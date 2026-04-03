import type { SzBuffer } from '../network/MSG.ts';

import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.ts';
import { HostError } from '../common/Errors.ts';
import { ServerEngineAPI } from '../common/GameAPIs.ts';
import { eventBus, getCommonRegistry, registry } from '../registry.mjs';
import { ED, ServerEdict } from './Edict.mjs';

type BuiltinValue = string | number | boolean | Vector | ServerEdict | null;
type BuiltinImplementation = (...args: BuiltinValue[]) => BuiltinValue | void;
type BuiltinFunction = () => void;

interface GeneratedAssert {
  readonly check: string;
  readonly message: string;
}

interface ProgsAPI {
  _assertTrue(check: boolean, message: string): void;
  _VarString(first: number): string;
  builtin: BuiltinFunction[];
}

const PF: ProgsAPI = {
  _assertTrue(check: boolean, message: string): void {
    if (!check) {
      throw new Error(`Program assert failed: ${message}`);
    }
  },

  _VarString(first: number): string {
    let out = '';

    for (let i = first; i < PR.argc; i++) {
      out += PR.GetString(PR.globals_int[ofs.OFS_PARM0 + i * 3]);
    }

    return out;
  },

  builtin: [],
};

export default PF;

let { Con, PR, SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, PR, SV } = getCommonRegistry());
});

/**
 * QuakeC field definition types from `PR.fielddefs[].type`.
 */
export enum etype {
  ev_void = 0,
  ev_string = 1,
  ev_float = 2,
  ev_vector = 3,
  ev_entity = 4,
  ev_field = 5,
  ev_function = 6,
  ev_pointer = 7,

  ev_strings = 101,
  ev_integer = 102,
  ev_string_not_empty = 103,
  ev_entity_client = 104,
  ev_bool = 200,
}

/**
 * QuakeC global parameter offsets.
 */
export enum ofs {
  OFS_NULL = 0,
  OFS_RETURN = 1,
  OFS_PARM0 = 4,
  OFS_PARM1 = 7,
  OFS_PARM2 = 10,
  OFS_PARM3 = 13,
  OFS_PARM4 = 16,
  OFS_PARM5 = 19,
  OFS_PARM6 = 22,
  OFS_PARM7 = 25,
}

/**
 * Generates a function that can be exposed to the QuakeC VM as a builtin.
 * @returns The VM-facing builtin wrapper.
 */
