import type { EdictData, ServerGameInterface } from '../../shared/GameInterfaces.ts';

import Cmd from '../common/Cmd.ts';
import { CRC16CCITT } from '../common/CRC.ts';
import Cvar from '../common/Cvar.ts';
import { HostError, MissingResourceError } from '../common/Errors.ts';
import Q from '../../shared/Q.ts';
import Vector from '../../shared/Vector.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';
import { ED, ServerEdict, type BaseEntity } from './Edict.ts';
import { ServerEngineAPI } from '../common/GameAPIs.ts';
import PF, { etype, ofs } from './ProgsAPI.ts';
import { gameCapabilities } from '../../shared/Defs.ts';
import { loadGameModule, type GameModuleInterface } from './GameLoader.ts';

interface ProgsStatement {
  op: number;
  a: number;
  b: number;
  c: number;
}

interface ProgsDefinition {
  type: number;
  ofs: number;
  name: number;
}

interface ProgsFunctionDefinition {
  first_statement: number;
  parm_start: number;
  locals: number;
  profile: number;
  name: number;
  file: number;
  numparms: number;
  parm_size: number[];
}

type ProgsValue = string | number | boolean | number[] | null;
type ProgsStackEntry = [number, ProgsFunctionDefinition | null];

interface FunctionProxySettings {
  readonly backupSelfAndOther?: boolean;
  readonly resetOther?: boolean;
}

type ProgsSerializedValue = [string, ...unknown[]];
type ProgsSerializedData = Record<string, ProgsSerializedValue>;
type ProgsEntityRecord = ProgsEntity & Record<string, unknown>;

interface ProgsGameAPI extends ServerGameInterface {
  readonly [key: string]: unknown;
  coop: number;
  deathmatch: number;
  mapname: string | null;
  serverflags: number;
}

const PROGS_OP = Object.freeze({
  done: 0,
  mul_f: 1, mul_v: 2, mul_fv: 3, mul_vf: 4,
  div_f: 5,
  add_f: 6, add_v: 7,
  sub_f: 8, sub_v: 9,
  eq_f: 10, eq_v: 11, eq_s: 12, eq_e: 13, eq_fnc: 14,
  ne_f: 15, ne_v: 16, ne_s: 17, ne_e: 18, ne_fnc: 19,
  le: 20, ge: 21, lt: 22, gt: 23,
  load_f: 24, load_v: 25, load_s: 26, load_ent: 27, load_fld: 28, load_fnc: 29,
  address: 30,
  store_f: 31, store_v: 32, store_s: 33, store_ent: 34, store_fld: 35, store_fnc: 36,
  storep_f: 37, storep_v: 38, storep_s: 39, storep_ent: 40, storep_fld: 41, storep_fnc: 42,
  ret: 43,
  not_f: 44, not_v: 45, not_s: 46, not_ent: 47, not_fnc: 48,
  jnz: 49, jz: 50,
  call0: 51, call1: 52, call2: 53, call3: 54, call4: 55, call5: 56, call6: 57, call7: 58, call8: 59,
  state: 60,
  jump: 61,
  and: 62, or: 63,
  bitand: 64, bitor: 65,
});

const PROGS_GLOBALVARS = Object.freeze({
  self: 28,
  other: 29,
  time: 31,
});

interface ProgsModule {
  saveglobal: number;
  op: typeof PROGS_OP;
  version: number;
  max_parms: number;
  globalvars: typeof PROGS_GLOBALVARS;
  entvars: Record<string, number | null>;
  ofs: typeof ofs;
  progheader_crc: number;
  crc: number;
  stack: ProgsStackEntry[];
  depth: number;
  localstack: number[];
  localstack_used: number;
  localstack_size: number;
  statements: ProgsStatement[];
  globaldefs: ProgsDefinition[];
  fielddefs: ProgsDefinition[];
  functions: ProgsFunctionDefinition[];
  strings: number[];
  string_temp: number;
  string_heap_start: number;
  string_heap_current: number;
  globals: ArrayBuffer;
  globals_float: Float32Array;
  globals_int: Int32Array;
  entityfields: number;
  edict_size: number;
  _cvars: Cvar[];
  QuakeJS: GameModuleInterface | null;
  opnames: string[];
  trace: boolean;
  argc: number;
  xstatement: number;
  xfunction: ProgsFunctionDefinition;
  capabilities: gameCapabilities[];
  GlobalAtOfs(ofs: number): ProgsDefinition | null;
  FieldAtOfs(ofs: number): ProgsDefinition | null;
  FindField(name: string): ProgsDefinition | null;
  FindGlobal(name: string): ProgsDefinition | null;
  FindFunction(name: string): number;
  ValueString(type: number, val: ArrayBuffer, ofs: number): string;
  Value(type: number, val: ArrayBuffer, ofs: number): ProgsValue;
  UglyValueString(type: number, val: ArrayBuffer, ofs: number): string;
  GlobalString(ofs: number): string;
  GlobalStringNoContents(ofs: number): string;
  LoadProgs(): Promise<ServerGameInterface>;
  Init(): Promise<void>;
  PrintStatement(s: ProgsStatement): void;
  StackTrace(): void;
  Profile_f(): void;
  RunError(error: string): never;
  EnterFunction(f: ProgsFunctionDefinition): number;
  LeaveFunction(): number;
  ExecuteProgram(fnum: number): void;
  GetString(num: number): string;
  _StringLength(ofs: number): number;
  SetString(ofs: number | null, s: string, length?: number | null): number;
  NewString(s: string, length: number): number;
  TempString(string: string): number;
}

const PR = {} as ProgsModule;

export default PR;

let { COM, Con, SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, SV } = getCommonRegistry());
});

PR.saveglobal = (1<<15);

PR.op = PROGS_OP;

PR.version = 6;
PR.max_parms = 8;

PR.globalvars = PROGS_GLOBALVARS;

PR.entvars = {
  modelindex: 0, // float
  absmin: 1, // vec3
  absmin1: 2,
  absmin2: 3,
  absmax: 4, // vec3
  absmax1: 5,
  absmax2: 6,
  ltime: 7, // float
  movetype: 8, // float
  solid: 9, // float
  origin: 10, // vec3
  origin1: 11,
  origin2: 12,
  oldorigin: 13, // vec3
  oldorigin1: 14,
  oldorigin2: 15,
  velocity: 16, // vec3
  velocity1: 17,
  velocity2: 18,
  angles: 19, // vec3
  angles1: 20,
  angles2: 21,
  avelocity: 22, // vec3
  avelocity1: 23,
  avelocity2: 24,
  punchangle: 25, // vec3
  punchangle1: 26,
  punchangle2: 27,
  classname: 28, // string
  model: 29, // string
  frame: 30, // float
  skin: 31, // float
  effects: 32, // float
  mins: 33, // vec3
  mins1: 34,
  mins2: 35,
  maxs: 36, // vec3
  maxs1: 37,
  maxs2: 38,
  size: 39, // vec3
  size1: 40,
  size2: 41,
  touch: 42, // func
  use: 43, // func
  think: 44, // func
  blocked: 45, // func
  nextthink: 46, // float
  groundentity: 47, // edict
  health: 48, // float
  frags: 49, // float
  weapon: 50, // float
  weaponmodel: 51, // string
  weaponframe: 52, // float
  currentammo: 53, // float
  ammo_shells: 54, // float
  ammo_nails: 55, // float
  ammo_rockets: 56, // float
  ammo_cells: 57, // float
  items: 58, // float
  takedamage: 59, // float
  chain: 60, // edict
  deadflag: 61, // float
  view_ofs: 62, // vec3
  view_ofs1: 63,
  view_ofs2: 64,
  button0: 65, // float
  button1: 66, // float
  button2: 67, // float
  impulse: 68, // float
  fixangle: 69, // float
  v_angle: 70, // vec3
  v_angle1: 71,
  v_angle2: 72,
  idealpitch: 73, // float
  netname: 74, // string
  enemy: 75, // edict
  flags: 76, // float
  colormap: 77, // float
  team: 78, // float
  max_health: 79, // float
  teleport_time: 80, // float
  armortype: 81, // float
  armorvalue: 82, // float
  waterlevel: 83, // float
  watertype: 84, // float
  ideal_yaw: 85, // float
  yaw_speed: 86, // float
  aiment: 87, // edict
  goalentity: 88, // edict
  spawnflags: 89, // float
  target: 90, // string
  targetname: 91, // string
  dmg_take: 92, // float
  dmg_save: 93, // float
  dmg_inflictor: 94, // edict
  owner: 95, // edict
  movedir: 96, // vec3
  movedir1: 97,
  movedir2: 98,
  message: 99, // string
  sounds: 100, // float
  noise: 101, // string
  noise1: 102, // string
  noise2: 103, // string
  noise3: 104, // string
};

