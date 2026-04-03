import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import CollisionModelSource, { createRegistryCollisionModelSource } from '../../common/CollisionModelSource.ts';
import Mod, { BrushModel } from '../../common/Mod.ts';
import { BrushTrace, DIST_EPSILON, Trace as SharedTrace } from '../../common/Pmove.ts';
import { eventBus, registry } from '../../registry.mjs';
import {
  BrushCollisionState,
  CollisionState,
  CollisionTrace,
  HullCollisionState,
  MeshCollisionState,
  MeshTraceContext,
  MeshTriangle,
  MoveClip,
} from './ServerCollisionSupport.mjs';
import {
  hullPointContents as legacyHullPointContents,
  pointContents as legacyPointContents,
  recursiveHullCheck as legacyRecursiveHullCheck,
} from './ServerLegacyHullCollision.mjs';

let { Con, SV } = registry;

/** @typedef {import('../Client.mjs').ServerEdict} ServerEdict */

/** @typedef {import('../../common/Pmove.ts').Trace} SharedBrushTrace */

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  SV = registry.SV;
});

/**
 * Handles collision detection and tracing for entities in the world.
 * Uses shared brush tracing for BSP models when brush data is available,
 * falling back to legacy hull traces otherwise.
 */
export class ServerCollision {
  static MISSILE_MINS = new Vector(-15.0, -15.0, -15.0);
  static MISSILE_MAXS = new Vector(15.0, 15.0, 15.0);

  /**
   * @param {CollisionModelSource} [modelSource] runtime model resolver
   */
  constructor(modelSource = createRegistryCollisionModelSource()) {
    this._modelSource = modelSource;
  }

  /**
   * Resolve a collision model by model index from either the active server or
   * the client precache populated by server signon data.
   * @param {number} modelIndex precached model index
   * @returns {BrushModel|object|null} resolved model, if any
   */
  _getModelByIndex(modelIndex) {
    return this._modelSource.getModelByIndex(modelIndex);
  }

  /**
   * Resolve the model used by an entity for collision.
   * @param {ServerEdict} ent entity being tested
   * @returns {BrushModel|object|null} collision model, if any
   */
  _getEntityModel(ent) {
    if (ent === SV.server?.edicts?.[0]) {
      return this._getStaticWorldSource().worldModel;
    }

    return this._getModelByIndex(ent.entity.modelindex);
  }

  /**
   * Resolve the collision state used by an entity during tracing.
   * @param {ServerEdict} ent entity being tested
   * @returns {CollisionState|null} collision state
   */
  _getEntityCollisionState(ent) {
    if (ent.entity.solid === Defs.solid.SOLID_MESH) {
      const model = this._getEntityModel(ent);
      return model === null || model === undefined
        ? null
        : new MeshCollisionState(ent, model);
    }

    if (ent.entity.solid === Defs.solid.SOLID_BSP) {
      const model = this._getEntityModel(ent);

      if (!(model instanceof BrushModel) || !model.hasBrushData) {
        return new HullCollisionState(ent);
      }

      return new BrushCollisionState(ent, model, ent.entity.origin, ent.entity.angles);
    }

    return new HullCollisionState(ent);
  }

  /**
   * Build a hull fallback state for callers that want a guaranteed collision mode.
   * @param {ServerEdict} ent entity being tested
   * @returns {HullCollisionState} hull collision state
   */
  _getHullFallbackState(ent) {
    return new HullCollisionState(ent);
  }

  /**
   * Resolve the active static-world model for traces that can run on either a
   * local server or a pure client connection.
   * @returns {{ worldEntity: ServerEdict|null, worldModel: BrushModel|null }} static world source
   */
  _getStaticWorldSource() {
    return {
      worldEntity: this._modelSource.getWorldEntity(),
      worldModel: this._modelSource.getWorldModel(),
    };
  }

  /**
   * Convert a shared brush trace result into the server collision trace shape.
   * @param {import('../../common/Pmove.ts').Trace} brushTrace shared brush trace result
   * @param {ServerEdict} ent entity that owns the brush model
   * @returns {CollisionTrace} server collision trace
   */
  _toServerTrace(brushTrace, ent) {
    return CollisionTrace.fromSharedTrace(brushTrace, ent);
  }