function generateBuiltinFunction(name: string, func: BuiltinImplementation, argTypes: readonly etype[] = [], returnType: etype = etype.ev_void): BuiltinFunction {
  if (!(func instanceof Function)) {
    throw new TypeError('func must be a Function!');
  }

  const args: Array<string | null> = [];
  const asserts: GeneratedAssert[] = [];

  for (const argType of argTypes) {
    const parmNum = args.length;
    const parmName = `PR.ofs.OFS_PARM${parmNum}`;

    switch (argType) {
      case etype.ev_entity_client:
        asserts.push({ check: `PR.globals_int[${parmName}] > 0 && PR.globals_int[${parmName}] <= SV.svs.maxclients`, message: 'edict points to a non-client' });
      // eslint-disable-next-line no-fallthrough
      case etype.ev_entity:
        args.push(`SV.server.edicts[PR.globals_int[${parmName}]]`);
        break;

      case etype.ev_vector:
        args.push(`new Vector(PR.globals_float[${parmName}], PR.globals_float[${parmName} + 1], PR.globals_float[${parmName} + 2])`);
        break;

      case etype.ev_float:
        args.push(`PR.globals_float[${parmName}]`);
        break;

      case etype.ev_integer:
        args.push(`PR.globals_float[${parmName}] >> 0`);
        break;

      case etype.ev_bool:
        args.push(`!!PR.globals_float[${parmName}]`);
        break;

      case etype.ev_string_not_empty:
        asserts.push({ check: `PR.globals_int[${parmName}]`, message: 'string must not be empty' });
      // eslint-disable-next-line no-fallthrough
      case etype.ev_string:
        args.push(`PR.GetString(PR.globals_int[${parmName}])`);
        break;

      case etype.ev_strings:
        args.push(`PF._VarString(${args.length})`);
        break;

      case etype.ev_field:
        args.push(`Object.entries(PR.entvars).find((entry) => entry[1] === PR.globals_int[${parmName}])[0]`);
        break;

      case etype.ev_void:
        args.push(null);
        break;

      default:
        throw new TypeError(`unsupported arg type: ${argType}`);
    }
  }

  let returnCode = '';

  switch (returnType) {
    case etype.ev_vector:
      asserts.push({ check: 'returnValue instanceof Vector', message: 'returnValue must be a Vector' });
      asserts.push({ check: '!Number.isNaN(returnValue[0])', message: 'returnValue[0] must not be NaN' });
      asserts.push({ check: '!Number.isNaN(returnValue[1])', message: 'returnValue[1] must not be NaN' });
      asserts.push({ check: '!Number.isNaN(returnValue[2])', message: 'returnValue[2] must not be NaN' });
      returnCode = `
        PR.globals_float[${ofs.OFS_RETURN + 0}] = returnValue[0];
        PR.globals_float[${ofs.OFS_RETURN + 1}] = returnValue[1];
        PR.globals_float[${ofs.OFS_RETURN + 2}] = returnValue[2];
      `;
      break;

    case etype.ev_entity_client:
      asserts.push({ check: 'returnValue === null || (returnValue.num > 0 && returnValue.num <= SV.svs.maxclients)', message: 'edict points to a non-client' });
    // eslint-disable-next-line no-fallthrough
    case etype.ev_entity:
      asserts.push({ check: 'returnValue === null || returnValue instanceof ServerEdict', message: 'returnValue must be an Edict or null' });
      returnCode = `PR.globals_int[${ofs.OFS_RETURN}] = returnValue ? returnValue.num : 0;`;
      break;

    case etype.ev_integer:
      asserts.push({ check: '!Number.isNaN(returnValue)', message: 'returnValue must not be NaN' });
      returnCode = `PR.globals_float[${ofs.OFS_RETURN}] = returnValue >> 0;`;
      break;

    case etype.ev_float:
      asserts.push({ check: '!Number.isNaN(returnValue)', message: 'returnValue must not be NaN' });
      returnCode = `PR.globals_float[${ofs.OFS_RETURN}] = returnValue;`;
      break;

    case etype.ev_bool:
      asserts.push({ check: 'typeof(returnValue) === \'boolean\'', message: 'returnValue must be bool' });
      returnCode = `PR.globals_float[${ofs.OFS_RETURN}] = returnValue;`;
      break;

    case etype.ev_void:
      returnCode = '/* no return value */';
      break;

    case etype.ev_string_not_empty:
      asserts.push({ check: 'returnValue !== null && returnValue !== \'\'', message: 'string must not be empty' });
    // eslint-disable-next-line no-fallthrough
    case etype.ev_string:
      returnCode = `PR.globals_int[${ofs.OFS_RETURN}] = PR.TempString(returnValue);`;
      break;

    default:
      throw new TypeError(`unsupported return type: ${returnType}`);
  }

  const code = `return function ${name}() {
  const { PR, SV } = registry;

  ${args.map((definition, index) => `  const arg${index} = ${definition};`).join('\n')}

  const returnValue = _${name}(${args.map((_, index) => `arg${index}`).join(', ')});

  ${asserts.map(({ check, message }) => `  PF._assertTrue(${check}, ${JSON.stringify(message)});`).join('\n')}

  ${returnCode}
}`;

  return new Function('ED', 'PF', 'ServerEdict', 'Vector', 'registry', `_${name}`, code)(ED, PF, ServerEdict, Vector, registry, func) as BuiltinFunction;
}

const error = generateBuiltinFunction('error', (str: string): never => {
  Con.PrintError(`======SERVER ERROR in ${PR.GetString(PR.xfunction.name)}\n${str}\n`);
  ED.Print(SV.server.gameAPI.self);
  throw new HostError(`Program error: ${str}`);
}, [etype.ev_strings]);

