import type { Trace as SharedBrushTrace } from '../../common/Pmove.ts';
import type { BrushModel } from '../../common/model/BSP.ts';
import type { MeshModel } from '../../common/model/MeshModel.ts';
import type { ServerEdict } from '../Edict.mjs';

import Vector from '../../../shared/Vector.ts';

interface CollisionPlaneSource {
  readonly normal: Vector;
  readonly dist: number;
}

interface CollisionTraceOptions {
  readonly fraction?: number;
  readonly allsolid?: boolean;
  readonly startsolid?: boolean;
  readonly plane?: CollisionPlane;
  readonly ent?: ServerEdict | null;
  readonly inopen?: boolean;
  readonly inwater?: boolean;
}

export class CollisionState {
  readonly ent: ServerEdict;

  /**
   * @param ent Entity being traced against.
   */
  constructor(ent: ServerEdict) {
    this.ent = ent;
  }
}

export class MeshCollisionState extends CollisionState {
  readonly model: MeshModel;

  /**
   * @param ent Entity being traced against.
   * @param model Collision model for the mesh entity.
   */
  constructor(ent: ServerEdict, model: MeshModel) {
    super(ent);
    this.model = model;
  }
}

export class BrushCollisionState extends CollisionState {
  readonly model: BrushModel;
  readonly origin: Vector;
  readonly angles: Vector;

  /**
   * @param ent Entity being traced against.
   * @param model Brush collision model.
   * @param origin Brush-model origin.
   * @param angles Brush-model angles.
   */
  constructor(ent: ServerEdict, model: BrushModel, origin: Vector, angles: Vector) {
    super(ent);
    this.model = model;
    this.origin = origin;
    this.angles = angles;
  }
}

export class HullCollisionState extends CollisionState {
}

export class MoveClip {
  trace: CollisionTrace;
  start: Vector;
  end: Vector;
  mins: Vector;
  mins2: Vector;
  maxs: Vector;
  maxs2: Vector;
  type: number;
  passedict: ServerEdict | null;
  boxmins: Vector;
  boxmaxs: Vector;

  /**
   * @param trace Current best trace result.
   * @param start World-space trace start.
   * @param end World-space trace end.
   * @param mins Default tracing mins.
   * @param mins2 Alternate mins used for missile-vs-monster checks.
   * @param maxs Default tracing maxs.
   * @param maxs2 Alternate maxs used for missile-vs-monster checks.
   * @param type Move type constant from Defs.moveTypes.
   * @param passedict Entity to skip during tracing.
   */
  constructor(
    trace: CollisionTrace,
    start: Vector,
    end: Vector,
    mins: Vector,
    mins2: Vector,
    maxs: Vector,
    maxs2: Vector,
    type: number,
    passedict: ServerEdict | null,
  ) {
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
  normal: Vector;
  dist: number;

  /**
   * @param normal Collision normal.
   * @param dist Plane distance from origin.
   */
  constructor(normal: Vector = new Vector(), dist = 0.0) {
    this.normal = normal;
    this.dist = dist;
  }

  /**
   * @param plane Source plane.
   * @returns Copied collision plane.
   */
  static fromPlane(plane: CollisionPlaneSource): CollisionPlane {
    return new CollisionPlane(plane.normal.copy(), plane.dist);
  }
}

export class CollisionTrace {
  fraction: number;
  allsolid: boolean;
  startsolid: boolean;
  endpos: Vector;
  plane: CollisionPlane;
  ent: ServerEdict | null;
  inopen: boolean;
  inwater: boolean;

