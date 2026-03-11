import test from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.mjs';
import { content, flags, moveType, solid } from '../../source/shared/Defs.mjs';
import { BrushModel } from '../../source/engine/common/model/BSP.mjs';
import { BrushTrace, Pmove, PmovePlayer, Trace } from '../../source/engine/common/Pmove.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import { ServerCollision } from '../../source/engine/server/physics/ServerCollision.mjs';
import { ServerPhysics } from '../../source/engine/server/physics/ServerPhysics.mjs';

test('PmovePlayer.DEBUG is disabled before Pmove.Init()', () => {
  assert.equal(PmovePlayer.DEBUG, false);
});

/**
 * Build a minimal axis plane for brush collision fixtures.
 * @param {number[]} normalComponents plane normal components
 * @param {number} dist plane distance from origin
 * @param {number} type axial plane type
 * @returns {{normal: Vector, dist: number, type: number}} plane fixture
 */
function createAxisPlane(normalComponents, dist, type) {
  return {
    normal: new Vector(...normalComponents),
    dist,
    type,
  };
}

/**
 * Build a minimal solid box brush model for trace and position tests.
 * @param {{center?: number[], halfExtents: number[], name?: string, submodel?: boolean}} options fixture options
 * @returns {BrushModel} brush model fixture
 */
function createBoxBrushModel({ center = [0, 0, 0], halfExtents, name = '*test', submodel = true }) {
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

  model.brushsides = model.planes.map((plane, index) => ({
    planenum: index,
    plane,
  }));

  model.brushes = [{
    firstside: 0,
    numsides: 6,
    contents: content.CONTENT_SOLID,
    mins: new Vector(centerX - halfExtents[0], centerY - halfExtents[1], centerZ - halfExtents[2]),
    maxs: new Vector(centerX + halfExtents[0], centerY + halfExtents[1], centerZ + halfExtents[2]),
    _brushTraceCheck: 0,
  }];

  return model;
}

/**
 * Build a minimal brush-list world model that traverses a BSP node and leaf brushes.
 * @param {{axis?: 0|1|2, center?: number[], halfExtents: number[]}} options fixture options
 * @returns {BrushModel} world brush model fixture
 */
function createBrushWorldModel({ axis = 0, center = [64, 0, 0], halfExtents }) {
  const model = createBoxBrushModel({ center, halfExtents, name: 'test-brush-world', submodel: false });
  const axisNormal = [0, 0, 0];
  axisNormal[axis] = 1;
  const roomMins = new Vector(-2048, -2048, -2048);
  const roomMaxs = new Vector(2048, 2048, 2048);
  const frontLeaf = {
    contents: content.CONTENT_EMPTY,
    firstleafbrush: 0,
    numleafbrushes: 1,
  };
  const backLeaf = {
    contents: content.CONTENT_EMPTY,
    firstleafbrush: 1,
    numleafbrushes: 0,
  };

  model.nodes = [{
    contents: 0,
    plane: createAxisPlane(axisNormal, 0, axis),
    children: [frontLeaf, backLeaf],
  }];
  model.leafs = [frontLeaf, backLeaf];
  model.leafbrushes = [0];
  model.hulls = [
    createRoomHullFromBounds(roomMins, roomMaxs),
    createRoomHullFromBounds(roomMins, roomMaxs),
    createRoomHullFromBounds(roomMins, roomMaxs),
  ];

  return model;
}

/**
 * Assert that two numeric values are approximately equal.
 * @param {number} actual measured value
 * @param {number} expected expected value
 * @param {number} [epsilon] maximum allowed absolute difference, defaults to 0.05
 */
function assertNear(actual, expected, epsilon = 0.05) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

/**
 * Build a room hull whose interior is empty and whose exterior is solid.
 * @param {Vector} mins room mins
 * @param {Vector} maxs room maxs
 * @returns {{clip_mins: Vector, clip_maxs: Vector, firstclipnode: number, lastclipnode: number, clipnodes: {planenum: number, children: number[]}[], planes: {normal: Vector, dist: number, type: number, signbits: number}[]}} model hull fixture
 */
