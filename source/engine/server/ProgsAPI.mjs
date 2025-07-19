import Cmd from '../common/Cmd.mjs';
import { ServerEngineAPI } from '../common/GameAPIs.mjs';
import MSG from '../network/MSG.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ED } from './Edict.mjs';

const PF = {};

export default PF;

let { Con, Host, PR, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Host = registry.Host;
  PR = registry.PR;
  SV = registry.SV;
});

PF._assertTrue = function _PF_assertTrue(check, message) {
  if (!check) {
    throw new Error('Program assert failed: ' + message);
  }
};

PF._wrapFunctions = [];

/**
 * Will generate a function that can be exposed to the QuakeC VM (so called built-in function)
 * @param {string} name
 * @param {Function} func
 * @param {PR.etype[]} argTypes
 * @param {PR.etype} returnType
 * @returns {Function}
 */

PF._generateBuiltinFunction = function _PF_GenerateBuiltinFunction(func, argTypes = [], returnType = PR.etype.ev_void) {
  // store the wrapped function, we need to refer to it
  const name = PF._wrapFunctions.length;

  if (!(func instanceof Function)) {
    throw new TypeError('func must be a Function!');
  }

  PF._wrapFunctions[name] = func;

  const args = [];
  let returnCode = '';
  const asserts = [];

  for (const argType of argTypes) {
    const parmNum = args.length;
    const parmName = `PR.ofs.OFS_PARM${parmNum}`;

    switch (argType) {
      case PR.etype.ev_entity_client:
        asserts.push({check: `PR.globals_int[${parmName}] > 0 && PR.globals_int[${parmName}] <= SV.svs.maxclients`, message: 'edict points to a non-client'});
      // eslint-disable-next-line no-fallthrough
      case PR.etype.ev_entity:
        args.push(`SV.server.edicts[PR.globals_int[${parmName}]]`);
        break;

      case PR.etype.ev_vector:
        args.push(`new Vector(PR.globals_float[${parmName}], PR.globals_float[${parmName} + 1], PR.globals_float[${parmName} + 2])`);
        break;

      case PR.etype.ev_float:
        args.push(`PR.globals_float[${parmName}]`);
        break;

      case PR.etype.ev_integer:
        args.push(`PR.globals_float[${parmName}] >> 0`);
        break;

      case PR.etype.ev_bool:
        args.push(`!!PR.globals_float[${parmName}]`);
        break;

      case PR.etype.ev_string_not_empty:
        asserts.push({check: `PR.globals_int[${parmName}]`, message: 'string must not be empty'});
        // eslint-disable-next-line no-fallthrough
      case PR.etype.ev_string:
        args.push(`PR.GetString(PR.globals_int[${parmName}])`);
        break;

      case PR.etype.ev_strings:
        args.push(`PF._VarString(${args.length})`);
        break;

      case PR.etype.ev_field:
        args.push(`Object.entries(PR.entvars).find((entry) => entry[1] === PR.globals_int[${parmName}])[0]`);
        break;

      case PR.etype.ev_void:
        args.push(null);
        break;

      default:
        throw new TypeError('unsupported arg type: ' + argType);
    }
  }

  switch (returnType) {
    case PR.etype.ev_vector:
      asserts.push({check: 'returnValue instanceof Vector', message: 'returnValue must be a Vector'});
      asserts.push({check: '!isNaN(returnValue[0])', message: 'returnValue[0] must not be NaN'});
      asserts.push({check: '!isNaN(returnValue[1])', message: 'returnValue[1] must not be NaN'});
      asserts.push({check: '!isNaN(returnValue[2])', message: 'returnValue[2] must not be NaN'});
      returnCode = `
        PR.globals_float[${PR.ofs.OFS_RETURN + 0}] = returnValue[0];
        PR.globals_float[${PR.ofs.OFS_RETURN + 1}] = returnValue[1];
        PR.globals_float[${PR.ofs.OFS_RETURN + 2}] = returnValue[2];
      `;
      break;

    case PR.etype.ev_entity_client:
      asserts.push({check: 'returnValue === null || (returnValue.num > 0 && returnValue.num <= SV.svs.maxclients)', message: 'edict points to a non-client'});
    // eslint-disable-next-line no-fallthrough
    case PR.etype.ev_entity:
      // additional sanity check: the returnValue _must_ be an Edict or null, otherwise chaos will ensue
      asserts.push({check: 'returnValue === null || returnValue instanceof SV.Edict', message: 'returnValue must be an Edict or null'});
      returnCode = `PR.globals_int[${PR.ofs.OFS_RETURN}] = returnValue ? returnValue.num : 0;`;
      break;

    case PR.etype.ev_integer:
      asserts.push({check: '!isNaN(returnValue)', message: 'returnValue must not be NaN'});
      returnCode = `PR.globals_float[${PR.ofs.OFS_RETURN}] = returnValue >> 0;`;
      break;

    case PR.etype.ev_float:
      asserts.push({check: '!isNaN(returnValue)', message: 'returnValue must not be NaN'});
      returnCode = `PR.globals_float[${PR.ofs.OFS_RETURN}] = returnValue;`;
      break;

    case PR.etype.ev_bool:
      asserts.push({check: 'typeof(returnValue) === \'boolean\'', message: 'returnValue must be bool'});
      returnCode = `PR.globals_float[${PR.ofs.OFS_RETURN}] = returnValue;`;
      break;

    case PR.etype.ev_void:
      returnCode = '/* no return value */';
      break;

    case PR.etype.ev_string_not_empty:
      asserts.push({check: 'returnValue !== null && returnValue !== \'\'', message: 'string must not be empty'});
      // eslint-disable-next-line no-fallthrough
    case PR.etype.ev_string:
      returnCode = `PR.globals_int[${PR.ofs.OFS_RETURN}] = PR.TempString(returnValue);`;
      break;

    default:
      throw new TypeError('unsupported return type: ' + returnType);
  }

  const code = `
    ${args.map((def, index) => `
      const arg${index} = ${def};
    `).join('\n')}

    const returnValue = PF._wrapFunctions[${name}](${args.map((_, index) => `arg${index}`).join(', ')});

    ${asserts.map(({check, message}) => `
      PF._assertTrue(${check}, ${JSON.stringify(message)});
    `).join('\n')}

    ${returnCode}`;

  return new Function(code);
};