PR.ofs = ofs;

PR.progheader_crc = 5927;

// classes

/**
 * FIXME: function proxies need to become cached
 */
class ProgsFunctionProxy extends Function {
  static proxyCache: Record<string, ProgsFunctionProxy> = {};

  declare fnc: number;
  declare ent: ProgsEntity | ServerEdict | null;
  declare _signature: string | null;
  declare _settings: FunctionProxySettings;

  constructor(fnc: number, ent: ProgsEntity | ServerEdict | null = null, settings: FunctionProxySettings = {}) {
    super();

    this.fnc = fnc;
    this.ent = ent;
    this._signature = null;
    this._settings = settings;

    const f = PR.functions[this.fnc];
    const name = PR.GetString(f.name);

    Object.defineProperty(this, 'name', {
      value: name,
      writable: false,
    });

    Object.freeze(this);
  }

  toString(): string {
    return `${PR.GetString(PR.functions[this.fnc].name)} (ProgsFunctionProxy(${this.fnc}))`;
  }

  static create(fnc: number, ent: ProgsEntity | ServerEdict | null, settings: FunctionProxySettings = {}): ProgsFunctionProxy {
    const cacheId = `${fnc}-${ent ? ProgsFunctionProxy._getEdictId(ent) : 'null'}`;

    if (ProgsFunctionProxy.proxyCache[cacheId]) {
      return ProgsFunctionProxy.proxyCache[cacheId];
    }

    const obj = new ProgsFunctionProxy(fnc, ent, settings);

    // such an ugly hack to make objects actually callable
    ProgsFunctionProxy.proxyCache[cacheId] = new Proxy(obj, {
      apply(target, thisArg, args) {
        return obj.call.apply(obj, args as [ProgsEntity | ServerEdict | null]);
      },
    });

    return ProgsFunctionProxy.proxyCache[cacheId];
  }

  static _getEdictId(ent: ProgsEntity | ServerEdict | null): number {
    if (!ent) {
      return 0;
    }

    if (ent instanceof ProgsEntity) {
      return ent._edictNum;
    }

    return ent.num;
  }

  /**
   * Calls the proxied QuakeC function.
   * @returns The QuakeC function return value interpreted as a float.
   */
  call(self: ProgsEntity | ServerEdict | null): ProgsValue {
    const old_self = PR.globals_int[PR.globalvars.self];
    const old_other = PR.globals_int[PR.globalvars.other];

    if (this.ent && (!(this.ent instanceof ServerEdict) || !this.ent.isFree())) {
      // in case this is a function bound to an entity, we need to set it to self
      PR.globals_int[PR.globalvars.self] = ProgsFunctionProxy._getEdictId(this.ent);

      // fun little hack, we always assume self being other if this is called on an ent
      PR.globals_int[PR.globalvars.other] = ProgsFunctionProxy._getEdictId(self);
    } else if (self) {
      // in case it’s a global function, we need to set self to the first argument
      PR.globals_int[PR.globalvars.self] = ProgsFunctionProxy._getEdictId(self);
    }

    if (this._settings.resetOther) {
      PR.globals_int[PR.globalvars.other] = 0;
    }

    PR.ExecuteProgram(this.fnc);

    if (this._settings.backupSelfAndOther) {
      PR.globals_int[PR.globalvars.self] = old_self;
      PR.globals_int[PR.globalvars.other] = old_other;
    }

    return PR.Value(etype.ev_float, PR.globals, 1); // assume float
  }
};

// PR._stats = {
//   edict: {},
//   global: {},
// };

class ProgsEntity {
  static SERIALIZATION_TYPE_EDICT = 'E';
  static SERIALIZATION_TYPE_FUNCTION = 'F';
  static SERIALIZATION_TYPE_VECTOR = 'V';
  static SERIALIZATION_TYPE_PRIMITIVE = 'P';

  declare _edictNum: number;
  declare _v: ArrayBuffer | null;
  declare _v_float: Float32Array | null;
  declare _v_int: Int32Array | null;
  declare _serializableFields: string[];

