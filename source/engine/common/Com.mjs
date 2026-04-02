
import { registry, eventBus } from '../registry.mjs';

import Q from '../../shared/Q.ts';
import { CorruptedResourceError } from './Errors.mjs';

import Cvar from './Cvar.mjs';
import W from './W.mjs';
import Cmd from './Cmd.mjs';
import { defaultBasedir, defaultGame } from './Def.mjs';
import { CRC16CCITT } from './CRC.mjs';

let { Con, Sys } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Sys = registry.Sys;
});

/** @typedef {{ name: string; filepos: number; filelen: number;}[]} PackFile */
/** @typedef {{filename: any; pack: PackFile[];}} SearchPath */

export default class COM {
  /** @type {string[]} */
  static argv = [];

  /** @type {SearchPath[]} */
  static searchpaths = [];

  static hipnotic = false;
  static rogue = false;
  static standard_quake = true;
  static modified = false;

  /** @type {Cvar} */
  static registered = null;

  /** @type {Cvar|string} */ // FIXME: string turns into Cvar when jumping from InitArgv to Init
  static cmdline = null;

  /** @type {?AbortController} */
  static abortController = null;

  /** @type {SearchPath[]} */
  static gamedir = null;

  /** @type {string} mod name */
  static game = defaultGame;

  static DefaultExtension(path, extension) {
    for (let i = path.length - 1; i >= 0; i--) {
      const src = path.charCodeAt(i);
      if (src === 47) {
        break;
      }
      if (src === 46) {
        return path;
      }
    }
    return path + extension;
  }

