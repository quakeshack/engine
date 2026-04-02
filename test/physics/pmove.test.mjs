import fs from 'node:fs/promises';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import COMClass from '../../source/engine/common/Com.mjs';
import Mod from '../../source/engine/common/Mod.mjs';
import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { DIST_EPSILON, PM_TYPE, PMF, Pmove, PmovePlayer, Trace } from '../../source/engine/common/Pmove.mjs';
import { UserCmd } from '../../source/engine/network/Protocol.ts';
import { eventBus, registry } from '../../source/engine/registry.mjs';

import {
  assertNear,
  createBoxBrushModel,
  createBrushWorldModel,
  createLegacyWorldModel,
  createPmoveBoxEntity,
} from './fixtures.mjs';

/**
 * Build a brush-backed world where a solid wall continues as a clip brush.
 * The seam at y=0 should remain slideable when the player is already tangent
 * to the shared x face of both brushes.
 * @returns {import('../../source/engine/common/model/BSP.mjs').BrushModel} world model fixture
 */
function createWallClipSeamWorldModel() {
  const model = createBrushWorldModel({ axis: 0, center: [24, -32, 0], halfExtents: [8, 32, 64] });
  const clipModel = createBoxBrushModel({ center: [24, 32, 0], halfExtents: [8, 32, 64], submodel: false });
  const planeOffset = model.planes.length;
  const sideOffset = model.brushsides.length;

  model.planes.push(...clipModel.planes);

  for (const side of clipModel.brushsides) {
    side.planenum += planeOffset;
  }

  model.brushsides.push(...clipModel.brushsides);

  const clipBrush = clipModel.brushes[0];
  clipBrush.firstside += sideOffset;
  clipBrush.contents = content.CONTENT_CLIP;
  clipBrush._brushTraceCheck = 0;

  model.brushes.push(clipBrush);
  model.numBrushes = model.brushes.length;

  model.leafbrushes = [0, 1];
  model.leafs[0].firstleafbrush = 0;
  model.leafs[0].numleafbrushes = 2;
  model.leafs[1].firstleafbrush = 2;
  model.leafs[1].numleafbrushes = 0;

  return model;
}

/**
 * Build a trace fixture with the requested observable fields.
 * @param {{ endpos: Vector, fraction?: number, normal?: Vector, dist?: number, ent?: number|null, allsolid?: boolean, startsolid?: boolean }} options trace options
 * @returns {Trace} trace fixture
 */
function createTrace({
  endpos,
  fraction = 1.0,
  normal = new Vector(),
  dist = 0.0,
  ent = null,
  allsolid = false,
  startsolid = false,
}) {
  const trace = new Trace();
  trace.endpos.set(endpos);
  trace.fraction = fraction;
  trace.allsolid = allsolid;
  trace.startsolid = startsolid;
  trace.ent = ent;
  trace.plane.normal.set(normal);
  trace.plane.dist = dist;
  return trace;
}

/** @typedef {{ origin: Vector, moved: Vector, velocity: Vector, onground: number|null }} MapPmoveFrame */

/**
 * @typedef {{
 *   basePath?: string,
 *   mapName: string,
 *   frames: number,
 *   startOrigin?: Vector|null,
 *   yaw?: number|null,
 *   buildCmd?: ((player: PmovePlayer, frame: number) => UserCmd)|null,
 * }} MapFrameRunOptions
 */

/**
 * Parse the BSP entity lump using the engine token parser.
 * @param {string} text entity lump text
 * @returns {Record<string, string>[]} parsed entities
 */
