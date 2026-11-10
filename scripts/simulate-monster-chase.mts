/**
 * Walks simulated monsters along navigation paths on a real map and counts how many arrive, get stuck or wander off.
 *
 * Dev tool for `plans/monster-chase-navigation.md`, not wired into any npm script:
 *
 *   node --import tsx scripts/simulate-monster-chase.mts [map=e1m1] [trials=300] [seed=1]
 *
 * It loads the map's BSP from `data/id1/pak*.pak` and its mesh from `data/id1/maps/<map>.nav`, picks random pairs of graph
 * nodes, asks `Navigation.findPath` for a path, and steps a monster along it with the server's real `ServerMovement`
 * (`movestep`, `stepDirection`, `newChaseDir`) against world collision only: no other entities, no doors. Every steering
 * policy walks the same trials with the same random sequence, so the numbers compare policies, not luck.
 *
 * Environment switches: WALKABLE_ONLY=1 keeps paths without a drop or climb taller than a step between waypoints,
 * HULL_FIT=1 keeps paths each hull can sweep through, DROP_LINKS=exclude removes ledge links from the graph first,
 * SHOW_FAILURES=<policy name> lists where that policy failed on level segments.
 */

import fs from 'node:fs/promises';

import '../source/engine/common/Mod.ts';
import Vector from '../source/shared/Vector.ts';
import { flags, moveType, moveTypes, solid } from '../source/shared/Defs.ts';
import { BSP29Loader } from '../source/engine/common/model/loaders/BSP29Loader.ts';
import type { BrushModel } from '../source/engine/common/model/BSP.ts';
import { ServerCollision, type CollisionHost } from '../source/engine/server/physics/ServerCollision.ts';
import { ServerMovement } from '../source/engine/server/physics/ServerMovement.ts';
import { Navigation } from '../source/engine/server/Navigation.ts';
import type { ServerEdict } from '../source/engine/server/Edict.ts';
import type Server from '../source/engine/server/Server.ts';
import type { CollisionModelSource } from '../source/engine/server/physics/ServerCollisionSupport.ts';
import { createMockEdict, createMockEntity, type MockEntity } from '../test/support/fixtures.ts';
import { createModelLoadContext, createSilentConsole } from '../test/support/modelContext.ts';
import { createCvarStub } from '../test/support/cvarStub.ts';
import { EntityHulls } from '../source/engine/common/collision/EntityHulls.ts';

const DATA = new URL('../data/id1/', import.meta.url);

/**
 * Reads one file out of the id1 pak files.
 * @returns The file's bytes.
 */
async function readFromPaks(name: string): Promise<ArrayBuffer> {
  for (const pak of ['pak1.pak', 'pak0.pak']) {
    let data: Buffer;
    try {
      data = await fs.readFile(new URL(pak, DATA));
    } catch {
      continue;
    }

    const directoryOffset = data.readInt32LE(4);
    const directoryLength = data.readInt32LE(8);

    for (let offset = directoryOffset; offset < directoryOffset + directoryLength; offset += 64) {
      const entryName = data.toString('latin1', offset, offset + 56).replace(/\0.*$/su, '');
      if (entryName === name) {
        const position = data.readInt32LE(offset + 56);
        const length = data.readInt32LE(offset + 60);
        return data.buffer.slice(data.byteOffset + position, data.byteOffset + position + length) as ArrayBuffer;
      }
    }
  }

  throw new Error(`${name} not found in the pak files`);
}

/** The world, its collision and the movement code, without a server. */
interface World {
  readonly model: BrushModel;
  readonly collision: ServerCollision;
  readonly movement: ServerMovement;
  readonly navigation: Navigation;
}

/**
 * Loads a map and its navigation mesh.
 * @returns The world.
 */
