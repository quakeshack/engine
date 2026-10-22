import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { flags, moveType, solid } from '../../source/shared/Defs.ts';
import { UserCmd } from '../../source/engine/network/Protocol.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { ServerClientPhysics } from '../../source/engine/server/physics/ServerClientPhysics.ts';

import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { Pmove } from '../../source/engine/common/Pmove.ts';
import type { BaseEntity, ServerEdict } from '../../source/engine/server/Edict.ts';
import { createBoxBrushModel, createMockEdict, createMockEntity, defaultMockEngine, withMockEngine, mockedSV } from '../support/fixtures.ts';

/**
 * @param [options]
 * @returns command fixture
 */
function createUserCmd(options: {msec?: number, forwardmove?: number, sidemove?: number, upmove?: number, impulse?: number} = {}): UserCmd {
  const cmd = new UserCmd();
  cmd.msec = options.msec ?? 0;
  cmd.forwardmove = options.forwardmove ?? 0;
  cmd.sidemove = options.sidemove ?? 0;
  cmd.upmove = options.upmove ?? 0;
  cmd.impulse = options.impulse ?? 0;
  return cmd;
}

/** What the stand-in mover was asked to do at one move. */
interface MoveCall {
  msec: number;
  impulse: number;
  origin: Vector;
  velocity: Vector;
}

