import { registry, eventBus, getCommonRegistry } from '../registry.mjs';

import Q from '../../shared/Q.ts';
import { CorruptedResourceError } from './Errors.ts';

import Cvar from './Cvar.ts';
import W from './W.mjs';
import Cmd from './Cmd.ts';
import { defaultBasedir, defaultGame } from './Def.ts';
import { CRC16CCITT } from './CRC.ts';

let { Con, Sys } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, Sys } = getCommonRegistry());
});

/** A file entry inside a .pak archive. */
export type PackFileEntry = {
  name: string;
  filepos: number;
  filelen: number;
};

/** A search path entry in the virtual filesystem. */
export type SearchPath = {
  filename: string;
  pack: PackFileEntry[][];
};

/** Result of {@link COM.Parse}. */
export type ParseResult = {
  token: string;
  data: string | null;
};

/**
 * Common file system, command line, and string parsing utilities.
 *
 * This is the base class shared by both the browser client and the Node.js
 * dedicated server (`server/Com.mjs` extends this as `NodeCOM`).
 */
export default class COM {
  static argv: string[] = [];
  static searchpaths: SearchPath[] = [];

  static hipnotic = false;
  static rogue = false;
  static standard_quake = true;
  static modified = false;

  static registered: Cvar | null = null;

  /**
   * Command line string — starts as a plain string from
   * {@link COM.InitArgv}, then replaced with a Cvar in {@link COM.Init}.
   */
  static cmdline: Cvar | string | null = null;

  static abortController: AbortController | null = null;

  static gamedir: SearchPath[] | null = null;

  /** Active mod name. */
  static game: string = defaultGame;

  /**
   * Append a default file extension if none is present.
   * @returns the path with extension appended when no extension was found
   */
  static DefaultExtension(path: string, extension: string): string {
    for (let i = path.length - 1; i >= 0; i--) {
      const src = path.charCodeAt(i);
      if (src === 47) { // '/'
        break;
      }
      if (src === 46) { // '.'
        return path;
      }
    }
    return path + extension;
  }

  /**
   * Quake-style token parser.
   *
   * Splits `data` into the next whitespace-delimited token (respecting
   * double-quote strings and `//` line comments) and returns the token
   * together with the remaining unparsed data.
   * @returns parsed token and remaining data
   */
  static Parse(data: string): ParseResult {
    let token = '';
    let i = 0;
    let c = 0;
    if (data.length === 0) {
      return { token, data: null };
    }

    // skip whitespace and // comments
    let skipwhite = true;
    while (true) {
      if (!skipwhite) {
        break;
      }
      skipwhite = false;
      while (true) {
        if (i >= data.length) {
          return { token, data: null };
        }
        c = data.charCodeAt(i);
        if (c > 32) {
          break;
        }
        i++;
      }
      // skip // comments
      if (c === 47 && data.charCodeAt(i + 1) === 47) { // '//'
        while (true) {
          if (i >= data.length || data.charCodeAt(i) === 10) { // '\n'
            break;
          }
          i++;
        }
        skipwhite = true;
      }
    }

    // handle quoted strings
    if (c === 34) { // '"'
      i++;
      while (true) {
        c = data.charCodeAt(i);
        i++;
        if (i >= data.length || c === 34) { // '"'
          return { token, data: data.substring(i) };
        }
        token += String.fromCharCode(c);
      }
    }

    // regular token
    while (true) {
      if (i >= data.length || c <= 32) { // whitespace
        break;
      }
      token += String.fromCharCode(c);
      i++;
      c = data.charCodeAt(i);
    }

    return { token, data: data.substring(i) };
  }