function createRoomHullFromBounds(mins, maxs) {
  const planes = [
    { normal: new Vector(1, 0, 0), dist: maxs[0], type: 0, signbits: 0 },
    { normal: new Vector(1, 0, 0), dist: mins[0], type: 0, signbits: 0 },
    { normal: new Vector(0, 1, 0), dist: maxs[1], type: 1, signbits: 0 },
    { normal: new Vector(0, 1, 0), dist: mins[1], type: 1, signbits: 0 },
    { normal: new Vector(0, 0, 1), dist: maxs[2], type: 2, signbits: 0 },
    { normal: new Vector(0, 0, 1), dist: mins[2], type: 2, signbits: 0 },
  ];

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
 * Build a legacy hull-only world model for Pmove smoke tests.
 * @param {Vector} mins room mins
 * @param {Vector} maxs room maxs
 * @returns {BrushModel} world model fixture
 */
function createLegacyWorldModel(mins, maxs) {
  const model = new BrushModel();
  model.name = 'test-world';
  model.hulls = [
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
  ];

  return model;
}

/**
 * Create a minimal entity object for server physics tests.
 * @param {{origin?: Vector, mins?: Vector, maxs?: Vector, velocity?: Vector, avelocity?: Vector, angles?: Vector, movetype?: number, solidType?: number, flagsValue?: number, groundentity?: object|null}} options entity options
 * @returns {object} mock entity
 */
function createMockEntity({
  origin = new Vector(),
  mins = new Vector(),
  maxs = new Vector(),
  velocity = new Vector(),
  avelocity = new Vector(),
  angles = new Vector(),
  movetype = moveType.MOVETYPE_NONE,
  solidType = solid.SOLID_NOT,
  flagsValue = 0,
  groundentity = null,
} = {}) {
  return {
    origin,
    mins,
    maxs,
    velocity,
    avelocity,
    angles,
    movetype,
    solid: solidType,
    flags: flagsValue,
    groundentity,
    ltime: 0,
    owner: null,
    blocked: null,
    touch: null,
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
 * @param {object} entity underlying entity
 * @returns {{entity: object, isFree: () => boolean, equals: (other: object) => boolean}} mock edict
 */
function createMockEdict(entity) {
  return {
    entity,
    isFree() {
      return false;
    },
    equals(other) {
      return this === other;
    },
  };
}

/**
 * Run a callback with a minimal mocked server registry for ServerPhysics tests.
 * @param {(context: { serverPhysics: ServerPhysics, pusherEdict: object, riderEdict: object, linkCalls: object[], moveCalls: object[], testCalls: object[], blockedCalls: object[] }) => void} callback test callback
 */
function withMockServerPhysics(callback) {
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousSV = registry.SV;
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

  registry.Con = {
    Print() {},
    DPrint() {},
  };
  registry.Host = {
    frametime: 0.1,
  };
  registry.SV = {
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
  };
  eventBus.publish('registry.frozen');

  try {
    callback({
      serverPhysics: new ServerPhysics(),
      pusherEdict,
      riderEdict,
      linkCalls,
      moveCalls,
      testCalls,
      blockedCalls,
    });
  } finally {
    registry.Con = previousCon;
    registry.Host = previousHost;
    registry.SV = previousSV;
    eventBus.publish('registry.frozen');
  }
}

test('BrushTrace.transformedTestPosition keeps exact face contact walkable', () => {
  const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
  const origin = new Vector(100, 0, 0);
  const tangentPosition = new Vector(100, 0, 40);
  const penetratingPosition = new Vector(100, 0, 39.9);

  assert.equal(
    BrushTrace.transformedTestPosition(
      model,
      tangentPosition,
      Pmove.PLAYER_MINS,
      Pmove.PLAYER_MAXS,
      origin,
      Vector.origin,
    ),
    true,
  );

  assert.equal(
    BrushTrace.transformedTestPosition(
      model,
      penetratingPosition,
      Pmove.PLAYER_MINS,
      Pmove.PLAYER_MAXS,
      origin,
      Vector.origin,
    ),
    false,
  );
});

test('BrushTrace.transformedBoxTrace returns world-space impact points', () => {
  const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
  const trace = BrushTrace.transformedBoxTrace(
    model,
    new Vector(0, 0, 0),
    new Vector(100, 0, 0),
    new Vector(),
    new Vector(),
    new Vector(64, 0, 0),
    Vector.origin,
  );

  assert.equal(trace.startsolid, false);
  assert.ok(trace.fraction < 1.0);
  assertNear(trace.endpos[0], 47.96875, 0.001);
  assertNear(trace.endpos[1], 0);
  assertNear(trace.endpos[2], 0);
});

test('BrushTrace.boxTrace traverses world brush lists through BSP nodes', () => {
  const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
  const trace = BrushTrace.boxTrace(
    worldModel,
    0,
    new Vector(0, 0, 0),
    new Vector(100, 0, 0),
    new Vector(),
    new Vector(),
  );

  assert.equal(trace.startsolid, false);
  assert.ok(trace.fraction < 1.0);
  assertNear(trace.endpos[0], 47.96875, 0.001);
  assertNear(trace.endpos[1], 0);
  assertNear(trace.endpos[2], 0);
});

test('BrushTrace.testPosition traverses world brush lists through BSP nodes', () => {
  const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });

  assert.equal(
    BrushTrace.testPosition(
      worldModel,
      0,
      new Vector(64, 0, 40),
      Pmove.PLAYER_MINS,
      Pmove.PLAYER_MAXS,
    ),
    true,
  );

  assert.equal(
    BrushTrace.testPosition(
      worldModel,
      0,
      new Vector(64, 0, 39.9),
      Pmove.PLAYER_MINS,
      Pmove.PLAYER_MAXS,
    ),
    false,
  );
});

test('Pmove.clipPlayerMove keeps startsolid end positions in world space', () => {
  const pmove = new Pmove();

  pmove.addEntity({
    origin: new Vector(),
    mins: new Vector(-32, -32, -32),
    maxs: new Vector(32, 32, 32),
  });

  const start = new Vector();
  const end = new Vector(128, 0, 0);
  const trace = pmove.clipPlayerMove(start, end);

  assert.equal(trace.startsolid, true);
  assert.equal(trace.fraction, 0.0);
  assert.deepEqual([...trace.endpos], [...start]);
});

test('Pmove.clipPlayerMove reports hull hits in world coordinates', () => {
  const pmove = new Pmove();

  pmove.addEntity({
    origin: new Vector(64, 0, 0),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
  });

  const trace = pmove.clipPlayerMove(new Vector(0, 0, 0), new Vector(100, 0, 0));

  assert.equal(trace.startsolid, false);
  assert.ok(trace.fraction < 1.0);
  assertNear(trace.endpos[0], 31.96875, 0.001);
  assertNear(trace.endpos[1], 0);
  assertNear(trace.endpos[2], 0);
});

test('Pmove server-style smoke setup mirrors TestServerside assertions', () => {
  const worldModel = createLegacyWorldModel(
    new Vector(-256, -256, -128),
    new Vector(256, 256, 128),
  );
  const pmove = new Pmove();
  const entity = {
    origin: new Vector(128, 0, 0),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    num: 1,
  };

  pmove.setWorldmodel(worldModel);

  assert.equal(pmove.physents[0].constructor.name, 'PhysEnt');
  assert.equal(pmove.physents[0].hulls.length, worldModel.hulls.length);

  pmove.addEntity(entity);

  assert.equal(pmove.physents.length, 2);
  assert.equal(pmove.physents[1].origin.equals(entity.origin), true);
  assert.equal(pmove.physents[1].edictId, 1);

  const playerOrigin = new Vector(0, 0, 0);
  assert.equal(pmove.isValidPlayerPosition(playerOrigin), true);

  const playerMoveTraceIntoSpace = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 999999));
  assert.equal(playerMoveTraceIntoSpace instanceof Trace, true);
  assert.equal(playerMoveTraceIntoSpace.ent, 0);
  assert.ok(playerMoveTraceIntoSpace.fraction < 1.0);

  const playerMoveTraceHigher = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 64.0));
  assert.equal(playerMoveTraceHigher instanceof Trace, true);
  assert.equal(playerMoveTraceHigher.ent, null);
  assert.equal(playerMoveTraceHigher.fraction, 1.0);
});

