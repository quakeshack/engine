import type { KeyValueBackend } from './UserStore.ts';

/** Where a backend keeps its keys: an IndexedDB database and the one object store in it. */
export interface IndexedDbLocation {
  readonly database: string;
  readonly store: string;
}

/**
 * A key-value database in IndexedDB, which unlike `localStorage` is large, asynchronous, and
 * available inside workers.
 */
export class IndexedDbBackend implements KeyValueBackend {
  /** The user files: saves, the configuration, demos. */
  static readonly USER_FILES: IndexedDbLocation = { database: 'quakeshack', store: 'files' };

  /**
   * The files the engine derives from content, such as navigation meshes. A database of its own,
   * so adding it did not need a schema upgrade of the user files, which pages of an older build
   * that are still open would have blocked.
   */
  static readonly GENERATED_FILES: IndexedDbLocation = { database: 'quakeshack-generated', store: 'files' };

  readonly #database: IDBDatabase;
  readonly #store: string;

  private constructor(database: IDBDatabase, store: string) {
    this.#database = database;
    this.#store = store;
  }

  /**
   * Opens a database, creating it on first use.
   * @returns The opened backend. Rejects when IndexedDB is unavailable or blocked.
   */
  static async open(factory: IDBFactory, location: IndexedDbLocation): Promise<IndexedDbBackend> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(location.database, 1);

      request.onupgradeneeded = (): void => {
        request.result.createObjectStore(location.store);
      };
      request.onsuccess = (): void => {
        resolve(request.result);
      };
      request.onerror = (): void => {
        reject(request.error ?? new Error('IndexedDB: open failed'));
      };
      request.onblocked = (): void => {
        reject(new Error('IndexedDB: open blocked'));
      };
    });

    // Should a later build raise the schema version, this page steps aside instead of blocking it.
    database.onversionchange = (): void => {
      database.close();
    };

    return new IndexedDbBackend(database, location.store);
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const value = await this.#request<ArrayBuffer | undefined>('readonly', (store) => store.get(key));

    return value ?? null;
  }

  async put(key: string, value: ArrayBuffer): Promise<void> {
    await this.#request('readwrite', (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.#request('readwrite', (store) => store.delete(key));
  }

  async keys(): Promise<string[]> {
    const keys = await this.#request<IDBValidKey[]>('readonly', (store) => store.getAllKeys());

    return keys.filter((key): key is string => typeof key === 'string');
  }

  async #request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const transaction = this.#database.transaction(this.#store, mode);
      const request = operation(transaction.objectStore(this.#store));

      // Resolve on the transaction, not the request, so a write is durable when its promise settles.
      transaction.oncomplete = (): void => {
        resolve(request.result);
      };
      transaction.onerror = (): void => {
        reject(transaction.error ?? request.error ?? new Error('IndexedDB: transaction failed'));
      };
      transaction.onabort = (): void => {
        reject(transaction.error ?? new Error('IndexedDB: transaction aborted'));
      };
    });
  }
}
