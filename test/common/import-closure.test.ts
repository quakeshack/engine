import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { importClosure } from '../support/importClosure.ts';

const SOURCE_ROOT = new URL('../../source/', import.meta.url).pathname;

/**
 * Writes an entry file into a fresh directory, runs the check with its path and removes the directory.
 * @param code the code of the entry file
 * @param check receives the absolute path of the entry file
 */
function withEntry(code: string, check: (entry: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'import-closure-'));

  try {
    const entry = join(directory, 'entry.ts');

    writeFileSync(entry, code);
    check(entry);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void describe('importClosure', () => {
  void test('follows relative value imports', () => {
    const closure = importClosure(join(SOURCE_ROOT, 'engine/common/model/ModelLoaderRegistry.ts'));

    assert.equal(closure.has(join(SOURCE_ROOT, 'engine/common/Errors.ts')), true);
  });

  void test('follows an aliased import into the directory the alias names', () => {
    withEntry("import W from '@engine/engine/common/W.ts';\n", (entry) => {
      const closure = importClosure(entry, { '@engine/': SOURCE_ROOT });

      assert.equal(closure.has(join(SOURCE_ROOT, 'engine/common/W.ts')), true);
      assert.equal(closure.has(join(SOURCE_ROOT, 'shared/Q.ts')), true);
    });
  });

  void test('skips type imports, bare packages and aliases it was not given', () => {
    withEntry([
      "import type W from '@engine/engine/common/W.ts';",
      "import { describe } from 'node:test';",
      "import Q from '@unknown/shared/Q.ts';",
      "export type { AssetSource } from '@engine/engine/common/AssetSource.ts';",
      '',
    ].join('\n'), (entry) => {
      assert.deepEqual([...importClosure(entry, { '@engine/': SOURCE_ROOT })], [entry]);
    });
  });

  void test('ignores imports that only appear in comments', () => {
    withEntry("// import W from '@engine/engine/common/W.ts';\n/* import Q from '@engine/shared/Q.ts'; */\n", (entry) => {
      assert.deepEqual([...importClosure(entry, { '@engine/': SOURCE_ROOT })], [entry]);
    });
  });
});
