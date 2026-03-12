import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.mjs';
import { content, flags, moveType, moveTypes, solid } from '../../source/shared/Defs.mjs';
import { Brush, BrushModel, BrushSide } from '../../source/engine/common/model/BSP.mjs';
import { BrushTrace, Hull, PMF, Pmove, PmovePlayer, Trace } from '../../source/engine/common/Pmove.mjs';
import { BSP29Loader } from '../../source/engine/common/model/loaders/BSP29Loader.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import { UserCmd } from '../../source/engine/network/Protocol.mjs';
import { ClientEdict } from '../../source/engine/client/ClientEntities.mjs';
import { ServerCollision } from '../../source/engine/server/physics/ServerCollision.mjs';
import { ServerPhysics } from '../../source/engine/server/physics/ServerPhysics.mjs';
import { ServerMovement } from '../../source/engine/server/physics/ServerMovement.mjs';
import { BlockedFlags, MAX_BUMP_COUNT } from '../../source/engine/server/physics/Defs.mjs';

test('PmovePlayer.DEBUG is disabled before Pmove.Init()', () => {
  assert.equal(PmovePlayer.DEBUG, false);
});

/**
 * Build a minimal axis plane for brush collision fixtures.
 * @param {number[]} normalComponents plane normal components
 * @param {number} dist plane distance from origin
 * @param {number} type axial plane type
 * @returns {{normal: Vector, dist: number, type: number, signbits: 0}} plane fixture
 */
