import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import DedicatedLauncherTs from '../../source/engine/main-dedicated.ts';

void test('main-dedicated exports a launcher with a static Launch method', () => {
  assert.equal(typeof DedicatedLauncherTs.Launch, 'function');
});

void test('index.html loads the TypeScript browser entrypoint directly', async () => {
  const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');

  assert.match(html, /main-browser\.ts/);
});
