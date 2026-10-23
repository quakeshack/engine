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
}
