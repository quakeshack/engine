import Q from '../../shared/Q.ts';

/**
 * The arguments of `color <top> [bottom]`, shared by the local console and the server.
 */
export default class PlayerColors {
  /**
   * Parses the arguments of `color <top> [bottom]` into two palette rows.
   * @returns The top (shirt) and bottom (pants) colors, each in 0 to 13.
   */
  static parse(argv: string[]): { top: number; bottom: number } {
    const top = (Q.atoi(argv[0]) & 15) >>> 0;
    const bottom = argv.length === 1 ? top : (Q.atoi(argv[1]) & 15) >>> 0;

    return { top: Math.min(top, 13), bottom: Math.min(bottom, 13) };
  }

  /**
   * Packs the two palette rows into the `colors` byte that goes over the wire.
   * @returns Top in the high nibble, bottom in the low nibble.
   */
  static pack(top: number, bottom: number): number {
    return (top << 4) + bottom;
  }
}
