import fs from 'node:fs/promises';
import path from 'node:path';

import COMClass from '../../source/engine/common/Com.ts';
import Mod from '../../source/engine/common/Mod.ts';
import { PMF, Pmove } from '../../source/engine/common/Pmove.ts';
import { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { UserCmd } from '../../source/engine/network/Protocol.ts';
import Vector from '../../source/shared/Vector.ts';
import { engineMocks } from './engineMocks.ts';

/*
 * A command line tool, not a test: it loads a BSP, drops a player on a spawn point and prints how the player
 * moves, one JSON row per frame, so a collision repro map can be inspected without a game.
 *
 *   npx tsx test/support/mapPmoveHarness.ts --map=maps/test_clip.bsp --game=id1 --frames=80
 *
 * Options: --map, --game, --spawn, --orientation-target, --frames, --msec, --forwardmove, --probe-distance.
 */

type EntityKV = Record<string, string>;

interface HarnessOptions {
  /** BSP path relative to the selected game directory. */
  mapName: string;
  /** Game directory used to resolve the BSP and assets. */
  gameDir: string;
  /** Spawn classname used to place the probe entity. */
  spawnClassname: string;
  /** Optional targetname used to derive the probe yaw. */
  orientationTargetname: string;
  /** Number of movement frames to simulate. */
  frames: number;
  /** Frame duration in milliseconds for each simulated command. */
  msec: number;
  /** Forward movement command applied each frame. */
  forwardmove: number;
  /** Distance used for optional forward probe traces. */
  probeDistance: number;
}

/**
 * Parse the BSP entity lump using the engine's token parser.
 * @param text Entity lump text.
 * @returns The parsed entities.
 */
function parseEntities(text: string): EntityKV[] {
  const entities: EntityKV[] = [];
  let data: string | null = text;

  while (data !== null) {
    let parsed = COMClass.Parse(data);
    data = parsed.data;

    if (parsed.token.length === 0) {
      break;
    }

    if (parsed.token !== '{') {
      continue;
    }

    const entity: EntityKV = {};

    while (true) {
      if (data === null) {
        throw new Error('Entity lump ends inside an entity');
      }

      parsed = COMClass.Parse(data);
      data = parsed.data;

      if (parsed.token === '}') {
        entities.push(entity);
        break;
      }

      if (data === null) {
        throw new Error('Entity lump ends inside an entity');
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
 * @param origin Entity origin string.
 * @returns The parsed vector.
 */
function parseOrigin(origin: string): Vector {
  const components = origin.split(/\s+/).map(Number);
  return new Vector(components[0], components[1], components[2]);
}

/**
 * Resolve the first entity matching the predicate or throw a clear error.
 * @param entities Parsed entity list.
 * @param predicate Entity predicate.
 * @param label Entity description for error messages.
 * @returns The matching entity.
 */
function requireEntity(entities: EntityKV[], predicate: (entity: EntityKV) => boolean, label: string): EntityKV {
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
 * @param spawn Spawn entity.
 * @param entities Parsed entity list.
 * @param orientationTargetname Targetname used for legacy direction markers.
 * @returns The yaw and the derived forward vector.
 */
function resolveYaw(spawn: EntityKV, entities: EntityKV[], orientationTargetname: string): { yaw: number; orientationOrigin: Vector | null; forward: Vector } {
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
 * @returns The normalized harness options.
 */
function parseOptions(): HarnessOptions {
  const options: HarnessOptions = {
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
      default:
        break;
    }
  }

  return options;
}

/**
 * Install enough engine state to load BSPs in a dedicated-style harness.
 * @param baseDir Active game data directory.
 */
function installEngine(baseDir: string): void {
  const con = {
    Print(...args: unknown[]) {
      console.log(...args);
    },
    DPrint() {},
    PrintWarning(...args: unknown[]) {
      console.warn(...args);
    },
    PrintError(...args: unknown[]) {
      console.error(...args);
    },
    PrintSuccess(...args: unknown[]) {
      console.log(...args);
    },
  };
  const files = {
    Parse: COMClass.Parse,
    ParseEntityLump: COMClass.ParseEntityLump,
    async LoadFile(name: string) {
      const resolved = path.join(baseDir, name);

      try {
        const data = await fs.readFile(resolved);
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } catch {
        return null;
      }
    },
    async LoadTextFile(name: string) {
      const resolved = path.join(baseDir, name);

      try {
        return await fs.readFile(resolved, 'utf8');
      } catch {
        return null;
      }
    },
  };

  engineMocks.Con = con;
  engineMocks.Mod = Mod;
  engineMocks.COM = files;

  Mod.Init({ files, con, loadRenderData: false });
}

/**
 * Round a number for compact output.
 * @param value The number.
 * @returns The rounded number.
 */
function round(value: number): number {
  return Number(value.toFixed(3));
}

const options = parseOptions();
const baseDir = path.resolve(`./data/${options.gameDir}`);

installEngine(baseDir);

const model = await Mod.ForNameAsync(options.mapName, true) as BrushModel;
const entities = parseEntities(model.entities!);
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
