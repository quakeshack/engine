import Q from '../../shared/Q.ts';

/**
 * Where the files the engine writes live: saves, the configuration, demos, generated navigation
 * meshes. A file here overrides the content file of the same path. Paths are addressed like in
 * `AssetSource` (see `AssetSource.ts`): `<game directory>/<file name>`, lower case.
 */
export interface UserStore {
  /**
   * Reads one file.
   * @returns The bytes of the file, `null` when it does not exist.
   */
  read(path: string): Promise<ArrayBuffer | null>;

  /**
   * Writes one file, replacing an existing one.
   * @returns False when the file could not be stored, e.g. because the quota is used up.
   */
  write(path: string, data: Uint8Array): Promise<boolean>;

  /**
   * Deletes one file.
   * @returns False when the file could not be deleted.
   */
  remove(path: string): Promise<boolean>;
}

/** The few operations a key-value database has to offer to hold a {@link UserStore}. */
export interface KeyValueBackend {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The subset of `localStorage` the migration reads and cleans up. */
export interface LegacyStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** A backend that keeps everything in memory, for tests and as the fallback when no database is available. */
export class MemoryBackend implements KeyValueBackend {
  readonly #entries = new Map<string, ArrayBuffer>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(key: string): Promise<ArrayBuffer | null> {
    const value = this.#entries.get(key);

    return value === undefined ? null : value.slice(0);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async put(key: string, value: ArrayBuffer): Promise<void> {
    this.#entries.set(key, value.slice(0));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }
}

/**
 * A user store on top of a key-value database. It never throws: a failing database makes a write
 * report `false` and a read report a missing file, so the game keeps running without persistence.
 */
export class BackendUserStore implements UserStore {
  /** Key of the marker that records that the legacy `localStorage` files were moved over. */
  static readonly MIGRATION_MARKER = 'meta/localstorage-migrated';

  /** Prefix `Host`/`COM` used for the keys of the legacy `localStorage` files. */
  static readonly LEGACY_PREFIX = 'Quake.';

  readonly #backend: KeyValueBackend;

  constructor(backend: KeyValueBackend) {
    this.#backend = backend;
  }

  async read(path: string): Promise<ArrayBuffer | null> {
    try {
      return await this.#backend.get(path);
    } catch (error) {
      console.warn(`UserStore: could not read ${path}`, error);
      return null;
    }
  }

  async write(path: string, data: Uint8Array): Promise<boolean> {
    try {
      const copy = new ArrayBuffer(data.byteLength);

      new Uint8Array(copy).set(data);
      await this.#backend.put(path, copy);

      return true;
    } catch (error) {
      console.warn(`UserStore: could not write ${path}`, error);
      return false;
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      await this.#backend.delete(path);
      return true;
    } catch (error) {
      console.warn(`UserStore: could not delete ${path}`, error);
      return false;
    }
  }

  /**
   * Moves the files older versions kept in `localStorage` (`Quake.<game directory>/<file>`) into the
   * store, once. `localStorage` is small and not reachable from workers, which is why the files left it.
   *
   * It is safe to call on every start and to be interrupted: each file is removed from `localStorage`
   * only after it was stored, and the marker is set last, so a second run picks up what is left.
   * @returns The number of files that were moved.
   */
  async migrateFromLocalStorage(storage: LegacyStorage): Promise<number> {
    if (await this.read(BackendUserStore.MIGRATION_MARKER) !== null) {
      return 0;
    }

    const keys: string[] = [];

    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);

      if (key?.startsWith(BackendUserStore.LEGACY_PREFIX)) {
        keys.push(key);
      }
    }

    let moved = 0;

    for (const key of keys) {
      const value = storage.getItem(key);

      if (value === null) {
        continue;
      }

      const path = key.substring(BackendUserStore.LEGACY_PREFIX.length);

      // Same decoding the old `COM.LoadFile` used for these values.
      if (!await this.write(path, new Uint8Array(Q.strmem(value)))) {
        // Keep it where it is, and leave the marker unset so that the next start tries again.
        return moved;
      }

      storage.removeItem(key);
      moved++;
    }

    await this.write(BackendUserStore.MIGRATION_MARKER, new Uint8Array([1]));

    return moved;
  }
}
