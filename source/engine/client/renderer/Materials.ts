import { eventBus, getClientRegistry } from '../../registry.ts';
import type { ClientEdict } from '../ClientEntities.ts';
import GL, { GLTexture, type GLProgramInfo } from '../GL.ts';

let { CL, R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, R } = getClientRegistry());

  // no renderer available in headless mode, so we need to provide a fallback for material renderer state access
  if (!R) {
    R = {
      blacktexture: nullTexture,
      notexture: nullTexture,
      flatnormalmap: nullTexture,
      interpolation: { value: false },
      c_brush_texture_binds: 0,
    } as unknown as typeof R;
  }
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

const nullTexture: GLTexture = {
  bind() {},
  free() {},
} as unknown as GLTexture;

export enum MaterialFlags {
  MF_NONE = 0,
  MF_TRANSPARENT = 1,
  MF_SKY = 2,
  MF_TURBULENT = 4,
  MF_SKIP = 8,
  MF_FULLBRIGHT = 16,
}

/**
 * Resolve the luminance texture for a material draw.
 * Materials flagged MF_FULLBRIGHT fall back to their diffuse texture when they
 * do not provide a separate luminance map.
 * @param flags Material flags.
 * @param luminanceTexture Explicit luminance texture.
 * @param diffuseTexture Active diffuse texture.
 * @param fallbackTexture Renderer fallback texture.
 * @returns Luminance texture to bind for the draw.
 */
