import { eventBus, getCommonRegistry, registry } from '../registry.ts';
import Cmd from './Cmd.ts';
import Q from '../../shared/Q.ts';
import { cvarFlags } from '../../shared/Defs.ts';

type CvarValue = number | string | boolean;
type CvarFilter = (variable: Cvar) => boolean;

let { Con, SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, SV } = getCommonRegistry());
});

/**
 * Console Variable.
 */
export default class Cvar {
  static _vars: Record<string, Cvar> = {};

  static FLAG = cvarFlags;

  // TODO: add things like onChange, onPreChange so that we can hook into changes of the variable

  #currentValue: string;
  #numberValue: number;
  #originalValue: string;
  #name: string;

  flags: number;
  readonly description: string | null;

  get name(): string {
    return this.#name;
  }

  get string(): string {
    return this.#currentValue;
  }

  get value(): number {
    return this.#numberValue;
  }

  constructor(name: string, value: string, flags: number = Cvar.FLAG.NONE, description: string | null = null) {
    // making sure these fields are out of reach
    this.#name = name;
    this.#currentValue = value;
    this.#originalValue = value;
    this.flags = flags;
    this.description = description;
    this.#numberValue = value === '' ? 0 : Q.atof(value);

    console.assert(name.length > 0, 'Cvar name must be at least 1 character long', name);
    console.assert(!Cvar._vars[name], 'Cvar name must not be used already', name);

    Cvar._vars[name] = this;
  }

  get archive(): boolean {
    return (this.flags & Cvar.FLAG.ARCHIVE) !== 0;
  }

  get server(): boolean {
    return (this.flags & Cvar.FLAG.SERVER) !== 0;
  }

  free(): void {
    delete Cvar._vars[this.name];
  }

  static FindVar(name: string): Cvar | null {
    return Cvar._vars[name] ?? null;
  }

  static GetVariableNames(): string[] {
    return Object.keys(Cvar._vars);
  }

  static CompleteVariable(partial: string): string | null {
    if (!partial.length) {
      return null;
    }

    return Cvar.GetVariableNames().find((name) => name.startsWith(partial)) ?? null;
  }

  set(value: CvarValue): this {
    let nextValue: string;

    // turning everything into a string
    switch (typeof value) {
      case 'boolean':
        nextValue = value ? '1' : '0';
        break;
      case 'string':
        nextValue = value.trim();
        break;
      case 'number':
        nextValue = value.toString();
        break;
      default:
        console.assert(false, 'invalid type of value', value);
        nextValue = '';
        break;
    }

    const changed = this.#currentValue !== nextValue;

    // TODO: implement Cvar.FLAG.DEFERRED

    this.#currentValue = nextValue;
    this.#numberValue = nextValue === '' ? 0 : Q.atof(nextValue);

    if (changed) {
      eventBus.publish('cvar.changed', this.name);
      eventBus.publish(`cvar.changed.${this.name}`, this);
    }

    return this;
  }

