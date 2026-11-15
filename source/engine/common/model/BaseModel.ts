import GL from '../../client/GL.ts';
import { eventBus } from '../EventBus.ts';
import Vector from '../../../shared/Vector.ts';
import type { ModelType } from '../Mod.ts';
import { modelFlags } from '../../../shared/Defs.ts';

let gl: WebGL2RenderingContext | null = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

export enum ModelState {
  NOT_READY = 'not-ready',
  LOADING = 'loading',
  READY = 'ready',
  FAILED = 'failed',
}

export type PlaneSignBits = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Shared plane representation used by BSP rendering and collision code.
 */
export class Plane {
  type = 0;

  /** Bits 1, 2, and 3 encode the signs of the normal components. */
  signbits: PlaneSignBits = 0;

  /** Plane normal. Face normals are usually more reliable for winding-facing work. */
  normal: Vector;

  /** Distance from the origin measured along the plane normal. */
  dist: number;

  constructor(normal: Vector, dist: number) {
    this.normal = normal;
    this.dist = dist;
  }
}

/**
 * Shared face metadata used by brush models and lightmap generation.
 */
export class Face {
  /** True when this face belongs to an inline submodel. */
  submodel = false;

  /** BSP plane linked during loading. */
  plane: Plane | null = null;

  /** True when the face uses the back side of its BSP plane. */
  planeBack = false;

  /** First surfedge index for this face. */
  firstedge = 0;

  /** Number of surfedges referenced by this face. */
  numedges = 0;

  /** Texture info index. */
  texinfo = 0;

  /** Lightstyle ids used by this face. */
  styles: number[] = [];

  /** Offset into the baked light data. */
  lightofs = 0;

  /** Texture index used by the renderer. */
  texture = 0;

  /** Texture-space minimum extents. */
  texturemins: [number, number] = [0, 0];

  /** Texture-space size extents. */
  extents: [number, number] = [0, 0];

  /** Optional per-face lightmap downscale shift. */
  lmshift: number | null = null;

  /** True when this face uses turbulent warping. */
  turbulent = false;

  /** True when this face renders as sky. */
  sky = false;

  /** Face normal oriented to the BSP face side. */
  normal = new Vector();

  /**
   * Per-vertex normals from the BSPX `FACENORMALS` lump, aligned to the original per-edge vertex
   * order (index i corresponds to the vertex produced by `surfedges[firstedge + i]`). Null when
   * the lump is absent, in which case the renderer falls back to the flat `normal` above.
   */
  vertexNormals: Vector[] | null = null;

  /** Per-vertex tangents from the BSPX `FACENORMALS` lump, aligned like `vertexNormals`. */
  vertexTangents: Vector[] | null = null;

  /** Per-vertex bitangents from the BSPX `FACENORMALS` lump, aligned like `vertexNormals`. */
  vertexBitangents: Vector[] | null = null;

  /** Dynamic light bitmask affecting this face. */
  dlightbits = 0;

  /** Last frame index that updated the dynamic light bits. */
  dlightframe = -1;

  // ─── Renderer-side state (populated by BrushModelRenderer) ───────────────

  /** Rendered vertex data packed by the display list builder. Each entry is a vertex attribute array. */
  verts: number[][] | null = null;

  /** Lightmap atlas block S coordinate (set by the lightmap allocator). */
  light_s = 0;

  /** Lightmap atlas block T coordinate (set by the lightmap allocator). */
  light_t = 0;
}

/**
 * Base class for all model types.
 *
 * Holds common bounds, loading state, and runtime-only rendering resources
 * shared by brush, sprite, alias, and mesh models.
 */
export class BaseModel {
  static STATE = ModelState;

  /** Model name or load path. */
  name: string;

  /** Concrete model type, assigned by subclasses. */
  type: ModelType | null;

  /** Number of frames in file. */
  _num_frames = 0;

  /** Number of skins in file. */
  _num_skins = 0;

  /** Number of triangles, also consumed by the renderer. */
  _num_tris = 0;

  /** Number of vertices in the loaded model. */
  _num_verts = 0;

  /** Scale factors applied to model vertices. */
  _scale: Vector | null = new Vector(1.0, 1.0, 1.0);

  /** Origin offset applied to model vertices. */
  _scale_origin: Vector | null = new Vector();

  /** Randomization flag retained from legacy formats. */
  _random = false;

