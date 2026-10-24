import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { join, relative } from 'node:path';

import { importClosure, readCode } from '../support/importClosure.ts';

const ENGINE_ROOT = new URL('../../source/engine/', import.meta.url).pathname;

/**
 * The model loaders skip everything that needs a GL context in a server realm, but they still import the classes
 * that hold the render data. Nothing else of the client may be loaded by a server, in a worker or on its own.
 */
const CLIENT_FILES_OF_MODEL_LOADERS = [
  'client/GL.ts',
  'client/PageServices.ts',
  'client/VID.ts',
  'client/renderer/models/Materials.ts',
  'client/renderer/scene/Sky.ts',
];

/**
 * Lists all TypeScript files below a directory of the engine source.
 * @param directory absolute directory path
 * @returns absolute file paths
 */
function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }

    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Finds files whose code matches a pattern.
 * @param directory directory below the engine source
 * @param pattern pattern that marks a violation
 * @returns the matching files, relative to the engine source
 */
function filesMatching(directory: string, pattern: RegExp): string[] {
  return listSourceFiles(join(ENGINE_ROOT, directory))
    .filter((path) => pattern.test(readCode(path)))
    .map((path) => relative(ENGINE_ROOT, path));
}

void describe('engine boundaries', () => {
  void describe('registry', () => {
    // Everything an engine part needs is imported or handed to it by the composition root of its realm.
    void test('is gone, nothing looks anything up in it or waits for it to be frozen', () => {
      assert.deepEqual(existsSync(join(ENGINE_ROOT, 'registry.ts')), false);
      assert.deepEqual(filesMatching('.', /registry\.ts'|registry\.frozen|get(?:Client|Common)Registry/), []);
    });
  });

  void describe('server runtime', () => {
    void test('does not import anything from the client', () => {
      assert.deepEqual(filesMatching('server', /from\s+'(?:\.\.\/)+client\//), []);
    });

  });

  void describe('network layer', () => {
    void test('does not import client or server code', () => {
      assert.deepEqual(filesMatching('network', /from\s+'(?:\.\.\/)+(?:client|server)\//), []);
    });
  });

  void describe('shared engine code', () => {
    void test('Host does not know the client or the server runtime', () => {
      const code = readCode(join(ENGINE_ROOT, 'common/Host.ts'));

      assert.equal(/from\s+'\.\.\/client\//.test(code), false);
      assert.equal(/import\s+(?!type)[^;]*from\s+'\.\.\/server\//.test(code), false);
    });
  });

  void describe('client runtime', () => {
    void test('does not import the server module', () => {
      assert.deepEqual(filesMatching('client', /from\s+'(?:\.\.\/)+server\/Server\.ts'/), []);
    });

    void test('does not call into SV or ServerHost through a global', () => {
      assert.deepEqual(filesMatching('client', /\bSV\.(?:server|svs|collision|area|physics|messages)\b/), []);
    });
  });

  void describe('client engine API', () => {
    void test('does not reach for SV, a page whose server is in a worker has none', () => {
      const code = readCode(join(ENGINE_ROOT, 'client/ClientEngineAPI.ts'));

      assert.equal(/\bSV\./.test(code), false);
    });
  });

  void describe('dedicated server', () => {
    void test('does not load client code, apart from what model loading drags in', () => {
      const closure = importClosure(join(ENGINE_ROOT, 'bootstrap/createDedicatedServer.ts'));
      const clientFiles = [...closure]
        .map((path) => relative(ENGINE_ROOT, path))
        .filter((path) => path.startsWith('client/'))
        .sort();

      assert.deepEqual(clientFiles, CLIENT_FILES_OF_MODEL_LOADERS);
    });
  });

  void describe('server worker', () => {
    void test('does not load client code, apart from what model loading drags in', () => {
      const closure = importClosure(join(ENGINE_ROOT, 'server/ServerWorker.ts'));
      const clientFiles = [...closure]
        .map((path) => relative(ENGINE_ROOT, path))
        .filter((path) => path.startsWith('client/'))
        .sort();

      assert.deepEqual(clientFiles, CLIENT_FILES_OF_MODEL_LOADERS);
    });

    void test('does not carry the shader text, it is installed into GL by the page', () => {
      const closure = [...importClosure(join(ENGINE_ROOT, 'server/ServerWorker.ts'))].map((path) => relative(ENGINE_ROOT, path));

      assert.equal(closure.includes('client/renderer/programs/ShaderLibrary.ts'), false);
      assert.equal(closure.includes('client/renderer/programs/ShaderPreprocessor.ts'), false);
      assert.equal(/import\.meta\.glob/.test(readCode(join(ENGINE_ROOT, 'client/GL.ts'))), false);
    });

    void test('does not load the game API classes of the client, they pull in the menu and the renderer', () => {
      const closure = [...importClosure(join(ENGINE_ROOT, 'server/ServerWorker.ts'))].map((path) => relative(ENGINE_ROOT, path));

      assert.equal(closure.includes('client/ClientEngineAPI.ts'), false);
    });
  });
});
