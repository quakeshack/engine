import Vector from '../../../shared/Vector.ts';

/** @typedef {import('../Client.mjs').ServerEdict} ServerEdict */

export class CollisionState {
  /**
   * @param {ServerEdict} ent entity being traced against
   */
  constructor(ent) {
    this.ent = ent;
  }
}

export class MeshCollisionState extends CollisionState {
  /**
   * @param {ServerEdict} ent entity being traced against
   * @param {object} model collision model for the mesh entity
   */
  constructor(ent, model) {
    super(ent);
    this.model = model;
  }
}

export class BrushCollisionState extends CollisionState {
  /**
   * @param {ServerEdict} ent entity being traced against
   * @param {import('../../common/Mod.ts').BrushModel} model brush collision model
   * @param {Vector} origin brush-model origin
   * @param {Vector} angles brush-model angles
   */
  constructor(ent, model, origin, angles) {
    super(ent);
    this.model = model;
    this.origin = origin;
    this.angles = angles;
  }
}

export class HullCollisionState extends CollisionState {
}

export class MoveClip {
  /**
   * @param {CollisionTrace} trace current best trace result
   * @param {Vector} start world-space trace start
   * @param {Vector} end world-space trace end
   * @param {Vector} mins default tracing mins
   * @param {Vector} mins2 alternate mins used for missile-vs-monster checks
   * @param {Vector} maxs default tracing maxs
   * @param {Vector} maxs2 alternate maxs used for missile-vs-monster checks
   * @param {number} type move type constant from Defs.moveTypes
   * @param {ServerEdict|null} passedict entity to skip during tracing
   */
  constructor(trace, start, end, mins, mins2, maxs, maxs2, type, passedict) {
    this.trace = trace;
    this.start = start;
    this.end = end;
    this.mins = mins;
    this.mins2 = mins2;
    this.maxs = maxs;
    this.maxs2 = maxs2;
    this.type = type;
    this.passedict = passedict;
    this.boxmins = new Vector();
    this.boxmaxs = new Vector();
  }
}

export class CollisionPlane {
  /**
   * @param {Vector} [normal] collision normal
   * @param {number} [dist] plane distance from origin
   */
  constructor(normal = new Vector(), dist = 0.0) {
    this.normal = normal;
    this.dist = dist;
  }

  /**
   * @param {{normal: Vector, dist: number}} plane source plane
   * @returns {CollisionPlane} copied collision plane
   */
  static fromPlane(plane) {
    return new CollisionPlane(plane.normal.copy(), plane.dist);
  }
}

export class CollisionTrace {
  /**
   * @param {Vector} endpos final trace end position
   * @param {{fraction?: number, allsolid?: boolean, startsolid?: boolean, plane?: CollisionPlane, ent?: ServerEdict|null, inopen?: boolean, inwater?: boolean}} [options] trace initialization options
   */
  constructor(endpos, options = {}) {
    this.fraction = options.fraction ?? 1.0;
    this.allsolid = options.allsolid ?? false;
    this.startsolid = options.startsolid ?? false;
    this.endpos = endpos;
    this.plane = options.plane ?? new CollisionPlane();
    this.ent = options.ent ?? null;
    this.inopen = options.inopen ?? false;
    this.inwater = options.inwater ?? false;
  }

  /**
   * @param {Vector} end end position
   * @returns {CollisionTrace} empty trace
   */
  static empty(end) {
    return new CollisionTrace(end.copy());
  }

  /**
   * @param {Vector} end end position
   * @returns {CollisionTrace} hull-initialized trace
   */
  static hullInitial(end) {
    return new CollisionTrace(end.copy(), { allsolid: true });
  }

  /**
   * @param {import('../../common/Pmove.ts').Trace} brushTrace shared brush trace result
   * @param {ServerEdict} ent entity that owns the brush model
   * @returns {CollisionTrace} server collision trace
   */
  static fromSharedTrace(brushTrace, ent) {
    const trace = new CollisionTrace(brushTrace.endpos.copy(), {
      fraction: brushTrace.fraction,
      allsolid: brushTrace.allsolid,
      startsolid: brushTrace.startsolid,
      plane: CollisionPlane.fromPlane(brushTrace.plane),
      inopen: brushTrace.inopen,
      inwater: brushTrace.inwater,
    });

    if (trace.allsolid) {
      trace.startsolid = true;
    }

    if (trace.fraction < 1.0 || trace.startsolid) {
      trace.ent = ent;
    }

    return trace;
  }
}

export class MeshTraceContext {
  /** @type {ServerEdict} */
  ent;
  /** @type {import('../../common/model/MeshModel.ts').MeshModel} */
  model;
  /** @type {Vector} */
  start;
  /** @type {Vector} */
  end;
  /** @type {Vector} */
  origin;
  /** @type {Vector} */
  moveDir;
  /** @type {Vector} */
  startCenter;
  /** @type {Vector} */
  boxExtents;
  /** @type {Vector} */
  forward;
  /** @type {Vector} */
  right;
  /** @type {Vector} */
  up;

