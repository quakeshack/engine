import type { BuildConfig, URLs } from '../build-config';
import type { ConsoleOutput, SystemServices } from './Services.ts';
import { eventBus } from './EventBus.ts';

import { AssetCaches, CachedFetchAssetSource, type AssetSource } from './AssetSource.ts';
import { BackendUserStore, MemoryBackend, type UserStore } from './UserStore.ts';
import { GeneratedFileStore } from './GeneratedFileStore.ts';
import { IndexedDbBackend } from './IndexedDbBackend.ts';

import Q from '../../shared/Q.ts';
import { CorruptedResourceError } from './Errors.ts';

import Cvar from './Cvar.ts';
import W from './W.ts';
import Cmd from './Cmd.ts';
import { defaultBasedir, defaultGame, productVersion } from './Def.ts';
import { CRC16CCITT } from './CRC.ts';

/** A file entry inside a .pak archive. */
export interface PackFileEntry {
  readonly name: string;
  readonly filepos: number;
  readonly filelen: number;
}

/** A search path entry in the virtual filesystem. */
export interface SearchPath {
  readonly filename: string;
  pack: PackFileEntry[][];
}

/** Result of {@link COM.Parse}. */
export interface ParseResult {
  readonly token: string;
  readonly data: string | null;
}

/**
 * Common file system, command line, and string parsing utilities.
 *
 * This is the base class shared by both the browser client and the Node.js
 * dedicated server (`server/Com.ts` extends this as `NodeCOM`).
 */
/** What a `COM` depends on. */
export interface ComDependencies {
  readonly con: ConsoleOutput;
  readonly sys: SystemServices;
  /** The build this engine was made by, read when needed because a launcher may complete it late. */
  readonly buildConfig: () => BuildConfig | undefined;
  /** Where files are downloaded from, read when needed because it may be completed late. */
  readonly urls: () => URLs | undefined;
}

export default class COM {
  readonly con: ConsoleOutput;
  readonly sys: SystemServices;
  readonly getBuildConfig: ComDependencies['buildConfig'];
  readonly getUrls: ComDependencies['urls'];

  constructor(dependencies: ComDependencies) {
    this.con = dependencies.con;
    this.sys = dependencies.sys;
    this.getBuildConfig = dependencies.buildConfig;
    this.getUrls = dependencies.urls;
  }

  /** Same as the static helper, for code that reaches `COM` through an instance. */
  readonly DefaultExtension = COM.DefaultExtension;

  /** Same as the static helper, for code that reaches `COM` through an instance. */
  readonly Parse = COM.Parse;

  /** Same as the static helper, for code that reaches `COM` through an instance. */
  readonly ParseEntityLump = COM.ParseEntityLump;

  argv: string[] = [];
  searchpaths: SearchPath[] = [];

  hipnotic = false;
  rogue = false;
  standard_quake = true;
  modified = false;

  registered: Cvar | null = null;

  /**
   * Command line string — starts as a plain string from
   * {@link COM#InitArgv}, then replaced with a Cvar in {@link COM#Init}.
   */
  cmdline: Cvar | string | null = null;

  abortController: AbortController | null = null;

  gamedir: SearchPath[] | null = null;

  /** Active mod name. */
  game: string = defaultGame;

  /**
   * Where content files are read from. Set by {@link COM#InitStorage}. The dedicated server does
   * not use it, it reads the file system directly.
   */
  assetSource: AssetSource | null = null;

  /**
   * Where the files the engine writes live, and what overrides content files of the same name.
   * Set by {@link COM#InitStorage}. The dedicated server does not use it.
   */
  userStore: UserStore | null = null;

  /**
   * Where the files the engine derives from content live, in the namespace of the running build and
   * game version. Set by {@link COM#InitStorage}. The dedicated server does not use it.
   */
  generatedStore: GeneratedFileStore | null = null;

  /** Version of the loaded game module, `null` until it is loaded. Part of the asset cache name. */
  gameVersion: string | null = null;

  /** Settles when the user store and the generated file store are open, file reads and writes wait for it. */
  #storageReady: Promise<void> = Promise.resolve();

  /**
   * Append a default file extension if none is present.
   * @returns the path with extension appended when no extension was found
   */
  static DefaultExtension(this: void, path: string, extension: string): string {
    const lastSlashIndex = path.lastIndexOf('/');
    const lastDotIndex = path.lastIndexOf('.');

    if (lastDotIndex > lastSlashIndex) {
      return path;
    }

    return `${path}${extension}`;
  }

