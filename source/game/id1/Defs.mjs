/* global Vector */

/**
 * range values
 * @readonly
 * @enum {number}
 */
export const range = {
  RANGE_MELEE: 0,
  RANGE_NEAR: 1,
  RANGE_MID: 2,
  RANGE_FAR: 3,
};

/**
 * deadflag values
 * @readonly
 * @enum {number}
 */
export const dead = {
  DEAD_NO: 0,
  DEAD_DYING: 1,
  DEAD_DEAD: 2,
  DEAD_RESPAWNABLE: 3,
};

/**
 * takedamage values
 * @readonly
 * @enum {number}
 */
export const damage = {
  DAMAGE_NO:  0,
  DAMAGE_YES: 1,
  DAMAGE_AIM: 2,
};

/**
 * edict.solid values
 * @readonly
 * @enum {number}
 */
export const solid = {
  /** no interaction with other objects */
  SOLID_NOT:				0,
  /** touch on edge, but not blocking */
  SOLID_TRIGGER:		1,
  /** touch on edge, block */
  SOLID_BBOX:				2,
  /** touch on edge, but not an onground */
  SOLID_SLIDEBOX:		3,
  /** bsp clip, touch on edge, block */
  SOLID_BSP:				4,
};

/**
 * edict.movetype values
 * @readonly
 * @enum {number}
 */
export const moveType = {
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
};

/**
 * edict.flags
 * @readonly
 * @enum {number}
 */
export const flags = {
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
};

/**
 * entity effects
 */
export const effect = {
  EF_BRIGHTFIEL: 1,
  EF_MUZZLEFLASH: 2,
  EF_BRIGHTLIGHT: 4,
  EF_DIMLIGHT: 8,
};

/**
 * player items and weapons
 * @readonly
 * @enum {number}
 */
export const items = {
  IT_AXE:  4096,
  IT_SHOTGUN:  1,
  IT_SUPER_SHOTGUN:  2,
  IT_NAILGUN:  4,
  IT_SUPER_NAILGUN:  8,
  IT_GRENADE_LAUNCHER:  16,
  IT_ROCKET_LAUNCHER:  32,
  IT_LIGHTNING:  64,
  IT_EXTRA_WEAPON:  128,

  IT_KEY1: 131072,
  IT_KEY2: 262144,

  IT_INVISIBILITY: 524288,
  IT_INVULNERABILITY: 1048576,
  IT_SUIT: 2097152,
  IT_QUAD: 4194304,

  IT_ARMOR1: 8192,
  IT_ARMOR2: 16384,
  IT_ARMOR3: 32768,
  IT_SUPERHEALTH: 65536,
};

/**
 * sound channels
 * channel 0 never willingly overrides
 * other channels (1-7) always override a playing sound on that channel
 * @readonly
 * @enum {number}
 */
export const channel = {
  CHAN_AUTO:		0,
	CHAN_WEAPON:	1,
	CHAN_VOICE:		2,
	CHAN_ITEM:		3,
	CHAN_BODY:		4,
};

/**
 * attenuation
 * @readonly
 * @enum {number}
 */
export const attn = {
  ATTN_NONE: 0,
  ATTN_NORM: 1,
  ATTN_IDLE: 2,
  ATTN_STATIC: 3,
};

/**
 * Mins/max of available hulls.
 * @readonly
 */
export const hull = [
  [new Vector(-16.0, -16.0, -24.0), new Vector(16.0, 16.0, 32.0)],
  [new Vector(-32.0, -32.0, -24.0), new Vector(32.0, 32.0, 64.0)],
];

/**
 * @readonly
 * @enum {number}
 * point content values
 */
export const content = {
  CONTENT_EMPTY: -1,
  CONTENT_SOLID: -2,
  CONTENT_WATER: -3,
  CONTENT_SLIME: -4,
  CONTENT_LAVA: -5,
  CONTENT_SKY: -6,
};

/**
 * @readonly
 * @enum {?string}
 * how the player died
 */
export const deathType = {
  NONE: null,
  FALLING: 'falling',
};

/**
 * @readonly
 * @enum {number}
 * worldspawn’s worldtype enum
 */
export const worldType = {
  MEDIEVAL: 0,
  RUNES: 1,
  BASE: 2,
};

/**
 * @readonly
 * @enum {number}
 * temporary entity class, let’s the client code render client-only effects and things without causing edict bloat and clogging the client-server infrastructure
 */
export const tentType = {
  TE_SPIKE: 0,
  TE_SUPERSPIKE: 1,
  TE_GUNSHOT: 2,
  TE_EXPLOSION: 3,
  TE_TAREXPLOSION: 4,
  TE_LIGHTNING1: 5,
  TE_LIGHTNING2: 6,
  TE_WIZSPIKE: 7,
  TE_KNIGHTSPIKE: 8,
  TE_LIGHTNING3: 9,
  TE_LAVASPLASH: 10,
  TE_TELEPORT: 11,
};