function createAxisPlane(normalComponents, dist, type) {
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
 * @returns {{clip_mins: Vector, clip_maxs: Vector, firstclipnode: number, lastclipnode: number, clipnodes: {planenum: number, children: number[]}[], planes: {normal: Vector, dist: number, type: number, signbits: 0}[]}} model hull fixture
 */
function createRoomHullFromBounds(mins, maxs) {
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
 * Build a legacy hull-only world model for Pmove smoke tests.
 * @param {Vector} mins room mins
 * @param {Vector} maxs room maxs
 * @returns {BrushModel} world model fixture
 */
function createLegacyWorldModel(mins, maxs) {
  const model = new BrushModel();
  model.name = 'test-world';
  model.hulls = /** @type {BrushModel['hulls']} */ ([
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
    createRoomHullFromBounds(mins, maxs),
  ]);

  return model;
}

/**
 * Build a minimal boxed entity fixture for Pmove physents.
 * @param {{origin: Vector, mins: Vector, maxs: Vector, num?: number}} options entity options
 * @returns {ClientEdict} pmove entity fixture
 */
function createPmoveBoxEntity({ origin, mins, maxs, num = 0 }) {
  const entity = new ClientEdict(num);
  entity.origin.set(origin);
  entity.mins.set(mins);
  entity.maxs.set(maxs);
  entity.angles.clear();
  return entity;
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
    think() {},
    nextthink: 0,
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
 * @returns {{entity: object, num: number, isFree: () => boolean, isClient: () => boolean, equals: (other: object) => boolean}} mock edict
 */
function createMockEdict(entity) {
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

/**
 * Run a callback with mocked registry values.
 * @param {{Con: object, Host: object, SV: object}} mockedRegistry registry replacements
 * @param {() => void} callback test callback
 */
function withMockRegistry(mockedRegistry, callback) {
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousSV = registry.SV;

  registry.Con = mockedRegistry.Con;
  registry.Host = mockedRegistry.Host;
  registry.SV = mockedRegistry.SV;
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    registry.Con = previousCon;
    registry.Host = previousHost;
    registry.SV = previousSV;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Run a callback with a minimal mocked server registry for ServerPhysics tests.
 * @param {(context: { serverPhysics: ServerPhysics, pusherEdict: object, riderEdict: object, linkCalls: object[], moveCalls: object[], testCalls: object[], blockedCalls: object[] }) => void} callback test callback
 */
function withMockServerPhysics(callback) {
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

  withMockRegistry({
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

test('BrushTrace.transformedTestPosition keeps non-axial clip-brush edge contact walkable for player boxes', () => {
  const model = createBoxBrushModel({ center: [304, -124, 36], halfExtents: [8, 4, 36] });
  const slopedPlaneIndex = model.planes.length;

  model.planes.push({
    normal: new Vector(-0.4472135954999579, 0.8944271909999159, 0.0),
    dist: -246.8615612366939,
    type: 4,
    signbits: 1,
  });

  const slopedSide = new BrushSide(model);
  slopedSide.planenum = slopedPlaneIndex;
  slopedSide.texinfo = 0;
  model.brushsides.push(slopedSide);

  model.brushes[0].numsides += 1;
  model.brushes[0].contents = content.CONTENT_CLIP;

  assert.equal(
    BrushTrace.transformedTestPosition(
      model,
      new Vector(280, -112, 25),
      Pmove.PLAYER_MINS,
      Pmove.PLAYER_MAXS,
      Vector.origin,
      Vector.origin,
    ),
    true,
  );
});

test('BrushTrace.transformedTestPosition keeps single non-axial clip-brush face contact walkable for player boxes', () => {
  const model = createBoxBrushModel({ center: [336, -124, 36], halfExtents: [8, 4, 36] });
  const slopedPlaneIndex = model.planes.length;

  model.planes.push({
    normal: new Vector(0.4472135954999579, 0.8944271909999159, 0.0),
    dist: 39.310072314871135,
    type: 4,
    signbits: 0,
  });

  const slopedSide = new BrushSide(model);
  slopedSide.planenum = slopedPlaneIndex;
  slopedSide.texinfo = 0;
  model.brushsides.push(slopedSide);

  model.brushes[0].numsides += 1;
  model.brushes[0].contents = content.CONTENT_CLIP;

  assert.equal(
    BrushTrace.transformedTestPosition(
      model,
      new Vector(353.5, -108.80000305175781, 25),
      Pmove.PLAYER_MINS,
      Pmove.PLAYER_MAXS,
      Vector.origin,
      Vector.origin,
    ),
    true,
  );
});

test('BrushTrace.transformedBoxTrace clips tangent sloped clip-brush starts without startsolid', () => {
  const model = createBoxBrushModel({ center: [336, -124, 36], halfExtents: [8, 4, 36] });
  const slopedPlaneIndex = model.planes.length;

  model.planes.push({
    normal: new Vector(0.4472135954999579, 0.8944271909999159, 0.0),
    dist: 39.310072314871135,
    type: 4,
    signbits: 0,
  });

  const slopedSide = new BrushSide(model);
  slopedSide.planenum = slopedPlaneIndex;
  slopedSide.texinfo = 0;
  model.brushsides.push(slopedSide);

  model.brushes[0].numsides += 1;
  model.brushes[0].contents = content.CONTENT_CLIP;

  const trace = BrushTrace.transformedBoxTrace(
    model,
    new Vector(353.5, -108.80000305175781, 25),
    new Vector(349.20001220703125, -108.80000305175781, 25),
    Pmove.PLAYER_MINS,
    Pmove.PLAYER_MAXS,
    Vector.origin,
    Vector.origin,
  );

  assert.equal(trace.startsolid, false);
  assert.equal(trace.allsolid, false);
  assert.equal(trace.fraction, 0.0);
  assertNear(trace.plane.normal[0], 0.4472135954999579, 0.001);
  assertNear(trace.plane.normal[1], 0.8944271909999159, 0.001);
  assertNear(trace.plane.normal[2], 0.0, 0.001);
  assert.deepEqual([...trace.endpos], [353.5, -108.80000305175781, 25]);
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

test('BrushTrace.transformedBoxTrace keeps exact floor contact out of startsolid', () => {
  const model = createBoxBrushModel({ halfExtents: [16, 16, 16] });
  const origin = new Vector(100, 0, 0);
  const start = new Vector(100, 0, 40);
  const end = new Vector(100, 0, 39);

  const trace = BrushTrace.transformedBoxTrace(
    model,
    start,
    end,
    Pmove.PLAYER_MINS,
    Pmove.PLAYER_MAXS,
    origin,
    Vector.origin,
  );

  assert.equal(trace.startsolid, false);
  assert.equal(trace.allsolid, false);
  assert.equal(trace.fraction, 0.0);
  assertNear(trace.plane.normal[0], 0.0);
  assertNear(trace.plane.normal[1], 0.0);
  assertNear(trace.plane.normal[2], 1.0);
  assert.deepEqual([...trace.endpos], [...start]);
});

test('BrushTrace transformed tests honor rotated entity angles', () => {
  const model = createBoxBrushModel({ halfExtents: [8, 32, 16] });
  const point = new Vector(20, 0, 0);

  assert.equal(
    BrushTrace.transformedTestPosition(model, point, new Vector(), new Vector(), Vector.origin, Vector.origin),
    true,
  );
  assert.equal(
    BrushTrace.transformedTestPosition(model, point, new Vector(), new Vector(), Vector.origin, new Vector(0, 90, 0)),
    false,
  );

  const unrotatedTrace = BrushTrace.transformedBoxTrace(
    model,
    new Vector(-40, 0, 0),
    new Vector(40, 0, 0),
    new Vector(),
    new Vector(),
    Vector.origin,
    Vector.origin,
  );
  const rotatedTrace = BrushTrace.transformedBoxTrace(
    model,
    new Vector(-40, 0, 0),
    new Vector(40, 0, 0),
    new Vector(),
    new Vector(),
    Vector.origin,
    new Vector(0, 90, 0),
  );

  assert.ok(rotatedTrace.fraction < unrotatedTrace.fraction);
  assert.ok(rotatedTrace.endpos[0] < unrotatedTrace.endpos[0] - 20);
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

test('BrushTrace.boxTrace returns a clean miss for empty world models', () => {
  const worldModel = new BrushModel();
  worldModel.name = 'empty-world';
  worldModel.nodes = [];

  const start = new Vector(1, 2, 3);
  const end = new Vector(10, 20, 30);
  const trace = BrushTrace.boxTrace(worldModel, 0, start, end, Pmove.PLAYER_MINS, Pmove.PLAYER_MAXS);

  assert.equal(trace.allsolid, false);
  assert.equal(trace.startsolid, false);
  assert.equal(trace.fraction, 1.0);
  assert.deepEqual([...trace.endpos], [...end]);
});

test('BrushTrace.transformedBoxTrace returns a clean miss for empty submodels', () => {
  const model = new BrushModel();
  model.name = '*empty';
  model.submodel = true;
  model.brushes = [];
  model.brushsides = [];
  model.leafbrushes = [];
  model.numBrushes = 0;

  const end = new Vector(10, 20, 30);
  const trace = BrushTrace.transformedBoxTrace(
    model,
    new Vector(1, 2, 3),
    end,
    Pmove.PLAYER_MINS,
    Pmove.PLAYER_MAXS,
    Vector.origin,
    Vector.origin,
  );

  assert.equal(trace.allsolid, false);
  assert.equal(trace.startsolid, false);
  assert.equal(trace.fraction, 1.0);
  assert.deepEqual([...trace.endpos], [...end]);
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

  pmove.addEntity(createPmoveBoxEntity({
    origin: new Vector(),
    mins: new Vector(-32, -32, -32),
    maxs: new Vector(32, 32, 32),
  }));

  const start = new Vector();
  const end = new Vector(128, 0, 0);
  const trace = pmove.clipPlayerMove(start, end);

  assert.equal(trace.startsolid, true);
  assert.equal(trace.fraction, 0.0);
  assert.deepEqual([...trace.endpos], [...start]);
});

test('Pmove.clipPlayerMove reports hull hits in world coordinates', () => {
  const pmove = new Pmove();

  pmove.addEntity(createPmoveBoxEntity({
    origin: new Vector(64, 0, 0),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
  }));

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
  const entity = createPmoveBoxEntity({
    origin: new Vector(128, 0, 0),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    num: 1,
  });

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

test('Pmove.traceStaticWorldPlayerMove traces world only and ignores dynamic physents', () => {
  const worldModel = createLegacyWorldModel(
    new Vector(-256, -256, -128),
    new Vector(256, 256, 128),
  );
  const pmove = new Pmove();

  pmove.setWorldmodel(worldModel);
  pmove.addEntity(createPmoveBoxEntity({
    origin: new Vector(64, 0, 0),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    num: 1,
  }));

  const staticWorldTrace = pmove.traceStaticWorldPlayerMove(new Vector(0, 0, 0), new Vector(100, 0, 0));
  const aggregateTrace = pmove.clipPlayerMove(new Vector(0, 0, 0), new Vector(100, 0, 0));

  assert.equal(staticWorldTrace.fraction, 1.0);
  assert.deepEqual([...staticWorldTrace.endpos], [100, 0, 0]);
  assert.ok(aggregateTrace.fraction < 1.0);
  assertNear(aggregateTrace.endpos[0], 31.96875, 0.001);
});

test('Pmove brush-list world path supports server-style vertical smoke checks', () => {
  const worldModel = createBrushWorldModel({ axis: 2, center: [0, 0, 144], halfExtents: [512, 512, 16] });
  const pmove = new Pmove();
  const entity = createPmoveBoxEntity({
    origin: new Vector(128, 0, 0),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    num: 1,
  });

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

test('Pmove.staticWorldContents uses brush-backed world solids before leaf contents', () => {
  const worldModel = createBrushWorldModel({ center: [64, 0, 0], halfExtents: [16, 16, 16] });
  const pmove = new Pmove();

  worldModel.leafs[0].contents = content.CONTENT_WATER;

  pmove.setWorldmodel(worldModel);

  assert.equal(pmove.staticWorldContents(new Vector(64, 0, 0)), content.CONTENT_SOLID);
  assert.equal(pmove.staticWorldContents(new Vector(8, 0, 0)), content.CONTENT_WATER);
});

test('Pmove.staticWorldContents normalizes brush-backed current leaves to water', () => {
  const worldModel = createBrushWorldModel({ center: [64, 0, 0], halfExtents: [16, 16, 16] });
  const pmove = new Pmove();

  worldModel.leafs[0].contents = content.CONTENT_CURRENT_UP;

  pmove.setWorldmodel(worldModel);

  assert.equal(pmove.staticWorldContents(new Vector(8, 0, 0)), content.CONTENT_WATER);
});

test('PmovePlayer.move integrates one grounded movement frame against a world model', () => {
  const worldModel = createBrushWorldModel({ axis: 2, center: [0, 0, -40], halfExtents: [512, 512, 16] });
  const pmove = new Pmove();
  const player = pmove.newPlayerMove();

  pmove.setWorldmodel(worldModel);

  player.origin.setTo(0, 0, 0);
  player.velocity.clear();
  player.angles.clear();
  player.cmd = new UserCmd();
  player.cmd.msec = 100;
  player.cmd.forwardmove = 200;

  player.move();

  assert.equal((player.pmFlags & PMF.ON_GROUND) !== 0, true);
  assert.equal(player.onground, 0);
  assert.ok(player.origin[0] > 0.5);
  assertNear(player.origin[2], 0, 0.125);
  assert.ok(player.velocity[0] > 0);
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

test('ServerCollision.move traces world brush sweeps through shared brush state', () => {
  const collision = new ServerCollision();
  const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
  const worldEntity = createMockEntity({
    origin: new Vector(),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_NONE,
    solidType: solid.SOLID_BSP,
  });
  const worldEdict = createMockEdict(worldEntity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        hullForEntity(_ent, _mins, _maxs, offset) {
          offset.clear();
          return worldModel.hulls[0];
        },
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [worldEdict],
        worldmodel: worldModel,
      },
    },
  }, () => {
    const trace = collision.move(
      new Vector(0, 0, 0),
      new Vector(),
      new Vector(),
      new Vector(100, 0, 0),
      0,
      null,
    );

    assert.equal(trace.startsolid, false);
    assert.ok(trace.fraction < 1.0);
    assert.equal(trace.ent, worldEdict);
    assertNear(trace.endpos[0], 47.96875, 0.001);
    assertNear(trace.endpos[1], 0);
    assertNear(trace.endpos[2], 0);
  });
});

test('ServerCollision.move prefers a later legacy hull hit over an earlier world brush point hit', () => {
  const collision = new ServerCollision();
  const worldModel = createBoxBrushModel({ halfExtents: [16, 16, 16], name: 'world-brush' });
  const worldEntity = createMockEntity({
    origin: new Vector(),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_NONE,
    solidType: solid.SOLID_BSP,
  });
  const worldEdict = createMockEdict(worldEntity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [worldEdict],
        worldmodel: worldModel,
      },
    },
  }, () => {
    collision._traceBrushModel = () => ({
      fraction: 0.25,
      allsolid: false,
      startsolid: false,
      endpos: new Vector(25, 0, 0),
      plane: { normal: new Vector(-1, 0, 0), dist: -25 },
      inopen: true,
      inwater: false,
    });

    collision._clipMoveToHullState = (state, start, mins, maxs, end) => {
      if (state.ent !== worldEdict) {
        return {
          fraction: 1.0,
          allsolid: false,
          startsolid: false,
          endpos: end.copy(),
          plane: { normal: new Vector(), dist: 0.0 },
          ent: null,
          inopen: false,
          inwater: false,
        };
      }

      return {
        fraction: 0.5,
        allsolid: false,
        startsolid: false,
        endpos: new Vector(50, 0, 0),
        plane: { normal: new Vector(-1, 0, 0), dist: -50 },
        ent: worldEdict,
        inopen: true,
        inwater: false,
      };
    };

    const trace = collision.move(
      new Vector(0, 0, 0),
      Vector.origin,
      Vector.origin,
      new Vector(100, 0, 0),
      0,
      null,
    );

    assert.equal(trace.fraction, 0.5);
    assert.equal(trace.ent, worldEdict);
    assert.deepEqual([...trace.endpos], [50, 0, 0]);
  });
});

test('BSP29Loader builds legacy clipnode masks from a model headnode subtree', () => {
  const loader = new BSP29Loader();
  const clipnodes = [
    { planenum: 0, children: [1, 2] },
    { planenum: 1, children: [content.CONTENT_EMPTY, 3] },
    { planenum: 2, children: [4, content.CONTENT_SOLID] },
    { planenum: 3, children: [content.CONTENT_SOLID, content.CONTENT_EMPTY] },
    { planenum: 4, children: [content.CONTENT_EMPTY, content.CONTENT_SOLID] },
  ];

  const worldMask = loader._buildAllowedClipnodeMask(clipnodes, 0);
  const submodelMask = loader._buildAllowedClipnodeMask(clipnodes, 2);

  assert.deepEqual(Array.from(worldMask), [1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(submodelMask), [0, 0, 1, 0, 1]);
  assert.equal(loader._buildAllowedClipnodeMask(clipnodes, -1), null);
  assert.equal(loader._buildAllowedClipnodeMask(clipnodes, 99), null);
});

test('BSP29Loader inserts BRUSHLIST brushes into both leaves when they touch a BSP split plane', () => {
  const loader = new BSP29Loader();
  const loadmodel = new BrushModel();
  const frontLeaf = /** @type {import('../../source/engine/common/model/BSP.mjs').Node} */ ({
    contents: content.CONTENT_EMPTY,
    firstleafbrush: 0,
    numleafbrushes: 0,
  });
  const backLeaf = /** @type {import('../../source/engine/common/model/BSP.mjs').Node} */ ({
    contents: content.CONTENT_EMPTY,
    firstleafbrush: 0,
    numleafbrushes: 0,
  });

  loadmodel.planes = [createAxisPlane([1, 0, 0], 0, 0)];
  loadmodel.nodes = /** @type {import('../../source/engine/common/model/BSP.mjs').Node[]} */ ([{
    contents: 0,
    plane: loadmodel.planes[0],
    children: [frontLeaf, backLeaf],
  }]);
  loadmodel.leafs = /** @type {import('../../source/engine/common/model/BSP.mjs').Node[]} */ ([frontLeaf, backLeaf]);
  loadmodel.bspxlumps = {
    BRUSHLIST: {
      fileofs: 0,
      filelen: 44,
    },
  };

  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  view.setUint32(0, 1, true); // version
  view.setUint32(4, 0, true); // modelnum
  view.setUint32(8, 1, true); // numbrushes
  view.setUint32(12, 0, true); // numplanes
  view.setFloat32(16, 0, true); // mins.x touches the split plane exactly
  view.setFloat32(20, -16, true);
  view.setFloat32(24, -16, true);
  view.setFloat32(28, 16, true);
  view.setFloat32(32, 16, true);
  view.setFloat32(36, 16, true);
  view.setInt16(40, content.CONTENT_CLIP, true);
  view.setUint16(42, 0, true);

  withMockRegistry({
    Con: { Print() {}, DPrint() {} },
    Host: { frametime: 0.1 },
    SV: {},
  }, () => {
    loader._loadBrushList(loadmodel, buffer);
  });

  assert.equal(loadmodel.leafs[0].numleafbrushes, 1);
  assert.equal(loadmodel.leafs[1].numleafbrushes, 1);
  assert.deepEqual(loadmodel.leafbrushes, [0, 0]);
});

test('ServerCollision.hullPointContents treats masked foreign clipnodes as empty space', () => {
  const collision = new ServerCollision();
  const hull = {
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
    firstclipnode: 0,
    lastclipnode: 1,
    allowedClipNodes: Uint8Array.from([1, 0]),
    planes: [
      createAxisPlane([1, 0, 0], 50, 0),
      createAxisPlane([1, 0, 0], 0, 0),
    ],
    clipnodes: [
      { planenum: 0, children: [1, content.CONTENT_EMPTY] },
      { planenum: 1, children: [content.CONTENT_SOLID, content.CONTENT_SOLID] },
    ],
  };

  assert.equal(
    collision.hullPointContents(hull, hull.firstclipnode, new Vector(100, 0, 0)),
    content.CONTENT_EMPTY,
  );
});

test('Hull respects allowed clipnode masks in point and sweep tests', () => {
  const hull = Hull.fromModelHull({
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
    firstclipnode: 0,
    lastclipnode: 1,
    allowedClipNodes: Uint8Array.from([1, 0]),
    planes: [
      createAxisPlane([1, 0, 0], 50, 0),
      createAxisPlane([1, 0, 0], 0, 0),
    ],
    clipnodes: [
      { planenum: 0, children: [1, content.CONTENT_EMPTY] },
      { planenum: 1, children: [content.CONTENT_SOLID, content.CONTENT_SOLID] },
    ],
  });
  const trace = new Trace();
  const start = new Vector(100, 0, 0);
  const end = new Vector(110, 0, 0);

  trace.endpos.set(end);
  hull.check(0.0, 1.0, start, end, trace);

  assert.equal(hull.pointContents(start), content.CONTENT_EMPTY);
  assert.equal(trace.startsolid, false);
  assert.equal(trace.allsolid, false);
  assert.equal(trace.fraction, 1.0);
  assert.deepEqual([...trace.endpos], [...end]);
});

test('ServerCollision.pointContents respects world hull ownership masks', () => {
  const collision = new ServerCollision();
  const worldHull = {
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
    firstclipnode: 0,
    lastclipnode: 1,
    allowedClipNodes: Uint8Array.from([1, 0]),
    planes: [
      createAxisPlane([1, 0, 0], 50, 0),
      createAxisPlane([1, 0, 0], 0, 0),
    ],
    clipnodes: [
      { planenum: 0, children: [1, content.CONTENT_WATER] },
      { planenum: 1, children: [content.CONTENT_SOLID, content.CONTENT_SOLID] },
    ],
  };

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }))],
        worldmodel: { hulls: [worldHull] },
      },
    },
  }, () => {
    assert.equal(collision.staticWorldContents(new Vector(100, 0, 0)), content.CONTENT_EMPTY);
    assert.equal(collision.staticWorldContents(new Vector(-100, 0, 0)), content.CONTENT_WATER);
  });
});

test('ServerCollision.staticWorldContents uses brush-backed world solids before leaf contents', () => {
  const collision = new ServerCollision();
  const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
  const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [worldEdict],
        worldmodel: worldModel,
      },
    },
  }, () => {
    assert.equal(collision.staticWorldContents(new Vector(64, 0, 0)), content.CONTENT_SOLID);
    assert.equal(collision.staticWorldContents(new Vector(-100, 0, 0)), content.CONTENT_EMPTY);
  });
});

test('ServerCollision.staticWorldContents normalizes brush-backed current leaves to water', () => {
  const collision = new ServerCollision();
  const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
  worldModel.leafs[1].contents = content.CONTENT_CURRENT_DOWN;
  const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [worldEdict],
        worldmodel: worldModel,
      },
    },
  }, () => {
    assert.equal(collision.staticWorldContents(new Vector(-100, 0, 0)), content.CONTENT_WATER);
  });
});

