/* global ED, Host, Con, COM, Host, Cmd, Vector, Q, SV, Sys, Def, PR */

// eslint-disable-next-line no-global-assign
ED = {};

ED.ClearEdict = function(e) {
  let i;
  for (i = 0; i < PR.entityfields; ++i) {
    e.v_int[i] = 0;
  }
  e.free = false;
  SV.PhysicsEngineUnregisterEdict(e);
};

ED.Alloc = function() {
  let i; let e;
  for (i = SV.svs.maxclients + 1; i < SV.server.num_edicts; ++i) {
    e = SV.server.edicts[i];
    if ((e.free === true) && ((e.freetime < 2.0) || ((SV.server.time - e.freetime) > 0.5))) {
      ED.ClearEdict(e);
      return e;
    }
  }
  if (i === Def.max_edicts) {
    Sys.Error('ED.Alloc: no free edicts');
  }
  e = SV.server.edicts[SV.server.num_edicts++];
  ED.ClearEdict(e);
  SV.PhysicsEngineRegisterEdict(e);
  return e;
};

ED.Free = function(ed) {
  SV.UnlinkEdict(ed);
  SV.PhysicsEngineUnregisterEdict(ed);
  ed.free = true;
  ed.v_int[PR.entvars.model] = 0;
  ed.v_float[PR.entvars.takedamage] = 0.0;
  ed.v_float[PR.entvars.modelindex] = 0.0;
  ed.v_float[PR.entvars.colormap] = 0.0;
  ed.v_float[PR.entvars.skin] = 0.0;
  ed.v_float[PR.entvars.frame] = 0.0;
  ED.SetVector(ed, PR.entvars.origin, Vector.origin);
  ED.SetVector(ed, PR.entvars.angles, Vector.origin);
  ed.v_float[PR.entvars.nextthink] = -1.0;
  ed.v_float[PR.entvars.solid] = 0.0;
  ed.freetime = SV.server.time;
};

/**
 * Retrieves the global definition at the specified offset.
 * @param {number} ofs - The offset to retrieve.
 * @return {Object} - The global definition.
 */
ED.GlobalAtOfs = function(ofs) {
  return PR.globaldefs.find((def) => def.ofs === ofs);
};

/**
* Retrieves the field definition at the specified offset.
* @param {number} ofs - The offset to retrieve.
* @return {Object} - The field definition.
*/
ED.FieldAtOfs = function(ofs) {
  return PR.fielddefs.find((def) => def.ofs === ofs);
};

/**
* Finds a field definition by name.
* @param {string} name - The field name.
* @return {Object} - The field definition.
*/
ED.FindField = function(name) {
  return PR.fielddefs.find((def) => PR.GetString(def.name) === name);
};

/**
* Finds a global definition by name.
* @param {string} name - The global name.
* @return {Object} - The global definition.
*/
ED.FindGlobal = function(name) {
  return PR.globaldefs.find((def) => PR.GetString(def.name) === name);
};

/**
* Finds a function definition by name.
* @param {string} name - The function name.
* @return {number} - The function index.
*/
ED.FindFunction = function(name) {
  return PR.functions.findIndex((func) => PR.GetString(func.name) === name);
};

ED.Print = function(ed) {
  if (ed.free === true) {
    return;
  }
  Con.Print('\nEDICT ' + ed.num + ':\n');
  let i; let d; let name; let v;
  for (i = 1; i < PR.fielddefs.length; ++i) {
    d = PR.fielddefs[i];
    name = PR.GetString(d.name);
    if (name.charCodeAt(name.length - 2) === 95) {
      continue;
    }
    v = d.ofs;
    if (ed.v_int[v] === 0) {
      if ((d.type & ~PR.saveglobal) === 3) {
        if ((ed.v_int[v + 1] === 0) && (ed.v_int[v + 2] === 0)) {
          continue;
        }
      } else {
        continue;
      }
    }
    for (; name.length <= 14;) {
      name += ' ';
    }
    Con.Print(name + PR.ValueString(d.type, ed.v, v) + '\n');
  }
};

ED.PrintEdicts = function() {
  if (!SV.server.active) {
    return;
  }

  Con.Print(`${SV.server.num_edicts} entities\n`);
  SV.server.edicts.forEach(ED.Print);
};


