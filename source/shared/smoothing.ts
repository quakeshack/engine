/**
 * Frame-rate independent exponential smoothing: moves `current` toward `target` by the share of the way that
 * `deltaTime` seconds at `sharpness` cover. A non-positive sharpness or delta leaves the value where it is.
 * @param current The value so far.
 * @param target The value to ease toward.
 * @param sharpness How fast it eases, in 1/s; the remaining distance falls by a factor of `e` per `1 / sharpness`.
 * @param deltaTime The time step in seconds.
 * @returns The new value.
 */
export function smoothValue(current: number, target: number, sharpness: number, deltaTime: number): number {
  const smoothing = 1.0 - Math.exp(-Math.max(0.0, sharpness) * Math.max(0.0, deltaTime));

  return current + (target - current) * smoothing;
}

/**
 * The shortest way from one angle to another, so that a turn through 360 degrees is not a jump.
 * @param from The previous angle in degrees.
 * @param to The current angle in degrees.
 * @returns The wrapped delta, in the range [-180, 180).
 */
export function shortestAngleDelta(from: number, to: number): number {
  return ((to - from + 540.0) % 360.0) - 180.0;
}
