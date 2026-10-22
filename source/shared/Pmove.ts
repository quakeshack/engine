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
 *
 * This is only the behavior switches. Quake 2 also has different movement *variables*, which live in `MoveVars`
 * (`source/engine/common/Pmove.ts`) and come from the `sv_*` cvars, not from here. The values of `qcommon/pmove.c`:
 *
 * | variable | Quake 2 | engine default |
 * | :-- | :-- | :-- |
 * | `pm_friction` | 6 | `sv_friction` 4 |
 * | `pm_waterfriction` | 1 | `sv_waterfriction` 4 |
 * | `pm_maxspeed` | 300 | `sv_maxspeed` 320 |
 * | `pm_airaccelerate` | 0 | `sv_airaccelerate` 0.7 |
 * | `pm_stopspeed`, `pm_duckspeed`, `pm_accelerate`, `pm_wateraccelerate`, `pm_waterspeed` | 100, 100, 10, 10, 400 | the same |
 *
 * `PmoveQuake2MoveVars` below has them as cvar values, a Quake 2 game applies that when it starts. The `MoveVars` defaults used to be the Quake 2 friction values (6 and 1) by
 * accident of the Pmove port, which is why players moved with them from April to October 2026; see
 * `plans/track-e-collision-and-movement.md`, "Phase 0 follow-ups".
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

/**
 * The movement cvars of Quake 2, to be applied by a Quake 2 game when it starts, for instance
 * `for (const [name, value] of Object.entries(PmoveQuake2MoveVars)) { engine.SetCvar(name, value); }`.
 * Pair it with `PmoveQuake2Configuration` for the behavior switches.
 *
 * Values of `qcommon/pmove.c` (`pm_*`) and the default `sv_gravity` of Quake 2. The movement variables the engine adds on top
 * (`sv_spectatormaxspeed`, `edgefriction`) have no Quake 2 counterpart and are left alone. These are normal cvars: a server
 * admin or a config file can still change them after the game has set them.
 */
export const PmoveQuake2MoveVars = Object.freeze({
  sv_gravity: '800',
  sv_stopspeed: '100',
  sv_maxspeed: '300',
  sv_accelerate: '10',
  sv_airaccelerate: '0',
  sv_wateraccelerate: '10',
  sv_friction: '6',
  sv_waterfriction: '1',
});
