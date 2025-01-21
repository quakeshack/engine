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
};

export const damage = {
  DAMAGE_NO:  0,
  DAMAGE_YES: 1,
  DAMAGE_AIM: 2,
};

export const solid = {
  SOLID_NOT:				0,	// no interaction with other objects
  SOLID_TRIGGER:		1,	// touch on edge, but not blocking
  SOLID_BBOX:				2,	// touch on edge, block
  SOLID_SLIDEBOX:		3,	// touch on edge, but not an onground
  SOLID_BSP:				4,	// bsp clip, touch on edge, block
};

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

export const flags = {
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

export const attn = {
  ATTN_NONE: 0,
  ATTN_NORM: 1,
  ATTN_IDLE: 2,
  ATTN_STATIC: 3,
};