ED.PrintEdict_f = function() {
  if (SV.server.active !== true) {
    return;
  }
  if (Cmd.argv.length < 2) {
    Con.Print(`USAGE: ${Cmd.argv[0]} <num>\n`);
    return;
  }
  const i = Q.atoi(Cmd.argv[1]);
  if ((i >= 0) && (i < SV.server.num_edicts)) {
    ED.Print(SV.server.edicts[i]);
  }
};

ED.Count = function() {
  if (SV.server.active !== true) {
    return;
  }
  let i; let ent; let active = 0; let models = 0; let solid = 0; let step = 0;
  for (i = 0; i < SV.server.num_edicts; ++i) {
    ent = SV.server.edicts[i];
    if (ent.free === true) {
      continue;
    }
    ++active;
    if (ent.v_float[PR.entvars.solid] !== 0.0) {
      ++solid;
    }
    if (ent.v_int[PR.entvars.model] !== 0) {
      ++models;
    }
    if (ent.v_float[PR.entvars.movetype] === SV.movetype.step) {
      ++step;
    }
  }
  const num_edicts = SV.server.num_edicts;
  Con.Print('num_edicts:' + (num_edicts <= 9 ? '  ' : (num_edicts <= 99 ? ' ' : '')) + num_edicts + '\n');
  Con.Print('active    :' + (active <= 9 ? '  ' : (active <= 99 ? ' ' : '')) + active + '\n');
  Con.Print('view      :' + (models <= 9 ? '  ' : (models <= 99 ? ' ' : '')) + models + '\n');
  Con.Print('touch     :' + (solid <= 9 ? '  ' : (solid <= 99 ? ' ' : '')) + solid + '\n');
  Con.Print('step      :' + (step <= 9 ? '  ' : (step <= 99 ? ' ' : '')) + step + '\n');
};

ED.ParseGlobals = function(data) {
  while (true) {
    data = COM.Parse(data);
    if (COM.token === '}') {
      return;
    }

    if (!data) Sys.Error('ED.ParseGlobals: EOF without closing brace');

    const keyname = COM.token;
    data = COM.Parse(data);

    if (!data || COM.token === '}') {
      Sys.Error('ED.ParseGlobals: closing brace without data');
    }

    const key = ED.FindGlobal(keyname); // TODO: change to IsGlobal?
    if (!key) {
      Con.Print(`'${keyname}' is not a global\n`);
      continue;
    }

    if (!ED.ParseEpair(PR.globals, key, COM.token)) {
      Host.Error('ED.ParseGlobals: parse error');
    }
  }
};

ED.NewString = function(string) { // TODO: make private
  const newstring = []; let i; let c;
  for (i = 0; i < string.length; ++i) {
    c = string.charCodeAt(i);
    if ((c === 92) && (i < (string.length - 1))) {
      ++i;
      newstring[newstring.length] = (string.charCodeAt(i) === 110) ? '\n' : '\\';
    } else {
      newstring[newstring.length] = String.fromCharCode(c);
    }
  }
  return PR.NewString(newstring.join(''), string.length + 1);
};

ED.ParseEpair = function(base, key, s) { // TODO: access through proxy
  const d_float = new Float32Array(base);
  const d_int = new Int32Array(base);
  let d;
  let v;

  switch (key.type & ~PR.saveglobal) {
    case PR.etype.ev_string:
      // Parse a string and store it
      d_int[key.ofs] = ED.NewString(s);
      return true;

    case PR.etype.ev_float:
      // Parse a float and store it
      d_float[key.ofs] = Q.atof(s);
      return true;

    case PR.etype.ev_vector:
      // Parse a vector (e.g., "x y z")
      v = s.split(' ').map(Q.atof);
      if (v.length !== 3) {
        Con.Print(`Invalid vector: ${s}\n`);
        return false;
      }
      d_float[key.ofs] = v[0];
      d_float[key.ofs + 1] = v[1];
      d_float[key.ofs + 2] = v[2];
      return true;

    case PR.etype.ev_entity:
      // Parse an integer (entity index)
      d_int[key.ofs] = Q.atoi(s);
      return true;

    case PR.etype.ev_field:
      // Parse and find a field by name
      d = ED.FindField(s);
      if (!d) {
        Con.Print(`Can't find field: ${s}\n`);
        return false;
      }
      d_int[key.ofs] = d.ofs;
      return true;

    case PR.etype.ev_function:
      // Parse and find a function by name
      d = ED.FindFunction(s);
      if (!d) {
        Con.Print(`Can't find function: ${s}\n`);
        return false;
      }
      d_int[key.ofs] = d;
      return true;

    default:
      Con.Print(`Unknown key type: ${key.type}\n`);
      return false;
  }
};