test('ServerCollision.traceStaticWorldLine uses brush tracing for brush-backed world hull 0', () => {
  const collision = new ServerCollision();
  const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
  const worldEdict = createMockEdict(createMockEntity({
    origin: new Vector(),
    angles: new Vector(),
    solidType: solid.SOLID_BSP,
  }));

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [worldEdict],
        worldmodel: worldModel,
      },
    },
  }, () => {
    const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(100, 0, 0));

    assert.equal(trace.startsolid, false);
    assert.equal(trace.ent, worldEdict);
    assert.ok(trace.fraction < 1.0);
    assertNear(trace.endpos[0], 47.96875, 0.001);
  });
});

test('ServerCollision.move keeps legacy world hull traces out of foreign clipnode subtrees', () => {
  const collision = new ServerCollision();
  const worldHull = {
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
    firstclipnode: 0,
    lastclipnode: 1,
    allowedClipNodes: Uint8Array.from([1, 0]),
    planes: [
      createAxisPlane([1, 0, 0], 50, 0),
      createAxisPlane([1, 0, 0], 0, 0),
    ],
    clipnodes: [
      { planenum: 0, children: [1, content.CONTENT_EMPTY] },
      { planenum: 1, children: [content.CONTENT_SOLID, content.CONTENT_SOLID] },
    ],
  };
  const worldModel = new BrushModel();
  worldModel.name = 'legacy-world';
  worldModel.hulls = [worldHull, worldHull, worldHull];

  const worldEntity = createMockEntity({
    origin: new Vector(),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_NONE,
    solidType: solid.SOLID_BSP,
  });
  const worldEdict = createMockEdict(worldEntity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        hullForEntity() {
          return worldHull;
        },
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [worldEdict],
        worldmodel: worldModel,
      },
    },
  }, () => {
    const trace = collision.move(
      new Vector(0, 0, 0),
      Vector.origin,
      Vector.origin,
      new Vector(100, 0, 0),
      0,
      null,
    );

    assert.equal(trace.fraction, 1.0);
    assert.equal(trace.startsolid, false);
    assert.equal(trace.ent, null);
    assert.deepEqual([...trace.endpos], [100, 0, 0]);
  });
});

test('ServerCollision.traceWorldLine keeps legacy world hull traces out of foreign clipnode subtrees', () => {
  const collision = new ServerCollision();
  const worldHull = {
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
    firstclipnode: 0,
    lastclipnode: 1,
    allowedClipNodes: Uint8Array.from([1, 0]),
    planes: [
      createAxisPlane([1, 0, 0], 50, 0),
      createAxisPlane([1, 0, 0], 0, 0),
    ],
    clipnodes: [
      { planenum: 0, children: [1, content.CONTENT_EMPTY] },
      { planenum: 1, children: [content.CONTENT_SOLID, content.CONTENT_SOLID] },
    ],
  };
  const worldModel = new BrushModel();
  worldModel.name = 'legacy-world-line';
  worldModel.hulls = [worldHull, worldHull, worldHull];

  const worldEntity = createMockEntity({
    origin: new Vector(),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_NONE,
    solidType: solid.SOLID_BSP,
  });
  const worldEdict = createMockEdict(worldEntity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        hullForEntity() {
          return worldHull;
        },
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [worldEdict],
        worldmodel: worldModel,
      },
    },
  }, () => {
    const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(100, 0, 0));

    assert.equal(trace.fraction, 1.0);
    assert.equal(trace.startsolid, false);
    assert.equal(trace.ent, null);
    assert.deepEqual([...trace.endpos], [100, 0, 0]);
  });
});

describe('ServerCollision.move legacy hull recursion regressions', () => {
  test('keeps outer legacy hull split points stable across deeper recursion', () => {
  const collision = new ServerCollision();
  const worldHull = {
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
    firstclipnode: 0,
    lastclipnode: 2,
    planes: [
      createAxisPlane([1, 0, 0], 10, 0),
      createAxisPlane([1, 0, 0], 5, 0),
      createAxisPlane([1, 0, 0], 8, 0),
    ],
    clipnodes: [
      { planenum: 0, children: [2, 1] },
      { planenum: 1, children: [content.CONTENT_EMPTY, content.CONTENT_EMPTY] },
      { planenum: 2, children: [content.CONTENT_SOLID, content.CONTENT_EMPTY] },
    ],
  };
  const worldModel = new BrushModel();
  worldModel.name = 'legacy-midpoint-world';
  worldModel.hulls = [worldHull, worldHull, worldHull];

  const worldEntity = createMockEntity({
    origin: new Vector(),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_NONE,
    solidType: solid.SOLID_BSP,
  });
  const worldEdict = createMockEdict(worldEntity);

    withMockRegistry({
      Con: {
        Print() {},
        DPrint() {},
      },
      Host: { frametime: 0.1 },
      SV: {
        area: {
          hullForEntity() {
            return worldHull;
          },
          tree: {
            queryAABB() {
              return [];
            },
          },
        },
        server: {
          edicts: [worldEdict],
          worldmodel: worldModel,
        },
      },
    }, () => {
      const trace = collision.move(
        new Vector(0, 0, 0),
        Vector.origin,
        Vector.origin,
        new Vector(100, 0, 0),
        0,
        null,
      );

      assert.equal(trace.startsolid, false);
      assert.equal(trace.ent, worldEdict);
      assertNear(trace.fraction, 0.0996875, 0.000001);
      assertNear(trace.endpos[0], 9.96875, 0.000001);
      assertNear(trace.endpos[1], 0);
      assertNear(trace.endpos[2], 0);
    });
  });

  test('ServerCollision.move ignores zero-volume touched entities for boxed movers', () => {
    const collision = new ServerCollision();
    const worldModel = createBrushWorldModel({ center: [1024, 0, 0], halfExtents: [16, 16, 16] });
    const worldEdict = createMockEdict(createMockEntity({
      origin: new Vector(),
      solidType: solid.SOLID_BSP,
    }));
    const moverEdict = createMockEdict(createMockEntity({
      origin: new Vector(),
      mins: Pmove.PLAYER_MINS.copy(),
      maxs: Pmove.PLAYER_MAXS.copy(),
      solidType: solid.SOLID_BBOX,
    }));
    const zeroVolumeTouch = createMockEdict(createMockEntity({
      origin: new Vector(32, 0, 0),
      mins: new Vector(),
      maxs: new Vector(),
      solidType: solid.SOLID_BBOX,
    }));
    let narrowPhaseCalls = 0;

    withMockRegistry({
      Con: {
        Print() {},
        DPrint() {},
      },
      Host: { frametime: 0.1 },
      SV: {
        area: {
          tree: {
            queryAABB() {
              return [zeroVolumeTouch];
            },
          },
        },
        server: {
          edicts: [worldEdict],
          worldmodel: worldModel,
        },
      },
    }, () => {
      collision._traceTouch = () => {
        narrowPhaseCalls += 1;
        throw new Error('zero-volume touches should be skipped before narrow phase');
      };

      const trace = collision.move(
        new Vector(0, 0, 0),
        Pmove.PLAYER_MINS,
        Pmove.PLAYER_MAXS,
        new Vector(64, 0, 0),
        moveTypes.MOVE_NORMAL,
        moverEdict,
      );

      assert.equal(trace.fraction, 1.0);
      assert.equal(trace.ent, null);
      assert.equal(trace.startsolid, false);
      assert.equal(narrowPhaseCalls, 0);
      assert.deepEqual([...trace.endpos], [64, 0, 0]);
    });
  });

  test('ServerCollision.move asserts when a touched entity returns a malformed trace', () => {
    const collision = new ServerCollision();
    const worldModel = createBrushWorldModel({ center: [1024, 0, 0], halfExtents: [16, 16, 16] });
    const worldEdict = createMockEdict(createMockEntity({
      origin: new Vector(),
      solidType: solid.SOLID_BSP,
    }));
    const badTouch = createMockEdict(createMockEntity({
      origin: new Vector(32, 0, 0),
      mins: new Vector(-16, -16, -16),
      maxs: new Vector(16, 16, 16),
      solidType: solid.SOLID_BBOX,
    }));

    withMockRegistry({
      Con: {
        Print() {},
        DPrint() {},
      },
      Host: { frametime: 0.1 },
      SV: {
        area: {
          tree: {
            queryAABB() {
              return [badTouch];
            },
          },
        },
        server: {
          edicts: [worldEdict],
          worldmodel: worldModel,
        },
      },
    }, () => {
      const assertions = [];
      const originalConsoleAssert = console.assert;
      const originalClipMoveToEntityWithState = collision._clipMoveToEntityWithState.bind(collision);
      collision._clipMoveToEntityWithState = (state, start, mins, maxs, end) => {
        if (state.ent !== badTouch) {
          return originalClipMoveToEntityWithState(state, start, mins, maxs, end);
        }

        const invalidEnd = new Vector();
        invalidEnd[0] = Number.NaN;
        invalidEnd[1] = Number.NaN;
        invalidEnd[2] = Number.NaN;
        const invalidNormal = new Vector();
        invalidNormal[0] = Number.NaN;
        invalidNormal[1] = Number.NaN;
        invalidNormal[2] = Number.NaN;

        return {
          allsolid: false,
          startsolid: true,
          fraction: Number.NaN,
          endpos: invalidEnd,
          plane: { normal: invalidNormal, dist: Number.NaN },
          ent: badTouch,
          inopen: false,
          inwater: false,
        };
      };

      console.assert = (condition, ...args) => {
        assertions.push({ condition, args });
      };

      try {
        const trace = collision.move(
          new Vector(0, 0, 0),
          Pmove.PLAYER_MINS,
          Pmove.PLAYER_MAXS,
          new Vector(64, 0, 0),
          moveTypes.MOVE_NORMAL,
          null,
        );

        assert.equal(Number.isNaN(trace.fraction), true);
        assert.equal(Number.isNaN(trace.endpos[0]), true);
        assert.equal(trace.ent, badTouch);
        assert.equal(trace.startsolid, true);
      } finally {
        console.assert = originalConsoleAssert;
      }

      const malformedTraceAssertions = assertions.filter((entry) =>
        entry.condition === false
        && entry.args[0] === 'ServerCollision._traceTouch produced malformed trace',
      );

      assert.equal(malformedTraceAssertions.length, 1);
    });
  });
});