export function resolveMaterialLuminanceTexture(flags: number, luminanceTexture: GLTexture | null, diffuseTexture: GLTexture | null, fallbackTexture: GLTexture): GLTexture {
  if (luminanceTexture && luminanceTexture !== fallbackTexture) {
    return luminanceTexture;
  }

  if ((flags & MaterialFlags.MF_FULLBRIGHT) !== 0 && diffuseTexture !== null) {
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
  /** Material render flags, a combination of {@link MaterialFlags} bits. */
  flags: MaterialFlags = MaterialFlags.MF_NONE;

  /** Texture / material name. */
  name: string;

  /** Texture width in texels. */
  width: number;

  /** Texture height in texels. */
  height: number;

  /** Current alpha value resolved per-draw. */
  currentAlpha = 1.0;

  /** Average color of the texture as [r, g, b] in 0-255 range. */
  averageColor: [number, number, number] = [128, 128, 128];

  /**
   * Fog tint used by the underwater fog effect when the camera is inside this
   * turbulent material. RGB in 0-1 range. Null = fall back to the content-type
   * default color. Populated from the texture's average color once available.
   */
  fogTint: [number, number, number] | null = null;

  constructor(name: string, width: number, height: number) {
    this.name = name;
    this.width = width;
    this.height = height;
  }


  bindTo(_program: GLProgramInfo): void {
    // to be implemented by subclasses
  }

  emit(clientEdict: ClientEdict | null = null): void {
    this.currentAlpha = this.resolveAlpha(clientEdict);
  }

  /**
   * Resolve the effective alpha for this material on the current draw.
   * @param clientEdict Client entity being rendered.
   * @returns Alpha in the 0..1 range.
   */
  protected resolveAlpha(clientEdict: ClientEdict | null = null): number {
    if ((this.flags & MaterialFlags.MF_TURBULENT) === 0 || clientEdict === null) {
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
   * @returns Ordered list of worldspawn keys to query.
   */
  protected _getLiquidAlphaKeys(): string[] {
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

  free(): void {
    // to be implemented by subclasses
  }
}

class BrushMaterial extends BaseMaterial {
  /** Luminance/emissive texture for this material. */
  luminance: GLTexture;

  constructor(name: string, width: number, height: number) {
    super(name, width, height);
    this.luminance = R.blacktexture;
  }

  /**
   * @param program Active shader program.
   */
  protected _bindInterpolation(program: GLProgramInfo): void {
    if (program.uInterpolation !== undefined) {
      gl.uniform1f(program.uInterpolation!, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);
    }
  }

  /**
   * @returns Luminance texture for the current draw.
   */
  protected _getLuminanceTexture(): GLTexture {
    return resolveMaterialLuminanceTexture(this.flags, this.luminance, this._getCurrentTexture(), R.blacktexture);
  }

  /**
   * @param program Active shader program.
   */
  protected _bindLuminance(program: GLProgramInfo): void {
    if (program.tLuminance !== undefined) {
      this._getLuminanceTexture().bind(program.tLuminance!);
      R.c_brush_texture_binds++;
    }
  }

  /**
   * @returns Current diffuse texture for the draw.
   */
  protected _getCurrentTexture(): GLTexture {
    return R.notexture;
  }

  /**
   * @returns Next diffuse texture for interpolated draws.
   */
  protected _getNextTexture(): GLTexture {
    return this._getCurrentTexture();
  }

  /**
   * @param program Active shader program.
   */
  protected _bindPrimaryTextures(program: GLProgramInfo): void {
    const currentTexture = this._getCurrentTexture();

    if (program.tTextureA !== undefined && program.tTextureB !== undefined) {
      currentTexture.bind(program.tTextureA!);
      this._getNextTexture().bind(program.tTextureB!);
      R.c_brush_texture_binds += 2;
    }

    if (program.tTexture !== undefined) {
      currentTexture.bind(program.tTexture!);
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
  #textures: GLTexture[] = [];
  #luminanceTextures: (GLTexture | null)[] = [];
  #frames = 1;
  #alternateFrames = 0;
  #frame = 0;
  #nextFrame = 0;

  override bindTo(program: GLProgramInfo): void {
    gl.uniform1i(program.uPerformDotLighting!, 0);
    this._bindInterpolation(program);
    this._bindPrimaryTextures(program);
    this._bindLuminance(program);
  }

  set texture(texture: GLTexture) {
    this.#textures[0] = texture;
    this.#textures.length = 1;
  }

  set luminanceTexture(texture: GLTexture) {
    this.#luminanceTextures[0] = texture;
    this.#luminanceTextures.length = 1;
  }

  get texture(): GLTexture | null {
    return this.#textures[0] || null;
  }

  get luminanceTexture(): GLTexture | null {
    return this.#luminanceTextures[0] || null;
  }

  /**
   * @returns Current diffuse texture for the active animation frame.
   */
  protected override _getCurrentTexture(): GLTexture {
    return this.#textures[this.#frame] || R.notexture;
  }

  /**
   * @returns Next diffuse texture for the active animation frame.
   */
  protected override _getNextTexture(): GLTexture {
    return this.#textures[this.#nextFrame] || this._getCurrentTexture();
  }

  /**
   * @returns Luminance texture for the active animation frame.
   */
  protected override _getLuminanceTexture(): GLTexture {
    return resolveMaterialLuminanceTexture(this.flags, this.#luminanceTextures[this.#frame] || null, this._getCurrentTexture(), R.blacktexture);
  }

  addAnimationFrame(num: number, frameTexture: GLTexture, frameLuminanceTexture: GLTexture | null = null): void {
    this.#frames = Math.max(this.#frames, num + 1);
    this.#textures[num] = frameTexture;
    this.#luminanceTextures[num] = frameLuminanceTexture;
  }

  addAlternateFrame(num: number, frameTexture: GLTexture, frameLuminanceTexture: GLTexture | null = null): void {
    this.#alternateFrames = Math.max(this.#alternateFrames, num + 1);
    this.#textures[num + 10] = frameTexture;
    this.#luminanceTextures[num + 10] = frameLuminanceTexture;
  }

  override emit(clientEdict: ClientEdict | null = null): void {
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

  override free(): void {
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
}

/**
 * A class representing a PBR material.
 */
export class PBRMaterial extends BrushMaterial {
  /** Diffuse (albedo) texture. */
  diffuse: GLTexture;

  /** Specular texture. */
  specular: GLTexture;

  /** Normal map texture. */
  normal: GLTexture;

  constructor(name: string, width: number, height: number) {
    super(name, width, height);
    this.diffuse = R.notexture;
    this.specular = R.blacktexture;
    this.normal = R.flatnormalmap;
  }

  override bindTo(program: GLProgramInfo): void {
    if (program.uPerformDotLighting !== undefined) {
      gl.uniform1i(program.uPerformDotLighting!, 1);
    }

    this._bindInterpolation(program);
    this._bindPrimaryTextures(program);

    if (program.tSpecular !== undefined) {
      this.specular.bind(program.tSpecular!);
      R.c_brush_texture_binds++;
    }

    if (program.tNormal !== undefined) {
      this.normal.bind(program.tNormal!);
      R.c_brush_texture_binds++;
    }

    this._bindLuminance(program);
  }

  override emit(clientEdict: ClientEdict | null = null): void {
    this.currentAlpha = this.resolveAlpha(clientEdict);
  }

  override free(): void {
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
   * @returns Current diffuse texture for PBR draws.
   */
  protected override _getCurrentTexture(): GLTexture {
    return this.diffuse || R.notexture;
  }
}

class NoTextureMaterial extends BaseMaterial {
  constructor() {
    super('notexture', 16, 16);
  }

  override bindTo(_program: GLProgramInfo): void {
    R.notexture.bind(0);
  }
}

export const noTextureMaterial = new NoTextureMaterial();