  /**
   * Creates a QuakeC entity view backed by an edict or the globals table.
   */
  constructor(ed: ServerEdict | null) {
    // const stats = ed ? PR._stats.edict : PR._stats.global;
    const defs = ed ? PR.fielddefs : PR.globaldefs;

    this._edictNum = ed ? ed.num : 0;
    this._v = null;
    this._v_float = null;
    this._v_int = null;

    if (ed) {
      this._v = new ArrayBuffer(PR.entityfields * 4);
      this._v_float = new Float32Array(this._v);
      this._v_int = new Int32Array(this._v);
    }

    this._serializableFields = [];

    for (let i = 1; i < defs.length; i++) {
      const d = defs[i];
      const name = PR.GetString(d.name);

      if (name.charCodeAt(name.length - 2) === 95) {
        // skip _x, _y, _z
        continue;
      }

      const [type, val, ofs] = [d.type & ~PR.saveglobal, ed ? this._v : PR.globals, d.ofs];

      if ((type & ~PR.saveglobal) === 0) {
        continue;
      }

      if (!ed && (d.type & ~PR.saveglobal) !== 0 && [etype.ev_string, etype.ev_float, etype.ev_entity].includes(type)) {
        this._serializableFields.push(name);
      } else if (ed) {
        this._serializableFields.push(name);
      }

      const val_float = new Float32Array(val!);
      const val_int = new Int32Array(val!);

      const assignedFunctions = [] as Function[];

      switch (type as etype) {
        case etype.ev_string:
          Object.defineProperty(this, name, {
            get: function() {
              return val_int[ofs] > 0 ? PR.GetString(val_int[ofs]) : null;
            },
            set: function(value) {
              val_int[ofs] = value !== null && value !== '' ? PR.SetString(val_int[ofs], value) : 0;
            },
            configurable: true,
            enumerable: true,
          });
          break;
        case etype.ev_entity: // TODO: actually accept entity instead of edict and vice-versa
          Object.defineProperty(this, name, {
            get: function() {
              if (!SV.server?.edicts || !SV.server.edicts[val_int[ofs]]) {
                return null;
              }

              return SV.server.edicts[val_int[ofs]] || null;
            },
            set: function(value) {
              if (value === null) {
                val_int[ofs] = 0;
                return;
              }
              if (value === 0) { // making fixing stuff easier, though this is a breakpoint trap as well
                val_int[ofs] = 0;
                return;
              }
              if (typeof(value.edictId) !== 'undefined') { // TODO: Entity class
                val_int[ofs] = value.edictId;
                return;
              }
              if (typeof(value._edictNum) !== 'undefined') { // TODO: Edict class
                val_int[ofs] = value.edictId;
                return;
              }
              if (typeof(value.num) !== 'undefined') { // TODO: Edict class
                val_int[ofs] = value.num;
                return;
              }
              throw new TypeError('Expected Edict');
            },
            configurable: true,
            enumerable: true,
          });
          break;
        case etype.ev_function:
          Object.defineProperty(this, name, {
            get: function() {
              const id = val_int[ofs];
              if (id < 0 && assignedFunctions[(-id) - 1] instanceof Function) {
                return assignedFunctions[(-id) - 1];
              }
              return id > 0 ? ProgsFunctionProxy.create(id, ed, {
                // some QuakeC related idiosyncrasis we need to take care of
                backupSelfAndOther: ['touch'].includes(name),
                resetOther: ['StartFrame'].includes(name),
              }) : null;
            },
            set: function(value) {
              if (value === null) {
                val_int[ofs] = 0;
                return;
              }
              if (value instanceof Function) {
                assignedFunctions.push(value);
                val_int[ofs] = -assignedFunctions.length;
                return;
              }
              if (value instanceof ProgsFunctionProxy) {
                val_int[ofs] = value.fnc;
                return;
              }
              if (typeof(value) === 'string') { // this is used by ED.ParseEdict etc. when parsing entities and setting fields
                const d = PR.FindFunction(value);
                if (!d) {
                  throw new TypeError('Invalid function: ' + value);
                }
                val_int[ofs] = d;
                return;
              }
              if (typeof(value.fnc) !== 'undefined') {
                val_int[ofs] = value.fnc;
                return;
              }
              throw new TypeError('EdictProxy.' + name + ': Expected FunctionProxy, function name or function ID');
            },
            configurable: true,
            enumerable: true,
          });
          break;
        case etype.ev_pointer: // unused and irrelevant
          break;
        case etype.ev_field:
          Object.defineProperty(this, name, {
            get: function() {
              return val_int[ofs];
            },
            set: function(value) {
              if (typeof(value.ofs) !== 'undefined') {
                val_int[ofs] = value.ofs;
                return;
              }
              val_int[ofs] = value;
            },
            configurable: true,
            enumerable: true,
          });
          break;
        case etype.ev_float:
          Object.defineProperty(this, name, {
            get: function() {
              return val_float[ofs];
            },
            set: function(value) {
              if (value === undefined || Q.isNaN(value)) {
                throw new TypeError('EdictProxy.' + name + ': invalid value for ev_float passed: ' + value);
              }
              val_float[ofs] = value;
            },
            configurable: true,
            enumerable: true,
          });
          break;
        case etype.ev_vector: // TODO: Proxy for Vector?
          Object.defineProperty(this, name, {
            get: function() {
              return new Vector(val_float[ofs], val_float[ofs + 1], val_float[ofs + 2]);
            },
            set: function(value) {
              val_float[ofs] = value[0];
              val_float[ofs+1] = value[1];
              val_float[ofs+2] = value[2];
            },
            configurable: true,
            enumerable: true,
          });
          break;
      }
    }
  }

  serialize(): ProgsSerializedData {
    const data: ProgsSerializedData = {};
    const entityView = this as ProgsEntityRecord;

    for (const field of this._serializableFields) {
      const value = entityView[field];

      switch (true) {
        case value === null:
          data[field] = [ProgsEntity.SERIALIZATION_TYPE_PRIMITIVE, null];
          break;

        case value instanceof ProgsEntity:
          data[field] = [ProgsEntity.SERIALIZATION_TYPE_EDICT, value._edictNum];
          break;

        case value instanceof ProgsFunctionProxy:
          data[field] = [ProgsEntity.SERIALIZATION_TYPE_FUNCTION, value.fnc];
          break;

        case value instanceof Vector:
          data[field] = [ProgsEntity.SERIALIZATION_TYPE_VECTOR, ...value];
          break;

        case typeof value === 'number':
        case typeof value === 'boolean':
        case typeof value === 'string':
          data[field] = [ProgsEntity.SERIALIZATION_TYPE_PRIMITIVE, value];
          break;
      }
    }

    return data;
  }

  deserialize(obj: ProgsSerializedData): this {
    const entityView = this as ProgsEntityRecord;

    for (const [key, value] of Object.entries(obj)) {
      console.assert(this._serializableFields.includes(key));

      const [type, ...data] = value;

      switch (type) {
        case ProgsEntity.SERIALIZATION_TYPE_EDICT:
          entityView[key] = SV.server.edicts[data[0] as number];
          break;

        case ProgsEntity.SERIALIZATION_TYPE_FUNCTION:
          entityView[key] = { fnc: data[0] };
          break;

        case ProgsEntity.SERIALIZATION_TYPE_VECTOR:
          entityView[key] = new Vector(...data as [number, number, number]);
          break;

        case ProgsEntity.SERIALIZATION_TYPE_PRIMITIVE:
          entityView[key] = data[0];
          break;
      }
    }

    return this;
  }

  clear(): void {
    if (this._v) {
      const int32 = new Int32Array(this._v);
      for (let i = 0; i < PR.entityfields; i++) {
        int32[i] = 0;
      }
    }
  }

  free(): void {
    this.clear();
  }

  equals(other: ProgsEntity | ServerEdict | null): boolean {
    return other !== null && ProgsFunctionProxy._getEdictId(other) === this._edictNum;
  }

  spawn(): void {
    // QuakeC is different, the actual spawn function is called by its classname
    const gameAPI = SV.server.gameAPI as unknown as ProgsGameAPI;
    const entityView = this as ProgsEntityRecord;
    const classname = typeof entityView.classname === 'string' ? entityView.classname : null;
    const spawnFunction = classname !== null ? gameAPI[classname] : null;

    console.assert(typeof spawnFunction === 'function', 'classname spawn function required');

    (spawnFunction as (edict: { num: number }) => void)({ num: this._edictNum });
  }

  get edictId(): number {
    return this._edictNum;
  }
};

/**
 * Retrieves the QuakeC entity view for a live server edict.
 * @returns The QuakeC entity record backing the edict.
 */
function getProgsEntity(edict: ServerEdict): ProgsEntityRecord {
  const entity = edict.entity as unknown as ProgsEntityRecord | null;

  console.assert(entity !== null, 'QuakeC edict must have an entity view');

  return entity!;
}

// edict

/**
 * Retrieves the global definition at the specified offset.
 * @returns The matching global definition, or null when none exists.
 */
PR.GlobalAtOfs = function(ofs) {
  return PR.globaldefs.find((def) => def.ofs === ofs) || null;
};

/**
 * Retrieves the field definition at the specified offset.
 * @returns The matching field definition, or null when none exists.
 */