test('ServerCollision.move prefers a later legacy hull hit over an earlier unrotated BSP entity brush point hit', () => {
  const collision = new ServerCollision();
  const worldModel = createBoxBrushModel({ halfExtents: [16, 16, 16], name: 'world-brush', submodel: false });
  const entityModel = createBoxBrushModel({ halfExtents: [8, 8, 8], name: '*clip-brush' });
  const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));
  const bspEntity = createMockEntity({
    origin: new Vector(64, 0, 0),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  bspEntity.modelindex = 1;
  const bspEdict = createMockEdict(bspEntity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB() {
            return [bspEdict];
          },
        },
      },
      server: {
        edicts: [worldEdict, bspEdict],
        worldmodel: worldModel,
        models: [null, entityModel],
      },
    },
  }, () => {
    collision._traceBrushModel = (model, _start, _mins, _maxs, end) => {
      if (model === entityModel) {
        return {
          fraction: 0.25,
          allsolid: false,
          startsolid: false,
          endpos: new Vector(25, 0, 0),
          plane: { normal: new Vector(-1, 0, 0), dist: -25 },
          inopen: true,
          inwater: false,
        };
      }

      return {
        fraction: 1.0,
        allsolid: false,
        startsolid: false,
        endpos: end.copy(),
        plane: { normal: new Vector(), dist: 0.0 },
        inopen: true,
        inwater: false,
      };
    };

    collision._clipMoveToHullState = (state, _start, _mins, _maxs, end) => {
      if (state.ent !== bspEdict) {
        return {
          fraction: 1.0,
          allsolid: false,
          startsolid: false,
          endpos: end.copy(),
          plane: { normal: new Vector(), dist: 0.0 },
          ent: null,
          inopen: false,
          inwater: false,
        };
      }

      return {
        fraction: 0.5,
        allsolid: false,
        startsolid: false,
        endpos: new Vector(50, 0, 0),
        plane: { normal: new Vector(-1, 0, 0), dist: -50 },
        ent: bspEdict,
        inopen: true,
        inwater: false,
      };
    };

    const trace = collision.move(
      new Vector(0, 0, 0),
      Vector.origin,
      Vector.origin,
      new Vector(100, 0, 0),
      0,
      null,
    );

    assert.equal(trace.fraction, 0.5);
    assert.equal(trace.ent, bspEdict);
    assert.deepEqual([...trace.endpos], [50, 0, 0]);
  });
});

test('ServerCollision.clipMoveToEntity keeps rotated BSP point traces on the brush path', () => {
  const collision = new ServerCollision();
  const entityModel = createBoxBrushModel({ halfExtents: [8, 8, 8], name: '*rotating-brush' });
  const bspEntity = createMockEntity({
    origin: new Vector(32, 0, 0),
    angles: new Vector(0, 90, 0),
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  bspEntity.modelindex = 1;
  const bspEdict = createMockEdict(bspEntity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB() {
            return [];
          },
        },
      },
      server: {
        edicts: [createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }))],
        worldmodel: createBoxBrushModel({ halfExtents: [16, 16, 16], name: 'world-brush', submodel: false }),
        models: [null, entityModel],
      },
    },
  }, () => {
    collision._traceBrushModel = () => ({
      fraction: 0.25,
      allsolid: false,
      startsolid: false,
      endpos: new Vector(25, 0, 0),
      plane: { normal: new Vector(-1, 0, 0), dist: -25 },
      inopen: true,
      inwater: false,
    });

    collision._clipMoveToHullState = () => {
      throw new Error('rotated BSP point traces should not use legacy hull fallback');
    };

    const trace = collision.clipMoveToEntity(
      bspEdict,
      new Vector(0, 0, 0),
      Vector.origin,
      Vector.origin,
      new Vector(100, 0, 0),
    );

    assert.equal(trace.fraction, 0.25);
    assert.equal(trace.ent, bspEdict);
    assert.deepEqual([...trace.endpos], [25, 0, 0]);
  });
});

test('ServerCollision.move expands missile traces for monster broadphase and narrowphase', () => {
  const collision = new ServerCollision();
  const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));
  const monsterEntity = createMockEntity({
    origin: new Vector(50, 12, 0),
    mins: new Vector(-8, -8, -8),
    maxs: new Vector(8, 8, 8),
    movetype: moveType.MOVETYPE_WALK,
    solidType: solid.SOLID_BBOX,
    flagsValue: flags.FL_MONSTER,
  });
  monsterEntity.absmin = monsterEntity.origin.copy().add(monsterEntity.mins);
  monsterEntity.absmax = monsterEntity.origin.copy().add(monsterEntity.maxs);
  const monsterEdict = createMockEdict(monsterEntity);
  monsterEdict.num = 1;

  /** @type {{ boxmins: Vector, boxmaxs: Vector }[]} */
  const queryCalls = [];
  /** @type {{ ent: object, mins: Vector, maxs: Vector, end: Vector }[]} */
  const traceCalls = [];

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        tree: {
          queryAABB(boxmins, boxmaxs) {
            queryCalls.push({ boxmins: boxmins.copy(), boxmaxs: boxmaxs.copy() });

            const overlapsMonster = !(
              boxmins[0] > monsterEntity.absmax[0]
              || boxmins[1] > monsterEntity.absmax[1]
              || boxmins[2] > monsterEntity.absmax[2]
              || boxmaxs[0] < monsterEntity.absmin[0]
              || boxmaxs[1] < monsterEntity.absmin[1]
              || boxmaxs[2] < monsterEntity.absmin[2]
            );

            return overlapsMonster ? [monsterEdict] : [];
          },
        },
      },
      server: {
        edicts: [worldEdict, monsterEdict],
        worldmodel: null,
      },
    },
  }, () => {
    collision._clipMoveToEntityWithState = (state, start, mins, maxs, end) => {
      traceCalls.push({ ent: state.ent, mins: mins.copy(), maxs: maxs.copy(), end: end.copy() });

      if (state.ent === worldEdict) {
        return {
          fraction: 1.0,
          allsolid: false,
          startsolid: false,
          endpos: end.copy(),
          plane: { normal: new Vector(), dist: 0.0 },
          ent: null,
        };
      }

      return {
        fraction: 0.25,
        allsolid: false,
        startsolid: false,
        endpos: new Vector(25, 0, 0),
        plane: { normal: new Vector(-1, 0, 0), dist: 0.0 },
        ent: monsterEdict,
      };
    };

    const start = new Vector(0, 0, 0);
    const end = new Vector(100, 0, 0);

    const normalTrace = collision.move(start, Vector.origin, Vector.origin, end, moveTypes.MOVE_NORMAL, null);
    const normalQuery = queryCalls[0];
    const normalMonsterTrace = traceCalls.find((call) => call.ent === monsterEdict);

    assert.equal(normalTrace.fraction, 1.0);
    assert.equal(normalTrace.ent, null);
    assert.equal(normalMonsterTrace, undefined);
    assert.ok(normalQuery.boxmaxs[1] < monsterEntity.absmin[1]);

    queryCalls.length = 0;
    traceCalls.length = 0;

    const missileTrace = collision.move(start, Vector.origin, Vector.origin, end, moveTypes.MOVE_MISSILE, null);
    const missileQuery = queryCalls[0];
    const missileMonsterTrace = traceCalls.find((call) => call.ent === monsterEdict);

    assert.ok(missileQuery.boxmaxs[1] >= monsterEntity.absmin[1]);
    assert.notEqual(missileMonsterTrace, undefined);
    assert.deepEqual([...missileMonsterTrace.mins], [...ServerCollision.MISSILE_MINS]);
    assert.deepEqual([...missileMonsterTrace.maxs], [...ServerCollision.MISSILE_MAXS]);
    assert.equal(missileTrace.ent, monsterEdict);
    assert.equal(missileTrace.fraction, 0.25);
  });
});

