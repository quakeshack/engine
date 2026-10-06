import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';

import WorkerServerController from '../../source/engine/client/WorkerServerController.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import COM from '../../source/engine/common/Com.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { withMockRegistry } from '../physics/fixtures.mjs';

/**
 * Runs a console line here; tokenizing it needs the static parser of COM.
 * @param {string} line what the player typed
 * @returns {Promise<void>} settles when the line was handled
 */
async function typeLine(line) {
  await withMockRegistry({ COM: /** @type {any} */ (COM), Con: { Print() {}, DPrint() {} }, Host: { frametime: 0.1 }, SV: {} }, async () => {
    await Cmd.ExecuteString(line);
  });
}

const REALM = new URL('./fixtures/cvar-realm.mjs', import.meta.url);

const INIT = Object.freeze({
  searchpaths: [], gamedir: null, game: 'id1', urls: {}, engineVersion: 'test', edition: { registered: true, hipnotic: false, rogue: false }, argv: [], buildConfig: undefined,
});

/**
 * Starts a server realm in a real worker thread and a controller for it in this one. The two realms have
 * separate cvar tables, which is the point: nothing here is shared but the port.
 * @param {{ own?: Record<string, string> }} [options] cvars this realm has before the console is attached
 * @returns {Promise<object>} the controller and ways to look into the other realm
 */
async function createRealms({ own = {} } = {}) {
  for (const [name, value] of Object.entries(own)) {
    new Cvar(name, value);
  }

  const channel = new MessageChannel();
  const worker = new Worker(REALM);
  const probes = new Map();
  let nextProbe = 1;
  const prints = [];

  channel.port1.addEventListener('message', (event) => {
    const result = event.data?.probeResult;

    if (result !== undefined) {
      probes.get(result.id)?.(result.value);
    }
  });

  const probe = (message) => new Promise((resolve) => {
    const id = nextProbe++;

    probes.set(id, resolve);
    channel.port1.postMessage({ probe: { id, ...message } });
  });

  const controller = new WorkerServerController({
    worker: {
      postMessage: (message, transfer) => { worker.postMessage(message, transfer); },
      shutdown: async () => { await worker.terminate(); },
    },
    channel: /** @type {any} */ (channel),
    createInit: () => INIT,
    con: { Print: (t) => prints.push(t), PrintSuccess() {}, PrintWarning: (t) => prints.push(t), PrintError() {}, DPrint() {} },
    operatorName: () => 'Ranger',
    onNoclipAnglehack() {},
    publish() {},
    onError() {},
    onCrash() {},
  });

  await controller.init();

  return {
    controller,
    prints,
    get: (name) => probe({ kind: 'get', name }),
    gameSets: (name, value) => probe({ kind: 'set', name, value }),
    executed: () => probe({ kind: 'executed' }),
    send: (message) => { channel.port1.postMessage({ control: message }); },
    async close() {
      await controller.dispose();
      channel.port1.close();
    },
  };
}

/**
 * @param {() => boolean} condition what to wait for
 * @returns {Promise<void>} settles once it holds
 */
async function until(condition) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.ok(condition(), 'condition was not met in time');
}

void describe('cvars and commands across two realms', () => {
  const realms = [];

  beforeEach(() => {
    Cvar.Shutdown();
    Cmd.Init();
  });

  afterEach(async () => {
    for (const realm of realms.splice(0)) {
      await realm.close();
    }

    Cvar.Shutdown();
  });

  after(() => {
    Cmd.Init();
  });

  /**
   * @param {Parameters<typeof createRealms>[0]} [options] see createRealms
   * @returns {Promise<Awaited<ReturnType<typeof createRealms>>>} the realms, closed when the test ends
   */
  async function open(options) {
    const realm = await createRealms(options);

    realms.push(realm);

    return realm;
  }

  void test('the cvars of the server exist here before the first console command', async () => {
    const realm = await open();

    assert.equal(Cvar.FindVar('sv_gravity'), null, 'not before the console is attached');

    realm.controller.attachConsole();

    assert.equal(Cvar.FindVar('sv_gravity').string, '800');
    assert.equal(Cvar.FindVar('sv_gravity').description, 'Gravity.');
    assert.ok(Cmd.HasCommand('status'));
    assert.ok(Cmd.HasCommand('maxplayers'));
  });

  void test('a write here is visible to server code before its next frame', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    Cvar.FindVar('sv_gravity').set('400');

    // The probe is behind the write on the same port, so the answer shows what the next frame would see.
    assert.equal(await realm.get('sv_gravity'), '400');
  });

  void test('a write of the game shows up here without anyone asking', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    await realm.gameSets('sv_gravity', '300');
    await until(() => Cvar.FindVar('sv_gravity').string === '300');

    assert.equal(Cvar.FindVar('sv_gravity').string, '300');
  });

  void test('archived cvars of the server are written to the configuration', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    Cvar.FindVar('sv_gravity').set('450');

    assert.match(Cvar.WriteVariables(), /seta "sv_gravity" "450"/);
  });

  void test('read-only is enforced by the server, even when the page is asked to change it', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    realm.send({ kind: 'cvar-set', name: 'registered', value: '1' });

    assert.equal(await realm.get('registered'), '0');
  });

  void test('a cheat variable cannot be changed from here while the server has no cheats', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    realm.send({ kind: 'cvar-set', name: 'nav_debug_path', value: '1' });

    assert.equal(await realm.get('nav_debug_path'), '0');
    await until(() => Cvar.FindVar('nav_debug_path').string === '0');
  });

  void test('the answer of the server puts a refused change right again here', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    // Bypassing the checks of the console, as a script that sets the value directly would.
    Cvar.FindVar('nav_debug_path').set('1');
    assert.equal(await realm.get('nav_debug_path'), '0');
    await until(() => Cvar.FindVar('nav_debug_path').string === '0');
  });

  void test('a variable both realms have keeps the value of this one', async () => {
    const realm = await open({ own: { developer: '2' } });

    realm.controller.attachConsole();

    assert.equal(await realm.get('developer'), '2');
    assert.equal(Cvar.FindVar('developer').string, '2');
  });

  void test('a command only the server has is sent over, with the name of the player', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    await typeLine('maxplayers 4');

    assert.deepEqual(await realm.executed(), ['maxplayers 4 as Ranger']);
  });

  void test('a command both realms have stays here', async () => {
    const realm = await open();
    let ran = 0;

    Cmd.AddCommand('status', () => { ran++; });
    realm.controller.attachConsole();
    await typeLine('status');

    assert.equal(ran, 1);
    assert.deepEqual(await realm.executed(), []);
  });

  void test('the cvars stay with their values, but cannot be changed, once the server is gone', async () => {
    const realm = await open();

    realm.controller.attachConsole();
    Cvar.FindVar('sv_gravity').set('500');
    await realm.get('sv_gravity');
    await realm.controller.dispose();

    const cvar = Cvar.FindVar('sv_gravity');

    assert.equal(cvar.string, '500');
    assert.ok((cvar.flags & Cvar.FLAG.READONLY) !== 0);
  });
});