  /**
   * Quake-style token parser.
   *
   * Splits `data` into the next whitespace-delimited token (respecting
   * double-quote strings and `//` line comments) and returns the token
   * together with the remaining unparsed data.
   * @returns parsed token and remaining data
   */
  static Parse(this: void, data: string): ParseResult {
    // ASCII codes used by Quake's token parser.
    const CHAR_SPACE = 32; // ' '
    const CHAR_QUOTE = 34; // '"'
    const CHAR_LINE_FEED = 10; // '\n'
    const CHAR_SLASH = 47; // '/'

    const length = data.length;

    if (length === 0) {
      return { token: '', data: null };
    }

    let index = 0;

    // Skip whitespace and // comments.
    while (true) {
      while (index < length && data.charCodeAt(index) <= CHAR_SPACE) {
        index++;
      }

      if (index >= length) {
        return { token: '', data: null };
      }

      if (data.charCodeAt(index) !== CHAR_SLASH || data.charCodeAt(index + 1) !== CHAR_SLASH) {
        break;
      }

      index += 2;
      while (index < length && data.charCodeAt(index) !== CHAR_LINE_FEED) {
        index++;
      }
    }

    // Handle quoted strings.
    if (data.charCodeAt(index) === CHAR_QUOTE) {
      const tokenStart = index + 1;
      let cursor = tokenStart;

      while (cursor < length) {
        if (data.charCodeAt(cursor) === CHAR_QUOTE) {
          return {
            token: data.substring(tokenStart, cursor),
            data: data.substring(cursor + 1),
          };
        }
        cursor++;
      }

      return {
        token: data.substring(tokenStart),
        data: '',
      };
    }

    // Parse an unquoted token.
    let tokenEnd = index;
    while (tokenEnd < length && data.charCodeAt(tokenEnd) > CHAR_SPACE) {
      tokenEnd++;
    }

    return {
      token: data.substring(index, tokenEnd),
      data: data.substring(tokenEnd),
    };
  }

  /**
   * Parses a Quake entity lump (`{ "key" "value" ... } { ... } ...`) into a
   * sequence of key/value records, one per `{ }` block.
   *
   * Consumers that only need specific entities (e.g. `worldspawn`, or the
   * first N `light` entities) can `break` out of the `for...of` loop to skip
   * parsing the remainder of the lump.
   * @yields one record per entity, in lump order
   */
  static *ParseEntityLump(this: void, data: string | null): Generator<Record<string, string>> {
    while (data) {
      const parsed = COM.Parse(data);
      data = parsed.data;

      if (!data) {
        break;
      }

      const entity: Record<string, string> = {};

      while (data) {
        const parsedKey = COM.Parse(data);
        data = parsedKey.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        const parsedValue = COM.Parse(data);
        data = parsedValue.data;

        if (!data || parsedValue.token === '}') {
          break;
        }

        entity[parsedKey.token] = parsedValue.token;
      }

      yield entity;
    }
  }

  /**
   * Check if a command-line parameter is present.
   * @returns the argv index of the parameter, or null if not found
   */
  CheckParm(parm: string): number | null {
    for (let i = 1; i < this.argv.length; i++) {
      if (this.argv[i] === parm) {
        return i;
      }
    }
    return null;
  }

  /**
   * Get a command-line parameter value (the argument after the flag).
   * @returns the value following `parm`, or null if not found
   */
  GetParm(parm: string): string | null {
    for (let i = 1; i < this.argv.length; i++) {
      if (this.argv[i] === parm) {
        return this.argv[i + 1] || null;
      }
    }
    return null;
  }

  async CheckRegistered(): Promise<boolean> { // TODO: consider patching it out or feature flag it
    const filename = 'gfx/pop.lmp';
    const h = await this.LoadFile(filename);

    if (h === null) {
      this.con.PrintSuccess('Playing shareware version.\n');
      eventBus.publish('com.registered', false);
      return false;
    }

    // CR: shouldn't be that hard to generate a fake pop.lmp with the same checksum
    if (CRC16CCITT.Block(new Uint8Array(h)) !== 25990) {
      throw new CorruptedResourceError(filename, 'not genuine registered version');
    }

    this.registered!.set(true);
    this.con.PrintSuccess('Playing registered version.\n');
    eventBus.publish('com.registered', true);
    return true;
  }