test('ServerPhysics.checkVelocity clears NaNs and clamps to maxvelocity', () => {
  const serverPhysics = new ServerPhysics();
  const prints = [];
  const entity = createMockEntity({
    origin: new Vector(1, 2, 3),
    velocity: new Vector(5000, -5000, 1),
  });
  entity.origin[0] = Number.NaN;
  entity.velocity[2] = Number.NaN;
  entity.classname = 'test_entity';
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print(message) {
        prints.push(message);
      },
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      maxvelocity: { value: 2000 },
    },
  }, () => {
    serverPhysics.checkVelocity(edict);
  });

  assert.deepEqual([...edict.entity.velocity], [2000, -2000, 0]);
  assert.deepEqual([...edict.entity.origin], [0, 2, 3]);
  assert.equal(prints.length, 2);
  assert.equal(prints[0], 'Got a NaN origin on test_entity\n');
  assert.equal(prints[1], 'Got a NaN velocity on test_entity\n');
});

test('ServerPhysics.pushEntity uses MOVE_MISSILE and preserves origin on allsolid', () => {
  const serverPhysics = new ServerPhysics();
  const linkCalls = [];
  const moveCalls = [];
  const entity = createMockEntity({
    origin: new Vector(10, 20, 30),
    mins: new Vector(-1, -1, -1),
    maxs: new Vector(1, 1, 1),
    movetype: moveType.MOVETYPE_FLYMISSILE,
    solidType: solid.SOLID_BBOX,
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        linkEdict(linkedEdict) {
          linkCalls.push(linkedEdict);
        },
      },
      collision: {
        move(start, mins, maxs, end, type, passedict) {
          moveCalls.push({
            start: start.copy(),
            mins: mins.copy(),
            maxs: maxs.copy(),
            end: end.copy(),
            type,
            passedict,
          });
          return {
            allsolid: true,
            startsolid: true,
            fraction: 0.0,
            endpos: new Vector(999, 999, 999),
            ent: null,
          };
        },
      },
      server: {
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    const trace = serverPhysics.pushEntity(edict, new Vector(5, 0, 0));

    assert.equal(trace.allsolid, true);
  });

  assert.equal(moveCalls.length, 1);
  assert.equal(moveCalls[0].type, moveTypes.MOVE_MISSILE);
  assert.equal(moveCalls[0].passedict, edict);
  assert.deepEqual([...edict.entity.origin], [10, 20, 30]);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0], edict);
});

test('ServerMovement.checkBottom returns early when all four corners are solid', () => {
  const movement = new ServerMovement();
  const moveCalls = [];
  const cornerChecks = [];
  const entity = createMockEntity({
    origin: new Vector(64, 64, 32),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        pointContents(point) {
          cornerChecks.push(point.copy());
          return content.CONTENT_SOLID;
        },
        move(...args) {
          moveCalls.push(args);
          return null;
        },
      },
    },
  }, () => {
    assert.equal(movement.checkBottom(edict), true);
  });

  assert.equal(cornerChecks.length, 4);
  assert.equal(moveCalls.length, 0);
});

test('ServerMovement.movestep preserves horizontal progress on partial ground fallback', () => {
  const movement = new ServerMovement();
  const linkCalls = [];
  const moveCalls = [];
  const entity = createMockEntity({
    origin: new Vector(10, 20, 30),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    flagsValue: flags.FL_PARTIALGROUND | flags.FL_ONGROUND,
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        linkEdict(linkedEdict, touchTriggers) {
          linkCalls.push({ linkedEdict, touchTriggers });
        },
      },
      collision: {
        move(start, mins, maxs, end, type, passedict) {
          moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });
          return {
            allsolid: false,
            startsolid: false,
            fraction: 1.0,
            endpos: end.copy(),
            ent: null,
          };
        },
      },
    },
  }, () => {
    const moved = movement.movestep(edict, new Vector(4, -6, 0), true);
    assert.equal(moved, true);
  });

  assert.equal(moveCalls.length, 1);
  assert.deepEqual([...edict.entity.origin], [14, 14, 30]);
  assert.equal((edict.entity.flags & flags.FL_ONGROUND) !== 0, false);
  assert.equal((edict.entity.flags & flags.FL_PARTIALGROUND) !== 0, true);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].linkedEdict, edict);
  assert.equal(linkCalls[0].touchTriggers, true);
});

test('ServerPhysics.flyMove clips against a wall and records steptrace', () => {
  const serverPhysics = new ServerPhysics();
  const moveCalls = [];
  const impacts = [];
  const blocker = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
  const entity = createMockEntity({
    origin: new Vector(0, 0, 0),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    velocity: new Vector(10, 0, 0),
    solidType: solid.SOLID_BBOX,
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        move(start, mins, maxs, end, type, passedict) {
          moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });
          return {
            allsolid: false,
            startsolid: false,
            fraction: 0.5,
            endpos: new Vector(5, 0, 0),
            plane: { normal: new Vector(-1, 0, 0), dist: 5 },
            ent: blocker,
          };
        },
      },
      server: {
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.impact = (e1, e2, pushVector) => {
      impacts.push({ e1, e2, pushVector: pushVector.copy() });
    };

    const result = serverPhysics.flyMove(edict, 1.0);

    assert.equal(result.blocked, BlockedFlags.WALL);
    assert.equal(result.steptrace?.ent, blocker);
  });

  assert.equal(moveCalls.length, 1);
  assert.deepEqual([...edict.entity.origin], [5, 0, 0]);
  assert.deepEqual([...edict.entity.velocity], [0, 0, 0]);
  assert.equal(impacts.length, 1);
  assert.deepEqual([...impacts[0].pushVector], [10, 0, 0]);
});

test('ServerPhysics.flyMove stops in a two-plane crease', () => {
  const serverPhysics = new ServerPhysics();
  let moveCallCount = 0;
  const blockerA = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
  const blockerB = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
  const entity = createMockEntity({
    origin: new Vector(0, 0, 0),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    velocity: new Vector(10, 10, 0),
    solidType: solid.SOLID_BBOX,
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        move() {
          moveCallCount += 1;

          if (moveCallCount === 1) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.0,
              endpos: new Vector(0, 0, 0),
              plane: { normal: new Vector(-1, 0, 0), dist: 0 },
              ent: blockerA,
            };
          }

          return {
            allsolid: false,
            startsolid: false,
            fraction: 0.0,
            endpos: new Vector(0, 0, 0),
            plane: { normal: new Vector(0, -1, 0), dist: 0 },
            ent: blockerB,
          };
        },
      },
      server: {
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.impact = () => {};

    const result = serverPhysics.flyMove(edict, 1.0);

    assert.equal(result.blocked, BlockedFlags.WALL);
    assert.equal(result.steptrace?.ent, blockerB);
  });

  assert.equal(moveCallCount, 2);
  assert.deepEqual([...edict.entity.origin], [0, 0, 0]);
  assert.deepEqual([...edict.entity.velocity], [0, 0, 0]);
});

test('ServerPhysics.flyMove dead-stops when clipped by three non-coplanar planes', () => {
  const serverPhysics = new ServerPhysics();
  let moveCallCount = 0;
  const blockerA = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
  const blockerB = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
  const blockerC = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
  const entity = createMockEntity({
    origin: new Vector(0, 0, 0),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    velocity: new Vector(10, 10, 10),
    solidType: solid.SOLID_BBOX,
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        move() {
          moveCallCount += 1;

          if (moveCallCount === 1) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.0,
              endpos: new Vector(0, 0, 0),
              plane: { normal: new Vector(-1, 0, 0), dist: 0 },
              ent: blockerA,
            };
          }

          if (moveCallCount === 2) {
            return {
              allsolid: false,
              startsolid: false,
              fraction: 0.0,
              endpos: new Vector(0, 0, 0),
              plane: { normal: new Vector(0, -1, 0), dist: 0 },
              ent: blockerB,
            };
          }

          return {
            allsolid: false,
            startsolid: false,
            fraction: 0.0,
            endpos: new Vector(0, 0, 0),
            plane: { normal: new Vector(0, 0, -1), dist: 0 },
            ent: blockerC,
          };
        },
      },
      server: {
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.impact = () => {};

    const result = serverPhysics.flyMove(edict, 1.0);

    assert.equal(result.blocked, 7);
    assert.equal(result.steptrace?.ent, blockerB);
  });

  assert.equal(moveCallCount, 3);
  assert.deepEqual([...edict.entity.origin], [0, 0, 0]);
  assert.deepEqual([...edict.entity.velocity], [0, 0, 0]);
});

test('ServerPhysics.flyMove keeps state finite when a degenerate wall normal repeats', () => {
  const serverPhysics = new ServerPhysics();
  let moveCallCount = 0;
  const impacts = [];
  const blocker = createMockEdict(createMockEntity({ solidType: solid.SOLID_BBOX }));
  const entity = createMockEntity({
    origin: new Vector(5, 6, 7),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    velocity: new Vector(3, 4, 0),
    solidType: solid.SOLID_BBOX,
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        move() {
          moveCallCount += 1;

          return {
            allsolid: false,
            startsolid: false,
            fraction: 0.0,
            endpos: new Vector(5, 6, 7),
            plane: { normal: new Vector(0, 0, 0), dist: 0 },
            ent: blocker,
          };
        },
      },
      server: {
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.impact = (_e1, _e2, pushVector) => {
      impacts.push(pushVector.copy());
    };

    const result = serverPhysics.flyMove(edict, 1.0);

    assert.equal(result.blocked, BlockedFlags.WALL);
    assert.equal(result.steptrace?.ent, blocker);
  });

  assert.equal(moveCallCount, MAX_BUMP_COUNT);
  assert.equal(impacts.length, MAX_BUMP_COUNT);
  assert.deepEqual([...edict.entity.origin], [5, 6, 7]);
  assert.deepEqual([...edict.entity.velocity], [3, 4, 0]);
  for (const value of edict.entity.velocity) {
    assert.equal(Number.isFinite(value), true);
  }
});

