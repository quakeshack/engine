/**
 * Engine-game shared definitions.
 */

import Vector from './Vector.mjs';

/**
 * edict.solid values
 * @readonly
 * @enum {number}
 */
export const solid = Object.freeze({
  /** no interaction with other objects */
  SOLID_NOT: 0,
  /** touch on edge, but not blocking */
  SOLID_TRIGGER: 1,
  /** touch on edge, block */
  SOLID_BBOX: 2,
  /** touch on edge, but not an onground */
  SOLID_SLIDEBOX: 3,
  /** bsp clip, touch on edge, block */
  SOLID_BSP: 4,
});

/**
 * edict.movetype values
 * @readonly
 * @enum {number}
 */
export const moveType = Object.freeze({
  /** never moves */
  MOVETYPE_NONE: 0,
  //float	MOVETYPE_ANGLENOCLIP: 1,
  //float	MOVETYPE_ANGLECLIP: 2,
  /** players only */
  MOVETYPE_WALK: 3,
  /** discrete, not real time unless fall */
  MOVETYPE_STEP: 4,
  MOVETYPE_FLY: 5,
  /** gravity */
  MOVETYPE_TOSS: 6,
  /** no clip to world, push and crush */
  MOVETYPE_PUSH: 7,
  MOVETYPE_NOCLIP: 8,
  /** fly with extra size against monsters */
  MOVETYPE_FLYMISSILE: 9,
  MOVETYPE_BOUNCE: 10,
  /** bounce with extra size */
  MOVETYPE_BOUNCEMISSILE: 11,
});

/**
 * edict.flags
 * @readonly
 * @enum {number}
 */
export const flags = Object.freeze({
  FL_NONE: 0, // CR: used to mark something as “flags here”
  FL_FLY: 1,
  FL_SWIM: 2,
  /** set for all client edicts */
  FL_CLIENT: 8,
  /** for enter / leave water splash */
  FL_INWATER: 16,
  FL_MONSTER: 32,
  /** player cheat */
  FL_GODMODE: 64,
  /** player cheat */
  FL_NOTARGET: 128,
  /** extra wide size for bonus items */
  FL_ITEM: 256,
  /** standing on something */
  FL_ONGROUND: 512,
  /** not all corners are valid */
  FL_PARTIALGROUND: 1024,
  /** player jumping out of water */
  FL_WATERJUMP: 2048,
  /** for jump debouncing */
  FL_JUMPRELEASED: 4096,
});

/**
 * entity effects
 * @readonly
 * @enum {number}
 */
export const effect = Object.freeze({
  EF_NONE: 0,
  EF_BRIGHTFIELD: 1,
  EF_MUZZLEFLASH: 2,
  EF_BRIGHTLIGHT: 4,
  EF_DIMLIGHT: 8,

  /** makes sure that the model is always rendered fullbright */
  EF_FULLBRIGHT: 16,

  EF_NODRAW: 128,
});

/**
 * model flags
 * @readonly
 * @enum {number}
 */
export const modelFlags = Object.freeze({
  MF_NONE: 0,
  MF_ROCKET: 1,
  MF_GRENADE: 2,
  MF_GIB: 4,
  MF_ROTATE: 8,
  MF_TRACER: 16,
  MF_ZOMGIB: 32,
  MF_TRACER2: 64,
  MF_TRACER3: 128,
});


/**
 * sound channels
 * channel 0 never willingly overrides
 * other channels (1-7) always override a playing sound on that channel
 * @readonly
 * @enum {number}
 */
export const channel = Object.freeze({
  CHAN_AUTO: 0,
  CHAN_WEAPON: 1,
  CHAN_VOICE: 2,
  CHAN_ITEM: 3,
  CHAN_BODY: 4,
});

/**
 * attenuation
 * @readonly
 * @enum {number}
 */
export const attn = Object.freeze({
  ATTN_NONE: 0,
  ATTN_NORM: 1,
  ATTN_IDLE: 2,
  ATTN_STATIC: 3,
});

/**
 * Mins/max of available hulls.
 * @readonly
 */
export const hull = [
  [new Vector(-16.0, -16.0, -24.0).freeze(), new Vector(16.0, 16.0, 32.0).freeze()],
  [new Vector(-32.0, -32.0, -24.0).freeze(), new Vector(32.0, 32.0, 64.0).freeze()],
];

/**
 * @readonly
 * @enum {number}
 * point content values
 */
export const content = Object.freeze({
  CONTENT_EMPTY: -1,
  CONTENT_SOLID: -2,
  CONTENT_WATER: -3,
  CONTENT_SLIME: -4,
  CONTENT_LAVA: -5,
  CONTENT_SKY: -6,
});

/**
 * @readonly
 * @enum {number}
 * @deprecated I’m thinking of a more extensible way to handle this
 * thin client information and legacy updatestat values
 */
export const clientStat = Object.freeze({
  STAT_HEALTH: 0,
  STAT_WEAPON: 2,
  STAT_WEAPONFRAME: 5,
});

/**
 * @readonly
 * @enum {string}
 * feature flags
 */
export const gameCapabilities = Object.freeze({
  /** this will read total_secrets, total_monsters, found_secrets, killed_monsters being sent via updatestat and let the client write them to CL.state.stat */
  CAP_LEGACY_UPDATESTAT: 'CAP_REQUIRES_UPDATESTAT',
  /** this will add items and ammo information to clientdata messages */
  CAP_LEGACY_CLIENTDATA: 'CAP_LEGACY_CLIENTDATA',
  /** the client game code brings its own status bar, in other words: no Sbar required! */
  CAP_HUD_INCLUDES_SBAR: 'CAP_HUD_INCLUDES_SBAR',
  /** the client game code takes care of rendering crosshairs, in other words: V is not required to draw one! */
  CAP_HUD_INCLUDES_CROSSHAIR: 'CAP_HUD_INCLUDES_CROSSHAIR',
  /** the client game manages the view model now, no longer the game code */
  CAP_VIEWMODEL_MANAGED: 'CAP_VIEWMODEL_MANAGED',
});
