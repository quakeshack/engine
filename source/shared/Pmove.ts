/**
 * Pmove constant defaults.
 *
 * These will give player movement that feels more like Q1 (from QuakeWorld).
 */
export class PmoveConfiguration {
  /** distance to probe forward for water jump wall detection */
  forwardProbe = 24;
  /** Z offset for wall check in water jump detection */
  wallcheckZ = 8;
  /** Z offset for empty space check above wall in water jump */
  emptycheckZ = 24;
  /** upward velocity when exiting water via water jump */
  waterExitVelocity = 310;
  /** multiplier applied to wish speed when swimming */
  waterspeedMultiplier = 0.7;
  /** overbounce factor for velocity clipping (1.0 = QW, 1.01 = Q2) */
  overbounce = 1.0;
  /** distance below feet for ground detection trace */
  groundCheckDepth = 1.0;
  /** pitch divisor for ground angle vectors (0 = no scaling, 3 = Q2-style) */
  pitchDivisor = 0;
  /** clamp jump velocity to a minimum of 270 */
  jumpMinClamp = false;
  /** apply landing cooldown (PMF_TIME_LAND) preventing immediate re-jump */
  landingCooldown = false;
  /** prevent swimming jump when sinking faster than -300 */
  swimJumpGuard = false;
  /** fall back to regular accelerate when airaccelerate is 0 */
  airAccelFallback = false;
  /** apply edge friction when near dropoffs */
  edgeFriction = true;
}

/**
 * Quake 2 defaults.
 *
 * This will give player movement that original Quake 2 feeling.
 */
export class PmoveQuake2Configuration extends PmoveConfiguration {
  forwardProbe = 30;
  wallcheckZ = 4;
  emptycheckZ = 16;
  waterExitVelocity = 350;
  waterspeedMultiplier = 0.5;
  overbounce = 1.01;
  groundCheckDepth = 0.25;
  pitchDivisor = 3;
  jumpMinClamp = true;
  landingCooldown = true;
  swimJumpGuard = true;
  airAccelFallback = true;
  edgeFriction = false;
}