async function loadWorld(mapname: string): Promise<World> {
  const bsp = await readFromPaks(`maps/${mapname}.bsp`);
  const model = await new BSP29Loader(createModelLoadContext()).load(bsp, `maps/${mapname}.bsp`) as BrushModel;

  const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP, movetype: moveType.MOVETYPE_PUSH, modelindex: 1 })) as unknown as ServerEdict;
  const modelSource = {
    getWorldEntity: () => worldEdict,
    getWorldModel: () => model,
    getModelByIndex: () => model,
  } as unknown as CollisionModelSource;
  // ServerCollision asks its host for the edict list (the world is edict 0) and for the area tree, which is empty here.
  const host = {
    server: { edicts: [worldEdict], time: 0 },
    con: createSilentConsole(),
    area: { tree: { queryAABB: () => [].values() }, hulls: new EntityHulls(modelSource) },
  } as unknown as CollisionHost;
  const collision = new ServerCollision(host, modelSource);

  // ServerMovement reaches collision and the area (to relink, a no-op here) through its server.
  const server = { collision, area: { linkEdict() {} } } as unknown as Server;
  const movement = new ServerMovement(server);

  Navigation.nav_enabled = createCvarStub(1);
  Navigation.nav_debug_path = createCvarStub(0);
  Navigation.nav_debug_graph = createCvarStub(0);
  Navigation.nav_debug_waypoints = createCvarStub(0);
  const navData = await fs.readFile(new URL(`maps/${mapname}.nav`, DATA));
  const navigation = new Navigation(null, {
    con: createSilentConsole(),
    files: { LoadFile: () => Promise.resolve(navData.buffer.slice(navData.byteOffset, navData.byteOffset + navData.byteLength) as ArrayBuffer) },
    sv: null,
  } as unknown as ConstructorParameters<typeof Navigation>[1]);
  await navigation.load(mapname, model.checksum);

  return { model, collision, movement, navigation };
}

/** A monster as the movement code sees it. */
type Walker = MockEntity & { ideal_yaw: number; yaw_speed: number; enemy: null; goalentity: { edict: ServerEdict } | null };

/** What a policy works with on one trial. */
interface Trial {
  readonly world: World;
  readonly edict: ServerEdict;
  readonly entity: Walker;
  readonly path: Vector[];
  /** Index of the waypoint the monster heads for. */
  index: number;
  /** Policy-owned memory between frames. */
  readonly memory: Record<string, number>;
}

/** A steering policy: one AI frame of a monster that follows `trial.path`. */
interface Policy {
  readonly name: string;
  frame(trial: Trial, dist: number): void;
}

/**
 * Yaw from one point to another, in degrees as the engine uses them.
 * @returns The yaw.
 */
function yawTo(from: Vector, to: Vector): number {
  return Vector.anglemod(Math.atan2(to[1] - from[1], to[0] - from[0]) * 180.0 / Math.PI);
}

/**
 * Distance on the XY plane.
 * @returns The distance.
 */
function flatDistance(a: Vector, b: Vector): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Whether the monster has reached a waypoint: close on the plane and roughly on its level.
 * @returns True when reached.
 */
function reached(origin: Vector, waypoint: Vector, radius: number): boolean {
  return flatDistance(origin, waypoint) < radius && Math.abs(origin[2] - waypoint[2]) < 48;
}

/**
 * The steering before plans/monster-chase-navigation.md Phase 1, kept as the baseline: QuakeC's chase (keep the heading
 * three times out of four) toward `path[0]`, a waypoint counts as reached within 45 units on the plane.
 */
const BEFORE: Policy = {
  name: 'before Phase 1 (QC 75/25, 45u)',
  frame(trial, dist) {
    if (trial.index < trial.path.length - 1 && flatDistance(trial.entity.origin, trial.path[trial.index]) < 32 * 1.41) {
      trial.index++;
    }

    const { movement } = trial.world;
    if (Math.random() >= 0.75 || !movement.stepDirection(trial.edict, trial.entity.ideal_yaw, dist)) {
      movement.newChaseDir(trial.edict, trial.path[trial.index], dist);
    }
  },
};

/**
 * Advances the waypoint index past every waypoint reached within 24 units. It never passes the last one, the goal: like
 * the game's chase after its path ran out, the monster keeps heading for it until it arrives.
 */
function advance(trial: Trial): void {
  while (trial.index < trial.path.length - 1 && reached(trial.entity.origin, trial.path[trial.index], 24)) {
    trial.index++;
  }
}

/** Aims at the waypoint every frame, QC's newChaseDir when blocked. */
const AIM: Policy = {
  name: 'aim, newChaseDir fallback',
  frame(trial, dist) {
    advance(trial);
    const { movement } = trial.world;
    const yaw = yawTo(trial.entity.origin, trial.path[trial.index]);
    if (!movement.stepDirection(trial.edict, yaw, dist)) {
      movement.newChaseDir(trial.edict, trial.path[trial.index], dist);
    }
  },
};

/** The engine's `moveToGoal` with the waypoint as its target (Phase 1), a waypoint reached within 24 units. */
const MOVE_TO_GOAL: Policy = {
  name: 'moveToGoal(target)',
  frame(trial, dist) {
    advance(trial);
    trial.world.movement.moveToGoal(trial.edict, dist, trial.path[trial.index]);
  },
};

/**
 * AIM, plus the plan's stuck detection: when the distance to the current waypoint hasn't shrunk by 8 units for a second
 * (10 AI frames), ask for a new path from where the monster stands.
 */
