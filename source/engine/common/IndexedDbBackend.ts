import type { KeyValueBackend } from './UserStore.ts';

/**
 * A key-value database in IndexedDB, which unlike `localStorage` is large, asynchronous, and
 * available inside workers.
 */
export class IndexedDbBackend implements KeyValueBackend {
  static readonly DATABASE = 'quakeshack';
  static readonly STORE = 'files';

  readonly #database: IDBDatabase;

  private constructor(database: IDBDatabase) {
    this.#database = database;
  }

  /**
   * Opens the database, creating it on first use.
   * @returns The opened backend. Rejects when IndexedDB is unavailable or blocked.
   */
  static async open(factory: IDBFactory): Promise<IndexedDbBackend> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(IndexedDbBackend.DATABASE, 1);

      request.onupgradeneeded = (): void => {
        request.result.createObjectStore(IndexedDbBackend.STORE);
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

    return new IndexedDbBackend(database);
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

  async #request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const transaction = this.#database.transaction(IndexedDbBackend.STORE, mode);
      const request = operation(transaction.objectStore(IndexedDbBackend.STORE));

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
