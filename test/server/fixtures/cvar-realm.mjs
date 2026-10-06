// The server side of test/server/server-cvar-realms.test.mjs: a realm of its own with its own cvar
// table, answering the same control plane a server worker does. The probes at the end let the test
// look into this realm and play the part of the game.
import { parentPort } from 'node:worker_threads';

import Cmd from '../../../source/engine/common/Cmd.ts';
import Cvar from '../../../source/engine/common/Cvar.ts';
import { eventBus } from '../../../source/engine/common/EventBus.ts';
import { ControlLink } from '../../../source/engine/common/ServerWorkerProtocol.ts';
import { registry } from '../../../source/engine/registry.ts';
import ServerCvarSync from '../../../source/engine/server/ServerCvarSync.ts';
import ServerWorkerRuntime from '../../../source/engine/server/ServerWorkerRuntime.ts';

registry.Con = /** @type {any} */ ({ Print() {}, PrintWarning() {}, DPrint() {} });
registry.SV = /** @type {any} */ ({ server: { active: true } });
registry.CL = undefined;
eventBus.publish('registry.frozen');

parentPort.once('message', ({ port }) => {
  Cmd.Init();

  new Cvar('sv_gravity', '800', Cvar.FLAG.SERVER | Cvar.FLAG.ARCHIVE, 'Gravity.');
  new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);
  new Cvar('registered', '0', Cvar.FLAG.READONLY);
  new Cvar('nav_debug_path', '0', Cvar.FLAG.CHEAT);
  new Cvar('developer', '0');

  const executed = [];
  let runtime = null;
  const link = new ControlLink(port, (message) => runtime.handle(message));
  const sync = new ServerCvarSync((message) => link.send(message));

  sync.start();

  runtime = new ServerWorkerRuntime({
    send: (message) => link.send(message),
    readState: () => ({ active: true, maxclients: 1, mapname: 'start', paused: false }),
    host: { simulationAllowed: false, StartMap: () => Promise.resolve(true), AnnounceChangelevel() {}, Changelevel: () => Promise.resolve(true), ShutdownServer() {}, getViewthing: () => null, setViewthingFrame() {} },
    console: {
      describe: () => ({ cvars: sync.describe(), commands: ['status', 'god', 'maxplayers'] }),
      setCvar: (name, value) => { sync.apply(name, value); },
      execute: (text, operator) => { executed.push(`${text} as ${operator}`); },
    },
    savegame: { capture: () => ({ ok: false, reason: 'unused' }), restore: () => Promise.resolve() },
    frame: () => Promise.resolve(),
    fallbackInterval: () => 0,
    isServerActive: () => true,
  });

  port.addEventListener('message', (event) => {
    const probe = event.data?.probe;

    if (probe === undefined) {
      return;
    }

    switch (probe.kind) {
      case 'get':
        port.postMessage({ probeResult: { id: probe.id, value: Cvar.FindVar(probe.name)?.string ?? null } });
        break;
      case 'set': // the game changes a variable
        Cvar.Set(probe.name, probe.value);
        port.postMessage({ probeResult: { id: probe.id, value: 'done' } });
        break;
      case 'executed':
        port.postMessage({ probeResult: { id: probe.id, value: executed } });
        break;
      default:
        break;
    }
  });

  runtime.start();
});
