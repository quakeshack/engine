import type { AssetSource } from './AssetSource.ts';
import type { SearchPath } from './Com.ts';
import { PakFile, type PakDirectory, type PackFileEntry } from './PakFile.ts';

/**
 * The raw files of a folder that holds game directories (`id1/`, `hellwave/`): a folder on disk, a directory
 * picked in a browser, a map of bytes in a test.
 */
export interface GameFolder {
  /**
   * Opens a file by its path below the folder (`id1/pak0.pak`, `hellwave/maps/hw_aitest.bsp`).
   * @returns The file, `null` when there is none (a directory is none either).
   */
  open(path: string): Promise<Blob | null>;
}

/** A pak that {@link SearchPathAssetSource.loadGameDirectory} found. */
export interface LoadedPak {
  /** The pak's path below the game folder (`id1/pak0.pak`). */
  readonly path: string;
  readonly directory: PakDirectory;
}

/**
 * Content files the way Quake's search path finds them, read from a {@link GameFolder}.
 *
 * - Later game directories win over earlier ones: a mod over its base game.
 * - Within one game directory the paks win over loose files, the highest-numbered pak first.
 *
 * The search paths are the `COM`'s (`COM.searchpaths`, read through a getter on every read), so the paks'
 * directories travel to a worker as plain data with them and the worker reads the same way. A pak is opened for
 * each read of one of its entries; only that entry is read.
 */
export class SearchPathAssetSource implements AssetSource {
  readonly #folder: GameFolder;
  readonly #searchpaths: () => readonly SearchPath[];
  /** Name lookups of pak directories, built on first use, kept as long as the directory itself. */
  readonly #indexes = new WeakMap<readonly PackFileEntry[], Map<string, PackFileEntry>>();

  /**
   * @param folder Where the game directories are.
   * @param searchpaths The search paths to read through, in the order they were added.
   */
  constructor(folder: GameFolder, searchpaths: () => readonly SearchPath[]) {
    this.#folder = folder;
    this.#searchpaths = searchpaths;
  }

  /**
   * Opens the paks of a game directory (`pak0.pak`, `pak1.pak`, ... up to the first one missing), reading only
   * their directories. The caller adds the search path to the ones this source reads through.
   * @param directory The game directory, `''` for the game folder itself.
   * @returns The search path, and the paks for the caller to check or report.
   */
  async loadGameDirectory(directory: string): Promise<{ search: SearchPath; paks: LoadedPak[] }> {
    const search: SearchPath = { filename: directory, pack: [] };
    const paks: LoadedPak[] = [];

    for (let i = 0; ; i++) {
      const path = SearchPathAssetSource.#join(directory, `pak${i}.pak`);
      const pak = await this.#folder.open(path);

      if (pak === null) {
        break;
      }

      const pakDirectory = await PakFile.readDirectory(pak, path);

      search.pack.push(pakDirectory.entries);
      paks.push({ path, directory: pakDirectory });
    }

    return { search, paks };
  }

  /**
   * Reads a file through the search paths. The path names a game directory (`hellwave/progs/player.mdl`): that
   * game directory and every one added before it are searched, in the order above. A pak or a file that cannot be
   * read is passed over, as if it did not have the file.
   * @returns The file's bytes, `null` when no search path has it or the game directory is not one of them.
   */
  async read(path: string): Promise<ArrayBuffer | null> {
    const separator = path.indexOf('/');
    const directory = path.substring(0, separator);
    const filename = path.substring(separator + 1);
    const searchpaths = this.#searchpaths();
    let top = -1;

    for (let i = searchpaths.length - 1; i >= 0; i--) {
      if (searchpaths[i].filename === directory) {
        top = i;
        break;
      }
    }

    for (let i = top; i >= 0; i--) {
      const data = await this.#readFromSearchPath(searchpaths[i], filename);

      if (data !== null) {
        return data;
      }
    }

    return null;
  }

  async #readFromSearchPath(search: SearchPath, filename: string): Promise<ArrayBuffer | null> {
    for (let j = search.pack.length - 1; j >= 0; j--) {
      const entry = this.#indexOf(search.pack[j]).get(filename);

      if (entry === undefined) {
        continue;
      }

      const path = SearchPathAssetSource.#join(search.filename, `pak${j}.pak`);

      try {
        const pak = await this.#folder.open(path);

        if (pak !== null) {
          return await PakFile.readEntry(pak, entry, path);
        }
      } catch (_error) {
        // A pak that went missing or broke since its directory was read does not have the file.
      }
    }

    try {
      return await (await this.#folder.open(SearchPathAssetSource.#join(search.filename, filename)))?.arrayBuffer() ?? null;
    } catch (_error) {
      return null;
    }
  }

  #indexOf(entries: readonly PackFileEntry[]): Map<string, PackFileEntry> {
    let index = this.#indexes.get(entries);

    if (index === undefined) {
      index = new Map();

      // The first entry of a name wins, as a scan of the directory would find it.
      for (const entry of entries) {
        if (!index.has(entry.name)) {
          index.set(entry.name, entry);
        }
      }

      this.#indexes.set(entries, index);
    }

    return index;
  }

  static #join(directory: string, filename: string): string {
    return directory === '' ? filename : `${directory}/${filename}`;
  }
}