PR.FieldAtOfs = function(ofs) {
  return PR.fielddefs.find((def) => def.ofs === ofs) || null;
};

/**
 * Finds a field definition by name.
 * @returns The matching field definition, or null when none exists.
 */
PR.FindField = function(name) {
  return PR.fielddefs.find((def) => PR.GetString(def.name) === name) || null;
};

/**
 * Finds a global definition by name.
 * @returns The matching global definition, or null when none exists.
 */
PR.FindGlobal = function(name) {
  return PR.globaldefs.find((def) => PR.GetString(def.name) === name) || null;
};

/**
 * Finds a function definition by name.
 * @returns The function index, or `-1` when the function cannot be found.
 */
PR.FindFunction = function(name) {
  return PR.functions.findIndex((func) => PR.GetString(func.name) === name);
};

PR.ValueString = function(type, val, ofs) {
  const val_float = new Float32Array(val);
  const val_int = new Int32Array(val);
  type &= ~PR.saveglobal;
  switch (type as etype) {
    case etype.ev_string:
      return PR.GetString(val_int[ofs]);
    case etype.ev_entity:
      return 'entity ' + val_int[ofs];
    case etype.ev_function:
      return PR.GetString(PR.functions[val_int[ofs]].name) + '()';
    case etype.ev_field: {
        const def = PR.FieldAtOfs(val_int[ofs]);
        if (def !== null) {
          return '.' + PR.GetString(def.name);
        }
        return '.';
      }
    case etype.ev_void:
      return 'void';
    case etype.ev_float:
      return val_float[ofs].toFixed(1);
    case etype.ev_vector:
      return '\'' + val_float[ofs].toFixed(1) +
              ' ' + val_float[ofs + 1].toFixed(1) +
              ' ' + val_float[ofs + 2].toFixed(1) + '\'';
    case etype.ev_pointer:
      return 'pointer';
  }
  return 'bad type ' + type;
};

PR.Value = function(type, val, ofs) {
  const val_float = new Float32Array(val);
  const val_int = new Int32Array(val);
  type &= ~PR.saveglobal;
  switch (type as etype) {
    case etype.ev_string:
      return PR.GetString(val_int[ofs]);
    case etype.ev_pointer:
    case etype.ev_entity:
    case etype.ev_field:
      return val_int[ofs];
      // case etype.ev_field: {
      //     const def = PR.FieldAtOfs(val_int[ofs]);
      //     if (def != null) {
      //       return '.' + PR.GetString(def.name);
      //     }
      //     return '.';
      //   }
    case etype.ev_function:
      return PR.GetString(PR.functions[val_int[ofs]].name) + '()';
    case etype.ev_void:
      return null;
    case etype.ev_float:
      return val_float[ofs];
    case etype.ev_vector:
      return [val_float[ofs],
              val_float[ofs + 1],
              val_float[ofs + 2]];
  }
  throw new TypeError('bad PR etype ' + type);
};

PR.UglyValueString = function(type, val, ofs) {
  const val_float = new Float32Array(val);
  const val_int = new Int32Array(val);
  type &= ~PR.saveglobal;
  switch (type as etype) {
    case etype.ev_string:
      return PR.GetString(val_int[ofs]);
    case etype.ev_entity:
      return val_int[ofs].toString();
    case etype.ev_function:
      return PR.GetString(PR.functions[val_int[ofs]].name);
    case etype.ev_field: {
        const def = PR.FieldAtOfs(val_int[ofs]);
        if (def !== null) {
          return PR.GetString(def.name);
        }
        return '';
      }
    case etype.ev_void:
      return 'void';
    case etype.ev_float:
      return val_float[ofs].toFixed(6);
    case etype.ev_vector:
      return val_float[ofs].toFixed(6) +
    ' ' + val_float[ofs + 1].toFixed(6) +
    ' ' + val_float[ofs + 2].toFixed(6);
  }
  return 'bad type ' + type;
};

PR.GlobalString = function(ofs) {
  const def = PR.GlobalAtOfs(ofs); let line;
  if (def !== null) {
    line = ofs + '(' + PR.GetString(def.name) + ')' + PR.ValueString(def.type, PR.globals, ofs);
  } else {
    line = ofs + '(???)';
  }
  for (; line.length <= 20; ) {
    line += ' ';
  }
  return line;
};

PR.GlobalStringNoContents = function(ofs) {
  const def = PR.GlobalAtOfs(ofs); let line;
  if (def !== null) {
    line = ofs + '(' + PR.GetString(def.name) + ')';
  } else {
    line = ofs + '(???)';
  }
  for (; line.length <= 20; ) {
    line += ' ';
  }
  return line;
};

