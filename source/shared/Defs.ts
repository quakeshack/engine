/**
 * Engine-game shared definitions.
 */

import Vector from './Vector.ts';

/**
 * `edict.solid` values.
 */
export enum solid {
  /** no interaction with other objects */
  SOLID_NOT = 0,
  /** touch on edge, but not blocking */
  SOLID_TRIGGER = 1,
  /** touch on edge, block */
  SOLID_BBOX = 2,
  /** touch on edge, but not an onground */
  SOLID_SLIDEBOX = 3,
  /** bsp clip, touch on edge, block */
  SOLID_BSP = 4,
  /** mesh clip, touch on edge, block */
  SOLID_MESH = 5,
}

/**
 * `edict.movetype` values.
 */
export enum moveType {
  /** never moves */
  MOVETYPE_NONE = 0,
  // float MOVETYPE_ANGLENOCLIP: 1,
  // float MOVETYPE_ANGLECLIP: 2,
  /** players only */
  MOVETYPE_WALK = 3,
  /** discrete, not real time unless fall */
  MOVETYPE_STEP = 4,
  MOVETYPE_FLY = 5,
  /** gravity */
  MOVETYPE_TOSS = 6,
  /** no clip to world, push and crush */
  MOVETYPE_PUSH = 7,
  MOVETYPE_NOCLIP = 8,
  /** fly with extra size against monsters */
  MOVETYPE_FLYMISSILE = 9,
  MOVETYPE_BOUNCE = 10,
  /** bounce with extra size */
  MOVETYPE_BOUNCEMISSILE = 11,
}

/**
 * `edict.flags` values.
 */
export enum flags {
  FL_NONE = 0,
  FL_FLY = 1,
  FL_SWIM = 2,
  /** set for all client edicts */
  FL_CLIENT = 8,
  /** for enter / leave water splash */
  FL_INWATER = 16,
  FL_MONSTER = 32,
  /** player cheat */
  FL_GODMODE = 64,
  /** player cheat */
  FL_NOTARGET = 128,
  /** extra wide size for bonus items */
  FL_ITEM = 256,
  /** standing on something */
  FL_ONGROUND = 512,
  /** not all corners are valid */
  FL_PARTIALGROUND = 1024,
  /** player jumping out of water */
  FL_WATERJUMP = 2048,
  /** for jump debouncing */
  FL_JUMPRELEASED = 4096,
  /** entity can be used (interacted with) */
  FL_USEABLE = 8192,
}

/**
 * Damage types.
 */
export enum damage {
  /** no damage */
  DAMAGE_NO = 0,
  /** damage is applied */
  DAMAGE_YES = 1,
  /** damage aims at entities */
  DAMAGE_AIM = 2,
}

/**
 * Collision trace move types.
 */
export enum moveTypes { // TODO: unfortunate name, need to rename this to avoid confusion with edict.movetype
  /** normal trace */
  MOVE_NORMAL = 0,
  /** don't clip against monsters */
  MOVE_NOMONSTERS = 1,
  /** expand for missile size */
  MOVE_MISSILE = 2,
}

/**
 * Entity effects.
 * This is a uint8.
 */
export enum effect {
  EF_NONE = 0,
  /** will emit particles looking like a bunch of fireflies circling the entity */
  EF_BRIGHTFIELD = 1,
  /** emits a single muzzleflash, it will automatically be removed in the next frame */
  EF_MUZZLEFLASH = 2,
  /** emits a bright flickering light (400 units) */
  EF_BRIGHTLIGHT = 4,
  /** emits a dim flickering light (200 units) */
  EF_DIMLIGHT = 8,
  /** makes sure that the model is always rendered fullbright */
  EF_FULLBRIGHT = 16,
  /** makes sure the model is never completely dark */
  EF_MINLIGHT = 32,
  /** make sure the model never casts a shadow */
  EF_NOSHADOW = 64,
  /** simply not being rendered */
  EF_NODRAW = 128,
}

/**
 * Model flags.
 */
export enum modelFlags {
  MF_NONE = 0,
  MF_ROCKET = 1,
  MF_GRENADE = 2,
  MF_GIB = 4,
  MF_ROTATE = 8,
  MF_TRACER = 16,
  MF_ZOMGIB = 32,
  MF_TRACER2 = 64,
  MF_TRACER3 = 128,
}