  /**
   * Quake style parser.
   * @param {string} data string to parse
   * @returns {{token: string, data: string|null}} parsed token and remaining data to parse
   */
  static Parse(data) { // FIXME: remove charCodeAt code
    let token = '';
    let i = 0; let c;
    if (data.length === 0) {
      return { token, data: null };
    }

    let skipwhite = true;
    while (true) {
      if (skipwhite !== true) {
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
      if ((c === 47) && (data.charCodeAt(i + 1) === 47)) {
        while (true) {
          if ((i >= data.length) || (data.charCodeAt(i) === 10)) {
            break;
          }
          i++;
        }
        skipwhite = true;
      }
    }

    if (c === 34) {
      i++;
      while (true) {
        c = data.charCodeAt(i);
        i++;
        if ((i >= data.length) || (c === 34)) {
          return { token, data: data.substring(i) };
        }
        token += String.fromCharCode(c);
      }
    }

    while (true) {
      if ((i >= data.length) || (c <= 32)) {
        break;
      }
      token += String.fromCharCode(c);
      i++;
      c = data.charCodeAt(i);
    }

    return { token, data: data.substring(i) };
  };

  static CheckParm(parm) {
    for (let i = 1; i < this.argv.length; i++) {
      if (this.argv[i] === parm) {
        return i;
      }
    }

    return null;
  };

  /**
   * Gets parameter from command line.
   * @param {string} parm parameter name
   * @returns {string|null} value of the parameter or null if not found
   */
  static GetParm(parm) {
    for (let i = 1; i < this.argv.length; i++) {
      if (this.argv[i] === parm) {
        return this.argv[i + 1] || null;
      }
    }

    return null;
  };

  static async CheckRegistered() {
    const filename = 'gfx/pop.lmp';
    const h = await this.LoadFile(filename);

    if (h === null) {
      Con.PrintSuccess('Playing shareware version.\n');
      eventBus.publish('com.registered', false);
      return false;
    }

    if (CRC16CCITT.Block(new Uint8Array(h)) !== 25990) { // CR: shouldn’t be that hard to generate a fake pop.lmp with the same checksum
      throw new CorruptedResourceError(filename, 'not genuine registered version');
    }

    this.registered.set(true);
    Con.PrintSuccess('Playing registered version.\n');
    eventBus.publish('com.registered', true);
    return true;
  }

  static InitArgv(argv) {
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
    // @ts-ignore: need to fix that later, this.cmdline is a string first, but then it’s turned into a Cvar.
    this.cmdline = new Cvar('cmdline', this.cmdline, Cvar.FLAG.READONLY, 'Command line used to start the game.');

    Cmd.AddCommand('path', this.Path_f);

    await this.InitFilesystem();

    await Promise.all([
      this.CheckRegistered(),
      W.LoadPalette('gfx/palette.lmp'), // CR: we early load the palette here, it’s needed in both dedicated and browser processes
    ]);

    Sys.Print('COM.Init: low-level initialization completed.\n');

    eventBus.publish('com.ready');
  }

  static Shutdown() {
    Sys.Print('COM.Shutdown: signaling outstanding promises to abort\n');

    this.abortController.abort('COM.Shutdown');
  }

  static Path_f() {
    Con.Print('Files are served from the unified virtual filesystem.\n');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  static async WriteFile(filename, data, len) {
    if (registry.isInsideWorker) {
      Sys.Print('COM.WriteFile: not supported inside worker threads\n');
      return false;
    }

    filename = filename.toLowerCase();
    const dest = [];
    for (let i = 0; i < len; i++) {
      dest[i] = String.fromCharCode(data[i]);
    }
    try {
      localStorage.setItem('Quake.' + this.searchpaths[this.searchpaths.length - 1].filename + '/' + filename, dest.join(''));
    } catch (e) {
      Sys.Print('COM.WriteFile: failed on ' + filename + ', ' + e.message + '\n');
      return false;
    }
    Sys.Print('COM.WriteFile: ' + filename + '\n');
    return true;
  };

  static WriteTextFile(filename, data) {
    filename = filename.toLowerCase();
    try {
      localStorage.setItem('Quake.' + this.searchpaths[this.searchpaths.length - 1].filename + '/' + filename, data);
    } catch (e) {
      Sys.Print('COM.WriteTextFile: failed on ' + filename + ', ' + e.message + '\n');
      return false;
    }
    Sys.Print('COM.WriteTextFile: ' + filename + '\n');
    return true;
  };

  static GetNetpath(filename, gameDir = null) {
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
   * Get the current game directory
   * @returns {string} game name, e.g. 'id1'
   */
  static GetGamedir() {
    return this.searchpaths.length > 0
      ? this.searchpaths[this.searchpaths.length - 1].filename
      : defaultGame;
  }

  /**
   * @param {string} filename virtual filename
   * @returns {Promise<ArrayBuffer>} binary content
   */
  static async LoadFile(filename) {
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
   * Loads a text file.
   * @param {string} filename filename
   * @returns {Promise<string>} content of the file as a string
   */
  static async LoadTextFile(filename) {
    const buf = await this.LoadFile(filename);
    if (buf === null) {
      return null;
    }
    const bufview = new Uint8Array(buf);
    const f = [];
    for (let i = 0; i < bufview.length; i++) {
      if (bufview[i] !== 13) {
        f[f.length] = String.fromCharCode(bufview[i]);
      }
    }
    return f.join('');
  };

  /**
   * Add a game directory to the search path.
   * Note: PAK files are pre-extracted at build time, so we only track the directory.
   * @param {string} dir - directory name (e.g., 'id1')
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  static async AddGameDirectory(dir) {
    /** @type {SearchPath} */
    const search = { filename: dir, pack: [] };
    this.searchpaths[this.searchpaths.length] = search;
    Con.DPrint(`Added game directory: ${dir}\n`);
  };

  static async InitFilesystem() {
    // Shortcut for specifying game directory at build time
    if (registry.buildConfig?.gameDir) {
      await this.AddGameDirectory(registry.buildConfig.gameDir);
      this.gamedir = [this.searchpaths[this.searchpaths.length - 1]];
      return;
    }

    let search;

    let i = this.CheckParm('-basedir');
    if (i !== null) {
      search = this.argv[i + 1];
    }
    if (search !== undefined) {
      await this.AddGameDirectory(search);
    } else {
      await this.AddGameDirectory(defaultBasedir);
    }

    if (this.rogue === true) {
      await this.AddGameDirectory('rogue');
    } else if (this.hipnotic === true) {
      await this.AddGameDirectory('hipnotic');
    }

    i = this.CheckParm('-game');
    if (i !== null) {
      search = this.argv[i + 1];
      if (search !== undefined) {
        this.modified = true;
        this.game = search;
        await this.AddGameDirectory(search);
      }
    } else if (defaultGame !== defaultBasedir) {
      this.game = defaultGame;
      this.modified = true;
      await this.AddGameDirectory(defaultGame);
    }

    this.gamedir = [this.searchpaths[this.searchpaths.length - 1]];
  }
};
