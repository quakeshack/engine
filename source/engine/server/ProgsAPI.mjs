import Vector from '../../shared/Vector.mjs';
import Cmd from '../common/Cmd.mjs';
import { HostError } from '../common/Errors.mjs';
import { ServerEngineAPI } from '../common/GameAPIs.mjs';
import MSG from '../network/MSG.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ED, ServerEdict } from './Edict.mjs';

const PF = {};

export default PF;

let { Con, PR, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  PR = registry.PR;
  SV = registry.SV;
});

PF._assertTrue = function _PF_assertTrue(check, message) {
  if (!check) {
    throw new Error('Program assert failed: ' + message);
  }
};

/**
 * PR.fielddefs[].type
 * @enum {number}
 * @readonly
 */
export const etype = Object.freeze({
  ev_void: 0,
  ev_string: 1,
  ev_float: 2,
  ev_vector: 3,
  ev_entity: 4,
  ev_field: 5,
  ev_function: 6,
  ev_pointer: 7,

  ev_strings: 101,
  ev_integer: 102,
  ev_string_not_empty: 103,
  ev_entity_client: 104,
  ev_bool: 200,
});

/**
 * @enum {number}
 * @readonly
 */
export const ofs = Object.freeze({
  OFS_NULL: 0,
  OFS_RETURN: 1,
  OFS_PARM0: 4, // leave 3 ofs for each parm to hold vectors
  OFS_PARM1: 7,
  OFS_PARM2: 10,
  OFS_PARM3: 13,
  OFS_PARM4: 16,
  OFS_PARM5: 19,
  OFS_PARM6: 22,
  OFS_PARM7: 25,
});

/**
 * Will generate a function that can be exposed to the QuakeC VM (so called built-in function)
 * @param {string} name
 * @param {Function} func
 * @param {etype[]} argTypes
 * @param {etype} returnType
 * @returns {Function}
 */
function _PF_GenerateBuiltinFunction(name, func, argTypes = [], returnType = etype.ev_void) {
  if (!(func instanceof Function)) {
    throw new TypeError('func must be a Function!');
  }

  const args = [];
  let returnCode = '';
  const asserts = [];

  for (const argType of argTypes) {
    const parmNum = args.length;
    const parmName = `PR.ofs.OFS_PARM${parmNum}`;

    switch (argType) {
      case etype.ev_entity_client:
        asserts.push({check: `PR.globals_int[${parmName}] > 0 && PR.globals_int[${parmName}] <= SV.svs.maxclients`, message: 'edict points to a non-client'});
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
        asserts.push({check: `PR.globals_int[${parmName}]`, message: 'string must not be empty'});
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
        throw new TypeError('unsupported arg type: ' + argType);
    }
  }

  switch (returnType) {
    case etype.ev_vector:
      asserts.push({check: 'returnValue instanceof Vector', message: 'returnValue must be a Vector'});
      asserts.push({check: '!isNaN(returnValue[0])', message: 'returnValue[0] must not be NaN'});
      asserts.push({check: '!isNaN(returnValue[1])', message: 'returnValue[1] must not be NaN'});
      asserts.push({check: '!isNaN(returnValue[2])', message: 'returnValue[2] must not be NaN'});
      returnCode = `
        PR.globals_float[${ofs.OFS_RETURN + 0}] = returnValue[0];
        PR.globals_float[${ofs.OFS_RETURN + 1}] = returnValue[1];
        PR.globals_float[${ofs.OFS_RETURN + 2}] = returnValue[2];
      `;
      break;

    case etype.ev_entity_client:
      asserts.push({check: 'returnValue === null || (returnValue.num > 0 && returnValue.num <= SV.svs.maxclients)', message: 'edict points to a non-client'});
    // eslint-disable-next-line no-fallthrough
    case etype.ev_entity:
      // additional sanity check: the returnValue _must_ be an Edict or null, otherwise chaos will ensue
      asserts.push({check: 'returnValue === null || returnValue instanceof ServerEdict', message: 'returnValue must be an Edict or null'});
      returnCode = `PR.globals_int[${ofs.OFS_RETURN}] = returnValue ? returnValue.num : 0;`;
      break;

    case etype.ev_integer:
      asserts.push({check: '!isNaN(returnValue)', message: 'returnValue must not be NaN'});
      returnCode = `PR.globals_float[${ofs.OFS_RETURN}] = returnValue >> 0;`;
      break;

    case etype.ev_float:
      asserts.push({check: '!isNaN(returnValue)', message: 'returnValue must not be NaN'});
      returnCode = `PR.globals_float[${ofs.OFS_RETURN}] = returnValue;`;
      break;

    case etype.ev_bool:
      asserts.push({check: 'typeof(returnValue) === \'boolean\'', message: 'returnValue must be bool'});
      returnCode = `PR.globals_float[${ofs.OFS_RETURN}] = returnValue;`;
      break;

    case etype.ev_void:
      returnCode = '/* no return value */';
      break;

    case etype.ev_string_not_empty:
      asserts.push({check: 'returnValue !== null && returnValue !== \'\'', message: 'string must not be empty'});
      // eslint-disable-next-line no-fallthrough
    case etype.ev_string:
      returnCode = `PR.globals_int[${ofs.OFS_RETURN}] = PR.TempString(returnValue);`;
      break;

    default:
      throw new TypeError('unsupported return type: ' + returnType);
  }

  const code = `return function ${name}() {
  const { PR, SV } = registry;

  ${args.map((def, index) => `  const arg${index} = ${def};`).join('\n')}

  const returnValue = _${name}(${args.map((_, index) => `arg${index}`).join(', ')});

  ${asserts.map(({check, message}) => `  PF._assertTrue(${check}, ${JSON.stringify(message)});`).join('\n')}

  ${returnCode}
}`;

  return (new Function('ED', 'MSG', 'PF', 'ServerEdict', 'Vector', 'registry', '_' + name, code))(ED, MSG, PF, ServerEdict, Vector, registry, func);
};