/**
 * Sound channels.
 * Channel 0 never willingly overrides.
 * Other channels (1-7) always override a playing sound on that channel.
 */
export enum channel {
  CHAN_AUTO = 0,
  CHAN_WEAPON = 1,
  CHAN_VOICE = 2,
  CHAN_ITEM = 3,
  CHAN_BODY = 4,
}

/**
 * Sound attenuation.
 */
export enum attn {
  /** whole map */
  ATTN_NONE = 0,
  /** around 1,000 units */
  ATTN_NORM = 1,
  /** around 500 units */
  ATTN_IDLE = 2,
  /** around 300 units */
  ATTN_STATIC = 3,
}

/**
 * Mins/maxes of available hulls.
 */
export const hull = Object.freeze([
  [new Vector(-16.0, -16.0, -24.0).freeze(), new Vector(16.0, 16.0, 32.0).freeze()] as const,
  [new Vector(-32.0, -32.0, -24.0).freeze(), new Vector(32.0, 32.0, 64.0).freeze()] as const,
] satisfies readonly [mins: Vector, maxs: Vector][]);

/**
 * Point content values.
 */
export enum content {
  // for convenience:
  /** uninitialized content, should never show up */
  CONTENT_NONE = 0,

  // for game play:
  /** inside the world */
  CONTENT_EMPTY = -1,
  /** outside the world */
  CONTENT_SOLID = -2,
  CONTENT_WATER = -3,
  CONTENT_SLIME = -4,
  CONTENT_LAVA = -5,
  /** behaves like CONTENT_SOLID (collisions and sealing), but renders sky and might affect game play */
  CONTENT_SKY = -6,

  // for build tools shenanigans:
  CONTENT_ORIGIN = -7,
  /** clip brush, does not affect PxS nor rendering, but collisions */
  CONTENT_CLIP = -8,

  // currents:
  CONTENT_CURRENT_0 = -9,
  CONTENT_CURRENT_90 = -10,
  CONTENT_CURRENT_180 = -11,
  CONTENT_CURRENT_270 = -12,
  CONTENT_CURRENT_UP = -13,
  CONTENT_CURRENT_DOWN = -14,
}

/**
 * `waterlevel` values for `.waterlevel`.
 */
export enum waterlevel {
  /** not in water */
  WATERLEVEL_NONE = 0,
  /** feet in water (`origin[2] + playerMins[2] + 1`) */
  WATERLEVEL_FEET = 1,
  /** waist in water (`origin[2] + (playerMins[2] + playerMaxs[2]) / 2`) */
  WATERLEVEL_WAIST = 2,
  /** head in water (`origin[2] + view_ofs[2]`) */
  WATERLEVEL_HEAD = 3,
}

/**
 * Thin client information and legacy `updatestat` values.
 */
export enum clientStat {
  STAT_HEALTH = 0,
  STAT_WEAPON = 2,
  STAT_WEAPONFRAME = 5,
}

/**
 * Feature flags for the game code (both server and client).
 */
export enum gameCapabilities {
  /** the client game code takes care of rendering crosshairs, in other words: V is not required to draw one! */
  CAP_HUD_INCLUDES_CROSSHAIR = 'CAP_HUD_INCLUDES_CROSSHAIR',
  /** adds additional units to the bounding box during entity linking (e.g. for items additional 28 units in total per x/y axis) */
  CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK = 'CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK',
}

/**
 * Cvar registration flags.
 */
export enum cvarFlags {
  NONE = 0,
  /** archive will make the engine write the modified variable to local storage or file (dedicated only) */
  ARCHIVE = 1,
  /** server will make changes be broadcast to all clients */
  SERVER = 2,
  /** readonly cannot be changed by the user, only through the API */
  READONLY = 4,
  /** value won’t be shown in broadcast message */
  SECRET = 8,
  /** variable declared by the game code */
  GAME = 16,
  /** variable will be changed upon next map */
  DEFERRED = 32,
  /** variable cannot be changed unless sv_cheats is set to 1 */
  CHEAT = 64,
  /** variable has been registered from the client code */
  CLIENT = 128,
}

/** floating point epsilon to account for inexact comparisons */
export const EPSILON = 1e-8;
