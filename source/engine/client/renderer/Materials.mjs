import { eventBus, registry } from '../../registry.mjs';
import { ClientEdict } from '../ClientEntities.ts';
import GL, { GLTexture } from '../GL.mjs';

let { CL, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  R = registry.R;

  // no renderer available in headless mode, so we need to provide a fallback for material renderer state access
  if (!R) {
    // @ts-ignore
    R = {
      blacktexture: nullTexture,
      notexture: nullTexture,
      flatnormalmap: nullTexture,
      interpolation: { value: false },
      c_brush_texture_binds: 0,
    };
  }
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/** @typedef {{ blacktexture: GLTexture, notexture: GLTexture, flatnormalmap: GLTexture, interpolation: { value: boolean }, c_brush_texture_binds: number }} MaterialRendererState */

const nullTexture = /** @type {GLTexture} */ ({
  bind() {},
  free() {},
});

export const materialFlags = Object.freeze({
  MF_NONE: 0,
  MF_TRANSPARENT: 1,
  MF_SKY: 2,
  MF_TURBULENT: 4,
  MF_SKIP: 8,
  MF_FULLBRIGHT: 16,
});

/**
 * Resolve the luminance texture for a material draw.
 * Materials flagged MF_FULLBRIGHT fall back to their diffuse texture when they
 * do not provide a separate luminance map.
 * @param {number} flags Material flags.
 * @param {GLTexture|null} luminanceTexture Explicit luminance texture.
 * @param {GLTexture|null} diffuseTexture Active diffuse texture.
 * @param {GLTexture} fallbackTexture Renderer fallback texture.
 * @returns {GLTexture} Luminance texture to bind for the draw.
 */
export function resolveMaterialLuminanceTexture(flags, luminanceTexture, diffuseTexture, fallbackTexture) {
  if (luminanceTexture && luminanceTexture !== fallbackTexture) {
    return luminanceTexture;
  }

  if ((flags & materialFlags.MF_FULLBRIGHT) !== 0 && diffuseTexture !== null) {
    return diffuseTexture;
  }

  return fallbackTexture;
}

/**
 * A class representing a material.
 * It holds various properties like texture, flags, etc.
 * Also responsible for managing animations etc.
 */
export class BaseMaterial {
  flags = /** @type {number} */ (materialFlags.MF_NONE);
  name = /** @type {string} */ (null);
  width = /** @type {number} */ (0);
  height = /** @type {number} */ (0);
  currentAlpha = 1.0;

  /** @type {number[]} Average color of the texture as [r, g, b] in 0-255 range */
  averageColor = [128, 128, 128];

  /**
   * @param {string} name name
   * @param {number} width width
   * @param {number} height height
   */
  constructor(name, width, height) {
    this.name = name;
    this.width = width;
    this.height = height;
  }

  // eslint-disable-next-line no-unused-vars
  bindTo(program) {
    // to be implemented by subclasses
  }

  emit(/** @type {ClientEdict?} */ clientEdict = null) {
    this.currentAlpha = this.resolveAlpha(clientEdict);
  }

  /**
   * Resolve the effective alpha for this material on the current draw.
   * @protected
   * @param {ClientEdict?} clientEdict Client entity being rendered.
   * @returns {number} Alpha in the 0..1 range.
   */
  resolveAlpha(clientEdict = null) {
    if ((this.flags & materialFlags.MF_TURBULENT) === 0 || clientEdict === null) {
      return 1.0;
    }

    const worldspawn = CL.state.clientEntities.getEntity(0);
    if (clientEdict !== worldspawn) {
      return 1.0;
    }

    const worldspawnInfo = CL.state.worldmodel?.worldspawnInfo;
    if (!worldspawnInfo) {
      return 1.0;
    }

    const alphaKeys = this._getLiquidAlphaKeys();
    for (let i = 0; i < alphaKeys.length; i++) {
      const rawValue = worldspawnInfo[alphaKeys[i]];
      if (rawValue === undefined) {
        continue;
      }

      const parsedAlpha = Number.parseFloat(rawValue);
      if (Number.isFinite(parsedAlpha)) {
        return Math.max(0.0, Math.min(parsedAlpha, 1.0));
      }
    }

    return 1.0;
  }

  /**
   * Pick the relevant worldspawn alpha keys for this turbulent material.
   * @protected
   * @returns {string[]} Ordered list of worldspawn keys to query.
   */
  _getLiquidAlphaKeys() {
    const lowerName = this.name.toLowerCase();

    if (lowerName.includes('lava')) {
      return ['_lavaalpha', 'lavaalpha'];
    }

    if (lowerName.includes('slime')) {
      return ['_slimealpha', 'slimealpha'];
    }

    if (lowerName.includes('tele')) {
      return ['_telealpha', 'telealpha', '_teleportalpha', 'teleportalpha'];
    }

    return ['_wateralpha', 'wateralpha'];
  }

  free() {
    // to be implemented by subclasses
  }

  [Symbol.dispose]() { // make sure we always free resources
    this.free();
  }
};

class BrushMaterial extends BaseMaterial {
  luminance = /** @type {GLTexture} */ (null);

  constructor(name, width, height) {
    super(name, width, height);

    this.luminance = R.blacktexture;
  }

  /**
   * @protected
   * @param {object} program Active shader program.
   */
  _bindInterpolation(program) {
    if (program.uInterpolation !== undefined) {
      gl.uniform1f(program.uInterpolation, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);
    }
  }

  /**
   * @protected
   * @returns {GLTexture} Luminance texture for the current draw.
   */
  _getLuminanceTexture() {
    return resolveMaterialLuminanceTexture(this.flags, this.luminance, this._getCurrentTexture(), R.blacktexture);
  }

  /**
   * @protected
   * @param {object} program Active shader program.
   */
  _bindLuminance(program) {
    if (program.tLuminance !== undefined) {
      this._getLuminanceTexture().bind(program.tLuminance);
      R.c_brush_texture_binds++;
    }
  }

  /**
   * @protected
   * @returns {GLTexture} Current diffuse texture for the draw.
   */
  _getCurrentTexture() {
    return R.notexture;
  }

  /**
   * @protected
   * @returns {GLTexture} Next diffuse texture for interpolated draws.
   */
  _getNextTexture() {
    return this._getCurrentTexture();
  }

  /**
   * @protected
   * @param {object} program Active shader program.
   */
  _bindPrimaryTextures(program) {
    const currentTexture = this._getCurrentTexture();

    if (program.tTextureA !== undefined && program.tTextureB !== undefined) {
      currentTexture.bind(program.tTextureA);
      this._getNextTexture().bind(program.tTextureB);
      R.c_brush_texture_binds += 2;
    }

    if (program.tTexture !== undefined) {
      currentTexture.bind(program.tTexture);
      R.c_brush_texture_binds++;
    }
  }
}

/**
 * A class representing a Quake-style material with animation frames.
 * It supports multiple frames and alternate frames for different states.
 * No support for PBR or advanced features.
 */
export class QuakeMaterial extends BrushMaterial {
  #textures = /** @type {GLTexture[]} */ ([]);
  #luminanceTextures = /** @type {(GLTexture|null)[]} */ ([]);

  #frames = /** @type {number} */ (1);
  #alternateFrames = /** @type {number} */ (0);

  #frame = 0;
  #nextFrame = 0;

  bindTo(program) {
    gl.uniform1i(program.uPerformDotLighting, 0);
    this._bindInterpolation(program);

    this._bindPrimaryTextures(program);
    this._bindLuminance(program);
  }

  set texture(texture) {
    this.#textures[0] = texture;
    this.#textures.length = 1;
  }

  set luminanceTexture(texture) {
    this.#luminanceTextures[0] = texture;
    this.#luminanceTextures.length = 1;
  }

  get texture() {
    return this.#textures[0] || null;
  }

  get luminanceTexture() {
    return this.#luminanceTextures[0] || null;
  }

  /**
   * @protected
   * @returns {GLTexture} Current diffuse texture for the active animation frame.
   */
  _getCurrentTexture() {
    return this.#textures[this.#frame] || R.notexture;
  }

  /**
   * @protected
   * @returns {GLTexture} Next diffuse texture for the active animation frame.
   */
  _getNextTexture() {
    return this.#textures[this.#nextFrame] || this._getCurrentTexture();
  }

  /**
   * @protected
   * @returns {GLTexture} Luminance texture for the active animation frame.
   */
  _getLuminanceTexture() {
    return resolveMaterialLuminanceTexture(this.flags, this.#luminanceTextures[this.#frame] || null, this._getCurrentTexture(), R.blacktexture);
  }

  addAnimationFrame(num, frameTexture, frameLuminanceTexture = null) {
    this.#frames = Math.max(this.#frames, num + 1);
    this.#textures[num] = frameTexture;
    this.#luminanceTextures[num] = frameLuminanceTexture;
  }

  addAlternateFrame(num, frameTexture, frameLuminanceTexture = null) {
    this.#alternateFrames = Math.max(this.#alternateFrames, num + 1);
    this.#textures[num + 10] = frameTexture;
    this.#luminanceTextures[num + 10] = frameLuminanceTexture;
  }

  emit(/** @type {ClientEdict} */ clientEdict = null) {
    this.currentAlpha = this.resolveAlpha(clientEdict);
    const frame = Math.floor((clientEdict !== null ? clientEdict.frame : 0) + CL.state.time * 5.0);
    const useAlternate = (clientEdict !== null && clientEdict.frame > 0 && this.#alternateFrames > 0);

    if (useAlternate) {
      this.#frame = 10 + (frame % this.#alternateFrames);
      this.#nextFrame = 10 + ((frame + 1) % this.#alternateFrames);
    } else {
      this.#frame = frame % this.#frames;
      this.#nextFrame = (frame + 1) % this.#frames;
    }
  }

  free() {
    for (const tex of this.#textures) {
      tex.free();
    }

    for (const tex of this.#luminanceTextures) {
      if (tex && tex !== R.blacktexture) {
        tex.free();
      }
    }

    this.#textures.length = 0;
    this.#luminanceTextures.length = 0;
  }
};

/**
 * A class representing a PBR material.
 */
export class PBRMaterial extends BrushMaterial {
  diffuse = /** @type {GLTexture} */ (null);
  specular = /** @type {GLTexture} */ (null);
  normal = /** @type {GLTexture} */ (null);

  constructor(name, width, height) {
    super(name, width, height);

    this.diffuse = R.notexture;
    this.specular = R.blacktexture;
    this.normal = R.flatnormalmap;
  }

  bindTo(program) {
    if (program.uPerformDotLighting !== undefined) {
      gl.uniform1i(program.uPerformDotLighting, 1);
    }

    this._bindInterpolation(program);

    this._bindPrimaryTextures(program);

    if (program.tSpecular !== undefined) {
      this.specular.bind(program.tSpecular);
      R.c_brush_texture_binds++;
    }

    if (program.tNormal !== undefined) {
      this.normal.bind(program.tNormal);
      R.c_brush_texture_binds++;
    }

    this._bindLuminance(program);
  }

  emit(/** @type {ClientEdict?} */ clientEdict = null) {
    this.currentAlpha = this.resolveAlpha(clientEdict);
  }

  free() {
    if (this.diffuse !== R.notexture) {
      this.diffuse.free();
    }

    if (this.luminance !== R.blacktexture) {
      this.luminance.free();
    }

    if (this.specular !== R.blacktexture) {
      this.specular.free();
    }

    if (this.normal !== R.flatnormalmap) {
      this.normal.free();
    }
  }

  /**
   * @protected
   * @returns {GLTexture} Current diffuse texture for PBR draws.
   */
  _getCurrentTexture() {
    return this.diffuse || R.notexture;
  }
};

class NoTextureMaterial extends BaseMaterial {
  constructor() {
    super('notexture', 16, 16);
  }

  bind() {
    R.notexture.bind(0);
  }
}

export const noTextureMaterial = new NoTextureMaterial();
