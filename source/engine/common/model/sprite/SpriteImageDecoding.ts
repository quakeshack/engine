import type { ImageFormat, ImageHeader } from './ImageHeader.ts';

/** The pixels of an image file, every frame already composited onto the full canvas. */
export interface DecodedSpriteImages {
  /** Width of every frame, in pixels. May be smaller than the file's when the decoder had to shrink it. */
  readonly width: number;
  /** Height of every frame, in pixels. */
  readonly height: number;
  /** One entry per frame, `width * height * 4` bytes of RGBA with the color premultiplied by the alpha. */
  readonly frames: readonly Uint8Array[];
}

/**
 * Turns an image file into the pixels of its frames. Only a realm that draws has one: it needs the browser's
 * image decoding, so it is handed to the model loaders instead of being imported by them.
 */
export interface SpriteImageDecoding {
  /**
   * @param buffer The file.
   * @param format The format the header pass found.
   * @param header What the header pass found.
   * @param name File name, for messages.
   * @returns The frames. There may be fewer than the header says (a browser that only shows a still image), and
   * the size may be smaller than the file's (a memory limit).
   */
  decode(buffer: ArrayBuffer, format: ImageFormat, header: ImageHeader, name: string): Promise<DecodedSpriteImages>;
}
