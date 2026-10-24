import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import * as Defs from '../../source/shared/Defs.ts';
import CL from '../../source/engine/client/CL.ts';
import { ClientPlayerState } from '../../source/engine/client/ClientMessages.ts';
import { MOVEVAR_CVARS, MoveVars, PM_TYPE, PMF, Pmove, PmovePlayer, type MoveVarName } from '../../source/engine/common/Pmove.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { ServerClientPhysics } from '../../source/engine/server/physics/ServerClientPhysics.ts';
import type { ServerClient } from '../../source/engine/server/Client.ts';
import Server from '../../source/engine/server/Server.ts';
import type { ServerDependencies } from '../../source/engine/server/ServerDependencies.ts';
import type { ServerEdict } from '../../source/engine/server/Edict.ts';


import {
  SCENARIOS,
  SCRIPT_MSEC,
  createDeterminismWorld,
  createDoorModel,
  createMoveVars,
  describeDifference,
  hashStates,
  BOX_ENTITY_NUM,
  DOOR_ENTITY_NUM,
  placeEntities,
  randomScript,
  readState,
  toUserCmd,
  type CommandSpec,
  type Scenario,
  type StepState,
} from '../support/pmoveDeterminism.ts';

/** One side of a comparison: a world of its own, loaded separately like a client and a server worker each would. */
interface Side {
  readonly pmove: Pmove;
  readonly player: PmovePlayer;
  readonly doorModel: ReturnType<typeof createDoorModel>;
}

type Order = 'first-then-second' | 'second-then-first' | 'alternating';

const ORDERS: readonly Order[] = ['first-then-second', 'second-then-first', 'alternating'];

/** Random runs per scenario and per order. */
const RANDOM_SEEDS: readonly number[] = [1, 2, 3];

const RANDOM_STEPS = 120;

/**
 * Builds a side that starts as the scenario says.
 * @returns The side.
 */
function createSide(scenario: Scenario): Side {
  const pmove = new Pmove();

  pmove.movevars = createMoveVars();
  pmove.setWorldmodel(createDeterminismWorld());

  const player = pmove.newPlayerMove();

  player.origin.setTo(...scenario.origin);
  player.velocity.clear();

  switch (scenario.pmType) {
    case 'noclip':
      player.pmType = PM_TYPE.SPECTATOR;
      break;
    case 'dead':
      player.pmType = PM_TYPE.DEAD;
      break;
    default:
      player.pmFlags = PMF.ON_GROUND;
      player.onground = 0;
      break;
  }

  return { pmove, player, doorModel: createDoorModel() };
}

/**
 * Runs a command script on two sides and compares them after every command.
 * @returns The states of the first side, and the first difference between the sides, if any.
 */
function runPair(scenario: Scenario, commands: readonly CommandSpec[], order: Order): { states: StepState[]; difference: string | null } {
  const sides = [createSide(scenario), createSide(scenario)] as const;
  const states: StepState[] = [];

  for (let step = 0; step < commands.length; step++) {
    const sequence = order === 'second-then-first' || (order === 'alternating' && step % 2 === 1) ? [1, 0] : [0, 1];
    const results: StepState[] = [];

    for (const index of sequence) {
      const side = sides[index]!;

      placeEntities(side.pmove, scenario.placement(step), side.doorModel);
      side.player.cmd = toUserCmd(commands[step]!);
      side.player.move();
      results[index] = readState(side.player);
    }

    states.push(results[0]!);

    const difference = describeDifference(results[0]!, results[1]!);

    if (difference !== null) {
      return { states, difference: `step ${step} (msec ${commands[step]!.msec}): ${difference}` };
    }
  }

  return { states, difference: null };
}