function parseMapEntities(text) {
  /** @type {Record<string, string>[]} */
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

    /** @type {Record<string, string>} */
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
function parseMapOrigin(origin) {
  const components = origin.split(/\s+/).map(Number);
  return new Vector(components[0], components[1], components[2]);
}

/**
 * Resolve the first entity matching the predicate.
 * @param {Record<string, string>[]} entities parsed entity list
 * @param {(entity: Record<string, string>) => boolean} predicate entity predicate
 * @param {string} label entity description for error messages
 * @returns {Record<string, string>} matching entity
 */
function requireMapEntity(entities, predicate, label) {
  const entity = entities.find(predicate);

  if (entity === undefined) {
    throw new Error(`Could not find ${label} in entity lump`);
  }

  return entity;
}

/**
 * Resolve the movement yaw for a real-map pmove probe.
 * Prefer the explicit spawn angle when present so map-authored repros do not
 * depend on a separate direction marker entity.
 * @param {Record<string, string>} spawn spawn entity
 * @param {Record<string, string>[]} entities parsed entity list
 * @returns {number} yaw in degrees
 */
function resolveMapYaw(spawn, entities) {
  if (spawn.angle !== undefined) {
    return Number(spawn.angle);
  }

  const orientation = requireMapEntity(entities, (entity) => entity.targetname === 'direction', 'orientation entity targetname=direction');
  const spawnOrigin = parseMapOrigin(spawn.origin);
  const orientationOrigin = parseMapOrigin(orientation.origin);
  const forward = orientationOrigin.copy().subtract(spawnOrigin);
  forward.normalize();
  return Math.atan2(forward[1], forward[0]) * 180 / Math.PI;
}

/**
 * Run a real BSP-backed movement probe for a fixed number of frames.
 * @param {MapFrameRunOptions} options movement probe options
 * @returns {Promise<MapPmoveFrame[]>} per-frame movement snapshots
 */
async function runMapFrames({
  basePath = '../../data/id1/',
  mapName,
  frames,
  startOrigin = null,
  yaw = null,
  buildCmd = null,
}) {
  const baseUrl = new URL(basePath, import.meta.url);
  const previousRegistry = {
    COM: registry.COM,
    Con: registry.Con,
    Mod: registry.Mod,
    isDedicatedServer: registry.isDedicatedServer,
  };
  const knownKeysBefore = new Set(Object.keys(Mod.known));

  registry.isDedicatedServer = true;
  registry.Con = /** @type {typeof import('../../source/engine/common/Console.ts').default} */ ({
    Print() {},
    DPrint() {},
    PrintWarning() {},
    PrintError(...args) {
      console.error(...args);
    },
    PrintSuccess() {},
  });
  registry.Mod = Mod;
  registry.COM = /** @type {typeof import('../../source/engine/common/Com.mjs').default} */ ({
    Parse: COMClass.Parse,
    async LoadFile(name) {
      try {
        const data = await fs.readFile(new URL(name, baseUrl));
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } catch {
        return null;
      }
    },
    async LoadTextFile(name) {
      try {
        return await fs.readFile(new URL(name, baseUrl), 'utf8');
      } catch {
        return null;
      }
    },
  });
  eventBus.publish('registry.frozen');
  Mod.Init();

  try {
    const model = /** @type {import('../../source/engine/common/model/BSP.mjs').BrushModel} */ (await Mod.ForNameAsync(mapName, true));
    const entities = parseMapEntities(model.entities);
    const spawn = requireMapEntity(entities, (entity) => entity.classname === 'info_player_start', 'spawn entity classname=info_player_start');

    const spawnOrigin = startOrigin ?? parseMapOrigin(spawn.origin);
    const moveYaw = yaw ?? resolveMapYaw(spawn, entities);

    const pmove = new Pmove();
    pmove.setWorldmodel(model);

    const player = pmove.newPlayerMove();
    player.origin.set(spawnOrigin);
    player.velocity.clear();
    player.angles.setTo(0, moveYaw, 0);
    player.pmFlags = PMF.ON_GROUND;
    player.onground = 0;

    /** @type {MapPmoveFrame[]} */
    const rows = [];

    for (let frame = 0; frame < frames; frame++) {
      const before = player.origin.copy();
      const cmd = buildCmd?.(player, frame) ?? new UserCmd();
      if (cmd.msec === 0) {
        cmd.msec = 50;
      }
      if (buildCmd === null) {
        cmd.forwardmove = 320;
        cmd.angles = player.angles.copy();
      }
      player.cmd = cmd;
      player.move();

      rows.push({
        origin: player.origin.copy(),
        moved: player.origin.copy().subtract(before),
        velocity: player.velocity.copy(),
        onground: player.onground,
      });
    }

    return rows;
  } finally {
    for (const name of Object.keys(Mod.known)) {
      if (!knownKeysBefore.has(name)) {
        delete Mod.known[name];
      }
    }

    Object.assign(registry, previousRegistry);
    eventBus.publish('registry.frozen');
  }
}

/**
 * Run a real BSP-backed forward movement probe for a fixed number of frames.
 * @param {string} mapName map path relative to data/id1
 * @param {number} frames number of frames to simulate
 * @returns {Promise<MapPmoveFrame[]>} per-frame movement snapshots
 */
async function runMapForwardFrames(mapName, frames) {
  return runMapFrames({ mapName, frames });
}

describe('PmovePlayer', () => {
  test('DEBUG is disabled before Pmove.Init()', () => {
    assert.equal(PmovePlayer.DEBUG, false);
  });

  test('move integrates one grounded movement frame against a world model', () => {
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

  test('move uses noclip-style spectator movement without collision traces', () => {
    const pmove = new Pmove();
    const player = pmove.newPlayerMove();

    pmove.clipPlayerMove = () => {
      throw new Error('spectator movement should not use collision traces');
    };
    pmove.isValidPlayerPosition = () => true;

    player.spectator = true;
    player.origin.clear();
    player.velocity.clear();
    player.angles.clear();
    player.cmd = new UserCmd();
    player.cmd.msec = 100;
    player.cmd.forwardmove = 600;
    player.cmd.upmove = 50;

    player.move();

    assert.equal(player.pmType, PM_TYPE.SPECTATOR);
    assert.equal(player.onground, null);
    assert.equal(player.viewheight, 22);
    assertNear(player.origin[0], 49.875, 0.001);
    assertNear(player.origin[1], 0.0);
    assertNear(player.origin[2], 4.125, 0.001);
    assertNear(player.velocity[0], 498.25, 0.001);
    assertNear(player.velocity[1], 0.0);
    assertNear(player.velocity[2], 41.5, 0.001);
  });

  test('keeps decisive uphill progress on the brush-backed slope regression map', async () => {
    const brushFrames = await runMapForwardFrames('maps/test_slope.bsp', 24);

    const firstRampFrame = 13;
    const lastRampFrame = 20;

    assert.ok(brushFrames[firstRampFrame].moved[0] > 12.0);
    assert.ok(brushFrames[firstRampFrame].moved[2] > 5.0);

    for (let frame = firstRampFrame; frame <= lastRampFrame; frame++) {
      assert.ok(brushFrames[frame].onground !== null);
      assert.ok(brushFrames[frame].moved[0] > 4.0);
    }
  });

  test('tracks the hull slope climb on the brush-backed slope regression map', async () => {
    const brushFrames = await runMapForwardFrames('maps/test_slope.bsp', 24);
    const hullFrames = await runMapForwardFrames('maps/test_slope_hull.bsp', 24);

    for (let frame = 0; frame < brushFrames.length; frame++) {
      assertNear(brushFrames[frame].origin[0], hullFrames[frame].origin[0], 0.75);
      assertNear(brushFrames[frame].origin[2], hullFrames[frame].origin[2], 0.75);
      assertNear(brushFrames[frame].moved[0], hullFrames[frame].moved[0], 0.75);
      assertNear(brushFrames[frame].moved[2], hullFrames[frame].moved[2], 0.75);
    }
  });

  test('matches the hull corner slide timing on the brush-backed clip_2 regression map', async () => {
    const brushFrames = await runMapForwardFrames('maps/test_clip_2.bsp', 12);
    const hullFrames = await runMapForwardFrames('maps/test_clip_2_hull.bsp', 12);

    for (let frame = 0; frame < brushFrames.length; frame++) {
      assertNear(brushFrames[frame].origin[0], hullFrames[frame].origin[0], 0.25);
      assertNear(brushFrames[frame].origin[1], hullFrames[frame].origin[1], 0.25);
      assertNear(brushFrames[frame].moved[0], hullFrames[frame].moved[0], 0.25);
      assertNear(brushFrames[frame].moved[1], hullFrames[frame].moved[1], 0.25);
      assertNear(brushFrames[frame].velocity[0], hullFrames[frame].velocity[0], 0.25);
      assertNear(brushFrames[frame].velocity[1], hullFrames[frame].velocity[1], 0.25);
    }

    assert.ok(brushFrames[7].moved[1] < -1.0);
    assert.ok(hullFrames[7].moved[1] < -1.0);
  });

  test('does not wedge on the hw_doom corridor sidestep repro', async () => {
    const frames = await runMapFrames({
      mapName: 'maps/test_hw_doom.bsp',
      frames: 8,
      startOrigin: new Vector(645.5, -667.875, 24),
      yaw: 270,
      buildCmd(player) {
        const cmd = new UserCmd();
        cmd.msec = 50;
        cmd.sidemove = -320;
        cmd.angles = player.angles.copy();
        return cmd;
      },
    });

    assert.ok(frames[5].moved[0] > 4.0);
    assert.ok(frames[6].moved[0] > 4.0);
    assert.ok(frames[7].moved[0] > 4.0);
  });

  test('tracks the hull slope climb on the brush-backed slope_2 regression map', async () => {
    const brushFrames = await runMapForwardFrames('maps/test_slope_2.bsp', 24);
    const hullFrames = await runMapForwardFrames('maps/test_slope_2_hull.bsp', 24);

    for (let frame = 0; frame < brushFrames.length; frame++) {
      assertNear(brushFrames[frame].origin[0], hullFrames[frame].origin[0], 0.75);
      assertNear(brushFrames[frame].origin[2], hullFrames[frame].origin[2], 0.75);
      assertNear(brushFrames[frame].moved[0], hullFrames[frame].moved[0], 0.75);
      assertNear(brushFrames[frame].moved[2], hullFrames[frame].moved[2], 0.75);
    }
  });

  describe('_checkDuck', () => {
    test('enters ducked state on grounded crouch input and stands when space is clear', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();

      player.origin.clear();
      player.cmd = new UserCmd();
      player.pmFlags = PMF.ON_GROUND;
      player.cmd.upmove = -1;

      player._checkDuck();

      assert.equal((player.pmFlags & PMF.DUCKED) !== 0, true);
      assert.equal(player.viewheight, -2);

      player.cmd.upmove = 0;
      pmove.isValidPlayerPosition = () => true;

      player._checkDuck();

      assert.equal((player.pmFlags & PMF.DUCKED) !== 0, false);
      assert.equal(player.viewheight, 22);
    });
  });

  describe('_checkSpecialMovement', () => {
    test('starts a waterjump when water waist depth meets a solid lip with empty space above', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();

      player.origin.clear();
      player.velocity.clear();
      player.angles.clear();
      player.waterlevel = 2;
      player.cmd = new UserCmd();
      player._clampAngles();

      pmove.clipPlayerMove = (start, end) => {
        void start;
        return createTrace({ endpos: end.copy() });
      };

      /** @type {number[][]} */
      const probes = [];
      pmove.staticWorldContents = (point) => {
        probes.push([...point]);
        if (point[2] === 8) {
          return content.CONTENT_SOLID;
        }
        if (point[2] === 32) {
          return content.CONTENT_EMPTY;
        }
        return content.CONTENT_WATER;
      };

      player._checkSpecialMovement();

      assert.deepEqual(probes, [[24, 0, 8], [24, 0, 32]]);
      assert.deepEqual([...player.velocity], [50, 0, 310]);
      assert.equal((player.pmFlags & PMF.TIME_WATERJUMP) !== 0, true);
      assert.equal(player.pmTime, 255);
    });
  });

  describe('_categorizePosition', () => {
    test('keeps grounded state on a walkable slope while climbing quickly', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();

      pmove.clipPlayerMove = (start, end) => {
        void start;
        return createTrace({
          endpos: end.copy(),
          normal: new Vector(0.0, 0.0, 0.75),
          ent: 0,
        });
      };
      pmove.staticWorldContents = () => content.CONTENT_EMPTY;

      player.origin.setTo(0, 0, 64);
      player.velocity.setTo(200, 0, 181);
      player.onground = 0;
      player.pmFlags = PMF.ON_GROUND;

      player._categorizePosition();

      assert.equal(player.onground, 0);
      assert.equal((player.pmFlags & PMF.ON_GROUND) !== 0, true);
      assert.deepEqual(player.touchindices, [0]);
    });

    test('still drops ground while moving upward fast after leaving the floor', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let traceCalls = 0;

      pmove.clipPlayerMove = () => {
        traceCalls += 1;
        throw new Error('airborne upward guard should skip ground tracing');
      };
      pmove.staticWorldContents = () => content.CONTENT_EMPTY;

      player.origin.setTo(0, 0, 64);
      player.velocity.setTo(200, 0, 181);
      player.onground = null;
      player.pmFlags = 0;

      player._categorizePosition();

      assert.equal(player.onground, null);
      assert.equal((player.pmFlags & PMF.ON_GROUND) !== 0, false);
      assert.equal(traceCalls, 0);
    });

    test('ignores a stale grounded flag while moving upward fast', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let traceCalls = 0;

      pmove.clipPlayerMove = () => {
        traceCalls += 1;
        throw new Error('stale PMF.ON_GROUND should not preserve a ground trace');
      };
      pmove.staticWorldContents = () => content.CONTENT_EMPTY;

      player.origin.setTo(0, 0, 64);
      player.velocity.setTo(0, 0, 181);
      player.onground = null;
      player.pmFlags = PMF.ON_GROUND;

      player._categorizePosition();

      assert.equal(player.onground, null);
      assert.equal((player.pmFlags & PMF.ON_GROUND) !== 0, false);
      assert.equal(traceCalls, 0);
    });
  });

  describe('waterjump movement', () => {
    test('applies gravity and clears waterjump once the upward boost turns downward', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let stepSlideCalls = 0;

      pmove.isValidPlayerPosition = () => true;
      pmove.clipPlayerMove = (start, end) => {
        void start;
        return createTrace({ endpos: end.copy(), normal: new Vector(0, 0, 1) });
      };
      pmove.staticWorldContents = () => content.CONTENT_EMPTY;

      player.origin.clear();
      player.velocity.setTo(0, 0, 10);
      player.angles.clear();
      player.pmFlags = PMF.TIME_WATERJUMP;
      player.pmTime = 255;
      player.cmd = new UserCmd();
      player.cmd.msec = 100;
      player._stepSlideMove = () => {
        stepSlideCalls += 1;
      };

      player.move();

      assert.equal(stepSlideCalls, 1);
      assert.equal((player.pmFlags & PMF.TIME_WATERJUMP) !== 0, false);
      assert.equal(player.pmTime, 0);
      assertNear(player.velocity[2], -70.0);
    });
  });

  describe('_stepSlideMove', () => {
    test('snaps down to a walkable slope after an unblocked slide', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let slideCalls = 0;
      let traceCalls = 0;

      player.origin.clear();
      player.velocity.setTo(30, 0, 0);
      player.onground = 0;
      player._slideMove = () => {
        slideCalls += 1;
        player.origin.setTo(8, 0, 4);
        player.velocity.setTo(20, 0, 3);
        return false;
      };

      pmove.clipPlayerMove = (start, end) => {
        traceCalls += 1;

        assert.deepEqual([...start], [8, 0, 4]);
        assert.deepEqual([...end], [8, 0, -14]);

        return createTrace({
          endpos: new Vector(8, 0, 3.5),
          fraction: 0.03,
          normal: new Vector(0, 0.75, 0.75),
          ent: 5,
        });
      };

      player._stepSlideMove();

      assert.equal(slideCalls, 1);
      assert.equal(traceCalls, 1);
      assert.deepEqual([...player.origin], [8, 0, 3.5]);
      assert.deepEqual([...player.velocity], [20, 0, 3]);
      assert.deepEqual(player.touchindices, [5]);
    });

    test('still evaluates the stepped retry after a blocked slide move', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let slideCalls = 0;
      let traceCalls = 0;

      player.origin.clear();
      player.velocity.setTo(30, 0, 0);
      player.onground = 0;
      player._slideMove = () => {
        slideCalls += 1;
        if (slideCalls === 1) {
          player.origin.setTo(8, 0, 4);
          player.velocity.setTo(20, 0, 3);
          return true;
        }

        player.origin.setTo(12, 0, 9);
        player.velocity.setTo(24, 0, 6);
        return true;
      };

      pmove.clipPlayerMove = (start, end) => {
        traceCalls += 1;

        if (traceCalls === 1) {
          assert.deepEqual([...start], [0, 0, 0]);
          assert.deepEqual([...end], [0, 0, 18]);
          return createTrace({
            endpos: new Vector(0, 0, 9),
            fraction: 0.5,
            normal: new Vector(0, 0, 1),
            ent: 3,
          });
        }

        if (traceCalls === 2) {
          assert.deepEqual([...start], [12, 0, 9]);
          assert.deepEqual([...end], [12, 0, -0.03125]);
          return createTrace({
            endpos: new Vector(12, 0, 4),
            normal: new Vector(0, 0, 1),
            ent: 4,
          });
        }

        throw new Error(`unexpected trace call ${traceCalls}`);
      };

      player._stepSlideMove();

      assert.equal(slideCalls, 2);
      assert.equal(traceCalls, 2);
      assert.deepEqual([...player.origin], [12, 0, 4]);
      assert.deepEqual([...player.velocity], [24, 0, 3]);
      assert.deepEqual(player.touchindices, [3, 4]);
    });
  });

  describe('_slideMove', () => {
    test('slides past a wall-to-clip seam and snap keeps the seam walkable', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();

      pmove.setWorldmodel(createWallClipSeamWorldModel());

      // Approach the wall diagonally so the first bump clips into the wall,
      // then the remaining movement has to continue across the solid-to-clip seam.
      player.origin.setTo(-8, -48, 0);
      player.velocity.setTo(32, 96, 0);
      player.frametime = 1.0;

      player._slideMove();

      // Raw brush traces keep the player DIST_EPSILON on the near side of the
      // expanded face. The gameplay path snaps this back to the exact seam.
      assertNear(player.origin[0], -DIST_EPSILON, 0.001);
      assertNear(player.origin[1], 48.0, 0.001);
      assertNear(player.origin[2], 0.0, 0.001);
      assertNear(player.velocity[0], 0.0, 0.001);
      assertNear(player.velocity[1], 96.0, 0.001);
      assertNear(player.velocity[2], 0.0, 0.001);

      player._snapPosition();

      assertNear(player.origin[0], 0.0, 0.001);
      assertNear(player.origin[1], 48.0, 0.001);
      assert.equal(pmove.isValidPlayerPosition(player.origin), true);

      const continuedTrace = pmove.clipPlayerMove(player.origin, new Vector(0, 144, 0));
      assert.equal(continuedTrace.startsolid, false);
      assert.equal(continuedTrace.allsolid, false);
      assert.equal(continuedTrace.fraction, 1.0);
      assert.deepEqual([...continuedTrace.endpos], [0, 144, 0]);
    });

    test('treats zero-progress near-parallel brush re-clips as a single slide plane', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      let traceCalls = 0;

      player.origin.clear();
      player.velocity.setTo(100, 100, 0);
      player.frametime = 1.0;

      pmove.clipPlayerMove = (start, end) => {
        traceCalls += 1;

        if (traceCalls === 1) {
          assert.deepEqual([...start], [0, 0, 0]);
          assert.deepEqual([...end], [100, 100, 0]);
          return createTrace({
            endpos: new Vector(50, 50, 0),
            fraction: 0.5,
            normal: new Vector(-1, 0, 0),
            ent: 1,
          });
        }

        if (traceCalls === 2) {
          assert.deepEqual([...start], [50, 50, 0]);
          return createTrace({
            endpos: new Vector(50, 50, 0),
            fraction: 0.0,
            normal: new Vector(-0.9876883625984192, -0.15643446147441864, 0),
            ent: 1,
          });
        }

        return createTrace({
          endpos: end.copy(),
          fraction: 1.0,
        });
      };

      player._slideMove();

      assert.equal(traceCalls, 3);
      assert.ok(player.origin[0] > 48.5);
      assert.ok(player.origin[1] > 99.0);
      assert.ok(Math.abs(player.velocity[0]) < 2.0);
      assert.ok(player.velocity[1] > 99.0);
    });
  });
});

