import { SpriteDirection, type SpriteSequence } from './SpriteTypes.ts';

/**
 * Works out which image of a {@link SpriteSequence} is showing at a given time. Pure, so the server
 * (how long does this effect last?) and the renderer (what do I draw?) agree.
 *
 * One *cycle* of a sequence is a pass through its images: `forward` and `reverse` show every image
 * once, `pingpong` and `pingpongReverse` go to the far end and back without showing either end image
 * twice in a row. `repeat` counts cycles. A finished sequence holds the image a cycle starts with for
 * the ping-pong directions (the animation came back to where it began), and the last image of its
 * pass for `forward` and `reverse`.
 */
export class SpriteAnimator {
  /**
   * @returns Seconds a single pass over the images takes, the cycle of a looping sequence.
   */
  static cycleDuration(sequence: SpriteSequence): number {
    const { endTimes } = sequence;
    const count = endTimes.length;
    const total = endTimes[count - 1];

    switch (sequence.direction) {
      case SpriteDirection.pingpong:
      case SpriteDirection.pingpongReverse:
        if (count < 2) {
          return total;
        }
        return total * 2 - SpriteAnimator.#rankDuration(sequence, 0) - SpriteAnimator.#rankDuration(sequence, count - 1);
      default:
        return total;
    }
  }

  /**
   * @returns Seconds until the sequence stops animating, `Infinity` when it repeats forever.
   */
  static duration(sequence: SpriteSequence): number {
    if (sequence.repeat <= 0) {
      return Infinity;
    }

    return SpriteAnimator.cycleDuration(sequence) * sequence.repeat;
  }

  /**
   * @param time Seconds since the sequence started.
   * @returns Index into `sequence.images` showing at `time`.
   */
  static imageIndexAt(sequence: SpriteSequence, time: number): number {
    const count = sequence.images.length;
    const reversed = sequence.direction === SpriteDirection.reverse || sequence.direction === SpriteDirection.pingpongReverse;
    const pingpong = sequence.direction === SpriteDirection.pingpong || sequence.direction === SpriteDirection.pingpongReverse;

    if (count === 1) {
      return 0;
    }

    const cycle = SpriteAnimator.cycleDuration(sequence);

    if (!(cycle > 0) || time <= 0) {
      return SpriteAnimator.#imageOfRank(count, 0, reversed);
    }

    if (sequence.repeat > 0 && time >= cycle * sequence.repeat) {
      return SpriteAnimator.#imageOfRank(count, pingpong ? 0 : count - 1, reversed);
    }

    const cycleTime = time - Math.floor(time / cycle) * cycle;
    const total = sequence.endTimes[count - 1];

    if (!pingpong || cycleTime < total) {
      return SpriteAnimator.#imageOfRank(count, SpriteAnimator.#rankAt(sequence, cycleTime, reversed), reversed);
    }

    // the way back runs over ranks count - 2 down to 1, mirrored onto the forward time line
    const backTime = SpriteAnimator.#cumulative(sequence, count - 2, reversed) - (cycleTime - total);

    return SpriteAnimator.#imageOfRank(count, SpriteAnimator.#rankAtEnd(sequence, backTime, reversed), reversed);
  }

  /**
   * A rank is a position in play order; for a reversed direction rank 0 is the last image.
   * @returns The image index at a rank.
   */
  static #imageOfRank(count: number, rank: number, reversed: boolean): number {
    return reversed ? count - 1 - rank : rank;
  }

  /**
   * @returns Seconds the image at a rank is shown.
   */
  static #rankDuration(sequence: SpriteSequence, rank: number): number {
    const { endTimes } = sequence;
    const count = endTimes.length;
    const reversed = sequence.direction === SpriteDirection.reverse || sequence.direction === SpriteDirection.pingpongReverse;
    const index = reversed ? count - 1 - rank : rank;

    return endTimes[index] - (index > 0 ? endTimes[index - 1] : 0);
  }

  /**
   * @returns Seconds from the start of a pass to the end of the image at a rank.
   */
  static #cumulative(sequence: SpriteSequence, rank: number, reversed: boolean): number {
    const { endTimes } = sequence;
    const count = endTimes.length;

    if (!reversed) {
      return endTimes[rank];
    }

    // reversed ranks walk the images backwards: what is left after image count - 1 - rank
    const index = count - 1 - rank;
    return endTimes[count - 1] - (index > 0 ? endTimes[index - 1] : 0);
  }

  /**
   * @returns The rank showing at `time` (the first whose end lies after it).
   */
  static #rankAt(sequence: SpriteSequence, time: number, reversed: boolean): number {
    const last = sequence.endTimes.length - 1;

    for (let rank = 0; rank < last; rank++) {
      if (SpriteAnimator.#cumulative(sequence, rank, reversed) > time) {
        return rank;
      }
    }

    return last;
  }

  /**
   * @returns The first rank whose end is at or after `time`, for a time line that runs backwards.
   */
  static #rankAtEnd(sequence: SpriteSequence, time: number, reversed: boolean): number {
    const last = sequence.endTimes.length - 1;

    for (let rank = 0; rank < last; rank++) {
      if (SpriteAnimator.#cumulative(sequence, rank, reversed) >= time) {
        return rank;
      }
    }

    return last;
  }
}
