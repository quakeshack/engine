import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { join, relative } from 'node:path';

const PROJECT_ROOT = new URL('../../', import.meta.url).pathname;

interface TestScript {
  readonly name: string;
  readonly patterns: string[];
}

/**
 * Reads the glob patterns that the `test*` scripts of package.json pass to `node --test`.
 * @returns the scripts which run `node --test` with at least one pattern
 */
function readTestScripts(): TestScript[] {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const scripts: TestScript[] = [];

  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (!/^test(:|$)/.test(name) || !command.includes('--test ')) {
      continue;
    }

    const patterns = command.slice(command.indexOf('--test ') + '--test '.length).split(/\s+/).filter((token) => token !== '');
    scripts.push({ name, patterns });
  }

  return scripts;
}

/**
 * Resolves the patterns of a script the way npm and `node --test` do together. The shell expands a pattern it can
 * match, and only one directory level deep. A pattern it cannot match reaches Node unchanged, and Node expands it
 * recursively on its own.
 * @param patterns the glob patterns of one script
 * @returns the test files that run, relative to the project root
 */
function resolveTestFiles(patterns: string[]): Set<string> {
  const files = new Set<string>();

  for (const pattern of patterns) {
    const output = execFileSync('sh', ['-c', `printf '%s\\n' ${pattern}`], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    const expanded = output.split('\n').filter((path) => path !== '');

    if (expanded.length === 1 && expanded[0] === pattern) {
      for (const path of globSync(pattern, { cwd: PROJECT_ROOT })) {
        files.add(path);
      }
      continue;
    }

    for (const path of expanded) {
      files.add(path);
    }
  }

  return files;
}

/**
 * Finds every test file with one of the extensions below a directory.
 * @param directory absolute directory
 * @param extensions file name endings such as `.test.ts`
 * @returns paths relative to the project root
 */
function findTestFiles(directory: string, extensions: string[]): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...findTestFiles(path, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(relative(PROJECT_ROOT, path));
    }
  }

  return found;
}

/**
 * The directory a pattern starts in: everything before the first path segment with a wildcard.
 * @param pattern a glob pattern
 * @returns the directory relative to the project root
 */
function rootOf(pattern: string): string {
  const segments = pattern.split('/');
  const wildcard = segments.findIndex((segment) => segment.includes('*'));
  return segments.slice(0, wildcard).join('/');
}

void describe('package.json test scripts', () => {
  // dash (npm's shell here and in the Docker test stage) treats `**` like `*`, so a script reaches only as many
  // directory levels as its patterns spell out. A test file one level deeper is skipped while npm test still passes.
  for (const script of readTestScripts()) {
    void test(`${script.name} reaches every test file below its directories`, () => {
      const extensions = [...new Set(script.patterns.map((pattern) => pattern.slice(pattern.lastIndexOf('*') + 1)))];
      const roots = [...new Set(script.patterns.map(rootOf))];

      const expected = roots.flatMap((root) => findTestFiles(join(PROJECT_ROOT, root), extensions));
      const matched = resolveTestFiles(script.patterns);
      const missing = expected.filter((path) => !matched.has(path)).sort();

      assert.deepEqual(missing, [], `${script.name} skips these test files; spell out one more "**/" level in its patterns in package.json`);
    });
  }
});