const AIM_REPLAN: Policy = {
  name: 'aim + replan when stuck',
  frame(trial, dist) {
    const { memory, path } = trial;
    const distance = trial.entity.origin.distanceTo(path[trial.index]);
    if (memory.best === undefined || distance < memory.best - 8) {
      memory.best = distance;
      memory.idle = 0;
    } else if (++memory.idle >= 10) {
      const fresh = trial.world.navigation.findPath(trial.entity.origin, path[path.length - 1]);
      if (fresh !== null && fresh.length >= 2) {
        path.splice(0, path.length, ...fresh);
        trial.index = 1;
      }
      memory.best = Infinity;
      memory.idle = 0;
    }
    AIM.frame(trial, dist);
  },
};

/**
 * Steps off a ledge toward a waypoint below: moves `dist` toward it without asking for ground, then falls to the floor
 * underneath, which is what gravity does to a monster that left the ground (`MOVETYPE_STEP`).
 * @returns True when the monster dropped.
 */
function dropToward(trial: Trial, waypoint: Vector, dist: number): boolean {
  const { entity, world, edict } = trial;
  if (waypoint[2] > entity.origin[2] - 18) {
    return false;
  }

  const radians = yawTo(entity.origin, waypoint) * Math.PI / 180.0;
  const ahead = entity.origin.copy();
  ahead[0] += Math.cos(radians) * dist;
  ahead[1] += Math.sin(radians) * dist;
  const across = world.collision.move(entity.origin, entity.mins, entity.maxs, ahead, moveTypes.MOVE_NORMAL, edict);
  if (across.startsolid || across.fraction < 1.0) {
    return false;
  }

  const below = ahead.copy();
  below[2] -= 512;
  const fall = world.collision.move(ahead, entity.mins, entity.maxs, below, moveTypes.MOVE_NORMAL, edict);
  if (fall.startsolid || fall.fraction === 1.0) {
    return false;
  }

  entity.origin = fall.endpos.copy();
  return true;
}

/** AIM, plus stepping off ledges toward a waypoint below, which the graph's drop links expect. */
const AIM_DROP: Policy = {
  name: 'aim + drop off ledges',
  frame(trial, dist) {
    advance(trial);
    const { movement } = trial.world;
    const waypoint = trial.path[trial.index];
    const yaw = yawTo(trial.entity.origin, waypoint);
    if (movement.stepDirection(trial.edict, yaw, dist)) {
      return;
    }
    if (dropToward(trial, waypoint, dist)) {
      return;
    }
    movement.newChaseDir(trial.edict, waypoint, dist);
  },
};

// Also tried on e1m1–e1m7 (2026-11-10): skipping waypoints already passed, and sliding along the wall that blocks a step.
// Neither changed arrivals measurably over AIM, see plans/monster-chase-navigation.md.
const POLICIES: Policy[] = [BEFORE, AIM, MOVE_TO_GOAL, AIM_REPLAN, AIM_DROP];

/**
 * A small seeded random generator (mulberry32), so every policy sees the same sequence.
 * @returns The generator.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How one trial ended. */
interface Outcome {
  readonly result: 'arrived' | 'stuck' | 'timeout';
  readonly frames: number;
  readonly frozenFrames: number;
  readonly where: Vector;
  readonly waypoint: Vector | null;
  readonly previousWaypoint: Vector | null;
}

/**
 * Walks one monster along one path with one policy.
 * @returns How it ended.
 */