const objerror = generateBuiltinFunction('objerror', (str: string): never => {
  Con.PrintError(`======OBJECT ERROR in ${PR.GetString(PR.xfunction.name)}\n${str}\n`);
  ED.Print(SV.server.gameAPI.self);
  throw new HostError(`Program error: ${str}`);
}, [etype.ev_strings]);

const makevectors = generateBuiltinFunction('makevectors', (vec: Vector): void => {
  const { forward, right, up } = vec.angleVectors();
  SV.server.gameAPI.v_forward = forward;
  SV.server.gameAPI.v_right = right;
  SV.server.gameAPI.v_up = up;
}, [etype.ev_vector]);

const setorigin = generateBuiltinFunction('setorigin', (edict: ServerEdict, vec: Vector): void => edict.setOrigin(vec), [etype.ev_entity, etype.ev_vector], etype.ev_void);
const setsize = generateBuiltinFunction('setsize', (edict: ServerEdict, min: Vector, max: Vector): void => edict.setMinMaxSize(min, max), [etype.ev_entity, etype.ev_vector, etype.ev_vector], etype.ev_void);

const setmodel = generateBuiltinFunction('setmodel', (edict: ServerEdict, model: string): void => {
  edict.setModel(model);
}, [etype.ev_entity, etype.ev_string]);

const bprint = generateBuiltinFunction('bprint', (message: string): void => {
  ServerEngineAPI.BroadcastPrint(message);
}, [etype.ev_strings]);

const sprint = generateBuiltinFunction('sprint', (clientEdict: ServerEdict, message: string): void => {
  clientEdict.getClient().consolePrint(message);
}, [etype.ev_entity_client, etype.ev_strings]);

const centerprint = generateBuiltinFunction('centerprint', (clientEdict: ServerEdict, message: string): void => {
  clientEdict.getClient().centerPrint(message);
}, [etype.ev_entity_client, etype.ev_strings]);

const normalize = generateBuiltinFunction('normalize', (vec: Vector): Vector => {
  vec.normalize();
  return vec;
}, [etype.ev_vector], etype.ev_vector);

const vlen = generateBuiltinFunction('vlen', (vec: Vector): number => vec.len(), [etype.ev_vector], etype.ev_float);
const vectoyaw = generateBuiltinFunction('vectoyaw', (vec: Vector): number => vec.toYaw(), [etype.ev_vector], etype.ev_float);
const vectoangles = generateBuiltinFunction('vectoangles', (vec: Vector): Vector => vec.toAngles(), [etype.ev_vector], etype.ev_vector);
const random = generateBuiltinFunction('random', (): number => Math.random(), [], etype.ev_float);

const particle = generateBuiltinFunction('particle', (origin: Vector, direction: Vector, color: number, count: number): void => {
  ServerEngineAPI.StartParticles(origin, direction, color, count);
}, [etype.ev_vector, etype.ev_vector, etype.ev_integer, etype.ev_integer]);

const ambientsound = generateBuiltinFunction('ambientsound', (origin: Vector, sample: string, volume: number, attenuation: number): boolean => ServerEngineAPI.SpawnAmbientSound(origin, sample, volume, attenuation), [
  etype.ev_vector,
  etype.ev_string_not_empty,
  etype.ev_float,
  etype.ev_float,
], etype.ev_bool);

const sound = generateBuiltinFunction('sound', (edict: ServerEdict, channel: number, sample: string, volume: number, attenuation: number): boolean => ServerEngineAPI.StartSound(edict, channel, sample, volume, attenuation), [
  etype.ev_entity,
  etype.ev_integer,
  etype.ev_string_not_empty,
  etype.ev_float,
  etype.ev_float,
], etype.ev_bool);

const breakstatement: BuiltinFunction = function breakstatement() {
  Con.Print('break statement\n');
};