  /**
   * @param endpos Final trace end position.
   * @param options Trace initialization options.
   */
  constructor(endpos: Vector, options: CollisionTraceOptions = {}) {
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
   * @param end End position.
   * @returns Empty trace.
   */
  static empty(end: Vector): CollisionTrace {
    return new CollisionTrace(end.copy());
  }

  /**
   * @param end End position.
   * @returns Hull-initialized trace.
   */
  static hullInitial(end: Vector): CollisionTrace {
    return new CollisionTrace(end.copy(), { allsolid: true });
  }

  /**
   * @param brushTrace Shared brush trace result.
   * @param ent Entity that owns the brush model.
   * @returns Server collision trace.
   */
  static fromSharedTrace(brushTrace: SharedBrushTrace, ent: ServerEdict): CollisionTrace {
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
  readonly ent: ServerEdict;
  readonly model: MeshModel;
  readonly start: Vector;
  readonly end: Vector;
  readonly origin: Vector;
  readonly moveDir: Vector;
  readonly startCenter: Vector;
  readonly boxExtents: Vector;
  readonly forward: Vector;
  readonly right: Vector;
  readonly up: Vector;

  /**
   * @param ent Entity being traced against.
   * @param model Mesh collision model.
   * @param start Start position.
   * @param mins Minimum extents of the moving box.
   * @param maxs Maximum extents of the moving box.
   * @param end End position.
   */
  constructor(ent: ServerEdict, model: MeshModel, start: Vector, mins: Vector, maxs: Vector, end: Vector) {
    this.ent = ent;
    this.model = model;
    this.start = start;
    this.end = end;
    this.origin = ent.entity!.origin;

    const mat = ent.entity!.angles.toRotationMatrix();
    this.forward = new Vector(mat[0], mat[1], mat[2]);
    this.right = new Vector(mat[3], mat[4], mat[5]);
    this.up = new Vector(mat[6], mat[7], mat[8]);
    this.moveDir = end.copy().subtract(start);
    this.boxExtents = maxs.copy().subtract(mins).multiply(0.5);
    this.startCenter = start.copy().add(mins.copy().add(maxs).multiply(0.5));
  }

  /**
   * Transform a model-space vertex into world space.
   * @param x X component in model space.
   * @param y Y component in model space.
   * @param z Z component in model space.
   * @returns Transformed world-space vertex.
   */
  transformVertex(x: number, y: number, z: number): Vector {
    return this.origin.copy()
      .add(this.forward.copy().multiply(x))
      .add(this.right.copy().multiply(y))
      .add(this.up.copy().multiply(z));
  }

  /**
   * Project a point onto a plane.
   * @param point Point to project.
   * @param normal Plane normal.
   * @param planeDist Plane distance from origin.
   * @returns Projected point on the plane.
   */
  projectPointOntoPlane(point: Vector, normal: Vector, planeDist: number): Vector {
    const height = normal.dot(point) - planeDist;
    return new Vector(
      point[0] - normal[0] * height,
      point[1] - normal[1] * height,
      point[2] - normal[2] * height,
    );
  }

  /**
   * Compute the box support radius along a plane normal.
   * @param normal Plane normal.
   * @returns Support radius along the normal.
   */
  getBoxSupportRadius(normal: Vector): number {
    return this.boxExtents[0] * Math.abs(normal[0])
      + this.boxExtents[1] * Math.abs(normal[1])
      + this.boxExtents[2] * Math.abs(normal[2]);
  }

  /**
   * Compute the box-center position at a trace fraction.
   * @param fraction Trace fraction.
   * @returns Center position at the fraction.
   */
  getCenterAtFraction(fraction: number): Vector {
    return new Vector(
      this.startCenter[0] + this.moveDir[0] * fraction,
      this.startCenter[1] + this.moveDir[1] * fraction,
      this.startCenter[2] + this.moveDir[2] * fraction,
    );
  }

  /**
   * Compute the trace endpoint at a trace fraction.
   * @param fraction Trace fraction.
   * @returns End position at the fraction.
   */
  getTraceEndAtFraction(fraction: number): Vector {
    return new Vector(
      this.start[0] + this.moveDir[0] * fraction,
      this.start[1] + this.moveDir[1] * fraction,
      this.start[2] + this.moveDir[2] * fraction,
    );
  }
}

export class MeshTriangle {
  readonly v0: Vector;
  readonly v1: Vector;
  readonly v2: Vector;
  readonly normal: Vector;
  readonly planeDist: number;

  /**
   * @param v0 First world-space vertex.
   * @param v1 Second world-space vertex.
   * @param v2 Third world-space vertex.
   * @param normal Unit face normal.
   * @param planeDist Plane distance from origin.
   */
  constructor(v0: Vector, v1: Vector, v2: Vector, normal: Vector, planeDist: number) {
    this.v0 = v0;
    this.v1 = v1;
    this.v2 = v2;
    this.normal = normal;
    this.planeDist = planeDist;
  }

  /**
   * Build a world-space triangle from mesh data.
   * @param meshTrace Mesh tracing context.
   * @param triangleIndex Triangle index within the mesh.
   * @returns Transformed triangle, or null for degenerate faces.
   */
  static fromMesh(meshTrace: MeshTraceContext, triangleIndex: number): MeshTriangle | null {
    const indices = meshTrace.model.indices;
    const vertices = meshTrace.model.vertices;

    console.assert(indices !== null && vertices !== null, 'mesh collision model must have vertices and indices');

    const liveIndices = indices!;
    const liveVertices = vertices!;

    const idx0 = liveIndices[triangleIndex * 3];
    const idx1 = liveIndices[triangleIndex * 3 + 1];
    const idx2 = liveIndices[triangleIndex * 3 + 2];

    const v0 = meshTrace.transformVertex(
      liveVertices[idx0 * 3],
      liveVertices[idx0 * 3 + 1],
      liveVertices[idx0 * 3 + 2],
    );
    const v1 = meshTrace.transformVertex(
      liveVertices[idx1 * 3],
      liveVertices[idx1 * 3 + 1],
      liveVertices[idx1 * 3 + 2],
    );
    const v2 = meshTrace.transformVertex(
      liveVertices[idx2 * 3],
      liveVertices[idx2 * 3 + 1],
      liveVertices[idx2 * 3 + 2],
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
   * @param moveDir Sweep direction in world space.
   * @returns Positive when moving toward the front face.
   */
  getApproach(moveDir: Vector): number {
    return -(this.normal[0] * moveDir[0] + this.normal[1] * moveDir[1] + this.normal[2] * moveDir[2]);
  }
}
