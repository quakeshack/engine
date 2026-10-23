import type { GLTextureArray } from '../../../client/GL.ts';
import { SpriteBlend, type SpriteFrame } from './SpriteTypes.ts';

/** What a {@link SpriteAsset} is made of. */
export interface SpriteAssetOptions {
  readonly frames: readonly SpriteFrame[];
  readonly blend?: SpriteBlend;
  /** Width of every layer of the texture, the largest image. */
  readonly layerWidth?: number;
  /** Height of every layer of the texture, the largest image. */
  readonly layerHeight?: number;
  /** The images as an array texture, `null` in a realm that does not draw. */
  readonly texture?: GLTextureArray | null;
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

  /** Width of every layer of {@link SpriteAsset.texture}. */
  readonly layerWidth: number;

  /** Height of every layer of {@link SpriteAsset.texture}. */
  readonly layerHeight: number;

  /** One layer per image, premultiplied alpha. `null` where nothing is drawn (the server). */
  readonly texture: GLTextureArray | null;

  constructor(options: SpriteAssetOptions) {
    this.frames = options.frames;
    this.blend = options.blend ?? SpriteBlend.alphaTest;
    this.layerWidth = options.layerWidth ?? 0;
    this.layerHeight = options.layerHeight ?? 0;
    this.texture = options.texture ?? null;
  }

  /**
   * Releases the texture.
   */
  free(): void {
    this.texture?.free();
  }
}