  reset(): this {
    this.set(this.#originalValue);
    return this;
  }

  toString(): string {
    return this.#currentValue;
  }

  static Set(name: string, value: CvarValue): Cvar | null {
    const variable = Cvar._vars[name];

    console.assert(variable !== undefined, 'variable must be registered', name);

    if (!variable) {
      return null;
    }

    variable.set(value);
    return variable;
  }

  static Command_f(name: string, value?: string): boolean {
    const variable = Cvar.FindVar(name);

    if (variable === null) {
      return false;
    }

    if (value === undefined) {
      Con.Print(`"${variable.name}" is "${variable.string}"\n`);
      Con.DPrint(`... "${variable.string}" is ${variable.value} as a numeric value\n`);

      if (variable.description) {
        Con.Print(`> ${variable.description}\n`);
      }

      if (variable.flags & Cvar.FLAG.READONLY) {
        Con.Print('- Cannot be changed.\n');
      }

      if (variable.flags & Cvar.FLAG.ARCHIVE) {
        Con.Print('- Will be saved to the configuration file.\n');
      }

      if (variable.flags & Cvar.FLAG.SERVER) {
        Con.Print('- Is a server variable.\n');
      }

      if (variable.flags & Cvar.FLAG.GAME) {
        Con.Print('- Is a game variable.\n');
      }

      if (variable.flags & Cvar.FLAG.DEFERRED) {
        Con.Print('- New value will be applied on the next map.\n');
      }

      if (variable.flags & Cvar.FLAG.CHEAT) {
        Con.Print('- Cheat.\n');
      }

      if ((variable.flags & Cvar.FLAG.SECRET) && (variable.flags & Cvar.FLAG.SERVER)) {
        Con.Print('- Changed value will not be broadcasted, sensitive information.\n');
      }

      return true;
    }

    if (variable.flags & Cvar.FLAG.READONLY) {
      Con.PrintWarning(`"${variable.name}" is read-only\n`);
      return true;
    }

    const clientSvCheats = registry.CL?.cls.serverInfo?.sv_cheats;

    if ((variable.flags & Cvar.FLAG.CHEAT) && SV.server.active && clientSvCheats !== '1') {
      Con.Print('Cheats are not enabled on this server.\n');
      return true;
    }

    // TODO: check if there’s a min/max value and clamp accordingly

    variable.set(value);
    return true;
  }

  static WriteVariables(): string {
    return Object.values(Cvar._vars)
        .filter((variable) => (variable.flags & Cvar.FLAG.ARCHIVE) !== 0)
        .map((variable) => `seta "${variable.name}" "${variable.string}"\n`)
        .join('');
  }

  static *Filter(compareFn: CvarFilter): Generator<Cvar, void, undefined> {
    for (const variable of Object.values(Cvar._vars)) {
      if (compareFn(variable)) {
        yield variable;
      }
    }
  }

  static Set_f(name?: string, value?: string): void {
    if (name === undefined) {
      Con.Print('Usage: set <name> <value>\n');
      return;
    }

    if (!Cvar.Command_f.call(this, name, value)) {
      Con.PrintWarning(`Unknown variable "${name}"\n`);
    }
  }

  static Seta_f(name?: string, value?: string): void {
    if (name === undefined) {
      Con.Print('Usage: seta <name> <value>\n');
      return;
    }

    const variable = Cvar.FindVar(name);

    if (variable === null) {
      Con.PrintWarning(`Unknown variable "${name}"\n`);
      return;
    }

    if ((variable.flags & (Cvar.FLAG.ARCHIVE | Cvar.FLAG.READONLY)) === 0) {
      variable.flags |= Cvar.FLAG.ARCHIVE;
      Con.DPrint(`"${name}" flagged as archive variable\n`);
    }

    if (!Cvar.Command_f.call(this, name, value)) {
      Con.PrintWarning(`Unknown variable "${name}"\n`);
    }
  }

  static Toggle_f(name?: string): void {
    if (name === undefined) {
      Con.Print('Usage: toggle <name>\n');
      return;
    }

    const variable = Cvar.FindVar(name);

    if (variable === null) {
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

  static Cvarlist_f(start?: string): void {
    const names = Cvar.GetVariableNames().sort();

    for (const name of names) {
      const variable = Cvar._vars[name];

      if (start !== undefined && !name.startsWith(start)) {
        continue;
      }

      const flags = new Array(5).fill(' ');

      if (variable.flags & Cvar.FLAG.ARCHIVE) {
        flags[0] = 'A';
      }

      if (variable.flags & Cvar.FLAG.GAME) {
        flags[1] = 'G';
      }

      if (variable.flags & Cvar.FLAG.SERVER) {
        flags[2] = 'S';
      }

      if (variable.flags & Cvar.FLAG.READONLY) {
        flags[3] = 'R';
      }

      if (variable.flags & Cvar.FLAG.CHEAT) {
        flags[4] = 'C';
      }

      Con.Print(`${variable.name.padEnd(24)} | ${flags.join('')} | ${variable.string.padEnd(16)} | ${variable.description ?? ''}\n`);
    }
  }

  static Init(): void {
    Cmd.AddCommand('set', Cvar.Set_f);
    Cmd.AddCommand('seta', Cvar.Seta_f);
    Cmd.AddCommand('toggle', Cvar.Toggle_f);
    Cmd.AddCommand('cvarlist', Cvar.Cvarlist_f);
  }

  static Shutdown(): void {
    Cvar._vars = {};
  }
}