PF._VarString = function _PF_VarString(first) {
  let i; let out = '';
  for (i = first; i < PR.argc; ++i) {
    out += PR.GetString(PR.globals_int[PR.ofs.OFS_PARM0 + i * 3]);
  }
  return out;
};

PF.error = PF._generateBuiltinFunction(function (str) {
  Con.PrintError('======SERVER ERROR in ' + PR.GetString(PR.xfunction.name) + '\n' + str + '\n');
  ED.Print(SV.server.gameAPI.self);
  Host.Error('Program error: ' + str);
}, [PR.etype.ev_strings]);

PF.objerror = PF._generateBuiltinFunction(function (str) {
  Con.PrintError('======OBJECT ERROR in ' + PR.GetString(PR.xfunction.name) + '\n' + str + '\n');
  ED.Print(SV.server.gameAPI.self);
  Host.Error('Program error: ' + str);
}, [PR.etype.ev_strings]);

PF.makevectors = PF._generateBuiltinFunction(function (vec) {
  const {forward, right, up} = vec.angleVectors();
  SV.server.gameAPI.v_forward = forward;
  SV.server.gameAPI.v_right = right;
  SV.server.gameAPI.v_up = up;
}, [PR.etype.ev_vector]);

PF.setorigin = PF._generateBuiltinFunction((edict, vec)  => edict.setOrigin(vec), [PR.etype.ev_entity, PR.etype.ev_vector], PR.etype.ev_void);

PF.setsize = PF._generateBuiltinFunction((edict, min, max) => edict.setMinMaxSize(min, max), [PR.etype.ev_entity, PR.etype.ev_vector, PR.etype.ev_vector], PR.etype.ev_void);

PF.setmodel = PF._generateBuiltinFunction(function(ed, model) {
  ed.setModel(model);
}, [PR.etype.ev_entity, PR.etype.ev_string]);

PF.bprint = PF._generateBuiltinFunction(ServerEngineAPI.BroadcastPrint, [PR.etype.ev_strings]);

PF.sprint = PF._generateBuiltinFunction((clientEdict, message) => clientEdict.getClient().consolePrint(message), [PR.etype.ev_entity_client, PR.etype.ev_strings]);

PF.centerprint = PF._generateBuiltinFunction((clientEdict, message) => clientEdict.getClient().centerPrint(message), [PR.etype.ev_entity_client, PR.etype.ev_strings]);

PF.normalize = PF._generateBuiltinFunction(function (vec) {
  vec.normalize();

  return vec;
}, [PR.etype.ev_vector], PR.etype.ev_vector);

PF.vlen = PF._generateBuiltinFunction((vec) => vec.len(), [PR.etype.ev_vector], PR.etype.ev_float);

PF.vectoyaw = PF._generateBuiltinFunction((vec) => vec.toYaw(), [PR.etype.ev_vector], PR.etype.ev_float);

PF.vectoangles = PF._generateBuiltinFunction((vec) => vec.toAngles(), [PR.etype.ev_vector], PR.etype.ev_vector);

PF.random = PF._generateBuiltinFunction(Math.random, [], PR.etype.ev_float);

