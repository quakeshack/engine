
/**
 * Version string. It will be modified during the build process.
 */
export const version = '1.1.0+dev';

export const limits = Object.freeze({
  edicts: 600,
  clients: 32,
  dlights: 32,
  lightstyles: 64,
  beams: 24,
  entities: 1024,
});

/**
 * @enum {number}
 * @readonly
 */
export const stat = Object.freeze({
  health: 0,
  frags: 1,
  weapon: 2,
  ammo: 3,
  armor: 4,
  weaponframe: 5,
  shells: 6,
  nails: 7,
  rockets: 8,
  cells: 9,
  activeweapon: 10,
  totalsecrets: 11,
  totalmonsters: 12,
  secrets: 13,
  monsters: 14,
});

/**
 * @enum {number}
 * @readonly
 */
export const it = Object.freeze({
  shotgun: 1,
  super_shotgun: 2,
  nailgun: 4,
  super_nailgun: 8,
  grenade_launcher: 16,
  rocket_launcher: 32,
  lightning: 64,
  super_lightning: 128,
  shells: 256,
  nails: 512,
  rockets: 1024,
  cells: 2048,
  axe: 4096,
  armor1: 8192,
  armor2: 16384,
  armor3: 32768,
  superhealth: 65536,
  key1: 131072,
  key2: 262144,
  invisibility: 524288,
  invulnerability: 1048576,
  suit: 2097152,
  quad: 4194304,
});

/**
 * @enum {number}
 * @readonly
 */
export const rit = Object.freeze({
  shells: 128,
  nails: 256,
  rockets: 512,
  cells: 1024,
  axe: 2048,
  lava_nailgun: 4096,
  lava_super_nailgun: 8192,
  multi_grenade: 16384,
  multi_rocket: 32768,
  plasma_gun: 65536,
  armor1: 8388608,
  armor2: 16777216,
  armor3: 33554432,
  lava_nails: 67108864,
  plasma_ammo: 134217728,
  multi_rockets: 268435456,
  shield: 536870912,
  antigrav: 1073741824,
  superhealth: 2147483648,
});

/**
 * @enum {number}
 * @readonly
 */
export const hit = Object.freeze({
  proximity_gun_bit: 16,
  mjolnir_bit: 7,
  laser_cannon_bit: 23,
  proximity_gun: 65536,
  mjolnir: 128,
  laser_cannon: 8388608,
  wetsuit: 33554432,
  empathy_shields: 67108864,
});

/**
 * @enum {number}
 * @readonly
 */
export const contentShift = Object.freeze({
  contents: 0,
  damage: 1,
  bonus: 2,
  powerup: 3,
});

/**
 * @enum {number}
 * @readonly
 */
export const clientConnectionState = {
  disconnected: 0,
  connecting: 1,
  connected: 2,
};