const traceline = generateBuiltinFunction('traceline', (start: Vector, end: Vector, noMonsters: number, passEdict: ServerEdict | null): void => {
  const trace = ServerEngineAPI.TracelineLegacy(start, end, noMonsters, passEdict);

  SV.server.gameAPI.trace_allsolid = trace.allsolid === true ? 1.0 : 0.0;
  SV.server.gameAPI.trace_startsolid = trace.startsolid === true ? 1.0 : 0.0;
  SV.server.gameAPI.trace_fraction = trace.fraction;
  SV.server.gameAPI.trace_inwater = trace.inwater === true ? 1.0 : 0.0;
  SV.server.gameAPI.trace_inopen = trace.inopen === true ? 1.0 : 0.0;
  SV.server.gameAPI.trace_endpos = trace.endpos;
  SV.server.gameAPI.trace_plane_normal = trace.plane.normal;
  SV.server.gameAPI.trace_plane_dist = trace.plane.dist;
  SV.server.gameAPI.trace_ent = trace.ent || null;
}, [etype.ev_vector, etype.ev_vector, etype.ev_integer, etype.ev_entity]);

const checkclient = generateBuiltinFunction('checkclient', (): ServerEdict | null => SV.server.gameAPI.self.getNextBestClient(), [], etype.ev_entity_client);

const stuffcmd = generateBuiltinFunction('stuffcmd', (clientEdict: ServerEdict, command: string): void => {
  clientEdict.getClient().sendConsoleCommands(command);
}, [etype.ev_entity_client, etype.ev_string]);

const localcmd = generateBuiltinFunction('localcmd', (command: string): void => {
  Cmd.text += command;
}, [etype.ev_string]);

const cvar = generateBuiltinFunction('cvar', (name: string): number => {
  const cvarValue = ServerEngineAPI.GetCvar(name);
  return cvarValue ? cvarValue.value : 0.0;
}, [etype.ev_string], etype.ev_float);

const cvar_set = generateBuiltinFunction('cvar_set', (name: string, value: string): void => {
  ServerEngineAPI.SetCvar(name, value);
}, [etype.ev_string, etype.ev_string]);

const findradius = generateBuiltinFunction('findradius', (origin: Vector, radius: number): ServerEdict => {
  const edicts = ServerEngineAPI.FindInRadius(origin, radius);
  let chain = SV.server.edicts[0];

  for (const edict of edicts) {
    edict.entity.chain = chain;
    chain = edict;
  }

  return chain;
}, [etype.ev_vector, etype.ev_float], etype.ev_entity);

const dprint = generateBuiltinFunction('dprint', (message: string): void => {
  ServerEngineAPI.ConsoleDebug(message);
}, [etype.ev_strings]);

const ftos = generateBuiltinFunction('ftos', (value: number): string => ((+value | 0) === +value ? value.toString() : value.toFixed(1)), [etype.ev_float], etype.ev_string);
const fabs = generateBuiltinFunction('fabs', (value: number): number => Math.abs(value), [etype.ev_float], etype.ev_float);
const vtos = generateBuiltinFunction('vtos', (vec: Vector): string => vec.toString(), [etype.ev_vector], etype.ev_string);

const Spawn = generateBuiltinFunction('Spawn', (): ServerEdict => {
  const edict = ED.Alloc();
  SV.server.gameAPI.prepareEntity(edict, null, {});
  return edict;
}, [], etype.ev_entity);

const Remove = generateBuiltinFunction('Remove', (edict: ServerEdict): void => {
  edict.freeEdict();
}, [etype.ev_entity]);

const Find = generateBuiltinFunction('Find', (edict: ServerEdict, field: string, value: string): ServerEdict | null => ServerEngineAPI.FindByFieldAndValue(field, value, edict.num + 1), [etype.ev_entity, etype.ev_field, etype.ev_string], etype.ev_entity);
const MoveToGoal = generateBuiltinFunction('MoveToGoal', (dist: number): boolean => SV.server.gameAPI.self.moveToGoal(dist), [etype.ev_float], etype.ev_bool);
const precache_file = generateBuiltinFunction('precache_file', (value: number): number => value, [etype.ev_integer], etype.ev_integer);

const precache_sound = generateBuiltinFunction('precache_sound', (sfxName: string): void => {
  ServerEngineAPI.PrecacheSound(sfxName);
}, [etype.ev_string_not_empty]);

const precache_model = generateBuiltinFunction('precache_model', (modelName: string): void => {
  ServerEngineAPI.PrecacheModel(modelName);
}, [etype.ev_string_not_empty]);