PF._VarString = function _PF_VarString(first) {
  let i; let out = '';
  for (i = first; i < PR.argc; ++i) {
    out += PR.GetString(PR.globals_int[ofs.OFS_PARM0 + i * 3]);
  }
  return out;
};

PF.error = _PF_GenerateBuiltinFunction('error', function (str) {
  Con.PrintError('======SERVER ERROR in ' + PR.GetString(PR.xfunction.name) + '\n' + str + '\n');
  ED.Print(SV.server.gameAPI.self);
  throw new HostError('Program error: ' + str);
}, [etype.ev_strings]);

PF.objerror = _PF_GenerateBuiltinFunction('objerror', function (str) {
  Con.PrintError('======OBJECT ERROR in ' + PR.GetString(PR.xfunction.name) + '\n' + str + '\n');
  ED.Print(SV.server.gameAPI.self);
  throw new HostError('Program error: ' + str);
}, [etype.ev_strings]);

PF.makevectors = _PF_GenerateBuiltinFunction('makevectors', function (vec) {
  const {forward, right, up} = vec.angleVectors();
  SV.server.gameAPI.v_forward = forward;
  SV.server.gameAPI.v_right = right;
  SV.server.gameAPI.v_up = up;
}, [etype.ev_vector]);

PF.setorigin = _PF_GenerateBuiltinFunction('setorigin', (edict, vec)  => edict.setOrigin(vec), [etype.ev_entity, etype.ev_vector], etype.ev_void);

PF.setsize = _PF_GenerateBuiltinFunction('setsize', (edict, min, max) => edict.setMinMaxSize(min, max), [etype.ev_entity, etype.ev_vector, etype.ev_vector], etype.ev_void);

PF.setmodel = _PF_GenerateBuiltinFunction('setmodel', function(ed, model) {
  ed.setModel(model);
}, [etype.ev_entity, etype.ev_string]);

PF.bprint = _PF_GenerateBuiltinFunction('bprint', ServerEngineAPI.BroadcastPrint, [etype.ev_strings]);

PF.sprint = _PF_GenerateBuiltinFunction('sprint', (clientEdict, message) => clientEdict.getClient().consolePrint(message), [etype.ev_entity_client, etype.ev_strings]);

PF.centerprint = _PF_GenerateBuiltinFunction('centerprint', (clientEdict, message) => clientEdict.getClient().centerPrint(message), [etype.ev_entity_client, etype.ev_strings]);

PF.normalize = _PF_GenerateBuiltinFunction('normalize', function (vec) {
  vec.normalize();

  return vec;
}, [etype.ev_vector], etype.ev_vector);

PF.vlen = _PF_GenerateBuiltinFunction('vlen', (vec) => vec.len(), [etype.ev_vector], etype.ev_float);

PF.vectoyaw = _PF_GenerateBuiltinFunction('vectoyaw', (vec) => vec.toYaw(), [etype.ev_vector], etype.ev_float);

