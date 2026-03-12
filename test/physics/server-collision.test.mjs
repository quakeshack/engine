import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.mjs';
import { content, flags, moveType, moveTypes, solid } from '../../source/shared/Defs.mjs';
import { BrushModel } from '../../source/engine/common/model/BSP.mjs';
import { BrushTrace, Pmove } from '../../source/engine/common/Pmove.mjs';
import { BSP29Loader } from '../../source/engine/common/model/loaders/BSP29Loader.mjs';
import { ServerCollision } from '../../source/engine/server/physics/ServerCollision.mjs';

import {
  assertNear,
  createAxisPlane,
  createBoxBrushModel,
  createBrushWorldModel,
  createMockEdict,
  createMockEntity,
  defaultMockRegistry,
  withMockRegistry,
} from './fixtures.mjs';

describe('ServerCollision', () => {
  test('stationary brush tests preserve exact resting contact', () => {
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

  describe('move', () => {
    test('traces world brush sweeps through shared brush state', () => {
      const collision = new ServerCollision();
      const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
      const worldEntity = createMockEntity({
        origin: new Vector(),
        angles: new Vector(),
        movetype: moveType.MOVETYPE_NONE,
        solidType: solid.SOLID_BSP,
      });
      const worldEdict = createMockEdict(worldEntity);

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
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

    test('prefers a later legacy hull hit over an earlier world brush point hit', () => {
      const collision = new ServerCollision();
      const worldModel = createBoxBrushModel({ halfExtents: [16, 16, 16], name: 'world-brush' });
      const worldEntity = createMockEntity({
        origin: new Vector(),
        angles: new Vector(),
        movetype: moveType.MOVETYPE_NONE,
        solidType: solid.SOLID_BSP,
      });
      const worldEdict = createMockEdict(worldEntity);

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
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

    test('keeps legacy world hull traces out of foreign clipnode subtrees', () => {
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

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
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

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
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

    test('prefers a later legacy hull hit over an earlier unrotated BSP entity brush point hit', () => {
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

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
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

    test('expands missile traces for monster broadphase and narrowphase', () => {
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

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
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

    test('queries area-linked entities and filters skipped or out-of-bounds touches', () => {
      const collision = new ServerCollision();
      const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));
      const passedict = createMockEdict(createMockEntity({
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        solidType: solid.SOLID_BBOX,
      }));
      const triggerEdict = createMockEdict(createMockEntity({
        origin: new Vector(18, 40, 38),
        mins: new Vector(-8, -8, -8),
        maxs: new Vector(8, 8, 8),
        solidType: solid.SOLID_TRIGGER,
      }));
      const offBoundsEdict = createMockEdict(createMockEntity({
        origin: new Vector(120, 120, 120),
        mins: new Vector(-8, -8, -8),
        maxs: new Vector(8, 8, 8),
        solidType: solid.SOLID_BBOX,
      }));
      const blockingEdict = createMockEdict(createMockEntity({
        origin: new Vector(24, 44, 42),
        mins: new Vector(-8, -8, -8),
        maxs: new Vector(8, 8, 8),
        solidType: solid.SOLID_BBOX,
      }));

      /** @type {{ boxmins: Vector, boxmaxs: Vector }[]} */
      const queryCalls = [];
      /** @type {object[]} */
      const traceCalls = [];

      withMockRegistry(defaultMockRegistry({
        area: {
          tree: {
            queryAABB(boxmins, boxmaxs) {
              queryCalls.push({ boxmins: boxmins.copy(), boxmaxs: boxmaxs.copy() });
              return [passedict, triggerEdict, offBoundsEdict, blockingEdict];
            },
          },
        },
        server: {
          edicts: [worldEdict, passedict, triggerEdict, offBoundsEdict, blockingEdict],
          worldmodel: null,
        },
      }), () => {
        collision._clipMoveToEntityWithState = (state, start, mins, maxs, end) => {
          traceCalls.push({ ent: state.ent, start: start.copy(), mins: mins.copy(), maxs: maxs.copy(), end: end.copy() });

          if (state.ent === worldEdict) {
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
            endpos: new Vector(20, 40, 40),
            plane: { normal: new Vector(-1, 0, 0), dist: -20 },
            ent: state.ent,
            inopen: true,
            inwater: false,
          };
        };

        const start = new Vector(10, 20, 30);
        const mins = new Vector(-4, -5, -6);
        const maxs = new Vector(7, 8, 9);
        const end = new Vector(30, 60, 50);
        const trace = collision.move(
          start,
          mins,
          maxs,
          end,
          moveTypes.MOVE_NORMAL,
          /** @type {import('../../source/engine/server/Client.mjs').ServerEdict} */ (passedict),
        );

        assert.equal(queryCalls.length, 1);
        assert.deepEqual([...queryCalls[0].boxmins], [5, 14, 23]);
        assert.deepEqual([...queryCalls[0].boxmaxs], [38, 69, 60]);

        assert.deepEqual(traceCalls.map((call) => call.ent), [worldEdict, blockingEdict]);
        assert.deepEqual([...traceCalls[1].start], [...start]);
        assert.deepEqual([...traceCalls[1].mins], [...mins]);
        assert.deepEqual([...traceCalls[1].maxs], [...maxs]);
        assert.deepEqual([...traceCalls[1].end], [...end]);

        assert.equal(trace.ent, blockingEdict);
        assert.equal(trace.fraction, 0.5);
        assert.deepEqual([...trace.endpos], [20, 40, 40]);
      });
    });

    test('keeps the nearest hit across multi-entity clip chains', () => {
      const collision = new ServerCollision();
      const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));
      const farEdict = createMockEdict(createMockEntity({
        origin: new Vector(72, 0, 0),
        mins: new Vector(-8, -8, -8),
        maxs: new Vector(8, 8, 8),
        solidType: solid.SOLID_BBOX,
      }));
      const nearEdict = createMockEdict(createMockEntity({
        origin: new Vector(36, 0, 0),
        mins: new Vector(-8, -8, -8),
        maxs: new Vector(8, 8, 8),
        solidType: solid.SOLID_BBOX,
      }));

      /** @type {object[]} */
      const traceCalls = [];

      withMockRegistry(defaultMockRegistry({
        area: {
          tree: {
            queryAABB() {
              return [farEdict, nearEdict];
            },
          },
        },
        server: {
          edicts: [worldEdict, farEdict, nearEdict],
          worldmodel: null,
        },
      }), () => {
        collision._clipMoveToEntityWithState = (state, start, mins, maxs, end) => {
          traceCalls.push({ ent: state.ent, start: start.copy(), mins: mins.copy(), maxs: maxs.copy(), end: end.copy() });

          if (state.ent === worldEdict) {
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

          if (state.ent === farEdict) {
            return {
              fraction: 0.6,
              allsolid: false,
              startsolid: false,
              endpos: new Vector(60, 0, 0),
              plane: { normal: new Vector(-1, 0, 0), dist: -60 },
              ent: farEdict,
            };
          }

          return {
            fraction: 0.2,
            allsolid: false,
            startsolid: false,
            endpos: new Vector(20, 0, 0),
            plane: { normal: new Vector(-1, 0, 0), dist: -20 },
            ent: nearEdict,
            inopen: true,
            inwater: false,
          };
        };

        const trace = collision.move(
          new Vector(0, 0, 0),
          Vector.origin,
          Vector.origin,
          new Vector(100, 0, 0),
          moveTypes.MOVE_NORMAL,
          null,
        );

        assert.deepEqual(traceCalls.map((call) => call.ent), [worldEdict, farEdict, nearEdict]);
        assert.equal(trace.ent, nearEdict);
        assert.equal(trace.fraction, 0.2);
        assert.deepEqual([...trace.endpos], [20, 0, 0]);
      });
    });
  });

  describe('clipMoveToEntity', () => {
    test('keeps rotated BSP point traces on the brush path', () => {
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

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
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
  });

  describe('hullPointContents', () => {
    test('treats masked foreign clipnodes as empty space', () => {
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
  });

  describe('pointContents', () => {
    test('respects world hull ownership masks', () => {
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

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
        assert.equal(collision.staticWorldContents(new Vector(100, 0, 0)), content.CONTENT_EMPTY);
        assert.equal(collision.staticWorldContents(new Vector(-100, 0, 0)), content.CONTENT_WATER);
      });
    });
  });

  describe('staticWorldContents', () => {
    test('uses brush-backed world solids before leaf contents', () => {
      const collision = new ServerCollision();
      const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
      const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
        assert.equal(collision.staticWorldContents(new Vector(64, 0, 0)), content.CONTENT_SOLID);
        assert.equal(collision.staticWorldContents(new Vector(-100, 0, 0)), content.CONTENT_EMPTY);
      });
    });

    test('normalizes brush-backed current leaves to water', () => {
      const collision = new ServerCollision();
      const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
      worldModel.leafs[1].contents = content.CONTENT_CURRENT_DOWN;
      const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
        assert.equal(collision.staticWorldContents(new Vector(-100, 0, 0)), content.CONTENT_WATER);
      });
    });
  });

  describe('traceStaticWorldLine', () => {
    test('uses brush tracing for brush-backed world hull 0', () => {
      const collision = new ServerCollision();
      const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });
      const worldEdict = createMockEdict(createMockEntity({
        origin: new Vector(),
        angles: new Vector(),
        solidType: solid.SOLID_BSP,
      }));

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
        const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(100, 0, 0));

        assert.equal(trace.startsolid, false);
        assert.equal(trace.ent, worldEdict);
        assert.ok(trace.fraction < 1.0);
        assertNear(trace.endpos[0], 47.96875, 0.001);
      });
    });

    test('uses the client worldmodel when no local server worldspawn exists', () => {
      const collision = new ServerCollision();
      const worldModel = createBrushWorldModel({ halfExtents: [16, 16, 16] });

      withMockRegistry(defaultMockRegistry({
        area: {
          tree: {
            queryAABB() {
              return [];
            },
          },
        },
        server: {
          edicts: [],
          worldmodel: null,
        },
      }, {
        state: {
          worldmodel: worldModel,
        },
      }), () => {
        const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(100, 0, 0));

        assert.equal(trace.startsolid, false);
        assert.equal(trace.ent, null);
        assert.ok(trace.fraction < 1.0);
        assertNear(trace.endpos[0], 47.96875, 0.001);
      });
    });

    test('keeps legacy world hull traces out of foreign clipnode subtrees', () => {
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

      withMockRegistry(defaultMockRegistry({
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
      }), () => {
        const trace = collision.traceStaticWorldLine(new Vector(0, 0, 0), new Vector(100, 0, 0));

        assert.equal(trace.fraction, 1.0);
        assert.equal(trace.startsolid, false);
        assert.equal(trace.ent, null);
        assert.deepEqual([...trace.endpos], [100, 0, 0]);
      });
    });
  });
});

describe('BSP29Loader', () => {
  test('builds legacy clipnode masks from a model headnode subtree', () => {
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
});