  /** True while the file still needs loading. */
  needload = true;

  /** Simple CRC checksum used to detect content changes. */
  checksum = 0;

  /** Bounding box minimum, required by gameplay and rendering code. */
  mins = new Vector();

  /** Bounding box maximum, required by gameplay and rendering code. */
  maxs = new Vector();

  /** Model-space origin offset. */
  origin = new Vector();

  /** Legacy client-side model flags. Alias models populate this, other model types leave it at zero. */
  flags = modelFlags.MF_NONE;

  /** True when the model was loaded without looking for its sidecar file, because the game said there is none. */
  sidecarSkipped = false;

  /** True when animation frames should be selected randomly. Alias models populate this, other model types leave it at false. */
  random = false;

  /** Shared alias-model command buffer, when applicable. */
  cmds: WebGLBuffer | null = null;

  /**
   * False when the model was loaded without the per-vertex data collision code traces against, which
   * a realm without a renderer may do for models nobody traces. `mins`/`maxs` are valid either way.
   * Only alias models can be loaded that way; every other type always has what it has.
   * @returns True when collision code can trace against this model's own geometry.
   */
  get hasCollisionGeometry(): boolean {
    return true;
  }

  constructor(name: string) {
    this.name = name;
    this.type = null;
    this.reset();
  }

  /**
   * Finds a tag: a named place on the model that something else can follow, such as the muzzle of a weapon or the hand
   * of a monster. A model without tags has none.
   * @param _name The name of the tag.
   * @returns The index that `sampleTag` takes, -1 when there is none of that name.
   */
  getTagIndex(_name: string): number {
    return -1;
  }

  /**
   * Where a tag is on the model for a pose between two frames. The transform is rigid, with no scale, and in the model's
   * own space: apply the entity's origin and angles to it to get the world.
   * @param _index A tag index from `getTagIndex`.
   * @param _frameA First frame.
   * @param _frameB Second frame.
   * @param _blend Weight of `frameB`, 0 to 1. The pose of a tag is interpolated like the model's vertices, so the two
   * are at the same place.
   * @param _out Receives the origin `x, y, z` and the rotation as a quaternion `w, x, y, z`, 7 numbers.
   * @returns `false` when the model has no such tag, and `out` untouched.
   */
  sampleTag(_index: number, _frameA: number, _frameB: number, _blend: number, _out: Float32Array | Float64Array | number[]): boolean {
    return false;
  }

  /**
   * Finds a named sequence, so a game does not depend on their order. A model without named sequences has none.
   * What the number selects depends on the format: see `SpriteModel` and `SkeletalModel`.
   * @param _name The name of the sequence.
   * @returns The number that selects it, -1 when there is none of that name.
   */
  sequenceIndex(_name: string): number {
    return -1;
  }

  /**
   * How long a sequence plays, for effects that remove themselves when it is over.
   * @param _sequence The sequence number.
   * @returns Seconds, `Infinity` for a sequence that repeats forever, 0 for a model without sequences and for one that
   * holds a single pose or picture.
   */
  sequenceDuration(_sequence: number): number {
    return 0;
  }

  reset(): void {
    // Private variables used while loading.
    this._num_frames = 0;
    this._num_skins = 0;
    this._num_tris = 0;
    this._num_verts = 0;
    this._scale = new Vector(1.0, 1.0, 1.0);
    this._scale_origin = new Vector();
    this._random = false;

    // Public variables shared across model users.
    this.needload = true;
    this.checksum = 0;
    this.mins = new Vector();
    this.maxs = new Vector();
    this.origin = new Vector();
    this.flags = 0;
    this.random = false;
    this.sidecarSkipped = false;

    // Runtime-only rendering state.
    this.cmds = null;
  }

  /**
   * Creates a per-scope runtime view that reuses immutable model data.
   * @returns A scoped model view that shares immutable backing data.
   */
  createScopedView(): this {
    return Object.assign(
      Object.create(Object.getPrototypeOf(this)) as this,
      this,
    );
  }

  /**
   * Returns the active GL context, if a client renderer is currently running.
   * @returns The active WebGL context, or `null` when rendering is unavailable.
   */
  protected _getGLContext(): WebGL2RenderingContext | null {
    return gl;
  }

  /**
   * Releases runtime-only resources owned by a scoped model view.
   */
  cleanupScopedView(): void {
    // Base models do not assume ownership of shared GPU resources.
  }
}