  /**
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @returns {boolean} true when the trace is point-sized
   */
  _isPointTrace(mins, maxs) {
    return mins.isOrigin() && maxs.isOrigin();
  }

  /**
   * Emit a developer-only summary for point-trace hits so live repros can
   * distinguish world hull issues from dynamic-entity hits.
   * @param {CollisionTrace} trace final trace result
   * @param {Vector} start trace start
   * @param {Vector} end trace end
   * @param {Vector} mins trace mins
   * @param {Vector} maxs trace maxs
   */
  _debugLogPointTraceHit(trace, start, end, mins, maxs) {
    if (!this._isPointTrace(mins, maxs)) {
      return;
    }

    if (trace.ent === null || (trace.fraction >= 1.0 && !trace.startsolid && !trace.allsolid)) {
      return;
    }

    const hitEntity = trace.ent.entity;
    const model = this._getEntityModel(trace.ent);
    const modelName = model && typeof model.name === 'string' ? model.name : '<none>';
    const classname = typeof hitEntity.classname === 'string' ? hitEntity.classname : '<no classname>';

    Con.DPrint(
      'ServerCollision.move point trace hit '
      + `ent=${trace.ent.num} classname=${classname} solid=${hitEntity.solid} movetype=${hitEntity.movetype} `
      + `modelindex=${hitEntity.modelindex} model=${modelName} fraction=${trace.fraction.toFixed(4)} `
      + `start=(${start[0].toFixed(1)} ${start[1].toFixed(1)} ${start[2].toFixed(1)}) `
      + `end=(${end[0].toFixed(1)} ${end[1].toFixed(1)} ${end[2].toFixed(1)}) `
      + `endpos=(${trace.endpos[0].toFixed(1)} ${trace.endpos[1].toFixed(1)} ${trace.endpos[2].toFixed(1)})\n`,
    );
  }

  /**
   * Legacy hull point traces remain the compatibility baseline when brush and
   * hull BSP paths disagree about the first finite hit.
   * When the brush path reports an earlier finite hit than the legacy hull path,
   * prefer the later hull impact to avoid terminating on traversal-only planes.
   * @param {CollisionTrace} brushTrace brush-based trace result
   * @param {CollisionTrace} hullTrace hull-based trace result
   * @returns {boolean} true when the hull result should replace the brush result
   */
  _shouldPreferHullPointTrace(brushTrace, hullTrace) {
    if (hullTrace.fraction >= 1.0) {
      return false;
    }

    if (brushTrace.allsolid && !hullTrace.allsolid) {
      return true;
    }

    if (brushTrace.startsolid && !hullTrace.startsolid) {
      return true;
    }

    return hullTrace.fraction > brushTrace.fraction + DIST_EPSILON;
  }

  /**
   * Hull fallback is only safe for point traces whose BSP entity is not rotated,
   * because the legacy hull path does not apply entity angles.
   * @param {BrushCollisionState} state brush collision state
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @returns {boolean} true when the brush trace can be cross-checked with hulls
   */
  _canUseHullPointFallback(state, mins, maxs) {
    if (!this._isPointTrace(mins, maxs)) {
      return false;
    }

    if (state.ent === SV.server?.edicts?.[0]) {
      return true;
    }

    return state.angles.isOrigin();
  }

