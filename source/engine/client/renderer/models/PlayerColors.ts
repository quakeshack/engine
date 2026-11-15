import W from '../../../common/W.ts';

/**
 * The colors of a player's shirt and pants, from the `colors` byte of the scoreboard: the shirt is the high nibble,
 * the pants the low one, each a row of the Quake palette (a row of 16 shades from dark to light, the shirt and pants
 * rows of the skin follow that ramp).
 */
export class PlayerColors {
  private constructor() {
    // Static-only helper class.
  }

  /**
   * The color a player's shirt is tinted with.
   * @param colors The `colors` byte of the player's scoreboard entry.
   * @param out Receives red, green and blue in 0 to 255.
   */
  static shirtInto(colors: number, out: Float32Array | number[]): void {
    PlayerColors.#rowColorInto((colors >> 4) & 0xf, out);
  }

  /**
   * The color a player's pants are tinted with.
   * @param colors The `colors` byte of the player's scoreboard entry.
   * @param out Receives red, green and blue in 0 to 255.
   */
  static pantsInto(colors: number, out: Float32Array | number[]): void {
    PlayerColors.#rowColorInto(colors & 0xf, out);
  }

  /**
   * Picks the shade of a palette row that the engine has always used for team colors: column 11 in the dark half of
   * the palette (rows 0 to 7) and column 4 in the light half, where the ramps run the other way round.
   * @param row Palette row, 0 to 15.
   * @param out Receives red, green and blue in 0 to 255.
   */
  static #rowColorInto(row: number, out: Float32Array | number[]): void {
    let index = (row << 4) + 4;

    if (index <= 127) {
      index += 7;
    }

    const rgb = W.d_8to24table[index];
    out[0] = rgb & 0xff;
    out[1] = (rgb >> 8) & 0xff;
    out[2] = (rgb >> 16) & 0xff;
  }
}
