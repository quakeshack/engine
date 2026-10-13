import RenderTarget, { type RenderTargetDescriptor } from './RenderTarget.ts';

/**
 * Two targets of one shape that swap roles: what a pass wrote this frame is what the next frame's pass reads. This
 * is how a result that depends on its own past (the bloom adaptation, later a temporal filter) is kept.
 */
export default class RenderTargetPair {
  readonly #targets: [RenderTarget, RenderTarget];
  #readIndex = 0;

  /**
   * Creates both targets from one descriptor; their names get `-0` and `-1` appended.
   * @param descriptor What each of the two is made of.
   */
  constructor(descriptor: RenderTargetDescriptor) {
    this.#targets = [
      new RenderTarget({ ...descriptor, name: `${descriptor.name}-0`, persistent: true }),
      new RenderTarget({ ...descriptor, name: `${descriptor.name}-1`, persistent: true }),
    ];
  }

  /**
   * The target that holds the result of the previous frame.
   * @returns The target to read.
   */
  get read(): RenderTarget {
    return this.#targets[this.#readIndex];
  }

  /**
   * The target this frame writes.
   * @returns The target to write.
   */
  get write(): RenderTarget {
    return this.#targets[1 - this.#readIndex];
  }

  /** Makes what was written the thing to read; call it once the write is complete. */
  swap(): void {
    this.#readIndex = 1 - this.#readIndex;
  }

  /** Puts the roles back to what they were after creation, for a history that starts over. */
  reset(): void {
    this.#readIndex = 0;
  }

  /**
   * Resizes both targets.
   * @param width Width in pixels.
   * @param height Height in pixels.
   * @param samples Sample count of renderbuffers, 0 for single-sampled.
   */
  resize(width: number, height: number, samples = 0): void {
    this.#targets[0].resize(width, height, samples);
    this.#targets[1].resize(width, height, samples);
  }

  /** Frees both targets. */
  free(): void {
    this.#targets[0].free();
    this.#targets[1].free();
  }
}
