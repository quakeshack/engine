/**
 * Pixel helpers for building the layers of a sprite's array texture.
 */
export class SpritePixels {
  /**
   * Places an image in the top left corner of a larger, transparent layer. Sprite images may differ
   * in size, an array texture's layers may not.
   * @param rgba the image, `width * height * 4` bytes
   * @returns the layer, `rgba` itself when it already has the layer's size
   */
  static padToLayer(rgba: Uint8Array, width: number, height: number, layerWidth: number, layerHeight: number): Uint8Array {
    console.assert(width <= layerWidth && height <= layerHeight, 'image must fit its layer');

    if (width === layerWidth && height === layerHeight) {
      return rgba;
    }

    const layer = new Uint8Array(layerWidth * layerHeight * 4);

    for (let row = 0; row < height; row++) {
      layer.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * layerWidth * 4);
    }

    return layer;
  }

  /**
   * Multiplies the color of every pixel by its alpha, in place. Sprite textures hold premultiplied alpha.
   * @param rgba straight RGBA pixels
   * @returns the same array
   */
  static premultiply<T extends Uint8Array | Uint8ClampedArray>(rgba: T): T {
    for (let index = 0; index < rgba.length; index += 4) {
      const alpha = rgba[index + 3];

      if (alpha === 255) {
        continue;
      }

      rgba[index] = Math.round(rgba[index] * alpha / 255);
      rgba[index + 1] = Math.round(rgba[index + 1] * alpha / 255);
      rgba[index + 2] = Math.round(rgba[index + 2] * alpha / 255);
    }

    return rgba;
  }

  /**
   * Halves the size of an image by averaging blocks of 2x2 pixels (fewer at an odd edge).
   * @param rgba premultiplied RGBA pixels
   * @returns the smaller image
   */
  static halve(rgba: Uint8Array, width: number, height: number): { rgba: Uint8Array, width: number, height: number } {
    const halfWidth = Math.max(1, (width + 1) >> 1);
    const halfHeight = Math.max(1, (height + 1) >> 1);
    const result = new Uint8Array(halfWidth * halfHeight * 4);

    for (let row = 0; row < halfHeight; row++) {
      for (let column = 0; column < halfWidth; column++) {
        const sum = [0, 0, 0, 0];
        let count = 0;

        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const x = column * 2 + dx;
            const y = row * 2 + dy;

            if (x >= width || y >= height) {
              continue;
            }

            const source = (y * width + x) * 4;

            sum[0] += rgba[source];
            sum[1] += rgba[source + 1];
            sum[2] += rgba[source + 2];
            sum[3] += rgba[source + 3];
            count++;
          }
        }

        const target = (row * halfWidth + column) * 4;

        for (let channel = 0; channel < 4; channel++) {
          result[target + channel] = Math.round(sum[channel] / count);
        }
      }
    }

    return { rgba: result, width: halfWidth, height: halfHeight };
  }
}