void describe('ServerClientPhysics', () => {
  void describe('_runSharedPmove', () => {
    void test('syncs pmove state, splits long commands, and deduplicates touch impacts', () => {
      const clientPhysics = new ServerClientPhysics(mockedSV());
      const impacts: Array<{ ent: ServerEdict; touchEdict: ServerEdict; pushVector: Vector }> = [];
      const addEntityCalls: Array<{ entity: BaseEntity | ClientEdict; model: BrushModel | null }> = [];
      const moveCalls: MoveCall[] = [];

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
      const playerEdict = createMockEdict(playerEntity, 1);

      const monsterEntity = createMockEntity({
        origin: new Vector(50, 0, 0),
        mins: new Vector(-16, -16, -24),
        maxs: new Vector(16, 16, 32),
        movetype: moveType.MOVETYPE_STEP,
        solidType: solid.SOLID_BBOX,
      });
      monsterEntity.num = 2;
      const monsterEdict = createMockEdict(monsterEntity, 2);

      const brushEntity = createMockEntity({
        origin: new Vector(80, 0, 0),
        angles: new Vector(),
        movetype: moveType.MOVETYPE_PUSH,
        solidType: solid.SOLID_BSP,
      });
      brushEntity.num = 3;
      brushEntity.modelindex = 1;
      const brushEdict = createMockEdict(brushEntity, 3);

      const ignoredTrigger = createMockEdict(createMockEntity({
        solidType: solid.SOLID_TRIGGER,
      }), 4);

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
        onground: null as number | null,
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
        addEntity(entity: BaseEntity | ClientEdict, model: BrushModel | null = null) {
          addEntityCalls.push({ entity, model });
          this.physents.push({ edictId: ('num' in entity ? entity.num : entity.edictId) ?? 0 });
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

      const client = new ServerClient(0, mockedSV());
      client.state = ServerClient.STATE.CONNECTED;
      Object.assign(client.cmd, createUserCmd({ msec: 100, forwardmove: 200, impulse: 7 }));
      client.pmOldButtons = 1;
      client.pmFlags = 2;
      client.pmTime = 3;

      withMockEngine(defaultMockEngine({
        // The stand-in mover answers only what the server's player movement asks of it.
        pmove: pmove as unknown as Pmove,
        physics: {
          impact(ent: ServerEdict, touchEdict: ServerEdict, pushVector: Vector) {
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

  void describe('_runSharedPmove: long commands', () => {
    /**
     * Runs one command through the server's player movement with a recording stand-in for the mover.
     * @param msec duration of the command
     * @returns the moves the mover was asked for
     */
    function movesOfCommand(msec: number): {msec: number, impulse: number}[] {
      const moves: Array<{ msec: number; impulse: number }> = [];
      const mover = {
        origin: new Vector(),
        velocity: new Vector(),
        angles: new Vector(),
        cmd: new UserCmd(),
        touchindices: [] as number[],
        onground: null,
        move() {
          moves.push({ msec: this.cmd.msec, impulse: this.cmd.impulse });
        },
      };
      const pmove = {
        physents: [{}],
        clearEntities() {
          return this;
        },
        newPlayerMove() {
          return mover;
        },
      };
      const playerEntity = createMockEntity({ movetype: moveType.MOVETYPE_WALK, solidType: solid.SOLID_SLIDEBOX });
      playerEntity.deadflag = 0;
      const playerEdict = createMockEdict(playerEntity);
      const client = new ServerClient(0, mockedSV());
      Object.assign(client.cmd, createUserCmd({ msec, impulse: 7 }));

      withMockEngine(defaultMockEngine({
        // The stand-in mover answers only what the server's player movement asks of it.
        pmove: pmove as unknown as Pmove,
        server: { time: 1.0, num_edicts: 2, edicts: [createMockEdict(createMockEntity()), playerEdict], models: [] },
      }), () => {
        new ServerClientPhysics(mockedSV())._runSharedPmove(playerEdict, client);
      });

      return moves;
    }

    // Client prediction splits a command in halves until a piece is 50 ms or less, the server has to take the same steps.
    void test('a command of 50 ms or less is one move', () => {
      assert.deepEqual(movesOfCommand(16), [{ msec: 16, impulse: 7 }]);
      assert.deepEqual(movesOfCommand(50), [{ msec: 50, impulse: 7 }]);
    });

    void test('a command between 51 and 100 ms is two halves, the impulse only on the first', () => {
      assert.deepEqual(movesOfCommand(51), [{ msec: 25.5, impulse: 7 }, { msec: 25.5, impulse: 0 }]);
      assert.deepEqual(movesOfCommand(100), [{ msec: 50, impulse: 7 }, { msec: 50, impulse: 0 }]);
    });

    void test('a command above 100 ms is split again until no piece is longer than 50 ms', () => {
      assert.deepEqual(movesOfCommand(200), [
        { msec: 50, impulse: 7 }, { msec: 50, impulse: 0 }, { msec: 50, impulse: 0 }, { msec: 50, impulse: 0 },
      ]);
      assert.deepEqual(movesOfCommand(101).map((move) => move.msec), [25.25, 25.25, 25.25, 25.25]);
    });

    void test('a command is clamped to 1 to 200 ms before it is split', () => {
      assert.equal(movesOfCommand(900).length, 4);
      assert.deepEqual(movesOfCommand(0), [{ msec: 1, impulse: 7 }]);
    });
  });

  void describe('physicsClient', () => {
    void test('drains queued walk commands and links once per frame', () => {
      const clientPhysics = new ServerClientPhysics(mockedSV());
      const events: Array<[string, ...unknown[]]> = [];
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);
      const client = new ServerClient(0, mockedSV());
      client.state = ServerClient.STATE.CONNECTED;
      client.pendingCmds.push(
        createUserCmd({ msec: 20, forwardmove: 10, impulse: 1 }),
        createUserCmd({ msec: 30, sidemove: 20, impulse: 2 }),
      );
      edict.getClient = () => client;

      withMockEngine(defaultMockEngine({
        area: {
          linkEdict(linkedEdict: ServerEdict, touchTriggers: boolean) {
            events.push(['linkEdict', linkedEdict, touchTriggers]);
          },
        },
        physics: {
          checkVelocity(checkedEdict: ServerEdict) {
            events.push(['checkVelocity', checkedEdict]);
          },
          runThink(thunkEdict: ServerEdict) {
            events.push(['runThink', thunkEdict]);
            return true;
          },
          physicsToss() {
            events.push(['physicsToss']);
          },
          flyMove() {
            events.push(['flyMove']);
            return { blocked: 0, steptrace: null };
          },
        },
        server: {
          time: 8.0,
          gameAPI: {
            time: 0,
            PlayerPreThink(thunkEdict: ServerEdict) {
              events.push(['preThink', thunkEdict]);
            },
            PlayerPostThink(thunkEdict: ServerEdict) {
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
      const firstCmd = events[3][2] as UserCmd;
      const secondCmd = events[4][2] as UserCmd;

      assert.equal(firstCmd.msec, 20);
      assert.equal(firstCmd.impulse, 1);
      assert.equal(secondCmd.msec, 30);
      assert.equal(secondCmd.impulse, 2);
      assert.equal(client.pendingCmds.length, 0);
    });

    void test('skips movement when no walk commands are queued', () => {
      const clientPhysics = new ServerClientPhysics(mockedSV());
      const events: string[] = [];
      const entity = createMockEntity({
        movetype: moveType.MOVETYPE_WALK,
        solidType: solid.SOLID_BBOX,
      });
      const edict = createMockEdict(entity);
      const client = new ServerClient(0, mockedSV());
      client.state = ServerClient.STATE.CONNECTED;
      edict.getClient = () => client;

      withMockEngine(defaultMockEngine({
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
            return { blocked: 0, steptrace: null };
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
