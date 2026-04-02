import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { content, flags, moveType, solid } from '../../source/shared/Defs.ts';
import { Brush, BrushModel, BrushSide } from '../../source/engine/common/model/BSP.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import { ClientEdict } from '../../source/engine/client/ClientEntities.mjs';
import { ServerPhysics } from '../../source/engine/server/physics/ServerPhysics.mjs';

// ── Typedefs ────────────────────────────────────────────────────────────────

/**
 * @typedef MockEntity
 * @property {Vector} origin
 * @property {Vector} mins
 * @property {Vector} maxs
 * @property {Vector} velocity
 * @property {Vector} avelocity
 * @property {Vector} angles
 * @property {number} modelindex
 * @property {number} movetype
 * @property {number} solid
 * @property {number} flags
 * @property {object|null} groundentity
 * @property {number} ltime
 * @property {object|null} owner
 * @property {Function|null} blocked
 * @property {Function|null} touch
 * @property {Function} think
 * @property {number} nextthink
 * @property {number} num
 * @property {Vector} size
 * @property {Vector} absmin
 * @property {Vector} absmax
 * @property {(other: object) => boolean} equals
 */

/**
 * @typedef MockEdict
 * @property {MockEntity} entity
 * @property {number} num
 * @property {() => boolean} isFree
 * @property {() => boolean} isClient
 * @property {(other: object) => boolean} equals
 */

/**
 * @typedef MockRegistryConfig
 * @property {typeof import('../../source/engine/common/Com.mjs').default | null} [COM]
 * @property {object|null} [CL]
 * @property {{ Print: Function, DPrint: Function }} Con
 * @property {{ frametime: number }} Host
 * @property {object} SV
 */

// ── Plane & Model Fixtures ─────────────────────────────────────────────────

/**
 * Build a minimal axis plane for brush collision fixtures.
 * @param {number[]} normalComponents plane normal components
 * @param {number} dist plane distance from origin
 * @param {number} type axial plane type
 * @returns {{normal: Vector, dist: number, type: number, signbits: 0}} plane fixture
 */
export function createAxisPlane(normalComponents, dist, type) {
  return {
    normal: new Vector(...normalComponents),
    dist,
    type,
    signbits: 0,
  };
}

/**
 * Build a minimal solid box brush model for trace and position tests.
 * @param {{center?: number[], halfExtents: number[], name?: string, submodel?: boolean}} options fixture options
 * @returns {BrushModel} brush model fixture
 */
export function createBoxBrushModel({ center = [0, 0, 0], halfExtents, name = '*test', submodel = true }) {
  const model = new BrushModel();
  model.name = name;
  model.submodel = submodel;
  model.firstBrush = 0;
  model.numBrushes = 1;
  model.leafbrushes = [];
  model.hulls = [];

  const [centerX, centerY, centerZ] = center;

  model.planes = [
    createAxisPlane([1, 0, 0], centerX + halfExtents[0], 0),
    createAxisPlane([-1, 0, 0], halfExtents[0] - centerX, 0),
    createAxisPlane([0, 1, 0], centerY + halfExtents[1], 1),
    createAxisPlane([0, -1, 0], halfExtents[1] - centerY, 1),
    createAxisPlane([0, 0, 1], centerZ + halfExtents[2], 2),
    createAxisPlane([0, 0, -1], halfExtents[2] - centerZ, 2),
  ];

  model.brushsides = model.planes.map((plane, index) => {
    const side = new BrushSide(model);
    side.planenum = index;
    side.texinfo = 0;
    return side;
  });

  const brush = new Brush(model);
  brush.firstside = 0;
  brush.numsides = 6;
  brush.contents = content.CONTENT_SOLID;
  brush.mins = new Vector(centerX - halfExtents[0], centerY - halfExtents[1], centerZ - halfExtents[2]);
  brush.maxs = new Vector(centerX + halfExtents[0], centerY + halfExtents[1], centerZ + halfExtents[2]);
  brush._brushTraceCheck = 0;
  model.brushes = [brush];

  return model;
}

/**
 * Build a room hull whose interior is empty and whose exterior is solid.
 * @param {Vector} mins room mins
 * @param {Vector} maxs room maxs
 * @returns {{clip_mins: Vector, clip_maxs: Vector, firstclipnode: number, lastclipnode: number, clipnodes: {planenum: number, children: number[]}[], planes: {normal: Vector, dist: number, type: number, signbits: 0}[]}} model hull fixture
 */
