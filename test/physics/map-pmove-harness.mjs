import fs from 'node:fs/promises';
import path from 'node:path';

import COMClass from '../../source/engine/common/Com.ts';
import Mod from '../../source/engine/common/Mod.mjs';
import { PMF, Pmove } from '../../source/engine/common/Pmove.ts';
import { UserCmd } from '../../source/engine/network/Protocol.ts';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import Vector from '../../source/shared/Vector.ts';

/**
 * @typedef {Record<string, string>} EntityKV
 */

/**
 * @typedef {object} HarnessOptions
 * @property {string} mapName
 * @property {string} gameDir
 * @property {string} spawnClassname
 * @property {string} orientationTargetname
 * @property {number} frames
 * @property {number} msec
 * @property {number} forwardmove
 * @property {number} probeDistance
 */

/**
 * Parse the BSP entity lump using the engine's token parser.
 * @param {string} text entity lump text
 * @returns {EntityKV[]} parsed entities
 */
function parseEntities(text) {
  /** @type {EntityKV[]} */
  const entities = [];
  let data = text;

  while (data !== null) {
    let parsed = COMClass.Parse(data);
    data = parsed.data;

    if (parsed.token.length === 0) {
      break;
    }

    if (parsed.token !== '{') {
      continue;
    }

    /** @type {EntityKV} */
    const entity = {};

    while (true) {
      parsed = COMClass.Parse(data);
      data = parsed.data;

      if (parsed.token === '}') {
        entities.push(entity);
        break;
      }

      const key = parsed.token;
      parsed = COMClass.Parse(data);
      data = parsed.data;
      entity[key] = parsed.token;
    }
  }

  return entities;
}

/**
 * Convert a Quake origin string into a Vector.
 * @param {string} origin entity origin string
 * @returns {Vector} parsed vector
 */
function parseOrigin(origin) {
  const components = origin.split(/\s+/).map(Number);
  return new Vector(components[0], components[1], components[2]);
}

/**
 * Resolve the first entity matching the predicate or throw a clear error.
 * @param {EntityKV[]} entities parsed entity list
 * @param {(entity: EntityKV) => boolean} predicate entity predicate
 * @param {string} label entity description for error messages
 * @returns {EntityKV} matching entity
 */
function requireEntity(entities, predicate, label) {
  const entity = entities.find(predicate);

  if (entity === undefined) {
    throw new Error(`Could not find ${label} in entity lump`);
  }

  return entity;
}

/**
 * Resolve the movement yaw for the harness.
 * Prefer the explicit spawn angle when present so authored repro maps can
 * encode the exact forward vector directly on the spawn.
 * @param {EntityKV} spawn spawn entity
 * @param {EntityKV[]} entities parsed entity list
 * @param {string} orientationTargetname targetname used for legacy direction markers
 * @returns {{ yaw: number, orientationOrigin: Vector|null, forward: Vector }} yaw and derived forward vector
 */
function resolveYaw(spawn, entities, orientationTargetname) {
  if (spawn.angle !== undefined) {
    const yaw = Number(spawn.angle);
    const radians = yaw * Math.PI / 180;
    return {
      yaw,
      orientationOrigin: null,
      forward: new Vector(Math.cos(radians), Math.sin(radians), 0),
    };
  }

  const orientation = requireEntity(
    entities,
    (entity) => entity.targetname === orientationTargetname,
    `orientation entity targetname=${orientationTargetname}`,
  );
  const spawnOrigin = parseOrigin(spawn.origin);
  const orientationOrigin = parseOrigin(orientation.origin);
  const forward = orientationOrigin.copy().subtract(spawnOrigin);
  forward.normalize();

  return {
    yaw: Math.atan2(forward[1], forward[0]) * 180 / Math.PI,
    orientationOrigin,
    forward,
  };
}

/**
 * Parse simple `--name=value` command line options.
 * @returns {HarnessOptions} normalized harness options
 */
