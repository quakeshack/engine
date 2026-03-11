import Vector from '../../../shared/Vector.mjs';
import * as Defs from '../../../shared/Defs.mjs';
import Mod, { BrushModel } from '../../common/Mod.mjs';
import { BrushTrace, DIST_EPSILON, Trace as SharedTrace } from '../../common/Pmove.mjs';
import { eventBus, registry } from '../../registry.mjs';

let { Con, SV } = registry;

/** @typedef {import('../Client.mjs').ServerEdict} ServerEdict */

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  SV = registry.SV;
});

/**
 * @typedef {object} Trace
 * @property {number} fraction completed movement fraction
 * @property {boolean} allsolid true when trace remained in solid
 * @property {boolean} startsolid whether start position was solid
 * @property {Vector} endpos final position after the trace
 * @property {{normal: Vector, dist: number}} plane collision plane information
 * @property {ServerEdict} ent entity that was hit, if any
 * @property {boolean} [inopen] true if open space was encountered
 * @property {boolean} [inwater] true if water was encountered
 */

/**
 * Handles collision detection and tracing for entities in the world.
 * Uses shared brush tracing for BSP models when brush data is available,
 * falling back to legacy hull traces otherwise.
 */
export class ServerCollision {
  /**
   * Resolve the shared brush collision inputs for an entity.
   * @param {ServerEdict} ent entity being tested
   * @returns {{model: BrushModel, origin: Vector, angles: Vector}|null} brush collision inputs, if available
   */
  _getBrushCollisionState(ent) {
    const model = ent === SV.server.edicts[0]
      ? SV.server.worldmodel
      : SV.server.models[ent.entity.modelindex];

    if (!(model instanceof BrushModel) || !model.hasBrushData) {
      return null;
    }

    return {
      model,
      origin: ent.entity.origin,
      angles: ent.entity.angles,
    };
  }

  /**
   * Convert a shared brush trace result into the server collision trace shape.
   * @param {import('../../common/Pmove.mjs').Trace} brushTrace shared brush trace result
   * @param {ServerEdict} ent entity that owns the brush model
   * @returns {Trace} server collision trace
   */
  _toServerTrace(brushTrace, ent) {
    const trace = {
      fraction: brushTrace.fraction,
      allsolid: brushTrace.allsolid,
      startsolid: brushTrace.startsolid,
      endpos: brushTrace.endpos.copy(),
      plane: {
        normal: brushTrace.plane.normal.copy(),
        dist: brushTrace.plane.dist,
      },
      ent: null,
      inopen: brushTrace.inopen,
      inwater: brushTrace.inwater,
    };

    if (trace.allsolid) {
      trace.startsolid = true;
    }

    if (trace.fraction < 1.0 || trace.startsolid) {
      trace.ent = ent;
    }

    return trace;
  }

  /**
   * Run the shared brush trace path for a BSP entity, including zero-length
   * position tests that must avoid swept-trace startsolid artifacts.
   * @param {BrushModel} model brush collision model
   * @param {Vector} start world-space start position
   * @param {Vector} mins box mins
   * @param {Vector} maxs box maxs
   * @param {Vector} end world-space end position
   * @param {Vector} origin entity origin
   * @param {Vector} angles entity angles
   * @returns {SharedTrace} shared trace result
   */
  _traceBrushModel(model, start, mins, maxs, end, origin, angles) {
    if (start.equals(end)) {
      const blocked = !BrushTrace.transformedTestPosition(
        model,
        start,
        mins,
        maxs,
        origin,
        angles,
      );

      const trace = new SharedTrace();
      trace.allsolid = blocked;
      trace.startsolid = blocked;
      trace.fraction = blocked ? 0.0 : 1.0;
      trace.endpos.set(start);
      trace.plane.normal.clear();
      trace.plane.dist = 0.0;
      trace.inopen = false;
      trace.inwater = false;
      return trace;
    }

    return BrushTrace.transformedBoxTrace(
      model,
      start,
      end,
      mins,
      maxs,
      origin,
      angles,
    );
  }

  /**
   * Attempt a shared brush trace against a BSP model.
   * Returns null when the entity should use legacy hull collision.
   * @param {ServerEdict} ent entity to collide with
   * @param {Vector} start world-space start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end world-space end position
   * @returns {Trace|null} collision result, or null to fall back to hull tracing
   */
  _clipMoveToBrushEntity(ent, start, mins, maxs, end) {
    if (ent.entity.solid !== Defs.solid.SOLID_BSP) {
      return null;
    }

    const brushState = this._getBrushCollisionState(ent);
    if (brushState === null) {
      return null;
    }

    const brushTrace = this._traceBrushModel(
      brushState.model,
      start,
      mins,
      maxs,
      end,
      brushState.origin,
      brushState.angles,
    );

    return this._toServerTrace(brushTrace, ent);
  }