const coredump: BuiltinFunction = function coredump() {
  ED.PrintEdicts();
};

const traceon: BuiltinFunction = function traceon() {
  PR.trace = true;
};

const traceoff: BuiltinFunction = function traceoff() {
  PR.trace = false;
};

const eprint: BuiltinFunction = function eprint() {
  ED.Print(SV.server.edicts[PR.globals_float[4]]);
};

const walkmove = generateBuiltinFunction('walkmove', (yaw: number, dist: number): boolean => {
  const oldFunction = PR.xfunction;
  const result = SV.server.gameAPI.self.walkMove(yaw, dist);
  PR.xfunction = oldFunction;
  return result;
}, [etype.ev_float, etype.ev_float], etype.ev_bool);

const droptofloor = generateBuiltinFunction('droptofloor', (): boolean => SV.server.gameAPI.self.dropToFloor(-256.0), [], etype.ev_bool);

const lightstyle = generateBuiltinFunction('lightstyle', (style: number, value: string): void => {
  ServerEngineAPI.Lightstyle(style, value);
}, [etype.ev_integer, etype.ev_string]);

const rint = generateBuiltinFunction('rint', (value: number): number => (value >= 0.0 ? value + 0.5 : value - 0.5), [etype.ev_float], etype.ev_integer);
const floor = generateBuiltinFunction('floor', (value: number): number => Math.floor(value), [etype.ev_float], etype.ev_float);
const ceil = generateBuiltinFunction('ceil', (value: number): number => Math.ceil(value), [etype.ev_float], etype.ev_float);
const checkbottom = generateBuiltinFunction('checkbottom', (edict: ServerEdict): boolean => edict.isOnTheFloor(), [etype.ev_entity], etype.ev_bool);
const pointcontents = generateBuiltinFunction('pointcontents', (point: Vector): number => ServerEngineAPI.DeterminePointContents(point), [etype.ev_vector], etype.ev_float);
const nextent = generateBuiltinFunction('nextent', (edict: ServerEdict): ServerEdict | null => edict.nextEdict(), [etype.ev_entity], etype.ev_entity);

const aim = generateBuiltinFunction('aim', (edict: ServerEdict): Vector => {
  const direction = SV.server.gameAPI.v_forward;
  return edict.aim(direction);
}, [etype.ev_entity], etype.ev_vector);

const changeyaw = generateBuiltinFunction('changeyaw', (): void => {
  SV.server.gameAPI.self.changeYaw();
}, []);

/**
 * Resolves a Quake message destination to a concrete buffer.
 * @returns The destination message buffer.
 */
function WriteGeneric(dest: number): SzBuffer {
  switch (dest) {
    case 0:
      return SV.server.datagram;

    case 1: {
      const messageEntity = SV.server.gameAPI.msg_entity;
      const entityNumber = messageEntity.num;

      if (!messageEntity.isClient()) {
        throw new Error(`WriteGeneric: not a client ${entityNumber}`);
      }

      return messageEntity.getClient().message;
    }

    case 2:
      return SV.server.reliable_datagram;

    case 3:
      return SV.server.signon;

    default:
      throw new Error(`WriteGeneric: bad destination ${dest}`);
  }
}

const WriteByte = generateBuiltinFunction('WriteByte', (dest: number, value: number): void => {
  WriteGeneric(dest).writeByte(value);
}, [etype.ev_integer, etype.ev_float]);

const WriteChar = generateBuiltinFunction('WriteChar', (dest: number, value: number): void => {
  WriteGeneric(dest).writeChar(value);
}, [etype.ev_integer, etype.ev_float]);

const WriteShort = generateBuiltinFunction('WriteShort', (dest: number, value: number): void => {
  WriteGeneric(dest).writeShort(value);
}, [etype.ev_integer, etype.ev_float]);

const WriteLong = generateBuiltinFunction('WriteLong', (dest: number, value: number): void => {
  WriteGeneric(dest).writeLong(value);
}, [etype.ev_integer, etype.ev_float]);

const WriteAngle = generateBuiltinFunction('WriteAngle', (dest: number, value: number): void => {
  WriteGeneric(dest).writeAngle(value);
}, [etype.ev_integer, etype.ev_float]);