PF.vectoangles = _PF_GenerateBuiltinFunction('vectoangles', (vec) => vec.toAngles(), [etype.ev_vector], etype.ev_vector);

PF.random = _PF_GenerateBuiltinFunction('random', Math.random, [], etype.ev_float);

PF.particle = _PF_GenerateBuiltinFunction('particle', ServerEngineAPI.StartParticles, [etype.ev_vector, etype.ev_vector, etype.ev_integer, etype.ev_integer]);

PF.ambientsound = _PF_GenerateBuiltinFunction('ambientsound', ServerEngineAPI.SpawnAmbientSound, [
  etype.ev_vector,
  etype.ev_string_not_empty,
  etype.ev_float,
  etype.ev_float,
], etype.ev_bool);

PF.sound = _PF_GenerateBuiltinFunction('sound', ServerEngineAPI.StartSound, [
  etype.ev_entity,
  etype.ev_integer,
  etype.ev_string_not_empty,
  etype.ev_float,
  etype.ev_float,
], etype.ev_bool);

PF.breakstatement = function breakstatement() { // PR
  Con.Print('break statement\n');
};

PF.traceline = _PF_GenerateBuiltinFunction('traceline', function(start, end, noMonsters, passEdict) {
  const trace = ServerEngineAPI.TracelineLegacy(start, end, noMonsters, passEdict);

  SV.server.gameAPI.trace_allsolid = (trace.allsolid === true) ? 1.0 : 0.0;
  SV.server.gameAPI.trace_startsolid = (trace.startsolid === true) ? 1.0 : 0.0;
  SV.server.gameAPI.trace_fraction = trace.fraction;
  SV.server.gameAPI.trace_inwater = (trace.inwater === true) ? 1.0 : 0.0;
  SV.server.gameAPI.trace_inopen = (trace.inopen === true) ? 1.0 : 0.0;
  SV.server.gameAPI.trace_endpos = trace.endpos;
  SV.server.gameAPI.trace_plane_normal = trace.plane.normal;
  SV.server.gameAPI.trace_plane_dist = trace.plane.dist;
  SV.server.gameAPI.trace_ent = trace.ent || null;
}, [
  etype.ev_vector,
  etype.ev_vector,
  etype.ev_integer,
  etype.ev_entity,
]);

PF.checkclient = _PF_GenerateBuiltinFunction('checkclient', () => SV.server.gameAPI.self.getNextBestClient(), [], etype.ev_entity_client);

PF.stuffcmd = _PF_GenerateBuiltinFunction('stuffcmd', function(clientEdict, cmd) {
  clientEdict.getClient().sendConsoleCommands(cmd);
}, [etype.ev_entity_client, etype.ev_string]);

PF.localcmd = _PF_GenerateBuiltinFunction('localcmd', function(cmd) {
  Cmd.text += cmd;
}, [etype.ev_string]);

PF.cvar = _PF_GenerateBuiltinFunction('cvar', function(name) {
  const cvar = ServerEngineAPI.GetCvar(name);
  return cvar ? cvar.value : 0.0;
}, [etype.ev_string], etype.ev_float);

PF.cvar_set = _PF_GenerateBuiltinFunction('cvar_set', ServerEngineAPI.SetCvar, [etype.ev_string, etype.ev_string]);

PF.findradius = _PF_GenerateBuiltinFunction('findradius', (origin, radius) => {
  const edicts = ServerEngineAPI.FindInRadius(origin, radius);

  // doing the chain dance
  let chain = SV.server.edicts[0]; // starts with worldspawn

  // iterate over the list of edicts
  for (const edict of edicts) {
    edict.entity.chain = chain;
    chain = edict;
  }

  return chain;
}, [etype.ev_vector, etype.ev_float], etype.ev_entity);

PF.dprint = function PF_dprint() { // EngineInterface
  Con.DPrint(PF._VarString(0));
};

PF.dprint = _PF_GenerateBuiltinFunction('dprint', (str) => ServerEngineAPI.ConsoleDebug(str), [etype.ev_strings]);

PF.ftos = _PF_GenerateBuiltinFunction('ftos', (f) => parseInt(f) == f ? f.toString() : f.toFixed(1), [etype.ev_float], etype.ev_string);

PF.fabs = _PF_GenerateBuiltinFunction('fabs', Math.abs, [etype.ev_float], etype.ev_float);

