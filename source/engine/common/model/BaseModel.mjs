import GL from '../../client/GL.mjs';
import { eventBus } from '../../registry.mjs';
import Vector from '../../../shared/Vector.ts';

let gl = /** @type {WebGL2RenderingContext|null} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

export class Plane { // TODO: move to shared
  type = 0;

  /** @type {0|1|2|3|4|5|6|7} bits 1, 2 and 3 represent the normal’s components signess */
  signbits = 0;

  /**
   * @param {Vector} normal normal vector
   * @param {number} dist distance from origin
   */
  constructor(normal, dist) {
    /** @type {Vector} plane’s normal vector, on n-sided polygons it might not be facing correctly, better use Face’s normal instead. */
    this.normal = normal;

    /** @type {number} distance from origin along normal (in direction of normal) */
    this.dist = dist;
  }
};

export class Face {
  submodel = false;
  plane = /** @type {Plane} */(null); // will be linked during loading

  /** @type {boolean} True when the face uses the back side of its BSP plane. */
  planeBack = false;
  firstedge = 0;
  numedges = 0;
  texinfo = 0;
  styles = /** @type {number[]} */([]);
  lightofs = 0;
  texture = 0;
  texturemins = [0, 0];
  extents = [0, 0];

  // lightmap scaling
  lmshift = null;

  // TODO: refactor these fields into a flags bitmap, there’s more to come
  turbulent = false;
  sky = false;

  /** @type {Vector} Face normal oriented to the BSP face side. */
  normal = new Vector();

  dlightbits = 0;
  dlightframe = -1;
};

export class BaseModel {
  static STATE = {
    NOT_READY: 'not-ready',
    LOADING: 'loading',
    READY: 'ready',
    FAILED: 'failed',
  };

  constructor(name) {
    this.name = name;
    this.type = null;
    this.reset();
  }

  reset() {
    // Private variables (used during loading)

    /** @type {number} Number of frames in file */
    this._num_frames = 0;

    /** @type {number} Number of skins in file */
    this._num_skins = 0;

    /** @type {number} Number of triangles (R requires that) */
    this._num_tris = 0;

    /** @type {number} Number of vertices */
    this._num_verts = 0;

    /** @type {Vector} Scale factors for vertices */
    this._scale = new Vector(1.0, 1.0, 1.0);

    /** @type {Vector} Origin offset for vertices */
    this._scale_origin = new Vector();

    /** @type {boolean} FIXME: read but unused */
    this._random = false;

    // Public variables

    /** @type {boolean} Whether the file still needs loading */
    this.needload = true;

    /** @type {number} Simple CRC checksum to check if things are still the same */
    this.checksum = 0;

    /** @type {Vector} Bounding box minimum (required by PF, R, CL, SV on worldmodel) */
    this.mins = new Vector();

    /** @type {Vector} Bounding box maximum (required by PF, R, CL, SV on worldmodel) */
    this.maxs = new Vector();

    /** @type {Vector} Origin offset for vertices */
    this.origin = new Vector();

    // Public variables just for rendering purposes (IDEA: refactor into ModelRenderer classes)

    /** @type {WebGLBuffer|null} WebGLBuffer for alias models, or null for brush/sprite models */
    this.cmds = null;
  }

  /**
   * Create a per-scope runtime view that reuses immutable model data.
   * @returns {BaseModel} scoped runtime view
   */
  createScopedView() {
    const scopedView = /** @type {BaseModel} */ (Object.assign(
      Object.create(Object.getPrototypeOf(this)),
      this,
    ));

    return scopedView;
  }

  /**
   * @protected
   * @returns {WebGL2RenderingContext|null} current GL context, if available
   */
  _getGLContext() {
    return gl;
  }

  /**
   * Release runtime-only resources owned by a scoped model view.
   */
  cleanupScopedView() {
    // Base models do not assume ownership of shared GPU resources.
  }
};
