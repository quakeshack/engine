import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Cvar from '../../source/engine/common/Cvar.ts';
import Host from '../../source/engine/common/Host.ts';
import * as Def from '../../source/engine/common/Def.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Installs a minimal client-side registry (CL, Con, SV, isDedicatedServer) for the
 * duration of the callback and restores the previous registry afterwards.
 * @param {object} root0 registry overrides
 * @param {object} root0.cl CL replacement
 * @param {object} [root0.sv] SV replacement
 * @param {boolean} [root0.isDedicatedServer] isDedicatedServer replacement
 * @param {() => void} callback test callback
 */
function withIdentityRegistry({ cl, sv = { server: { active: false } }, isDedicatedServer = false }, callback) {
  const previous = {
    CL: registry.CL,
    Con: registry.Con,
    SV: registry.SV,
    isDedicatedServer: registry.isDedicatedServer,
  };

  const prints = [];

  registry.CL = cl;
  registry.Con = { Print(message) { prints.push(message); }, DPrint() {} };
  registry.SV = sv;
  registry.isDedicatedServer = isDedicatedServer;
  eventBus.publish('registry.frozen');

  try {
    callback(prints);
  } finally {
    registry.CL = previous.CL;
    registry.Con = previous.Con;
    registry.SV = previous.SV;
    registry.isDedicatedServer = previous.isDedicatedServer;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Creates a lightweight Cvar registered under Cvar._vars, freed by the caller.
 * @param {string} name cvar name
 * @param {string} value initial value
 * @returns {Cvar} the created cvar
 */
function createRealCvar(name, value) {
  return new Cvar(name, value, Cvar.FLAG.ARCHIVE);
}

void describe('Host.Name_f', () => {
  void test('prints the current name when called without arguments', () => {
    const name = createRealCvar('_cl_name', 'player');

    try {
      withIdentityRegistry({ cl: { name, cls: { state: Def.clientConnectionState.disconnected } } }, (prints) => {
        Host.Name_f.call({ client: null, forward: () => true });
        assert.deepEqual(prints, ['"name" is "player"\n']);
      });
    } finally {
      name.free();
    }
  });

  // Regression: a stray `if (!SV.server.active) return;` used to bail out before the
  // client ever set `_cl_name` or forwarded the change, which made renaming a no-op for
  // anyone who wasn't hosting a local (listen) server -- i.e. everyone joining a remote game.
  void test('updates _cl_name and forwards to the server even without a local server running', () => {
    const name = createRealCvar('_cl_name', 'player');
    let forwarded = false;

    try {
      withIdentityRegistry({
        cl: { name, cls: { state: Def.clientConnectionState.connected } },
        sv: { server: { active: false } },
      }, () => {
        Host.Name_f.call({ client: null, forward: () => { forwarded = true; return true; } }, 'NewName');

        assert.equal(name.string, 'NewName');
        assert.equal(forwarded, true);
      });
    } finally {
      name.free();
    }
  });

  void test('updates _cl_name locally but does not forward while not yet connected', () => {
    const name = createRealCvar('_cl_name', 'player');
    let forwarded = false;

    try {
      withIdentityRegistry({
        cl: { name, cls: { state: Def.clientConnectionState.disconnected } },
        sv: { server: { active: false } },
      }, () => {
        Host.Name_f.call({ client: null, forward: () => { forwarded = true; return true; } }, 'NewName');

        assert.equal(name.string, 'NewName');
        assert.equal(forwarded, false);
      });
    } finally {
      name.free();
    }
  });
});

void describe('Host.Color_f', () => {
  void test('prints the current color when called without arguments', () => {
    const color = createRealCvar('_cl_color', String((3 << 4) + 5));

    try {
      withIdentityRegistry({ cl: { color, cls: { state: Def.clientConnectionState.disconnected } } }, (prints) => {
        Host.Color_f.call({ client: null, forward: () => true });
        assert.deepEqual(prints, ['"color" is "3 5"\ncolor <0-13> [0-13]\n']);
      });
    } finally {
      color.free();
    }
  });

  void test('applies the same value to shirt and pants when only one argument is given', () => {
    const color = createRealCvar('_cl_color', '0');

    try {
      withIdentityRegistry({
        cl: { color, cls: { state: Def.clientConnectionState.connected } },
        sv: { server: { active: false } },
      }, () => {
        Host.Color_f.call({ client: null, forward: () => true }, '7');

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
  void test('applies distinct shirt and pants colors when two arguments are given', () => {
    const color = createRealCvar('_cl_color', '0');
    let forwarded = false;

    try {
      withIdentityRegistry({
        cl: { color, cls: { state: Def.clientConnectionState.connected } },
        sv: { server: { active: false } },
      }, () => {
        Host.Color_f.call({ client: null, forward: () => { forwarded = true; return true; } }, '3', '5');

        assert.equal(color.value >> 4, 3);
        assert.equal(color.value & 15, 5);
        assert.equal(forwarded, true);
      });
    } finally {
      color.free();
    }
  });

  void test('updates _cl_color locally but does not forward while not yet connected', () => {
    const color = createRealCvar('_cl_color', '0');
    let forwarded = false;

    try {
      withIdentityRegistry({
        cl: { color, cls: { state: Def.clientConnectionState.disconnected } },
        sv: { server: { active: false } },
      }, () => {
        Host.Color_f.call({ client: null, forward: () => { forwarded = true; return true; } }, '3', '5');

        assert.equal(color.value >> 4, 3);
        assert.equal(color.value & 15, 5);
        assert.equal(forwarded, false);
      });
    } finally {
      color.free();
    }
  });
});
