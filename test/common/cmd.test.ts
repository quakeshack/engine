import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Cmd from '../../source/engine/common/Cmd.ts';
import COM from '../../source/engine/common/Com.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { defaultMockEngine, withMockEngine, type MockEngineConfig } from '../support/fixtures.ts';
import type { ServerClient } from '../../source/engine/server/Client.ts';
import '../support/consoleBridge.ts';
import { engineMocks } from '../support/engineMocks.ts';

/** A console that keeps what it is asked to print, by how loud it is. */
interface ConsoleCapture {
  prints: string[];
  warnings: string[];
  errors: string[];
  dprints: string[];
  Print: (message: string) => void;
  PrintWarning: (message: string) => void;
  PrintError: (message: string) => void;
  DPrint: (message: string) => void;
}

/** @returns captured console methods */
function createConsoleCapture(): ConsoleCapture {
  return {
    prints: [],
    warnings: [],
    errors: [],
    dprints: [],
    Print(this: ConsoleCapture, message: string) {
      this.prints.push(message);
    },
    PrintWarning(this: ConsoleCapture, message: string) {
      this.warnings.push(message);
    },
    PrintError(this: ConsoleCapture, message: string) {
      this.errors.push(message);
    },
    DPrint(this: ConsoleCapture, message: string) {
      this.dprints.push(message);
    },
  };
}

/**
 * Reset Cmd and Cvar globals between tests.
 */
function resetCommandState() {
  Cmd.Shutdown();
  Cmd.alias.length = 0;
  Cmd.text = '';
  Cmd.wait = false;
  Cvar.Shutdown();
}

/**
 * @param consoleCapture captured console sinks
 * @param [hostOverrides] host registry overrides
 * @returns mock registry config
 */
function createMockEngineConfig(consoleCapture: ConsoleCapture, hostOverrides: { frametime?: number } = {}): MockEngineConfig & { Host: { frametime: number } } {
  return {
    ...defaultMockEngine({}, null),
    COM,
    Con: consoleCapture,
    Host: {
      frametime: 0.1,
      ...hostOverrides,
    },
  };
}

void describe('Cmd', () => {
  void test('lists aliases without creating a broken alias entry and overwrites existing aliases by name', async () => {
    const consoleCapture = createConsoleCapture();

    await withMockEngine(createMockEngineConfig(consoleCapture), async () => {
      resetCommandState();
      Cmd.Init();

      try {
        await Cmd.ExecuteString('alias');
        assert.deepEqual(Cmd.alias, []);
        assert.deepEqual(consoleCapture.prints, ['Current alias commands:\n']);

        await Cmd.ExecuteString('alias greet echo first');
        assert.deepEqual(Cmd.alias, [{ name: 'greet', value: 'echo first\n' }]);

        await Cmd.ExecuteString('alias GREET echo second');
        assert.deepEqual(Cmd.alias, [{ name: 'greet', value: 'echo second\n' }]);

        await Cmd.ExecuteString('greet');
        assert.equal(Cmd.text, 'echo second\n');
      } finally {
        resetCommandState();
      }
    });
  });

  void test('exposes public command and variable name lists for completion', () => {
    const consoleCapture = createConsoleCapture();

    withMockEngine(createMockEngineConfig(consoleCapture), () => {
      resetCommandState();
      Cmd.Init();

      try {
        Cmd.AddCommand('customcommand', () => {});
        new Cvar('skill', '1');
        new Cvar('deathmatch', '0');

        assert.equal(Cmd.GetCommandNames().includes('alias'), true);
        assert.equal(Cmd.GetCommandNames().includes('customcommand'), true);
        assert.deepEqual(Cvar.GetVariableNames(), ['skill', 'deathmatch']);
      } finally {
        resetCommandState();
      }
    });
  });

  void test('captures rejected promises from wrapped async function commands without mutating Host', async () => {
    const consoleCapture = createConsoleCapture();
    // The command only passes its client through.
    const invokingClient = { name: 'player' } as unknown as ServerClient;

    await withMockEngine(createMockEngineConfig(consoleCapture), async () => {
      resetCommandState();
      Cmd.Init();

      try {
        Cmd.AddCommand('asyncplain', async function (arg) {
          assert.equal(arg, 'payload');
          assert.equal(this.client, invokingClient);
          assert.equal(this.command, 'asyncplain');
          assert.equal(this.args, 'asyncplain payload');
          assert.deepEqual(this.argv, ['asyncplain', 'payload']);
          assert.equal(Object.hasOwn(engineMocks.Host as object, 'client'), false);

          await Promise.resolve();

          throw new Error('boom');
        });

        await Cmd.ExecuteString('asyncplain payload', invokingClient);

        assert.equal(Object.hasOwn(engineMocks.Host as object, 'client'), false);
        assert.deepEqual(consoleCapture.errors, ['Error executing command "asyncplain":\nboom\n']);
      } finally {
        resetCommandState();
      }
    });
  });
});