PR.LoadProgs = async function() {
  const progs = await COM.LoadFile('progs.dat');
  if (progs === null) {
    throw new MissingResourceError('progs.dat');
  }
  Con.DPrint('Programs occupy ' + (progs.byteLength >> 10) + 'K.\n');
  const view = new DataView(progs);

  let i = view.getUint32(0, true);
  if (i !== PR.version) {
    throw new Error('progs.dat has wrong version number (' + i + ' should be ' + PR.version + ')');
  }

  if (view.getUint32(4, true) !== PR.progheader_crc) {
    throw new Error('progs.dat system vars have been modified, PR.js is out of date');
  }

  PR.crc = CRC16CCITT.Block(new Uint8Array(progs));

  PR.stack = [];
  PR.depth = 0;

  PR.localstack = [];
  for (i = 0; i < PR.localstack_size; i++) {
    PR.localstack[i] = 0;
  }
  PR.localstack_used = 0;

  let ofs; let num;

  ofs = view.getUint32(8, true);
  num = view.getUint32(12, true);
  PR.statements = [];
  for (i = 0; i < num; i++) {
    PR.statements[i] = {
      op: view.getUint16(ofs, true),
      a: view.getInt16(ofs + 2, true),
      b: view.getInt16(ofs + 4, true),
      c: view.getInt16(ofs + 6, true),
    };
    ofs += 8;
  }

  ofs = view.getUint32(16, true);
  num = view.getUint32(20, true);
  PR.globaldefs = [];
  for (i = 0; i < num; i++) {
    PR.globaldefs[i] = {
      type: view.getUint16(ofs, true),
      ofs: view.getUint16(ofs + 2, true),
      name: view.getUint32(ofs + 4, true),
    };
    ofs += 8;
  }

  ofs = view.getUint32(24, true);
  num = view.getUint32(28, true);
  PR.fielddefs = [];
  for (i = 0; i < num; i++) {
    PR.fielddefs[i] = {
      type: view.getUint16(ofs, true),
      ofs: view.getUint16(ofs + 2, true),
      name: view.getUint32(ofs + 4, true),
    };
    ofs += 8;
  }

  ofs = view.getUint32(32, true);
  num = view.getUint32(36, true);
  PR.functions = [];
  for (i = 0; i < num; i++) {
    PR.functions[i] = {
      first_statement: view.getInt32(ofs, true),
      parm_start: view.getUint32(ofs + 4, true),
      locals: view.getUint32(ofs + 8, true),
      profile: view.getUint32(ofs + 12, true),
      name: view.getUint32(ofs + 16, true),
      file: view.getUint32(ofs + 20, true),
      numparms: view.getUint32(ofs + 24, true),
      parm_size: [
        view.getUint8(ofs + 28), view.getUint8(ofs + 29),
        view.getUint8(ofs + 30), view.getUint8(ofs + 31),
        view.getUint8(ofs + 32), view.getUint8(ofs + 33),
        view.getUint8(ofs + 34), view.getUint8(ofs + 35),
      ],
    };
    ofs += 36;
  }

  ofs = view.getUint32(40, true);
  num = view.getUint32(44, true);
  PR.strings = [];
  for (i = 0; i < num; i++) {
    PR.strings[i] = view.getUint8(ofs + i);
  }
  PR.string_temp = PR.NewString('', 1024); // allocates 1024 bytes for temp strings
  PR.string_heap_start = PR.strings.length + 4;
  PR.string_heap_current = PR.string_heap_start;

  ofs = view.getUint32(48, true);
  num = view.getUint32(52, true);
  PR.globals = new ArrayBuffer(num << 2);
  PR.globals_float = new Float32Array(PR.globals);
  PR.globals_int = new Int32Array(PR.globals);
  for (i = 0; i < num; i++) {
    PR.globals_int[i] = view.getInt32(ofs + (i << 2), true);
  }

  PR.entityfields = view.getUint32(56, true);
  PR.edict_size = 96 + (PR.entityfields << 2);

  const fields = [
    'ammo_shells1',
    'ammo_nails1',
    'ammo_lava_nails',
    'ammo_rockets1',
    'ammo_multi_rockets',
    'ammo_cells1',
    'ammo_plasma',
    'gravity',
    'items2',
  ];
  for (i = 0; i < fields.length; i++) {
    const field = fields[i];
    const def = PR.FindField(field);
    PR.entvars[field] = (def !== null) ? def.ofs : null;
  }
  ProgsFunctionProxy.proxyCache = {}; // free all cached functions
  // hook up progs.dat with our proxies

  const progsAPI = new ProgsEntity(null);

  const deathmatch = Cvar.FindVar('deathmatch')!;
  const skill = Cvar.FindVar('skill')!;
  const coop = Cvar.FindVar('coop')!;

  console.assert(deathmatch instanceof Cvar, 'deathmatch cvar not found');
  console.assert(skill instanceof Cvar, 'skill cvar not found');
  console.assert(coop instanceof Cvar, 'coop cvar not found');

  const gameAPI = Object.assign(progsAPI, {
    prepareEntity(edict: ServerEdict, classname: string | null, initialData: EdictData = {}): boolean {
      if (!edict.entity) { // do not use isFree(), check for unset entity property
        edict.entity = new ProgsEntity(edict) as unknown as BaseEntity;
        Object.freeze(edict.entity);
      }

      const preparedEntity = getProgsEntity(edict);

      // yet another hack, always be successful during a loadgame
      if (SV.server.loadgame) {
        return true;
      }

      // special case for QuakeC: empty entity
      if (classname === null) {
        return true;
      }

      // another special case for QuakeC: player has no spawn function
      if (classname === 'player') {
        return true;
      }

      if (typeof (SV.server.gameAPI as unknown as ProgsGameAPI)[classname] !== 'function') {
        Con.PrintWarning(`No spawn function for edict ${edict.num}: ${classname}\n`);
        // debugger;
        return false;
      }

      preparedEntity.classname = classname;

      for (const [key, value] of Object.entries(initialData)) {
        const field = PR.FindField(key);

        if (!field) {
          Con.PrintWarning(`'${key}' is not a field\n`);
          continue;
        }

        switch ((field.type & 0x7fff) as etype) {
          case etype.ev_entity:
            if (value === null || typeof value === 'object') {
              preparedEntity[key] = value;
            } else {
              preparedEntity[key] = { num: Q.atoi(String(value)) };
            }
            break;

          case etype.ev_vector:
            if (value instanceof Vector) {
              preparedEntity[key] = value;
            } else {
              // eslint-disable-next-line @typescript-eslint/no-base-to-string
              preparedEntity[key] = new Vector(...String(value).split(' ').map((x) => Q.atof(x)));
            }
            break;

          case etype.ev_field: {
            if (typeof value !== 'string') {
              throw new TypeError(`Expected field name string for ${key}`);
            }

            const d = PR.FindField(value);
            if (!d) {
              Con.PrintWarning(`Can't find field: ${value}\n`);
              break;
            }
            preparedEntity[key] = d;
            break;
          }

          case etype.ev_function: {
            if (typeof value === 'string') {
              preparedEntity[key] = value;
            } else if (typeof value === 'number') {
              preparedEntity[key] = { fnc: value };
            } else {
              throw new TypeError(`Expected function name or function id for ${key}`);
            }
            break;
          }

          default:
            preparedEntity[key] = value;
        }
      }

      // these are quake specific things happening during loading

      const spawnflags = typeof preparedEntity.spawnflags === 'number' ? preparedEntity.spawnflags : 0;

      if (deathmatch!.value !== 0 && (spawnflags & 2048)) {
        return false;
      }

      const skillFlags = [256, 512, 1024, 1024];

      if (spawnflags & skillFlags[Math.max(0, Math.min(skillFlags.length, skill!.value))]) {
        return false;
      }

      return true;
    },

    spawnPreparedEntity(edict: ServerEdict): boolean {
      if (!edict.entity) {
        Con.PrintError('PR.LoadProgs.spawnPreparedEntity: no entity class instance set!\n');
        return false;
      }

      // another special case for QuakeC: player has no spawn function
      if (edict.entity.classname === 'player') {
        return true;
      }

      edict.entity.spawn();

      return true;
    },

    init(mapname: string, serverflags: number): void {
      gameAPI.mapname = mapname;
      gameAPI.serverflags = serverflags;

      // coop automatically disables deathmatch
      if (coop!.value) {
        coop.set(true);
        deathmatch.set(false);
      }

      // make sure skill is in range
      skill.set(Math.max(0, Math.min(3, Math.floor(skill.value))));

      gameAPI.coop = coop.value;
      gameAPI.deathmatch = deathmatch.value;
    },


    shutdown(_isCrashShutdown: boolean): void {
    },

    startFrame(): void {
      // pass to the VM
      // @ts-ignore
      progsAPI.StartFrame(null);
    },
  }) as ProgsEntityRecord & ProgsGameAPI;

  Object.freeze(gameAPI);

  return gameAPI;
};

PR._cvars = [];

PR.QuakeJS = null;

