import { SpriteAnimator, type SpriteSample } from '../../../common/model/sprite/SpriteAnimator.ts';
import type { SpriteAsset } from '../../../common/model/sprite/SpriteAsset.ts';

/** Which clock a {@link SpritePlayback} follows. */
export type SpriteClock = 'client' | 'real';

/**
 * One element of the screen that plays a sprite: a HUD icon, a flame in a corner, a full-screen effect. It holds
 * which sequence of the shared {@link SpriteAsset} is showing and how far it has come, so two elements made from one
 * file play independently. A game gets one from `ClientEngineAPI.LoadSprite()` and draws it with `DrawSprite()`; it
 * does not construct them.
 *
 * A new playback shows the sequence 0 from the start. Its clock is the client's time by default, the clock the
 * world's sprites follow (`clientRuntimeState.time`), or real time (`Host.realtime`) for what must not depend on the
 * game's clock. Both advance at the same speed today, and neither stops while the game is paused. A clock that goes
 * backwards (a client time that is reset) restarts the sequence instead of freezing it.
 */
export class SpritePlayback {
  /** The shared images, timing and texture. Read by the engine's drawing; a game has no use for it. */
  readonly asset: SpriteAsset;

  readonly #now: () => number;
  #sequence = 0;
  /** Seconds of animation that had passed when the clock read {@link SpritePlayback.#anchor}. */
  #elapsed = 0;
  #anchor: number;
  #paused = false;
  #speed = 1;

  /**
   * @param asset What to play.
   * @param now Reads the clock the playback follows, in seconds.
   */
  constructor(asset: SpriteAsset, now: () => number) {
    this.asset = asset;
    this.#now = now;
    this.#anchor = now();
  }

  /**
   * @returns The index of the sequence that is showing, which is also what an entity's `frame` would select.
   */
  get sequence(): number {
    return this.#sequence;
  }

  /**
   * @returns How fast time passes for this playback, 1 is the speed of the file.
   */
  get speed(): number {
    return this.#speed;
  }

  /**
   * Changes the speed from now on; what has played so far stays played.
   * @param value Above 0; 2 plays twice as fast, 0.5 half as fast. Use {@link SpritePlayback.pause} to stop.
   */
  set speed(value: number) {
    if (!(value > 0) || !Number.isFinite(value)) {
      throw new RangeError(`SpritePlayback.speed has to be a number above 0, got ${value}`);
    }

    this.#elapsed = this.#animationTime();
    this.#anchor = this.#now();
    this.#speed = value;
  }

  /**
   * @returns Whether the playback is held where it is.
   */
  get paused(): boolean {
    return this.#paused;
  }

  /**
   * @returns Seconds of the clock the sequence takes to play as far as its repeat count goes (the speed counts),
   * `Infinity` for a sequence that repeats forever, 0 for a single picture.
   */
  get duration(): number {
    return this.asset.sequenceDuration(this.#sequence) / this.#speed;
  }

  /**
   * @returns Whether the sequence has played as often as it repeats and holds its last image. A single picture has
   * nothing to play and counts as finished; a sequence that repeats forever never is.
   */
  get finished(): boolean {
    return this.#animationTime() >= this.asset.sequenceDuration(this.#sequence);
  }

  /**
   * @returns Width of the image that is showing, in screen units at scale 1 (the file's pixels times the sidecar's
   * `scale`), for placing it.
   */
  get width(): number {
    return this.#currentImage().width;
  }

  /**
   * @returns Height of the image that is showing, see {@link SpritePlayback.width}.
   */
  get height(): number {
    return this.#currentImage().height;
  }

  /**
   * Starts a sequence from its first image, also when it is the one that is showing. A paused playback stays paused,
   * on that first image.
   * @param sequence The index of the sequence, or its name (a sidecar sequence or an Aseprite tag).
   * @throws RangeError when the file has no such sequence.
   */
  play(sequence: number | string): void {
    const index = typeof sequence === 'string' ? this.asset.sequenceIndex(sequence) : sequence;

    if (!Number.isInteger(index) || index < 0 || index >= this.asset.frames.length) {
      throw new RangeError(`SpritePlayback.play: no sequence ${JSON.stringify(sequence)} (the file has ${this.asset.frames.length})`);
    }

    this.#sequence = index;
    this.#elapsed = 0;
    this.#anchor = this.#now();
  }

  /**
   * Holds the playback on the image it shows.
   */
  pause(): void {
    if (this.#paused) {
      return;
    }

    this.#elapsed = this.#animationTime();
    this.#paused = true;
  }

  /**
   * Continues a paused playback where it stopped.
   */
  resume(): void {
    if (!this.#paused) {
      return;
    }

    this.#paused = false;
    this.#anchor = this.#now();
  }

  /**
   * Works out what to draw now.
   * @param interpolate Whether to also work out the image to fade into.
   * @param out Filled in.
   */
  sample(interpolate: boolean, out: SpriteSample): void {
    SpriteAnimator.sample(this.asset.frames[this.#sequence], this.#animationTime(), interpolate, out);
  }

  /**
   * @returns Seconds of animation since the sequence started, with the pause and the speed counted in.
   */
  #animationTime(): number {
    if (this.#paused) {
      return this.#elapsed;
    }

    const now = this.#now();

    if (now < this.#anchor) {
      // the clock started over (a new connection): so does the sequence
      this.#elapsed = 0;
      this.#anchor = now;
    }

    return this.#elapsed + (now - this.#anchor) * this.#speed;
  }

  #currentImage(): { width: number, height: number } {
    const frame = this.asset.frames[this.#sequence];

    return 'images' in frame ? frame.images[0] : frame;
  }
}