const WriteCoord = generateBuiltinFunction('WriteCoord', (dest: number, value: number): void => {
  WriteGeneric(dest).writeCoord(value);
}, [etype.ev_integer, etype.ev_float]);

const WriteString = generateBuiltinFunction('WriteString', (dest: number, value: string): void => {
  WriteGeneric(dest).writeString(value);
}, [etype.ev_integer, etype.ev_string]);

const WriteEntity = generateBuiltinFunction('WriteEntity', (dest: number, value: ServerEdict): void => {
  WriteGeneric(dest).writeShort(value.num);
}, [etype.ev_integer, etype.ev_entity]);

const makestatic = generateBuiltinFunction('makestatic', (edict: ServerEdict): void => {
  edict.makeStatic();
}, [etype.ev_entity]);

const setspawnparms = generateBuiltinFunction('setspawnparms', (clientEdict: ServerEdict): void => {
  const spawnParameters = clientEdict.getClient().spawn_parms;

  for (let i = 0; i <= 15; i++) {
    SV.server.gameAPI[`parm${i + 1}`] = spawnParameters[i];
  }
}, [etype.ev_entity_client]);

const changelevel = generateBuiltinFunction('changelevel', (levelName: string): void => {
  ServerEngineAPI.ChangeLevel(levelName);
}, [etype.ev_string]);

const Fixme: BuiltinFunction = function Fixme() {
  throw new Error('unimplemented builtin');
};

Object.assign(PF, {
  error,
  objerror,
  makevectors,
  setorigin,
  setsize,
  setmodel,
  bprint,
  sprint,
  centerprint,
  normalize,
  vlen,
  vectoyaw,
  vectoangles,
  random,
  particle,
  ambientsound,
  sound,
  breakstatement,
  traceline,
  checkclient,
  stuffcmd,
  localcmd,
  cvar,
  cvar_set,
  findradius,
  dprint,
  ftos,
  fabs,
  vtos,
  Spawn,
  Remove,
  Find,
  MoveToGoal,
  precache_file,
  precache_sound,
  precache_model,
  coredump,
  traceon,
  traceoff,
  eprint,
  walkmove,
  droptofloor,
  lightstyle,
  rint,
  floor,
  ceil,
  checkbottom,
  pointcontents,
  nextent,
  aim,
  changeyaw,
  WriteByte,
  WriteChar,
  WriteShort,
  WriteLong,
  WriteAngle,
  WriteCoord,
  WriteString,
  WriteEntity,
  makestatic,
  setspawnparms,
  changelevel,
  Fixme,
});

PF.builtin = [
  Fixme,
  makevectors,
  setorigin,
  setmodel,
  setsize,
  Fixme,
  breakstatement,
  random,
  sound,
  normalize,
  error,
  objerror,
  vlen,
  vectoyaw,
  Spawn,
  Remove,
  traceline,
  checkclient,
  Find,
  precache_sound,
  precache_model,
  stuffcmd,
  findradius,
  bprint,
  sprint,
  dprint,
  ftos,
  vtos,
  coredump,
  traceon,
  traceoff,
  eprint,
  walkmove,
  Fixme,
  droptofloor,
  lightstyle,
  rint,
  floor,
  ceil,
  Fixme,
  checkbottom,
  pointcontents,
  Fixme,
  fabs,
  aim,
  cvar,
  localcmd,
  nextent,
  particle,
  changeyaw,
  Fixme,
  vectoangles,
  WriteByte,
  WriteChar,
  WriteShort,
  WriteLong,
  WriteCoord,
  WriteAngle,
  WriteString,
  WriteEntity,
  Fixme,
  Fixme,
  Fixme,
  Fixme,
  Fixme,
  Fixme,
  Fixme,
  MoveToGoal,
  precache_file,
  makestatic,
  changelevel,
  Fixme,
  cvar_set,
  centerprint,
  ambientsound,
  precache_model,
  precache_sound,
  precache_file,
  setspawnparms,
  Fixme,
  Fixme,
  Fixme,
  Fixme,
];
