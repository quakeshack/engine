/* global ED, Host, Con, COM, Host, Cmd, Q, SV, Sys, Def, PR */

// eslint-disable-next-line no-global-assign
ED = {};

ED.ClearEdict = function(e) {
  e.clear();
  e.free = false;
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
    Con.Print(`WARNING: ED.Alloc triggered max_edicts (${Def.max_edicts})\n`);
  }
  e = SV.server.edicts[SV.server.num_edicts++];
  if (!e) {
    e = new SV.Edict(i);
    SV.server.edicts.push(e);
  }
  ED.ClearEdict(e);
  return e;
};

ED.Free = function(ed) {
  SV.UnlinkEdict(ed);
  ed.free = true;
  ed.api = null;
  // ed.api.model = null;
  // ed.api.takedamage = 0.0;
  // ed.api.modelindex = 0.0;
  // ed.api.colormap = 0.0;
  // ed.api.skin = 0.0;
  // ed.api.frame = 0.0;
  // ed.api.origin = Vector.origin;
  // ed.api.angles = Vector.origin;
  // ed.api.nextthink = -1.0;
  // ed.api.solid = 0.0;
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
  if (ed.isFree()) {
    return;
  }
  Con.Print('\nEDICT ' + ed.num + ':\n');

  for (let i = 1; i < PR.fielddefs.length; i++) {
    const d = PR.fielddefs[i];
    const name = PR.GetString(d.name);

    if (/_[xyz]$/.test(name)) {
      continue;
    }

    Con.Print(`${name.padStart(24, '.')}: ${ed.api[name]}\n`);
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
    if (ent.isFree() === true) {
      continue;
    }
    ++active;
    if (ent.api.solid) {
      ++solid;
    }
    if (ent.api.model) {
      ++models;
    }
    if (ent.api.movetype === SV.movetype.step) {
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

ED._NewString = function(string) {
  const newstring = [];
  for (let i = 0; i < string.length; ++i) {
    const c = string.charCodeAt(i);
    if ((c === 92) && (i < (string.length - 1))) {
      ++i;
      newstring[newstring.length] = (string.charCodeAt(i) === 110) ? '\n' : '\\';
    } else {
      newstring[newstring.length] = String.fromCharCode(c);
    }
  }
  return PR.SetString(null, newstring.join(''));
};

ED.ParseEdict = function() {
  Host.Error('currently not implemented');
};

ED.ParseEdict = function(data, ent, initialData = {}) {
  // If not the world entity, clear the entity data
  // CR: this is required, otherwise we would overwrite data SV.SpawnServer had set prior
  if (ent.num > 0) {
    ent.clear();
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

    if (keyname.startsWith('_')) {
      // Ignore keys starting with "_"
      continue;
    }

    if (anglehack) {
      COM.token = `0 ${COM.token} 0`;
    }

    initialData[keyname] = COM.token;

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
  SV.server.gameAPI.time = SV.server.time;

  while (true) {
    data = COM.Parse(data);
    if (!data) {
      break;
    }

    if (COM.token !== '{') {
      Sys.Error(`ED.LoadFromFile: found ${COM.token} when expecting {`);
    }

    const initialData = {};
    ent = ent ? ED.Alloc() : SV.server.edicts[0];
    data = ED.ParseEdict(data, ent, initialData);

    if (!initialData.classname) {
      Con.Print(`No classname for edict ${ent.num}\n`);
      ED.Free(ent);
      continue;
    }

    const maySpawn = SV.server.gameAPI.prepareEntity(ent, initialData.classname, initialData);

    if (!maySpawn) {
      ED.Free(ent);
      inhibit++;
      continue;
    }

    const spawned = SV.server.gameAPI.spawnEntity(ent);

    if (!spawned) {
      Con.Print(`Could not spawn entity for edict ${ent.num}:\n`);
      ED.Print(ent);
      ED.Free(ent);
      continue;
    }
  }

  Con.DPrint(`${inhibit} entities inhibited\n`);
};