export function createRoomHullFromBounds(mins, maxs) {
  const planes = /** @type {{normal: Vector, dist: number, type: number, signbits: 0}[]} */ ([
    createAxisPlane([1, 0, 0], maxs[0], 0),
    createAxisPlane([1, 0, 0], mins[0], 0),
    createAxisPlane([0, 1, 0], maxs[1], 1),
    createAxisPlane([0, 1, 0], mins[1], 1),
    createAxisPlane([0, 0, 1], maxs[2], 2),
    createAxisPlane([0, 0, 1], mins[2], 2),
  ]);

  return {
    clip_mins: mins.copy(),
    clip_maxs: maxs.copy(),
    firstclipnode: 0,
    lastclipnode: 5,
    clipnodes: [
      { planenum: 0, children: [content.CONTENT_SOLID, 1] },
      { planenum: 1, children: [2, content.CONTENT_SOLID] },
      { planenum: 2, children: [content.CONTENT_SOLID, 3] },
      { planenum: 3, children: [4, content.CONTENT_SOLID] },
      { planenum: 4, children: [content.CONTENT_SOLID, 5] },
      { planenum: 5, children: [content.CONTENT_EMPTY, content.CONTENT_SOLID] },
    ],
    planes,
  };
}

/**
 * Build a minimal brush-list world model that traverses a BSP node and leaf brushes.
 * @param {{axis?: 0|1|2, center?: number[], halfExtents: number[]}} options fixture options
 * @returns {BrushModel} world brush model fixture
 */
export function createBrushWorldModel({ axis = 0, center = [64, 0, 0], halfExtents }) {
  const model = createBoxBrushModel({ center, halfExtents, name: 'test-brush-world', submodel: false });
  const axisNormal = [0, 0, 0];
  axisNormal[axis] = 1;
  const roomMins = new Vector(-2048, -2048, -2048);
  const roomMaxs = new Vector(2048, 2048, 2048);
  const frontLeaf = /** @type {import('../../source/engine/common/model/BSP.mjs').Node} */ ({
    contents: content.CONTENT_EMPTY,
    firstleafbrush: 0,
    numleafbrushes: 1,
  });
  const backLeaf = /** @type {import('../../source/engine/common/model/BSP.mjs').Node} */ ({
    contents: content.CONTENT_EMPTY,
    firstleafbrush: 1,
    numleafbrushes: 0,
  });

  model.nodes = /** @type {import('../../source/engine/common/model/BSP.mjs').Node[]} */ ([{
    contents: 0,
    plane: createAxisPlane(axisNormal, 0, axis),
    children: [frontLeaf, backLeaf],
  }]);
  model.leafs = /** @type {import('../../source/engine/common/model/BSP.mjs').Node[]} */ ([frontLeaf, backLeaf]);
  model.leafbrushes = [0];
  model.hulls = /** @type {BrushModel['hulls']} */ ([
    createRoomHullFromBounds(roomMins, roomMaxs),
    createRoomHullFromBounds(roomMins, roomMaxs),
    createRoomHullFromBounds(roomMins, roomMaxs),
  ]);

  return model;
}

/**
 * Build a legacy hull-only world model for Pmove smoke tests.
 * @param {Vector} mins room mins
 * @param {Vector} maxs room maxs
 * @returns {BrushModel} world model fixture
 */
export function createLegacyWorldModel(mins, maxs) {
  const model = new BrushModel();
  model.name = 'test-world';
  model.hulls = /** @type {BrushModel['hulls']} */ ([
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
  ]);

  return model;
}

// ── Entity Fixtures ─────────────────────────────────────────────────────────

/**
 * Build a minimal boxed entity fixture for Pmove physents.
 * @param {{origin: Vector, mins: Vector, maxs: Vector, num?: number}} options entity options
 * @returns {ClientEdict} pmove entity fixture
 */
export function createPmoveBoxEntity({ origin, mins, maxs, num = 0 }) {
  const entity = new ClientEdict(num);
  entity.origin.set(origin);
  entity.mins.set(mins);
  entity.maxs.set(maxs);
  entity.angles.clear();
  return entity;
}

/**
 * Create a minimal entity object for server physics tests.
 * @param {{origin?: Vector, mins?: Vector, maxs?: Vector, velocity?: Vector, avelocity?: Vector, angles?: Vector, modelindex?: number, movetype?: number, solidType?: number, flagsValue?: number, groundentity?: object|null, num?: number}} options entity options
 * @returns {MockEntity} mock entity
 */
export function createMockEntity({
  origin = new Vector(),
  mins = new Vector(),
  maxs = new Vector(),
  velocity = new Vector(),
  avelocity = new Vector(),
  angles = new Vector(),
  modelindex = 0,
  movetype = moveType.MOVETYPE_NONE,
  solidType = solid.SOLID_NOT,
  flagsValue = 0,
  groundentity = null,
  num = 0,
} = {}) {
  return {
    origin,
    mins,
    maxs,
    velocity,
    avelocity,
    angles,
    modelindex,
    movetype,
    solid: solidType,
    flags: flagsValue,
    groundentity,
    ltime: 0,
    owner: null,
    blocked: null,
    touch: null,
    think() {},
    nextthink: 0,
    num,
    size: maxs.copy().subtract(mins),
    absmin: origin.copy().add(mins),
    absmax: origin.copy().add(maxs),
    equals(other) {
      return this === other;
    },
  };
}

