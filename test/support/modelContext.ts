import fs from 'node:fs/promises';

import type { ConsoleOutput } from '../../source/engine/common/Services.ts';
import type { ModelFiles, ModelLoadContext } from '../../source/engine/common/model/ModelLoadContext.ts';

/**
 * Builds a console that prints nothing, except what a test wants to see.
 * @param overrides Members to replace, e.g. to record warnings.
 * @returns The console.
 */
export function createSilentConsole(overrides: Partial<ConsoleOutput> = {}): ConsoleOutput {
  return {
    Print() {},
    DPrint() {},
    PrintWarning() {},
    PrintError(text: string) { console.error(text); },
    PrintSuccess() {},
    ...overrides,
  };
}

/**
 * Builds file access that reads from a directory on disk, like a game directory would.
 * @param baseUrl The directory every name is resolved against.
 * @returns The file access.
 */
export function createDirectoryFiles(baseUrl: URL): ModelFiles {
  return {
    async LoadFile(name: string): Promise<ArrayBuffer | null> {
      try {
        const data = await fs.readFile(new URL(name, baseUrl));
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      } catch {
        return null;
      }
    },
    async LoadTextFile(name: string): Promise<string | null> {
      try {
        return await fs.readFile(new URL(name, baseUrl), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Builds what a model loader is given by its realm, with nothing to read from and a silent console
 * unless the test says otherwise.
 * @param overrides Members to replace.
 * @returns The context; render data is not loaded by default, like on a server.
 */
export function createModelLoadContext(overrides: Partial<ModelLoadContext> = {}): ModelLoadContext {
  return {
    files: { LoadFile: () => Promise.resolve(null), LoadTextFile: () => Promise.resolve(null) },
    con: createSilentConsole(),
    loadRenderData: false,
    ...overrides,
  };
}