  /**
   * @param {ServerEdict} ent entity being traced against
   * @param {import('../../common/model/MeshModel.ts').MeshModel} model mesh collision model
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   */
  constructor(ent, model, start, mins, maxs, end) {
    this.ent = ent;
    this.model = model;
    this.start = start;
    this.end = end;
    this.origin = ent.entity.origin;

    const mat = ent.entity.angles.toRotationMatrix();
    this.forward = new Vector(mat[0], mat[1], mat[2]);
    this.right = new Vector(mat[3], mat[4], mat[5]);
    this.up = new Vector(mat[6], mat[7], mat[8]);
    this.moveDir = end.copy().subtract(start);
    this.boxExtents = maxs.copy().subtract(mins).multiply(0.5);
    this.startCenter = start.copy().add(mins.copy().add(maxs).multiply(0.5));
  }

  /**
   * Transform a model-space vertex into world space.
   * @param {number} x x component in model space
   * @param {number} y y component in model space
   * @param {number} z z component in model space
   * @returns {Vector} transformed world-space vertex
   */
  transformVertex(x, y, z) {
    return this.origin.copy()
      .add(this.forward.copy().multiply(x))
      .add(this.right.copy().multiply(y))
      .add(this.up.copy().multiply(z));
  }

  /**
   * Project a point onto a plane.
   * @param {Vector} point point to project
   * @param {Vector} normal plane normal
   * @param {number} planeDist plane distance from origin
   * @returns {Vector} projected point on the plane
   */
  projectPointOntoPlane(point, normal, planeDist) {
    const height = normal.dot(point) - planeDist;
    return new Vector(
      point[0] - normal[0] * height,
      point[1] - normal[1] * height,
      point[2] - normal[2] * height,
    );
  }

  /**
   * Compute the box support radius along a plane normal.
   * @param {Vector} normal plane normal
   * @returns {number} support radius along the normal
   */
  getBoxSupportRadius(normal) {
    return this.boxExtents[0] * Math.abs(normal[0])
      + this.boxExtents[1] * Math.abs(normal[1])
      + this.boxExtents[2] * Math.abs(normal[2]);
  }

  /**
   * Compute the box-center position at a trace fraction.
   * @param {number} fraction trace fraction
   * @returns {Vector} center position at the fraction
   */
  getCenterAtFraction(fraction) {
    return new Vector(
      this.startCenter[0] + this.moveDir[0] * fraction,
      this.startCenter[1] + this.moveDir[1] * fraction,
      this.startCenter[2] + this.moveDir[2] * fraction,
    );
  }

  /**
   * Compute the trace endpoint at a trace fraction.
   * @param {number} fraction trace fraction
   * @returns {Vector} end position at the fraction
   */
  getTraceEndAtFraction(fraction) {
    return new Vector(
      this.start[0] + this.moveDir[0] * fraction,
      this.start[1] + this.moveDir[1] * fraction,
      this.start[2] + this.moveDir[2] * fraction,
    );
  }
}

export class MeshTriangle {
  /** @type {Vector} */
  v0;
  /** @type {Vector} */
  v1;
  /** @type {Vector} */
  v2;
  /** @type {Vector} */
  normal;
  /** @type {number} */
  planeDist;

  /**
   * @param {Vector} v0 first world-space vertex
   * @param {Vector} v1 second world-space vertex
   * @param {Vector} v2 third world-space vertex
   * @param {Vector} normal unit face normal
   * @param {number} planeDist plane distance from origin
   */
  constructor(v0, v1, v2, normal, planeDist) {
    this.v0 = v0;
    this.v1 = v1;
    this.v2 = v2;
    this.normal = normal;
    this.planeDist = planeDist;
  }

  /**
   * Build a world-space triangle from mesh data.
   * @param {MeshTraceContext} meshTrace mesh tracing context
   * @param {number} triangleIndex triangle index within the mesh
   * @returns {MeshTriangle|null} transformed triangle, or null for degenerate faces
   */
  static fromMesh(meshTrace, triangleIndex) {
    const idx0 = meshTrace.model.indices[triangleIndex * 3];
    const idx1 = meshTrace.model.indices[triangleIndex * 3 + 1];
    const idx2 = meshTrace.model.indices[triangleIndex * 3 + 2];

    const v0 = meshTrace.transformVertex(
      meshTrace.model.vertices[idx0 * 3],
      meshTrace.model.vertices[idx0 * 3 + 1],
      meshTrace.model.vertices[idx0 * 3 + 2],
    );
    const v1 = meshTrace.transformVertex(
      meshTrace.model.vertices[idx1 * 3],
      meshTrace.model.vertices[idx1 * 3 + 1],
      meshTrace.model.vertices[idx1 * 3 + 2],
    );
    const v2 = meshTrace.transformVertex(
      meshTrace.model.vertices[idx2 * 3],
      meshTrace.model.vertices[idx2 * 3 + 1],
      meshTrace.model.vertices[idx2 * 3 + 2],
    );

    const normal = v1.copy().subtract(v0).cross(v2.copy().subtract(v0));
    const lenSq = normal.dot(normal);
    if (lenSq < 1e-12) {
      return null;
    }

    normal.multiply(1.0 / Math.sqrt(lenSq));
    return new MeshTriangle(v0, v1, v2, normal, normal.dot(v0));
  }

  /**
   * Compute the approach speed of a sweep against this triangle face.
   * @param {Vector} moveDir sweep direction in world space
   * @returns {number} positive when moving toward the front face
   */
  getApproach(moveDir) {
    return -(this.normal[0] * moveDir[0] + this.normal[1] * moveDir[1] + this.normal[2] * moveDir[2]);
  }
}
