/* global Host, Cvar, Q, SV, Con, Cmd */

/**
 * Console Variable
 */
// eslint-disable-next-line no-global-assign
Cvar = class Cvar {
  /** @type {Map<string,Cvar>} @private */
  static _vars = {};

  static FLAG = {
    NONE: 0,
    /** archive will make the engine write the modified variable to local storage or file (dedicated only) */
    ARCHIVE: 1,
    /** server will make changes be broadcast to all clients */
    SERVER: 2,
    /** readonly cannot be changed by the user, only through the API */
    READONLY: 4,
    /** value won’t be shown in broadcast message */
    SECRET: 8,
    /** variable declared by the game code */
    GAME: 16,
    /** variable will be changed upon next map */
    DEFERRED: 32,
  };

  /**
   * @param {string} name name of the variable
   * @param {string} value preset value of the variable
   * @param {Cvar.FLAG} flags optional flags for the variable
   * @param {?string} description optional description of the variable
   */
  constructor(name, value, flags = 0, description = null) {
    /** @type {string} @private */
    this.name = name;
    /** @type {string} @private */
    this.string = value;
    /** @type {Cvar.FLAGS} @private */
    this.flags = flags;
    /** @type {?string} @private */
    this.description = description;

    Cvar._vars[name] = this;
  }

  /**
   * Returns the value of the console variable as a floating-point number.
   * @returns {number} The numeric value of the console variable.
   */
  get value() {
    return Q.atof(this.string);
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

    const changed = this.string !== value;

    // TODO: implement Cvar.FLAG.DEFERRED

    this.string = value;

    if ((this.flags & Cvar.FLAG.SERVER) && changed && SV.server.active) {
      if (this.flags & Cvar.FLAG.SECRET) {
        Host.BroadcastPrint(`"${this.name}" changed\n`);
      } else {
        Host.BroadcastPrint(`"${this.name}" changed to "${this.string}"\n`);
      }
    }

    // CR: automatically save when an archive Cvar changed
    if ((this.flags & Cvar.FLAG.ARCHIVE) && changed && Host.initialized) {
      Host.WriteConfiguration();
    }

    return this;
  }

  /**
   * Sets the value of the console variable to a floating-point number.
   * @param {number} value new value
   * @deprecated use set instead
   * @see {@link Cvar#set}
   * @returns {Cvar} this
   */
  setValue(value) {
    return this.set(value);
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

    variable.set(value);

    return variable;
  }

  /**
   * Sets the value of the console variable to a floating-point number.
   * @param {string} name name of the variable
   * @param {number} value new value
   * @deprecated use Set instead
   * @see {@link Cvar#Set}
   * @returns {Cvar} variable
   */
  static SetValue(name, value) {
    return Cvar.Set(name, value);
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

      if (v.description) {
        Con.Print(`> ${v.description}\n`);
      }

      if (v.flags & Cvar.FLAG.READONLY) {
        Con.Print(`- Cannot be changed.\n`);
      }

      if (v.flags & Cvar.FLAG.ARCHIVE) {
        Con.Print(`- Will be saved to the configuration file.\n`);
      }

      if (v.flags & Cvar.FLAG.SERVER) {
        Con.Print(`- Is a server variable.\n`);
      }

      if (v.flags & Cvar.FLAG.GAME) {
        Con.Print(`- Is a game variable.\n`);
      }

      if (v.flags & Cvar.FLAG.DEFERRED) {
        Con.Print(`- New value will be applied on the next map.\n`);
      }

      if (v.flags & Cvar.FLAG.SECRET) {
        if (v.flags & Cvar.FLAG.SERVER) {
          Con.Print(`- Changed value will not be broadcasted, sensitive information.\n`);
        }
      }

      return true;
    }

    if (v.flags & Cvar.FLAG.READONLY) {
      Con.PrintWarning(`"${v.name}" is read-only\n`);
      return true;
    }

    v.set(value);

    return true;
  }

  /**
   * @returns {string} all variables that are marked as archive
   */
  static WriteVariables() {
    return Object.values(Cvar._vars)
        .filter((v) => (v.flags & Cvar.FLAG.ARCHIVE) !== 0)
        .map((v) => `${v.name} "${v.string}"\n`)
        .join('');
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

  /**
   * Initializes the Cvar system.
   */
  static Init() {
    Cmd.AddCommand('set', Cvar.Set_f);
    // TODO: seta
    Cmd.AddCommand('toggle', Cvar.Toggle_f);
  }

  /**
   * Unregisters all variables.
   */
  static Shutdown() {
    Cvar._vars = {};
  }
};