  /**
   * Check if a command-line parameter is present.
   * @returns the argv index of the parameter, or null if not found
   */
  static CheckParm(parm: string): number | null {
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
  static GetParm(parm: string): string | null {
    for (let i = 1; i < this.argv.length; i++) {
      if (this.argv[i] === parm) {
        return this.argv[i + 1] || null;
      }
    }
    return null;
  }

  static async CheckRegistered(): Promise<boolean> {
    const filename = 'gfx/pop.lmp';
    const h = await this.LoadFile(filename);

    if (h === null) {
      Con.PrintSuccess('Playing shareware version.\n');
      eventBus.publish('com.registered', false);
      return false;
    }

    // CR: shouldn't be that hard to generate a fake pop.lmp with the same checksum
    if (CRC16CCITT.Block(new Uint8Array(h)) !== 25990) {
      throw new CorruptedResourceError(filename, 'not genuine registered version');
    }

    this.registered!.set(true);
    Con.PrintSuccess('Playing registered version.\n');
    eventBus.publish('com.registered', true);
    return true;
  }

  static InitArgv(argv: string[]) {
    this.cmdline = (argv.join(' ') + ' ').substring(0, 256);
    for (let i = 0; i < argv.length; i++) {
      this.argv[i] = argv[i];
    }
    if (this.CheckParm('-safe')) {
      this.argv[this.argv.length] = '-nosound';
      this.argv[this.argv.length] = '-nocdaudio';
      this.argv[this.argv.length] = '-nomouse';
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

  static async Init() {
    this.abortController = new AbortController();

    this.registered = new Cvar('registered', '0', Cvar.FLAG.READONLY, 'Set to 1, when not playing shareware.');
    // cmdline starts as a string from InitArgv, then becomes a Cvar here
    this.cmdline = new Cvar('cmdline', this.cmdline as string, Cvar.FLAG.READONLY, 'Command line used to start the game.');

    Cmd.AddCommand('path', this.Path_f);

    await this.InitFilesystem();

    await Promise.all([
      this.CheckRegistered(),
      W.LoadPalette('gfx/palette.lmp'), // CR: we early load the palette here, it's needed in both dedicated and browser processes
    ]);

    Sys.Print('COM.Init: low-level initialization completed.\n');

    eventBus.publish('com.ready');
  }

  static Shutdown() {
    Sys.Print('COM.Shutdown: signaling outstanding promises to abort\n');
    this.abortController!.abort('COM.Shutdown');
  }

  static Path_f() {
    Con.Print('Files are served from the unified virtual filesystem.\n');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  static async WriteFile(filename: string, data: ArrayLike<number>, len: number): Promise<boolean> {
    if (registry.isInsideWorker) {
      Sys.Print('COM.WriteFile: not supported inside worker threads\n');
      return false;
    }

    filename = filename.toLowerCase();
    const dest: string[] = [];
    for (let i = 0; i < len; i++) {
      dest[i] = String.fromCharCode(data[i]);
    }
    try {
      localStorage.setItem('Quake.' + this.searchpaths[this.searchpaths.length - 1].filename + '/' + filename, dest.join(''));
    } catch (e) {
      Sys.Print('COM.WriteFile: failed on ' + filename + ', ' + (e as Error).message + '\n');
      return false;
    }
    Sys.Print('COM.WriteFile: ' + filename + '\n');
    return true;
  }

  static WriteTextFile(filename: string, data: string): boolean {
    filename = filename.toLowerCase();
    try {
      localStorage.setItem('Quake.' + this.searchpaths[this.searchpaths.length - 1].filename + '/' + filename, data);
    } catch (e) {
      Sys.Print('COM.WriteTextFile: failed on ' + filename + ', ' + (e as Error).message + '\n');
      return false;
    }
    Sys.Print('COM.WriteTextFile: ' + filename + '\n');
    return true;
  }

  static GetNetpath(filename: string, gameDir: string | null = null): string {
    if (gameDir === null) {
      gameDir = this.GetGamedir();
    }

    const cdnURLPatternValue = registry.urls?.cdnURL;

    if (cdnURLPatternValue) {
      return cdnURLPatternValue
        .replace('{shard}', Math.floor(Math.random() * 4 + 1).toFixed(0))
        .replace('{filename}', filename)
        .replace('{gameDir}', gameDir);
    }

    return `${location.protocol}//${location.host}/qfs/${filename}`;
  }

  /**
   * Get the current game directory.
   * @returns game name, e.g. `'id1'`
   */
  static GetGamedir(): string {
    return this.searchpaths.length > 0
      ? this.searchpaths[this.searchpaths.length - 1].filename
      : defaultGame;
  }

  /**
   * Load a file from the virtual filesystem.
   * Searches localStorage first, then fetches from the CDN/server.
   * @returns binary content, or null if not found
   */
  static async LoadFile(filename: string): Promise<ArrayBuffer | null> {
    filename = filename.toLowerCase();

    eventBus.publish('com.fs.being', filename);

    // Determine file path based on active game directory
    const gameDir = this.GetGamedir();
    const netpath = this.GetNetpath(filename, gameDir);

    // 1) Try localStorage first
    if (!registry.isInsideWorker) {
      const localData = localStorage.getItem(`Quake.${gameDir}/${filename}`);
      if (localData !== null) {
        Sys.Print(`COM.LoadFile: ${netpath} (localStorage)\n`);
        eventBus.publish('com.fs.end', filename);
        return Q.strmem(localData);
      }
    }

    // 2) Load from pre-merged filesystem (all PAKs and priorities resolved at build time)
    try {
      const directResponse = await fetch(netpath, {
        signal: this.abortController?.signal, // unavailable in workers
      });

      if (directResponse.ok) {
        const data = await directResponse.arrayBuffer();
        Sys.Print(`COM.LoadFile: ${netpath}\n`);
        eventBus.publish('com.fs.end', filename);
        return data;
      }
    } catch (e) {
      console.warn(`COM.LoadFile: fetch failed for ${netpath}`, e);
      // File doesn't exist
    }

    // File not found
    Sys.Print(`COM.LoadFile: can't find ${filename}\n`);
    eventBus.publish('com.fs.end', filename);
    return null;
  }

  /**
   * Load a text file, stripping carriage returns.
   * @returns file content as a string, or null if not found
   */
  static async LoadTextFile(filename: string): Promise<string | null> {
    const buf = await this.LoadFile(filename);
    if (buf === null) {
      return null;
    }
    const bufview = new Uint8Array(buf);
    const f: string[] = [];
    for (let i = 0; i < bufview.length; i++) {
      if (bufview[i] !== 13) { // skip CR
        f[f.length] = String.fromCharCode(bufview[i]);
      }
    }
    return f.join('');
  }

  /**
   * Add a game directory to the search path.
   * Note: PAK files are pre-extracted at build time, so we only track the directory.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  static async AddGameDirectory(dir: string) {
    const search: SearchPath = { filename: dir, pack: [] };
    this.searchpaths.push(search);
    Con.DPrint(`Added game directory: ${dir}\n`);
  }

  static async InitFilesystem() {
    // Shortcut for specifying game directory at build time
    if (registry.buildConfig?.gameDir) {
      await this.AddGameDirectory(registry.buildConfig.gameDir);
      this.gamedir = [this.searchpaths[this.searchpaths.length - 1]];
      return;
    }

    let search: string | undefined;

    const i = this.CheckParm('-basedir');
    if (i !== null) {
      search = this.argv[i + 1];
    }
    if (search !== undefined) {
      await this.AddGameDirectory(search);
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