void describe('Pmove determinism: two worlds, same commands', () => {
  void describe('scripted runs', () => {
    for (const scenario of SCENARIOS) {
      for (const order of ORDERS) {
        void test(`${scenario.name}, ${order}`, () => {
          for (const msec of SCRIPT_MSEC) {
            const { difference } = runPair(scenario, scenario.script(msec), order);

            assert.equal(difference, null, `msec ${msec}: ${difference}`);
          }
        });
      }
    }
  });

  void describe('seeded random runs', () => {
    for (const scenario of SCENARIOS) {
      for (const order of ORDERS) {
        void test(`${scenario.name}, ${order}`, () => {
          for (const seed of RANDOM_SEEDS) {
            const { difference } = runPair(scenario, randomScript(seed, RANDOM_STEPS, [8, 16, 33, 50, 101, 200]), order);

            assert.equal(difference, null, `seed ${seed}: ${difference}`);
          }
        });
      }
    }
  });

  void describe('the order the sides run in', () => {
    void test('does not change what a side computes', () => {
      for (const scenario of SCENARIOS) {
        const commands = randomScript(7, RANDOM_STEPS, [8, 16, 33, 50]);
        const hashes = ORDERS.map((order) => hashStates(runPair(scenario, commands, order).states));

        assert.deepEqual(hashes, [hashes[0], hashes[0], hashes[0]], scenario.name);
      }
    });
  });

  void describe('the scenarios', () => {
    // A scenario that no longer reaches what its name says is a passing test of nothing.
    /**
     * Runs the scripted run of the scenario whose name starts with the given text.
     * @returns The states of the run.
     */
    function run(name: string, msec = 16): StepState[] {
      const scenario = SCENARIOS.find((candidate) => candidate.name.startsWith(name))!;

      return runPair(scenario, scenario.script(msec), 'first-then-second').states;
    }

    void test('stairs: the player climbs onto the steps', () => {
      assert.ok(Math.max(...run('stairs').map((state) => state.origin[2]!)) > 24 + 30);
    });

    void test('jump: the player leaves the ground and lands again', () => {
      const states = run('jump');

      assert.ok(states.some((state) => !state.onground));
      assert.equal(states.at(-1)!.onground, true);
    });

    void test('water: the player is in water at some point', () => {
      assert.ok(run('water').some((state) => state.waterlevel > 0));
    });

    void test('slopes: the player gets up the gentle slope', () => {
      assert.ok(Math.max(...run('walkable').map((state) => state.origin[2]!)) > 24 + 20);
    });

    void test('wall: the player ends up stopped at the wall, not through it', () => {
      assert.ok(run('wall').every((state) => state.origin[0]! <= 900 - 16));
    });

    void test('every walking scenario moves the player', () => {
      for (const scenario of SCENARIOS) {
        const states = runPair(scenario, scenario.script(16), 'first-then-second').states;
        const last = states.at(-1)!;
        const moved = Math.hypot(last.origin[0]! - scenario.origin[0], last.origin[1]! - scenario.origin[1], last.origin[2]! - scenario.origin[2]);

        assert.ok(moved > 10 || scenario.pmType === 'dead', `${scenario.name}: ${moved}`);
      }
    });
  });
});

/** The fields of an entity that the server wrapper and the physents read and write, which is all the stand-ins here have. */
interface FakeEntity {
  readonly num: number;
  origin: Vector;
  velocity: Vector;
  angles: Vector;
  v_angle: Vector;
  mins: Vector;
  maxs: Vector;
  modelindex: number;
  movetype: Defs.moveType;
  solid: Defs.solid;
  flags: number;
  groundentity: FakeEntity | null;
  teleport_time: number;
  deadflag: number;
  waterlevel: number;
  watertype: number;
}

/**
 * Makes an entity stand-in and the edict that holds it.
 * @returns The edict, whose `entity` is the stand-in.
 */
function createFakeEdict(num: number, fields: Partial<FakeEntity>): { readonly num: number; readonly entity: FakeEntity; isFree(): boolean } {
  const entity: FakeEntity = {
    num,
    origin: new Vector(),
    velocity: new Vector(),
    angles: new Vector(),
    v_angle: new Vector(),
    mins: new Vector(),
    maxs: new Vector(),
    modelindex: 0,
    movetype: Defs.moveType.MOVETYPE_NONE,
    solid: Defs.solid.SOLID_NOT,
    flags: 0,
    groundentity: null,
    teleport_time: 0,
    deadflag: 0,
    waterlevel: 0,
    watertype: -1,
    ...fields,
  };

  return { num, entity, isFree: () => false };
}

/** The server's way to run a player's command, with the connection state it keeps between commands. */
interface ServerWrapperSide {
  readonly run: (spec: CommandSpec, step: number) => StepState;
}

/**
 * Builds the server side of a wrapper run: the real `ServerClientPhysics._runSharedPmove` over a world of its own.
 * @returns A function that runs one command and reads what the server keeps afterwards.
 */
