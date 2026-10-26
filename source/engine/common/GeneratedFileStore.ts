import type { KeyValueBackend } from './UserStore.ts';

/**
 * Where the files the engine derives from content live, such as navigation meshes built for a map
 * that ships none, or an outdated one. Unlike the user store, every file belongs to a namespace, the
 * engine build, game directory and game version that made it (`COM.GetAssetCacheName()`), and the
 * files of every other namespace are deleted when the game version becomes known. A new deploy
 * therefore never reads a file an older build generated.
 *
 * Keys are `<namespace>/<file name>`. Like the user store it never throws: a failing database makes
 * a write report `false` and a read report a missing file.
 */
export class GeneratedFileStore {
  readonly #backend: KeyValueBackend;

  constructor(backend: KeyValueBackend) {
    this.#backend = backend;
  }

  /**
   * Reads one file of a namespace.
   * @returns The bytes of the file, `null` when it does not exist.
   */
  async read(namespace: string, filename: string): Promise<ArrayBuffer | null> {
    try {
      return await this.#backend.get(GeneratedFileStore.#key(namespace, filename));
    } catch (error) {
      console.warn(`GeneratedFileStore: could not read ${filename}`, error);
      return null;
    }
  }

  /**
   * Writes one file into a namespace, replacing an existing one.
   * @returns False when the file could not be stored, e.g. because the quota is used up.
   */
  async write(namespace: string, filename: string, data: Uint8Array): Promise<boolean> {
    try {
      const copy = new ArrayBuffer(data.byteLength);

      new Uint8Array(copy).set(data);
      await this.#backend.put(GeneratedFileStore.#key(namespace, filename), copy);

      return true;
    } catch (error) {
      console.warn(`GeneratedFileStore: could not write ${filename}`, error);
      return false;
    }
  }

  /**
   * Deletes the files of every namespace but the given one.
   * @returns The number of files that were deleted.
   */
  async prune(keepNamespace: string): Promise<number> {
    const keep = GeneratedFileStore.#key(keepNamespace, '');
    let deleted = 0;

    try {
      for (const key of await this.#backend.keys()) {
        if (key.startsWith(keep)) {
          continue;
        }

        await this.#backend.delete(key);
        deleted++;
      }
    } catch (error) {
      console.warn('GeneratedFileStore: could not clean up', error);
    }

    return deleted;
  }

  static #key(namespace: string, filename: string): string {
    return `${namespace}/${filename}`;
  }
}
