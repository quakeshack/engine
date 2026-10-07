import type { ConsoleOutput } from '../Services.ts';

/** The file access a model loader needs. */
export interface ModelFiles {
  /**
   * Reads a binary file from the game's search path.
   * @returns The file, `null` when it does not exist.
   */
  LoadFile(filename: string): Promise<ArrayBuffer | null>;
  /**
   * Reads a text file from the game's search path.
   * @returns The file's text, `null` when it does not exist.
   */
  LoadTextFile(filename: string): Promise<string | null>;
}

/**
 * What a model loader gets from the realm it runs in. A realm that never draws anything (the
 * server, a worker) loads without render data: no textures, lightmaps or other GL resources.
 */
export interface ModelLoadContext {
  readonly files: ModelFiles;
  readonly con: ConsoleOutput;
  /** Whether textures and the other data only a renderer needs are created while loading. */
  readonly loadRenderData: boolean;
}