/**
 * Create a minimal server edict wrapper.
 * @param {MockEntity} entity underlying entity
 * @returns {MockEdict} mock edict
 */
export function createMockEdict(entity) {
  return {
    entity,
    num: entity.num ?? 0,
    isFree() {
      return false;
    },
    isClient() {
      return false;
    },
    equals(other) {
      return this === other;
    },
  };
}

// ── Mock Registry Helpers ───────────────────────────────────────────────────

/**
 * Build a default mock registry config with silent console and standard frametime.
 * Supply SV overrides to configure server-side mocks.
 * @param {object} [sv] SV overrides
 * @param cl
 * @returns {MockRegistryConfig} registry config
 */
export function defaultMockRegistry(sv = {}, cl = null) {
  return {
    CL: cl,
    Con: { Print() {}, DPrint() {} },
    Host: { frametime: 0.1 },
    SV: sv,
  };
}

/**
 * Run a callback with mocked registry values.
 * @param {MockRegistryConfig} mockedRegistry registry replacements
 * @param {() => void | Promise<void>} callback test callback
 */
export function withMockRegistry(mockedRegistry, callback) {
  const previousCOM = registry.COM;
  const previousCL = registry.CL;
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousSV = registry.SV;

  registry.COM = mockedRegistry.COM ?? previousCOM;
  registry.CL = mockedRegistry.CL ?? null;
  registry.Con = mockedRegistry.Con;
  registry.Host = mockedRegistry.Host;
  registry.SV = mockedRegistry.SV;
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.COM = previousCOM;
    registry.CL = previousCL;
    registry.Con = previousCon;
    registry.Host = previousHost;
    registry.SV = previousSV;
    eventBus.publish('registry.frozen');
  };

  try {
    const result = callback();

    if (result !== null && result !== undefined && typeof result.then === 'function') {
      return Promise.resolve(result).finally(restore);
    }

    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/**
 * Run a callback with a minimal mocked server registry for ServerPhysics tests.
 * @param {(context: { serverPhysics: ServerPhysics, pusherEdict: MockEdict, riderEdict: MockEdict, linkCalls: object[], moveCalls: object[], testCalls: object[], blockedCalls: object[] }) => void} callback test callback
 */
export function withMockServerPhysics(callback) {
  const linkCalls = [];
  const moveCalls = [];
  const testCalls = [];
  const blockedCalls = [];

  const pusherEntity = createMockEntity({
    origin: new Vector(0, 0, 0),
    mins: new Vector(-64, -64, -16),
    maxs: new Vector(64, 64, 16),
    velocity: new Vector(0, 0, 100),
    avelocity: new Vector(),
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  pusherEntity.blocked = (blockingEntity) => {
    blockedCalls.push(blockingEntity);
  };

  const riderEntity = createMockEntity({
    origin: new Vector(0, 0, 32),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    velocity: new Vector(),
    avelocity: new Vector(),
    movetype: moveType.MOVETYPE_WALK,
    solidType: solid.SOLID_BBOX,
    flagsValue: flags.FL_ONGROUND,
    groundentity: pusherEntity,
  });

  const worldEdict = createMockEdict(createMockEntity());
  const pusherEdict = createMockEdict(pusherEntity);
  const riderEdict = createMockEdict(riderEntity);

  const linkEdict = (edict) => {
    edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
    edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
    linkCalls.push(edict);
  };

  void withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: {
      frametime: 0.1,
    },
    SV: {
      maxvelocity: { value: 2000 },
      area: {
        linkEdict,
      },
      collision: {
        move(start, mins, maxs, end) {
          moveCalls.push({ start: start.copy(), mins: mins.copy(), maxs: maxs.copy(), end: end.copy() });
          return {
            allsolid: false,
            startsolid: false,
            fraction: 1.0,
            endpos: end.copy(),
            ent: null,
          };
        },
        testEntityPosition(edict) {
          testCalls.push(edict);
          return false;
        },
      },
      server: {
        time: 0,
        num_edicts: 3,
        edicts: [worldEdict, pusherEdict, riderEdict],
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    callback({
      serverPhysics: new ServerPhysics(),
      pusherEdict,
      riderEdict,
      linkCalls,
      moveCalls,
      testCalls,
      blockedCalls,
    });
  });
}

// ── Assertion Helpers ───────────────────────────────────────────────────────

/**
 * Assert that two numeric values are approximately equal.
 * @param {number} actual measured value
 * @param {number} expected expected value
 * @param {number} [epsilon] maximum allowed absolute difference, defaults to 0.05
 */
export function assertNear(actual, expected, epsilon = 0.05) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}
