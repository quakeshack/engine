/**
 * The light on a lit sprite. A sprite is flat and turns towards the viewer, so there is no surface direction to light:
 * it takes the light of the map at its origin plus the dynamic lights that reach it, like the brightness of an alias
 * model without its shading.
 */
export class SpriteLighting {
  /**
   * @param ambient Baked light at the sprite's origin, 1 is the light level a texture is shown unchanged at (128).
   * @param dynamic Dynamic lights that reach the sprite, on the same scale.
   * @param out Receives red, green and blue.
   * @returns `out`, each channel from 0 to 1: a lit sprite is never brighter than its texture.
   */
  static combine(ambient: ArrayLike<number>, dynamic: ArrayLike<number>, out: [number, number, number]): [number, number, number] {
    for (let channel = 0; channel < 3; channel++) {
      out[channel] = Math.min(1, Math.max(0, ambient[channel] + dynamic[channel]));
    }

    return out;
  }
}