describe('Pmove', () => {
  describe('clipPlayerMove', () => {
    test('keeps startsolid end positions in world space', () => {
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

    test('reports hull hits in world coordinates', () => {
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

    test('preserves later startsolid when an earlier equal-fraction clip already won', () => {
      const pmove = new Pmove();
      const start = new Vector(0, 0, 0);
      const end = new Vector(100, 0, 0);
      const worldModel = createLegacyWorldModel(
        new Vector(-256, -256, -128),
        new Vector(256, 256, 128),
      );

      pmove.setWorldmodel(worldModel);
      pmove.addEntity(createPmoveBoxEntity({
        origin: new Vector(64, 0, 0),
        mins: new Vector(-16, -16, -16),
        maxs: new Vector(16, 16, 16),
        num: 1,
      }));

      pmove.physents[0].tracePlayerMove = () => createTrace({
        endpos: start.copy(),
        fraction: 0.0,
        normal: new Vector(-1, 0, 0),
      });
      pmove.physents[1].tracePlayerMove = () => createTrace({
        endpos: end.copy(),
        startsolid: true,
        allsolid: false,
      });

      const trace = pmove.clipPlayerMove(start, end);

      assert.equal(trace.fraction, 0.0);
      assert.equal(trace.startsolid, true);
      assert.equal(trace.allsolid, false);
      assert.deepEqual([...trace.endpos], [...start]);
    });

    test('ands allsolid across equal-fraction startsolid physents', () => {
      const pmove = new Pmove();
      const start = new Vector(0, 0, 0);
      const end = new Vector(100, 0, 0);
      const worldModel = createLegacyWorldModel(
        new Vector(-256, -256, -128),
        new Vector(256, 256, 128),
      );

      pmove.setWorldmodel(worldModel);
      pmove.addEntity(createPmoveBoxEntity({
        origin: new Vector(64, 0, 0),
        mins: new Vector(-16, -16, -16),
        maxs: new Vector(16, 16, 16),
        num: 1,
      }));

      pmove.physents[0].tracePlayerMove = () => createTrace({
        endpos: end.copy(),
        startsolid: true,
        allsolid: true,
      });
      pmove.physents[1].tracePlayerMove = () => createTrace({
        endpos: end.copy(),
        startsolid: true,
        allsolid: false,
      });

      const trace = pmove.clipPlayerMove(start, end);

      assert.equal(trace.fraction, 0.0);
      assert.equal(trace.startsolid, true);
      assert.equal(trace.allsolid, false);
      assert.deepEqual([...trace.endpos], [...start]);
    });
  });

  test('server-style smoke setup mirrors TestServerside assertions', () => {
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

  test('traceStaticWorldPlayerMove traces world only and ignores dynamic physents', () => {
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

  test('brush-list world path supports server-style vertical smoke checks', () => {
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

  describe('staticWorldContents', () => {
    test('uses brush-backed world solids before leaf contents', () => {
      const worldModel = createBrushWorldModel({ center: [64, 0, 0], halfExtents: [16, 16, 16] });
      const pmove = new Pmove();

      worldModel.leafs[0].contents = content.CONTENT_WATER;

      pmove.setWorldmodel(worldModel);

      assert.equal(pmove.staticWorldContents(new Vector(64, 0, 0)), content.CONTENT_SOLID);
      assert.equal(pmove.staticWorldContents(new Vector(8, 0, 0)), content.CONTENT_WATER);
    });

    test('normalizes brush-backed current leaves to water', () => {
      const worldModel = createBrushWorldModel({ center: [64, 0, 0], halfExtents: [16, 16, 16] });
      const pmove = new Pmove();

      worldModel.leafs[0].contents = content.CONTENT_CURRENT_UP;

      pmove.setWorldmodel(worldModel);

      assert.equal(pmove.staticWorldContents(new Vector(8, 0, 0)), content.CONTENT_WATER);
    });
  });

  describe('crouching movement', () => {
    test('uses duckspeed as the movement cap while ducked on the ground', () => {
      const pmove = new Pmove();
      const player = pmove.newPlayerMove();
      const recordedWishspeeds = [];

      player.origin.clear();
      player.velocity.clear();
      player.angles.clear();
      player.onground = 0;
      player.pmFlags = PMF.ON_GROUND | PMF.DUCKED;
      player.cmd = new UserCmd();
      player.cmd.forwardmove = 400;
      player._clampAngles();
      player._accelerate = (_wishdir, wishspeed) => {
        recordedWishspeeds.push(wishspeed);
      };
      player._stepSlideMove = () => {};

      player._airMove();

      assert.deepEqual(recordedWishspeeds, [pmove.movevars.duckspeed]);
      assert.equal(player.velocity[2], 0);
    });
  });
});
