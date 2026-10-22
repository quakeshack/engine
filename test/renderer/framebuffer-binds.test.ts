import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

const clientDirectory = new URL('../../source/engine/client', import.meta.url).pathname;

/**
 * Lists the TypeScript files under a directory.
 * @param directory The directory.
 * @returns The paths of the files.
 */
function listSources(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSources(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

void describe('framebuffer binds', () => {
  void test('only RenderTarget binds a framebuffer, so RenderTarget.bound is what GL has bound', () => {
    const offenders = listSources(clientDirectory)
      .filter((path) => !path.endsWith('renderer/frame/RenderTarget.ts'))
      .filter((path) => /\.(bindFramebuffer|createFramebuffer|createRenderbuffer)\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(clientDirectory, path));

    assert.deepEqual(offenders, [], 'a framebuffer is created and bound through RenderTarget, which the frame checks');
  });
});