function walk(world: World, policy: Policy, sharedPath: Vector[], hull: [Vector, Vector], speeds: number[], seed: number): Outcome {
  Math.random = seededRandom(seed);
  const path = sharedPath.map((point) => point.copy());
  const entity = createMockEntity({ origin: path[0].copy(), mins: hull[0], maxs: hull[1], flagsValue: flags.FL_ONGROUND }) as Walker;
  entity.yaw_speed = 20;
  entity.enemy = null;
  // moveToGoal needs a goal entity, the end of the path; it has no enemy, so it never stops for being close enough
  entity.goalentity = { edict: createMockEdict(createMockEntity({ origin: path[path.length - 1].copy() })) as unknown as ServerEdict };
  entity.ideal_yaw = yawTo(path[0], path[path.length - 1]);
  entity.angles = new Vector(0, entity.ideal_yaw, 0);
  const edict = createMockEdict(entity) as unknown as ServerEdict;
  const trial: Trial = { world, edict, entity, path, index: 1, memory: {} };

  let pathLength = 0;
  for (let i = 1; i < path.length; i++) {
    pathLength += path[i].distanceTo(path[i - 1]);
  }
  const averageSpeed = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
  const budget = Math.ceil(pathLength / averageSpeed * 3) + 40;
  const history: Vector[] = [];
  let frozenFrames = 0;

  for (let frame = 0; frame < budget; frame++) {
    const goal = path[path.length - 1];
    if (reached(entity.origin, goal, 32)) {
      return { result: 'arrived', frames: frame, frozenFrames, where: entity.origin.copy(), waypoint: null, previousWaypoint: null };
    }

    const before = entity.origin.copy();
    policy.frame(trial, speeds[frame % speeds.length]);
    trial.index = Math.min(trial.index, path.length - 1);
    if (before.distanceTo(entity.origin) < 0.5) {
      frozenFrames++;
    }

    history.push(entity.origin.copy());
    // two seconds of AI frames without getting 16 units anywhere is stuck
    if (history.length > 20 && history[history.length - 21].distanceTo(entity.origin) < 16) {
      return { result: 'stuck', frames: frame, frozenFrames, where: entity.origin.copy(), waypoint: path[trial.index], previousWaypoint: path[trial.index - 1] ?? null };
    }
  }

  return { result: 'timeout', frames: budget, frozenFrames, where: entity.origin.copy(), waypoint: path[trial.index], previousWaypoint: path[trial.index - 1] ?? null };
}

/**
 * Picks trial paths: random node pairs some distance apart that the graph connects.
 * @returns The paths.
 */