PR.Init = async function() {
  try {
    if (COM.CheckParm('-noquakejs')) {
      Con.PrintWarning('PR.Init: QuakeJS disabled by request\n');
      PR.QuakeJS = null;
    } else {
      // try to get the game API
      PR.QuakeJS = await loadGameModule(COM.gamedir![0].filename);
      PR.QuakeJS.ServerGameAPI.Init(ServerEngineAPI);

      const identification = PR.QuakeJS.identification;
      Con.Print(`PR.Init: ${identification.name} v${identification.version.join('.')} by ${identification.author} loaded.\n`);
    return;
    }
  } catch (e) {
    const errorCode = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
      ? e.code
      : null;

    if (errorCode !== null && errorCode !== 'ERR_MODULE_NOT_FOUND') { // only catch module not found errors
      throw e;
    }

    // CR: stupidest error convention ever, check https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import#return_value
    const errorMessage = e instanceof Error ? e.message : String(e);
    Con.PrintWarning('PR.Init: Falling back to QuakeC, failed to initialize QuakeJS server code: ' + errorMessage + '.\n');

    PR.QuakeJS = null;
  }

  // CR: we do not need any of this when running QuakeJS
  Cmd.AddCommand('edict', ED.PrintEdict_f);
  Cmd.AddCommand('edicts', ED.PrintEdicts);
  Cmd.AddCommand('edictcount', ED.Count);
  Cmd.AddCommand('profile', PR.Profile_f);
  PR._cvars.push(new Cvar('gamecfg', '0'));
  PR._cvars.push(new Cvar('scratch1', '0'));
  PR._cvars.push(new Cvar('scratch2', '0'));
  PR._cvars.push(new Cvar('scratch3', '0'));
  PR._cvars.push(new Cvar('scratch4', '0'));
  PR._cvars.push(new Cvar('savedgamecfg', '0', Cvar.FLAG.ARCHIVE));
  PR._cvars.push(new Cvar('saved1', '0', Cvar.FLAG.ARCHIVE));
  PR._cvars.push(new Cvar('saved2', '0', Cvar.FLAG.ARCHIVE));
  PR._cvars.push(new Cvar('saved3', '0', Cvar.FLAG.ARCHIVE));
  PR._cvars.push(new Cvar('saved4', '0', Cvar.FLAG.ARCHIVE));

  PR._cvars.push(new Cvar('nomonsters', '0', Cvar.FLAG.SERVER));
  PR._cvars.push(new Cvar('fraglimit', '0', Cvar.FLAG.SERVER));
  PR._cvars.push(new Cvar('timelimit', '0', Cvar.FLAG.SERVER));
  PR._cvars.push(new Cvar('samelevel', '0', Cvar.FLAG.SERVER, 'Set to 1 to stay on the same map even the map is over'));
  PR._cvars.push(new Cvar('noexit', '0', Cvar.FLAG.SERVER));
  PR._cvars.push(new Cvar('skill', '1', Cvar.FLAG.SERVER));
  PR._cvars.push(new Cvar('deathmatch', '0', Cvar.FLAG.SERVER));
  PR._cvars.push(new Cvar('coop', '0', Cvar.FLAG.SERVER));
};

// exec

PR.localstack_size = 2048;

PR.opnames = [
  'DONE',
  'MUL_F', 'MUL_V', 'MUL_FV', 'MUL_VF',
  'DIV',
  'ADD_F', 'ADD_V',
  'SUB_F', 'SUB_V',
  'EQ_F', 'EQ_V', 'EQ_S', 'EQ_E', 'EQ_FNC',
  'NE_F', 'NE_V', 'NE_S', 'NE_E', 'NE_FNC',
  'LE', 'GE', 'LT', 'GT',
  'INDIRECT', 'INDIRECT', 'INDIRECT', 'INDIRECT', 'INDIRECT', 'INDIRECT',
  'ADDRESS',
  'STORE_F', 'STORE_V', 'STORE_S', 'STORE_ENT', 'STORE_FLD', 'STORE_FNC',
  'STOREP_F', 'STOREP_V', 'STOREP_S', 'STOREP_ENT', 'STOREP_FLD', 'STOREP_FNC',
  'RETURN',
  'NOT_F', 'NOT_V', 'NOT_S', 'NOT_ENT', 'NOT_FNC',
  'IF', 'IFNOT',
  'CALL0', 'CALL1', 'CALL2', 'CALL3', 'CALL4', 'CALL5', 'CALL6', 'CALL7', 'CALL8',
  'STATE',
  'GOTO',
  'AND', 'OR',
  'BITAND', 'BITOR',
];

// PR.executions = [];

PR.PrintStatement = function(s) {
  let text;
  if (s.op < PR.opnames.length) {
    text = PR.opnames[s.op] + ' ';
    for (; text.length <= 9; ) {
      text += ' ';
    }
  } else {
    text = '';
  }
  if (s.op === PR.op.jnz || s.op === PR.op.jz) {
    text += PR.GlobalString(s.a) + 'branch ' + s.b;
  } else if (s.op === PR.op.jump) {
    text += 'branch ' + s.a;
  } else if (s.op >= PR.op.store_f && s.op <= PR.op.store_fnc) {
    text += PR.GlobalString(s.a) + PR.GlobalStringNoContents(s.b);
  } else {
    if (s.a !== 0) {
      text += PR.GlobalString(s.a);
    }
    if (s.b !== 0) {
      text += PR.GlobalString(s.b);
    }
    if (s.c !== 0) {
      text += PR.GlobalStringNoContents(s.c);
    }
  }
  Con.Print(text + '\n');
  // if (PR.executions.length > 50) {
  //   PR.executions.shift();
  // }
  // PR.executions.push(text);
};

PR.StackTrace = function() {
  if (PR.depth === 0) {
    Con.Print('<NO STACK>\n');
    return;
  }
  PR.stack[PR.depth] = [PR.xstatement, PR.xfunction];
  let f; let file;
  for (; PR.depth >= 0; PR.depth--) {
    f = PR.stack[PR.depth][1];
    if (!f) {
      Con.Print('<NO FUNCTION>\n');
      continue;
    }
    file = PR.GetString(f.file);
    for (; file.length <= 11; ) {
      file += ' ';
    }
    Con.Print(file + ' : ' + PR.GetString(f.name) + '\n');
  }
  PR.depth = 0;
};

PR.Profile_f = function() {
  if (!SV.server.active) {
    return;
  }
  let num = 0; let max; let best; let i; let f; let profile;
  while (true) {
    max = 0;
    best = null;
    for (i = 0; i < PR.functions.length; i++) {
      f = PR.functions[i];
      if (f.profile > max) {
        max = f.profile;
        best = f;
      }
    }
    if (best === null) {
      return;
    }
    if (num < 10) {
      profile = best.profile.toString();
      for (; profile.length <= 6; ) {
        profile = ' ' + profile;
      }
      Con.Print(profile + ' ' + PR.GetString(best.name) + '\n');
    }
    num++;
    best.profile = 0;
  }
};

PR.RunError = function(error) {
  PR.PrintStatement(PR.statements[PR.xstatement]);
  PR.StackTrace();
  Con.PrintError(error + '\n');
  throw new HostError('Program error');
};

PR.EnterFunction = function(f) {
  PR.stack[PR.depth++] = [PR.xstatement, PR.xfunction];
  const c = f.locals;
  if ((PR.localstack_used + c) > PR.localstack_size) {
    PR.RunError('PR.EnterFunction: locals stack overflow\n');
  }
  let i;
  for (i = 0; i < c; i++) {
    PR.localstack[PR.localstack_used + i] = PR.globals_int[f.parm_start + i];
  }
  PR.localstack_used += c;
  let o = f.parm_start; let j;
  for (i = 0; i < f.numparms; i++) {
    for (j = 0; j < f.parm_size[i]; j++) {
      PR.globals_int[o++] = PR.globals_int[4 + i * 3 + j];
    }
  }
  PR.xfunction = f;
  return f.first_statement - 1;
};

PR.LeaveFunction = function() {
  if (PR.depth <= 0) {
    throw new Error('prog stack underflow');
  }
  let c = PR.xfunction.locals;
  PR.localstack_used -= c;
  if (PR.localstack_used < 0) {
    PR.RunError('PR.LeaveFunction: locals stack underflow\n');
  }
  for (--c; c >= 0; --c) {
    PR.globals_int[PR.xfunction.parm_start + c] = PR.localstack[PR.localstack_used + c];
  }
  PR.xfunction = PR.stack[--PR.depth][1]!;
  return PR.stack[PR.depth][0];
};

