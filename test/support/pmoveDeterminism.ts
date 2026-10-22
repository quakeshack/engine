/**
 * Worlds, scenarios and command scripts for the client/server movement determinism tests
 * (`test/physics/pmove-determinism.test.ts`).
 *
 * Everything here is plain code on the engine's own classes, with no `node:` import and no `Math.random`, so the
 * same scenarios can run in a browser (see `plans/track-e-collision-and-movement.md`, Phase 0b) and a hash of what
 * they produce can be compared across JavaScript engines.
 */

import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { BrushModel } from '../../source/engine/common/Mod.ts';
import { MoveVars, Pmove, PmovePlayer } from '../../source/engine/common/Pmove.ts';
import { UserCmd } from '../../source/engine/network/Protocol.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { createRoomHull } from './hulls.ts';
import { setBspTree } from './bspTree.ts';

/** The plane shape the brush model carries. */
type ModelPlane = BrushModel['planes'][number];

/** A plane of a convex brush, the solid side being behind it. */
interface BrushPlane {
  readonly normal: readonly [number, number, number];
  readonly dist: number;
}

/** Entity number of the box entity in the scenarios. */
export const BOX_ENTITY_NUM = 2;

/** Entity number of the door (a brush submodel) in the scenarios. */
export const DOOR_ENTITY_NUM = 3;

/** Where the world's water starts: everything with an x below this is water. */
const WATER_EDGE_X = -600;

/**
 * A deterministic pseudo-random generator (mulberry32), so a failing run can be repeated from its seed.
 * @returns A function returning numbers in [0, 1).
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds an empty brush model that the brush helpers below add to.
 * @returns A brush model with brush data arrays and no brushes yet.
 */
function createEmptyBrushModel(name: string, submodel: boolean): BrushModel {
  const model = new BrushModel(name);

  model.submodel = submodel;
  model.firstBrush = 0;
  model.numBrushes = 0;
  model.planes = [];
  model.brushsides = [];
  model.brushes = [];
  model.leafbrushes = [];
  model.hulls = [];

  return model;
}

/**
 * Adds a convex brush, given as the planes that bound it, to a world model.
 */
function addConvexBrush(model: BrushModel, planes: readonly BrushPlane[], mins: Vector, maxs: Vector): void {
  const firstSide = model.brushsides!.length;

  for (const { normal, dist } of planes) {
    const nonZero = normal.filter((component) => component !== 0).length;
    const axis = normal.findIndex((component) => component !== 0);
    const type = nonZero === 1 && Math.abs(normal[axis]) === 1 ? axis : 3;

    model.planes.push({ normal: new Vector(...normal), dist, type, signbits: 0 } as unknown as ModelPlane);
    model.brushsides!.push({ planenum: model.planes.length - 1, texinfo: 0 } as unknown as BrushModel['brushsides'] extends Array<infer T> | null ? T : never);
  }

  model.brushes!.push({
    firstside: firstSide,
    numsides: planes.length,
    contents: content.CONTENT_SOLID,
    mins,
    maxs,
    _brushTraceCheck: 0,
  } as unknown as BrushModel['brushes'] extends Array<infer T> | null ? T : never);
}

/**
 * Adds an axis-aligned box brush.
 */
function addBox(model: BrushModel, center: readonly [number, number, number], half: readonly [number, number, number]): void {
  addConvexBrush(model, [
    { normal: [1, 0, 0], dist: center[0] + half[0] },
    { normal: [-1, 0, 0], dist: half[0] - center[0] },
    { normal: [0, 1, 0], dist: center[1] + half[1] },
    { normal: [0, -1, 0], dist: half[1] - center[1] },
    { normal: [0, 0, 1], dist: center[2] + half[2] },
    { normal: [0, 0, -1], dist: half[2] - center[2] },
  ], new Vector(center[0] - half[0], center[1] - half[1], center[2] - half[2]), new Vector(center[0] + half[0], center[1] + half[1], center[2] + half[2]));
}

/**
 * Adds a ramp rising along y: the top plane passes through the height 0 line at `startY`, and the brush ends in a wall at `endY`.
 * @param direction +1 rises towards +y, -1 towards -y.
 */
function addRamp(model: BrushModel, startY: number, endY: number, degrees: number, direction: 1 | -1): void {
  const sin = Math.sin(degrees * Math.PI / 180);
  const cos = Math.cos(degrees * Math.PI / 180);
  const rise = Math.abs(endY - startY) * Math.tan(degrees * Math.PI / 180);
  // the top plane: z = (y - startY) * tan, written as n . p = d with n pointing up and away from the slope
  const normal: [number, number, number] = [0, -sin * direction, cos];

  addConvexBrush(model, [
    { normal, dist: normal[1] * startY },
    { normal: [0, 0, -1], dist: 32 },
    { normal: [0, direction, 0], dist: direction * endY },
    { normal: [0, -direction, 0], dist: -direction * startY },
    { normal: [1, 0, 0], dist: 300 },
    { normal: [-1, 0, 0], dist: 300 },
  ], new Vector(-300, Math.min(startY, endY), -32), new Vector(300, Math.max(startY, endY), rise));
}

