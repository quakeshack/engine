/**
 * A read-only source of content files, addressed by their path in the virtual filesystem
 * (`<game directory>/<file name>`, lower case).
 */
export interface AssetSource {
  /**
   * Reads one file.
   * @returns The bytes of the file, `null` when it does not exist.
   */
  read(path: string): Promise<ArrayBuffer | null>;
}

/** Everything {@link CachedFetchAssetSource} needs from its environment, so tests can provide fakes. */
export interface CachedFetchEnvironment {
  /** The `fetch` function that downloads a file. */
  readonly fetch: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
  /** Cache Storage, shared by every realm of the origin. */
  readonly caches: CacheStorage;
  /** Web Locks, `null` where unavailable, then only duplicate downloads are possible. */
  readonly locks: Pick<LockManager, 'request'> | null;
  /** Maps a path to the URL the file is downloaded from, which is also its cache key. */
  readonly resolveUrl: (path: string) => string;
  /** Name of the cache the files currently belong to, see {@link AssetCaches.name}. */
  readonly cacheName: () => string;
  /** Aborts downloads that are still running when the engine shuts down. */
  readonly signal?: () => AbortSignal | undefined;
  /**
   * Asks the server whether a cached file changed before using it (a conditional request, the file
   * is only downloaded again when it did). For development, where files change under the cache.
   */
  readonly revalidate?: boolean;
}

/**
 * Downloads content files through the Cache Storage of the browser.
 *
 * Cache Storage belongs to the origin, so every realm (the main thread and each worker) sees the
 * same files: what one realm downloaded is a local read for the other, independent of HTTP cache
 * headers, and survives a reload. The client and the server precache nearly the same files at the
 * same moment, so each file is guarded by a Web Lock: the realm that comes second waits for the
 * first one's download and then finds it in the cache.
 */
export class CachedFetchAssetSource implements AssetSource {
  readonly #environment: CachedFetchEnvironment;

  constructor(environment: CachedFetchEnvironment) {
    this.#environment = environment;
  }

  async read(path: string): Promise<ArrayBuffer | null> {
    const url = this.#environment.resolveUrl(path);
    const { locks } = this.#environment;

    if (locks === null) {
      return await this.#readOrDownload(url);
    }

    return await locks.request(`asset:${url}`, async () => await this.#readOrDownload(url));
  }

  async #readOrDownload(url: string): Promise<ArrayBuffer | null> {
    const cache = await this.#openCache();
    const cached = await CachedFetchAssetSource.#match(cache, url);

    if (cached !== null && this.#environment.revalidate !== true) {
      return await cached.arrayBuffer();
    }

    let response: Response;

    try {
      response = await this.#environment.fetch(url, {
        signal: this.#environment.signal?.(),
        headers: cached === null ? undefined : CachedFetchAssetSource.#validators(cached),
      });
    } catch (error) {
      if (cached !== null) {
        return await cached.arrayBuffer();
      }

      console.warn(`AssetSource: fetch failed for ${url}`, error);
      return null;
    }

    if (cached !== null && !response.ok) {
      // Not modified (304), or the server cannot say right now: what we have is still the best answer.
      return await cached.arrayBuffer();
    }

    if (!response.ok) {
      return null;
    }

    await CachedFetchAssetSource.#store(cache, url, response.clone());

    return await response.arrayBuffer();
  }

  async #openCache(): Promise<Cache | null> {
    try {
      return await this.#environment.caches.open(this.#environment.cacheName());
    } catch (error) {
      console.warn('AssetSource: Cache Storage is unavailable, files are downloaded every time', error);
      return null;
    }
  }

  /**
   * Builds the headers of a conditional request from what the cached response remembers.
   * @returns The validators, `undefined` when the cached response has none.
   */
  static #validators(cached: Response): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    const etag = cached.headers.get('etag');
    const lastModified = cached.headers.get('last-modified');

    if (etag !== null) {
      headers['If-None-Match'] = etag;
    }

    if (lastModified !== null) {
      headers['If-Modified-Since'] = lastModified;
    }

    return Object.keys(headers).length === 0 ? undefined : headers;
  }

  static async #match(cache: Cache | null, url: string): Promise<Response | null> {
    if (cache === null) {
      return null;
    }

    try {
      return (await cache.match(url)) ?? null;
    } catch {
      return null;
    }
  }

  static async #store(cache: Cache | null, url: string, response: Response): Promise<void> {
    if (cache === null) {
      return;
    }

    try {
      await cache.put(url, response);
    } catch (error) {
      // A full quota or a response that must not be stored is no reason to fail the load.
      console.warn(`AssetSource: could not cache ${url}`, error);
    }
  }
}

/**
 * Names and cleans up the caches {@link CachedFetchAssetSource} uses. A cache belongs to one engine
 * build, one game directory and one game version, so a new deploy never serves files of an old one.
 *
 * Files that are needed before the game module is loaded (the palette, `pop.lmp`) go into the
 * `boot` cache of the game directory, which follows the engine version only.
 */
export class AssetCaches {
  /** Every cache of the engine starts with this, nothing else is ever touched. */
  static readonly PREFIX = 'quakeshack/';

  /** Stands in for the game version until the game module is loaded. */
  static readonly BOOT = 'boot';

  /**
   * Builds the name of the cache for a set of versions.
   * @param gameVersion The game version, `null` before the game module is loaded.
   * @returns The cache name.
   */
  static name(engineVersion: string, gameDir: string, gameVersion: string | null): string {
    return `${AssetCaches.PREFIX}${engineVersion}/${gameDir}/${gameVersion ?? AssetCaches.BOOT}`;
  }

  /**
   * Deletes every cache of the engine that does not belong to the running versions.
   * @param keep Names of the caches to keep.
   * @returns The names of the deleted caches.
   */
  static async prune(caches: Pick<CacheStorage, 'keys' | 'delete'>, keep: readonly string[]): Promise<string[]> {
    const deleted: string[] = [];

    for (const name of await caches.keys()) {
      if (!name.startsWith(AssetCaches.PREFIX) || keep.includes(name)) {
        continue;
      }

      if (await caches.delete(name)) {
        deleted.push(name);
      }
    }

    return deleted;
  }
}
