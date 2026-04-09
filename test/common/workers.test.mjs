import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import PlatformWorker from '../../source/engine/common/PlatformWorker.ts';
import WorkerManager from '../../source/engine/common/WorkerManager.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

class FakeNodeWorker {
  constructor() {
    this.listeners = {
      error: [],
      message: [],
    };
    this.messages = [];
    this.terminated = 0;
  }

  on(event, listener) {
    this.listeners[event].push(listener);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated += 1;
    return Promise.resolve(0);
  }

  emit(event, payload) {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }
}

/** @returns {{ prints: string[], successes: string[], warnings: string[], errors: string[], dprints: string[], Print: (message: string) => void, PrintSuccess: (message: string) => void, PrintWarning: (message: string) => void, PrintError: (message: string) => void, DPrint: (message: string) => void }} console capture */
function createConsoleCapture() {
  return {
    prints: [],
    successes: [],
    warnings: [],
    errors: [],
    dprints: [],
    Print(message) {
      this.prints.push(message);
    },
    PrintSuccess(message) {
      this.successes.push(message);
    },
    PrintWarning(message) {
      this.warnings.push(message);
    },
    PrintError(message) {
      this.errors.push(message);
    },
    DPrint(message) {
      this.dprints.push(message);
    },
  };
}

/**
 * Run with a minimal worker-capable registry.
 * @param {ReturnType<typeof createConsoleCapture>} consoleCapture
 * @param {() => void | Promise<void>} callback
 */
async function withWorkerRegistry(consoleCapture, callback) {
  const previousCon = registry.Con;
  const previousCom = registry.COM;
  const previousHost = registry.Host;
  const previousUrls = registry.urls;
  const crashes = [];

  Object.assign(registry, {
    Con: /** @type {typeof import('../../source/engine/common/Console.ts').default} */ (/** @type {unknown} */ (consoleCapture)),
    COM: /** @type {typeof import('../../source/engine/common/Com.ts').default} */ ({
    searchpaths: [{ filename: 'id1', pack: [] }],
    gamedir: [{ filename: 'id1', pack: [] }],
    game: 'id1',
    }),
    Host: /** @type {typeof import('../../source/engine/common/Host.ts').default} */ (/** @type {unknown} */ ({
      crashes,
      HandleCrash(error) {
        crashes.push(error);
      },
    })),
    urls: /** @type {import('../../source/engine/build-config').URLs} */ ({ cdnURL: 'https://cdn.example/{gameDir}/{filename}' }),
  });

  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    Object.assign(registry, {
      Con: previousCon,
      COM: previousCom,
      Host: previousHost,
      urls: previousUrls,
    });
    eventBus.publish('registry.frozen');
  }
}

void describe('PlatformWorker', () => {
  void test('forwards messages and runs shutdown listeners once on terminate', async () => {
    const consoleCapture = createConsoleCapture();

    await withWorkerRegistry(consoleCapture, async () => {
      const rawWorker = new FakeNodeWorker();
      const worker = new PlatformWorker('server/DummyWorker.ts', rawWorker);
      const messages = [];
      let shutdownCalls = 0;

      worker.addOnMessageListener((message) => {
        messages.push(message);
      });
      worker.addOnShutdownListener(() => {
        shutdownCalls += 1;
      });

      rawWorker.emit('message', { event: 'nav.build', args: [] });
      worker.postMessage({ event: 'nav.load', args: ['e1m1'] });
      await worker.shutdown();

      assert.deepEqual(messages, [{ event: 'nav.build', args: [] }]);
      assert.deepEqual(rawWorker.messages, [{ event: 'nav.load', args: ['e1m1'] }]);
      assert.equal(shutdownCalls, 1);
      assert.equal(rawWorker.terminated, 1);
    });
  });

  void test('routes worker errors through Host.HandleCrash', async () => {
    const consoleCapture = createConsoleCapture();

    await withWorkerRegistry(consoleCapture, async () => {
      const rawWorker = new FakeNodeWorker();
      const worker = new PlatformWorker('server/DummyWorker.ts', rawWorker);
      const error = new Error('worker boom');

      rawWorker.emit('error', error);

      const mockedHost = /** @type {{ crashes: Error[] }} */ (/** @type {unknown} */ (registry.Host));
      assert.deepEqual(mockedHost.crashes, [error]);
      await worker.shutdown();
    });
  });
});

