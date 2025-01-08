/* global Host, Cmd, Cvar, Q, SV, Con */

// eslint-disable-next-line no-global-assign
Cvar = class Cvar {
  static FindVar(name) {
    return Cvar.vars.find((v) => v.name === name) || null;
  }

  static CompleteVariable(partial) {
    if (!partial.length) {
      return null;
    }
    return Cvar.vars.find((v) => v.name.startsWith(partial))?.name || null;
  }

  static Set(name, value) {
    const variable = Cvar.vars.find((v) => v.name === name);

    if (!variable) {
      console.warn(`Cvar.Set: variable ${name} not found`);
      return false;
    }

    const changed = variable.string !== value;
    variable.string = value;
    variable.value = Q.atof(value);

    if (variable.server && changed && SV.server.active) {
      Host.BroadcastPrint(`"${variable.name}" changed to "${variable.string}"\n`);
    }

    return true;
  }

  static SetValue(name, value) {
    Cvar.Set(name, value.toFixed(6));
  }

  static RegisterVariable(name, value, archive, server) {
    if (Cvar.vars.some((v) => v.name === name)) {
      console.warn(`Can't register variable ${name}, already defined`);
      return null;
    }

    const newVar = {
      name,
      string: value,
      archive: !!archive,
      server: !!server,
      value: Q.atof(value),
    };

    Cvar.vars.push(newVar);
    return newVar;
  }

  static Command() {
    const v = Cvar.FindVar(Cmd.argv[0]);

    if (!v) {
      return null;
    }

    if (Cmd.argv.length <= 1) {
      Con.Print(`"${v.name}" is "${v.string}"\n`);
      return true;
    }

    Cvar.Set(v.name, Cmd.argv[1]);
    return true;
  }

  static WriteVariables() {
    return Cvar.vars
        .filter((v) => v.archive)
        .map((v) => `${v.name} "${v.string}"\n`)
        .join('');
  }
};

Cvar.vars = [];
