import { CorruptedResourceError } from '../../Errors.ts';
import { AsepriteHeader } from './AsepriteHeader.ts';
import { GifHeader } from './GifHeader.ts';
import { PngHeader } from './PngHeader.ts';
import type { SpriteDirection } from './SpriteTypes.ts';
import { WebpHeader } from './WebpHeader.ts';

/** A named range of images a file marks as one animation (an Aseprite tag). */
export interface SpriteTag {
  readonly name: string;
  /** Index of the first image. */
  readonly from: number;
  /** Index of the last image, included. */
  readonly to: number;
  readonly direction: SpriteDirection;
  /** Plays, 0 for forever. */
  readonly repeat: number;
}

/**
 * What a header pass finds out about an image file without touching its pixels: enough to build a
 * sprite model's bounds and timing, which is all a realm that never draws needs.
 */
export interface ImageHeader {
  readonly width: number;
  readonly height: number;
  /** Milliseconds each image is shown, as the file stores them (a browser's 10 ms clamp is not applied). */
  readonly frameDurations: readonly number[];
  /** How often the file plays through, 0 for forever. */
  readonly repeat: number;
  readonly tags: readonly SpriteTag[];
  /**
   * The pixel each image has its origin at, counted from the top left corner (an Aseprite slice's pivot), one entry
   * per image, `null` when the file does not say.
   */
  readonly origins: ReadonlyArray<readonly [number, number]> | null;
}

/** The image formats that have a header parser. */
export enum ImageFormat {
  gif = 'gif',
  png = 'png',
  webp = 'webp',
  aseprite = 'aseprite',
}

const HEADER_PARSERS: Record<ImageFormat, (buffer: ArrayBuffer, name: string) => ImageHeader> = {
  [ImageFormat.gif]: (buffer, name) => GifHeader.parse(buffer, name),
  [ImageFormat.png]: (buffer, name) => PngHeader.parse(buffer, name),
  [ImageFormat.webp]: (buffer, name) => WebpHeader.parse(buffer, name),
  [ImageFormat.aseprite]: (buffer, name) => AsepriteHeader.parse(buffer, name),
};

/**
 * Finds the format of an image file and runs its header parser.
 */
export class ImageHeaders {
  /**
   * @returns The format whose signature the file starts with, `null` when it is none of them.
   */
  static detect(buffer: ArrayBuffer): ImageFormat | null {
    if (GifHeader.matches(buffer)) {
      return ImageFormat.gif;
    }

    if (PngHeader.matches(buffer)) {
      return ImageFormat.png;
    }

    if (WebpHeader.matches(buffer)) {
      return ImageFormat.webp;
    }

    if (AsepriteHeader.matches(buffer)) {
      return ImageFormat.aseprite;
    }

    return null;
  }

  /**
   * Reads the size, timing and repeat count of an image file.
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns The header.
   * @throws CorruptedResourceError when the file is not an image of a known format, or is cut short.
   */
  static parse(buffer: ArrayBuffer, name: string): ImageHeader {
    const format = ImageHeaders.detect(buffer);

    if (format === null) {
      throw new CorruptedResourceError(name, `${name} is not a GIF, PNG, WebP or Aseprite image`);
    }

    try {
      return HEADER_PARSERS[format](buffer, name);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new CorruptedResourceError(name, `${name} is cut short`);
      }

      throw error;
    }
  }

  /**
   * Browsers play images that claim 10 ms or less (no delay at all, or a delay of one hundredth of a second
   * as GIF can say) at 100 ms, so a file times the same here as in a browser tab.
   * @param milliseconds A duration as the file stores it.
   * @returns Seconds the image is shown.
   */
  static frameSeconds(milliseconds: number): number {
    return (milliseconds <= 10 ? 100 : milliseconds) / 1000;
  }
}
