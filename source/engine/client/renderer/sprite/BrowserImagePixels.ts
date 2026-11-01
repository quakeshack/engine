/** A decoded picture with straight (not premultiplied) alpha. */
export interface StillImagePixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

/**
 * The browser APIs the sprite decoders share: decoding a still image and reading pixels back from something
 * drawable. Everything else in the decoders is plain code that runs in Node as well.
 */
export class BrowserImagePixels {
  /**
   * Decodes a still image (the first frame of an animation) with the browser's own decoder.
   * @param bytes The file.
   * @param mimeType Its media type.
   * @returns The pixels.
   */
  static async decodeStill(bytes: Uint8Array, mimeType: string): Promise<StillImagePixels> {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mimeType }), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });

    try {
      return { width: bitmap.width, height: bitmap.height, rgba: BrowserImagePixels.readPixels(bitmap, bitmap.width, bitmap.height) };
    } finally {
      bitmap.close();
    }
  }

  /**
   * Draws something onto a canvas of the given size and reads it back.
   * @param source An image, a bitmap or a video frame.
   * @returns Straight RGBA pixels.
   */
  static readPixels(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

    if (typeof OffscreenCanvas !== 'undefined') {
      context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    } else {
      const canvas = document.createElement('canvas');

      canvas.width = width;
      canvas.height = height;
      context = canvas.getContext('2d', { willReadFrequently: true });
    }

    if (context === null) {
      throw new Error('no 2D canvas to read pixels with');
    }

    context.drawImage(source, 0, 0);

    return context.getImageData(0, 0, width, height).data;
  }
}