  InitArgv(argv: string[]) {
    this.cmdline = `${argv.join(' ')} `.substring(0, 256);
    this.argv = [...argv];
    if (this.CheckParm('-safe')) {
      this.argv.push('-nosound', '-nocdaudio', '-nomouse');
    }
    if (this.CheckParm('-rogue')) {
      this.rogue = true;
      this.standard_quake = false;
    } else if (this.CheckParm('-hipnotic')) {
      this.hipnotic = true;
      this.standard_quake = false;
    }

    eventBus.publish('com.argv.ready');
  }

  async Init() {
    this.abortController = new AbortController();

    this.registered = new Cvar('registered', '0', Cvar.FLAG.READONLY, 'Set to 1, when not playing shareware.');
    // FIXME: cmdline starts as a string from InitArgv, then becomes a Cvar here
    this.cmdline = new Cvar('cmdline', this.cmdline as string, Cvar.FLAG.READONLY, 'Command line used to start the game.');

     
    Cmd.AddCommand('path', () => { this.Path_f(); });

    await this.InitFilesystem();
    await this.InitStorage();

    W.files = this;

    await Promise.all([
      this.CheckRegistered(),
      W.LoadPalette('gfx/palette.lmp'), // CR: we early load the palette here, it's needed in both dedicated and browser processes
    ]);

    this.sys.Print('COM.Init: low-level initialization completed.\n');

    eventBus.publish('com.ready');
  }

  Shutdown() {
    this.sys.Print('COM.Shutdown: signaling outstanding promises to abort\n');
    this.abortController!.abort('this.Shutdown');
  }

  Path_f() {
    this.con.Print('Files are served from the unified virtual filesystem.\n');
  }

