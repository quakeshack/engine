import GL from '../../client/GL.ts';
import { eventBus } from '../../registry.ts';
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

  /** True when animation frames should be selected randomly. Alias models populate this, other model types leave it at false. */
  random = false;

  /** Shared alias-model command buffer, when applicable. */
  cmds: WebGLBuffer | null = null;

  constructor(name: string) {
    this.name = name;
    this.type = null;
    this.reset();
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