void describe('WorkerManager', () => {
  void test('subscribes worker events, forwards console messages, and sends framework init payload', async () => {
    const consoleCapture = createConsoleCapture();

    await withWorkerRegistry(consoleCapture, async () => {
      const rawWorker = new FakeNodeWorker();

      WorkerManager.Init({
        'server/DummyWorker.ts': () => rawWorker,
      });

      const worker = WorkerManager.SpawnWorker('server/DummyWorker.ts', ['nav.build']);

      assert.deepEqual(rawWorker.messages[0], {
        event: 'worker.framework.init',
        args: [
          [registry.COM.searchpaths, registry.COM.gamedir, registry.COM.game],
          registry.urls,
        ],
      });

      eventBus.publish('nav.build', 'arg1', 2);
      assert.deepEqual(rawWorker.messages[1], {
        event: 'nav.build',
        args: ['arg1', 2],
      });

      const navResponses = [];
      const unsubscribe = eventBus.subscribe('nav.path.response', (...args) => {
        navResponses.push(args);
      });

      rawWorker.emit('message', { event: 'worker.con.print.warning', data: ['from worker\n'] });
      rawWorker.emit('message', { event: 'nav.path.response', data: [8, ['c']] });

      unsubscribe();
      await worker.shutdown();

      assert.deepEqual(consoleCapture.warnings, ['from worker\n']);
      assert.deepEqual(navResponses, [[8, ['c']]]);
    });
  });
});

const dedicatedDir = new URL('../../dist/dedicated/', import.meta.url);
const dedicatedDirPath = fileURLToPath(dedicatedDir);
const dedicatedBuildAvailable = existsSync(dedicatedDirPath);

void describe('Dedicated build worker output', { skip: !dedicatedBuildAvailable }, () => {
  void test('WorkerFactories URLs point to ./workers/*.mjs in the engine bundle', async () => {
    const engineChunks = [];

    for await (const entry of fs.glob('engine-*.mjs', { cwd: dedicatedDirPath })) {
      engineChunks.push(new URL(entry, dedicatedDir));
    }

    assert.ok(engineChunks.length > 0, 'expected at least one engine-*.mjs chunk in dist/dedicated/');

    const code = await fs.readFile(engineChunks[0], 'utf8');
    const workerUrlPattern = /new Worker\(new URL\(["']([^"']+)["'],\s*import\.meta\.url\)/g;
    const urls = [...code.matchAll(workerUrlPattern)].map((m) => m[1]);

    assert.ok(urls.length >= 2, `expected at least 2 worker URLs, found ${urls.length}: ${urls.join(', ')}`);

    for (const url of urls) {
      assert.ok(url.startsWith('./workers/'), `worker URL should start with ./workers/, got: ${url}`);
      assert.ok(url.endsWith('.mjs'), `worker URL should end with .mjs, got: ${url}`);
    }
  });

  void test('worker bundles exist in dist/dedicated/workers/', async () => {
    const workersDir = new URL('workers/', dedicatedDir);

    for (const name of ['NavigationWorker.mjs', 'DummyWorker.mjs']) {
      const filePath = new URL(name, workersDir);
      const stat = await fs.stat(filePath).catch(() => null);
      assert.ok(stat !== null && stat.isFile(), `expected ${name} to exist in dist/dedicated/workers/`);
    }
  });

  void test('worker bundles do not contain unresolved source imports', async () => {
    const workersDir = new URL('workers/', dedicatedDir);
    const workersDirPath = fileURLToPath(workersDir);
    const workerFiles = [];

    for await (const entry of fs.glob('*.mjs', { cwd: workersDirPath })) {
      workerFiles.push(new URL(entry, workersDir));
    }

    assert.ok(workerFiles.length > 0, 'expected at least one .mjs file in dist/dedicated/workers/');

    for (const file of workerFiles) {
      const code = await fs.readFile(file, 'utf8');
      const sourceImports = [...code.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((specifier) => specifier.includes('/source/') || specifier.endsWith('.ts'));

      assert.deepEqual(
        sourceImports,
        [],
        `${file.pathname} still imports unresolved source paths: ${sourceImports.join(', ')}`,
      );
    }
  });
});
