import type { GLTexture } from '../../GL.ts';

export enum MaterialFlags {
  MF_NONE = 0,
  MF_TRANSPARENT = 1,
  MF_SKY = 2,
  MF_TURBULENT = 4,
  MF_SKIP = 8,
  MF_FULLBRIGHT = 16,
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

  /**
   * Pick the relevant worldspawn alpha keys for this turbulent material, which is where a map sets how
   * transparent its liquids are.
   * @returns Ordered list of worldspawn keys to query.
   */
  getLiquidAlphaKeys(): string[] {
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
  /** Luminance/emissive texture for this material, `null` for none (the renderer draws black). */
  luminance: GLTexture | null = null;
}

/**
 * A class representing a Quake-style material with animation frames.
 * It supports multiple frames and alternate frames for different states.
 * No support for PBR or advanced features.
 *
 * It holds the textures and picks the animation frame; `MaterialBinder` binds them for a draw.
 */
export class QuakeMaterial extends BrushMaterial {
  #textures: GLTexture[] = [];
  #luminanceTextures: (GLTexture | null)[] = [];
  #frames = 1;
  #alternateFrames = 0;
  #frame = 0;
  #nextFrame = 0;

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
   * The diffuse texture of the animation frame selected by the last `selectFrame`.
   * @returns The texture, `null` when the frame has none (the renderer draws its fallback).
   */
  get currentTexture(): GLTexture | null {
    return this.#textures[this.#frame] || null;
  }

  /**
   * The diffuse texture of the frame after the selected one, which interpolated draws blend towards.
   * @returns The texture, `null` when that frame has none.
   */
  get nextTexture(): GLTexture | null {
    return this.#textures[this.#nextFrame] || null;
  }

  /**
   * The luminance texture of the selected animation frame.
   * @returns The texture, `null` when the frame has none.
   */
  get currentLuminanceTexture(): GLTexture | null {
    return this.#luminanceTextures[this.#frame] || null;
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

  /**
   * Selects the animation frame for a draw: the frames of the material advance five times per second, and an
   * entity with a frame above 0 shows the alternate animation when the material has one.
   * @param entityFrame The `frame` of the entity being drawn, 0 for the world.
   * @param time The client time.
   */
  selectFrame(entityFrame: number, time: number): void {
    const frame = Math.floor(entityFrame + time * 5.0);
    const useAlternate = entityFrame > 0 && this.#alternateFrames > 0;

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
      tex?.free();
    }

    this.#textures.length = 0;
    this.#luminanceTextures.length = 0;
  }
}

/**
 * A class representing a PBR material. A layer that is `null` has none, and the renderer draws its default for it.
 */
export class PBRMaterial extends BrushMaterial {
  /** Diffuse (albedo) texture. */
  diffuse: GLTexture | null = null;

  /** Specular texture. */
  specular: GLTexture | null = null;

  /** Normal map texture. */
  normal: GLTexture | null = null;

  override free(): void {
    this.diffuse?.free();
    this.luminance?.free();
    this.specular?.free();
    this.normal?.free();
  }
}

/**
 * The material of a surface whose texture is missing; the renderer draws its checkerboard.
 */
export class NoTextureMaterial extends BaseMaterial {
  constructor() {
    super('notexture', 16, 16);
  }
}

export const noTextureMaterial = new NoTextureMaterial();
