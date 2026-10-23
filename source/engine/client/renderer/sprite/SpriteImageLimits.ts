import type { ConsoleOutput } from '../../../common/Services.ts';
import { SpritePixels } from '../../../common/model/sprite/SpritePixels.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';

/** What the video hardware and the player's settings allow one sprite. */
export interface SpriteImageLimitValues {
  /** Largest texture side. */
  readonly maxTextureSize: number;
  /** Most layers of an array texture. */
  readonly maxLayers: number;
  /** Bytes one sprite may take on the GPU, mip levels included. */
  readonly maxBytes: number;
}

/**
 * Keeps the frames of one sprite within the limits of the texture hardware and the memory budget: frames over
 * the layer limit are dropped, and the images are halved in size until they fit.
 */
export class SpriteImageLimits {
  /** A mip chain adds a third on top of the base level. */
  static readonly MIP_FACTOR = 4 / 3;

  /**
   * @returns Bytes a sprite of that size takes on the GPU, mip levels included.
   */
  static textureBytes(width: number, height: number, layers: number): number {
    return Math.ceil(width * height * 4 * layers * SpriteImageLimits.MIP_FACTOR);
  }

  /**
   * @param decoded The decoded frames.
   * @param limits What is allowed.
   * @param con Where to say what was cut.
   * @param name File name, for the messages.
   * @returns `decoded` when it fits, otherwise a copy with fewer frames and/or a smaller size.
   */
  static fit(decoded: DecodedSpriteImages, limits: SpriteImageLimitValues, con: ConsoleOutput, name: string): DecodedSpriteImages {
    let { width, height } = decoded;
    let frames = decoded.frames;

    if (frames.length > limits.maxLayers) {
      con.PrintWarning(`${name}: ${frames.length} frames, the video hardware takes ${limits.maxLayers}, the rest is dropped\n`);
      frames = frames.slice(0, limits.maxLayers);
    }

    const originalWidth = width;
    const originalHeight = height;

    while (width > limits.maxTextureSize || height > limits.maxTextureSize
      || (SpriteImageLimits.textureBytes(width, height, frames.length) > limits.maxBytes && (width > 1 || height > 1))) {
      const shrunk = frames.map((frame) => SpritePixels.halve(frame, width, height));

      frames = shrunk.map((entry) => entry.rgba);
      width = shrunk[0].width;
      height = shrunk[0].height;
    }

    if (width !== originalWidth || height !== originalHeight) {
      con.PrintWarning(`${name}: ${originalWidth}x${originalHeight} with ${frames.length} frames is too large (limit ${Number((limits.maxBytes / 1048576).toFixed(2))} MB, r_sprite_memory), reduced to ${width}x${height}\n`);
    }

    if (frames === decoded.frames && width === decoded.width && height === decoded.height) {
      return decoded;
    }

    return { width, height, frames };
  }
}