/**
 * Adds a slab, a wall that is not aligned with an axis.
 */
function addSlab(model: BrushModel, center: readonly [number, number], yawDegrees: number, length: number, thickness: number): void {
  const yaw = yawDegrees * Math.PI / 180;
  const along: [number, number, number] = [Math.cos(yaw), Math.sin(yaw), 0];
  const across: [number, number, number] = [-Math.sin(yaw), Math.cos(yaw), 0];
  const dot = (normal: readonly number[]): number => normal[0] * center[0] + normal[1] * center[1];
  const reach = length / 2 + thickness / 2;

  addConvexBrush(model, [
    { normal: along, dist: dot(along) + length / 2 },
    { normal: [-along[0], -along[1], 0], dist: -dot(along) + length / 2 },
    { normal: across, dist: dot(across) + thickness / 2 },
    { normal: [-across[0], -across[1], 0], dist: -dot(across) + thickness / 2 },
    { normal: [0, 0, 1], dist: 128 },
    { normal: [0, 0, -1], dist: 16 },
  ], new Vector(center[0] - reach, center[1] - reach, -16), new Vector(center[0] + reach, center[1] + reach, 128));
}

/**
 * Builds the world every scenario runs in. Each call builds a new model, like a client and a server each loading their own.
 *
 * The floor's top is at z = 0, so a standing player's origin is at z = 24. From the origin:
 * a short flight of steps and a platform to the east (+x), a 30 degree ramp to the north (+y) and a 60 degree ramp
 * (not walkable) to the south, a wall at x = 900, two slabs meeting at an acute angle around y = 900, and a pool to
 * the west (x below -600) with a low wall inside it.
 * @returns A world model with brush data.
 */
export function createDeterminismWorld(): BrushModel {
  const model = createEmptyBrushModel('determinism-world', false);

  addBox(model, [0, 0, -16], [1024, 1024, 16]);

  for (let step = 0; step < 6; step++) {
    const top = 8 * (step + 1);

    addBox(model, [216 + 32 * step, 0, (top - 16) / 2], [16, 64, (top + 16) / 2]);
  }

  addBox(model, [456, 0, (48 - 16) / 2], [64, 64, (48 + 16) / 2]);
  addRamp(model, 300, 500, 30, 1);
  addRamp(model, -300, -500, 60, -1);
  addBox(model, [916, 0, 96], [16, 1024, 128]);

  // the apex at (0, 900), the arms opening towards -y with 60 degrees between them
  addSlab(model, [-75, 900 + 150 * Math.sin(240 * Math.PI / 180)], 240, 300, 16);
  addSlab(model, [75, 900 + 150 * Math.sin(300 * Math.PI / 180)], 300, 300, 16);

  addBox(model, [-916, 0, 12], [16, 512, 28]);

  const brushCount = model.brushes!.length;
  const allBrushes = Array.from({ length: brushCount }, (_unused, index) => index);
  const roomMins = new Vector(-2048, -2048, -2048);
  const roomMaxs = new Vector(2048, 2048, 2048);

  model.numBrushes = brushCount;
  model.leafbrushes = [...allBrushes, ...allBrushes];
  model.planes.push({ normal: new Vector(1, 0, 0), dist: WATER_EDGE_X, type: 0, signbits: 0 } as unknown as ModelPlane);
  setBspTree(
    model,
    [{ planeNum: model.planes.length - 1, children: [~0, ~1] }],
    [
      { contents: content.CONTENT_EMPTY, firstLeafBrush: 0, numLeafBrushes: brushCount },
      { contents: content.CONTENT_WATER, firstLeafBrush: brushCount, numLeafBrushes: brushCount },
    ],
  );
  model.hulls = [
    createRoomHull(roomMins, roomMaxs),
    createRoomHull(roomMins, roomMaxs),
    createRoomHull(roomMins, roomMaxs),
  ] as unknown as BrushModel['hulls'];

  return model;
}

/**
 * Builds the brush model of the door: a slab of 64 by 8 by 128 around its own origin.
 * @returns A brush submodel.
 */
export function createDoorModel(): BrushModel {
  const model = createEmptyBrushModel('*1', true);

  addBox(model, [0, 0, 0], [32, 4, 64]);
  model.numBrushes = 1;

  return model;
}

/** The state of the two solid entities other than the player in a step. */
export interface EntityPlacement {
  readonly boxOrigin: Vector;
  readonly doorOrigin: Vector;
}

