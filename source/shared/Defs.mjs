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
  /** mesh clip, touch on edge, block */
  SOLID_MESH: 5,
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
  /** entity can be used (interacted with) */
  FL_USEABLE: 8192,
});

/**
 * damage types
 * @readonly
 * @enum {number}
 */
export const damage = Object.freeze({
  /** no damage */
  DAMAGE_NO: 0,
  /** damage is applied */
  DAMAGE_YES: 1,
  /** damage aims at entities */
  DAMAGE_AIM: 2,
});

/**
 * collision trace move types
 * @readonly
 * @enum {number}
 */
export const moveTypes = Object.freeze({
  /** normal trace */
  MOVE_NORMAL: 0,
  /** don't clip against monsters */
  MOVE_NOMONSTERS: 1,
  /** expand for missile size */
  MOVE_MISSILE: 2,
});

/**
 * entity effects
 * NOTE: this is uint8
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

  /** makes sure the model is never completely dark */
  EF_MINLIGHT: 32,

  /** make sure the model never casts a shadow */
  EF_NOSHADOW: 64,

  /** simply not being rendered */
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
  /** whole map */
  ATTN_NONE: 0,
  /** around 1,000 units */
  ATTN_NORM: 1,
  /** around 500 units */
  ATTN_IDLE: 2,
  /** around 300 units */
  ATTN_STATIC: 3,
});

/**
 * Mins/max of available hulls.
 * @readonly
 */
export const hull = Object.freeze([
  [new Vector(-16.0, -16.0, -24.0).freeze(), new Vector(16.0, 16.0, 32.0).freeze()],
  [new Vector(-32.0, -32.0, -24.0).freeze(), new Vector(32.0, 32.0, 64.0).freeze()],
]);

/**
 * @readonly
 * @enum {number}
 * point content values
 */
export const content = Object.freeze({
  // for convenience:
  CONTENT_NONE: 0,

  // for game play:
  /** inside the world */
  CONTENT_EMPTY: -1,
  /** outside the world */
  CONTENT_SOLID: -2,
  CONTENT_WATER: -3,
  CONTENT_SLIME: -4,
  CONTENT_LAVA: -5,
  /** behaves like CONTENT_SOLID (collisions and sealing), but renders sky and might affect game play */
  CONTENT_SKY: -6,

  // for build tools shenanigans:
  CONTENT_ORIGIN: -7,
  /** clip brush, does not affect PxS nor rendering, but collisions */
  CONTENT_CLIP: -8,

  // currents:
  CONTENT_CURRENT_0: -9,
  CONTENT_CURRENT_90: -10,
  CONTENT_CURRENT_180: -11,
  CONTENT_CURRENT_270: -12,
  CONTENT_CURRENT_UP: -13,
  CONTENT_CURRENT_DOWN: -14,
});

/**
 * @readonly
 * @enum {number}
 * waterlevel values (0, 1, 2, 3) for .waterlevel
 */
export const waterlevel = Object.freeze({
  /** not in water */
  WATERLEVEL_NONE: 0,
  /** feet in water (origin[2] + playerMins[2] + 1) */
  WATERLEVEL_FEET: 1,
  /** waist in water (origin[2] + (playerMins[2] + playerMaxs[2]) / 2) */
  WATERLEVEL_WAIST: 2,
  /** head in water (origin[2] + view_ofs[2]) */
  WATERLEVEL_HEAD: 3,
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
 * feature flags for the game code (both server and client)
 */
export const gameCapabilities = Object.freeze({
  /** this will read total_secrets, total_monsters, found_secrets, killed_monsters being sent via updatestat and let the client write them to CL.state.stat */
  CAP_CLIENTDATA_UPDATESTAT: 'CAP_CLIENTDATA_UPDATESTAT',
  /** this will add items and ammo information to clientdata messages */
  CAP_CLIENTDATA_LEGACY: 'CAP_CLIENTDATA_LEGACY',
  /** this will transmit clientdataFields defined in the player entity to the client and automatically populate clientdata on the ClientGameAPI */
  CAP_CLIENTDATA_DYNAMIC: 'CAP_CLIENTDATA_DYNAMIC',
  /** will allow updating certain fields from server to client */
  CAP_ENTITY_EXTENDED: 'CAP_ENTITY_EXTENDED',
  /** the client game code brings its own status bar, in other words: no Sbar required! */
  CAP_HUD_INCLUDES_SBAR: 'CAP_HUD_INCLUDES_SBAR',
  /** the client game code takes care of rendering crosshairs, in other words: V is not required to draw one! */
  CAP_HUD_INCLUDES_CROSSHAIR: 'CAP_HUD_INCLUDES_CROSSHAIR',
  /** the client game manages the view model now, no longer the game code */
  CAP_VIEWMODEL_MANAGED: 'CAP_VIEWMODEL_MANAGED',
  /** no longer using SetNewParms, SetSpawnParms, SetChangeParms, parm0..15, but the new interfaces allowing for more flexibility */
  CAP_SPAWNPARMS_DYNAMIC: 'CAP_SPAWNPARMS_DYNAMIC',
  /** will use SetNewParms, SetSpawnParms, SetChangeParms, parm0..15, etc. */
  CAP_SPAWNPARMS_LEGACY: 'CAP_SPAWNPARMS_LEGACY',
  /** prevents chat messages from being handled by the engine, client code will handle that */
  CAP_CHAT_MANAGED: 'CAP_CHAT_MANAGED',
  /** adds additional units to the bounding box during entity linking (e.g. for items additional 28 units in total per x/y axis) */
  CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK: 'CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK',
});

export const cvarFlags = Object.freeze({
  NONE: 0,
  /** archive will make the engine write the modified variable to local storage or file (dedicated only) */
  ARCHIVE: 1,
  /** server will make changes be broadcast to all clients */
  SERVER: 2,
  /** readonly cannot be changed by the user, only through the API */
  READONLY: 4,
  /** value won’t be shown in broadcast message */
  SECRET: 8,
  /** variable declared by the game code */
  GAME: 16,
  /** variable will be changed upon next map */
  DEFERRED: 32, // TODO: implement
  /** variable cannot be changed unless sv_cheats is set to 1 */
  CHEAT: 64,
  /** variable has been registered from the client code */
  CLIENT: 128,
});

/** floating point epsilon to account for inexact comparisons */
export const EPSILON = 1e-8;
