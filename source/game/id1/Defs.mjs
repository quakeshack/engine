/* global Vector */

export const attackStates = {
  AS_NONE: 0,
  AS_STRAIGHT: 1,
  AS_SLIDING: 2,
  AS_MELEE: 3,
  AS_MISSILE: 4,
};

/**
 * range values
 */
export const range = {
  RANGE_MELEE: 0,
  RANGE_NEAR: 1,
  RANGE_MID: 2,
  RANGE_FAR: 3,
};

/**
 * deadflag values
 */
export const dead = {
  DEAD_NO: 0,
  DEAD_DYING: 1,
  DEAD_DEAD: 2,
  DEAD_RESPAWNABLE: 3,
};

/**
 * takedamage values
 */
export const damage = {
  DAMAGE_NO:  0,
  DAMAGE_YES: 1,
  DAMAGE_AIM: 2,
};

/**
 * edict.solid values
 */
export const solid = {
  SOLID_NOT:				0,	// no interaction with other objects
  SOLID_TRIGGER:		1,	// touch on edge, but not blocking
  SOLID_BBOX:				2,	// touch on edge, block
  SOLID_SLIDEBOX:		3,	// touch on edge, but not an onground
  SOLID_BSP:				4,	// bsp clip, touch on edge, block
};

/**
 * edict.movetype values
 */
export const moveType = {
  // edict.movetype values
  MOVETYPE_NONE: 0,	// never moves
  //float	MOVETYPE_ANGLENOCLIP: 1,
  //float	MOVETYPE_ANGLECLIP: 2,
  MOVETYPE_WALK: 3,	// players only
  MOVETYPE_STEP: 4,	// discrete, not real time unless fall
  MOVETYPE_FLY: 5,
  MOVETYPE_TOSS: 6,	// gravity
  MOVETYPE_PUSH: 7,	// no clip to world, push and crush
  MOVETYPE_NOCLIP: 8,
  MOVETYPE_FLYMISSILE: 9,	// fly with extra size against monsters
  MOVETYPE_BOUNCE: 10,
  MOVETYPE_BOUNCEMISSILE: 11,	// bounce with extra size
};

/**
 * edict.flags
 */
export const flags = {
  FL_NONE: 0, // CR: used to mark something as “flags here”
  FL_FLY: 1,
  FL_SWIM: 2,
  FL_CLIENT: 8,	// set for all client edicts
  FL_INWATER: 16,	// for enter / leave water splash
  FL_MONSTER: 32,
  FL_GODMODE: 64,	// player cheat
  FL_NOTARGET: 128,	// player cheat
  FL_ITEM: 256,	// extra wide size for bonus items
  FL_ONGROUND: 512,	// standing on something
  FL_PARTIALGROUND: 1024,	// not all corners are valid
  FL_WATERJUMP: 2048,	// player jumping out of water
  FL_JUMPRELEASED: 4096,	// for jump debouncing
};

/**
 * player items and weapons
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
};

/**
 * sound channels
 * channel 0 never willingly overrides
 * other channels (1-7) always override a playing sound on that channel
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
 */
export const attn = {
  ATTN_NONE: 0,
  ATTN_NORM: 1,
  ATTN_IDLE: 2,
  ATTN_STATIC: 3,
};

export const vec = {
  /**
   * @deprecated use Vector.origin directly instead
   */
  VEC_ORIGIN: Vector.origin,

  VEC_HULL_MIN: new Vector(-16.0, -16.0, -24.0),
  VEC_HULL_MAX: new Vector(16.0, 16.0, 32.0),

  VEC_HULL2_MIN: new Vector(-32.0, -32.0, -24.0),
  VEC_HULL2_MAX: new Vector(32.0, 32.0, 64.0),
};

/**
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
 * how the player died
 */
export const deathType = {
  NONE: null,
  FALLING: 'falling',
};

/**
 * worldspawn’s worldtype enum
 */
export const worldType = {
  MEDIEVAL: 0,
  RUNES: 1,
  BASE: 2,
};