test('ServerMovement.stepDirection restores origin when yaw delta stays too large', () => {
  const movement = new ServerMovement();
  const linkCalls = [];
  const entity = createMockEntity({
    origin: new Vector(10, 20, 30),
    angles: new Vector(0, 200, 0),
  });
  entity.yaw_speed = 0;
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        linkEdict(linkedEdict, touchTriggers) {
          linkCalls.push({ linkedEdict, touchTriggers });
        },
      },
    },
  }, () => {
    movement.movestep = (ent, move) => {
      ent.entity.origin = ent.entity.origin.copy().add(move);
      return true;
    };

    const stepped = movement.stepDirection(edict, 0, 8);
    assert.equal(stepped, true);
  });

  assert.deepEqual([...edict.entity.origin], [10, 20, 30]);
  assert.equal(edict.entity.ideal_yaw, 0);
  assert.equal(edict.entity.angles[1], 200);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].linkedEdict, edict);
  assert.equal(linkCalls[0].touchTriggers, true);
});

test('ServerPhysics.pushEntity uses MOVE_NOMONSTERS for trigger and non-solid entities', () => {
  const serverPhysics = new ServerPhysics();
  const moveCalls = [];
  const touchCalls = [];

  const touchedEntity = createMockEntity({ solidType: solid.SOLID_BBOX });
  touchedEntity.touch = (other) => {
    touchCalls.push(['target', other]);
  };
  const touchedEdict = createMockEdict(touchedEntity);

  /** @param {number} solidType */
  const runCase = (solidType) => {
    const entity = createMockEntity({
      origin: new Vector(1, 2, 3),
      mins: new Vector(-1, -1, -1),
      maxs: new Vector(1, 1, 1),
      solidType,
    });
    entity.touch = (other) => {
      touchCalls.push([solidType, other]);
    };
    const edict = createMockEdict(entity);

    withMockRegistry({
      Con: {
        Print() {},
        DPrint() {},
      },
      Host: { frametime: 0.1 },
      SV: {
        area: {
          linkEdict() {},
        },
        collision: {
          move(start, mins, maxs, end, type, passedict) {
            moveCalls.push({ solidType, type, passedict, end: end.copy() });
            return {
              allsolid: false,
              startsolid: false,
              fraction: 1.0,
              endpos: end.copy(),
              plane: { normal: new Vector(), dist: 0.0 },
              ent: touchedEdict,
            };
          },
        },
        server: {
          gameAPI: { time: 0 },
        },
      },
    }, () => {
      serverPhysics.pushEntity(edict, new Vector(4, 0, 0));
    });
  };

  runCase(solid.SOLID_TRIGGER);
  runCase(solid.SOLID_NOT);

  assert.equal(moveCalls.length, 2);
  assert.equal(moveCalls[0].type, moveTypes.MOVE_NOMONSTERS);
  assert.equal(moveCalls[1].type, moveTypes.MOVE_NOMONSTERS);
  assert.equal(touchCalls.length, 3);
  assert.equal(touchCalls[0][0], solid.SOLID_TRIGGER);
  assert.equal(touchCalls[1][0], 'target');
  assert.equal(touchCalls[2][0], 'target');
});

test('ServerPhysics.checkAllEnts skips static entities and reports invalid dynamic positions', () => {
  const serverPhysics = new ServerPhysics();
  const prints = [];
  const tested = [];

  const worldEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NONE }));
  const freeEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_WALK }));
  freeEdict.isFree = () => true;
  const pushEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_PUSH }));
  const noneEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NONE }));
  const noclipEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NOCLIP }));
  const walkEntity = createMockEntity({ movetype: moveType.MOVETYPE_WALK });
  const walkEdict = createMockEdict(walkEntity);
  walkEdict.num = 5;

  withMockRegistry({
    Con: {
      Print(message) {
        prints.push(message);
      },
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        testEntityPosition(edict) {
          tested.push(edict);
          return edict === walkEdict;
        },
      },
      server: {
        num_edicts: 6,
        edicts: [worldEdict, freeEdict, pushEdict, noneEdict, noclipEdict, walkEdict],
      },
    },
  }, () => {
    serverPhysics.checkAllEnts();
  });

  assert.deepEqual(tested, [walkEdict]);
  assert.deepEqual(prints, ['entity in invalid position\n']);
});

test('ServerMovement.moveToGoal returns false when already close enough to a non-world enemy goal', () => {
  const movement = new ServerMovement();
  const actor = createMockEdict(createMockEntity({ flagsValue: flags.FL_ONGROUND }));
  const goal = createMockEdict(createMockEntity());
  const enemy = createMockEdict(createMockEntity());
  enemy.isWorld = () => false;

  actor.entity.goalentity = { edict: goal };
  actor.entity.enemy = { edict: enemy };

  movement.closeEnough = () => true;
  movement.stepDirection = () => {
    throw new Error('stepDirection should not run when already close enough');
  };
  movement.newChaseDir = () => {
    throw new Error('newChaseDir should not run when already close enough');
  };

  assert.equal(movement.moveToGoal(actor, 16), false);
});

test('ServerMovement.moveToGoal falls back to newChaseDir when stepDirection fails', () => {
  const movement = new ServerMovement();
  const actor = createMockEdict(createMockEntity({ flagsValue: flags.FL_ONGROUND }));
  const goal = createMockEdict(createMockEntity({ origin: new Vector(100, 50, 0) }));
  const explicitTarget = new Vector(12, 34, 56);
  const originalRandom = Math.random;
  const calls = [];

  actor.entity.goalentity = { edict: goal };
  actor.entity.enemy = null;
  actor.entity.ideal_yaw = 90;

  movement.stepDirection = (ent, yaw, dist) => {
    calls.push({ kind: 'step', ent, yaw, dist });
    return false;
  };
  movement.newChaseDir = (ent, target, dist) => {
    calls.push({ kind: 'chase', ent, target: target.copy(), dist });
  };

  Math.random = () => 0.0;
  try {
    assert.equal(movement.moveToGoal(actor, 24, explicitTarget), true);
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'step');
  assert.equal(calls[0].yaw, 90);
  assert.equal(calls[0].dist, 24);
  assert.equal(calls[1].kind, 'chase');
  assert.deepEqual([...calls[1].target], [...explicitTarget]);
  assert.equal(calls[1].dist, 24);
});

test('ServerMovement.newChaseDir restores old yaw and marks partial ground when every direction fails', () => {
  const movement = new ServerMovement();
  const actor = createMockEdict(createMockEntity({
    origin: new Vector(0, 0, 0),
    flagsValue: flags.FL_ONGROUND,
  }));
  const attemptedDirs = [];
  const originalRandom = Math.random;

  actor.entity.ideal_yaw = 90;

  movement.stepDirection = (_actor, dir) => {
    attemptedDirs.push(dir);
    return false;
  };
  movement.checkBottom = () => false;

  let randomCall = 0;
  Math.random = () => {
    randomCall += 1;
    return 0.0;
  };
  try {
    movement.newChaseDir(actor, new Vector(100, 100, 0), 12);
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(randomCall, 2);
  assert.equal(actor.entity.ideal_yaw, 90);
  assert.equal((actor.entity.flags & flags.FL_PARTIALGROUND) !== 0, true);
  assert.deepEqual(attemptedDirs, [45, 0, 90, 90, 315, 225, 180, 135, 90, 45, 0, 270]);
});

test('ServerMovement.walkMove returns false when entity is not grounded, flying, or swimming', () => {
  const movement = new ServerMovement();
  const actor = createMockEdict(createMockEntity({ flagsValue: 0 }));

  movement.movestep = () => {
    throw new Error('movestep should not run when walkMove gating fails');
  };

  assert.equal(movement.walkMove(actor, 90, 16), false);
});

test('ServerMovement.changeYaw wraps and clamps using the shortest turn direction', () => {
  const movement = new ServerMovement();
  const actor = createMockEdict(createMockEntity({ angles: new Vector(0, 350, 0) }));
  actor.entity.yaw_speed = 5;
  actor.entity.ideal_yaw = 10;

  assert.equal(movement.changeYaw(actor), 355);

  actor.entity.angles[1] = 10;
  actor.entity.ideal_yaw = 350;

  assert.equal(movement.changeYaw(actor), 5);
});

test('ServerPhysics.runThink returns false when the entity frees itself during think', () => {
  const serverPhysics = new ServerPhysics();
  let freed = false;
  let thinkCalls = 0;
  const entity = createMockEntity();
  entity.nextthink = 0.5;
  entity.think = () => {
    thinkCalls += 1;
    freed = true;
  };
  const edict = createMockEdict(entity);
  edict.isFree = () => freed;

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      server: {
        time: 1.0,
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    const result = serverPhysics.runThink(edict);

    assert.equal(result, false);
    assert.equal(registry.SV.server.gameAPI.time, 1.0);
  });

  assert.equal(thinkCalls, 1);
  assert.equal(entity.nextthink, 0.0);
});

test('ServerPhysics.runThink executes multiple thinks that become due within one frame', () => {
  const serverPhysics = new ServerPhysics();
  const thinkTimes = [];
  const entity = createMockEntity();
  entity.nextthink = 1.05;
  entity.think = () => {
    thinkTimes.push(registry.SV.server.gameAPI.time);
    entity.nextthink = thinkTimes.length === 1 ? 1.15 : 0.0;
  };
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.2 },
    SV: {
      server: {
        time: 1.0,
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    const result = serverPhysics.runThink(edict);

    assert.equal(result, true);
    assert.equal(registry.SV.server.gameAPI.time, 1.15);
  });

  assert.deepEqual(thinkTimes, [1.05, 1.15]);
  assert.equal(entity.nextthink, 0.0);
});

test('ServerMovement.checkBottom rejects support when a corner drops more than step size', () => {
  const movement = new ServerMovement();
  const moveCalls = [];
  let pointContentCalls = 0;
  const entity = createMockEntity({
    origin: new Vector(64, 64, 32),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        pointContents() {
          pointContentCalls += 1;
          return content.CONTENT_EMPTY;
        },
        move(start, mins, maxs, end, type, passedict) {
          moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });

          if (moveCalls.length === 1) {
            return {
              fraction: 0.5,
              endpos: new Vector(start[0], start[1], 0),
            };
          }

          return {
            fraction: 0.5,
            endpos: new Vector(start[0], start[1], -19),
          };
        },
      },
    },
  }, () => {
    assert.equal(movement.checkBottom(edict), false);
  });

  assert.equal(pointContentCalls, 1);
  assert.equal(moveCalls.length, 2);
});