  /**
   * Sets up where files are read from and written to in the browser: content comes through the
   * Cache Storage of the origin, user files and generated files go to two IndexedDB databases, and
   * files an older version kept in `localStorage` are moved over once.
   *
   * All of them work the same inside a worker, which is what lets a server in a worker share the
   * files and the saves of the client.
   */
  async InitStorage(): Promise<void> {
    this.assetSource = new CachedFetchAssetSource({
      fetch: async (url, init) => await fetch(url, init),
      caches: globalThis.caches,
      locks: globalThis.navigator?.locks ?? null,
      resolveUrl: (path) => {
        const separator = path.indexOf('/');

        return this.GetNetpath(path.substring(separator + 1), path.substring(0, separator));
      },
      cacheName: () => this.GetAssetCacheName(),
      signal: () => this.abortController?.signal,
      revalidate: this.getBuildConfig()?.mode === 'development',
    });

    this.#storageReady = Promise.all([this.#openUserStore(), this.#openGeneratedStore()]).then(([userStore, generatedStore]) => {
      this.userStore = userStore;
      this.generatedStore = generatedStore;
    });

    await this.#storageReady;
  }

  async #openUserStore(): Promise<UserStore> {
    let store: BackendUserStore;

    try {
      store = new BackendUserStore(await IndexedDbBackend.open(globalThis.indexedDB, IndexedDbBackend.USER_FILES));
    } catch (error) {
      this.sys.Print(`COM.InitStorage: IndexedDB is unavailable (${(error as Error).message}), files are not kept after a reload\n`);
      return new BackendUserStore(new MemoryBackend());
    }

    // localStorage does not exist inside workers, the main thread does the moving.
    if (typeof localStorage !== 'undefined') {
      const moved = await store.migrateFromLocalStorage(localStorage);

      if (moved > 0) {
        this.sys.Print(`COM.InitStorage: moved ${moved} file(s) from localStorage to IndexedDB\n`);
      }
    }

    // Every realm cleans up before its first read, so none of them is served a stale mesh.
    const removed = await store.removeLegacyNavigationMeshes();

    if (removed > 0) {
      this.sys.Print(`COM.InitStorage: removed ${removed} outdated navigation mesh(es) from the user files\n`);
    }

    return store;
  }

  async #openGeneratedStore(): Promise<GeneratedFileStore> {
    try {
      return new GeneratedFileStore(await IndexedDbBackend.open(globalThis.indexedDB, IndexedDbBackend.GENERATED_FILES));
    } catch (error) {
      this.sys.Print(`COM.InitStorage: IndexedDB is unavailable (${(error as Error).message}), generated files are rebuilt after a reload\n`);
      return new GeneratedFileStore(new MemoryBackend());
    }
  }

  /**
   * Version string of this engine build for the asset cache name: the commit when the build has
   * one, otherwise the build time, so local rebuilds never serve stale files.
   * @returns The engine build version.
   */
  GetEngineBuildVersion(): string {
    const buildConfig = this.getBuildConfig();

    return buildConfig?.commitHash ? `${productVersion}+${buildConfig.commitHash}` : `${productVersion}@${buildConfig?.timestamp ?? 'dev'}`;
  }

  /**
   * Name of the cache the content files currently belong to.
   * @returns The cache name.
   */
  GetAssetCacheName(): string {
    return AssetCaches.name(this.GetEngineBuildVersion(), this.GetGamedir(), this.gameVersion);
  }

  /**
   * Tells the file layer which game version is running. From then on content is cached and files
   * are generated for that version, and the caches and generated files of every other build and
   * version are deleted.
   */
  async SetGameVersion(version: string): Promise<void> {
    this.gameVersion = version;

    await this.#pruneAssetCaches();
    await this.#pruneGeneratedFiles();
  }

  async #pruneAssetCaches(): Promise<void> {
    if (this.assetSource === null) {
      return;
    }

    try {
      const bootName = AssetCaches.name(this.GetEngineBuildVersion(), this.GetGamedir(), null);
      const deleted = await AssetCaches.prune(globalThis.caches, [this.GetAssetCacheName(), bootName]);

      if (deleted.length > 0) {
        this.con.DPrint(`COM.SetGameVersion: removed ${deleted.length} outdated asset cache(s)\n`);
      }
    } catch (error) {
      this.con.DPrint(`COM.SetGameVersion: could not clean up asset caches (${(error as Error).message})\n`);
    }
  }

  async #pruneGeneratedFiles(): Promise<void> {
    await this.#storageReady;

    if (this.generatedStore === null) {
      return;
    }

    const deleted = await this.generatedStore.prune(this.GetAssetCacheName());

    if (deleted > 0) {
      this.con.DPrint(`COM.SetGameVersion: removed ${deleted} outdated generated file(s)\n`);
    }
  }

  /**
   * Writes a file the engine derived from content, such as a navigation mesh. It is kept for the
   * running build and game version only and read back by {@link COM#LoadFile} before content, so a
   * rebuilt file replaces an outdated one that ships with the game until the next deploy.
   * @returns whether the file was stored
   */
  async WriteGeneratedFile(filename: string, data: Uint8Array): Promise<boolean> {
    await this.#storageReady;

    filename = filename.toLowerCase();

    if (this.generatedStore === null || !await this.generatedStore.write(this.GetAssetCacheName(), filename, data)) {
      this.sys.Print(`COM.WriteGeneratedFile: failed on ${filename}\n`);
      return false;
    }

    this.sys.Print(`COM.WriteGeneratedFile: ${filename}\n`);
    return true;
  }

  /**
   * Writes a binary file to the user store.
   * @returns whether the file was stored
   */
  async WriteFile(filename: string, data: ArrayLike<number>, len: number): Promise<boolean> {
    await this.#storageReady;

    filename = filename.toLowerCase();

    const bytes = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
      bytes[i] = data[i];
    }

    if (this.userStore === null || !await this.userStore.write(`${this.GetGamedir()}/${filename}`, bytes)) {
      this.sys.Print(`COM.WriteFile: failed on ${filename}\n`);
      return false;
    }

    this.sys.Print(`COM.WriteFile: ${filename}\n`);
    return true;
  }

  /**
   * Writes a text file to the user store.
   * @returns whether the file was stored
   */
  async WriteTextFile(filename: string, data: string): Promise<boolean> {
    await this.#storageReady;

    filename = filename.toLowerCase();

    // Same byte mapping LoadTextFile reads it back with.
    if (this.userStore === null || !await this.userStore.write(`${this.GetGamedir()}/${filename}`, new Uint8Array(Q.strmem(data)))) {
      this.sys.Print(`COM.WriteTextFile: failed on ${filename}\n`);
      return false;
    }

    this.sys.Print(`COM.WriteTextFile: ${filename}\n`);
    return true;
  }

  GetNetpath(filename: string, gameDir: string | null = null): string {
    if (gameDir === null) {
      gameDir = this.GetGamedir();
    }

    const cdnURLPatternValue = this.getUrls()?.cdnURL;

    if (cdnURLPatternValue) {
      // Hash filename + gameDir into a stable shard so the same asset always
      // resolves to the same CDN host, allowing the browser cache to help.
      const shard = (CRC16CCITT.Block(new TextEncoder().encode(`${gameDir}/${filename}`)) % 4) + 1;

      return cdnURLPatternValue
        .replace('{shard}', shard.toFixed(0))
        .replace('{filename}', filename)
        .replace('{gameDir}', gameDir);
    }

    return `${location.protocol}//${location.host}/qfs/${filename}`;
  }

  /**
   * Get the current game directory.
   * @returns game name, e.g. `'id1'`
   */
  GetGamedir(): string {
    return this.searchpaths.length > 0
      ? this.searchpaths[this.searchpaths.length - 1].filename
      : defaultGame;
  }

  /**
   * Load a file from the virtual filesystem.
   * User files override generated files of the running version, and both override content, which
   * is read through the asset cache.
   * @returns binary content, or null if not found
   */
  async LoadFile(filename: string): Promise<ArrayBuffer | null> {
    filename = filename.toLowerCase();

    eventBus.publish('com.fs.being', filename);

    // Determine file path based on active game directory
    const gameDir = this.GetGamedir();
    const path = `${gameDir}/${filename}`;

    // 1) Files the player owns (saves, configuration, ...) come first.
    await this.#storageReady;

    const userData = await this.userStore?.read(path) ?? null;

    if (userData !== null) {
      this.sys.Print(`COM.LoadFile: ${path} (user store)\n`);
      eventBus.publish('com.fs.end', filename);
      return userData;
    }

    // 2) Files generated by this very build and game version. One only exists because the content
    // file was missing or outdated, so it is the better one.
    const generatedData = await this.generatedStore?.read(this.GetAssetCacheName(), filename) ?? null;

    if (generatedData !== null) {
      this.sys.Print(`COM.LoadFile: ${path} (generated)\n`);
      eventBus.publish('com.fs.end', filename);
      return generatedData;
    }

    // 3) Content from the pre-merged filesystem (all PAKs and priorities resolved at build time).
    const data = await this.assetSource?.read(path) ?? null;

    if (data !== null) {
      this.sys.Print(`COM.LoadFile: ${this.GetNetpath(filename, gameDir)}\n`);
      eventBus.publish('com.fs.end', filename);
      return data;
    }

    // File not found
    this.sys.Print(`COM.LoadFile: can't find ${filename}\n`);
    eventBus.publish('com.fs.end', filename);
    return null;
  }

  /**
   * Load a text file, stripping carriage returns.
   * @returns file content as a string, or null if not found
   */
  async LoadTextFile(filename: string): Promise<string | null> {
    const buf = await this.LoadFile(filename);
    if (buf === null) {
      return null;
    }
    return new TextDecoder('iso-8859-1').decode(buf).replaceAll('\r', '');
  }

  /**
   * Add a game directory to the search path.
   * Note: PAK files are pre-extracted at build time, so we only track the directory.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async AddGameDirectory(dir: string) {
    const search: SearchPath = { filename: dir, pack: [] };
    this.searchpaths.push(search);
    this.con.DPrint(`Added game directory: ${dir}\n`);
  }

  async InitFilesystem() {
    let search: string | undefined;
    const buildBaseDir = this.getBuildConfig()?.baseDir ?? null;

    const i = this.CheckParm('-basedir');
    if (i !== null) {
      search = this.argv[i + 1];
    }

    const effectiveBaseDir = search ?? buildBaseDir ?? defaultBasedir;

    // Build-time game overrides still select the active game directory, but
    // they now layer on top of the effective base directory instead of
    // bypassing it entirely.
    const buildGameDir = this.getBuildConfig()?.gameDir ?? null;

    if (buildGameDir) {
      await this.AddGameDirectory(effectiveBaseDir);
      if (buildGameDir !== effectiveBaseDir) {
        this.modified = true;
        this.game = buildGameDir;
        await this.AddGameDirectory(buildGameDir);
      }
      this.gamedir = [this.searchpaths[this.searchpaths.length - 1]];
      return;
    }

    if (search !== undefined) {
      await this.AddGameDirectory(search);
    } else if (buildBaseDir !== null) {
      await this.AddGameDirectory(buildBaseDir);
    } else {
      await this.AddGameDirectory(defaultBasedir);
    }

    if (this.rogue) {
      await this.AddGameDirectory('rogue');
    } else if (this.hipnotic) {
      await this.AddGameDirectory('hipnotic');
    }

    const gameIdx = this.CheckParm('-game');
    if (gameIdx !== null) {
      const gameArg = this.argv[gameIdx + 1];
      if (gameArg !== undefined) {
        this.modified = true;
        this.game = gameArg;
        await this.AddGameDirectory(gameArg);
      }
    } else if (defaultGame !== defaultBasedir) {
      this.game = defaultGame;
      this.modified = true;
      await this.AddGameDirectory(defaultGame);
    }

    this.gamedir = [this.searchpaths[this.searchpaths.length - 1]];
  }
}