PF.vtos = _PF_GenerateBuiltinFunction('vtos', (vec) => vec.toString(), [etype.ev_vector], etype.ev_string);

PF.Spawn = _PF_GenerateBuiltinFunction('Spawn', () => {
  // this is a special null entity we spawn for the QuakeC
  // it will be automatically populated with an EdictProxy
  // the JS Game is supposed to use ServerEngineAPI.SpawnEntity
  const edict = ED.Alloc();
  SV.server.gameAPI.prepareEntity(edict, null, {});
  return edict;
}, [], etype.ev_entity);

PF.Remove = _PF_GenerateBuiltinFunction('Remove', (edict) => edict.freeEdict(), [etype.ev_entity]);

PF.Find = _PF_GenerateBuiltinFunction('Find', (edict, field, value) => {
  return ServerEngineAPI.FindByFieldAndValue(field, value, edict.num + 1);
}, [etype.ev_entity, etype.ev_field, etype.ev_string], etype.ev_entity);

PF.MoveToGoal = _PF_GenerateBuiltinFunction('MoveToGoal', (dist) => {
  return SV.server.gameAPI.self.moveToGoal(dist);
}, [etype.ev_float], etype.ev_bool);

PF.precache_file = _PF_GenerateBuiltinFunction('precache_file', (integer) => {
  return integer; // dummy behavior
}, [etype.ev_integer], etype.ev_integer);

PF.precache_sound = _PF_GenerateBuiltinFunction('precache_sound', (sfxName) => {
  return ServerEngineAPI.PrecacheSound(sfxName);
}, [etype.ev_string_not_empty]);

PF.precache_model = _PF_GenerateBuiltinFunction('precache_model', (modelName) => {
  // FIXME: handle this more gracefully
  // if (SV.server.loading !== true) {
  //   PR.RunError('PF.Precache_*: Precache can only be done in spawn functions');
  // }

  return ServerEngineAPI.PrecacheModel(modelName);
}, [etype.ev_string_not_empty]);

PF.coredump = function coredump() {
  ED.PrintEdicts();
};

PF.traceon = function traceon() {
  PR.trace = true;
};

PF.traceoff = function traceoff() {
  PR.trace = false;
};

PF.eprint = function eprint() {
  ED.Print(SV.server.edicts[PR.globals_float[4]]);
};

PF.walkmove = _PF_GenerateBuiltinFunction('walkmove', function(yaw, dist) {
  const oldf = PR.xfunction; // ???
  const res = SV.server.gameAPI.self.walkMove(yaw, dist);
  PR.xfunction = oldf; // ???

  return res;
}, [etype.ev_float, etype.ev_float], etype.ev_bool);

PF.droptofloor = _PF_GenerateBuiltinFunction('droptofloor', () => SV.server.gameAPI.self.dropToFloor(-256.0), [], etype.ev_bool);

PF.lightstyle = _PF_GenerateBuiltinFunction('lightstyle', ServerEngineAPI.Lightstyle, [etype.ev_integer, etype.ev_string]);

PF.rint = _PF_GenerateBuiltinFunction('rint', (f) => (f >= 0.0 ? f + 0.5 : f - 0.5), [etype.ev_float], etype.ev_integer);

PF.floor = _PF_GenerateBuiltinFunction('floor', Math.floor, [etype.ev_float], etype.ev_float);

PF.ceil = _PF_GenerateBuiltinFunction('ceil', Math.ceil, [etype.ev_float], etype.ev_float);

PF.checkbottom = _PF_GenerateBuiltinFunction('checkbottom', (edict) => edict.isOnTheFloor(), [etype.ev_entity], etype.ev_bool);

PF.pointcontents = _PF_GenerateBuiltinFunction('pointcontents', ServerEngineAPI.DeterminePointContents, [etype.ev_vector], etype.ev_float);

PF.nextent = _PF_GenerateBuiltinFunction('nextent', (edict) => edict.nextEdict(), [etype.ev_entity], etype.ev_entity);

PF.aim = _PF_GenerateBuiltinFunction('aim', (edict) => {
  // CR: `makevectors(self.v_angle);` is called in `W_Attack` and propagates all the way down here
  const dir = SV.server.gameAPI.v_forward;
  return edict.aim(dir);
}, [etype.ev_entity], etype.ev_vector);

PF.changeyaw = _PF_GenerateBuiltinFunction('changeyaw', () => SV.server.gameAPI.self.changeYaw(), []);