test('ServerMovement.movestep returns false when both the raised trace and retry stay startsolid', () => {
  const movement = new ServerMovement();
  const linkCalls = [];
  const moveCalls = [];
  const entity = createMockEntity({
    origin: new Vector(10, 20, 30),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    flagsValue: flags.FL_ONGROUND,
  });
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        linkEdict(linkedEdict, touchTriggers) {
          linkCalls.push({ linkedEdict, touchTriggers });
        },
      },
      collision: {
        move(start, mins, maxs, end, type, passedict) {
          moveCalls.push({ start: start.copy(), end: end.copy(), type, passedict });

          return {
            allsolid: false,
            startsolid: true,
            fraction: 0.0,
            endpos: end.copy(),
            ent: null,
          };
        },
      },
    },
  }, () => {
    assert.equal(movement.movestep(edict, new Vector(4, -6, 0), true), false);
  });

  assert.equal(moveCalls.length, 2);
  assert.deepEqual([...edict.entity.origin], [10, 20, 30]);
  assert.equal(linkCalls.length, 0);
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

test('ServerPhysics.pushMove restores earlier riders when a later rider blocks the push', () => {
  const linkCalls = [];
  const blockedCalls = [];

  const pusherEntity = createMockEntity({
    origin: new Vector(0, 0, 0),
    mins: new Vector(-64, -64, -16),
    maxs: new Vector(64, 64, 16),
    velocity: new Vector(0, 0, 100),
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  pusherEntity.blocked = (blockingEntity) => {
    blockedCalls.push(blockingEntity);
  };

  const riderAEntity = createMockEntity({
    origin: new Vector(0, 0, 32),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    movetype: moveType.MOVETYPE_WALK,
    solidType: solid.SOLID_BBOX,
    flagsValue: flags.FL_ONGROUND,
    groundentity: pusherEntity,
  });
  const riderBEntity = createMockEntity({
    origin: new Vector(24, 0, 32),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
    movetype: moveType.MOVETYPE_WALK,
    solidType: solid.SOLID_BBOX,
    flagsValue: flags.FL_ONGROUND,
    groundentity: pusherEntity,
  });

  const worldEdict = createMockEdict(createMockEntity());
  const pusherEdict = createMockEdict(pusherEntity);
  const riderAEdict = createMockEdict(riderAEntity);
  riderAEdict.num = 2;
  const riderBEdict = createMockEdict(riderBEntity);
  riderBEdict.num = 3;

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      maxvelocity: { value: 2000 },
      area: {
        linkEdict(edict) {
          edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
          edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
          linkCalls.push(edict);
        },
      },
      collision: {
        move(start, mins, maxs, end) {
          return {
            allsolid: false,
            startsolid: false,
            fraction: 1.0,
            endpos: end.copy(),
            ent: null,
          };
        },
        testEntityPosition(edict) {
          return edict === riderBEdict;
        },
      },
      server: {
        time: 0,
        num_edicts: 4,
        edicts: [worldEdict, pusherEdict, riderAEdict, riderBEdict],
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    const serverPhysics = new ServerPhysics();
    serverPhysics.pushMove(pusherEdict, 0.1);
  });

  assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 0]);
  assert.deepEqual([...riderAEdict.entity.origin], [0, 0, 32]);
  assert.deepEqual([...riderBEdict.entity.origin], [24, 0, 32]);
  assert.equal(blockedCalls.length, 1);
  assert.equal(blockedCalls[0], riderBEdict.entity);
  assert.equal(pusherEdict.entity.ltime, 0);
  assert.ok(linkCalls.length >= 5);
});

test('ServerPhysics.pushMove collapses trigger bounds instead of rolling back the pusher', () => {
  const blockedCalls = [];

  const pusherEntity = createMockEntity({
    origin: new Vector(0, 0, 0),
    mins: new Vector(-64, -64, -16),
    maxs: new Vector(64, 64, 16),
    velocity: new Vector(0, 0, 100),
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  pusherEntity.blocked = (blockingEntity) => {
    blockedCalls.push(blockingEntity);
  };

  const triggerEntity = createMockEntity({
    origin: new Vector(0, 0, 32),
    mins: new Vector(-8, -8, -8),
    maxs: new Vector(8, 8, 8),
    movetype: moveType.MOVETYPE_STEP,
    solidType: solid.SOLID_TRIGGER,
    flagsValue: flags.FL_ONGROUND,
    groundentity: pusherEntity,
  });

  const worldEdict = createMockEdict(createMockEntity());
  const pusherEdict = createMockEdict(pusherEntity);
  const triggerEdict = createMockEdict(triggerEntity);
  triggerEdict.num = 2;

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      maxvelocity: { value: 2000 },
      area: {
        linkEdict(edict) {
          edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
          edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
        },
      },
      collision: {
        move(start, mins, maxs, end) {
          return {
            allsolid: false,
            startsolid: false,
            fraction: 1.0,
            endpos: end.copy(),
            ent: null,
          };
        },
        testEntityPosition(edict) {
          return edict === triggerEdict;
        },
      },
      server: {
        time: 0,
        num_edicts: 3,
        edicts: [worldEdict, pusherEdict, triggerEdict],
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    const serverPhysics = new ServerPhysics();
    serverPhysics.pushMove(pusherEdict, 0.1);
  });

  assert.deepEqual([...pusherEdict.entity.origin], [0, 0, 10]);
  assert.deepEqual([...triggerEdict.entity.origin], [0, 0, 42]);
  assert.deepEqual([...triggerEdict.entity.mins], [0, 0, -8]);
  assert.deepEqual([...triggerEdict.entity.maxs], [0, 0, -8]);
  assert.equal(blockedCalls.length, 0);
  assert.equal(pusherEdict.entity.ltime, 0.1);
});

test('ServerPhysics.pushMove rotates grounded riders around the pusher yaw axis', () => {
  withMockServerPhysics(({ serverPhysics, pusherEdict, riderEdict, moveCalls, testCalls, blockedCalls }) => {
    pusherEdict.entity.velocity.clear();
    pusherEdict.entity.avelocity = new Vector(0, 900, 0);
    riderEdict.entity.origin = new Vector(32, 0, 32);
    riderEdict.entity.angles = new Vector(0, 0, 0);
    riderEdict.entity.absmin = riderEdict.entity.origin.copy().add(riderEdict.entity.mins);
    riderEdict.entity.absmax = riderEdict.entity.origin.copy().add(riderEdict.entity.maxs);

    const rotatedOffset = new Vector(0, 0, 1).rotatePointAroundVector(new Vector(32, 0, 32), 90);
    const expectedOrigin = rotatedOffset;

    serverPhysics.pushMove(pusherEdict, 0.1);

    assert.equal(moveCalls.length, 1);
    assertNear(moveCalls[0].end[0], expectedOrigin[0], 1e-9);
    assertNear(moveCalls[0].end[1], expectedOrigin[1], 1e-9);
    assertNear(moveCalls[0].end[2], expectedOrigin[2], 1e-9);
    assertNear(riderEdict.entity.origin[0], expectedOrigin[0], 1e-9);
    assertNear(riderEdict.entity.origin[1], expectedOrigin[1], 1e-9);
    assertNear(riderEdict.entity.origin[2], expectedOrigin[2], 1e-9);
    assert.deepEqual([...riderEdict.entity.angles], [0, 90, 0]);
    assert.deepEqual([...pusherEdict.entity.angles], [0, 90, 0]);
    assert.equal(testCalls.length, 1);
    assert.equal(testCalls[0], riderEdict);
    assert.equal(blockedCalls.length, 0);
  });
});

test('ServerPhysics.physicsPusher limits movement to nextthink and then runs think', () => {
  const serverPhysics = new ServerPhysics();
  const moveTimes = [];
  let observedGameTime = -1;
  let thinkCalls = 0;
  const entity = createMockEntity({
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  entity.ltime = 1.0;
  entity.nextthink = 1.05;
  entity.think = () => {
    thinkCalls += 1;
  };
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      server: {
        time: 7.0,
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.pushMove = (pusher, movetime) => {
      moveTimes.push(movetime);
      pusher.entity.ltime += movetime;
    };

    serverPhysics.physicsPusher(edict);

    observedGameTime = registry.SV.server.gameAPI.time;
  });

  assert.equal(moveTimes.length, 1);
  assertNear(moveTimes[0], 0.05, 1e-9);
  assert.equal(entity.ltime, 1.05);
  assert.equal(entity.nextthink, 0.0);
  assert.equal(thinkCalls, 1);
  assert.equal(observedGameTime, 7.0);
});

test('ServerPhysics.physicsPusher keeps think deferred when nextthink is beyond this frame', () => {
  const serverPhysics = new ServerPhysics();
  const moveTimes = [];
  let observedGameTime = -1;
  let thinkCalls = 0;
  const entity = createMockEntity({
    movetype: moveType.MOVETYPE_PUSH,
    solidType: solid.SOLID_BSP,
  });
  entity.ltime = 1.0;
  entity.nextthink = 1.3;
  entity.think = () => {
    thinkCalls += 1;
  };
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      server: {
        time: 8.0,
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.pushMove = (pusher, movetime) => {
      moveTimes.push(movetime);
      pusher.entity.ltime += movetime;
    };

    serverPhysics.physicsPusher(edict);

    observedGameTime = registry.SV.server.gameAPI.time;
  });

  assert.equal(moveTimes.length, 1);
  assertNear(moveTimes[0], 0.1, 1e-9);
  assertNear(entity.ltime, 1.1, 1e-9);
  assert.equal(entity.nextthink, 1.3);
  assert.equal(thinkCalls, 0);
  assert.equal(observedGameTime, 0);
});

test('ServerPhysics.checkStuck restores oldorigin when the saved position is clear', () => {
  const serverPhysics = new ServerPhysics();
  const prints = [];
  const linkCalls = [];
  let testCallCount = 0;
  const entity = createMockEntity({
    origin: new Vector(10, 20, 30),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  entity.oldorigin = new Vector(1, 2, 3);
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint(message) {
        prints.push(message);
      },
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        linkEdict(linkedEdict, touchTriggers) {
          linkCalls.push({ linkedEdict, touchTriggers });
        },
      },
      collision: {
        testEntityPosition() {
          testCallCount += 1;
          return testCallCount === 1;
        },
      },
    },
  }, () => {
    serverPhysics.checkStuck(edict);
  });

  assert.equal(testCallCount, 2);
  assert.deepEqual([...edict.entity.origin], [1, 2, 3]);
  assert.deepEqual(prints, ['Unstuck.\n']);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].linkedEdict, edict);
  assert.equal(linkCalls[0].touchTriggers, true);
});

