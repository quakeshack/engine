import { BaseModel } from './BaseModel.mjs';

/**
 * Alias model (.mdl) - Quake's animated mesh format.
 * Used for characters, monsters, weapons, and other animated models.
 */
export class AliasModel extends BaseModel {
  constructor(name) {
    super(name);
    this.type = 2; // Mod.type.alias
  }

  reset() {
    super.reset();

    // Private model data (used during loading)

    /** @type {import('../../../shared/Vector.ts').default|null} Scale factors for vertices */
    this._scale = null;

    /** @type {import('../../../shared/Vector.ts').default|null} Origin offset for vertices */
    this._scale_origin = null;

    /** @type {number} Number of skins in file */
    this._num_skins = 0;

    /** @type {number} Skin texture width */
    this._skin_width = 0;

    /** @type {number} Skin texture height */
    this._skin_height = 0;

    /** @type {number} Number of vertices */
    this._num_verts = 0;

    /** @type {number} Number of triangles */
    this._num_tris = 0;

    /** @type {number} Number of frames in file */
    this._frames = 0;

    /** @type {Array<{facesfront: boolean, vertindex: number[]}>} Triangle definitions */
    this._triangles = [];

    /** @type {Array<{onseam: boolean, s: number, t: number}>} Texture coordinate vertices */
    this._stverts = [];

    // Public variables

    /** @type {number} Model flags (CL requires that together with Mod.flags) */
    this.flags = 0;

    /** @type {boolean} Random frame selection */
    this.random = false;

    /** @type {Array} Animation frames (required by R, Host for name and interval) */
    this.frames = [];

    // Public variables just for rendering purposes (IDEA: refactor into ModelRenderer classes)

    /** @type {Array} Skin textures (R requires that to pick the right texture) */
    this.skins = [];

    /** @type {number} Bounding radius (R requires that) */
    this.boundingradius = 0;

    /** @type {boolean} Is this a player model (R requires that to change colors) */
    this.player = false;
  }
}