PF.particle = PF._generateBuiltinFunction(ServerEngineAPI.StartParticles, [PR.etype.ev_vector, PR.etype.ev_vector, PR.etype.ev_integer, PR.etype.ev_integer]);

PF.ambientsound = PF._generateBuiltinFunction(ServerEngineAPI.SpawnAmbientSound, [
  PR.etype.ev_vector,
  PR.etype.ev_string_not_empty,
  PR.etype.ev_float,
  PR.etype.ev_float,
], PR.etype.ev_bool);

PF.sound = PF._generateBuiltinFunction(ServerEngineAPI.StartSound, [
  PR.etype.ev_entity,
  PR.etype.ev_integer,
  PR.etype.ev_string_not_empty,
  PR.etype.ev_float,
  PR.etype.ev_float,
], PR.etype.ev_bool);

PF.breakstatement = function PF_breakstatement() { // PR
  Con.Print('break statement\n');
};

PF.traceline = PF._generateBuiltinFunction(function(start, end, noMonsters, passEdict) {
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
  PR.etype.ev_vector,
  PR.etype.ev_vector,
  PR.etype.ev_integer,
  PR.etype.ev_entity,
]);

PF.checkclient = PF._generateBuiltinFunction(() => SV.server.gameAPI.self.getNextBestClient(), [], PR.etype.ev_entity_client);

PF.stuffcmd = PF._generateBuiltinFunction(function(clientEdict, cmd) {
  clientEdict.getClient().sendConsoleCommands(cmd);
}, [PR.etype.ev_entity_client, PR.etype.ev_string]);

PF.localcmd = PF._generateBuiltinFunction(function(cmd) {
  Cmd.text += cmd;
}, [PR.etype.ev_string]);

PF.cvar = PF._generateBuiltinFunction(function(name) {
  const cvar = ServerEngineAPI.GetCvar(name);
  return cvar ? cvar.value : 0.0;
}, [PR.etype.ev_string], PR.etype.ev_float);

PF.cvar_set = PF._generateBuiltinFunction(ServerEngineAPI.SetCvar, [PR.etype.ev_string, PR.etype.ev_string]);

PF.findradius = PF._generateBuiltinFunction((origin, radius) => {
  const edicts = ServerEngineAPI.FindInRadius(origin, radius);

  // doing the chain dance
  let chain = SV.server.edicts[0]; // starts with worldspawn

  // iterate over the list of edicts
  for (const edict of edicts) {
    edict.entity.chain = chain;
    chain = edict;
  }

  return chain;
}, [PR.etype.ev_vector, PR.etype.ev_float], PR.etype.ev_entity);

PF.dprint = function PF_dprint() { // EngineInterface
  Con.DPrint(PF._VarString(0));
};

PF.dprint = PF._generateBuiltinFunction((str) => ServerEngineAPI.ConsoleDebug(str), [PR.etype.ev_strings]);

PF.ftos = PF._generateBuiltinFunction((f) => parseInt(f) == f ? f.toString() : f.toFixed(1), [PR.etype.ev_float], PR.etype.ev_string);

PF.fabs = PF._generateBuiltinFunction(Math.abs, [PR.etype.ev_float], PR.etype.ev_float);

PF.vtos = PF._generateBuiltinFunction((vec) => vec.toString(), [PR.etype.ev_vector], PR.etype.ev_string);

PF.Spawn = PF._generateBuiltinFunction(() => {
  // this is a special null entity we spawn for the QuakeC
  // it will be automatically populated with an EdictProxy
  // the JS Game is supposed to use ServerEngineAPI.SpawnEntity
  const edict = ED.Alloc();
  SV.server.gameAPI.prepareEntity(edict, null, {});
  return edict;
}, [], PR.etype.ev_entity);

PF.Remove = PF._generateBuiltinFunction((edict) => edict.freeEdict(), [PR.etype.ev_entity]);

PF.Find = PF._generateBuiltinFunction((edict, field, value) => {
  return ServerEngineAPI.FindByFieldAndValue(field, value, edict.num + 1);
}, [PR.etype.ev_entity, PR.etype.ev_field, PR.etype.ev_string], PR.etype.ev_entity);

PF.MoveToGoal = PF._generateBuiltinFunction((dist) => {
  return SV.server.gameAPI.self.moveToGoal(dist);
}, [PR.etype.ev_float], PR.etype.ev_bool);

PF.precache_file = PF._generateBuiltinFunction((integer) => {
  return integer; // dummy behavior
}, [PR.etype.ev_integer], PR.etype.ev_integer);

PF.precache_sound = PF._generateBuiltinFunction((sfxName) => {
  return ServerEngineAPI.PrecacheSound(sfxName);
}, [PR.etype.ev_string_not_empty]);