function parseOptions() {
  /** @type {HarnessOptions} */
  const options = {
    mapName: 'maps/test_clip.bsp',
    gameDir: 'id1',
    spawnClassname: 'info_player_start',
    orientationTargetname: 'direction',
    frames: 80,
    msec: 50,
    forwardmove: 320,
    probeDistance: 16,
  };

  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);

    if (match === null) {
      continue;
    }

    const [, key, value] = match;

    switch (key) {
      case 'map':
        options.mapName = value;
        break;
      case 'game':
        options.gameDir = value;
        break;
      case 'spawn':
        options.spawnClassname = value;
        break;
      case 'orientation-target':
        options.orientationTargetname = value;
        break;
      case 'frames':
        options.frames = Number(value);
        break;
      case 'msec':
        options.msec = Number(value);
        break;
      case 'forwardmove':
        options.forwardmove = Number(value);
        break;
      case 'probe-distance':
        options.probeDistance = Number(value);
        break;
    }
  }

  return options;
}

/**
 * Install enough registry state to load BSPs in a dedicated-style harness.
 * @param {string} baseDir active game data directory
 */
function installRegistry(baseDir) {
  registry.isDedicatedServer = true;
  registry.Con = {
    Print(...args) {
      console.log(...args);
    },
    DPrint() {},
    PrintWarning(...args) {
      console.warn(...args);
    },
    PrintError(...args) {
      console.error(...args);
    },
    PrintSuccess(...args) {
      console.log(...args);
    },
  };
  registry.Mod = Mod;
  registry.COM = {
    Parse: COMClass.Parse,
    async LoadFile(name) {
      const resolved = path.join(baseDir, name);

      try {
        const data = await fs.readFile(resolved);
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } catch {
        return null;
      }
    },
    async LoadTextFile(name) {
      const resolved = path.join(baseDir, name);

      try {
        return await fs.readFile(resolved, 'utf8');
      } catch {
        return null;
      }
    },
  };

  eventBus.publish('registry.frozen');
  Mod.Init();
}

/**
 * @param {number} value numeric value
 * @returns {number} rounded value for compact output
 */
function round(value) {
  return Number(value.toFixed(3));
}

const options = parseOptions();
const baseDir = path.resolve(`./data/${options.gameDir}`);

installRegistry(baseDir);

const model = await Mod.ForNameAsync(options.mapName, true);
const entities = parseEntities(model.entities);
const spawn = requireEntity(
  entities,
  (entity) => entity.classname === options.spawnClassname,
  `spawn entity classname=${options.spawnClassname}`,
);

const spawnOrigin = parseOrigin(spawn.origin);
const { yaw, orientationOrigin, forward } = resolveYaw(spawn, entities, options.orientationTargetname);

const pmove = new Pmove();
pmove.setWorldmodel(model);

const player = pmove.newPlayerMove();
player.origin.set(spawnOrigin);
player.velocity.clear();
player.angles.setTo(0, yaw, 0);
player.pmFlags = PMF.ON_GROUND;
player.onground = 0;

console.log(JSON.stringify({
  map: options.mapName,
  hasBrushData: model.hasBrushData,
  brushes: model.numBrushes,
  leafbrushes: model.leafbrushes?.length ?? 0,
  spawn: [spawnOrigin[0], spawnOrigin[1], spawnOrigin[2]],
  orientationTarget: orientationOrigin === null ? null : [orientationOrigin[0], orientationOrigin[1], orientationOrigin[2]],
  yaw: round(yaw),
  forward: [forward[0], forward[1], forward[2]].map(round),
}, null, 2));

for (let frame = 0; frame < options.frames; frame++) {
  const before = player.origin.copy();

  const cmd = new UserCmd();
  cmd.msec = options.msec;
  cmd.forwardmove = options.forwardmove;
  cmd.angles = player.angles.copy();
  player.cmd = cmd;
  player.move();

  const delta = player.origin.copy().subtract(before);
  const probeEnd = before.copy().add(forward.copy().multiply(options.probeDistance));
  const probeTrace = pmove.clipPlayerMove(before, probeEnd);

  const row = {
    frame,
    origin: [...player.origin].map(round),
    moved: [...delta].map(round),
    velocity: [...player.velocity].map(round),
    onground: player.onground,
    probeFraction: round(probeTrace.fraction),
    probeStartsolid: probeTrace.startsolid,
    probeAllsolid: probeTrace.allsolid,
    probeNormal: [...probeTrace.plane.normal].map(round),
  };

  console.log(JSON.stringify(row));
}
