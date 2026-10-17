import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createServerRuntime, type ServerRuntimeServices } from '../../source/engine/bootstrap/createServerRuntime.ts';
import type { ConsoleCommand } from '../../source/engine/common/Cmd.ts';
import type { ServerClient } from '../../source/engine/server/Client.ts';
import { createCvarStub } from '../support/cvarStub.ts';
import Server from '../../source/engine/server/Server.ts';
import ServerHost from '../../source/engine/server/ServerHost.ts';

/** The part of the process host the runtime reads and writes. */
interface StandInHost {
  version: { string: string };
  speeds: { value: number };
  noclip_anglehack: boolean;
  ScheduleForNextFrame(callback: () => void | Promise<void>): void;
}

/**
 * Builds stand-ins for the realm services a server runtime is made of.
 * @returns the services and what they recorded
 */
function createServices(): { services: ServerRuntimeServices, host: StandInHost, scheduled: Array<() => void | Promise<void>> } {
  const scheduled: Array<() => void | Promise<void>> = [];
  const host: StandInHost = {
    version: { string: '9.9.9+test' },
    speeds: { value: 0 },
    noclip_anglehack: false,
    ScheduleForNextFrame(callback: () => void | Promise<void>) { scheduled.push(callback); },
  };

  return {
    host,
    scheduled,
    services: {
      con: { Print() {}, DPrint() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {}, StartCapturing() {}, StopCapturing: () => '' },
      sys: { Print() {}, FloatTime: () => 0 },
      net: {},
      mod: {},
      com: { LoadFile: () => Promise.resolve(null), WriteFile: () => Promise.resolve(true) },
      host,
      view: { CalcRoll: () => 0 },
      gameEdition: () => ({ registered: true, hipnotic: false, rogue: false }),
      // The stand-ins have the members a runtime is built from and the tests look at.
    } as unknown as ServerRuntimeServices,
  };
}

void describe('createServerRuntime', () => {
  void test('builds a server and the host that drives it', () => {
    const { services } = createServices();
    const { sv, serverHost } = createServerRuntime(services, true);

    assert.ok(sv instanceof Server);
    assert.ok(serverHost instanceof ServerHost);
    assert.equal(serverHost.sv, sv);
  });

  void test('hands the services to the server instead of letting it look them up', () => {
    const { services } = createServices();
    const { sv } = createServerRuntime(services, true);

    assert.equal(sv.con, services.con);
    assert.equal(sv.sys, services.sys);
    assert.equal(sv.net, services.net);
    assert.equal(sv.mod, services.mod);
    assert.equal(sv.view, services.view);
    assert.equal(sv.files, services.com);
  });

  void test('tells clients the engine version of the moment', () => {
    const { services, host } = createServices();
    const { sv } = createServerRuntime(services, true);

    assert.equal(sv.engineVersion(), '9.9.9+test');

    host.version = { string: '10.0.0' };

    assert.equal(sv.engineVersion(), '10.0.0');
  });

  void test('remembers whether it serves a dedicated server', () => {
    const dedicated = createServerRuntime(createServices().services, true);
    const listen = createServerRuntime(createServices().services, false);

    assert.equal(dedicated.sv.dedicated, true);
    assert.equal(listen.sv.dedicated, false);
  });

  void test('lets the host schedule work for the next frame of the process', () => {
    const { services, scheduled } = createServices();
    const { serverHost } = createServerRuntime(services, true);

    // `map` is the dedicated console command that schedules the actual spawn.
    serverHost.map({ client: null } as ConsoleCommand, 'start');

    assert.equal(scheduled.length, 1);
  });

  void test('reports the noclip view hack of a server to the process that shows the view', () => {
    const { services, host } = createServices();
    const { sv, serverHost } = createServerRuntime(services, true);
    const entity = { flags: 0, movetype: 3 };
    // The command reads the entity of the client's edict and writes to its message.
    const client = { edict: { entity }, message: { writeByte() {}, writeString() {} } } as unknown as ServerClient;

    sv.cheats = createCvarStub(1);

    serverHost.noclip({ client, forward: () => false } as ConsoleCommand);

    assert.equal(host.noclip_anglehack, true);

    serverHost.noclip({ client, forward: () => false } as ConsoleCommand);

    assert.equal(host.noclip_anglehack, false);
  });

  void test('keeps two runtimes apart', () => {
    const first = createServerRuntime(createServices().services, true);
    const second = createServerRuntime(createServices().services, true);

    first.sv.server.active = true;

    assert.equal(second.sv.server.active, false);
    assert.notEqual(first.sv.svs, second.sv.svs);
  });
});