function createServerWrapperSide(scenario: Scenario): ServerWrapperSide {
  const pmove = new Pmove();
  const doorModel = createDoorModel();

  pmove.movevars = createMoveVars();
  pmove.setWorldmodel(createDeterminismWorld());

  const edicts = [
    createFakeEdict(0, { solid: Defs.solid.SOLID_BSP }),
    createFakeEdict(1, {
      origin: new Vector(...scenario.origin),
      movetype: scenario.pmType === 'noclip' ? Defs.moveType.MOVETYPE_NOCLIP : Defs.moveType.MOVETYPE_WALK,
      solid: Defs.solid.SOLID_SLIDEBOX,
      flags: scenario.pmType === undefined ? Defs.flags.FL_ONGROUND : 0,
      deadflag: scenario.pmType === 'dead' ? 2 : 0,
    }),
    createFakeEdict(BOX_ENTITY_NUM, { mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 32), solid: Defs.solid.SOLID_BBOX }),
    createFakeEdict(DOOR_ENTITY_NUM, { modelindex: 1, movetype: Defs.moveType.MOVETYPE_PUSH, solid: Defs.solid.SOLID_BSP }),
  ];
  const [, playerEdict, boxEdict, doorEdict] = edicts as [typeof edicts[0], typeof edicts[0], typeof edicts[0], typeof edicts[0]];
  const playerEntity = playerEdict.entity;
  const boxEntity = boxEdict.entity;
  const doorEntity = doorEdict.entity;
  const server = { time: 0, num_edicts: edicts.length, edicts, models: [null, doorModel] };
  const sv = { pmove, server, physics: { impact(): void {} } } as unknown as Server;
  const physics = new ServerClientPhysics(sv);
  const client = { cmd: toUserCmd({ msec: 0, forwardmove: 0, sidemove: 0, upmove: 0, yaw: 0, pitch: 0 }), pmOldButtons: 0, pmFlags: 0, pmTime: 0 } as unknown as ServerClient;

  return {
    run(spec, step) {
      const placement = scenario.placement(step);

      boxEntity.origin.set(placement.boxOrigin);
      doorEntity.origin.set(placement.doorOrigin);
      playerEntity.v_angle = toUserCmd(spec).angles.copy();
      client.cmd.set(toUserCmd(spec));
      physics._runSharedPmove(playerEdict as unknown as ServerEdict, client);

      // the timer the server keeps is an absolute time; what is left of it is what the client counts down
      const waterjumptime = (playerEntity.flags & Defs.flags.FL_WATERJUMP) !== 0 ? playerEntity.teleport_time - server.time : 0;

      server.time += Math.min(200, Math.max(1, spec.msec)) / 1000;

      return {
        origin: [...playerEntity.origin],
        velocity: [...playerEntity.velocity],
        onground: (playerEntity.flags & Defs.flags.FL_ONGROUND) !== 0,
        pmFlags: client.pmFlags,
        pmTime: client.pmTime,
        oldbuttons: client.pmOldButtons,
        waterlevel: playerEntity.waterlevel,
        watertype: playerEntity.watertype,
        waterjumptime,
      };
    },
  };
}

/**
 * Builds the client side of a wrapper run: the real `CL.PredictUsercmd`, carrying the state from one command to the next the way `CL.PredictMove` does.
 * @returns A function that runs one command and reads what prediction leaves.
 */
function createClientWrapperSide(scenario: Scenario): ServerWrapperSide {
  const side = createSide(scenario);
  const { player, pmove, doorModel } = side;
  const from = new ClientPlayerState(player);
  const to = new ClientPlayerState(player);

  from.origin.set(player.origin);
  from.onground = scenario.pmType === undefined ? 0 : null;
  from.pmType = player.pmType;
  // the server wrapper starts from a connection with no flags set, so does this
  from.pmFlags = 0;
  player.pmFlags = 0;

  return {
    run(spec, step) {
      placeEntities(pmove, scenario.placement(step), doorModel);
      CL.PredictUsercmd(player, from, to, toUserCmd(spec));

      const state: StepState = {
        origin: [...to.origin],
        velocity: [...to.velocity],
        onground: to.onground !== null,
        pmFlags: to.pmFlags,
        pmTime: to.pmTime,
        oldbuttons: to.oldbuttons,
        waterlevel: player.waterlevel,
        watertype: player.watertype,
        waterjumptime: to.waterjumptime,
      };

      from.origin.set(to.origin);
      from.velocity.set(to.velocity);
      from.angles.set(to.angles);
      from.onground = to.onground;
      from.pmFlags = to.pmFlags;
      from.pmTime = to.pmTime;
      from.oldbuttons = to.oldbuttons;
      from.pmType = to.pmType;
      from.waterjumptime = to.waterjumptime;

      return state;
    },
  };
}

/** The timers of the two sides are the same number computed two ways (a difference of absolute times against a countdown), so they are compared to a tolerance. */
const TIMER_TOLERANCE = 1e-9;

/**
 * Runs a script through the server wrapper and the client wrapper and compares them after every command.
 * @returns The first difference, or null.
 */