test('ServerPhysics.checkStuck reports failure after exhausting all nudges', () => {
  const serverPhysics = new ServerPhysics();
  const prints = [];
  const linkCalls = [];
  let testCallCount = 0;
  const entity = createMockEntity({
    origin: new Vector(10, 20, 30),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  entity.oldorigin = new Vector(1, 2, 3);
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint(message) {
        prints.push(message);
      },
    },
    Host: { frametime: 0.1 },
    SV: {
      area: {
        linkEdict(linkedEdict, touchTriggers) {
          linkCalls.push({ linkedEdict, touchTriggers });
        },
      },
      collision: {
        testEntityPosition() {
          testCallCount += 1;
          return true;
        },
      },
    },
  }, () => {
    serverPhysics.checkStuck(edict);
  });

  assert.equal(testCallCount, 164);
  assert.deepEqual(prints, ['player is stuck.\n']);
  assert.equal(linkCalls.length, 0);
  assert.deepEqual([...edict.entity.oldorigin], [1, 2, 3]);
});

test('ServerPhysics.checkWater leaves entities dry when feet probe is not water', () => {
  const serverPhysics = new ServerPhysics();
  const probes = [];
  const entity = createMockEntity({
    origin: new Vector(10, 20, 30),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  entity.view_ofs = new Vector(0, 0, 22);
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      collision: {
        pointContents(point) {
          probes.push(point.copy());
          return content.CONTENT_EMPTY;
        },
      },
    },
  }, () => {
    assert.equal(serverPhysics.checkWater(edict), false);
  });

  assert.equal(entity.waterlevel, 0);
  assert.equal(entity.watertype, content.CONTENT_EMPTY);
  assert.equal(probes.length, 1);
  assert.deepEqual([...probes[0]], [10, 20, 7]);
});

test('ServerPhysics.checkWater distinguishes feet waist and head submersion', () => {
  const serverPhysics = new ServerPhysics();
  const feetEntity = createMockEntity({
    origin: new Vector(0, 0, 40),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  feetEntity.view_ofs = new Vector(0, 0, 22);
  const waistEntity = createMockEntity({
    origin: new Vector(0, 0, 40),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  waistEntity.view_ofs = new Vector(0, 0, 22);
  const headEntity = createMockEntity({
    origin: new Vector(0, 0, 40),
    mins: new Vector(-16, -16, -24),
    maxs: new Vector(16, 16, 32),
  });
  headEntity.view_ofs = new Vector(0, 0, 22);

  const runCase = (entity, contents) => {
    let probeIndex = 0;

    withMockRegistry({
      Con: {
        Print() {},
        DPrint() {},
      },
      Host: { frametime: 0.1 },
      SV: {
        collision: {
          pointContents() {
            const result = contents[probeIndex];
            probeIndex += 1;
            return result;
          },
        },
      },
    }, () => {
      serverPhysics.checkWater(createMockEdict(entity));
    });
  };

  runCase(feetEntity, [content.CONTENT_WATER, content.CONTENT_EMPTY]);
  runCase(waistEntity, [content.CONTENT_WATER, content.CONTENT_WATER, content.CONTENT_EMPTY]);
  const headResult = (() => {
    let result;

    withMockRegistry({
      Con: {
        Print() {},
        DPrint() {},
      },
      Host: { frametime: 0.1 },
      SV: {
        collision: {
          pointContents() {
            return content.CONTENT_WATER;
          },
        },
      },
    }, () => {
      result = serverPhysics.checkWater(createMockEdict(headEntity));
    });

    return result;
  })();

  assert.equal(feetEntity.waterlevel, 1);
  assert.equal(feetEntity.watertype, content.CONTENT_WATER);
  assert.equal(waistEntity.waterlevel, 2);
  assert.equal(waistEntity.watertype, content.CONTENT_WATER);
  assert.equal(headEntity.waterlevel, 3);
  assert.equal(headEntity.watertype, content.CONTENT_WATER);
  assert.equal(headResult, true);
});

test('ServerPhysics.addGravity and addBoyancy accumulate using entity gravity and frametime', () => {
  const serverPhysics = new ServerPhysics();
  const entity = createMockEntity({
    velocity: new Vector(0, 0, 10),
  });
  entity.gravity = 0.5;
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.25 },
    SV: {
      gravity: { value: 800 },
    },
  }, () => {
    serverPhysics.addGravity(edict);
    serverPhysics.addBuoyancy(edict);
  });

  assert.deepEqual([...entity.velocity], [0, 0, -88]);
});

test('ServerPhysics.clipVelocity zeroes tiny residuals after clipping against an angled plane', () => {
  const serverPhysics = new ServerPhysics();
  const out = new Vector();

  serverPhysics.clipVelocity(
    new Vector(1, -1, 0.05),
    new Vector(0, 1, 0),
    out,
    1.0,
  );

  assertNear(out[0], 1.0, 1e-9);
  assert.equal(out[1], 0.0);
  assert.equal(out[2], 0.0);
});

test('ServerPhysics.physicsToss keeps a bounce entity moving after a hard floor impact', () => {
  const serverPhysics = new ServerPhysics();
  const entity = createMockEntity({
    origin: new Vector(0, 0, 64),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    velocity: new Vector(0, 0, -200),
    avelocity: new Vector(0, 0, 90),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_BOUNCE,
    solidType: solid.SOLID_BBOX,
  });
  entity.gravity = 1.0;
  entity.nextthink = 0.0;
  entity.watertype = content.CONTENT_EMPTY;
  entity.waterlevel = 0;
  const floorEntity = createMockEntity({ solidType: solid.SOLID_BSP });
  const floorEdict = createMockEdict(floorEntity);
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      gravity: { value: 800 },
      maxvelocity: { value: 2000 },
      area: {
        linkEdict() {},
      },
      collision: {
        move(_start, _mins, _maxs, end) {
          return {
            allsolid: false,
            startsolid: false,
            fraction: 0.5,
            endpos: end.copy(),
            ent: floorEdict,
            plane: { normal: new Vector(0, 0, 1), dist: 0.0 },
          };
        },
        pointContents() {
          return content.CONTENT_EMPTY;
        },
      },
      messages: {
        startSound() {},
      },
      server: {
        time: 0,
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.physicsToss(edict);
  });

  assert.equal((entity.flags & flags.FL_ONGROUND) !== 0, false);
  assert.equal(entity.groundentity, null);
  assert.deepEqual([...entity.velocity], [0, 0, 140]);
  assert.deepEqual([...entity.avelocity], [0, 0, 90]);
  assert.deepEqual([...entity.angles], [0, 0, 9]);
});

test('ServerPhysics.physicsToss settles non-bounce tosses on walkable ground', () => {
  const serverPhysics = new ServerPhysics();
  const entity = createMockEntity({
    origin: new Vector(0, 0, 64),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    velocity: new Vector(0, 0, -20),
    avelocity: new Vector(0, 10, 0),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_TOSS,
    solidType: solid.SOLID_BBOX,
  });
  entity.gravity = 1.0;
  entity.nextthink = 0.0;
  entity.watertype = content.CONTENT_EMPTY;
  entity.waterlevel = 0;
  const floorEntity = createMockEntity({ solidType: solid.SOLID_BSP });
  const floorEdict = createMockEdict(floorEntity);
  const edict = createMockEdict(entity);

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: { frametime: 0.1 },
    SV: {
      gravity: { value: 800 },
      maxvelocity: { value: 2000 },
      area: {
        linkEdict() {},
      },
      collision: {
        move(_start, _mins, _maxs, end) {
          return {
            allsolid: false,
            startsolid: false,
            fraction: 0.5,
            endpos: end.copy(),
            ent: floorEdict,
            plane: { normal: new Vector(0, 0, 1), dist: 0.0 },
          };
        },
        pointContents() {
          return content.CONTENT_EMPTY;
        },
      },
      messages: {
        startSound() {},
      },
      server: {
        time: 0,
        gameAPI: { time: 0 },
      },
    },
  }, () => {
    serverPhysics.physicsToss(edict);
  });

  assert.equal((entity.flags & flags.FL_ONGROUND) !== 0, true);
  assert.equal(entity.groundentity, floorEntity);
  assert.deepEqual([...entity.velocity], [0, 0, 0]);
  assert.deepEqual([...entity.avelocity], [0, 0, 0]);
  assert.deepEqual([...entity.angles], [0, 1, 0]);
});

test('ServerPhysics.physics applies gravity and toss movement for one frame', () => {
  const linkCalls = [];
  const moveCalls = [];
  let startFrameCount = 0;
  const worldEdict = createMockEdict(createMockEntity({ movetype: moveType.MOVETYPE_NONE }));
  const tossEntity = createMockEntity({
    origin: new Vector(0, 0, 100),
    mins: new Vector(-16, -16, -16),
    maxs: new Vector(16, 16, 16),
    velocity: new Vector(10, 0, 0),
    avelocity: new Vector(),
    angles: new Vector(),
    movetype: moveType.MOVETYPE_TOSS,
    solidType: solid.SOLID_BBOX,
  });
  tossEntity.nextthink = 0;
  tossEntity.gravity = 1.0;
  tossEntity.watertype = 0;
  tossEntity.waterlevel = 0;
  tossEntity.view_ofs = new Vector(0, 0, 22);
  tossEntity.oldorigin = tossEntity.origin.copy();
  const tossEdict = createMockEdict(tossEntity);
  tossEdict.num = 1;

  withMockRegistry({
    Con: {
      Print() {},
      DPrint() {},
    },
    Host: {
      frametime: 0.1,
    },
    SV: {
      gravity: { value: 800 },
      maxvelocity: { value: 2000 },
      area: {
        linkEdict(edict) {
          edict.entity.absmin = edict.entity.origin.copy().add(edict.entity.mins);
          edict.entity.absmax = edict.entity.origin.copy().add(edict.entity.maxs);
          linkCalls.push(edict);
        },
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
            plane: { normal: new Vector(), dist: 0.0 },
          };
        },
        pointContents() {
          return content.CONTENT_EMPTY;
        },
      },
      messages: {
        startSound() {},
      },
      clientPhysics: {
        physicsClient() {},
      },
      server: {
        time: 0,
        num_edicts: 2,
        edicts: [worldEdict, tossEdict],
        gameAPI: {
          time: 0,
          force_retouch: 0,
          startFrame() {
            startFrameCount += 1;
          },
        },
      },
    },
  }, () => {
    const serverPhysics = new ServerPhysics();
    serverPhysics.physics();

    assert.equal(startFrameCount, 1);
    assert.equal(moveCalls.length, 1);
    assert.deepEqual([...moveCalls[0].end], [1, 0, 92]);
    assert.deepEqual([...tossEntity.origin], [1, 0, 92]);
    assert.deepEqual([...tossEntity.velocity], [10, 0, -80]);
    assert.equal(linkCalls.length, 1);
  });
});
