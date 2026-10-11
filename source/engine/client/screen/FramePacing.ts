import Con from '../../common/Console.ts';
import Host from '../../common/Host.ts';

/** How many frames the frame rate is averaged over. */
const WINDOW = 30;

/** The refresh rates are looked for in steps of this many frames per second. */
const STEP = 15;

/** A measurement may be this much above a step before it counts as the next one (63 for 60). */
const TOLERANCE = 1.05;

/**
 * Measures how fast frames are drawn and, when the host does not know the refresh rate of the display, finds it
 * out from the frame rate the browser delivers.
 */
export default class FramePacing {
  /** Frames per second, averaged over the last 30. */
  static FPS = 0;

  static #times: Array<number | null> = new Array<number | null>(WINDOW).fill(null);
  static #index = 0;
  static #lastAnimationTime = 0;

  /** The refresh rate the last frames pointed at, and for how many frames in a row. */
  static #candidate = 0;
  static #stableFrames = 0;

  /**
   * Forgets the frames measured so far.
   */
  static Reset(): void {
    FramePacing.#times.fill(null);
    FramePacing.#index = 0;
    FramePacing.#lastAnimationTime = 0;
    FramePacing.#candidate = 0;
    FramePacing.#stableFrames = 0;
    FramePacing.FPS = 0;
  }

  /**
   * Takes the time of a frame that was drawn, updates the frame rate and, while the host has no refresh rate yet,
   * the refresh rate.
   * @param animationTime The time the browser gave the frame, in milliseconds.
   */
  static Record(animationTime: number): void {
    if (FramePacing.#lastAnimationTime > 0) {
      FramePacing.#times[FramePacing.#index] = animationTime - FramePacing.#lastAnimationTime;
      FramePacing.#index = (FramePacing.#index + 1) % FramePacing.#times.length;

      const samples = FramePacing.#times.filter((time): time is number => time !== null);
      FramePacing.FPS = 1000 / (samples.reduce((sum, time) => sum + time, 0) / samples.length);

      FramePacing.#detectRefreshRate();
    }

    FramePacing.#lastAnimationTime = animationTime;
  }

  /**
   * Picks the refresh rate the frame rate points at: the next step of 15 up that it is not clearly above. Takes it
   * once ten windows of frames have been drawn and the pick has not changed for a whole window.
   */
  static #detectRefreshRate(): void {
    if (Host.refreshrate!.value !== 0 || Host.framecount <= WINDOW * 10) {
      return;
    }

    const candidate = Math.ceil(FramePacing.FPS / (STEP * TOLERANCE)) * STEP;

    if (candidate === FramePacing.#candidate) {
      FramePacing.#stableFrames++;
    } else {
      FramePacing.#candidate = candidate;
      FramePacing.#stableFrames = 1;
    }

    if (FramePacing.#stableFrames < WINDOW || candidate <= 0) {
      return;
    }

    Con.DPrint(`Determined refresh rate: ${Math.round(FramePacing.FPS)} FPS\n`);
    Con.DPrint(`Setting Host refreshrate to ${candidate}\n`);
    Host.refreshrate!.set(candidate);
  }
}