// eslint-disable-next-line jsdoc/require-jsdoc
function WriteGeneric(dest) {
  switch (dest) {
    case 0: // broadcast
      return SV.server.datagram;
    case 1: { // one
        // CR: I’m not happy with the structure of the code, Write* needs to be on Edict as well
        const msg_entity = SV.server.gameAPI.msg_entity;
        const entnum = msg_entity.num;
        if (!msg_entity.isClient()) {
          throw new Error('WriteGeneric: not a client ' + entnum);
        }
        return msg_entity.getClient().message;
      }
    case 2: // all
      return SV.server.reliable_datagram;
    case 3: // init
      return SV.server.signon;
  }
  throw new Error('WriteGeneric: bad destination ' + dest);
};

for (const fn of ['WriteByte', 'WriteChar', 'WriteShort', 'WriteLong', 'WriteAngle', 'WriteCoord']) {
  PF[fn] = _PF_GenerateBuiltinFunction(fn, (dest, val) => MSG[fn](WriteGeneric(dest), val), [etype.ev_integer, etype.ev_float]);
}

PF.WriteString = _PF_GenerateBuiltinFunction('WriteString', (dest, val) => MSG.WriteString(WriteGeneric(dest), val), [etype.ev_integer, etype.ev_string]);

PF.WriteEntity = _PF_GenerateBuiltinFunction('WriteEntity', (dest, val) => MSG.WriteShort(WriteGeneric(dest), val.num), [etype.ev_integer, etype.ev_entity]);

PF.makestatic = _PF_GenerateBuiltinFunction('makestatic', (edict) => edict.makeStatic(), [etype.ev_entity]);

PF.setspawnparms = _PF_GenerateBuiltinFunction('setspawnparms', function (clientEdict) {
  const spawn_parms = clientEdict.getClient().spawn_parms;

  for (let i = 0; i <= 15; ++i) {
    SV.server.gameAPI[`parm${i + 1}`] = spawn_parms[i];
  }
}, [etype.ev_entity_client]);

PF.changelevel = _PF_GenerateBuiltinFunction('changelevel', ServerEngineAPI.ChangeLevel, [etype.ev_string]);

PF.Fixme = function Fixme() {
  throw new Error('unimplemented builtin');
};

PF.builtin = [
  PF.Fixme,
  PF.makevectors,
  PF.setorigin,
  PF.setmodel,
  PF.setsize,
  PF.Fixme,
  PF.breakstatement,
  PF.random,
  PF.sound,
  PF.normalize,
  PF.error,
  PF.objerror,
  PF.vlen,
  PF.vectoyaw,
  PF.Spawn,
  PF.Remove,
  PF.traceline,
  PF.checkclient,
  PF.Find,
  PF.precache_sound,
  PF.precache_model,
  PF.stuffcmd,
  PF.findradius,
  PF.bprint,
  PF.sprint,
  PF.dprint,
  PF.ftos,
  PF.vtos,
  PF.coredump,
  PF.traceon,
  PF.traceoff,
  PF.eprint,
  PF.walkmove,
  PF.Fixme,
  PF.droptofloor,
  PF.lightstyle,
  PF.rint,
  PF.floor,
  PF.ceil,
  PF.Fixme,
  PF.checkbottom,
  PF.pointcontents,
  PF.Fixme,
  PF.fabs,
  PF.aim,
  PF.cvar,
  PF.localcmd,
  PF.nextent,
  PF.particle,
  PF.changeyaw,
  PF.Fixme,
  PF.vectoangles,
  PF.WriteByte,
  PF.WriteChar,
  PF.WriteShort,
  PF.WriteLong,
  PF.WriteCoord,
  PF.WriteAngle,
  PF.WriteString,
  PF.WriteEntity,
  PF.Fixme,
  PF.Fixme,
  PF.Fixme,
  PF.Fixme,
  PF.Fixme,
  PF.Fixme,
  PF.Fixme,
  PF.MoveToGoal,
  PF.precache_file,
  PF.makestatic,
  PF.changelevel,
  PF.Fixme,
  PF.cvar_set,
  PF.centerprint,
  PF.ambientsound,
  PF.precache_model,
  PF.precache_sound,
  PF.precache_file,
  PF.setspawnparms,

  PF.Fixme, // PF.logfrag,
  PF.Fixme, // PF.infokey,
  PF.Fixme, // PF.stof,
  PF.Fixme, // PF.multicast,
];

console.log('PF.builtin', PF.builtin);