/** One command of a script, before it is turned into a `UserCmd`. */
export interface CommandSpec {
  readonly msec: number;
  readonly forwardmove: number;
  readonly sidemove: number;
  readonly upmove: number;
  readonly yaw: number;
  readonly pitch: number;
}

/** What a scenario starts from and how it moves. */
export interface Scenario {
  readonly name: string;
  readonly origin: readonly [number, number, number];
  readonly yaw: number;
  readonly pmType?: 'normal' | 'noclip' | 'dead';
  /** The commands of the scripted run. */
  script(msec: number): CommandSpec[];
  /** Where the entities are at a step. */
  placement(step: number): EntityPlacement;
}

const STATIC_PLACEMENT: EntityPlacement = {
  boxOrigin: new Vector(100, -60, 24),
  doorOrigin: new Vector(0, 150, 64),
};

/**
 * Builds a script from segments of (steps, forward, side, up, yaw turn per step).
 * @returns The commands.
 */
function segments(msec: number, startYaw: number, parts: ReadonlyArray<readonly [number, number, number, number, number]>): CommandSpec[] {
  const commands: CommandSpec[] = [];
  let yaw = startYaw;

  for (const [steps, forwardmove, sidemove, upmove, turn] of parts) {
    for (let step = 0; step < steps; step++) {
      yaw += turn;
      commands.push({ msec, forwardmove, sidemove, upmove, yaw, pitch: 0 });
    }
  }

  return commands;
}

