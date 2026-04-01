import { registry, eventBus } from '../registry.mjs';
import Cmd from './Cmd.mjs';
import Q from '../../shared/Q.mjs';
import { cvarFlags } from '../../shared/Defs.mjs';

let { CL, Con, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  SV = registry.SV;
});

/**
 * Console Variable
 */
export default class Cvar {
  /** @type {Record<string, Cvar>} @private */
  static _vars = {};

  static FLAG = cvarFlags;

  // TODO: add things like onChange, onPreChange so that we can hook into changes of the variable

  /** @type {string} */
  #currentValue = null;

  /** @type {number} */
  #numberValue = null;

  /** @type {string} @readonly */
  #originalValue = null;

  /** @type {string} @readonly */
  #name = null;

  get name() { return this.#name; }
  get string() { return this.#currentValue; }
  get value() { return this.#numberValue; }

  /**
   * @param {string} name name of the variable
   * @param {string} value preset value of the variable
   * @param {number} flags optional flags for the variable
   * @param {?string} description optional description of the variable
   */
  constructor(name, value, flags = Cvar.FLAG.NONE, description = null) {
    // making sure these fields are out of reach
    this.#name = name;
    this.#currentValue = value;
    this.#originalValue = value;

    /** @type {number} @see Cvar.FLAG */
    this.flags = flags;
    /** @type {?string} @readonly */
    this.description = description;

    this.#numberValue = value === '' ? 0 : Q.atof(value);

    console.assert(name.length > 0, 'Cvar name must be at least 1 character long', name);
    console.assert(!Cvar._vars[name], 'Cvar name must not be used already', name);

    Cvar._vars[name] = this;
  }

  /**
   * @deprecated use flags instead
   * @returns {boolean} whether the variable is an archive variable
   */
  get archive() {
    return !!(this.flags & Cvar.FLAG.ARCHIVE);
  }

  /**
   * @deprecated use flags instead
   * @returns {boolean} whether the variable is a server variable
   */
  get server() {
    return !!(this.flags & Cvar.FLAG.SERVER);
  }

  /**
   * Deletes the console variable from the list of variables.
   */
  free() {
    delete Cvar._vars[this.name];
  }

  /**
   * Finds a console variable by name.
   * @param {string} name console variable name
   * @returns {Cvar|null} The console variable if found, otherwise null.
   */
  static FindVar(name) {
    return Cvar._vars[name] || null;
  }

  /**
   * Completes a variable name based on a partial string.
   * @param {string} partial starting string of the variable name
   * @returns {string|null} The name of the console variable if found, otherwise null.
   */
  static CompleteVariable(partial) {
    if (!partial.length) {
      return null;
    }

    return Object.keys(Cvar._vars).find((name) => name.startsWith(partial)) || null;
  }

  /**
   * Sets the value of the console variable.
   * Setting a variable to a boolean will convert it to a string.
   * READONLY variables can be changed through this.
   * @param {number|string|boolean} value new value
   * @returns {Cvar} this
   */
  set(value) {
    // turning everything into a string
    switch (typeof value) {
      case 'boolean':
        value = value ? '1' : '0';
        break;
      case 'string':
        value = value.trim();
        break;
      case 'number':
        value = value.toString();
        break;

      default:
        console.assert(false, 'invalid type of value', value);
        value = '';
      }

    const changed = this.#currentValue !== value;

    // TODO: implement Cvar.FLAG.DEFERRED

    this.#currentValue = value;
    this.#numberValue = value === '' ? 0 : Q.atof(value);

    if (changed) {
      eventBus.publish('cvar.changed', this.name);
      eventBus.publish(`cvar.changed.${this.name}`, this);
    }

    return this;
  }

  /**
   * Resets the console variable to its original value.
   * @returns {Cvar} this
   */
  reset() {
    this.set(this.#originalValue);

    return this;
  }

  /**
   * For easy embedding in strings. It will return the current value of the console variable.
   * @returns {string} string representation of the console variable
   */
  toString() {
    return this.#currentValue;
  }

  /**
   * Sets the value of the console variable.
   * @param {string} name name of the variable
   * @param {number|string|boolean} value new value
   * @returns {Cvar} variable
   */
  static Set(name, value) {
    const variable = Cvar._vars[name];

    console.assert(variable !== undefined, 'variable must be registered', name);

    if (!variable) {
      return null;
    }

    variable.set(value);

    return variable;
  }

  /**
   * Command line interface for console variables.
   * @param {string} name name of the variable
   * @param {?string} value value to set
   * @returns {boolean} true if the variable handling was executed successfully, false otherwise
   */
  static Command_f(name, value) {
    const v = Cvar.FindVar(name);

    if (!v) {
      return false;
    }

    if (value === undefined) {
      Con.Print(`"${v.name}" is "${v.string}"\n`);
      Con.DPrint(`... "${v.string}" is ${v.value} as a numeric value\n`);

      if (v.description) {
        Con.Print(`> ${v.description}\n`);
      }

      if (v.flags & Cvar.FLAG.READONLY) {
        Con.Print('- Cannot be changed.\n');
      }

      if (v.flags & Cvar.FLAG.ARCHIVE) {
        Con.Print('- Will be saved to the configuration file.\n');
      }

      if (v.flags & Cvar.FLAG.SERVER) {
        Con.Print('- Is a server variable.\n');
      }

      if (v.flags & Cvar.FLAG.GAME) {
        Con.Print('- Is a game variable.\n');
      }

      if (v.flags & Cvar.FLAG.DEFERRED) {
        Con.Print('- New value will be applied on the next map.\n');
      }

      if (v.flags & Cvar.FLAG.CHEAT) {
        Con.Print('- Cheat.\n');
      }

      if (v.flags & Cvar.FLAG.SECRET) {
        if (v.flags & Cvar.FLAG.SERVER) {
          Con.Print('- Changed value will not be broadcasted, sensitive information.\n');
        }
      }

      return true;
    }

    if (v.flags & Cvar.FLAG.READONLY) {
      Con.PrintWarning(`"${v.name}" is read-only\n`);
      return true;
    }

    if ((v.flags & Cvar.FLAG.CHEAT) && SV.server.active && !registry.isDedicatedServer && CL.cls.serverInfo?.sv_cheats !== '1') {
      Con.Print('Cheats are not enabled on this server.\n');
      return true;
    }

    // TODO: check if there’s a min/max value and clamp accordingly

    v.set(value);

    return true;
  }

  /**
   * @returns {string} all variables that are marked as archive
   */
  static WriteVariables() {
    return Object.values(Cvar._vars)
        .filter((v) => (v.flags & Cvar.FLAG.ARCHIVE) !== 0)
        .map((v) => `seta "${v.name}" "${v.string}"\n`) // FIXME: escape quotes in value
        .join('');
  }

  /**
   * Filter all variables by a function.
   * @param {Function} compareFn function to compare the variable, first argument will be a Cvar
   * @yields {Cvar} variable
   */
  static *Filter(compareFn) {
    for (const variable of Object.values(Cvar._vars)) {
      if (compareFn(variable)) {
        yield variable;
      }
    }
  }

  /**
   * @param {string} name name of the variable
   * @param {?string} value value to set
   */
  static Set_f(name, value) {
    if (name === undefined) {
      Con.Print('Usage: set <name> <value>\n');
      return;
    }

    if (!Cvar.Command_f.call(this, name, value)) {
      Con.PrintWarning(`Unknown variable "${name}"\n`);
    }
  }

  /**
   * @param {string} name name of the variable
   * @param {?string} value value to set
   */
  static Seta_f(name, value) {
    if (name === undefined) {
      Con.Print('Usage: seta <name> <value>\n');
      return;
    }

    const variable = Cvar.FindVar(name);

    if (!variable) {
      Con.PrintWarning(`Unknown variable "${name}"\n`);
      return;
    }

    if (!(variable.flags & (Cvar.FLAG.ARCHIVE | Cvar.FLAG.READONLY))) {
      variable.flags |= Cvar.FLAG.ARCHIVE;
      Con.DPrint(`"${name}" flagged as archive variable\n`);
    }

    if (!Cvar.Command_f.call(this, name, value)) {
      Con.PrintWarning(`Unknown variable "${name}"\n`);
    }
  }

  /**
   * Toggles a variable between 0 and 1.
   * @param {string} name name of the variable
   */
  static Toggle_f(name) {
    if (name === undefined) {
      Con.Print('Usage: toggle <name>\n');
      return;
    }

    const variable = Cvar.FindVar(name);

    if (!variable) {
      Con.PrintWarning(`Unknown variable "${name}"\n`);
      return;
    }

    if (variable.flags & Cvar.FLAG.READONLY) {
      Con.PrintWarning(`"${name}" is read-only\n`);
      return;
    }

    variable.set(variable.value === 0 ? 1 : 0);

    Con.Print(`"${name}" toggled to "${variable.string}"\n`);
  }

  static Cvarlist_f(start) {
    const names = Object.keys(Cvar._vars).sort();

    for (const name of names) {
      const v = Cvar._vars[name];

      if (start !== undefined && !name.startsWith(start)) {
        continue;
      }

      const flags = new Array(5).fill(' ');

      if (v.flags & Cvar.FLAG.ARCHIVE) {
        flags[0] = 'A';
      }

      if (v.flags & Cvar.FLAG.GAME) {
        flags[1] = 'G';
      }

      if (v.flags & Cvar.FLAG.SERVER) {
        flags[2] = 'S';
      }

      if (v.flags & Cvar.FLAG.READONLY) {
        flags[3] = 'R';
      }

      if (v.flags & Cvar.FLAG.CHEAT) {
        flags[4] = 'C';
      }

      Con.Print(`${v.name.padEnd(24)} | ${flags.join('')} | ${v.string.padEnd(16)} | ${v.description || ''}\n`);
    }
  }

  /**
   * Initializes the Cvar system.
   */
  static Init() {
    Cmd.AddCommand('set', Cvar.Set_f);
    Cmd.AddCommand('seta', Cvar.Seta_f);
    Cmd.AddCommand('toggle', Cvar.Toggle_f);
    Cmd.AddCommand('cvarlist', Cvar.Cvarlist_f);
  }

  /**
   * Unregisters all variables.
   */
  static Shutdown() {
    Cvar._vars = {};
  }
};
