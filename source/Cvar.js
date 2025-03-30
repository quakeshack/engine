/* global Host, Cvar, Q, SV, Con */

// eslint-disable-next-line no-global-assign
Cvar = class Cvar {
  /** @type {Map<string,Cvar>} @private */
  static _vars = {};

  static FLAG = {
    NONE: 0,
    ARCHIVE: 1,
    SERVER: 2,
    READONLY: 4,
  };

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

  get value() {
    return Q.atof(this.string);
  }

  static FindVar(name) {
    return Cvar._vars[name] || null;
  }

  static CompleteVariable(partial) {
    if (!partial.length) {
      return null;
    }

    return Object.keys(Cvar._vars).find((name) => name.startsWith(partial)) || null;
  }

  set(value) {
    if (typeof value === 'boolean') {
      value = value ? '1' : '0';
    }

    const changed = this.string !== value;

    this.string = value;

    if ((this.flags & Cvar.FLAG.SERVER) && changed && SV.server.active) {
      Host.BroadcastPrint(`"${this.name}" changed to "${this.string}"\n`);
    }

    // CR: automatically save when an archive Cvar changed
    if ((this.flags & Cvar.FLAG.ARCHIVE) && changed && Host.initialized) {
      Host.WriteConfiguration();
    }

    return this;
  }

  setValue(value) {
    return this.set(value.toFixed(6));
  }

  static Set(name, value) {
    const variable = Cvar._vars[name];

    console.assert(variable !== undefined, 'variable must be registered', name);

    variable.set(value);

    return true;
  }

  static SetValue(name, value) {
    Cvar.Set(name, value.toFixed(6));
  }

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

  static Command(...argv) {
    const v = Cvar.FindVar(argv[0]);

    if (!v) {
      return null;
    }

    if (argv.length <= 1) {
      Con.Print(`"${v.name}" is "${v.string}"\n`);

      if (v.description) {
        Con.Print(`- ${v.description}\n`);
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

      return true;
    }

    if (v.flags & Cvar.FLAG.READONLY) {
      Con.Print(`"${v.name}" is read-only\n`);
      return true;
    }

    Cvar.Set(v.name, argv[1]);
    return true;
  }

  static WriteVariables() {
    return Object.values(Cvar._vars)
        .filter((v) => v.archive)
        .map((v) => `${v.name} "${v.string}"\n`)
        .join('');
  }
};