  /**
   * Trace against an entity through the legacy hull path.
   * @param {ServerEdict} ent entity to collide with
   * @param {Vector} start world-space start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end world-space end position
   * @returns {Trace} collision result
   */
  _clipMoveToHullEntity(ent, start, mins, maxs, end) {
    const trace = {
      fraction: 1.0,
      allsolid: true,
      startsolid: false,
      endpos: end.copy(),
      plane: { normal: new Vector(), dist: 0.0 },
      ent: null,
    };

    const offset = new Vector();
    const hull = SV.area.hullForEntity(ent, mins, maxs, offset);
    const startLocal = start.copy().subtract(offset);
    const endLocal = end.copy().subtract(offset);

    this.recursiveHullCheck(hull, hull.firstclipnode, 0.0, 1.0, startLocal, endLocal, trace);

    if (trace.fraction !== 1.0) {
      trace.endpos.add(offset);
    }

    if (trace.fraction < 1.0 || trace.startsolid) {
      trace.ent = ent;
    }

    return trace;
  }

  /**
   * Determines the contents inside a hull by descending the clipnode tree.
   * @param {*} hull hull data to test against
   * @param {number} num starting clipnode index
   * @param {Vector} p point to classify
   * @returns {number} content type for the point
   */
  hullPointContents(hull, num, p) {
    while (num >= 0) {
      console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);
      const node = hull.clipnodes[num];
      const plane = hull.planes[node.planenum];

      let d;

      if (plane.type < 3) {
        d = p[plane.type] - plane.dist;
      } else {
        d = plane.normal.dot(p) - plane.dist;
      }

      if (d < 0) {
        num = node.children[1];
      } else {
        num = node.children[0];
      }
    }