test('Pmove brush-list world path supports server-style vertical smoke checks', () => {
  const worldModel = createBrushWorldModel({ axis: 2, center: [0, 0, 144], halfExtents: [512, 512, 16] });
  const pmove = new Pmove();
  const entity = {
    origin: new Vector(128, 0, 0),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    num: 1,
  };

  pmove.setWorldmodel(worldModel);
  pmove.addEntity(entity);

  const playerOrigin = new Vector(0, 0, 0);
  assert.equal(pmove.physents[0].usesBrushTracing, true);
  assert.equal(pmove.isValidPlayerPosition(playerOrigin), true);

  const playerMoveTraceIntoSpace = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 999999));
  assert.equal(playerMoveTraceIntoSpace instanceof Trace, true);
  assert.equal(playerMoveTraceIntoSpace.ent, 0);
  assert.ok(playerMoveTraceIntoSpace.fraction < 1.0);

  const playerMoveTraceHigher = pmove.clipPlayerMove(playerOrigin, new Vector(0, 0, 64.0));
  assert.equal(playerMoveTraceHigher instanceof Trace, true);
  assert.equal(playerMoveTraceHigher.ent, null);
  assert.equal(playerMoveTraceHigher.fraction, 1.0);
});

test('ServerCollision stationary brush tests preserve exact resting contact', () => {
  const collision = new ServerCollision();
  const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
  const position = new Vector(100, 0, 40);

  const trace = collision._traceBrushModel(
    model,
    position,
    Pmove.PLAYER_MINS,
    Pmove.PLAYER_MAXS,
    position,
    new Vector(100, 0, 0),
    Vector.origin,
  );

  assert.equal(trace.startsolid, false);
  assert.equal(trace.allsolid, false);
  assert.equal(trace.fraction, 1.0);
  assert.deepEqual([...trace.endpos], [...position]);
});