function runWrappers(scenario: Scenario, commands: readonly CommandSpec[]): string | null {
  const server = createServerWrapperSide(scenario);
  const client = createClientWrapperSide(scenario);

  for (let step = 0; step < commands.length; step++) {
    const spec = commands[step]!;
    const serverState = server.run(spec, step);
    const clientState = client.run(spec, step);
    // Spectator movement returns before the water is looked at, so these two are inputs the sides echo, each with its own starting value.
    const ignoredWater = scenario.pmType === 'noclip' ? { waterlevel: 0, watertype: 0 } : {};
    const difference = describeDifference({ ...serverState, waterjumptime: 0, ...ignoredWater }, { ...clientState, waterjumptime: 0, ...ignoredWater });

    if (difference !== null) {
      return `step ${step} (msec ${spec.msec}): ${difference}`;
    }

    if (Math.abs(serverState.waterjumptime - clientState.waterjumptime) > TIMER_TOLERANCE) {
      return `step ${step} (msec ${spec.msec}): waterjumptime: ${serverState.waterjumptime} against ${clientState.waterjumptime}`;
    }
  }

  return null;
}

void describe('Movement determinism: the server wrapper against client prediction', () => {
  const SHORT_MSEC = [8, 16, 33, 50, 51, 100];
  const LONG_MSEC = [101, 150, 200];

  void describe('commands up to 100 ms', () => {
    for (const scenario of SCENARIOS) {
      void test(`${scenario.name}: scripted`, () => {
        for (const msec of SHORT_MSEC) {
          const difference = runWrappers(scenario, scenario.script(msec));

          assert.equal(difference, null, `msec ${msec}: ${difference}`);
        }
      });

      void test(`${scenario.name}: seeded random`, () => {
        for (const seed of RANDOM_SEEDS) {
          const difference = runWrappers(scenario, randomScript(seed, RANDOM_STEPS, SHORT_MSEC));

          assert.equal(difference, null, `seed ${seed}: ${difference}`);
        }
      });
    }
  });

  // The server used to split a long command once, prediction splits until a piece is 50 ms or less; above 100 ms that were
  // two moves against four. Both split recursively now.
  void describe('commands above 100 ms', () => {
    for (const scenario of SCENARIOS) {
      void test(`${scenario.name}: scripted`, () => {
        for (const msec of LONG_MSEC) {
          const difference = runWrappers(scenario, scenario.script(msec));

          assert.equal(difference, null, `msec ${msec}: ${difference}`);
        }
      });

      void test(`${scenario.name}: seeded random`, () => {
        for (const seed of RANDOM_SEEDS) {
          const difference = runWrappers(scenario, randomScript(seed, RANDOM_STEPS, [...SHORT_MSEC, ...LONG_MSEC]));

          assert.equal(difference, null, `seed ${seed}: ${difference}`);
        }
      });
    }
  });
});

/**
 * Builds a server over silent stand-ins, which is all its movement variables need.
 * @returns A server that has not spawned a map.
 */
function createBareServer(): Server {
  const silent = (): void => {};
  const dependencies: ServerDependencies = {
    con: { Print: silent, DPrint: silent, PrintWarning: silent, PrintError: silent, PrintSuccess: silent, StartCapturing: silent, StopCapturing: () => '' },
    sys: { Print: silent, FloatTime: () => 0 },
    net: {} as ServerDependencies['net'],
    mod: {} as ServerDependencies['mod'],
    view: { CalcRoll: () => 0 },
    files: { LoadFile: () => Promise.resolve(null), WriteGeneratedFile: () => Promise.resolve(true) },
    engineVersion: () => 'test',
    gameEdition: () => ({ registered: true, hipnotic: false, rogue: false }),
    dedicated: true,
  };

  return new Server(dependencies);
}

after(() => {
  Cvar.Shutdown();
});

void describe('Movement variables of the server', () => {
  void test('follow the server cvars', () => {
    const sv = createBareServer();

    sv.Init();
    sv.InitPmove();
    sv.gravity!.set(300);
    sv.friction!.set(9);

    assert.equal(sv.pmove!.movevars.gravity, 300);
    assert.equal(sv.pmove!.movevars.friction, 9);
  });

  // Until a client has heard from a server it predicts with the defaults of `MoveVars`; they are the values the cvars start with.
  void test('start with the defaults a client has before it hears from the server', () => {
    const sv = createBareServer();
    const defaults = new MoveVars();

    sv.Init();
    sv.InitPmove();

    for (const [variable, cvarName] of Object.entries(MOVEVAR_CVARS) as Array<[MoveVarName, string]>) {
      assert.equal(sv.pmove!.movevars[variable], defaults[variable], cvarName);
    }
  });
});
