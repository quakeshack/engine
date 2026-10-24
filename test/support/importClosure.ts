import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Reads a source file without its comments, so a mention in documentation is not a reference.
 * @param path absolute file path
 * @returns the code of the file
 */
export function readCode(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Resolves an import specifier to an absolute path.
 * @param from absolute path of the importing file
 * @param specifier the specifier as written
 * @param aliases specifier prefixes mapped to absolute directories
 * @returns the absolute path, `null` for a bare package specifier
 */
function resolveSpecifier(from: string, specifier: string, aliases: Readonly<Record<string, string>>): string | null {
  if (specifier.startsWith('.')) {
    return resolve(dirname(from), specifier);
  }

  for (const [prefix, directory] of Object.entries(aliases)) {
    if (specifier.startsWith(prefix)) {
      return resolve(directory, specifier.substring(prefix.length));
    }
  }

  return null;
}

/**
 * Collects every file that loading an entry point loads, following value imports of `.ts` files only.
 * Bare package imports (`react`, `node:fs`) are not followed.
 * @param entry absolute path of the entry file
 * @param aliases specifier prefixes mapped to absolute directories, such as `{ '@engine/': '/path/to/engine/source/' }`
 * @returns absolute paths of the entry and everything it imports, directly or not
 */
export function importClosure(entry: string, aliases: Readonly<Record<string, string>> = {}): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const path = pending.pop()!;

    if (seen.has(path)) {
      continue;
    }

    seen.add(path);

    // `import type` and `export type` are erased, only the others load a file.
    const imports = readCode(path).matchAll(/^(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s+'([^']+\.ts)'/gm);

    for (const [, specifier] of imports) {
      const target = resolveSpecifier(path, specifier, aliases);

      if (target !== null && existsSync(target)) {
        pending.push(target);
      }
    }
  }

  return seen;
}