PF.precache_model = PF._generateBuiltinFunction((modelName) => {
  // FIXME: handle this more gracefully
  // if (SV.server.loading !== true) {
  //   PR.RunError('PF.Precache_*: Precache can only be done in spawn functions');
  // }

  return ServerEngineAPI.PrecacheModel(modelName);
}, [PR.etype.ev_string_not_empty]);

PF.coredump = function PF_coredump() {
  ED.PrintEdicts();
};

PF.traceon = function PF_traceon() {
  PR.trace = true;
};

PF.traceoff = function PF_traceoff() {
  PR.trace = false;
};

PF.eprint = function PF_eprint() {
  ED.Print(SV.server.edicts[PR.globals_float[4]]);
};

PF.walkmove = PF._generateBuiltinFunction(function(yaw, dist) {
  const oldf = PR.xfunction; // ???
  const res = SV.server.gameAPI.self.walkMove(yaw, dist);
  PR.xfunction = oldf; // ???

  return res;
}, [PR.etype.ev_float, PR.etype.ev_float], PR.etype.ev_bool);

PF.droptofloor = PF._generateBuiltinFunction(() => SV.server.gameAPI.self.dropToFloor(-256.0), [], PR.etype.ev_bool);

PF.lightstyle = PF._generateBuiltinFunction(ServerEngineAPI.Lightstyle, [PR.etype.ev_integer, PR.etype.ev_string]);

PF.rint = PF._generateBuiltinFunction((f) => (f >= 0.0 ? f + 0.5 : f - 0.5), [PR.etype.ev_float], PR.etype.ev_integer);

PF.floor = PF._generateBuiltinFunction(Math.floor, [PR.etype.ev_float], PR.etype.ev_float);

PF.ceil = PF._generateBuiltinFunction(Math.ceil, [PR.etype.ev_float], PR.etype.ev_float);

PF.checkbottom = PF._generateBuiltinFunction((edict) => edict.isOnTheFloor(), [PR.etype.ev_entity], PR.etype.ev_bool);

PF.pointcontents = PF._generateBuiltinFunction(ServerEngineAPI.DeterminePointContents, [PR.etype.ev_vector], PR.etype.ev_float);

PF.nextent = PF._generateBuiltinFunction((edict) => edict.nextEdict(), [PR.etype.ev_entity], PR.etype.ev_entity);

PF.aim = PF._generateBuiltinFunction((edict) => {
  // CR: `makevectors(self.v_angle);` is called in `W_Attack` and propagates all the way down here
  const dir = SV.server.gameAPI.v_forward;
  return edict.aim(dir);
}, [PR.etype.ev_entity], PR.etype.ev_vector);

PF.changeyaw = PF._generateBuiltinFunction(() => SV.server.gameAPI.self.changeYaw(), []);

PF._WriteDest = function PF_WriteDest(dest) {
  switch (dest) {
    case 0: // broadcast
      return SV.server.datagram;
    case 1: { // one
        // CR: I’m not happy with the structure of the code, Write* needs to be on Edict as well
        const msg_entity = SV.server.gameAPI.msg_entity;
        const entnum = msg_entity.num;
        if (!msg_entity.isClient()) {
          throw new Error('PF._WriteDest: not a client ' + entnum);
        }
        return msg_entity.getClient().message;
      }
    case 2: // all
      return SV.server.reliable_datagram;
    case 3: // init
      return SV.server.signon;
  }
  throw new Error('PF._WriteDest: bad destination ' + dest);
};

for (const fn of ['WriteByte', 'WriteChar', 'WriteShort', 'WriteLong', 'WriteAngle', 'WriteCoord']) {
  PF[fn] = PF._generateBuiltinFunction((dest, val) => MSG[fn](PF._WriteDest(dest), val), [PR.etype.ev_integer, PR.etype.ev_float]);
}

PF.WriteString = PF._generateBuiltinFunction((dest, val) => MSG.WriteString(PF._WriteDest(dest), val), [PR.etype.ev_integer, PR.etype.ev_string]);

PF.WriteEntity = PF._generateBuiltinFunction((dest, val) => MSG.WriteShort(PF._WriteDest(dest), val.num), [PR.etype.ev_integer, PR.etype.ev_entity]);

PF.makestatic = PF._generateBuiltinFunction((edict) => edict.makeStatic(), [PR.etype.ev_entity]);

PF.setspawnparms = PF._generateBuiltinFunction(function (clientEdict) {
  const spawn_parms = clientEdict.getClient().spawn_parms;

  for (let i = 0; i <= 15; ++i) {
    SV.server.gameAPI[`parm${i + 1}`] = spawn_parms[i];
  }
}, [PR.etype.ev_entity_client]);

PF.changelevel = PF._generateBuiltinFunction(ServerEngineAPI.ChangeLevel, [PR.etype.ev_string]);

PF.Fixme = function PF_Fixme() {
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