    return num;
  }

  /**
   * Returns the contents at the specified world position.
   * @param {Vector} p position to sample
   * @returns {number} world content
   */
  pointContents(p) {
    const cont = this.hullPointContents(SV.server.worldmodel.hulls[0], 0, p);
    if ((cont <= Defs.content.CONTENT_CURRENT_0) && (cont >= Defs.content.CONTENT_CURRENT_DOWN)) {
      // all currents are considered water
      return Defs.content.CONTENT_WATER;
    }
    return cont;
  }

  /**
   * Recursively tests a swept hull against the world and aggregates the trace result.
   * @param {*} hull hull to trace against
   * @param {number} num clipnode index
   * @param {number} p1f fraction at the start point
   * @param {number} p2f fraction at the end point
   * @param {Vector} p1 start point
   * @param {Vector} p2 end point
   * @param {Trace} trace trace accumulator
   * @returns {boolean} true if traversal should continue downward
   */
  recursiveHullCheck(hull, num, p1f, p2f, p1, p2, trace) {
    // check for early exit - already hit something nearer
    if (trace.fraction <= p1f) {
      return false;
    }

    if (num < 0) {
      if (num !== Defs.content.CONTENT_SOLID) {
        trace.allsolid = false;
        if (num === Defs.content.CONTENT_EMPTY) {
          trace.inopen = true;
        } else {
          trace.inwater = true;
        }
      } else {
        trace.startsolid = true;
      }
      return true;
    }

    console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);

    const node = hull.clipnodes[num];
    const plane = hull.planes[node.planenum];
    const t1 = (plane.type < 3 ? p1[plane.type]
      : plane.normal[0] * p1[0] + plane.normal[1] * p1[1] + plane.normal[2] * p1[2]) - plane.dist;
    const t2 = (plane.type < 3 ? p2[plane.type]
      : plane.normal[0] * p2[0] + plane.normal[1] * p2[1] + plane.normal[2] * p2[2]) - plane.dist;

    if (t1 >= 0.0 && t2 >= 0.0) {
      return this.recursiveHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace);
    }

    if (t1 < 0.0 && t2 < 0.0) {
      return this.recursiveHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace);
    }

    let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? DIST_EPSILON : -DIST_EPSILON)) / (t1 - t2)));
    let midf = p1f + (p2f - p1f) * frac;
    const mid = new Vector(
      p1[0] + frac * (p2[0] - p1[0]),
      p1[1] + frac * (p2[1] - p1[1]),
      p1[2] + frac * (p2[2] - p1[2]),
    );
    const side = t1 < 0.0 ? 1 : 0;

    if (!this.recursiveHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace)) {
      return false;
    }

    if (this.hullPointContents(hull, node.children[side ^ 1], mid) !== Defs.content.CONTENT_SOLID) {
      return this.recursiveHullCheck(hull, node.children[side ^ 1], midf, p2f, mid, p2, trace);
    }

    if (trace.allsolid) {
      return false;
    }

    if (side === 0) {
      trace.plane.normal = plane.normal.copy();
      trace.plane.dist = plane.dist;
    } else {
      trace.plane.normal = plane.normal.copy().multiply(-1);
      trace.plane.dist = -plane.dist;
    }

    while (this.hullPointContents(hull, hull.firstclipnode, mid) === Defs.content.CONTENT_SOLID) {
      frac -= 0.1;
      if (frac < 0.0) {
        trace.fraction = midf;
        trace.endpos = mid.copy();
        Con.DPrint('backup past 0\n');
        return false;
      }
      midf = p1f + (p2f - p1f) * frac;
      mid[0] = p1[0] + frac * (p2[0] - p1[0]);
      mid[1] = p1[1] + frac * (p2[1] - p1[1]);
      mid[2] = p1[2] + frac * (p2[2] - p1[2]);
    }

    trace.fraction = midf;
    trace.endpos = mid.copy();

    return false;
  }

  /**
   * Tests whether a point lies inside a triangle using cross-product winding.
   * @param {Vector} p point to test (should lie on the triangle plane)
   * @param {Vector} v0 first vertex
   * @param {Vector} v1 second vertex
   * @param {Vector} v2 third vertex
   * @param {Vector} normal unit face normal of the triangle
   * @returns {boolean} true if the point is inside the triangle
   */
  _pointInTriangle(p, v0, v1, v2, normal) {
    // Small negative tolerance closes micro-gaps between adjacent triangles.
    // The cross product magnitude scales with edge length, so for typical
    // game triangles (edges ~5-50 units) this allows roughly 0.01–0.025 units
    // of perpendicular tolerance per edge.
    const EDGE_TOLERANCE = -0.125;

    const d0 = normal.dot(v1.copy().subtract(v0).cross(p.copy().subtract(v0)));
    const d1 = normal.dot(v2.copy().subtract(v1).cross(p.copy().subtract(v1)));
    const d2 = normal.dot(v0.copy().subtract(v2).cross(p.copy().subtract(v2)));

    return d0 >= EDGE_TOLERANCE && d1 >= EDGE_TOLERANCE && d2 >= EDGE_TOLERANCE;
  }

  /**
   * Traces a moving box against a mesh entity using expanded face planes.
   * Each triangle face is expanded outward by the box's support radius
   * (Minkowski sum) and tested for ray intersection. A DIST_EPSILON push-back
   * keeps the endpoint slightly in front of the surface, preventing the next
   * frame's trace from starting on or inside the plane (which causes
   * wall-sticking during slides).
   * @param {ServerEdict} ent entity to collide with
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @returns {Trace} collision result
   */
  clipMoveToMesh(ent, start, mins, maxs, end) {
    const trace = {
      fraction: 1.0,
      allsolid: false,
      startsolid: false,
      endpos: end.copy(),
      plane: { normal: new Vector(), dist: 0.0 },
      ent: null,
    };

    const model = SV.server.models[ent.entity.modelindex];
    if (!model || model.type !== Mod.type.mesh) {
      return trace;
    }

    const meshModel = /** @type {import('../../common/model/MeshModel.mjs').MeshModel} */(model);
    if (!meshModel.indices || !meshModel.vertices || meshModel.numTriangles === 0) {
      return trace;
    }

    const origin = ent.entity.origin;
    const mat = ent.entity.angles.toRotationMatrix();
    const forward = new Vector(mat[0], mat[1], mat[2]);
    const right = new Vector(mat[3], mat[4], mat[5]);
    const up = new Vector(mat[6], mat[7], mat[8]);

    const moveDir = end.copy().subtract(start);
    const boxExtents = maxs.copy().subtract(mins).multiply(0.5);
    const boxCenterOffset = mins.copy().add(maxs).multiply(0.5);
    const startCenter = start.copy().add(boxCenterOffset);

    for (let i = 0; i < meshModel.numTriangles; i++) {
      const idx0 = meshModel.indices[i * 3];
      const idx1 = meshModel.indices[i * 3 + 1];
      const idx2 = meshModel.indices[i * 3 + 2];

      // Transform triangle vertices to world space
      const lv0 = new Vector(meshModel.vertices[idx0 * 3], meshModel.vertices[idx0 * 3 + 1], meshModel.vertices[idx0 * 3 + 2]);
      const lv1 = new Vector(meshModel.vertices[idx1 * 3], meshModel.vertices[idx1 * 3 + 1], meshModel.vertices[idx1 * 3 + 2]);
      const lv2 = new Vector(meshModel.vertices[idx2 * 3], meshModel.vertices[idx2 * 3 + 1], meshModel.vertices[idx2 * 3 + 2]);

      const v0 = origin.copy()
        .add(forward.copy().multiply(lv0[0]))
        .add(right.copy().multiply(lv0[1]))
        .add(up.copy().multiply(lv0[2]));
      const v1 = origin.copy()
        .add(forward.copy().multiply(lv1[0]))
        .add(right.copy().multiply(lv1[1]))
        .add(up.copy().multiply(lv1[2]));
      const v2 = origin.copy()
        .add(forward.copy().multiply(lv2[0]))
        .add(right.copy().multiply(lv2[1]))
        .add(up.copy().multiply(lv2[2]));

      // Face normal (cross product of triangle edges, then normalize)
      const normal = v1.copy().subtract(v0).cross(v2.copy().subtract(v0));
      const lenSq = normal.dot(normal);
      if (lenSq < 1e-12) {
        continue; // degenerate triangle
      }
      normal.multiply(1.0 / Math.sqrt(lenSq));

      const planeDist = normal.dot(v0);

      // Box support radius projected onto the face normal (Minkowski expansion)
      const r = boxExtents[0] * Math.abs(normal[0])
              + boxExtents[1] * Math.abs(normal[1])
              + boxExtents[2] * Math.abs(normal[2]);

      // Rate of approach: positive when moving toward the front face
      const approach = -(normal[0] * moveDir[0] + normal[1] * moveDir[1] + normal[2] * moveDir[2]);

      // Signed distance from box nearest surface to triangle plane at start
      const d1 = normal.dot(startCenter) - planeDist - r;

      // --- Start-inside detection (separate from intersection) ---
      if (d1 <= 0) {
        // Too far behind the plane — on the back side, not stuck inside
        if (d1 < -r) {
          continue;
        }

        // Project start center onto triangle plane for containment check
        const hd = normal.dot(startCenter) - planeDist;
        const projStart = new Vector(
          startCenter[0] - normal[0] * hd,
          startCenter[1] - normal[1] * hd,
          startCenter[2] - normal[2] * hd,
        );

        if (this._pointInTriangle(projStart, v0, v1, v2, normal)) {
          trace.startsolid = true;
          const d2 = d1 - approach;
          if (d2 <= 0) {
            trace.allsolid = true;
          }
        }

        // Do not generate an impact fraction when starting overlapped;
        // the physics engine handles startsolid via depenetration logic
        continue;
      }

      // --- Front-face intersection ---

      // Not approaching or moving parallel — no face collision possible
      if (approach < DIST_EPSILON) {
        continue;
      }

      // Compute impact fraction with DIST_EPSILON push-back to keep the
      // endpoint slightly in front of the surface, preventing the next
      // frame's trace from starting on or inside the plane
      let frac = (d1 - DIST_EPSILON) / approach;
      frac = Math.max(0, Math.min(1, frac));

      // Already found a nearer hit
      if (frac >= trace.fraction) {
        continue;
      }

      // Box center at the candidate impact time
      const hitCenter = new Vector(
        startCenter[0] + moveDir[0] * frac,
        startCenter[1] + moveDir[1] * frac,
        startCenter[2] + moveDir[2] * frac,
      );

      // Project onto the triangle plane for point-in-triangle test
      const hd = normal.dot(hitCenter) - planeDist;
      const projHit = new Vector(
        hitCenter[0] - normal[0] * hd,
        hitCenter[1] - normal[1] * hd,
        hitCenter[2] - normal[2] * hd,
      );

      if (!this._pointInTriangle(projHit, v0, v1, v2, normal)) {
        continue;
      }

      // Record nearest collision
      trace.fraction = frac;
      trace.plane.normal = normal.copy();
      trace.plane.dist = planeDist;
      trace.ent = ent;
    }

    if (trace.fraction < 1.0) {
      trace.endpos.setTo(
        start[0] + moveDir[0] * trace.fraction,
        start[1] + moveDir[1] * trace.fraction,
        start[2] + moveDir[2] * trace.fraction,
      );
    }

    return trace;
  }

  /**
   * Traces a moving box against a target entity.
   * @param {ServerEdict} ent entity to collide with
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @returns {Trace} collision result
   */
  clipMoveToEntity(ent, start, mins, maxs, end) {
    if (ent.entity.solid === Defs.solid.SOLID_MESH) {
      return this.clipMoveToMesh(ent, start, mins, maxs, end);
    }

    const brushTrace = this._clipMoveToBrushEntity(ent, start, mins, maxs, end);

    if (brushTrace !== null) {
      return brushTrace;
    }

    return this._clipMoveToHullEntity(ent, start, mins, maxs, end);
  }

  /**
   * Recursively checks the links in the area node BSP for collision.
   * @param {*} clip clip data
   */
  clipToLinks(clip) {
    for (const touch of SV.area.tree.queryAABB(clip.boxmins, clip.boxmaxs)) {
      if (touch === clip.passedict) {
        continue;
      }

      if (touch.entity.solid === Defs.solid.SOLID_NOT) {
        continue;
      }

      if (touch.entity.solid === Defs.solid.SOLID_TRIGGER) {
        continue;
      }

      if (clip.type === Defs.moveTypes.MOVE_NOMONSTERS && touch.entity.solid !== Defs.solid.SOLID_BSP) {
        continue;
      }

      if (clip.boxmins[0] > touch.entity.absmax[0] ||
          clip.boxmins[1] > touch.entity.absmax[1] ||
          clip.boxmins[2] > touch.entity.absmax[2] ||
          clip.boxmaxs[0] < touch.entity.absmin[0] ||
          clip.boxmaxs[1] < touch.entity.absmin[1] ||
          clip.boxmaxs[2] < touch.entity.absmin[2]) {
        continue;
      }

      if (clip.passedict) {
        if (clip.passedict.entity.size[0] && !touch.entity.size[0]) {
          continue; // points never interact
        }
      }

      if (clip.trace.allsolid === true) {
        return;
      }

      if (clip.passedict) {
        if (touch.entity.owner && touch.entity.owner.equals(clip.passedict)) {
          continue;
        }
        if (clip.passedict.entity.owner && clip.passedict.entity.owner.equals(touch)) {
          continue;
        }
      }

      const trace = (touch.entity.flags & Defs.flags.FL_MONSTER) !== 0
        ? this.clipMoveToEntity(touch, clip.start, clip.mins2, clip.maxs2, clip.end)
        : this.clipMoveToEntity(touch, clip.start, clip.mins, clip.maxs, clip.end);

      if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
        trace.ent = touch;
        clip.trace = trace;
        if (clip.trace.allsolid) {
          return;
        }
      }
    }
  }

  /**
   * Fully traces a moving box through the world.
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @param {Defs.moveTypes} type move type constant from Defs.moveTypes
   * @param {ServerEdict} passedict entity to skip
   * @returns {Trace} collision result
   */
  move(start, mins, maxs, end, type, passedict) {
    const clip = {
      trace: this.clipMoveToEntity(SV.server.edicts[0], start, mins, maxs, end),
      start,
      end,
      mins,
      mins2: type === Defs.moveTypes.MOVE_MISSILE ? new Vector(-15.0, -15.0, -15.0) : mins,
      maxs,
      maxs2: type === Defs.moveTypes.MOVE_MISSILE ? new Vector(15.0, 15.0, 15.0) : maxs,
      type,
      passedict,
      boxmins: new Vector(),
      boxmaxs: new Vector(),
    };

    for (let i = 0; i < 3; i++) {
      if (end[i] > start[i]) {
        clip.boxmins[i] = start[i] + clip.mins2[i] - 1.0;
        clip.boxmaxs[i] = end[i] + clip.maxs2[i] + 1.0;
      } else {
        clip.boxmins[i] = end[i] + clip.mins2[i] - 1.0;
        clip.boxmaxs[i] = start[i] + clip.maxs2[i] + 1.0;
      }
    }

    this.clipToLinks(clip);
    return clip.trace;
  }

  /**
   * Tests whether an entity is currently stuck in solid geometry.
   * @param {ServerEdict} ent entity to test
   * @returns {boolean} true if the entity is stuck
   */
  testEntityPosition(ent) {
    const origin = ent.entity.origin.copy();
    return this.move(origin, ent.entity.mins, ent.entity.maxs, origin, 0, ent).startsolid;
  }
}
