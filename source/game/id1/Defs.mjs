import * as engine from '../../shared/Defs.mjs';

export const solid = engine.solid;
export const moveType = engine.moveType;
export const flags = engine.flags;
export const effect = engine.effect;
export const modelFlags = engine.modelFlags;
export const channel = engine.channel;
export const attn = engine.attn;
export const hull = engine.hull;
export const content = engine.content;

/**
 * range values
 * @readonly
 * @enum {number}
 */
export const range = Object.freeze({
  RANGE_MELEE: 0,
  RANGE_NEAR: 1,
  RANGE_MID: 2,
  RANGE_FAR: 3,
});

/**
 * deadflag values
 * @readonly
 * @enum {number}
 */
export const dead = Object.freeze({
  DEAD_NO: 0,
  DEAD_DYING: 1,
  DEAD_DEAD: 2,
  DEAD_RESPAWNABLE: 3,
});

/**
 * takedamage values
 * @readonly
 * @enum {number}
 */
export const damage = Object.freeze({
  DAMAGE_NO:  0,
  DAMAGE_YES: 1,
  DAMAGE_AIM: 2,
});

/**
 * player items and weapons
 * @readonly
 * @enum {number}
 */
export const items = Object.freeze({
  IT_AXE:  4096,
  IT_SHOTGUN:  1,
  IT_SUPER_SHOTGUN:  2,
  IT_NAILGUN:  4,
  IT_SUPER_NAILGUN:  8,
  IT_GRENADE_LAUNCHER:  16,
  IT_ROCKET_LAUNCHER:  32,
  IT_LIGHTNING:  64,

  IT_KEY1: 131072,
  IT_KEY2: 262144,

  IT_INVISIBILITY: 524288,
  IT_INVULNERABILITY: 1048576,
  IT_SUIT: 2097152,
  IT_QUAD: 4194304,

  IT_SHELLS: 256,
  IT_NAILS: 512,
  IT_ROCKETS: 1024,
  IT_CELLS: 2048,

  IT_ARMOR1: 8192,
  IT_ARMOR2: 16384,
  IT_ARMOR3: 32768,
  IT_SUPERHEALTH: 65536,
});

/**
 * @readonly
 * @enum {?string}
 * how the player died
 */
export const deathType = Object.freeze({
  NONE: null,
  FALLING: 'falling',
});

/**
 * @readonly
 * @enum {number}
 * worldspawn’s worldtype enum
 */
export const worldType = Object.freeze({
  MEDIEVAL: 0,
  RUNES: 1,
  BASE: 2,
});

/**
 * @readonly
 * @enum {number}
 * temporary entity class, lets the client code render client-only effects and things without causing edict bloat and clogging the client-server infrastructure
 */
export const tentType = Object.freeze({
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
});

/**
 * @readonly
 * @enum {number}
 * color codes for blood and gore, should match palette.lmp colors
 */
export const colors = Object.freeze({
  DUST: 0,
  BLOOD: 73,
  FIRE: 75,
  SPARK: 225,
});

/**
 * @readonly
 * @enum {number}
 */
export const spawnflags = Object.freeze({
  SPAWNFLAG_NOT_EASY: 256,
  SPAWNFLAG_NOT_MEDIUM: 512,
  SPAWNFLAG_NOT_HARD: 1024,
  SPAWNFLAG_NOT_DEATHMATCH: 2048,
});