/** The scenarios, one per kind of surface or state the movement code has a branch for. */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'flat floor: accelerate, strafe, stop',
    origin: [0, 0, 24], yaw: 0,
    script: (msec) => segments(msec, 0, [[20, 320, 0, 0, 0], [15, 160, 160, 0, 0], [15, 0, 0, 0, 0], [10, -320, 0, 0, 3]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'jump and land, air control',
    origin: [0, 0, 24], yaw: 0,
    script: (msec) => segments(msec, 0, [[10, 320, 0, 0, 0], [3, 320, 0, 200, 0], [30, 320, 160, 0, 4], [20, 0, 0, 0, 0]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'stairs up and down',
    origin: [150, 0, 24], yaw: 0,
    script: (msec) => segments(msec, 0, [[30, 320, 0, 0, 0], [8, 0, 0, 0, 0], [40, 320, 0, 0, 4.5]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'walkable and steep slopes',
    origin: [0, 250, 24], yaw: 90,
    script: (msec) => segments(msec, 90, [[40, 320, 0, 0, 0], [10, 0, 0, 0, 0], [60, 320, 0, 0, 3], [40, 320, 0, 0, 0]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'wall slide',
    origin: [800, 0, 24], yaw: 0,
    script: (msec) => segments(msec, 30, [[40, 320, 0, 0, 0], [30, 320, 160, 0, 0], [30, 320, 0, 0, 5]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'acute corner',
    origin: [0, 650, 24], yaw: 90,
    script: (msec) => segments(msec, 90, [[50, 320, 0, 0, 0], [30, 320, 320, 0, 0], [30, 320, -320, 0, 1], [20, 0, 0, 0, 0]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'water entry, swimming and water jump',
    origin: [-500, 0, 24], yaw: 180,
    script: (msec) => segments(msec, 180, [[30, 320, 0, 0, 0], [20, 320, 0, 200, 0], [40, 320, 0, 200, 0], [20, 0, 0, 0, 0], [30, 320, 160, 200, 3]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'door moving across the path, box entity',
    origin: [0, 60, 24], yaw: 90,
    script: (msec) => segments(msec, 90, [[40, 320, 0, 0, 0], [20, 160, 160, 0, 0], [40, 320, 0, 0, 2]]),
    placement: (step) => ({
      boxOrigin: new Vector(0, 140, 24),
      doorOrigin: new Vector(-80 + (step % 40) * 4, 110 + Math.floor(step / 40) * 8, 64),
    }),
  },
  {
    name: 'noclip',
    origin: [0, 0, 100], yaw: 0, pmType: 'noclip',
    script: (msec) => segments(msec, 0, [[20, 320, 0, 0, 0], [20, 320, 0, 200, 5], [20, 0, 320, -200, 0]]),
    placement: () => STATIC_PLACEMENT,
  },
  {
    name: 'dead',
    origin: [0, 0, 80], yaw: 0, pmType: 'dead',
    script: (msec) => segments(msec, 0, [[30, 320, 0, 200, 0], [20, 0, 0, 0, 0]]),
    placement: () => STATIC_PLACEMENT,
  },
];

/** The command durations the scripted runs use, in milliseconds. */
export const SCRIPT_MSEC: readonly number[] = [8, 16, 33, 50];

/**
 * Makes a random command script from a seed.
 * @returns The commands.
 */
export function randomScript(seed: number, steps: number, msecChoices: readonly number[]): CommandSpec[] {
  const random = createRandom(seed);
  const pick = <T>(choices: readonly T[]): T => choices[Math.floor(random() * choices.length)]!;
  const commands: CommandSpec[] = [];
  let yaw = random() * 360;

  for (let step = 0; step < steps; step++) {
    yaw = (yaw + (random() - 0.5) * 40 + 360) % 360;
    commands.push({
      msec: pick(msecChoices),
      forwardmove: pick([-320, 0, 160, 320, 320]),
      sidemove: pick([-320, -160, 0, 0, 160, 320]),
      upmove: pick([0, 0, 0, 200, -200]),
      yaw,
      pitch: random() < 0.1 ? (random() - 0.5) * 160 : 0,
    });
  }

  return commands;
}

/**
 * Turns a command spec into a `UserCmd`, with the angles the way the wire carries them: wrapped to 0 to 360.
 * @returns The command.
 */
export function toUserCmd(spec: CommandSpec): UserCmd {
  const cmd = new UserCmd();

  cmd.msec = spec.msec;
  cmd.forwardmove = spec.forwardmove;
  cmd.sidemove = spec.sidemove;
  cmd.upmove = spec.upmove;
  cmd.angles.setTo((spec.pitch + 360) % 360, (spec.yaw + 360) % 360, 0);

  return cmd;
}

/**
 * The movement variables both sides of a test use, so that the variables are not what differs.
 * @returns Movement variables with their defaults, which are what the server's cvars start with.
 */
export function createMoveVars(): MoveVars {
  return new MoveVars();
}

/**
 * Puts the entities of a placement into a `Pmove`, the way both callers do for every command: clear, then add.
 */
export function placeEntities(pmove: Pmove, placement: EntityPlacement, doorModel: BrushModel): void {
  const box = new ClientEdict(BOX_ENTITY_NUM);
  const door = new ClientEdict(DOOR_ENTITY_NUM);

  box.origin.set(placement.boxOrigin);
  box.mins.setTo(-16, -16, -24);
  box.maxs.setTo(16, 16, 32);
  box.angles.clear();
  door.origin.set(placement.doorOrigin);
  door.angles.clear();

  pmove.clearEntities();
  pmove.addEntity(box);
  pmove.addEntity(door, doorModel);
}

/** What a step leaves behind that the two sides are compared on. */
export interface StepState {
  readonly origin: readonly number[];
  readonly velocity: readonly number[];
  readonly onground: boolean;
  readonly pmFlags: number;
  readonly pmTime: number;
  readonly oldbuttons: number;
  readonly waterlevel: number;
  readonly watertype: number;
  readonly waterjumptime: number;
}

/**
 * Reads the compared state of a player.
 * @returns The state, with vectors copied out.
 */
export function readState(player: PmovePlayer): StepState {
  return {
    origin: [...player.origin],
    velocity: [...player.velocity],
    onground: player.onground !== null,
    pmFlags: player.pmFlags,
    pmTime: player.pmTime,
    oldbuttons: player.oldbuttons,
    waterlevel: player.waterlevel,
    watertype: player.watertype,
    waterjumptime: player.waterjumptime,
  };
}

/**
 * Names the first field in which two states differ, bit for bit.
 * @returns A description of the difference, or null when the states are identical.
 */
export function describeDifference(left: StepState, right: StepState): string | null {
  for (const key of ['origin', 'velocity'] as const) {
    for (let axis = 0; axis < 3; axis++) {
      if (!Object.is(left[key][axis], right[key][axis])) {
        return `${key}[${axis}]: ${left[key][axis]} against ${right[key][axis]}`;
      }
    }
  }

  for (const key of ['onground', 'pmFlags', 'pmTime', 'oldbuttons', 'waterlevel', 'watertype', 'waterjumptime'] as const) {
    if (!Object.is(left[key], right[key])) {
      return `${key}: ${left[key]} against ${right[key]}`;
    }
  }

  return null;
}

/**
 * Folds the states of a run into one 32-bit number (FNV-1a over the bytes of every value), for comparing runs across processes and engines.
 * @returns The hash.
 */
export function hashStates(states: readonly StepState[]): number {
  const scratch = new DataView(new ArrayBuffer(8));
  let hash = 0x811C9DC5;

  const mix = (value: number): void => {
    scratch.setFloat64(0, value);

    for (let index = 0; index < 8; index++) {
      hash = Math.imul(hash ^ scratch.getUint8(index), 0x01000193) >>> 0;
    }
  };

  for (const state of states) {
    [...state.origin, ...state.velocity, state.onground ? 1 : 0, state.pmFlags, state.pmTime, state.oldbuttons, state.waterlevel, state.watertype, state.waterjumptime].forEach(mix);
  }

  return hash;
}