PR.ExecuteProgram = function(fnum) {
  if (fnum === 0 || fnum >= PR.functions.length) {
    if (PR.globals_int[PR.globalvars.self] !== 0) {
      ED.Print(SV.server.edicts[PR.globals_int[PR.globalvars.self]]);
    }
    throw new HostError('PR.ExecuteProgram: NULL function');
  }
  let runaway = 100000;
  const exitdepth = PR.depth;
  let s = PR.EnterFunction(PR.functions[fnum]);
  let st; let ed; let ptr; let newf;

  while (true) {
    s++;
    st = PR.statements[s];
    if (--runaway === 0) {
      PR.RunError('runaway loop error');
    }
    PR.xfunction.profile++;
    PR.xstatement = s;
    if (PR.trace) {
      PR.PrintStatement(st);
    }
    switch (st.op) {
      case PR.op.add_f:
        PR.globals_float[st.c] = PR.globals_float[st.a] + PR.globals_float[st.b];
        continue;
      case PR.op.add_v:
        PR.globals_float[st.c] = PR.globals_float[st.a] + PR.globals_float[st.b];
        PR.globals_float[st.c + 1] = PR.globals_float[st.a + 1] + PR.globals_float[st.b + 1];
        PR.globals_float[st.c + 2] = PR.globals_float[st.a + 2] + PR.globals_float[st.b + 2];
        continue;
      case PR.op.sub_f:
        PR.globals_float[st.c] = PR.globals_float[st.a] - PR.globals_float[st.b];
        continue;
      case PR.op.sub_v:
        PR.globals_float[st.c] = PR.globals_float[st.a] - PR.globals_float[st.b];
        PR.globals_float[st.c + 1] = PR.globals_float[st.a + 1] - PR.globals_float[st.b + 1];
        PR.globals_float[st.c + 2] = PR.globals_float[st.a + 2] - PR.globals_float[st.b + 2];
        continue;
      case PR.op.mul_f:
        PR.globals_float[st.c] = PR.globals_float[st.a] * PR.globals_float[st.b];
        continue;
      case PR.op.mul_v:
        PR.globals_float[st.c] = PR.globals_float[st.a] * PR.globals_float[st.b] +
        PR.globals_float[st.a + 1] * PR.globals_float[st.b + 1] +
        PR.globals_float[st.a + 2] * PR.globals_float[st.b + 2];
        continue;
      case PR.op.mul_fv:
        PR.globals_float[st.c] = PR.globals_float[st.a] * PR.globals_float[st.b];
        PR.globals_float[st.c + 1] = PR.globals_float[st.a] * PR.globals_float[st.b + 1];
        PR.globals_float[st.c + 2] = PR.globals_float[st.a] * PR.globals_float[st.b + 2];
        continue;
      case PR.op.mul_vf:
        PR.globals_float[st.c] = PR.globals_float[st.b] * PR.globals_float[st.a];
        PR.globals_float[st.c + 1] = PR.globals_float[st.b] * PR.globals_float[st.a + 1];
        PR.globals_float[st.c + 2] = PR.globals_float[st.b] * PR.globals_float[st.a + 2];
        continue;
      case PR.op.div_f:
        PR.globals_float[st.c] = PR.globals_float[st.a] / PR.globals_float[st.b];
        continue;
      case PR.op.bitand:
        PR.globals_float[st.c] = PR.globals_float[st.a] & PR.globals_float[st.b];
        continue;
      case PR.op.bitor:
        PR.globals_float[st.c] = PR.globals_float[st.a] | PR.globals_float[st.b];
        continue;
      case PR.op.ge:
        PR.globals_float[st.c] = (PR.globals_float[st.a] >= PR.globals_float[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.le:
        PR.globals_float[st.c] = (PR.globals_float[st.a] <= PR.globals_float[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.gt:
        PR.globals_float[st.c] = (PR.globals_float[st.a] > PR.globals_float[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.lt:
        PR.globals_float[st.c] = (PR.globals_float[st.a] < PR.globals_float[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.and:
        PR.globals_float[st.c] = (PR.globals_float[st.a] !== 0.0 && PR.globals_float[st.b] !== 0.0) ? 1.0 : 0.0;
        continue;
      case PR.op.or:
        PR.globals_float[st.c] = (PR.globals_float[st.a] !== 0.0 || PR.globals_float[st.b] !== 0.0) ? 1.0 : 0.0;
        continue;
      case PR.op.not_f:
        PR.globals_float[st.c] = (PR.globals_float[st.a] === 0.0) ? 1.0 : 0.0;
        continue;
      case PR.op.not_v:
        PR.globals_float[st.c] = ((PR.globals_float[st.a] === 0.0) &&
        (PR.globals_float[st.a + 1] === 0.0) &&
        (PR.globals_float[st.a + 2] === 0.0)) ? 1.0 : 0.0;
        continue;
      case PR.op.not_s:
        if (PR.globals_int[st.a] !== 0) {
          PR.globals_float[st.c] = (PR.strings[PR.globals_int[st.a]] === 0) ? 1.0 : 0.0;
        } else {
          PR.globals_float[st.c] = 1.0;
        }
        continue;
      case PR.op.not_fnc:
      case PR.op.not_ent:
        PR.globals_float[st.c] = (PR.globals_int[st.a] === 0) ? 1.0 : 0.0;
        continue;
      case PR.op.eq_f:
        PR.globals_float[st.c] = (PR.globals_float[st.a] === PR.globals_float[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.eq_v:
        PR.globals_float[st.c] = ((PR.globals_float[st.a] === PR.globals_float[st.b]) &&
        (PR.globals_float[st.a + 1] === PR.globals_float[st.b + 1]) &&
        (PR.globals_float[st.a + 2] === PR.globals_float[st.b + 2])) ? 1.0 : 0.0;
        continue;
      case PR.op.eq_s:
        PR.globals_float[st.c] = (PR.GetString(PR.globals_int[st.a]) === PR.GetString(PR.globals_int[st.b])) ? 1.0 : 0.0;
        continue;
      case PR.op.eq_e:
      case PR.op.eq_fnc:
        PR.globals_float[st.c] = (PR.globals_int[st.a] === PR.globals_int[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.ne_f:
        PR.globals_float[st.c] = (PR.globals_float[st.a] !== PR.globals_float[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.ne_v:
        PR.globals_float[st.c] = ((PR.globals_float[st.a] !== PR.globals_float[st.b]) ||
        (PR.globals_float[st.a + 1] !== PR.globals_float[st.b + 1]) ||
        (PR.globals_float[st.a + 2] !== PR.globals_float[st.b + 2])) ? 1.0 : 0.0;
        continue;
      case PR.op.ne_s:
        PR.globals_float[st.c] = (PR.GetString(PR.globals_int[st.a]) !== PR.GetString(PR.globals_int[st.b])) ? 1.0 : 0.0;
        continue;
      case PR.op.ne_e:
      case PR.op.ne_fnc:
        PR.globals_float[st.c] = (PR.globals_int[st.a] !== PR.globals_int[st.b]) ? 1.0 : 0.0;
        continue;
      case PR.op.store_f:
      case PR.op.store_ent:
      case PR.op.store_fld:
      case PR.op.store_s:
      case PR.op.store_fnc:
        PR.globals_int[st.b] = PR.globals_int[st.a];
        continue;
      case PR.op.store_v:
        PR.globals_int[st.b] = PR.globals_int[st.a];
        PR.globals_int[st.b + 1] = PR.globals_int[st.a + 1];
        PR.globals_int[st.b + 2] = PR.globals_int[st.a + 2];
        continue;
      case PR.op.storep_f:
      case PR.op.storep_ent:
      case PR.op.storep_fld:
      case PR.op.storep_s:
      case PR.op.storep_fnc:
        ptr = PR.globals_int[st.b];
        getProgsEntity(SV.server.edicts[Math.floor(ptr / PR.edict_size)])._v_int![((ptr % PR.edict_size) - 96) >> 2] = PR.globals_int[st.a];
        continue;
      case PR.op.storep_v:
        ed = SV.server.edicts[Math.floor(PR.globals_int[st.b] / PR.edict_size)];
        ptr = ((PR.globals_int[st.b] % PR.edict_size) - 96) >> 2;
        getProgsEntity(ed)._v_int![ptr] = PR.globals_int[st.a];
        getProgsEntity(ed)._v_int![ptr + 1] = PR.globals_int[st.a + 1];
        getProgsEntity(ed)._v_int![ptr + 2] = PR.globals_int[st.a + 2];
        continue;
      case PR.op.address:
        ed = PR.globals_int[st.a];
        if (ed === 0 && !SV.server.loading) {
          PR.RunError('assignment to world entity');
        }
        PR.globals_int[st.c] = ed * PR.edict_size + 96 + (PR.globals_int[st.b] << 2);
        continue;
      case PR.op.load_f:
      case PR.op.load_fld:
      case PR.op.load_ent:
      case PR.op.load_s:
      case PR.op.load_fnc:
        PR.globals_int[st.c] = getProgsEntity(SV.server.edicts[PR.globals_int[st.a]])._v_int![PR.globals_int[st.b]];
        continue;
      case PR.op.load_v:
        ed = SV.server.edicts[PR.globals_int[st.a]];
        ptr = PR.globals_int[st.b];
        PR.globals_int[st.c] = getProgsEntity(ed)._v_int![ptr];
        PR.globals_int[st.c + 1] = getProgsEntity(ed)._v_int![ptr + 1];
        PR.globals_int[st.c + 2] = getProgsEntity(ed)._v_int![ptr + 2];
        continue;
      case PR.op.jz:
        if (PR.globals_int[st.a] === 0) {
          s += st.b - 1;
        }
        continue;
      case PR.op.jnz:
        if (PR.globals_int[st.a] !== 0) {
          s += st.b - 1;
        }
        continue;
      case PR.op.jump:
        s += st.a - 1;
        continue;
      case PR.op.call0:
      case PR.op.call1:
      case PR.op.call2:
      case PR.op.call3:
      case PR.op.call4:
      case PR.op.call5:
      case PR.op.call6:
      case PR.op.call7:
      case PR.op.call8:
        PR.argc = st.op - PR.op.call0;
        if (PR.globals_int[st.a] === 0) {
          PR.RunError('NULL function');
        }
        if (PR.globals_int[st.a] < 0) {
          console.debug('special function called');
          continue;
        }
        newf = PR.functions[PR.globals_int[st.a]];
        if (newf.first_statement < 0) {
          ptr = -newf.first_statement;
          if (ptr >= PF.builtin.length) {
            PR.RunError('Bad builtin call number');
          }
          // PF.builtin[ptr];
          // try {
            PF.builtin[ptr]();
          // } catch (e) {
          //   PR.RunError(e.message);
          //   throw e;
          // }
          continue;
        }
        s = PR.EnterFunction(newf);
        continue;
      case PR.op.done:
      case PR.op.ret:
        PR.globals_int[PR.ofs.OFS_RETURN] = PR.globals_int[st.a];
        PR.globals_int[PR.ofs.OFS_RETURN + 1] = PR.globals_int[st.a + 1];
        PR.globals_int[PR.ofs.OFS_RETURN + 2] = PR.globals_int[st.a + 2];
        s = PR.LeaveFunction();
        if (PR.depth === exitdepth) {
          return;
        }
        continue;
      case PR.op.state:
        ed = SV.server.edicts[PR.globals_int[PR.globalvars.self]];
        getProgsEntity(ed)._v_float![PR.entvars.nextthink!] = PR.globals_float[PR.globalvars.time] + 0.1;
        getProgsEntity(ed)._v_float![PR.entvars.frame!] = PR.globals_float[st.a];
        getProgsEntity(ed)._v_int![PR.entvars.think!] = PR.globals_int[st.b];
        continue;
    }
    PR.RunError('Bad opcode ' + st.op);
  }
};

PR.GetString = function(num) {
  let string = '';
  for (; num < PR.strings.length; num++) {
    if (PR.strings[num] === 0) {
      break;
    }
    string += String.fromCharCode(PR.strings[num]);
  }
  return string;
};

PR._StringLength = function(ofs) {
  let len = 0;

  while(PR.strings[ofs+len]) {
    len++;
  }

  return len;
};

PR.SetString = function(ofs, s, length = null) {
  // shortcut: empty strings are located at 0x0000
  if (s === '') {
    return 0;
  }

  const size = (length !== null ? Math.max(s.length, length || 0) : s.length) + 1;

  // check if it’s going to overwrite a constant (ofs < PR.string_heap_start)
  // check if we can overwrite in place (s.length < &PR.strings[ofs].length)
  if (ofs === null || ofs < PR.string_heap_start || PR._StringLength(ofs) <= size) {
    ofs = PR.string_heap_current;
    PR.string_heap_current += size;
  }

  // overwrite found spot with s
  for (let i = 0; i < s.length; i++) {
    PR.strings[ofs + i] = s.charCodeAt(i);
  }

  // add 0-byte string terminator
  PR.strings[ofs + s.length] = 0;

  return ofs;
};

/**
 * Allocates a new string in the VM string heap.
 * @returns The offset of the allocated string.
 */
PR.NewString = function(s, length) {
  const ofs = PR.strings.length;
  let i;
  if (s.length >= length) {
    for (i = 0; i < (length - 1); i++) {
      PR.strings[PR.strings.length] = s.charCodeAt(i);
    }
    PR.strings[PR.strings.length] = 0;
    return ofs;
  }
  for (i = 0; i < s.length; i++) {
    PR.strings[PR.strings.length] = s.charCodeAt(i);
  }
  length -= s.length;
  for (i = 0; i < length; i++) {
    PR.strings[PR.strings.length] = 0;
  }
  return ofs;
};

PR.TempString = function(string) {
  if (string.length > 1023) {
    string = string.substring(0, 1023);
  }
  for (let i = 0; i < string.length; i++) {
    PR.strings[PR.string_temp + i] = string.charCodeAt(i);
  }
  PR.strings[PR.string_temp + string.length] = 0;

  return PR.string_temp;
};

PR.capabilities = [
  gameCapabilities.CAP_CLIENTDATA_UPDATESTAT,
  gameCapabilities.CAP_CLIENTDATA_LEGACY,
  gameCapabilities.CAP_SPAWNPARMS_LEGACY,
  gameCapabilities.CAP_ENTITY_BBOX_ADJUSTMENTS_DURING_LINK,
];
