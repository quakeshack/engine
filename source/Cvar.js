/* global Host, Cvar, Q, SV, Con */

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
    this.string = new String(value);
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
    console.assert(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean', 'value must be a string, number or boolean', value);

    if (typeof value === 'boolean') {
      value = value ? '1' : '0';
    }

    const changed = this.string !== value;

    this.string = new String(value);

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
   * @returns {Cvar} this
   */
  setValue(value) {
    return this.set(value.toFixed(6));
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
   * @returns {Cvar} variable
   */
  static SetValue(name, value) {
    return Cvar.Set(name, value.toFixed(6));
  }

  /**
   * Quake-style API for registering variables.
   * @deprecated use `new Cvar` instead
   * @param {string} name name
   * @param {*} value preset value
   * @param {boolean} archive whether to archive the variable
   * @param {boolean} server whether to broadcast the variable to all clients
   * @returns {Cvar} registered cvar
   */
  static RegisterVariable(name, value, archive, server) {
    console.assert(Cvar._vars[name] === undefined, 'variable must be unique', name);

    let flags = 0;

    if (archive) {
      flags |= Cvar.FLAG.ARCHIVE;
    }

    if (server) {
      flags |= Cvar.FLAG.SERVER;
    }

    return new Cvar(name, value, flags);
  }

  /**
   * Command line interface for console variables.
   * @param  {...any} argv command line arguments
   * @returns {boolean} true if the variable handling was executed successfully, false otherwise
   */
  static Command(...argv) {
    const v = Cvar.FindVar(argv[0]);

    if (!v) {
      return false;
    }

    if (argv.length <= 1) {
      Con.Print(`"${v.name}" is "${v.string}"\n`);

      if (v.description) {
        Con.Print(`- ${v.description}\n`);
      }

      Con.Print('\n');

      if (v.flags & Cvar.FLAG.READONLY) {
        Con.Print(`- Cannot be changed.\n`);
      }

      if (v.flags & Cvar.FLAG.ARCHIVE) {
        Con.Print(`- Will be saved to the configuration file.\n`);
      }

      if (v.flags & Cvar.FLAG.SERVER) {
        Con.Print(`- Is a server variable.\n`);
      }

      if (v.flags & Cvar.FLAG.SECRET) {
        if (v.flags & Cvar.FLAG.SERVER) {
          Con.Print(`- Changed value will not be broadcasted, sensitive information.\n`);
        }
      }

      return true;
    }

    if (v.flags & Cvar.FLAG.READONLY) {
      Con.Print(`"${v.name}" is read-only\n`);
      return true;
    }

    Cvar.Set(v.name, argv[1]);
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
   * Unregisters all variables.
   */
  static Shutdown() {
    Cvar._vars = {};
  }
};
