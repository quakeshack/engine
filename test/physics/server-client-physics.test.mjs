import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { flags, moveType, solid } from '../../source/shared/Defs.ts';
import { UserCmd } from '../../source/engine/network/Protocol.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import { ServerClient } from '../../source/engine/server/Client.mjs';
import { ServerClientPhysics } from '../../source/engine/server/physics/ServerClientPhysics.mjs';

import {
  createBoxBrushModel,
  createMockEdict,
  createMockEntity,
  defaultMockRegistry,
  withMockRegistry,
} from './fixtures.mjs';

/**
 * @param {{msec?: number, forwardmove?: number, sidemove?: number, upmove?: number, impulse?: number}} [options]
 * @returns {UserCmd} command fixture
 */
function createUserCmd(options = {}) {
  const cmd = new UserCmd();
  cmd.msec = options.msec ?? 0;
  cmd.forwardmove = options.forwardmove ?? 0;
  cmd.sidemove = options.sidemove ?? 0;
  cmd.upmove = options.upmove ?? 0;
  cmd.impulse = options.impulse ?? 0;
  return cmd;
}

describe('ServerClientPhysics', () => {
  describe('_runSharedPmove', () => {
    test('syncs pmove state, splits long commands, and deduplicates touch impacts', () => {
      const clientPhysics = new ServerClientPhysics();
      const impacts = [];
      const addEntityCalls = [];
      const moveCalls = [];

      const worldEdict = createMockEdict(createMockEntity({ solidType: solid.SOLID_BSP }));
      const playerEntity = createMockEntity({
        origin: new Vector(10, 20, 30),
        velocity: new Vector(1, 2, 3),
        angles: new Vector(0, 45, 0),
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
      });
      playerEntity.num = 1;
      playerEntity.v_angle = new Vector(5, 15, 0);
      playerEntity.teleport_time = 0.0;
      playerEntity.deadflag = 0;
      playerEntity.waterlevel = 1;
      playerEntity.watertype = -3;
      const playerEdict = createMockEdict(playerEntity);
      playerEdict.num = 1;

      const monsterEntity = createMockEntity({
        origin: new Vector(50, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        movetype: moveType.MOVETYPE_STEP,
        solidType: solid.SOLID_BBOX,
      });
      monsterEntity.num = 2;
      const monsterEdict = createMockEdict(monsterEntity);
      monsterEdict.num = 2;

      const brushEntity = createMockEntity({
        origin: new Vector(80, 0, 0),
        angles: new Vector(),
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      brushEntity.num = 3;
      brushEntity.modelindex = 1;
      const brushEdict = createMockEdict(brushEntity);
      brushEdict.num = 3;

      const ignoredTrigger = createMockEdict(createMockEntity({
        solidType: solid.SOLID_TRIGGER,
      }));
      ignoredTrigger.num = 4;

      const fakeMove = {
        origin: new Vector(),
        velocity: new Vector(),
        angles: new Vector(),
        oldbuttons: 0,
        pmFlags: 0,
        pmTime: 0,
        waterjumptime: 0,
        dead: false,
        spectator: false,
        pmType: -1,
        onground: null,
        waterlevel: 0,
        watertype: -1,
        cmd: new UserCmd(),
        touchindices: [1, 1, 2],
        move() {
          moveCalls.push({
            msec: this.cmd.msec,
            impulse: this.cmd.impulse,
            origin: this.origin.copy(),
            velocity: this.velocity.copy(),
          });

          if (moveCalls.length === 1) {
            this.origin = this.origin.add(new Vector(4, 0, 0));
            this.velocity = new Vector(20, 0, 5);
            this.oldbuttons = 3;
            this.pmFlags = 11;
            this.pmTime = 7;
            this.waterlevel = 2;
            this.watertype = -4;
            return;
          }

          this.origin = new Vector(24, 20, 30);
          this.velocity = new Vector(30, 4, 0);
          this.oldbuttons = 5;
          this.pmFlags = 19;
          this.pmTime = 9;
          this.onground = 1;
          this.waterlevel = 3;
          this.watertype = -5;
          this.waterjumptime = 0.3;
        },
      };

      const pmove = {
        physents: [{}],
        clearEntities() {
          this.physents.length = 1;
          return this;
        },
        addEntity(entity, model = null) {
          addEntityCalls.push({ entity, model });
          this.physents.push({ edictId: entity.num ?? entity.edictId ?? 0 });
          return this;
        },
        newPlayerMove() {
          fakeMove.origin = new Vector();
          fakeMove.velocity = new Vector();
          fakeMove.angles = new Vector();
          fakeMove.oldbuttons = 0;
          fakeMove.pmFlags = 0;
          fakeMove.pmTime = 0;
          fakeMove.waterjumptime = 0;
          fakeMove.pmType = -1;
          fakeMove.onground = null;
          fakeMove.waterlevel = 0;
          fakeMove.watertype = -1;
          fakeMove.cmd.reset();
          fakeMove.touchindices = [1, 1, 2];
          return fakeMove;
        },
      };

      const client = new ServerClient(0);
      client.state = ServerClient.STATE.CONNECTED;
      client.cmd = createUserCmd({ msec: 100, forwardmove: 200, impulse: 7 });
      client.pmOldButtons = 1;
      client.pmFlags = 2;
      client.pmTime = 3;

      withMockRegistry(defaultMockRegistry({
        pmove,
        physics: {
          impact(ent, touchEdict, pushVector) {
            impacts.push({ ent, touchEdict, pushVector: pushVector.copy() });
          },
        },
        server: {
          time: 4.0,
          num_edicts: 5,
          edicts: [worldEdict, playerEdict, monsterEdict, brushEdict, ignoredTrigger],
          models: [null, createBoxBrushModel({ halfExtents: [16, 16, 16] })],
        },
      }), () => {
        clientPhysics._runSharedPmove(playerEdict, client);
      });

      assert.equal(addEntityCalls.length, 2);
      assert.equal(addEntityCalls[0].entity, monsterEntity);
      assert.equal(addEntityCalls[1].entity, brushEntity);
      assert.notEqual(addEntityCalls[1].model, null);

      assert.equal(moveCalls.length, 2);
      assert.equal(moveCalls[0].msec, 50);
      assert.equal(moveCalls[0].impulse, 7);
      assert.equal(moveCalls[1].msec, 50);
      assert.equal(moveCalls[1].impulse, 0);

      assert.deepEqual([...playerEntity.origin], [24, 20, 30]);
      assert.deepEqual([...playerEntity.velocity], [30, 4, 0]);
      assert.equal((playerEntity.flags & flags.FL_ONGROUND) !== 0, true);
      assert.equal(playerEntity.groundentity, monsterEntity);
      assert.equal(playerEntity.waterlevel, 3);
      assert.equal(playerEntity.watertype, -5);
      assert.equal((playerEntity.flags & flags.FL_WATERJUMP) !== 0, true);
      assert.equal(playerEntity.teleport_time, 4.3);

      assert.equal(client.pmOldButtons, 5);
      assert.equal(client.pmFlags, 19);
      assert.equal(client.pmTime, 9);

      assert.equal(impacts.length, 2);
      assert.equal(impacts[0].ent, playerEdict);
      assert.equal(impacts[0].touchEdict, monsterEdict);
      assert.deepEqual([...impacts[0].pushVector], [30, 4, 0]);
      assert.equal(impacts[1].touchEdict, brushEdict);
    });
  });

  describe('physicsClient', () => {
    test('drains queued walk commands and links once per frame', () => {
      const clientPhysics = new ServerClientPhysics();
      const events = [];
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);
      const client = new ServerClient(0);
      client.state = ServerClient.STATE.CONNECTED;
      client.pendingCmds = [
        createUserCmd({ msec: 20, forwardmove: 10, impulse: 1 }),
        createUserCmd({ msec: 30, sidemove: 20, impulse: 2 }),
      ];
      edict.getClient = () => client;

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict(linkedEdict, touchTriggers) {
            events.push(['linkEdict', linkedEdict, touchTriggers]);
          },
        },
        physics: {
          checkVelocity(checkedEdict) {
            events.push(['checkVelocity', checkedEdict]);
          },
          runThink(thunkEdict) {
            events.push(['runThink', thunkEdict]);
            return true;
          },
          physicsToss() {
            events.push(['physicsToss']);
          },
          flyMove() {
            events.push(['flyMove']);
          },
        },
        server: {
          time: 8.0,
          gameAPI: {
            time: 0,
            PlayerPreThink(thunkEdict) {
              events.push(['preThink', thunkEdict]);
            },
            PlayerPostThink(thunkEdict) {
              events.push(['postThink', thunkEdict]);
            },
          },
        },
      }), () => {
        clientPhysics._runSharedPmove = (movedEdict, movedClient) => {
          events.push(['pmove', movedEdict, movedClient.cmd.copy()]);
        };

        clientPhysics.physicsClient(edict);
      });

      assert.deepEqual(events.map((entry) => entry[0]), [
        'preThink',
        'checkVelocity',
        'runThink',
        'pmove',
        'pmove',
        'linkEdict',
        'postThink',
      ]);
      assert.equal(events[3][2].msec, 20);
      assert.equal(events[3][2].impulse, 1);
      assert.equal(events[4][2].msec, 30);
      assert.equal(events[4][2].impulse, 2);
      assert.equal(client.pendingCmds.length, 0);
    });

    test('skips movement when no walk commands are queued', () => {
      const clientPhysics = new ServerClientPhysics();
      const events = [];
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);
      const client = new ServerClient(0);
      client.state = ServerClient.STATE.CONNECTED;
      edict.getClient = () => client;

      withMockRegistry(defaultMockRegistry({
        area: {
          linkEdict() {
            events.push('linkEdict');
          },
        },
        physics: {
          checkVelocity() {
            events.push('checkVelocity');
          },
          runThink() {
            events.push('runThink');
            return true;
          },
          physicsToss() {
            events.push('physicsToss');
          },
          flyMove() {
            events.push('flyMove');
          },
        },
        server: {
          time: 2.0,
          gameAPI: {
            time: 0,
            PlayerPreThink() {
              events.push('preThink');
            },
            PlayerPostThink() {
              events.push('postThink');
            },
          },
        },
      }), () => {
        clientPhysics._runSharedPmove = () => {
          events.push('pmove');
        };

        clientPhysics.physicsClient(edict);
      });

      assert.deepEqual(events, ['preThink', 'checkVelocity', 'runThink', 'linkEdict', 'postThink']);
    });
  });
});
