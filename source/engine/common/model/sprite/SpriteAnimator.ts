import { SpriteDirection, type SpriteFrame, type SpriteImage, type SpriteSequence } from './SpriteTypes.ts';

/** What `SpriteAnimator.blendAt()` fills in. */
export interface SpriteImageBlend {
  index: number;
  nextIndex: number;
  mix: number;
}

/**
 * What {@link SpriteAnimator.sample} fills in: the image to draw and the one it fades into.
 */
export class SpriteSample {
  /** The image showing. */
  image: SpriteImage = null!;
  /** Layer of the image it fades into (its own layer when there is no fading). */
  nextLayer = 0;
  /** How far to fade into {@link SpriteSample.nextLayer}, 0 shows only {@link SpriteSample.image}. */
  fade = 0;
}

/** Where in an image a time falls. */
interface ImageLocation {
  index: number;
  remaining: number;
  duration: number;
}

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
    SpriteAnimator.#locate(sequence, time, SpriteAnimator.#scratch);

    return SpriteAnimator.#scratch.index;
  }

  /**
   * Works out the image showing at `time` and the one that follows it, with how far the first has run, for
   * sprites that crossfade between their images.
   * @param time Seconds since the sequence started.
   * @param out Filled in: `index` is the image showing, `nextIndex` the one after it (the same while a finished
   * sequence holds), `mix` is 0 when the image has just appeared and approaches 1 when the next one takes over.
   */
  static blendAt(sequence: SpriteSequence, time: number, out: SpriteImageBlend): void {
    const location = SpriteAnimator.#scratch;

    SpriteAnimator.#locate(sequence, time, location);

    // asking for the next image reuses the scratch object, so keep what this one said
    const { index, remaining, duration } = location;

    out.index = index;

    if (!Number.isFinite(remaining)) {
      out.nextIndex = index;
      out.mix = 0;
      return;
    }

    out.nextIndex = SpriteAnimator.imageIndexAt(sequence, Math.max(time, 0) + remaining + SpriteAnimator.#EPSILON);
    out.mix = Math.min(1, Math.max(0, 1 - remaining / duration));
  }

  /**
   * Picks what to draw of a frame at a time: a single picture as it is, a sequence by its clock.
   * @param frame What an entity's `frame` or a playback's sequence selects.
   * @param time Seconds since the sequence started (ignored by a single picture).
   * @param interpolate Whether to work out the image to fade into, for sprites that crossfade.
   * @param out Filled in.
   */
  static sample(frame: SpriteFrame, time: number, interpolate: boolean, out: SpriteSample): void {
    if (!('images' in frame)) {
      out.image = frame;
      out.nextLayer = frame.layer;
      out.fade = 0;
      return;
    }

    if (interpolate) {
      const blend = SpriteAnimator.#blend;

      SpriteAnimator.blendAt(frame, time, blend);
      out.image = frame.images[blend.index];
      out.nextLayer = frame.images[blend.nextIndex].layer;
      out.fade = blend.mix;
      return;
    }

    out.image = frame.images[SpriteAnimator.imageIndexAt(frame, time)];
    out.nextLayer = out.image.layer;
    out.fade = 0;
  }

  static readonly #blend: SpriteImageBlend = { index: 0, nextIndex: 0, mix: 0 };

  /** Nudges a time over the end of an image, past rounding. */
  static readonly #EPSILON = 1e-4;

  static readonly #scratch: ImageLocation = { index: 0, remaining: Infinity, duration: Infinity };

  /**
   * Finds the image at a time, and how long it still has to run.
   */
  static #locate(sequence: SpriteSequence, time: number, out: ImageLocation): void {
    const count = sequence.images.length;
    const reversed = sequence.direction === SpriteDirection.reverse || sequence.direction === SpriteDirection.pingpongReverse;
    const pingpong = sequence.direction === SpriteDirection.pingpong || sequence.direction === SpriteDirection.pingpongReverse;
    const cycle = SpriteAnimator.cycleDuration(sequence);

    out.remaining = Infinity;
    out.duration = Infinity;

    if (count === 1) {
      out.index = 0;
      return;
    }

    if (!(cycle > 0)) {
      out.index = SpriteAnimator.#imageOfRank(count, 0, reversed);
      return;
    }

    const clamped = Math.max(time, 0);

    if (sequence.repeat > 0 && clamped >= cycle * sequence.repeat) {
      out.index = SpriteAnimator.#imageOfRank(count, pingpong ? 0 : count - 1, reversed);
      return;
    }

    const cycleTime = clamped - Math.floor(clamped / cycle) * cycle;
    const total = sequence.endTimes[count - 1];
    let rank: number;

    if (!pingpong || cycleTime < total) {
      rank = SpriteAnimator.#rankAt(sequence, cycleTime, reversed);
      out.remaining = SpriteAnimator.#cumulative(sequence, rank, reversed) - cycleTime;
    } else {
      // the way back runs over ranks count - 2 down to 1, mirrored onto the forward time line
      const backTime = SpriteAnimator.#cumulative(sequence, count - 2, reversed) - (cycleTime - total);

      rank = SpriteAnimator.#rankAtEnd(sequence, backTime, reversed);
      out.remaining = backTime - (rank > 0 ? SpriteAnimator.#cumulative(sequence, rank - 1, reversed) : 0);
    }

    out.duration = SpriteAnimator.#rankDuration(sequence, rank);
    out.index = SpriteAnimator.#imageOfRank(count, rank, reversed);
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