function pickPaths(world: World, count: number, seed: number): Vector[][] {
  const random = seededRandom(seed);
  const nodes = world.navigation.graph.nodes;
  const paths: Vector[][] = [];
  let attempts = 0;
  while (paths.length < count && attempts < count * 50) {
    attempts++;
    const start = nodes[Math.floor(random() * nodes.length)];
    const goal = nodes[Math.floor(random() * nodes.length)];
    const straight = start.origin.distanceTo(goal.origin);
    if (straight < 256 || straight > 1500) {
      continue;
    }
    const path = world.navigation.findPath(start.origin, goal.origin);
    if (path !== null && path.length >= 3) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Whether a hull can sweep along every segment of a path, a step up so stairs don't count as walls.
 * @returns True when every segment is clear.
 */
function pathFitsHull(world: World, path: Vector[], hull: [Vector, Vector]): boolean {
  const probe = createMockEntity({ mins: hull[0], maxs: hull[1] });
  const edict = createMockEdict(probe) as unknown as ServerEdict;
  for (let i = 1; i < path.length; i++) {
    const top = Math.max(path[i][2], path[i - 1][2]) + 18;
    const start = path[i - 1].copy();
    const end = path[i].copy();
    start[2] = top;
    end[2] = top;
    const trace = world.collision.move(start, hull[0], hull[1], end, moveTypes.MOVE_NORMAL, edict);
    if (trace.startsolid || trace.fraction < 1.0) {
      return false;
    }
  }
  return true;
}

/**
 * Removes every link along which the floor drops by more than a step somewhere, sampled every 8 units like the builder.
 * @returns How many links were removed.
 */
function removeLedgeLinks(world: World): number {
  const nodes = world.navigation.graph.nodes;
  const probe = createMockEntity({ mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 40) });
  const edict = createMockEdict(probe) as unknown as ServerEdict;
  let removed = 0;
  for (const node of nodes) {
    const kept = node.neighbors.filter(([id]) => {
      const to = nodes[id].origin;
      if (to[2] > node.origin[2] - 18) {
        return true;
      }
      const length = flatDistance(node.origin, to);
      let previousZ = node.origin[2];
      for (let travelled = 8; travelled <= length; travelled += 8) {
        const t = travelled / length;
        const sample = new Vector(node.origin[0] + (to[0] - node.origin[0]) * t, node.origin[1] + (to[1] - node.origin[1]) * t, previousZ + 18);
        const below = sample.copy();
        below[2] = previousZ - 256;
        const trace = world.collision.move(sample, probe.mins, probe.maxs, below, moveTypes.MOVE_NORMAL, edict);
        if (trace.fraction === 1.0 || trace.endpos[2] < previousZ - 18) {
          return false;
        }
        previousZ = trace.endpos[2];
      }
      return to[2] >= previousZ - 18;
    });
    removed += node.neighbors.length - kept.length;
    node.neighbors.splice(0, node.neighbors.length, ...kept);
  }
  return removed;
}

/**
 * Sorts a failure by the path segment it happened on: a drop or climb taller than a step can't be walked by `movestep` at
 * all (no steering fixes it), a flat one is where steering failed.
 * @returns The kind of segment.
 */
function segmentKind(outcome: Outcome): 'drop' | 'climb' | 'flat' {
  if (outcome.waypoint === null || outcome.previousWaypoint === null) {
    return 'flat';
  }
  const dz = outcome.waypoint[2] - outcome.previousWaypoint[2];
  if (dz < -24) {
    return 'drop';
  }
  if (dz > 24) {
    return 'climb';
  }
  return 'flat';
}

const [mapname = 'e1m1', trialArgument = '300', seedArgument = '1'] = process.argv.slice(2);
const world = await loadWorld(mapname);
// DROP_LINKS=exclude removes the links that step off a ledge taller than a step, previewing paths that avoid drops
if (process.env.DROP_LINKS === 'exclude') {
  const removed = removeLedgeLinks(world);
  console.log(`removed ${removed} ledge links`);
}
const allPaths = pickPaths(world, Number(trialArgument), Number(seedArgument));
// WALKABLE_ONLY=1 keeps only the paths without a drop or climb taller than a step between waypoints, the ones steering alone can finish
const paths = process.env.WALKABLE_ONLY === '1'
  ? allPaths.filter((path) => path.every((point, i) => i === 0 || Math.abs(point[2] - path[i - 1][2]) <= 24))
  : allPaths;
const originalRandom = Math.random;

const MONSTERS: { name: string; hull: [Vector, Vector]; speeds: number[] }[] = [
  // knight run speeds (knight.qc), Quake hull 1
  { name: 'small (knight)', hull: [new Vector(-16, -16, -24), new Vector(16, 16, 40)], speeds: [16, 20, 13, 7, 16, 20, 14, 6] },
  // ogre run speeds (ogre.qc), Quake hull 2
  { name: 'large (ogre)', hull: [new Vector(-32, -32, -24), new Vector(32, 32, 64)], speeds: [9, 12, 8, 22, 16, 4, 13, 24] },
];

console.log(`${mapname}: ${world.navigation.graph.nodes.length} nodes, ${paths.length} paths`);

for (const monster of MONSTERS) {
  // trials whose start already is in solid for this hull say nothing about steering
  const usable = paths.filter((path) => {
    const probe = createMockEntity({ origin: path[0].copy(), mins: monster.hull[0], maxs: monster.hull[1] });
    const edict = createMockEdict(probe) as unknown as ServerEdict;
    return !world.collision.move(probe.origin, probe.mins, probe.maxs, probe.origin, moveTypes.MOVE_NORMAL, edict).startsolid;
  });
  // HULL_FIT=1 also drops paths with a segment this hull can't sweep through, previewing paths built for the hull (plan Phase 4)
  if (process.env.HULL_FIT === '1') {
    const fitting = usable.filter((path) => pathFitsHull(world, path, monster.hull));
    usable.splice(0, usable.length, ...fitting);
  }
  console.log(`\n${monster.name}: ${usable.length} of ${paths.length} paths fit the hull`);

  for (const policy of POLICIES) {
    const counts = { arrived: 0, stuck: 0, timeout: 0 };
    const kinds = { drop: 0, climb: 0, flat: 0 };
    let frames = 0;
    let frozen = 0;
    const failures: Outcome[] = [];
    usable.forEach((path, i) => {
      const outcome = walk(world, policy, path, monster.hull, monster.speeds, 1000 + i);
      counts[outcome.result]++;
      frames += outcome.frames;
      frozen += outcome.frozenFrames;
      if (outcome.result !== 'arrived') {
        failures.push(outcome);
        kinds[segmentKind(outcome)]++;
      }
    });
    Math.random = originalRandom;
    const percent = (value: number): string => `${(100 * value / usable.length).toFixed(1)}%`.padStart(6);
    console.log(`  ${policy.name.padEnd(36)} arrived ${percent(counts.arrived)}  stuck ${percent(counts.stuck)}  timeout ${percent(counts.timeout)}  frames ${String(frames).padStart(7)}  frozen ${(100 * frozen / Math.max(frames, 1)).toFixed(1)}%  failed on drop ${percent(kinds.drop)} climb ${percent(kinds.climb)} flat ${percent(kinds.flat)}`);
    if (process.env.SHOW_FAILURES === policy.name) {
      for (const failure of failures.filter((candidate) => segmentKind(candidate) === 'flat')) {
        const dz = failure.waypoint && failure.previousWaypoint ? (failure.waypoint[2] - failure.previousWaypoint[2]).toFixed(0) : '?';
        console.log(`    ${failure.result} at ${failure.where.toString()} heading for ${failure.waypoint?.toString()} (segment dz ${dz})`);
      }
    }
  }
}
