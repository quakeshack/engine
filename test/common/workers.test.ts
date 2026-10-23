import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { BuildConfig } from '../../source/engine/build-config';
import PlatformWorker from '../../source/engine/common/PlatformWorker.ts';
import WorkerManager from '../../source/engine/common/WorkerManager.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';

class FakeNodeWorker {
  listeners: Record<'error' | 'message', Array<(payload: never) => void>> = {
    error: [],
    message: [],
  };

  messages: unknown[] = [];
  terminated = 0;

  on(event: 'error' | 'message', listener: (payload: never) => void): void {
    this.listeners[event].push(listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate() {
    this.terminated += 1;
    return Promise.resolve(0);
  }

  emit(event: 'error' | 'message', payload: unknown): void {
    for (const listener of this.listeners[event]) {
      listener(payload as never);
    }
  }
}

/** A console that keeps what it is asked to print, by how loud it is. */
interface ConsoleCapture {
  prints: string[];
  successes: string[];
  warnings: string[];
  errors: string[];
  dprints: string[];
  Print: (message: string) => void;
  PrintSuccess: (message: string) => void;
  PrintWarning: (message: string) => void;
  PrintError: (message: string) => void;
  DPrint: (message: string) => void;
}

/** @returns console capture */
function createConsoleCapture(): ConsoleCapture {
  return {
    prints: [],
    successes: [],
    warnings: [],
    errors: [],
    dprints: [],
    Print(this: ConsoleCapture, message: string) {
      this.prints.push(message);
    },
    PrintSuccess(this: ConsoleCapture, message: string) {
      this.successes.push(message);
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
 * Run with the services a worker-capable realm gives the worker manager and the crash hook of
 * its workers, recording the crashes.
 * @param consoleCapture
 * @param callback
 */
async function withWorkerServices(consoleCapture: ReturnType<typeof createConsoleCapture>, callback: (context: { crashes: unknown[], com: { searchpaths: unknown[], gamedir: unknown[], game: string, buildConfig: BuildConfig, gameVersion: string }, urls: object }) => void | Promise<void>) {
  const previousServices = WorkerManager.services;
  const previousOnCrash = PlatformWorker.onCrash;
  const crashes: Array<Error | ErrorEvent> = [];
  const com = {
    searchpaths: [{ filename: 'id1', pack: [] }],
    gamedir: [{ filename: 'id1', pack: [] }],
    game: 'id1',
    buildConfig: { mode: 'production', timestamp: 'T', commitHash: 'abc123', gameDir: null, baseDir: null },
    gameVersion: '1.0.0',
    getBuildConfig(): BuildConfig {
      return this.buildConfig;
    },
  };
  const urls = { cdnURL: 'https://cdn.example/{gameDir}/{filename}' };

  // The manager reads the console, the file system search paths and the URLs of its realm.
  WorkerManager.services = { con: consoleCapture, com, urls: () => urls } as unknown as typeof WorkerManager.services;
  PlatformWorker.onCrash = (error) => { crashes.push(error); };

  try {
    await callback({ crashes, com, urls });
  } finally {
    // The realm's services are put back as they were found, whatever happened meanwhile.
    // eslint-disable-next-line require-atomic-updates
    WorkerManager.services = previousServices;
    // eslint-disable-next-line require-atomic-updates
    PlatformWorker.onCrash = previousOnCrash;
  }
}

void describe('PlatformWorker', () => {
  void test('forwards messages and runs shutdown listeners once on terminate', async () => {
    const consoleCapture = createConsoleCapture();

    await withWorkerServices(consoleCapture, async () => {
      const rawWorker = new FakeNodeWorker();
      const worker = new PlatformWorker('server/DummyWorker.ts', rawWorker);
      const messages: unknown[] = [];
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

  void test('routes worker errors to the crash hook of the realm', async () => {
    const consoleCapture = createConsoleCapture();

    await withWorkerServices(consoleCapture, async ({ crashes }) => {
      const rawWorker = new FakeNodeWorker();
      const worker = new PlatformWorker('server/DummyWorker.ts', rawWorker);
      const error = new Error('worker boom');

      rawWorker.emit('error', error);

      assert.deepEqual(crashes, [error]);
      await worker.shutdown();
    });
  });
});

void describe('WorkerManager', () => {
  void test('subscribes worker events, forwards console messages, and sends framework init payload with the build and game version', async () => {
    const consoleCapture = createConsoleCapture();

    await withWorkerServices(consoleCapture, async ({ com, urls }) => {
      const rawWorker = new FakeNodeWorker();

      WorkerManager.Init({
        'server/DummyWorker.ts': () => rawWorker,
      });

      const worker = WorkerManager.SpawnWorker('server/DummyWorker.ts', ['nav.build']);

      assert.deepEqual(rawWorker.messages[0], {
        event: 'worker.framework.init',
        args: [
          [com.searchpaths, com.gamedir, com.game, com.buildConfig, com.gameVersion],
          urls,
        ],
      });

      eventBus.publishUntyped('nav.build', 'arg1', 2);
      assert.deepEqual(rawWorker.messages[1], {
        event: 'nav.build',
        args: ['arg1', 2],
      });

      const navResponses: unknown[][] = [];
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
