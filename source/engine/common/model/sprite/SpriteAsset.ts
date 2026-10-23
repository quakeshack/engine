import type { GLTextureArray } from '../../../client/GL.ts';
import { SpriteAnimator } from './SpriteAnimator.ts';
import { SpriteBlend, type SpriteFilter, type SpriteFrame, type SpriteRegion } from './SpriteTypes.ts';

/** What a {@link SpriteAsset} is made of. */
export interface SpriteAssetOptions {
  readonly frames: readonly SpriteFrame[];
  readonly blend?: SpriteBlend;
  /** How the texture is sampled, `null` to follow `gl_texturemode`. */
  readonly filter?: SpriteFilter | null;
  /** Whether to crossfade from an image to the next. */
  readonly interpolate?: boolean;
  /** Width of every layer of the texture, the largest image. */
  readonly layerWidth?: number;
  /** Height of every layer of the texture, the largest image. */
  readonly layerHeight?: number;
  /** The images as an array texture, `null` in a realm that does not draw. */
  readonly texture?: GLTextureArray | null;
  /** Named rectangles of the images, in file pixels. */
  readonly regions?: ReadonlyMap<string, SpriteRegion>;
}

/**
 * The decoded images of a sprite with their timing. Knows nothing about entities, bounds or the model
 * cache, so anything that wants to draw an animated image can use it, not only world sprites.
 */
export class SpriteAsset {
  /** What an entity's `frame` selects, in order. */
  readonly frames: readonly SpriteFrame[];

  /** How pixels are combined with what is behind them. */
  readonly blend: SpriteBlend;

  /** How the texture is sampled, `null` to follow `gl_texturemode`. */
  readonly filter: SpriteFilter | null;

  /** Whether to crossfade from an image to the next (also needs `r_interpolation`). */
  readonly interpolate: boolean;

  /** Width of every layer of {@link SpriteAsset.texture}. */
  readonly layerWidth: number;

  /** Height of every layer of {@link SpriteAsset.texture}. */
  readonly layerHeight: number;

  /** One layer per image, premultiplied alpha. `null` where nothing is drawn (the server). */
  readonly texture: GLTextureArray | null;

  /** Named rectangles of the images, in the pixels of the file (the sidecar's `regions`, an Aseprite file's slices). */
  readonly regions: ReadonlyMap<string, SpriteRegion>;

  constructor(options: SpriteAssetOptions) {
    this.frames = options.frames;
    this.blend = options.blend ?? SpriteBlend.alphaTest;
    this.filter = options.filter ?? null;
    this.interpolate = options.interpolate ?? false;
    this.layerWidth = options.layerWidth ?? 0;
    this.layerHeight = options.layerHeight ?? 0;
    this.texture = options.texture ?? null;
    this.regions = options.regions ?? new Map();
  }

  /**
   * How long the sequence a `frame` selects plays, as far as its repeat count goes. A `frame` out of range selects the
   * first, as the renderer does.
   * @param frame What an entity's `frame` is, or the index of a sequence.
   * @returns Seconds, `Infinity` for a sequence that repeats forever, 0 for a single picture (it has nothing to play).
   */
  sequenceDuration(frame: number): number {
    const entry = this.frames[frame >= 0 && frame < this.frames.length ? frame : 0];

    return entry !== undefined && 'images' in entry ? SpriteAnimator.duration(entry) : 0;
  }

  /**
   * Finds a named sequence (a sequence of the sidecar, a tag of an Aseprite file).
   * @param name The name of the sequence.
   * @returns The `frame` that selects it, -1 when there is none of that name.
   */
  sequenceIndex(name: string): number {
    return name === '' ? -1 : this.frames.findIndex((entry) => 'images' in entry && entry.name === name);
  }

  /**
   * Releases the texture.
   */
  free(): void {
    this.texture?.free();
  }
}