ED.ParseEdict = function(data, ent) {
  // If not the world entity, clear the entity data
  if (ent !== SV.server.edicts[0]) {
    for (let i = 0; i < PR.entityfields; ++i) {
      ent.v_int[i] = 0;
    }
  }

  let keyname;
  let anglehack;
  let init = false;

  // Parse until closing brace
  while (true) {
    data = COM.Parse(data);

    if (COM.token.charCodeAt(0) === 125) {
      // Closing brace found
      break;
    }

    if (data == null) {
      Sys.Error('ED.ParseEdict: EOF without closing brace');
    }

    if (COM.token === 'angle') {
      keyname = 'angles';
      anglehack = true;
    } else {
      keyname = COM.token;
      anglehack = false;

      if (keyname === 'light') {
        keyname = 'light_lev'; // Quake 1 convention
      }
    }

    // Remove trailing spaces in keyname
    keyname = keyname.trimEnd();

    // Parse the value
    data = COM.Parse(data);

    if (data == null) {
      Sys.Error('ED.ParseEdict: EOF without closing brace');
    }

    if (COM.token.charCodeAt(0) === 125) {
      Sys.Error('ED.ParseEdict: Closing brace without data');
    }

    if (keyname.charCodeAt(0) === 95) {
      // Ignore keys starting with "_"
      continue;
    }

    const key = ED.FindField(keyname); // TODO: IsField?

    if (key == null) {
      Con.Print(`'${keyname}' is not a field\n`);
      continue;
    }

    if (anglehack) {
      COM.token = `0 ${COM.token} 0`;
    }

    if (ED.ParseEpair(ent.v, key, COM.token) !== true) {
      Host.Error('ED.ParseEdict: parse error');
    }

    init = true;
  }

  // Mark the entity as free if no valid initialization occurred
  if (!init) {
    ent.free = true;
  }

  return data;
};

/**
 * Loads entities from a file.
 * @param {string} data - The data to load.
 */
ED.LoadFromFile = function(data) {
  let inhibit = 0;
  let ent = null;
  SV.server.worldvars.time = SV.server.time;

// data += `

// {
//   "classname" "item_shells"
//   "origin" "528 720 128"
//   "phys_mass" "5"
// }
//   `;

  while (true) {
    data = COM.Parse(data);
    if (!data) {
      break;
    }

    if (COM.token !== '{') {
      Sys.Error(`ED.LoadFromFile: found ${COM.token} when expecting {`);
    }

    ent = ent ? ED.Alloc() : SV.server.edicts[0];
    data = ED.ParseEdict(data, ent);

    const spawnflags = ent.v_float[PR.entvars.spawnflags] | 0;
    if (Host.deathmatch.value !== 0 && (spawnflags & 2048)) {
      ED.Free(ent);
      inhibit++;
      continue;
    }

    const skillFlags = [256, 512, 1024];
    if (skillFlags.some((flag, idx) => Host.current_skill === idx && (spawnflags & flag))) {
      ED.Free(ent);
      inhibit++;
      continue;
    }

    if (!ent.vars.classname) {
      Con.Print('No classname for:\n');
      ED.Print(ent);
      ED.Free(ent);
      continue;
    }

    const func = SV.server.worldvars[ent.vars.classname];
    if (!func) {
      Con.Print('No spawn function for:\n');
      ED.Print(ent);
      ED.Free(ent);
      continue;
    }

    SV.server.worldvars[ent.vars.classname](ent);
  }

  Con.DPrint(`${inhibit} entities inhibited\n`);
};

/**
 * @deprecated
 */
ED.Vector = function(e, o) {
  return new Vector(e.v_float[o], e.v_float[o + 1], e.v_float[o + 2]);
};

/**
 * @deprecated
 */
ED.SetVector = function(e, o, v) {
  e.v_float[o] = v[0];
  e.v_float[o + 1] = v[1];
  e.v_float[o + 2] = v[2];
};
