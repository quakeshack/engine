import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Cvar from '../../source/engine/common/Cvar.ts';
import * as Def from '../../source/engine/common/Def.ts';
import '../support/consoleBridge.ts';
import { useClientStateOf } from '../support/clientState.ts';
import ClientHost from '../../source/engine/client/ClientHost.ts';
import { runConsoleCommand } from '../support/consoleCommands.ts';
import { engineMocks } from '../support/engineMocks.ts';
import type { MockClient, MockServer } from '../support/fixtures.ts';

/**
 * Installs a minimal client-side mock (CL, Con, SV) for the
 * duration of the callback and restores the previous one afterwards.
 * @param root0 mock overrides
 * @param root0.cl CL replacement
 * @param [root0.sv] SV replacement
 * @param callback test callback
 * @returns settles when the callback did and the mocks are back
 */
async function withIdentityMocks({ cl, sv = { server: { active: false } } }: { cl: MockClient; sv?: MockServer }, callback: (prints: string[]) => void | Promise<void>): Promise<void> {
  const previous = {
    CL: engineMocks.CL,
    Con: engineMocks.Con,
    SV: engineMocks.SV,
  };

  const prints: string[] = [];

  engineMocks.CL = cl;

  const restoreClientState = useClientStateOf(cl);
  engineMocks.Con = { Print(message: string) { prints.push(message); }, DPrint() {} };
  engineMocks.SV = sv;

  try {
    await callback(prints);
  } finally {
    // The mocks are put back as they were found, whatever happened meanwhile.
    /* eslint-disable require-atomic-updates */
    engineMocks.CL = previous.CL;
    restoreClientState();
    engineMocks.Con = previous.Con;
    engineMocks.SV = previous.SV;
    /* eslint-enable require-atomic-updates */
  }
}

/**
 * Creates a lightweight Cvar registered under Cvar._vars, freed by the caller.
 * @param name cvar name
 * @param value initial value
 * @returns the created cvar
 */
function createRealCvar(name: string, value: string): Cvar {
  return new Cvar(name, value, Cvar.FLAG.ARCHIVE);
}

void describe('ClientHost.NameCommand', () => {
  void test('prints the current name when called without arguments', async () => {
    const name = createRealCvar('_cl_name', 'player');

    try {
      await withIdentityMocks({ cl: { name, cls: { state: Def.clientConnectionState.disconnected } } }, async (prints) => {
        await runConsoleCommand(ClientHost.NameCommand, { client: null, forward: () => true });
        assert.deepEqual(prints, ['"name" is "player"\n']);
      });
    } finally {
      name.free();
    }
  });

  // Regression: a stray `if (!SV.server.active) return;` used to bail out before the
  // client ever set `_cl_name` or forwarded the change, which made renaming a no-op for
  // anyone who wasn't hosting a local (listen) server -- i.e. everyone joining a remote game.
  void test('updates _cl_name and forwards to the server even without a local server running', async () => {
    const name = createRealCvar('_cl_name', 'player');
    let forwarded = false;

    try {
      await withIdentityMocks({
        cl: { name, cls: { state: Def.clientConnectionState.connected } },
        sv: { server: { active: false } },
      }, async () => {
        await runConsoleCommand(ClientHost.NameCommand, { client: null, forward: () => { forwarded = true; return true; } }, 'NewName');

        assert.equal(name.string, 'NewName');
        assert.equal(forwarded, true);
      });
    } finally {
      name.free();
    }
  });

  void test('updates _cl_name locally but does not forward while not yet connected', async () => {
    const name = createRealCvar('_cl_name', 'player');
    let forwarded = false;

    try {
      await withIdentityMocks({
        cl: { name, cls: { state: Def.clientConnectionState.disconnected } },
        sv: { server: { active: false } },
      }, async () => {
        await runConsoleCommand(ClientHost.NameCommand, { client: null, forward: () => { forwarded = true; return true; } }, 'NewName');

        assert.equal(name.string, 'NewName');
        assert.equal(forwarded, false);
      });
    } finally {
      name.free();
    }
  });
});

void describe('ClientHost.ColorCommand', () => {
  void test('prints the current color when called without arguments', async () => {
    const color = createRealCvar('_cl_color', String((3 << 4) + 5));

    try {
      await withIdentityMocks({ cl: { color, cls: { state: Def.clientConnectionState.disconnected } } }, async (prints) => {
        await runConsoleCommand(ClientHost.ColorCommand, { client: null, forward: () => true });
        assert.deepEqual(prints, ['"color" is "3 5"\ncolor <0-13> [0-13]\n']);
      });
    } finally {
      color.free();
    }
  });

  void test('applies the same value to shirt and pants when only one argument is given', async () => {
    const color = createRealCvar('_cl_color', '0');

    try {
      await withIdentityMocks({
        cl: { color, cls: { state: Def.clientConnectionState.connected } },
        sv: { server: { active: false } },
      }, async () => {
        await runConsoleCommand(ClientHost.ColorCommand, { client: null, forward: () => true }, '7');

        assert.equal(color.value >> 4, 7);
        assert.equal(color.value & 15, 7);
      });
    } finally {
      color.free();
    }
  });

  // Regression: argv was indexed as if argv[0] were still the command name (the original
  // Quake C `Cmd_Argv(0)` convention), but Cmd.ExecuteString here already strips the
  // command name before invoking the handler. With two arguments this used to collapse
  // top and bottom to the same (second) value, so the shirt color was silently dropped.
  void test('applies distinct shirt and pants colors when two arguments are given', async () => {
    const color = createRealCvar('_cl_color', '0');
    let forwarded = false;

    try {
      await withIdentityMocks({
        cl: { color, cls: { state: Def.clientConnectionState.connected } },
        sv: { server: { active: false } },
      }, async () => {
        await runConsoleCommand(ClientHost.ColorCommand, { client: null, forward: () => { forwarded = true; return true; } }, '3', '5');

        assert.equal(color.value >> 4, 3);
        assert.equal(color.value & 15, 5);
        assert.equal(forwarded, true);
      });
    } finally {
      color.free();
    }
  });

  void test('updates _cl_color locally but does not forward while not yet connected', async () => {
    const color = createRealCvar('_cl_color', '0');
    let forwarded = false;

    try {
      await withIdentityMocks({
        cl: { color, cls: { state: Def.clientConnectionState.disconnected } },
        sv: { server: { active: false } },
      }, async () => {
        await runConsoleCommand(ClientHost.ColorCommand, { client: null, forward: () => { forwarded = true; return true; } }, '3', '5');

        assert.equal(color.value >> 4, 3);
        assert.equal(color.value & 15, 5);
        assert.equal(forwarded, false);
      });
    } finally {
      color.free();
    }
  });
});