test('ServerPhysics.pushMove carries a grounded rider upward without blocked()', () => {
  withMockServerPhysics(({ serverPhysics, pusherEdict, riderEdict, moveCalls, testCalls, blockedCalls }) => {
    serverPhysics.pushMove(pusherEdict, 0.1);

    assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 10]);
    assert.deepEqual([...riderEdict.entity.origin], [0, 0, 42]);
    assert.equal(moveCalls.length, 1);
    assert.deepEqual([...moveCalls[0].end], [0, 0, 42]);
    assert.equal(testCalls.length, 1);
    assert.equal(testCalls[0], riderEdict);
    assert.equal(blockedCalls.length, 0);
    assert.equal(pusherEdict.entity.ltime, 0.1);
  });
});

test('ServerPhysics.pushMove rolls back and calls blocked() when rider remains stuck', () => {
  withMockServerPhysics(({ serverPhysics, pusherEdict, riderEdict, blockedCalls }) => {
    let testCount = 0;
    registry.SV.collision.testEntityPosition = (edict) => {
      testCount += 1;
      return edict === riderEdict;
    };
    eventBus.publish('registry.frozen');

    serverPhysics.pushMove(pusherEdict, 0.1);

    assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 0]);
    assert.deepEqual([...riderEdict.entity.origin], [0, 0, 32]);
    assert.equal(testCount, 1);
    assert.equal(blockedCalls.length, 1);
    assert.equal(blockedCalls[0], riderEdict.entity);
    assert.equal(pusherEdict.entity.ltime, 0);
  });
});