  /**
   * Trace a BSP entity through the shared brush path and cross-check supported
   * point traces against the legacy hull path to avoid false early hits.
   * @param {BrushCollisionState} state brush collision state
   * @param {Vector} start world-space start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end world-space end position
   * @returns {CollisionTrace} collision result
   */
  _clipMoveToBrushStateWithHullFallback(state, start, mins, maxs, end) {
    const brushTrace = this._traceBrushModel(
      state.model,
      start,
      mins,
      maxs,
      end,
      state.origin,
      state.angles,
    );
    const serverBrushTrace = this._toServerTrace(brushTrace, state.ent);

    if (!this._canUseHullPointFallback(state, mins, maxs)) {
      return serverBrushTrace;
    }

    const hullTrace = this._clipMoveToHullState(this._getHullFallbackState(state.ent), start, mins, maxs, end);

    if (this._shouldPreferHullPointTrace(serverBrushTrace, hullTrace)) {
      return hullTrace;
    }

    return serverBrushTrace;
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
   * Trace against an entity through the shared brush path.
   * @param {BrushCollisionState} state brush collision state
   * @param {Vector} start world-space start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end world-space end position
   * @returns {CollisionTrace} collision result
   */
  _clipMoveToBrushState(state, start, mins, maxs, end) {
    return this._clipMoveToBrushStateWithHullFallback(state, start, mins, maxs, end);
  }

  /**
   * Trace against an entity through the legacy hull path.
   * @param {HullCollisionState} state hull collision state
   * @param {Vector} start world-space start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end world-space end position
   * @returns {CollisionTrace} collision result
   */
  _clipMoveToHullState(state, start, mins, maxs, end) {
    const trace = CollisionTrace.hullInitial(end);

    const offset = new Vector();
    const hull = SV.area.hullForEntity(state.ent, mins, maxs, offset);
    const startLocal = start.copy().subtract(offset);
    const endLocal = end.copy().subtract(offset);

    this.recursiveHullCheck(hull, hull.firstclipnode, 0.0, 1.0, startLocal, endLocal, trace);

    if (trace.fraction !== 1.0) {
      trace.endpos.add(offset);
    }

    if (trace.fraction < 1.0 || trace.startsolid) {
      trace.ent = state.ent;
    }

    return trace;
  }

  /**
   * Trace a line through a specific legacy hull without exposing clipnode walks
   * to higher-level callers.
   * @param {*} hull hull to trace against
   * @param {Vector} start start position in hull space
   * @param {Vector} end end position in hull space
   * @returns {CollisionTrace} collision result
   */
  _traceLegacyHullLine(hull, start, end) {
    const trace = CollisionTrace.hullInitial(end);
    this.recursiveHullCheck(hull, hull.firstclipnode, 0.0, 1.0, start, end, trace);
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
    return legacyHullPointContents(hull, num, p);
  }

  /**
   * Normalize static-world contents values so current volumes behave like water.
   * @param {number} contents raw contents value
   * @returns {number} normalized static-world contents value
   */
  _normalizeStaticWorldContents(contents) {
    if ((contents <= Defs.content.CONTENT_CURRENT_0) && (contents >= Defs.content.CONTENT_CURRENT_DOWN)) {
      return Defs.content.CONTENT_WATER;
    }

    return contents;
  }

  /**
   * Sample the contents of a brush-backed world without exposing brush internals
   * to higher-level callers.
   * @param {BrushModel} worldModel brush-backed world model
   * @param {Vector} point position to sample
   * @returns {number} world contents value
   */
  _pointContentsBrushStaticWorld(worldModel, point) {
    if (!BrushTrace.transformedTestPosition(
      worldModel,
      point,
      Vector.origin,
      Vector.origin,
      Vector.origin,
      Vector.origin,
    )) {
      return Defs.content.CONTENT_SOLID;
    }

    return this._normalizeStaticWorldContents(worldModel.getLeafForPoint(point).contents);
  }

  /**
   * Sample static-world contents using the best collision backend for the
   * active map. This queries worldspawn only; BSP entities such as doors are
   * not included here. Hull 0 may dispatch to brush contents when available,
   * while explicit non-zero hull queries stay on the legacy compatibility path.
   * @param {Vector} point position to sample
   * @param {number} [hullNum] explicit world hull index for legacy compatibility
   * @returns {number} static-world contents value
   */
  staticWorldContents(point, hullNum = 0) {
    const { worldModel } = this._getStaticWorldSource();

    if (worldModel === null) {
      return Defs.content.CONTENT_EMPTY;
    }

    if (hullNum === 0 && worldModel instanceof BrushModel && worldModel.hasBrushData) {
      return this._pointContentsBrushStaticWorld(worldModel, point);
    }

    return this._normalizeStaticWorldContents(legacyPointContents(worldModel, point));
  }

  /**
   * Compatibility alias for staticWorldContents.
   * @param {Vector} point position to sample
   * @param {number} [hullNum] explicit world hull index for legacy compatibility
   * @returns {number} static-world contents value
   */
  worldContents(point, hullNum = 0) {
    return this.staticWorldContents(point, hullNum);
  }

  /**
   * Compatibility alias for staticWorldContents.
   * @param {Vector} p position to sample
   * @param {number} [hullNum] explicit world hull index for legacy compatibility
   * @returns {number} static-world content
   */
  pointContents(p, hullNum = 0) {
    return this.staticWorldContents(p, hullNum);
  }

  /**
   * Trace static-world geometry using the best collision backend for the active
   * map. This traces worldspawn only; BSP entities such as doors are excluded.
   * Hull 0 can dispatch to shared brush tracing when brush data is available,
   * while explicit non-zero hull queries remain on the legacy compatibility path.
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @param {number} [hullNum] explicit world hull index for legacy compatibility
   * @returns {CollisionTrace} collision result against static world geometry
   */
  traceStaticWorld(start, mins, maxs, end, hullNum = 0) {
    const { worldEntity, worldModel } = this._getStaticWorldSource();

    if (worldModel === null) {
      return CollisionTrace.empty(end);
    }

    if (hullNum === 0 && worldModel instanceof BrushModel && worldModel.hasBrushData) {
      return this._toServerTrace(
        this._traceBrushModel(worldModel, start, mins, maxs, end, Vector.origin, Vector.origin),
        worldEntity ?? /** @type {ServerEdict} */ (null),
      );
    }

    if (hullNum === 0) {
      if (worldEntity === null) {
        if (!this._isPointTrace(mins, maxs)) {
          return CollisionTrace.empty(end);
        }

        return this._traceLegacyHullLine(worldModel.hulls[0], start, end);
      }

      return this._clipMoveToHullState(this._getHullFallbackState(worldEntity), start, mins, maxs, end);
    }

    return this._traceLegacyHullLine(worldModel.hulls[hullNum], start, end);
  }

  /**
   * Compatibility alias for traceStaticWorld.
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @param {number} [hullNum] explicit world hull index for legacy compatibility
   * @returns {CollisionTrace} collision result against static world geometry
   */
  traceWorld(start, mins, maxs, end, hullNum = 0) {
    return this.traceStaticWorld(start, mins, maxs, end, hullNum);
  }

  /**
   * Trace a point-sized line against the static world.
   * @param {Vector} start start position
   * @param {Vector} end end position
   * @param {number} [hullNum] explicit world hull index for legacy compatibility
   * @returns {CollisionTrace} collision result against static world geometry
   */
  traceStaticWorldLine(start, end, hullNum = 0) {
    return this.traceStaticWorld(start, Vector.origin, Vector.origin, end, hullNum);
  }

  /**
   * Compatibility alias for traceStaticWorldLine.
   * @param {Vector} start start position
   * @param {Vector} end end position
   * @param {number} [hullNum] explicit world hull index for legacy compatibility
   * @returns {CollisionTrace} collision result against static world geometry
   */
  traceWorldLine(start, end, hullNum = 0) {
    return this.traceStaticWorldLine(start, end, hullNum);
  }

  /**
   * Recursively tests a swept hull against the world and aggregates the trace result.
   * @param {*} hull hull to trace against
   * @param {number} num clipnode index
   * @param {number} p1f fraction at the start point
   * @param {number} p2f fraction at the end point
   * @param {Vector} p1 start point
   * @param {Vector} p2 end point
   * @param {CollisionTrace} trace trace accumulator
   * @param {number} [depth] recursion depth for scratch-vector reuse
   * @returns {boolean} true if traversal should continue downward
   */
  recursiveHullCheck(hull, num, p1f, p2f, p1, p2, trace, depth = 0) {
    return legacyRecursiveHullCheck(hull, num, p1f, p2f, p1, p2, trace, depth);
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
   * Update a trace with start-solid information for a mesh triangle.
   * @param {CollisionTrace} trace current trace result
   * @param {MeshTraceContext} meshTrace mesh tracing context
   * @param {MeshTriangle} triangle transformed triangle
   * @param {number} startDistance signed start distance to the expanded plane
   * @param {number} supportRadius projected box support radius
   * @param {number} approach rate of approach toward the face
   */
  _updateMeshStartSolid(trace, meshTrace, triangle, startDistance, supportRadius, approach) {
    if (startDistance < -supportRadius) {
      return;
    }

    const projectedStart = meshTrace.projectPointOntoPlane(meshTrace.startCenter, triangle.normal, triangle.planeDist);
    if (!this._pointInTriangle(projectedStart, triangle.v0, triangle.v1, triangle.v2, triangle.normal)) {
      return;
    }

    trace.startsolid = true;
    if ((startDistance - approach) <= 0.0) {
      trace.allsolid = true;
    }
  }

  /**
   * Try to record a nearer face impact from a mesh triangle.
   * @param {CollisionTrace} trace current trace result
   * @param {MeshTraceContext} meshTrace mesh tracing context
   * @param {MeshTriangle} triangle transformed triangle
   * @param {number} startDistance signed start distance to the expanded plane
   * @param {number} approach rate of approach toward the face
   */
  _updateMeshImpact(trace, meshTrace, triangle, startDistance, approach) {
    if (approach < DIST_EPSILON) {
      return;
    }

    let fraction = (startDistance - DIST_EPSILON) / approach;
    fraction = Math.max(0.0, Math.min(1.0, fraction));

    if (fraction >= trace.fraction) {
      return;
    }

    const hitCenter = meshTrace.getCenterAtFraction(fraction);
    const projectedHit = meshTrace.projectPointOntoPlane(hitCenter, triangle.normal, triangle.planeDist);
    if (!this._pointInTriangle(projectedHit, triangle.v0, triangle.v1, triangle.v2, triangle.normal)) {
      return;
    }

    trace.fraction = fraction;
    trace.plane.normal = triangle.normal.copy();
    trace.plane.dist = triangle.planeDist;
    trace.ent = meshTrace.ent;
  }

  /**
   * Build a mesh tracing context if the target entity has usable mesh data.
   * @param {ServerEdict} ent entity to collide with
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @returns {MeshTraceContext|null} mesh tracing context, or null when mesh tracing is not available
   */
  _createMeshTraceContext(ent, start, mins, maxs, end) {
    const model = this._getEntityModel(ent);
    if (!model || model.type !== Mod.type.mesh) {
      return null;
    }

    const meshModel = /** @type {import('../../common/model/MeshModel.ts').MeshModel} */ (model);
    if (!meshModel.indices || !meshModel.vertices || meshModel.numTriangles === 0) {
      return null;
    }

    return new MeshTraceContext(ent, meshModel, start, mins, maxs, end);
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
   * @returns {CollisionTrace} collision result
   */
  clipMoveToMesh(ent, start, mins, maxs, end) {
    const trace = CollisionTrace.empty(end);

    const meshTrace = this._createMeshTraceContext(ent, start, mins, maxs, end);
    if (meshTrace === null) {
      return trace;
    }

    for (let i = 0; i < meshTrace.model.numTriangles; i++) {
      const triangle = MeshTriangle.fromMesh(meshTrace, i);
      if (triangle === null) {
        continue;
      }

      const supportRadius = meshTrace.getBoxSupportRadius(triangle.normal);
      const approach = triangle.getApproach(meshTrace.moveDir);
      const startDistance = triangle.normal.dot(meshTrace.startCenter) - triangle.planeDist - supportRadius;

      if (startDistance <= 0.0) {
        this._updateMeshStartSolid(trace, meshTrace, triangle, startDistance, supportRadius, approach);
        continue;
      }

      this._updateMeshImpact(trace, meshTrace, triangle, startDistance, approach);
    }

    if (trace.fraction < 1.0) {
      trace.endpos = meshTrace.getTraceEndAtFraction(trace.fraction);
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
   * @returns {CollisionTrace} collision result
   */
  clipMoveToEntity(ent, start, mins, maxs, end) {
    const state = this._getEntityCollisionState(ent) ?? this._getHullFallbackState(ent);

    return this._clipMoveToEntityWithState(state, start, mins, maxs, end);
  }

  /**
   * Trace against a target entity using its pre-resolved collision state.
   * @param {CollisionState} state collision state
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @returns {CollisionTrace} collision result
   */
  _clipMoveToEntityWithState(state, start, mins, maxs, end) {
    if (state instanceof MeshCollisionState) {
      return this.clipMoveToMesh(state.ent, start, mins, maxs, end);
    }

    if (state instanceof BrushCollisionState) {
      return this._clipMoveToBrushState(state, start, mins, maxs, end);
    }

    return this._clipMoveToHullState(state, start, mins, maxs, end);
  }

  /**
   * Select the extents used to trace against a touched entity.
   * Missiles expand only against monsters.
   * @param {MoveClip} clip move clip state
   * @param {ServerEdict} touch touched entity candidate
   * @returns {{mins: Vector, maxs: Vector}} trace extents for this interaction
   */
  _getTouchTraceExtents(clip, touch) {
    if ((touch.entity.flags & Defs.flags.FL_MONSTER) !== 0) {
      return { mins: clip.mins2, maxs: clip.maxs2 };
    }

    return { mins: clip.mins, maxs: clip.maxs };
  }

  /**
   * Determine whether a touched entity should be skipped before narrow-phase tracing.
   * @param {MoveClip} clip move clip state
   * @param {ServerEdict} touch touched entity candidate
   * @returns {boolean} true when the touched entity should be ignored
   */
  _shouldSkipTouch(clip, touch) {
    if (touch === clip.passedict) {
      return true;
    }

    if (touch.entity.solid === Defs.solid.SOLID_NOT || touch.entity.solid === Defs.solid.SOLID_TRIGGER) {
      return true;
    }

    if (clip.type === Defs.moveTypes.MOVE_NOMONSTERS && touch.entity.solid !== Defs.solid.SOLID_BSP) {
      return true;
    }

    if (clip.passedict && clip.passedict.entity.size[0] && !touch.entity.size[0]) {
      return true;
    }

    if (clip.passedict) {
      if (touch.entity.owner && touch.entity.owner.equals(clip.passedict)) {
        return true;
      }

      if (clip.passedict.entity.owner && clip.passedict.entity.owner.equals(touch)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check whether a touched entity overlaps the clip broadphase box.
   * @param {MoveClip} clip move clip state
   * @param {ServerEdict} touch touched entity candidate
   * @returns {boolean} true when the entity overlaps the broadphase bounds
   */
  _touchOverlapsClipBounds(clip, touch) {
    return !(
      clip.boxmins[0] > touch.entity.absmax[0]
      || clip.boxmins[1] > touch.entity.absmax[1]
      || clip.boxmins[2] > touch.entity.absmax[2]
      || clip.boxmaxs[0] < touch.entity.absmin[0]
      || clip.boxmaxs[1] < touch.entity.absmin[1]
      || clip.boxmaxs[2] < touch.entity.absmin[2]
    );
  }

  /**
   * Run narrow-phase tracing against a touched entity using the correct extents.
   * @param {MoveClip} clip move clip state
   * @param {ServerEdict} touch touched entity candidate
   * @returns {CollisionTrace} trace result against the entity
   */
  _traceTouch(clip, touch) {
    const touchState = this._getEntityCollisionState(touch) ?? this._getHullFallbackState(touch);
    const { mins, maxs } = this._getTouchTraceExtents(clip, touch);
    const trace = this._clipMoveToEntityWithState(touchState, clip.start, mins, maxs, clip.end);

    console.assert(
      Number.isFinite(trace.fraction)
      && Number.isFinite(trace.endpos[0])
      && Number.isFinite(trace.endpos[1])
      && Number.isFinite(trace.endpos[2])
      && Number.isFinite(trace.plane.normal[0])
      && Number.isFinite(trace.plane.normal[1])
      && Number.isFinite(trace.plane.normal[2])
      && Number.isFinite(trace.plane.dist),
      'ServerCollision._traceTouch produced malformed trace',
    );

    return trace;
  }

  /**
   * Replace the current best clip trace when a touched entity produced a nearer hit.
   * @param {MoveClip} clip move clip state
   * @param {ServerEdict} touch touched entity candidate
   * @param {CollisionTrace} trace candidate trace result
   */
  _updateClipTrace(clip, touch, trace) {
    if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
      trace.ent = touch;
      clip.trace = trace;
    }
  }

  /**
   * Fill the broadphase AABB used to query touched entities for a trace.
   * @param {MoveClip} clip move clip state
   */
  _updateClipBounds(clip) {
    for (let i = 0; i < 3; i++) {
      if (clip.end[i] > clip.start[i]) {
        clip.boxmins[i] = clip.start[i] + clip.mins2[i] - 1.0;
        clip.boxmaxs[i] = clip.end[i] + clip.maxs2[i] + 1.0;
      } else {
        clip.boxmins[i] = clip.end[i] + clip.mins2[i] - 1.0;
        clip.boxmaxs[i] = clip.start[i] + clip.maxs2[i] + 1.0;
      }
    }
  }

  /**
   * Build the clip context used to trace a move through the world and dynamic entities.
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @param {number} type move type constant from Defs.moveTypes
   * @param {ServerEdict|null} passedict entity to skip
   * @returns {MoveClip} initialized move clip context
   */
  _createMoveClip(start, mins, maxs, end, type, passedict) {
    const worldEdict = SV.server.edicts[0];
    const worldState = this._getEntityCollisionState(worldEdict) ?? this._getHullFallbackState(worldEdict);
    const worldTrace = this._clipMoveToEntityWithState(worldState, start, mins, maxs, end);
    console.assert(
      Number.isFinite(worldTrace.fraction)
      && Number.isFinite(worldTrace.endpos[0])
      && Number.isFinite(worldTrace.endpos[1])
      && Number.isFinite(worldTrace.endpos[2])
      && Number.isFinite(worldTrace.plane.normal[0])
      && Number.isFinite(worldTrace.plane.normal[1])
      && Number.isFinite(worldTrace.plane.normal[2])
      && Number.isFinite(worldTrace.plane.dist),
      'ServerCollision._createMoveClip produced malformed world trace',
    );
    const clip = new MoveClip(
      worldTrace,
      start,
      end,
      mins,
      type === Defs.moveTypes.MOVE_MISSILE ? ServerCollision.MISSILE_MINS : mins,
      maxs,
      type === Defs.moveTypes.MOVE_MISSILE ? ServerCollision.MISSILE_MAXS : maxs,
      type,
      passedict,
    );

    this._updateClipBounds(clip);

    return clip;
  }

  /**
   * Recursively checks the links in the area node BSP for collision.
   * @param {MoveClip} clip clip data
   */
  clipToLinks(clip) {
    for (const touch of SV.area.tree.queryAABB(clip.boxmins, clip.boxmaxs)) {
      if (this._shouldSkipTouch(clip, touch)) {
        continue;
      }

      if (!this._touchOverlapsClipBounds(clip, touch)) {
        continue;
      }

      if (clip.trace.allsolid === true) {
        return;
      }

      const trace = this._traceTouch(clip, touch);
      this._updateClipTrace(clip, touch, trace);

      if (clip.trace.allsolid) {
        return;
      }
    }
  }

  /**
   * Fully traces a moving box through the world.
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs minimum extents of the moving box
   * @param {Vector} end end position
   * @param {Defs.moveTypes} type move type constant from Defs.moveTypes
   * @param {ServerEdict} passedict entity to skip
   * @returns {CollisionTrace} collision result
   */
  move(start, mins, maxs, end, type, passedict) {
    const clip = this._createMoveClip(start, mins, maxs, end, type, passedict);

    this.clipToLinks(clip);
    this._debugLogPointTraceHit(clip.trace, start, end, mins, maxs);
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
