/*global SV, Sys, COM,  Q, Host, Vector, Con, Cvar, Protocol, MSG, Def, NET, PR, Mod, ED, Cmd, SZ, V, SCR, CANNON, Game */

// eslint-disable-next-line no-global-assign
SV = {};

SV.movetype = {
  none: 0,
  anglenoclip: 1,
  angleclip: 2,
  walk: 3,
  step: 4,
  fly: 5,
  toss: 6,
  push: 7,
  noclip: 8,
  flymissile: 9,
  bounce: 10,
};

SV.solid = {
  not: 0,
  trigger: 1,
  bbox: 2,
  slidebox: 3,
  bsp: 4,
};

SV.damage = {
  no: 0,
  yes: 1,
  aim: 2,
};

SV.fl = {
  fly: 1,
  swim: 2,
  conveyor: 4,
  client: 8,
  inwater: 16,
  monster: 32,
  godmode: 64,
  notarget: 128,
  item: 256,
  onground: 512,
  partialground: 1024,
  waterjump: 2048,
  jumpreleased: 4096,
};

// main

SV.server = {
  num_edicts: 0,
  datagram: {data: new ArrayBuffer(1024), cursize: 0},
  reliable_datagram: {data: new ArrayBuffer(1024), cursize: 0},
  signon: {data: new ArrayBuffer(8192), cursize: 0},
  edicts: [],
  cannon: null,
  progsInterfaces: null,
};

SV.Edict = class Edict {
  constructor(num) {
    this.num = num;
    this.free = false;
    this.area = {
      ent: this,
    };
    this.leafnums = [];
    this.baseline = {
      origin: new Vector(),
      angles: new Vector(),
      modelindex: 0,
      frame: 0,
      colormap: 0,
      skin: 0,
      effects: 0,
    };
    this.freetime = 0.0;
    this.entity = null;
  }

  clear() {
    if (this.entity) {
      this.entity.free();
      this.entity = null;
    }
  }

  /**
   * Edict is no longer in use
   * @returns {boolean} true when freed/unused
   */
  isFree() {
    return this.free || !this.entity;
  }

  toString() {
    if (this.isFree()) {
      return `unused (${this.num})`;
    }

    return `${this.entity.classname} (edict ${this.num} at ${this.entity.origin})`;
  }

  /**
   * Gives up this edict and can be reused differently later.
   */
  freeEdict() {
    ED.Free(this);
  }

  /**
   *
   * @param {SV.Edict} otherEdict other edict
   * @returns {boolean} whether it’s equal
   */
  equals(otherEdict) {
    return otherEdict && this.num === otherEdict.num;
  }

  setMinMaxSize(min, max) {
    if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) {
      throw new Error('Edict.setMinMaxSize: backwards mins/maxs');
    }

    this.entity.mins = min.copy();
    this.entity.maxs = max.copy();
    this.entity.size = max.copy().subtract(min);
    this.linkEdict(true);
  }

  setOrigin(vec) {
    this.entity.origin = vec.copy();
    this.linkEdict(false);
  }

  linkEdict(touchTriggers = false) {
    SV.LinkEdict(this, touchTriggers);
  }

  /**
   * Sets the model, also sets mins/maxs when applicable.
   * Model has to be precached, otherwise an Error is thrown.
   * @throws {Error} Model not precached.
   * @param {string} model path to the model, e.g. progs/player.mdl
   */
  setModel(model) {
    let i;

    for (i = 0; i < SV.server.model_precache.length; ++i) {
      if (SV.server.model_precache[i] === model) {
        break;
      }
    }

    if (i === SV.server.model_precache.length) {
      throw new Error('Edict.setModel: ' + model + ' not precached');
    }

    this.entity.model = model;
    this.entity.modelindex = i;

    const mod = SV.server.models[i];

    if (mod) {
      this.setMinMaxSize(mod.mins, mod.maxs);
    } else {
      this.setMinMaxSize(Vector.origin, Vector.origin);
    }
  }

  /**
   * Moves self in the given direction. Returns success as a boolean.
   * @param {number} yaw
   * @param {number} dist
   * @returns {boolean} true, when walking was successful
   */
  walkMove(yaw, dist) {
    if ((this.entity.flags & (SV.fl.onground + SV.fl.fly + SV.fl.swim)) === 0) {
      return false;
    }

    return SV.movestep(this, [Math.cos(yaw) * dist, Math.sin(yaw) * dist], true);
  }

  /**
   * Makes sure the entity is settled on the ground.
   * @param {number} z maximum distance to look down to check
   * @returns true, when the dropping succeeded
   */
  dropToFloor(z = -2048.0) {
    const end = this.entity.origin.copy().add(new Vector(0.0, 0.0, z));
    const trace = SV.Move(this.entity.origin, this.entity.mins, this.entity.maxs, end, 0, this);

    if (trace.fraction === 1.0 || trace.allsolid) {
      return false;
    }

    this.setOrigin(trace.endpos);
    this.entity.flags |= SV.fl.onground;
    this.entity.groundentity = trace.ent.entity;

    return true;
  }

  /**
   * Checks if the entity is standing on the ground.
   * @returns {boolean} true, when edict touches the ground
   */
  isOnTheFloor() {
    return SV.CheckBottom(this);
  }

  /**
   * It will send a svc_spawnstatic to make clients register a static entity.
   * Also this will free and release this Edict.
   */
  makeStatic() {
    const message = SV.server.signon;
    const angles = this.entity.angles;
    const origin = this.entity.origin;
    MSG.WriteByte(message, Protocol.svc.spawnstatic);
    MSG.WriteByte(message, SV.ModelIndex(this.entity.model));
    MSG.WriteByte(message, this.entity.frame);
    MSG.WriteByte(message, this.entity.colormap);
    MSG.WriteByte(message, this.entity.skin);
    for (let i = 0; i < 3; i++) {
      MSG.WriteCoord(message, origin[i]);
      MSG.WriteAngle(message, angles[i]);
    }
    this.freeEdict();
  }

  /**
   * Returns client (or object that has a client enemy) that would be * a valid target. If there are more than one
   * valid options, they are cycled each frame. If (self.origin + self.viewofs) is not in the PVS of the target, null is returned.
   * @returns {?SV.Edict} Edict when client found, null otherwise
   */
  getNextBestClient() { // TODO: move to GameAPI, this is not interesting for edicts
    // refresh check cache
    if (SV.server.time - SV.server.lastchecktime >= 0.1) {
      let check = SV.server.lastcheck;
      if (check <= 0) {
        check = 1;
      } else if (check > SV.svs.maxclients) {
        check = SV.svs.maxclients;
      }
      let i = 1;
      if (check !== SV.svs.maxclients) {
        i += check;
      }
      let ent;
      for (; ; ++i) {
        if (i === SV.svs.maxclients + 1) {
          i = 1;
        }
        ent = SV.server.edicts[i];
        if (i === check) {
          break;
        }
        if (ent.isFree()) {
          continue;
        }
        if (ent.entity.health <= 0.0 || (ent.entity.flags & SV.fl.notarget) !== 0) {
          continue;
        }
        break;
      }
      SV.server.lastcheck = i;
      SV.lastcheckpvs = Mod.LeafPVS(Mod.PointInLeaf(ent.entity.origin.copy().add(ent.entity.view_ofs), SV.server.worldmodel), SV.server.worldmodel); // FIXME: use ….worldmodel.getPointInLeaf() etc.
      SV.server.lastchecktime = SV.server.time;
    }

    const ent = SV.server.edicts[SV.server.lastcheck];

    if (ent.isFree() || ent.entity.health <= 0.0) { // TODO: better interface, not health
      // not interesting anymore
      return null;
    }

    const l = Mod.PointInLeaf(this.entity.origin.copy().add(this.entity.view_ofs), SV.server.worldmodel).num - 1;

    if (l < 0 || (SV.lastcheckpvs[l >> 3] & (1 << (l & 7))) === 0) {
      // back side leaf or leaf is not visible according to PVS
      return null;
    }

    return ent;
  }

  /**
   * Move this entity toward its goal. Used for monsters.
   * @param {number} dist
   * @returns {boolean} true, when successful
   */
  moveToGoal(dist) {
    if ((this.entity.flags & (SV.fl.onground + SV.fl.fly + SV.fl.swim)) === 0) {
      return false;
    }

    // FIXME: interfaces, edict, entity
    const goal = this.entity.goalentity?.edict ? this.entity.goalentity.edict : this.entity.goalentity;
    const enemy = this.entity.enemy?.edict ? this.entity.enemy.edict : this.entity.enemy;

    console.assert(goal !== null, 'must have goal for moveToGoal');

    if (enemy !== null && !enemy.isWorld() && SV.CloseEnough(this, goal, dist)) {
      return false;
    }

    if (Math.random() >= 0.75 || !SV.StepDirection(this, this.entity.ideal_yaw, dist)) {
      SV.NewChaseDir(this, goal, dist);

      return true;
    }

    return false;
  }

  /**
   * Returns a vector along which this entity can shoot.
   * Usually, this entity is a player, and the vector returned is calculated by auto aiming to the closest enemy entity.
   * NOTE: The original code and unofficial QuakeC reference docs say there’s an argument (speed/misslespeed), but it’s unused.
   * @param {Vector} direction e.g. forward
   * @returns {Vector} aim direction
   */
  aim(direction) {
    const dir = direction.copy();
    const origin = this.entity.origin.copy();
    const start = origin.add(new Vector(0.0, 0.0, 20.0));

    const end = new Vector(start[0] + 2048.0 * dir[0], start[1] + 2048.0 * dir[1], start[2] + 2048.0 * dir[2]);
    const tr = SV.Move(start, Vector.origin, Vector.origin, end, 0, this);
    if (tr.ent !== null) {
      if ((tr.ent.entity.takedamage === SV.damage.aim) && (!Host.teamplay.value || this.entity.team <= 0 || this.entity.team !== tr.ent.entity.team)) {
        return dir;
      }
    }
    const bestdir = dir.copy();
    let bestdist = SV.aim.value;
    let bestent = null;
    for (let i = 1; i < SV.server.num_edicts; ++i) {
      const check = SV.server.edicts[i];
      if (check.isFree()) {
        continue;
      }
      if (check.entity.takedamage !== SV.damage.aim) {
        continue;
      }
      if (check.equals(this)) {
        continue;
      }
      if ((Host.teamplay.value !== 0) && (this.entity.team > 0) && (this.entity.team === check.entity.team)) {
        continue;
      }
      const corigin = check.entity.origin, cmins = check.entity.mins, cmaxs = check.entity.maxs;
      end.set(corigin).add(cmins.copy().add(cmaxs).multiply(0.5));
      dir.set(end).subtract(start);
      dir.normalize();
      let dist = dir.dot(bestdir);
      if (dist < bestdist) {
        continue;
      }
      const tr = SV.Move(start, Vector.origin, Vector.origin, end, 0, this);
      if (tr.ent === check) {
        bestdist = dist;
        bestent = check;
      }
    }
    if (bestent !== null) {
      dir.set(bestent.entity.origin).subtract(this.entity.origin);
      const dist = dir.dot(bestdir);
      end[0] = bestdir[0] * dist;
      end[1] = bestdir[1] * dist;
      end[2] = dir[2];
      end.normalize();
      return end;
    }
    return bestdir;
  }

  /**
   * Returns entity that is just after this in the entity list.
   * Useful to browse the list of entities, because it skips the undefined ones.
   * @returns {SV.Edict | null}
   */
  nextEdict() {
    for (let i = this.num + 1; i < SV.server.num_edicts; ++i) {
      if (!SV.server.edicts[i].isFree()) {
        return SV.server.edicts[i];
      }
    }

    return null;
  }

  /**
   * Change the horizontal orientation of this entity. Turns towards .ideal_yaw at .yaw_speed. Called every 0.1 sec by monsters.
   */
  changeYaw() {
    const angles = this.entity.angles;
    angles[1] = SV.ChangeYaw(this);
    this.entity.angles = angles;

    return angles[1];
  }

  /**
   * returns the corresponding client object
   * @returns {?SV.Client} client object, if edict is actually a client edict
   */
  getClient() {
    return SV.svs.clients[this.num - 1] || null;
  }

  /**
   * check if edict is a client edict
   * @returns {boolean} true, when edict is a client edict
   */
  isClient() {
    return (this.num > 0) && (this.num <= SV.svs.maxclients);
  }

  /**
   * checks if this entity is worldspawn
   * @returns {boolean} true, when edict represents world
   * @deprecated use isWorld instead
   */
  isWorldspawn() {
    return this.num === 0;
  }

  /**
   * checks if this entity is worldspawn
   * @returns {boolean} true, when edict represents world
   */
  isWorld() {
    return this.num === 0;
  }
};

SV.svs = {};

SV.Init = function() {
  SV.maxvelocity = Cvar.RegisterVariable('sv_maxvelocity', '2000');
  SV.gravity = Cvar.RegisterVariable('sv_gravity', '800', false, true);
  SV.friction = Cvar.RegisterVariable('sv_friction', '4', false, true);
  SV.edgefriction = Cvar.RegisterVariable('edgefriction', '2');
  SV.stopspeed = Cvar.RegisterVariable('sv_stopspeed', '100');
  SV.maxspeed = Cvar.RegisterVariable('sv_maxspeed', '320', false, true);
  SV.accelerate = Cvar.RegisterVariable('sv_accelerate', '10');
  SV.idealpitchscale = Cvar.RegisterVariable('sv_idealpitchscale', '0.8');
  SV.aim = Cvar.RegisterVariable('sv_aim', '0.93');
  SV.nostep = Cvar.RegisterVariable('sv_nostep', '0');
  SV.rcon_password = Cvar.RegisterVariable('sv_rcon_password', '', true, true);
  SV.cheats = Cvar.RegisterVariable('sv_cheats', '0');

  SV.nop = {data: new ArrayBuffer(4), cursize: 1};
  (new Uint8Array(SV.nop.data))[0] = Protocol.svc.nop;
  SV.reconnect = {data: new ArrayBuffer(128), cursize: 0};
  MSG.WriteByte(SV.reconnect, Protocol.svc.stufftext);
  MSG.WriteString(SV.reconnect, 'reconnect\n');

  SV.InitBoxHull();
};

SV._scheduledGameCommands = [];

SV.RunScheduledGameCommands = function() {
  while (SV._scheduledGameCommands.length > 0) {
    const command = SV._scheduledGameCommands.shift();

    command();
  }
};

/**
 * Schedules a command to be run during the next server frame.
 * @param {Function} command
 */
SV.ScheduleGameCommand = function(command) {
  SV._scheduledGameCommands.push(command);
}

SV.StartParticle = function(org, dir, color, count) {
  const datagram = SV.server.datagram;
  if (datagram.cursize >= 1009) {
    return;
  }
  MSG.WriteByte(datagram, Protocol.svc.particle);
  MSG.WriteCoord(datagram, org[0]);
  MSG.WriteCoord(datagram, org[1]);
  MSG.WriteCoord(datagram, org[2]);
  let i; let v;
  for (i = 0; i <= 2; ++i) {
    v = (dir[i] * 16.0) >> 0;
    if (v > 127) {
      v = 127;
    } else if (v < -128) {
      v = -128;
    }
    MSG.WriteChar(datagram, v);
  }
  MSG.WriteByte(datagram, count);
  MSG.WriteByte(datagram, color);
};

SV.StartSound = function(edict, channel, sample, volume, attenuation) {
  if ((volume < 0) || (volume > 255)) {
    Sys.Error('SV.StartSound: volume = ' + volume);
  }
  if ((attenuation < 0.0) || (attenuation > 4.0)) {
    Sys.Error('SV.StartSound: attenuation = ' + attenuation);
  }
  if ((channel < 0) || (channel > 7)) {
    Sys.Error('SV.StartSound: channel = ' + channel);
  }

  const datagram = SV.server.datagram;
  if (datagram.cursize >= 1009) {
    return;
  }

  let i;
  for (i = 1; i < SV.server.sound_precache.length; ++i) {
    if (sample === SV.server.sound_precache[i]) {
      break;
    }
  }
  if (i >= SV.server.sound_precache.length) {
    Con.Print('SV.StartSound: ' + sample + ' was not precached\n');
    SV.server.sound_precache.push(sample);
    MSG.WriteByte(datagram, Protocol.svc.loadsound);
    MSG.WriteByte(datagram, i);
    MSG.WriteString(datagram, sample);
  }

  let field_mask = 0;
  if (volume !== 255) {
    field_mask += 1;
  }
  if (attenuation !== 1.0) {
    field_mask += 2;
  }

  MSG.WriteByte(datagram, Protocol.svc.sound);
  MSG.WriteByte(datagram, field_mask);
  if ((field_mask & 1) !== 0) {
    MSG.WriteByte(datagram, volume);
  }
  if ((field_mask & 2) !== 0) {
    MSG.WriteByte(datagram, Math.floor(attenuation * 64.0));
  }
  MSG.WriteShort(datagram, (edict.num << 3) + channel);
  MSG.WriteByte(datagram, i);
  MSG.WriteCoordVector(datagram, edict.entity.origin.copy().add(edict.entity.mins.copy().add(edict.entity.maxs).multiply(0.5)));
};

SV.SendServerinfo = function(client) {
  const message = client.message;
  MSG.WriteByte(message, Protocol.svc.print);
  MSG.WriteString(message, `\x02\nVERSION ${Def.version} SERVER (${SV.server.gameVersion})`);
  MSG.WriteByte(message, Protocol.svc.serverinfo);
  MSG.WriteLong(message, Protocol.version);
  MSG.WriteByte(message, SV.svs.maxclients);
  MSG.WriteByte(message, ((Host.coop.value === 0) && (Host.deathmatch.value !== 0)) ? 1 : 0); // gametype (1 deathmatch, 0 coop/singleplayer)
  MSG.WriteString(message, SV.server.edicts[0].entity.message); // levelname
  let i;
  for (i = 1; i < SV.server.model_precache.length; ++i) {
    MSG.WriteString(message, SV.server.model_precache[i]);
  }
  MSG.WriteByte(message, 0);
  for (i = 1; i < SV.server.sound_precache.length; ++i) {
    MSG.WriteString(message, SV.server.sound_precache[i]);
  }
  MSG.WriteByte(message, 0);
  MSG.WriteByte(message, Protocol.svc.cdtrack);
  MSG.WriteByte(message, SV.server.edicts[0].entity.sounds);
  MSG.WriteByte(message, SV.server.edicts[0].entity.sounds);
  MSG.WriteByte(message, Protocol.svc.setview);
  MSG.WriteShort(message, client.edict.num);
  MSG.WriteByte(message, Protocol.svc.signonnum);
  MSG.WriteByte(message, 1);
  client.sendsignon = true;
  client.spawned = false;
};

SV.ConnectClient = function(clientnum) {
  const client = SV.svs.clients[clientnum];
  const spawn_parms = [];
  if (SV.server.loadgame === true) {
    if (client.spawn_parms == null) {
      client.spawn_parms = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    }
    for (let i = 0; i <= 15; ++i) {
      spawn_parms[i] = client.spawn_parms[i];
    }
  }
  Con.DPrint('Client ' + client.netconnection.address + ' connected\n');
  client.active = true;
  client.dropasap = false;
  client.last_message = 0.0;
  client.cmd = {forwardmove: 0.0, sidemove: 0.0, upmove: 0.0};
  client.wishdir = new Vector();
  client.message.cursize = 0;
  client.edict = SV.server.edicts[clientnum + 1];
  SV.SetClientName(client, 'unconnected');
  client.colors = 0;
  client.ping_times = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  client.num_pings = 0;
  if (SV.server.loadgame !== true) {
    client.spawn_parms = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
      0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  }
  client.old_frags = 0;
  if (SV.server.loadgame === true) {
    for (let i = 0; i <= 15; ++i) {
      client.spawn_parms[i] = spawn_parms[i];
    }
  } else {
    SV.server.gameAPI.SetNewParms(client.edict);
    for (let i = 0; i <= 15; ++i) {
      client.spawn_parms[i] = SV.server.gameAPI[`parm${i + 1}`];
    }
  }
  SV.SendServerinfo(client);
};

SV.fatpvs = [];

SV.CheckForNewClients = function() {
  let ret; let i;
  for (;;) {
    ret = NET.CheckNewConnections();
    if (ret == null) {
      return;
    }
    for (i = 0; i < SV.svs.maxclients; ++i) {
      if (SV.svs.clients[i].active !== true) {
        break;
      }
    }
    if (i === SV.svs.maxclients) {
      Con.Print('SV.CheckForNewClients: Server is full\n');
      const message = {data: new ArrayBuffer(32), cursize: 0};
      MSG.WriteByte(message, Protocol.svc.disconnect);
      MSG.WriteString(message, 'Server is full');
      NET.SendUnreliableMessage(ret, message);
      NET.Close(ret);
      return;
    }
    SV.svs.clients[i].netconnection = ret;
    SV.ConnectClient(i);
    ++NET.activeconnections;
  }
};

SV.AddToFatPVS = function(org, node) {
  let pvs; let i; let normal; let d;
  for (;;) {
    if (node.contents < 0) {
      if (node.contents !== Mod.contents.solid) {
        pvs = Mod.LeafPVS(node, SV.server.worldmodel);
        for (i = 0; i < SV.fatbytes; ++i) {
          SV.fatpvs[i] |= pvs[i];
        }
      }
      return;
    }
    normal = node.plane.normal;
    d = org.dot(normal) - node.plane.dist;
    if (d > 8.0) {
      node = node.children[0];
    } else {
      if (d >= -8.0) {
        SV.AddToFatPVS(org, node.children[0]);
      }
      node = node.children[1];
    }
  }
};

SV.FatPVS = function(org) {
  SV.fatbytes = (SV.server.worldmodel.leafs.length + 31) >> 3;
  let i;
  for (i = 0; i < SV.fatbytes; ++i) {
    SV.fatpvs[i] = 0;
  }
  SV.AddToFatPVS(org, SV.server.worldmodel.nodes[0]);
};

SV.WriteEntitiesToClient = function(clent, msg) {
  SV.FatPVS(clent.entity.origin.copy().add(clent.entity.view_ofs));
  const pvs = SV.fatpvs; let ent; let e; let i; let bits; let miss;
  for (e = 1; e < SV.server.num_edicts; ++e) {
    ent = SV.server.edicts[e];
    if (!ent.equals(clent)) {
      if (ent.isFree()) {
        continue;
      }
      if ((ent.entity.modelindex === 0.0) || !ent.entity.model) {
        continue;
      }
      for (i = 0; i < ent.leafnums.length; ++i) {
        if ((pvs[ent.leafnums[i] >> 3] & (1 << (ent.leafnums[i] & 7))) !== 0) {
          break;
        }
      }
      if (i === ent.leafnums.length) {
        continue;
      }
    }
    if ((msg.data.byteLength - msg.cursize) < 16) {
      Con.Print('packet overflow\n');
      return;
    }

    const angles = ent.entity.angles, origin = ent.entity.origin;

    bits = 0;
    for (i = 0; i <= 2; ++i) {
      miss = origin[i] - ent.baseline.origin[i];
      if ((miss < -0.1) || (miss > 0.1)) {
        bits += Protocol.u.origin1 << i;
      }
    }
    if (angles[0] !== ent.baseline.angles[0]) {
      bits += Protocol.u.angle1;
    }
    if (angles[1] !== ent.baseline.angles[1]) {
      bits += Protocol.u.angle2;
    }
    if (angles[2] !== ent.baseline.angles[2]) {
      bits += Protocol.u.angle3;
    }
    if (ent.entity.movetype === SV.movetype.step) {
      bits += Protocol.u.nolerp;
    }
    if (ent.baseline.colormap !== ent.entity.colormap) {
      bits += Protocol.u.colormap;
    }
    if (ent.baseline.skin !== ent.entity.skin) {
      bits += Protocol.u.skin;
    }
    if (ent.baseline.frame !== ent.entity.frame) {
      bits += Protocol.u.frame;
    }
    if (ent.baseline.effects !== ent.entity.effects) {
      bits += Protocol.u.effects;
    }
    if (ent.baseline.modelindex !== ent.entity.modelindex) {
      bits += Protocol.u.model;
    }
    if (e >= 256) {
      bits += Protocol.u.longentity;
    }
    if (bits >= 256) {
      bits += Protocol.u.morebits;
    }

    MSG.WriteByte(msg, bits + Protocol.u.signal);
    if ((bits & Protocol.u.morebits) !== 0) {
      MSG.WriteByte(msg, bits >> 8);
    }
    if ((bits & Protocol.u.longentity) !== 0) {
      MSG.WriteShort(msg, e);
    } else {
      MSG.WriteByte(msg, e);
    }
    if ((bits & Protocol.u.model) !== 0) {
      MSG.WriteByte(msg, ent.entity.modelindex);
    }
    if ((bits & Protocol.u.frame) !== 0) {
      MSG.WriteByte(msg, ent.entity.frame);
    }
    if ((bits & Protocol.u.colormap) !== 0) {
      MSG.WriteByte(msg, ent.entity.colormap);
    }
    if ((bits & Protocol.u.skin) !== 0) {
      MSG.WriteByte(msg, ent.entity.skin);
    }
    if ((bits & Protocol.u.effects) !== 0) {
      MSG.WriteByte(msg, ent.entity.effects);
    }
    if ((bits & Protocol.u.origin1) !== 0) {
      MSG.WriteCoord(msg, origin[0]);
    }
    if ((bits & Protocol.u.angle1) !== 0) {
      MSG.WriteAngle(msg, angles[0]);
    }
    if ((bits & Protocol.u.origin2) !== 0) {
      MSG.WriteCoord(msg, origin[1]);
    }
    if ((bits & Protocol.u.angle2) !== 0) {
      MSG.WriteAngle(msg, angles[1]);
    }
    if ((bits & Protocol.u.origin3) !== 0) {
      MSG.WriteCoord(msg, origin[2]);
    }
    if ((bits & Protocol.u.angle3) !== 0) {
      MSG.WriteAngle(msg, angles[2]);
    }
  }
};

SV.WriteClientdataToMessage = function(ent, msg) {
  // FIXME: there is too much hard wired stuff happening here
  // FIXME: interfaces, edict, entity
  if ((ent.entity.dmg_take || ent.entity.dmg_save) && ent.entity.dmg_inflictor) {
    const other = ent.entity.dmg_inflictor.edict ? ent.entity.dmg_inflictor.edict : ent.entity.dmg_inflictor; // FIXME: SV.Edict vs BaseEntity
    const vec = !other.isFree() ? other.entity.origin.copy().add(other.entity.mins.copy().add(other.entity.maxs).multiply(0.5)) : ent.entity.origin;
    MSG.WriteByte(msg, Protocol.svc.damage);
    MSG.WriteByte(msg, ent.entity.dmg_save);
    MSG.WriteByte(msg, ent.entity.dmg_take);
    MSG.WriteCoordVector(msg, vec);
    ent.entity.dmg_take = 0.0;
    ent.entity.dmg_save = 0.0;
  }

  SV.SetIdealPitch();

  if (ent.entity.fixangle) {
    MSG.WriteByte(msg, Protocol.svc.setangle);
    MSG.WriteAngleVector(msg, ent.entity.angles);
    ent.entity.fixangle = false;
  };

  let bits = Protocol.su.items + Protocol.su.weapon;
  if (ent.entity.view_ofs[2] !== Protocol.default_viewheight) {
    bits += Protocol.su.viewheight;
  }
  if (ent.entity.idealpitch !== 0.0) {
    bits += Protocol.su.idealpitch;
  }

  let items;
  if (ent.entity.items2 !== undefined) {
    if (ent.entity.items2 !== 0.0) {
      items = (ent.entity.items >> 0) + ((ent.entity.items2 << 23) >>> 0);
    } else {
      items = (ent.entity.items >> 0) + ((SV.server.gameAPI.serverflags << 28) >>> 0);
    }
  } else {
    items = (ent.entity.items >> 0) + ((SV.server.gameAPI.serverflags << 28) >>> 0);
  }

  if (ent.entity.flags & SV.fl.onground) {
    bits += Protocol.su.onground;
  }
  if (ent.entity.waterlevel >= 2.0) {
    bits += Protocol.su.inwater;
  }

  const velo = ent.entity.velocity, punchangle = ent.entity.punchangle;

  if (punchangle[0] !== 0.0) {
    bits += Protocol.su.punch1;
  }
  if (velo[0] !== 0.0) {
    bits += Protocol.su.velocity1;
  }
  if (punchangle[1] !== 0.0) {
    bits += Protocol.su.punch2;
  }
  if (velo[1] !== 0.0) {
    bits += Protocol.su.velocity2;
  }
  if (punchangle[2] !== 0.0) {
    bits += Protocol.su.punch3;
  }
  if (velo[2] !== 0.0) {
    bits += Protocol.su.velocity3;
  }

  if (ent.entity.weaponframe !== 0.0) {
    bits += Protocol.su.weaponframe;
  }
  if (ent.entity.armorvalue !== 0.0) {
    bits += Protocol.su.armor;
  }

  MSG.WriteByte(msg, Protocol.svc.clientdata);
  MSG.WriteShort(msg, bits);
  if ((bits & Protocol.su.viewheight) !== 0) {
    MSG.WriteChar(msg, ent.entity.view_ofs[2]);
  }
  if ((bits & Protocol.su.idealpitch) !== 0) {
    MSG.WriteChar(msg, ent.entity.idealpitch);
  }

  if ((bits & Protocol.su.punch1) !== 0) {
    MSG.WriteShort(msg, punchangle[0] * 90);
  }
  if ((bits & Protocol.su.velocity1) !== 0) {
    MSG.WriteChar(msg, velo[0] * 0.0625);
  }
  if ((bits & Protocol.su.punch2) !== 0) {
    MSG.WriteShort(msg, punchangle[1] * 90.0);
  }
  if ((bits & Protocol.su.velocity2) !== 0) {
    MSG.WriteChar(msg, velo[1] * 0.0625);
  }
  if ((bits & Protocol.su.punch3) !== 0) {
    MSG.WriteShort(msg, punchangle[2] * 90.0);
  }
  if ((bits & Protocol.su.velocity3) !== 0) {
    MSG.WriteChar(msg, velo[2] * 0.0625);
  }

  MSG.WriteLong(msg, items);
  if ((bits & Protocol.su.weaponframe) !== 0) {
    MSG.WriteByte(msg, ent.entity.weaponframe);
  }
  if ((bits & Protocol.su.armor) !== 0) {
    MSG.WriteByte(msg, ent.entity.armorvalue);
  }
  MSG.WriteByte(msg, SV.ModelIndex(ent.entity.weaponmodel));
  MSG.WriteShort(msg, ent.entity.health);
  MSG.WriteByte(msg, ent.entity.currentammo);
  MSG.WriteByte(msg, ent.entity.ammo_shells);
  MSG.WriteByte(msg, ent.entity.ammo_nails);
  MSG.WriteByte(msg, ent.entity.ammo_rockets);
  MSG.WriteByte(msg, ent.entity.ammo_cells);
  if (COM.standard_quake === true) {
    MSG.WriteByte(msg, ent.entity.weapon);
  } else {
    const weapon = ent.entity.weapon;
    for (let i = 0; i <= 31; ++i) {
      if ((weapon & (1 << i)) !== 0) {
        MSG.WriteByte(msg, i);
        break;
      }
    }
  }
};

SV.clientdatagram = {data: new ArrayBuffer(1024), cursize: 0};
SV.SendClientDatagram = function() { // FIXME: Host.client
  const client = Host.client;
  const msg = SV.clientdatagram;
  msg.cursize = 0;
  MSG.WriteByte(msg, Protocol.svc.time);
  MSG.WriteFloat(msg, SV.server.time);

  // Send ping times to all clients every second
  if (Host.realtime - client.last_ping_update >= 1) {
    for (let i = 0; i < SV.svs.clients.length; i++) {
      const pingClient = SV.svs.clients[i];

      if (!pingClient.active) {
        continue;
      }

      const ping = Math.round((pingClient.ping_times.reduce((sum, elem) => sum + elem) / pingClient.ping_times.length) * 1000);
      MSG.WriteByte(msg, Protocol.svc.updatepings);
      MSG.WriteByte(msg, i);
      MSG.WriteShort(msg, ping);
    }

    client.last_ping_update = Host.realtime;
  }

  SV.WriteClientdataToMessage(client.edict, msg);
  SV.WriteEntitiesToClient(client.edict, msg);
  if ((msg.cursize + SV.server.datagram.cursize) < msg.data.byteLength) {
    SZ.Write(msg, new Uint8Array(SV.server.datagram.data), SV.server.datagram.cursize);
  }
  if (NET.SendUnreliableMessage(client.netconnection, msg) === -1) {
    Host.DropClient(client, true, 'Connectivity issues');
    return false;
  }
  return true;
};

SV.UpdateToReliableMessages = function() {
  let i; let frags; let j; let client;

  for (i = 0; i < SV.svs.maxclients; ++i) {
    Host.client = SV.svs.clients[i];
    frags = Host.client.edict.entity ? Host.client.edict.entity.frags | 0 : 0; // force int
    if (Host.client.old_frags === frags) {
      continue;
    }
    for (j = 0; j < SV.svs.maxclients; ++j) {
      client = SV.svs.clients[j];
      if (!client.active) {
        continue;
      }
      MSG.WriteByte(client.message, Protocol.svc.updatefrags);
      MSG.WriteByte(client.message, i);
      MSG.WriteShort(client.message, frags);
    }
    Host.client.old_frags = frags;
  }

  for (i = 0; i < SV.svs.maxclients; ++i) {
    client = SV.svs.clients[i];
    if (client.active === true) {
      SZ.Write(client.message, new Uint8Array(SV.server.reliable_datagram.data), SV.server.reliable_datagram.cursize);
    }
  }

  SV.server.reliable_datagram.cursize = 0;
};

SV.SendClientMessages = function() {
  SV.UpdateToReliableMessages();
  let i; let client;
  for (i = 0; i < SV.svs.maxclients; ++i) {
    Host.client = client = SV.svs.clients[i]; // FIXME: Host.client
    if (client.active !== true) {
      continue;
    }
    if (client.spawned === true) {
      if (SV.SendClientDatagram() !== true) {
        continue;
      }
    } else if (client.sendsignon !== true) {
      if ((Host.realtime - client.last_message) > 5.0) {
        if (NET.SendUnreliableMessage(client.netconnection, SV.nop) === -1) {
          Host.DropClient(client, true, 'Connectivity issues');
        }
        client.last_message = Host.realtime;
      }
      continue;
    }
    if (client.message.overflowed === true) {
      Host.DropClient(client, true, 'Connectivity issues, too many messages');
      client.message.overflowed = false;
      continue;
    }
    if (client.dropasap === true) {
      if (NET.CanSendMessage(client.netconnection) === true) {
        Host.DropClient(client, false, 'Connectivity issues, ASAP drop requested');
      }
    } else if (client.message.cursize !== 0) {
      if (NET.CanSendMessage(client.netconnection) !== true) {
        continue;
      }
      if (NET.SendMessage(client.netconnection, client.message) === -1) {
        Host.DropClient(client, true, 'Connectivity issues, failed to send message');
      }
      client.message.cursize = 0;
      client.last_message = Host.realtime;
      client.sendsignon = false;
    }
  }

  for (i = 1; i < SV.server.num_edicts; ++i) {
    if (SV.server.edicts[i].isFree()) {
      continue;
    }

    SV.server.edicts[i].entity.effects &= (~Mod.effects.muzzleflash >>> 0);
  }
};

SV.ModelIndex = function(name) {
  if (name == null) {
    return 0;
  }
  if (name.length === 0) {
    return 0;
  }
  let i;
  for (i = 0; i < SV.server.model_precache.length; ++i) {
    if (SV.server.model_precache[i] === name) {
      return i;
    }
  }
  Sys.Error('SV.ModelIndex: model ' + name + ' not precached');
};

SV.CreateBaseline = function() {
  let i; let svent; let baseline;
  const player = SV.ModelIndex('progs/player.mdl');
  const signon = SV.server.signon;
  for (i = 0; i < SV.server.num_edicts; ++i) {
    svent = SV.server.edicts[i];
    if (svent.isFree()) {
      continue;
    }
    if ((i > SV.svs.maxclients) && !svent.entity.modelindex) {
      continue;
    }
    baseline = svent.baseline;
    baseline.origin = svent.entity.origin.copy();
    baseline.angles = svent.entity.angles.copy();
    baseline.frame = svent.entity.frame >> 0;
    baseline.skin = svent.entity.skin >> 0;
    if ((i > 0) && (i <= SV.server.maxclients)) {
      baseline.colormap = i;
      baseline.modelindex = player;
    } else {
      baseline.colormap = 0;
      baseline.modelindex = SV.ModelIndex(svent.entity.model);
    }
    MSG.WriteByte(signon, Protocol.svc.spawnbaseline);
    MSG.WriteShort(signon, i);
    MSG.WriteByte(signon, baseline.modelindex);
    MSG.WriteByte(signon, baseline.frame);
    MSG.WriteByte(signon, baseline.colormap);
    MSG.WriteByte(signon, baseline.skin);
    MSG.WriteCoord(signon, baseline.origin[0]);
    MSG.WriteAngle(signon, baseline.angles[0]);
    MSG.WriteCoord(signon, baseline.origin[1]);
    MSG.WriteAngle(signon, baseline.angles[1]);
    MSG.WriteCoord(signon, baseline.origin[2]);
    MSG.WriteAngle(signon, baseline.angles[2]);
  }
};

SV.SaveSpawnparms = function() {
  SV.svs.serverflags = SV.server.gameAPI.serverflags;
  for (let i = 0; i < SV.svs.maxclients; ++i) {
    Host.client = SV.svs.clients[i];
    if (Host.client.active !== true) {
      continue;
    }
    SV.server.gameAPI.SetChangeParms(Host.client.edict);
    for (let j = 0; j <= 15; ++j) {
      Host.client.spawn_parms[j] = SV.server.gameAPI[`parm${j + 1}`];
    }
  }
};

SV.HasMap = function(mapname) {
  return Mod.ForName('maps/' + mapname + '.bsp') !== null;
};

SV.SpawnServer = function(mapname) {
  let i;

  if (NET.hostname.string.length === 0) {
    Cvar.Set('hostname', 'UNNAMED');
  }

  if (!Host.dedicated.value) {
    SCR.centertime_off = 0.0;
  }

  Con.DPrint('SpawnServer: ' + mapname + '\n');
  SV.svs.changelevel_issued = false;

  if (SV.server.active === true) {
    NET.SendToAll(SV.reconnect);
    if (!Host.dedicated.value) {
      Cmd.ExecuteString('reconnect\n');
    }
  }

  if (Host.coop.value !== 0) {
    Cvar.SetValue('deathmatch', 0);
  }
  Host.current_skill = Math.floor(Host.skill.value + 0.5);
  if (Host.current_skill < 0) {
    Host.current_skill = 0;
  } else if (Host.current_skill > 3) {
    Host.current_skill = 3;
  }
  Cvar.SetValue('skill', Host.current_skill);

  Con.DPrint('Clearing memory\n');
  Mod.ClearAll();

  SV.server.gameAPI = PR.QuakeJS ? new PR.QuakeJS.ServerGameAPI(Game.EngineInterface) : PR.LoadProgs();

  SV.server.gameVersion = `${(PR.QuakeJS ? `${PR.QuakeJS.identification.version.join('.')} QuakeJS` : `${PR.crc} CRC`)}`;

  SV.server.edicts = [];
  // preallocating up to max_edicts, we can extend that later during runtime
  for (i = 0; i < Def.max_edicts; ++i) {
    const ent = new SV.Edict(i);

    SV.server.edicts[i] = ent;
  }
  SV.server.cannon = {
    world: new CANNON.World(),
    lastTime: null,
    active: false,
  };
  SV.server.cannon.world.gravity.set(0, 0, -9.82);
  SV.server.datagram.cursize = 0;
  SV.server.reliable_datagram.cursize = 0;
  SV.server.signon.cursize = 0;
  // hooking up the edicts reserved for clients
  SV.server.num_edicts = SV.svs.maxclients + 1;
  for (i = 0; i < SV.svs.maxclients; ++i) {
    const ent = SV.server.edicts[i + 1];

    // we need to spawn the player entity in those client edict slots
    if (!SV.server.gameAPI.prepareEntity(ent, 'player')) {
      Con.Print('Cannot start server: The game does not know what a player entity is.\n');
      SV.server.active = false;
      return false;
    }

    SV.svs.clients[i].edict = ent;
  }
  SV.server.loading = true;
  SV.server.paused = false;
  SV.server.loadgame = false;
  SV.server.time = 1.0;
  SV.server.lastcheck = 0;
  SV.server.lastchecktime = 0.0;
  SV.server.gameAPI.mapname = mapname;
  SV.server.modelname = 'maps/' + mapname + '.bsp';
  SV.server.worldmodel = Mod.ForName(SV.server.modelname);
  if (SV.server.worldmodel === null) {
    Con.Print('Couldn\'t spawn server ' + SV.server.modelname + '\n');
    SV.server.active = false;
    return false;
  }
  SV.server.models = [];
  SV.server.models[1] = SV.server.worldmodel;

  SV.areanodes = [];
  SV.CreateAreaNode(0, SV.server.worldmodel.mins, SV.server.worldmodel.maxs);

  SV.server.sound_precache = [''];
  SV.server.model_precache = ['', SV.server.modelname];
  for (i = 1; i <= SV.server.worldmodel.submodels.length; ++i) {
    // TODO: do we really need this? (yes we do, PF, CL and Host etc. rely on it)
    //       also each submodule is a brush connected to an entity (doors etc.)
    SV.server.model_precache[i + 1] = '*' + i;
    SV.server.models[i + 1] = Mod.ForName('*' + i);
  }

  SV.server.lightstyles = [];
  for (i = 0; i <= 63; ++i) {
    SV.server.lightstyles[i] = '';
  }

  // edict 0 is reserved for worldspawn
  const ent = SV.server.edicts[0];

  if (!SV.server.gameAPI.prepareEntity(ent, 'worldspawn', {
    model: SV.server.modelname,
    modelindex: 1,
    solid: SV.solid.bsp,
    movetype: SV.movetype.push,
  })) {
    Con.Print('Cannot start server: The game does not know what a worldspawn entity is.\n');
    SV.server.active = false;
    return false;
  }

  SV.server.gameAPI.serverflags = SV.svs.serverflags;
  SV.server.gameAPI.mapname = mapname;
  SV.server.gameAPI.coop = Host.coop.value; // QuakeC quirks
  SV.server.gameAPI.deathmatch = Host.deathmatch.value; // QuakeC quirks

  // NOTE: not calling ent.entity.spawn(); here, it’s done by ED.LoadFromFile

  // populate all edicts by the entities file
  ED.LoadFromFile(SV.server.worldmodel.entities);
  SV.server.active = true;
  SV.server.loading = false;
  Host.frametime = 0.1;
  SV.InitPhysicsEngine();
  SV.Physics();
  SV.Physics();
  SV.CreateBaseline();
  for (i = 0; i < SV.svs.maxclients; ++i) {
    Host.client = SV.svs.clients[i];
    if (Host.client.active !== true) {
      continue;
    }
    SV.SendServerinfo(Host.client);
  }
  Con.Print('Server spawned.\n');
  return true;
};

SV.ShutdownServer = function (isCrashShutdown) {
  // make sure all references are dropped
  SV.server.active = false;
  SV.server.loading = false;
  SV.server.progsInterfaces = null;
  SV.server.cannon = null;
  SV.server.worldmodel = null;
  SV.server.gameAPI = null;

  // purge out all edicts and clients
  for (const edict of SV.server.edicts) {
    // explicitly tell entities to free memory
    edict.clear();
    edict.freeEdict();
  }
  SV.server.edicts = [];
  SV.server.num_edicts = 0;

  // unlink all edicts from client structures, reset data
  for (const client of SV.svs.clients) {
    client.clear();
  }

  if (isCrashShutdown) {
    Con.Print('Server shut down due to a crash!\n');
    return;
  }

  Con.Print('Server shut down.\n');
}

SV.GetClientName = function(client) {
  return client.name;
};

SV.SetClientName = function(client, name) {
  client.name = name;
  client.edict.entity.netname = name; // tell the game the client name too
};

// move

SV.CheckBottom = function(ent) {
  const STEPSIZE = 18.0;
  const mins = ent.entity.origin.copy().add(ent.entity.mins);
  const maxs = ent.entity.origin.copy().add(ent.entity.maxs);
  for (;;) {
    if (SV.PointContents(new Vector(mins[0], mins[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    if (SV.PointContents(new Vector(mins[0], maxs[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    if (SV.PointContents(new Vector(maxs[0], mins[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    if (SV.PointContents(new Vector(maxs[0], maxs[1], mins[2] - 1.0)) !== Mod.contents.solid) {
      break;
    }
    return true;
  }
  const start = new Vector((mins[0] + maxs[0]) * 0.5, (mins[1] + maxs[1]) * 0.5, mins[2]);
  const stop = new Vector(start[0], start[1], start[2] - 2.0 * STEPSIZE);
  let trace = SV.Move(start, Vector.origin, Vector.origin, stop, SV.move.nomonsters, ent);
  if (trace.fraction === 1.0) {
    return false;
  }
  let bottom = trace.endpos[2];
  const mid = bottom;
  let x; let y;
  for (x = 0; x <= 1; ++x) {
    for (y = 0; y <= 1; ++y) {
      start[0] = stop[0] = (x !== 0) ? maxs[0] : mins[0];
      start[1] = stop[1] = (y !== 0) ? maxs[1] : mins[1];
      trace = SV.Move(start, Vector.origin, Vector.origin, stop, SV.move.nomonsters, ent);
      if ((trace.fraction !== 1.0) && (trace.endpos[2] > bottom)) {
        bottom = trace.endpos[2];
      }
      if ((trace.fraction === 1.0) || ((mid - trace.endpos[2]) > STEPSIZE)) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Called by monster program code.
 * The move will be adjusted for slopes and stairs, but if the move isn't
 * possible, no move is done, false is returned, and
 * pr_global_struct->trace_normal is set to the normal of the blocking wall
 * @param {SV.Edict} ent edict/entity trying to move
 * @param {Vector} move move direction
 * @param {boolean} relink if true, it will call SV.LinkEdict
 * @returns {boolean} false, if no move is done
 */
SV.movestep = function(ent, move, relink) { // FIXME: return type = boolean
  const STEPSIZE = 18.0;
  const oldorg = ent.entity.origin.copy();
  const mins = ent.entity.mins;
  const maxs = ent.entity.maxs;
  // flying monsters don't step up
  if ((ent.entity.flags & (SV.fl.swim | SV.fl.fly)) !== 0) {
    const enemy = ent.entity.enemy;
    const neworg = new Vector();
    // try one move with vertical motion, then one without
    for (let i = 0; i <= 1; ++i) {
      const origin = ent.entity.origin.copy();
      neworg[0] = origin[0] + move[0];
      neworg[1] = origin[1] + move[1];
      neworg[2] = origin[2];
      if (i === 0 && enemy) {
        const dz = ent.entity.origin[2] - enemy.entity.origin[2];
        if (dz > 40.0) {
          neworg[2] -= 8.0;
        } else if (dz < 30.0) {
          neworg[2] += 8.0;
        }
      }
      const trace = SV.Move(ent.entity.origin, mins, maxs, neworg, SV.move.normal, ent);
      if (trace.fraction === 1.0) {
        if (((ent.entity.flags & SV.fl.swim) !== 0) && (SV.PointContents(trace.endpos) === Mod.contents.empty)) {
          return false; // swim monster left water
        }
        ent.entity.origin = trace.endpos.copy();
        if (relink) {
          SV.LinkEdict(ent, true);
        }
        return true;
      }
      if (!enemy) {
        return false;
      }
    }
    return false;
  }
  // push down from a step height above the wished position
  const neworg = ent.entity.origin.copy();
  neworg[0] += move[0];
  neworg[1] += move[1];
  neworg[2] += STEPSIZE;
  const end = neworg.copy();
  end[2] -= STEPSIZE * 2.0;
  const trace = SV.Move(neworg, mins, maxs, end, SV.move.normal, ent);
  if (trace.allsolid === true) {
    return false;
  }
  if (trace.startsolid === true) {
    neworg[2] -= STEPSIZE;
    const trace = SV.Move(neworg, mins, maxs, end, SV.move.normal, ent);
    if ((trace.allsolid === true) || (trace.startsolid === true)) {
      return false;
    }
  }
  // CR: FIXME: there’s a significant difference from WinQuake’s SV_movestep
  if (trace.fraction === 1.0) {
    // if monster had the ground pulled out, go ahead and fall
    if ((ent.entity.flags & SV.fl.partialground) !== 0) {
      const neworg = ent.entity.origin.copy();
      neworg[0] += move[0];
      neworg[1] += move[1];
      ent.entity.origin = neworg;
      if (relink) {
        SV.LinkEdict(ent, true);
      }
      ent.entity.flags &= (~SV.fl.onground);
      return true;
    }

    return false; // walked off an edge
  }
  ent.entity.origin = trace.endpos.copy();
  if (!SV.CheckBottom(ent)) {
    if ((ent.entity.flags & SV.fl.partialground) !== 0) {
      if (relink) {
        SV.LinkEdict(ent, true);
      }
      return true;
    }
    ent.entity.origin = ent.entity.origin.set(oldorg);
    return false;
  }
  ent.entity.flags &= (~SV.fl.partialground >>> 0);
  ent.entity.groundentity = trace.ent.entity;
  if (relink) {
    SV.LinkEdict(ent, true);
  }
  return true;
};

SV.ChangeYaw = function (ent) { // Edict
  const angle1 = ent.entity.angles[1];
  const current = Vector.anglemod(angle1);
  const ideal = ent.entity.ideal_yaw;

  if (current === ideal) {
    return angle1;
  }

  let move = ideal - current;

  if (ideal > current) {
    if (move >= 180.0) {
      move -= 360.0;
    }
  } else if (move <= -180.0) {
    move += 360.0;
  }

  const speed = ent.entity.yaw_speed;

  if (move > 0.0) {
    if (move > speed) {
      move = speed;
    }
  } else if (move < -speed) {
    move = -speed;
  }

  return Vector.anglemod(current + move);
}

SV.StepDirection = function(ent, yaw, dist) {
  ent.entity.ideal_yaw = yaw;
  ent.entity.angles = new Vector(ent.entity.angles[0], SV.ChangeYaw(ent), ent.entity.angles[2]); // CR: I’m not happy about this line
  yaw *= Math.PI / 180.0;
  const oldorigin = ent.entity.origin.copy();
  if (SV.movestep(ent, [Math.cos(yaw) * dist, Math.sin(yaw) * dist], false)) {
    const delta = ent.entity.angles[1] - ent.entity.ideal_yaw;
    if ((delta > 45.0) && (delta < 315.0)) {
      ent.entity.origin = ent.entity.origin.set(oldorigin);
    }
    SV.LinkEdict(ent, true);
    return true;
  }
  SV.LinkEdict(ent, true);
  return false;
};

SV.NewChaseDir = function(actor, enemy, dist) {
  const olddir = Vector.anglemod(((actor.entity.ideal_yaw / 45.0) >> 0) * 45.0);
  const turnaround = Vector.anglemod(olddir - 180.0);
  const deltax = enemy.entity.origin[0] - actor.entity.origin[0];
  const deltay = enemy.entity.origin[1] - actor.entity.origin[1];
  let dx; let dy;
  if (deltax > 10.0) {
    dx = 0.0;
  } else if (deltax < -10.0) {
    dx = 180.0;
  } else {
    dx = -1;
  }
  if (deltay < -10.0) {
    dy = 270.0;
  } else if (deltay > 10.0) {
    dy = 90.0;
  } else {
    dy = -1;
  }
  let tdir;
  if ((dx !== -1) && (dy !== -1)) {
    if (dx === 0.0) {
      tdir = (dy === 90.0) ? 45.0 : 315.0;
    } else {
      tdir = (dy === 90.0) ? 135.0 : 215.0;
    }
    if ((tdir !== turnaround) && SV.StepDirection(actor, tdir, dist)) {
      return;
    }
  }
  if ((Math.random() >= 0.25) || (Math.abs(deltay) > Math.abs(deltax))) {
    tdir = dx;
    dx = dy;
    dy = tdir;
  }
  if ((dx !== -1) && (dx !== turnaround) && SV.StepDirection(actor, dx, dist)) {
    return;
  }
  if ((dy !== -1) && (dy !== turnaround) && SV.StepDirection(actor, dy, dist)) {
    return;
  }
  if ((olddir !== -1) && SV.StepDirection(actor, olddir, dist)) {
    return;
  }
  if (Math.random() >= 0.5) {
    for (tdir = 0.0; tdir <= 315.0; tdir += 45.0) {
      if ((tdir !== turnaround) && SV.StepDirection(actor, tdir, dist)) {
        return;
      }
    }
  } else {
    for (tdir = 315.0; tdir >= 0.0; tdir -= 45.0) {
      if ((tdir !== turnaround) && SV.StepDirection(actor, tdir, dist)) {
        return;
      }
    }
  }
  if ((turnaround !== -1) && SV.StepDirection(actor, turnaround, dist)) {
    return;
  }
  actor.entity.ideal_yaw = olddir;
  if (!SV.CheckBottom(actor)) {
    actor.entity.flags |= SV.fl.partialground;
  }
};

SV.CloseEnough = function(ent, goal, dist) { // Edict
  const absmin = ent.entity.absmin, absmax = ent.entity.absmax;
  const absminGoal = goal.entity.absmin, absmaxGoal = goal.entity.absmax;
  for (let i = 0; i <= 2; ++i) {
    if (absminGoal[i] > (absmax[i] + dist)) {
      return false;
    }
    if (absmaxGoal[i] < (absmin[i] - dist)) {
      return false;
    }
  }
  return true;
};

// phys

SV.CheckAllEnts = function() {
  let e; let check;
  for (e = 1; e < SV.server.num_edicts; ++e) {
    check = SV.server.edicts[e];
    if (check.isFree() === true) {
      continue;
    }
    switch (check.entity.movetype) {
      case SV.movetype.push:
      case SV.movetype.none:
      case SV.movetype.noclip:
        continue;
    }
    if (SV.TestEntityPosition(check) === true) {
      Con.Print('entity in invalid position\n');
    }
  }
};

SV.CheckVelocity = function(ent) {
  const velo = ent.entity.velocity, origin = ent.entity.origin;
  for (let i = 0; i <= 2; ++i) {
    let component = velo[i];
    if (Q.isNaN(component)) {
      Con.Print('Got a NaN velocity on ' + ent.entity.classname + '\n');
      component = 0.0;
    }
    if (Q.isNaN(origin[i])) {
      Con.Print('Got a NaN origin on ' + ent.entity.classname + '\n');
      origin[i] = 0.0;
    }
    if (component > SV.maxvelocity.value) {
      component = SV.maxvelocity.value;
    } else if (component < -SV.maxvelocity.value) {
      component = -SV.maxvelocity.value;
    }
    velo[i] = component;
  }
  ent.entity.origin = ent.entity.origin.set(origin);
  ent.entity.velocity = ent.entity.velocity.set(velo);
};

/**
 * @param {SV.Edict} ent edict
 * @returns {boolean} whether false when an edict got freed
 */
SV.RunThink = function(ent) {
  let thinktime = ent.entity.nextthink;
  if ((thinktime <= 0.0) || (thinktime > (SV.server.time + Host.frametime))) {
    return true;
  }
  if (thinktime < SV.server.time) {
    thinktime = SV.server.time;
  }
  ent.entity.nextthink = 0.0;
  SV.server.gameAPI.time = thinktime;
  ent.entity.think(null);
  return !ent.isFree(); // think might have deleted the edict
};

SV.Impact = function(e1, e2) {
  SV.server.gameAPI.time = SV.server.time;

  if (e1.entity.touch && (e1.entity.solid !== SV.solid.not)) {
    e1.entity.touch(e2.entity);
  }
  if (e2.entity.touch && (e2.entity.solid !== SV.solid.not)) {
    e2.entity.touch(e1.entity);
  }
};

SV.ClipVelocity = function(vec, normal, out, overbounce) {
  const backoff = vec.dot(normal) * overbounce;

  out[0] = vec[0] - normal[0] * backoff;
  if ((out[0] > -0.1) && (out[0] < 0.1)) {
    out[0] = 0.0;
  }
  out[1] = vec[1] - normal[1] * backoff;
  if ((out[1] > -0.1) && (out[1] < 0.1)) {
    out[1] = 0.0;
  }
  out[2] = vec[2] - normal[2] * backoff;
  if ((out[2] > -0.1) && (out[2] < 0.1)) {
    out[2] = 0.0;
  }
};

SV.FlyMove = function(ent, time) {
  let bumpcount;
  let numplanes = 0;
  let dir;
  const planes = []; let plane;
  const primal_velocity = ent.entity.velocity;
  let original_velocity = ent.entity.velocity;
  const new_velocity = new Vector();
  let i; let j;
  let time_left = time;
  let blocked = 0;
  for (bumpcount = 0; bumpcount <= 3; ++bumpcount) {
    if (ent.entity.velocity.isOrigin()) {
      break;
    }
    const end = ent.entity.origin.copy().add(ent.entity.velocity.copy().multiply(time_left));
    const trace = SV.Move(ent.entity.origin, ent.entity.mins, ent.entity.maxs, end, 0, ent);
    if (trace.allsolid === true) {
      ent.entity.velocity = Vector.origin;
      return 3;
    }
    if (trace.fraction > 0.0) {
      ent.entity.origin = ent.entity.origin.set(trace.endpos);
      original_velocity = ent.entity.velocity.copy();
      numplanes = 0;
      if (trace.fraction === 1.0) {
        break;
      }
    }
    if (trace.ent == null) {
      Sys.Error('SV.FlyMove: !trace.ent');
    }
    if (trace.plane.normal[2] > 0.7) {
      blocked |= 1;
      if (trace.ent.entity.solid === SV.solid.bsp) {
        ent.entity.flags |= SV.fl.onground;
        ent.entity.groundentity = trace.ent.entity;
      }
    } else if (trace.plane.normal[2] === 0.0) {
      blocked |= 2;
      SV.steptrace = trace;
    }
    SV.Impact(ent, trace.ent);
    if (ent.isFree()) {
      break;
    }
    time_left -= time_left * trace.fraction;
    if (numplanes >= 5) {
      ent.entity.velocity = Vector.origin;
      return 3;
    }
    planes[numplanes++] = trace.plane.normal.copy();
    for (i = 0; i < numplanes; ++i) {
      SV.ClipVelocity(original_velocity, planes[i], new_velocity, 1.0);
      for (j = 0; j < numplanes; ++j) {
        if (j !== i) {
          plane = planes[j];
          if ((new_velocity[0] * plane[0] + new_velocity[1] * plane[1] + new_velocity[2] * plane[2]) < 0.0) { // plane is not a Vector
            break;
          }
        }
      }
      if (j === numplanes) {
        break;
      }
    }
    if (i !== numplanes) {
      ent.entity.velocity = new_velocity;
    } else {
      if (numplanes !== 2) {
        ent.entity.velocity = Vector.origin;
        return 7;
      }
      dir = planes[0].cross(planes[1]);
      // scale the velocity by the dot product of velocity and direction
      ent.entity.velocity = dir.multiply(dir.dot(ent.entity.velocity));
    }
    if (ent.entity.velocity.dot(primal_velocity) <= 0.0) {
      ent.entity.velocity = Vector.origin;
      return blocked;
    }
  }
  return blocked;
};

SV.AddGravity = function(ent) {
  const ent_gravity = ent.entity.gravity || 1.0;

  ent.entity.velocity = ent.entity.velocity.add(new Vector(0.0, 0.0, ent_gravity * SV.gravity.value * Host.frametime * -1.0));
};

SV.PushEntity = function(ent, pushVector) {
  const end = ent.entity.origin.copy().add(pushVector);
  let nomonsters;
  const solid = ent.entity.solid;
  if (ent.entity.movetype === SV.movetype.flymissile) {
    nomonsters = SV.move.missile;
  } else if ((solid === SV.solid.trigger) || (solid === SV.solid.not)) {
    nomonsters = SV.move.nomonsters;
  } else {
    nomonsters = SV.move.normal;
  }
  const trace = SV.Move(ent.entity.origin, ent.entity.mins, ent.entity.maxs, end, nomonsters, ent);
  ent.entity.origin = ent.entity.origin.set(trace.endpos);
  SV.LinkEdict(ent, true);
  if (trace.ent) {
    SV.Impact(ent, trace.ent);
  }
  return trace;
};

SV.PushMove = function(pusher, movetime) {
  if (pusher.entity.velocity.isOrigin()) {
    pusher.entity.ltime += movetime;
    return;
  }
  const move = pusher.entity.velocity.copy().multiply(movetime);
  const mins = pusher.entity.absmin.copy().add(move);
  const maxs = pusher.entity.absmax.copy().add(move);
  const pushorig = pusher.entity.origin.copy().add(move);
  pusher.entity.origin = pushorig;
  pusher.entity.ltime += movetime;
  SV.LinkEdict(pusher);
  let check; let movetype;
  const moved = [];
  for (let e = 1; e < SV.server.num_edicts; ++e) {
    check = SV.server.edicts[e];
    if (check.isFree() === true) {
      continue;
    }
    movetype = check.entity.movetype;
    if ((movetype === SV.movetype.push) ||
			(movetype === SV.movetype.none) ||
			(movetype === SV.movetype.noclip)) {
      continue;
    }
    if (((check.entity.flags & SV.fl.onground) === 0) || !check.entity.groundentity || !check.entity.groundentity.equals(pusher)) {
      if (!check.entity.absmin.lt(maxs) || !check.entity.absmax.gt(mins)) {
        continue;
      }

      if (!SV.TestEntityPosition(check)) {
        continue;
      }
    }
    // remove the onground flag for non-players
    if (movetype !== SV.movetype.walk) {
      check.entity.flags &= ~SV.fl.onground;
    }
    const entorig = check.entity.origin.copy();
    moved[moved.length] = [entorig, check];
    pusher.entity.solid = SV.solid.not;
    SV.PushEntity(check, move);
    pusher.entity.solid = SV.solid.bsp;
    if (SV.TestEntityPosition(check) === true) {
      const cmins = check.entity.mins, cmaxs = check.entity.maxs;
      if (cmins[0] === cmaxs[0]) {
        continue;
      }
      if (check.entity.solid === SV.solid.not || check.entity.solid === SV.solid.trigger) {
        cmins[0] = cmaxs[0] = 0.0;
        cmins[1] = cmaxs[1] = 0.0;
        cmaxs[2] = cmins[2];
        check.entity.mins = cmins;
        check.entity.maxs = cmaxs;
        continue;
      }
      check.entity.origin = entorig;
      SV.LinkEdict(check, true);
      check.entity.origin = pushorig;
      SV.LinkEdict(pusher);
      pusher.entity.ltime -= movetime;
      if (pusher.entity.blocked) {
        pusher.entity.blocked(check.entity);
      }
      for (let i = 0; i < moved.length; ++i) {
        const moved_edict = moved[i];
        moved_edict[1].entity.origin = moved_edict[0];
        SV.LinkEdict(moved_edict[1]);
      }
      return;
    }
  }
};

SV.Physics_Pusher = function(ent) {
  const oldltime = ent.entity.ltime;
  const thinktime = ent.entity.nextthink;
  let movetime;
  if (thinktime < (oldltime + Host.frametime)) {
    movetime = thinktime - oldltime;
    if (movetime < 0.0) {
      movetime = 0.0;
    }
  } else {
    movetime = Host.frametime;
  }
  if (movetime !== 0.0) {
    SV.PushMove(ent, movetime);
  }
  if ((thinktime <= oldltime) || (thinktime > ent.entity.ltime)) {
    return;
  }
  ent.entity.nextthink = 0.0;
  SV.server.gameAPI.time = SV.server.time;
  ent.entity.think(null);
};

SV.CheckStuck = function(ent) {
  if (SV.TestEntityPosition(ent) !== true) {
    ent.entity.oldorigin = ent.entity.oldorigin.set(ent.entity.origin);
    return;
  }
  ent.entity.origin = ent.entity.origin.set(ent.entity.oldorigin);
  if (SV.TestEntityPosition(ent) !== true) {
    Con.DPrint('Unstuck.\n');
    SV.LinkEdict(ent, true);
    return;
  }
  const norg = ent.entity.origin.copy();
  for (norg[2] = 0.0; norg[2] <= 17.0; ++norg[2]) {
    for (norg[0] = -1.0; norg[0] <= 1.0; ++norg[0]) {
      for (norg[1] = -1.0; norg[1] <= 1.0; ++norg[1]) {
        ent.entity.origin = ent.entity.origin.set(norg).add(norg);
        if (SV.TestEntityPosition(ent) !== true) {
          Con.DPrint('Unstuck.\n');
          SV.LinkEdict(ent, true);
          return;
        }
      }
    }
  }
  Con.DPrint('player is stuck.\n');
};

SV.CheckWater = function(ent) {
  const point = ent.entity.origin.copy().add(new Vector(0.0, 0.0, ent.entity.mins[2] + 1.0));
  ent.entity.waterlevel = 0.0;
  ent.entity.watertype = Mod.contents.empty;
  let cont = SV.PointContents(point);
  if (cont > Mod.contents.water) {
    return false;
  }
  ent.entity.watertype = cont;
  ent.entity.waterlevel = 1.0;
  const origin = ent.entity.origin;
  point[2] = origin[2] + (ent.entity.mins[2] + ent.entity.maxs[2]) * 0.5;
  cont = SV.PointContents(point);
  if (cont <= Mod.contents.water) {
    ent.entity.waterlevel = 2.0;
    point[2] = origin[2] + ent.entity.view_ofs[2];
    cont = SV.PointContents(point);
    if (cont <= Mod.contents.water) {
      ent.entity.waterlevel = 3.0;
    }
  }
  return ent.entity.waterlevel > 1.0;
};

SV.WallFriction = function(ent, trace) {
  const { forward } = ent.entity.v_angle.angleVectors()
  const normal = trace.plane.normal;
  let d = normal.dot(forward) + 0.5;
  if (d >= 0.0) {
    return;
  }
  d += 1.0;
  const velo = ent.entity.velocity;
  const i = normal.dot(velo);

  // CR: velo[2] was always 0 when I tested this code substitude
  // ent.entity.velocity = ent.entity.velocity.subtract(normal.multiply(i)).multiply(d);

  velo[0] = (velo[0] - normal[0] * i) * d;
  velo[1] = (velo[1] - normal[1] * i) * d;

  ent.entity.velocity = velo;
};

SV.TryUnstick = function(ent, oldvel) {
  const oldorg = ent.entity.origin.copy();
  const dir = new Vector(2.0, 0.0, 0.0);
  let i; let clip;
  for (i = 0; i <= 7; ++i) {
    switch (i) {
      case 1: dir[0] = 0.0; dir[1] = 2.0; break;
      case 2: dir[0] = -2.0; dir[1] = 0.0; break;
      case 3: dir[0] = 0.0; dir[1] = -2.0; break;
      case 4: dir[0] = 2.0; dir[1] = 2.0; break;
      case 5: dir[0] = -2.0; dir[1] = 2.0; break;
      case 6: dir[0] = 2.0; dir[1] = -2.0; break;
      case 7: dir[0] = -2.0; dir[1] = -2.0;
    }
    SV.PushEntity(ent, dir);
    ent.entity.velocity = new Vector(oldvel[0], oldvel[1], 0.0);
    clip = SV.FlyMove(ent, 0.1);
    const curorg = ent.entity.origin;
    if (Math.abs(oldorg[1] - curorg[1]) > 4.0 || Math.abs(oldorg[0] - curorg[0]) > 4.0) {
      return clip;
    }
    ent.entity.origin = ent.entity.origin.set(oldorg);
  }
  ent.entity.velocity = Vector.origin;
  return 7;
};

SV.WalkMove = function(ent) {
  const oldonground = ent.entity.flags & SV.fl.onground;
  ent.entity.flags ^= oldonground;
  const oldorg = ent.entity.origin.copy();
  const oldvel = ent.entity.velocity.copy();
  let clip = SV.FlyMove(ent, Host.frametime);
  if ((clip & 2) === 0) {
    return;
  }
  if ((oldonground === 0) && (ent.entity.waterlevel === 0.0)) {
    return;
  }
  if (ent.entity.movetype !== SV.movetype.walk) {
    return;
  }
  if (SV.nostep.value !== 0) {
    return;
  }
  if ((SV.player.entity.flags & SV.fl.waterjump) !== 0) {
    return;
  }
  const nosteporg = ent.entity.origin.copy();
  const nostepvel = ent.entity.velocity.copy();
  ent.entity.origin = ent.entity.origin.set(oldorg);
  SV.PushEntity(ent, new Vector(0.0, 0.0, 18.0));
  ent.entity.velocity = new Vector(oldvel[0], oldvel[1], 0.0);
  clip = SV.FlyMove(ent, Host.frametime);
  if (clip !== 0) {
    const curorg = ent.entity.origin;
    if (Math.abs(oldorg[1] - curorg[1]) < 0.03125 && Math.abs(oldorg[0] - curorg[0]) < 0.03125) {
      clip = SV.TryUnstick(ent, oldvel);
    }
    if ((clip & 2) !== 0) {
      // FIXME: SV.steptrace can be null!
      if (SV.steptrace) {
        SV.WallFriction(ent, SV.steptrace);
      }
    }
  }
  const downtrace = SV.PushEntity(ent, new Vector(0.0, 0.0, oldvel[2] * Host.frametime - 18.0));
  if (downtrace.plane.normal[2] > 0.7) {
    if (ent.entity.solid === SV.solid.bsp) {
      ent.entity.flags |= SV.fl.onground;
      ent.entity.groundentity = downtrace.ent.entity;
    }
    return;
  }
  ent.entity.origin = ent.entity.origin.set(nosteporg);
  ent.entity.velocity = ent.entity.velocity.set(nostepvel);
};

SV.NoclipMove = function() {
  const ent = SV.player, cmd = Host.client.cmd;

  const { forward, right } = ent.entity.v_angle.angleVectors();

  const wishvel = new Vector(
    forward[0] * cmd.forwardmove + right[0] * cmd.sidemove,
    forward[1] * cmd.forwardmove + right[1] * cmd.sidemove,
    forward[2] * cmd.forwardmove + right[2] * cmd.sidemove,
  );

  ent.entity.velocity = ent.entity.velocity.set(wishvel.multiply(2.0));
}

SV.Physics_Client = function(ent) {
  if (!ent.getClient().active) {
    return;
  }
  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.PlayerPreThink(ent);
  SV.CheckVelocity(ent);
  const movetype = ent.entity.movetype >> 0;
  if ((movetype === SV.movetype.toss) || (movetype === SV.movetype.bounce)) {
    SV.Physics_Toss(ent);
  } else {
    if (!SV.RunThink(ent)) {
      return; // thinking might have freed the edict
    }
    switch (movetype) {
      case SV.movetype.none:
        break;
      case SV.movetype.walk:
        if (!SV.CheckWater(ent) && (ent.entity.flags & SV.fl.waterjump) === 0) {
          SV.AddGravity(ent);
        }
        SV.CheckStuck(ent);
        SV.WalkMove(ent);
        break;
      case SV.movetype.fly:
        SV.FlyMove(ent, Host.frametime);
        break;
      case SV.movetype.noclip:
        ent.entity.angles = ent.entity.angles.add(ent.entity.avelocity.copy().multiply(Host.frametime));
        ent.entity.origin = ent.entity.origin.add(ent.entity.velocity.copy().multiply(Host.frametime));
        break;
      default:
        Sys.Error('SV.Physics_Client: bad movetype ' + movetype);
    }
  }
  SV.LinkEdict(ent, true);
  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.PlayerPostThink(ent);
};

SV.CheckWaterTransition = function(ent) {
  const cont = SV.PointContents(ent.entity.origin);
  if (ent.entity.watertype === 0.0) {
    ent.entity.watertype = cont;
    ent.entity.waterlevel = 1.0;
    return;
  }
  if (cont <= Mod.contents.water) {
    if (ent.entity.watertype === Mod.contents.empty) {
      SV.StartSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0); // TODO: move to game logic
    }
    ent.entity.watertype = cont;
    ent.entity.waterlevel = 1.0;
    return;
  }
  if (ent.entity.watertype !== Mod.contents.empty) {
    SV.StartSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0); // TODO: move to game logic
  }
  ent.entity.watertype = Mod.contents.empty;
  ent.entity.waterlevel = cont;
};

SV.Physics_Toss = function(ent) {
  if (!SV.RunThink(ent)) {
    return; // thinking might have freed the edict
  }
  if ((ent.entity.flags & SV.fl.onground) !== 0) {
    return;
  }
  SV.CheckVelocity(ent);
  const movetype = ent.entity.movetype;
  if ((movetype !== SV.movetype.fly) && (movetype !== SV.movetype.flymissile)) {
    SV.AddGravity(ent);
  }
  ent.entity.angles = ent.entity.angles.add(ent.entity.avelocity.copy().multiply(Host.frametime));
  const trace = SV.PushEntity(ent, ent.entity.velocity.copy().multiply(Host.frametime));
  if (trace.fraction === 1.0 || ent.isFree()) {
    return;
  }
  const velocity = new Vector();
  SV.ClipVelocity(ent.entity.velocity, trace.plane.normal, velocity, (movetype === SV.movetype.bounce) ? 1.5 : 1.0);
  ent.entity.velocity = velocity;
  if (trace.plane.normal[2] > 0.7) {
    if (ent.entity.velocity[2] < 60.0 || movetype !== SV.movetype.bounce) {
      ent.entity.flags |= SV.fl.onground;
      ent.entity.groundentity = trace.ent.entity;
      ent.entity.velocity = Vector.origin;
      ent.entity.avelocity = Vector.origin;
    }
  }
  SV.CheckWaterTransition(ent);
};

SV.Physics_Step = function(ent) {
  if ((ent.entity.flags & (SV.fl.onground | SV.fl.fly | SV.fl.swim)) === 0) {
    const hitsound = (ent.entity.velocity[2] < (SV.gravity.value * -0.1));
    SV.AddGravity(ent);
    SV.CheckVelocity(ent);
    SV.FlyMove(ent, Host.frametime);
    SV.LinkEdict(ent, true);
    if (((ent.entity.flags & SV.fl.onground) !== 0) && (hitsound === true)) { // TODO: move to game logic
      SV.StartSound(ent, 0, 'demon/dland2.wav', 255, 1.0);
    }
  }
  SV.RunThink(ent);
  SV.CheckWaterTransition(ent);
};

SV._BuildSurfaceDisplayList = function(currentmodel, fa) { // FIXME: move to Mod?
  fa.verts = [];
  if (fa.numedges <= 2) {
    return;
  }
  let i; let index; let vec; let vert; let s; let t;
  const texinfo = currentmodel.texinfo[fa.texinfo];
  const texture = currentmodel.textures[texinfo.texture];
  for (i = 0; i < fa.numedges; ++i) {
    index = currentmodel.surfedges[fa.firstedge + i];
    if (index > 0) {
      vec = currentmodel.vertexes[currentmodel.edges[index][0]];
    } else {
      vec = currentmodel.vertexes[currentmodel.edges[-index][1]];
    }
    vert = new Vector(vec[0], vec[1], vec[2]);
    if (fa.sky !== true) {
      s = vec.dot(new Vector(...texinfo.vecs[0])) + texinfo.vecs[0][3];
      t = vec.dot(new Vector(...texinfo.vecs[1])) + texinfo.vecs[1][3];
      vert[3] = s / texture.width;
      vert[4] = t / texture.height;
      if (fa.turbulent !== true) {
        vert[5] = (s - fa.texturemins[0] + (fa.light_s << 4) + 8.0) / 16384.0;
        vert[6] = (t - fa.texturemins[1] + (fa.light_t << 4) + 8.0) / 16384.0;
      }
    }
    if (i >= 3) {
      fa.verts[fa.verts.length] = fa.verts[0];
      fa.verts[fa.verts.length] = fa.verts[fa.verts.length - 2];
    }
    fa.verts[fa.verts.length] = vert;
  }
};

SV._CreateTrimeshFromBSP = function(m) { // FIXME: move to Mod?
  const vertices = [];
  const indices = [];
  let vertexCount = 0;

  // Calculate all vertices for surfaces
  for (let j = 0; j < m.faces.length; ++j) {
    SV._BuildSurfaceDisplayList(m, m.faces[j]);
  }

  // Iterate through textures
  for (let i = 0; i < m.textures.length; ++i) {
      const texture = m.textures[i];

      // Skip sky and turbulent textures for collision geometry
      if (texture.sky || texture.turbulent) {
          continue;
      }

      // Iterate through leaf nodes
      for (let j = 0; j < m.leafs.length; ++j) {
          const leaf = m.leafs[j];

          // Iterate through the surfaces (faces) in the leaf
          for (let k = 0; k < leaf.nummarksurfaces; ++k) {
              const surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];

              // Skip surfaces with a different texture
              if (surf.texture !== i) {
                  continue;
              }

              // Process the vertices in the surface
              const faceVertices = [];
              for (let l = 0; l < surf.verts.length; ++l) {
                  const vert = surf.verts[l];
                  // Push vertex data (x, y, z)
                  vertices.push(vert[0], vert[1], vert[2]);
                  faceVertices.push(vertexCount++);
              }

              // Triangulate the face (if needed)
              if (faceVertices.length > 2) {
                  for (let l = 1; l < faceVertices.length - 1; ++l) {
                      indices.push(
                          faceVertices[0],    // First vertex
                          faceVertices[l],    // Current vertex
                          faceVertices[l + 1] // Next vertex
                      );
                  }
              }
          }
      }
  }

  // Create the Trimesh
  return new CANNON.Trimesh(vertices, indices);
}

SV.InitPhysicsEngine = function() {
  // // load world model as static body
  const worldmodel = SV.server.worldmodel;
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(SV._CreateTrimeshFromBSP(worldmodel));
  // body.addShape(new CANNON.Plane());
  SV.server.cannon.world.addBody(body);

  for (let i = 0; i < SV.server.num_edicts; ++i) {
    const ent = SV.server.edicts[i];

    if (ent.isFree()) {
      continue;
    }

    SV.PhysicsEngineRegisterEdict(ent);
  }
};

SV.StepPhysicsEngine = function() {
  if (!SV.server.cannon.active) {
    return;
  }

  if (SV.server.cannon.lastTime) {
    const fixedTimeStep = 1.0 / 60.0;
    const maxSubSteps = 10;
    const dt = (Host.realtime - SV.server.cannon.lastTime);

    SV.server.cannon.world.step(fixedTimeStep, dt, maxSubSteps);
  }

  SV.server.cannon.lastTime = Host.realtime;
};

SV.LinkPhysicsEngine = function() {
  if (!SV.server.cannon.active) {
    return;
  }

  for (let i = 0; i < SV.server.num_edicts; ++i) {
    const edict = SV.server.edicts[i];

    if (edict.isFree()) {
      continue;
    }

    if (edict.cannon?.body) {
      edict.entity.origin.set(edict.cannon.body.position.toArray());
      edict.entity.angles.set(Vector.fromQuaternion(edict.cannon.body.quaternion.toArray()));
      edict.linkEdict(false);
    }
  }
};

SV.PhysicsEngineUnregisterEdict = function(ent) {
  if (ent.cannon?.body) {
    SV.server.cannon.world.removeBody(ent.cannon.body);
    ent.cannon.body = null;
  }
};

 
SV.PhysicsEngineRegisterEdict = function(edict) {
  const classname = edict.entity.classname;

  edict.cannon = {
    body: null,
  };

  if (classname === 'item_shells') {
    const body = new CANNON.Body({
      position: new CANNON.Vec3(...edict.entity.origin),
      quaternion: new CANNON.Quaternion(...edict.entity.angles.toQuaternion()),
      mass: Q.atof(edict.entity.mass || 5), // kg
    });

    body.addShape(new CANNON.Box(new CANNON.Vec3(...edict.entity.size)));

    // if (edict.entity.model.endsWith('.bsp')) { // use model information instead
    //   body.addShape(SV._CreateTrimeshFromBSP(Mod.ForName(edict.entity.model)));
    // }

    SV.server.cannon.world.addBody(body);

    edict.cannon.body = body;
  }
};

SV.Physics = function() {
  SV.server.gameAPI.time = SV.server.time;
  SV.server.gameAPI.StartFrame(null);
  let i; let ent;
  for (i = 0; i < SV.server.num_edicts; ++i) {
    ent = SV.server.edicts[i];
    if (ent.isFree()) {
      continue;
    }
    if (SV.server.gameAPI.force_retouch-- > 0) {
      SV.LinkEdict(ent, true);
    }
    if (ent.isClient()) {
      SV.Physics_Client(ent);
      continue;
    }
    switch (ent.entity.movetype) {
      case SV.movetype.push:
        SV.Physics_Pusher(ent);
        continue;
      case SV.movetype.none:
        SV.RunThink(ent);
        continue;
      case SV.movetype.noclip:
        SV.RunThink(ent);
        continue;
      case SV.movetype.step:
        SV.Physics_Step(ent);
        continue;
      case SV.movetype.toss:
      case SV.movetype.bounce:
      case SV.movetype.fly:
      case SV.movetype.flymissile:
        SV.Physics_Toss(ent);
        continue;
    }
    Sys.Error('SV.Physics: bad movetype ' + (ent.entity.movetype >> 0));
  }
  SV.server.time += Host.frametime;
  SV.StepPhysicsEngine();
  SV.LinkPhysicsEngine();
};

// user

SV.SetIdealPitch = function() {
  const ent = SV.player;
  if ((ent.entity.flags & SV.fl.onground) === 0) {
    return;
  }
  const origin = ent.entity.origin;
  const angleval = ent.entity.angles[1] * (Math.PI / 180.0);
  const sinval = Math.sin(angleval);
  const cosval = Math.cos(angleval);
  const top = new Vector(0.0, 0.0, origin[2] + ent.entity.view_ofs[2]);
  const bottom = new Vector(0.0, 0.0, top[2] - 160.0);
  let i; let tr; const z = [];
  for (i = 0; i < 6; ++i) {
    top[0] = bottom[0] = origin[0] + cosval * (i + 3) * 12.0;
    top[1] = bottom[1] = origin[1] + sinval * (i + 3) * 12.0;
    tr = SV.Move(top, Vector.origin, Vector.origin, bottom, 1, ent);
    if (tr.allsolid || tr.fraction === 1.0) {
      return;
    }
    z[i] = top[2] - tr.fraction * 160.0;
  }
  let dir = 0.0; let step; let steps = 0;
  for (i = 1; i < 6; ++i) {
    step = z[i] - z[i - 1];
    if ((step > -0.1) && (step < 0.1)) {
      continue;
    }
    if ((dir !== 0.0) && (((step - dir) > 0.1) || ((step - dir) < -0.1))) {
      return;
    }
    ++steps;
    dir = step;
  }
  if (dir === 0.0) {
    ent.entity.idealpitch = 0.0;
    return;
  }
  if (steps >= 2) {
    ent.entity.idealpitch = -dir * SV.idealpitchscale.value;
  }
};

SV.UserFriction = function() {
  const ent = SV.player;
  const vel = ent.entity.velocity;
  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]);
  if (speed === 0.0) {
    return;
  }
  const origin = ent.entity.origin;
  const start = new Vector(origin[0] + vel[0] / speed * 16.0, origin[1] + vel[1] / speed * 16.0, origin[2] + ent.entity.mins[2]);
  let friction = SV.friction.value;
  if (SV.Move(start, Vector.origin, Vector.origin, new Vector(start[0], start[1], start[2] - 34.0), 1, ent).fraction === 1.0) {
    friction *= SV.edgefriction.value;
  }
  let newspeed = speed - Host.frametime * (speed < SV.stopspeed.value ? SV.stopspeed.value : speed) * friction;
  if (newspeed < 0.0) {
    newspeed = 0.0;
  }
  newspeed /= speed;
  ent.entity.velocity = ent.entity.velocity.multiply(newspeed);
};

SV.Accelerate = function(wishvel, air) {
  const ent = SV.player;

  const wishdir = wishvel.copy(); // new Vector(wishvel[0], wishvel[1], wishvel[2]);

  let wishspeed = wishdir.normalize();

  if (air && wishspeed > 30.0) {
    wishspeed = 30.0;
  }

  const addspeed = wishspeed - ent.entity.velocity.dot(wishdir);
  if (addspeed <= 0.0) {
    return;
  }
  const accelspeed = Math.min(SV.accelerate.value * Host.frametime * wishspeed, addspeed);
  ent.entity.velocity = ent.entity.velocity.add(wishdir.multiply(accelspeed));
};

SV.WaterMove = function() { // Host.client
  const ent = SV.player; const cmd = Host.client.cmd;
  const { forward, right } = ent.entity.v_angle.angleVectors();
  const wishvel = new Vector(
    forward[0] * cmd.forwardmove + right[0] * cmd.sidemove,
    forward[1] * cmd.forwardmove + right[1] * cmd.sidemove,
    forward[2] * cmd.forwardmove + right[2] * cmd.sidemove,
  );
  if ((cmd.forwardmove === 0.0) && (cmd.sidemove === 0.0) && (cmd.upmove === 0.0)) {
    wishvel[2] -= 60.0;
  } else {
    wishvel[2] += cmd.upmove;
  }
  let wishspeed = wishvel.len();
  let scale;
  if (wishspeed > SV.maxspeed.value) {
    scale = SV.maxspeed.value / wishspeed;
    wishvel.multiply(scale);
    wishspeed = SV.maxspeed.value;
  }
  wishspeed *= 0.7;
  const speed = ent.entity.velocity.len(); let newspeed;
  if (speed !== 0.0) {
    newspeed = speed - Host.frametime * speed * SV.friction.value;
    if (newspeed < 0.0) {
      newspeed = 0.0;
    }
    scale = newspeed / speed;
    ent.entity.velocity = ent.entity.velocity.multiply(scale);
  } else {
    newspeed = 0.0;
  }

  if (wishspeed === 0.0) {
    return;
  }

  const addspeed = wishspeed - newspeed;
  if (addspeed <= 0.0) {
    return;
  }
  const accelspeed = Math.min(SV.accelerate.value * wishspeed * Host.frametime, addspeed);
  ent.entity.velocity = ent.entity.velocity.add(wishvel.multiply(accelspeed / wishspeed));
};

SV.WaterJump = function() { // Host.client
  const ent = SV.player;
  if ((SV.server.time > ent.entity.teleport_time) || (ent.entity.waterlevel === 0.0)) {
    ent.entity.flags &= (~SV.fl.waterjump >>> 0);
    ent.entity.teleport_time = 0.0;
  }

  const nvelo = ent.entity.movedir.copy();
  nvelo[2] = ent.entity.velocity[2];
  ent.entity.velocity = nvelo;
};

SV.AirMove = function() { // Host.client
  const ent = SV.player;
  const cmd = Host.client.cmd;
  const {forward, right} =   ent.entity.angles.angleVectors();
  let fmove = cmd.forwardmove;
  const smove = cmd.sidemove;
  if ((SV.server.time < ent.entity.teleport_time) && (fmove < 0.0)) {
    fmove = 0.0;
  }
  const wishvel = new Vector(
    forward[0] * fmove + right[0] * smove,
    forward[1] * fmove + right[1] * smove,
		((ent.entity.movetype >> 0) !== SV.movetype.walk) ? cmd.upmove : 0.0);
  const wishdir = new Vector(wishvel[0], wishvel[1], wishvel[2]);
  if (wishdir.normalize() > SV.maxspeed.value) {
    wishvel[0] = wishdir[0] * SV.maxspeed.value;
    wishvel[1] = wishdir[1] * SV.maxspeed.value;
    wishvel[2] = wishdir[2] * SV.maxspeed.value;
  }
  if (ent.entity.movetype === SV.movetype.noclip) {
    ent.entity.velocity = wishvel;
  } else if ((ent.entity.flags & SV.fl.onground) !== 0) {
    SV.UserFriction(wishvel);
    SV.Accelerate(wishvel);
  } else {
    SV.Accelerate(wishvel, true);
  }
};

SV.ClientThink = function() {
  const ent = SV.player;

  if (ent.entity.movetype === SV.movetype.none) {
    return;
  }

  const punchangle = ent.entity.punchangle.copy();
  let len = punchangle.normalize() - 10.0 * Host.frametime;
  if (len < 0.0) {
    len = 0.0;
  }
  ent.entity.punchangle = punchangle.multiply(len);

  if (ent.entity.health <= 0.0) {
    return;
  }

  const angles = ent.entity.angles;
  const v_angle = ent.entity.v_angle.copy().add(punchangle);

  angles[2] = V.CalcRoll(angles, ent.entity.velocity) * 4.0;

  if (!SV.player.entity.fixangle) {
    angles[0] = (v_angle[0] + punchangle[0]) / -3.0;
    angles[1] = v_angle[1] + punchangle[1];
  }

  ent.entity.angles = angles;
  ent.entity.v_angle = v_angle;

  if (ent.entity.flags & SV.fl.waterjump) {
    SV.WaterJump();
  } else if (ent.entity.waterlevel >= 2.0 && ent.entity.movetype !== SV.movetype.noclip) {
    SV.WaterMove();
  } else if (ent.entity.movetype === SV.movetype.noclip) {
    SV.NoclipMove();
  } else {
    SV.AirMove();
  }
};

SV.ReadClientMove = function(client) {
  client.ping_times[client.num_pings++ & 15] = SV.server.time - MSG.ReadFloat();
  client.edict.entity.v_angle = MSG.ReadAngleVector();
  client.cmd.forwardmove = MSG.ReadShort();
  client.cmd.sidemove = MSG.ReadShort();
  client.cmd.upmove = MSG.ReadShort();
  // CR: we could restructure this a bit and let the ServerGameAPI handle the rest
  let i = MSG.ReadByte();
  client.edict.entity.button0 = (i & 1) === 1; // QuakeC
  client.edict.entity.button2 = ((i & 2) >> 1) === 1; // QuakeC
  client.edict.entity.button1 = ((i & 4) >> 2) === 1; // QuakeC
  i = MSG.ReadByte();
  if (i !== 0) {
    client.edict.entity.impulse = i; // QuakeC
  }
};

SV.HandleRconRequest = function(client) {
  const message = client.message;

  const password = MSG.ReadString();
  const cmd = MSG.ReadString();

  const rconPassword = SV.rcon_password.string;

  if (rconPassword === '' || rconPassword !== password) {
    MSG.WriteByte(message, Protocol.svc.print);
    MSG.WriteString(message, 'Wrong rcon password!');
    Con.Print(`SV.HandleRconRequest: rcon attempted by ${SV.GetClientName(client)} from ${client.netconnection.address}: ${cmd}\n`);
    return;
  }

  Con.Print(`SV.HandleRconRequest: rcon by ${SV.GetClientName(client)} from ${client.netconnection.address}: ${cmd}\n`);

  Con.StartCapture();
  Cmd.ExecuteString(cmd);
  const response = Con.StopCapture();

  MSG.WriteByte(message, Protocol.svc.print);
  MSG.WriteString(message, response);
};

SV.ReadClientMessage = function(client) {
  const commands = [
    'status',
    'god',
    'notarget',
    'fly',
    'name',
    'noclip',
    'say',
    'say_team',
    'tell',
    'color',
    'kill',
    'pause',
    'spawn',
    'begin',
    'prespawn',
    'kick',
    'ping',
    'give',
    'ban',
  ];

  while (true) {
    const ret = NET.GetMessage(client.netconnection);

    if (ret === -1) {
      Sys.Print('SV.ReadClientMessage: NET.GetMessage failed\n');
      return false;
    }

    if (ret === 0) {
      return true;
    }

    MSG.BeginReading();

    while (true) {
      if (!client.active) {
        return false;
      }

      if (MSG.badread) {
        Sys.Print('SV.ReadClientMessage: badread\n');
        return false;
      }

      const cmd = MSG.ReadChar();

      if (cmd === -1) {
        break; // End of message
      }

      switch (cmd) {
        case Protocol.clc.nop:
          // No operation, continue reading
          continue;

        case Protocol.clc.stringcmd: {
          const input = MSG.ReadString();
          const matchedCommand = commands.find((command) =>
            input.toLowerCase().startsWith(command),
          );

          if (matchedCommand) {
            Cmd.ExecuteString(input, true);
          } else {
            Con.DPrint(`${SV.GetClientName(client)} tried to ${input}`);
          }
          break;
        }

        case Protocol.clc.rconcmd:
          SV.HandleRconRequest(client);
          break;

        case Protocol.clc.disconnect:
          return false; // Client disconnect

        case Protocol.clc.move:
          SV.ReadClientMove(client);
          break;

        default:
          Sys.Print(`SV.ReadClientMessage: unknown command ${cmd}\n`);
          return false;
      }
    }
  }
};

SV.RunClients = function() { // FIXME: Host.client
  for (let i = 0; i < SV.svs.maxclients; ++i) {
    const client = SV.svs.clients[i];
    if (!client.active) {
      continue;
    }
    Host.client = client;
    SV.player = client.edict; // FIXME: SV.player
    if (!SV.ReadClientMessage(client)) {
      Host.DropClient(client, false, 'Connectivity issues, failed to read message');
      continue;
    }
    if (!client.spawned) {
      client.cmd.forwardmove = 0.0;
      client.cmd.sidemove = 0.0;
      client.cmd.upmove = 0.0;
      continue;
    }
    SV.ClientThink(); // FIXME: SV.player
  }
};

SV.FindClientByName = function(name) {
  return SV.svs.clients
      .filter((client) => client.active)
      .find((client) => SV.GetClientName(client) === name);
};

// world

SV.move = {
  normal: 0,
  nomonsters: 1,
  missile: 2,
};

SV.InitBoxHull = function() {
  SV.box_clipnodes = [];
  SV.box_planes = [];
  SV.box_hull = {
    clipnodes: SV.box_clipnodes,
    planes: SV.box_planes,
    firstclipnode: 0,
    lastclipnode: 5,
  };
  for (let i = 0; i <= 5; ++i) {
    const node = {};
    SV.box_clipnodes[i] = node;
    node.planenum = i;
    node.children = [];
    node.children[i & 1] = Mod.contents.empty;
    if (i !== 5) {
      node.children[1 - (i & 1)] = i + 1;
    } else {
      node.children[1 - (i & 1)] = Mod.contents.solid;
    }
    const plane = {};
    SV.box_planes[i] = plane;
    plane.type = i >> 1;
    plane.normal = new Vector();
    plane.normal[i >> 1] = 1.0;
    plane.dist = 0.0;
  }
};

SV.HullForEntity = function(ent, mins, maxs, out_offset) {
  const origin = ent.entity.origin;
  if (ent.entity.solid !== SV.solid.bsp) {
    const emaxs = ent.entity.maxs, emins = ent.entity.mins;
    SV.box_planes[0].dist = emaxs[0] - mins[0];
    SV.box_planes[1].dist = emins[0] - maxs[0];
    SV.box_planes[2].dist = emaxs[1] - mins[1];
    SV.box_planes[3].dist = emins[1] - maxs[1];
    SV.box_planes[4].dist = emaxs[2] - mins[2];
    SV.box_planes[5].dist = emins[2] - maxs[2];
    out_offset.set(origin);
    return SV.box_hull;
  }
  if (ent.entity.movetype !== SV.movetype.push) {
    Sys.Error('SOLID_BSP without MOVETYPE_PUSH');
  }
  const model = SV.server.models[ent.entity.modelindex];
  if (!model) {
    Sys.Error('MOVETYPE_PUSH with a non bsp model');
  }
  if (model.type !== Mod.type.brush) {
    Sys.Error('MOVETYPE_PUSH with a non bsp model');
  }
  const size = maxs[0] - mins[0];
  let hull;
  if (size < 3.0) {
    hull = model.hulls[0];
  } else if (size <= 32.0) {
    hull = model.hulls[1];
  } else {
    hull = model.hulls[2];
  }
  out_offset.setTo(
    hull.clip_mins[0] - mins[0] + origin[0],
    hull.clip_mins[1] - mins[1] + origin[1],
    hull.clip_mins[2] - mins[2] + origin[2],
  );
  return hull;
};

SV.CreateAreaNode = function(depth, mins, maxs) {
  const anode = {};
  SV.areanodes[SV.areanodes.length++] = anode;

  anode.trigger_edicts = {};
  anode.trigger_edicts.prev = anode.trigger_edicts.next = anode.trigger_edicts;
  anode.solid_edicts = {};
  anode.solid_edicts.prev = anode.solid_edicts.next = anode.solid_edicts;

  if (depth === 4) {
    anode.axis = -1;
    anode.children = [];
    return anode;
  }

  anode.axis = (maxs[0] - mins[0]) > (maxs[1] - mins[1]) ? 0 : 1;
  anode.dist = 0.5 * (maxs[anode.axis] + mins[anode.axis]);

  const maxs1 = new Vector(maxs[0], maxs[1], maxs[2]);
  const mins2 = new Vector(mins[0], mins[1], mins[2]);
  maxs1[anode.axis] = mins2[anode.axis] = anode.dist;
  anode.children = [SV.CreateAreaNode(depth + 1, mins2, maxs), SV.CreateAreaNode(depth + 1, mins, maxs1)];
  return anode;
};

SV.UnlinkEdict = function(ent) {
  if (ent.area.prev != null) {
    ent.area.prev.next = ent.area.next;
  }
  if (ent.area.next != null) {
    ent.area.next.prev = ent.area.prev;
  }
  ent.area.prev = ent.area.next = null;
};

SV.TouchLinks = function(ent, node) {
  const absmin = ent.entity.absmin, absmax = ent.entity.absmax;
  for (let l = node.trigger_edicts.next, next = null; l !== node.trigger_edicts; l = next) {
    next = l.next;
    const touch = l.ent;
    if (touch === ent) {
      continue;
    }
    if (!touch.entity.touch || touch.entity.solid !== SV.solid.trigger) {
      continue;
    }
    if (!absmin.lte(touch.entity.absmax) || !absmax.gte(touch.entity.absmin)) {
      continue;
    }
    SV.server.gameAPI.time = SV.server.time;
    touch.entity.touch(!ent.isFree() ? ent.entity : null);
  }
  if (node.axis === -1) {
    return;
  }
  if (absmax[node.axis] > node.dist) {
    SV.TouchLinks(ent, node.children[0]);
  }
  if (absmax[node.axis] < node.dist) {
    SV.TouchLinks(ent, node.children[1]);
  }
};

SV.FindTouchedLeafs = function(ent, node) {
  if (node.contents === Mod.contents.solid) {
    return;
  }

  if (node.contents < 0) {
    if (ent.leafnums.length === 16) {
      return;
    }
    ent.leafnums[ent.leafnums.length] = node.num - 1;
    return;
  }

  const sides = Vector.boxOnPlaneSide(ent.entity.absmin, ent.entity.absmax, node.plane);

  if ((sides & 1) !== 0) {
    SV.FindTouchedLeafs(ent, node.children[0]);
  }
  if ((sides & 2) !== 0) {
    SV.FindTouchedLeafs(ent, node.children[1]);
  }
};

SV.LinkEdict = function(ent, touch_triggers = false) {
  if (ent.equals(SV.server.edicts[0]) || ent.isFree()) {
    return;
  }

  SV.UnlinkEdict(ent);

  const origin = ent.entity.origin;
  const absmin = origin.copy(), absmax = origin.copy();

  absmin.add(ent.entity.mins).add(new Vector(-1.0, -1.0, -1.0));
  absmax.add(ent.entity.maxs).add(new Vector( 1.0,  1.0,  1.0));

  if ((ent.entity.flags & SV.fl.item) !== 0) {
    // the former else-branch would set Z, but we did it two statements before already,
    // so we need to correct it by subtracting the adjusted Z back.
    absmin.add(new Vector(-14.0, -14.0,  1.0));
    absmax.add(new Vector( 14.0,  14.0, -1.0));
  }

  ent.entity.absmin = ent.entity.absmin.set(absmin);
  ent.entity.absmax = ent.entity.absmax.set(absmax);

  ent.leafnums = [];
  if (ent.entity.modelindex !== 0.0) {
    SV.FindTouchedLeafs(ent, SV.server.worldmodel.nodes[0]);
  }

  if (ent.entity.solid === SV.solid.not) {
    return;
  }

  let node = SV.areanodes[0];
  for (;;) {
    if (node.axis === -1) {
      break;
    }
    if (ent.entity.absmin[node.axis] > node.dist) {
      node = node.children[0];
    } else if (ent.entity.absmax[node.axis] < node.dist) {
      node = node.children[1];
    } else {
      break;
    }
  }

  const before = (ent.entity.solid === SV.solid.trigger) ? node.trigger_edicts : node.solid_edicts;
  ent.area.next = before;
  ent.area.prev = before.prev;
  ent.area.prev.next = ent.area;
  ent.area.next.prev = ent.area;
  ent.area.ent = ent;

  if (touch_triggers) {
    SV.TouchLinks(ent, SV.areanodes[0]);
  }
};

SV.HullPointContents = function(hull, num, p) {
  let d; let node; let plane;
  for (; num >= 0; ) {
    if ((num < hull.firstclipnode) || (num > hull.lastclipnode)) {
      Sys.Error('SV.HullPointContents: bad node number');
    }
    node = hull.clipnodes[num];
    plane = hull.planes[node.planenum];
    if (plane.type <= 2) {
      d = p[plane.type] - plane.dist;
    } else {
      d = plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] - plane.dist;
    }
    if (d >= 0.0) {
      num = node.children[0];
    } else {
      num = node.children[1];
    }
  }
  return num;
};

SV.PointContents = function(p) {
  const cont = SV.HullPointContents(SV.server.worldmodel.hulls[0], 0, p);
  if ((cont <= Mod.contents.current_0) && (cont >= Mod.contents.current_down)) {
    return Mod.contents.water;
  }
  return cont;
};

SV.TestEntityPosition = function(ent) {
  const origin = ent.entity.origin.copy();
  return SV.Move(origin, ent.entity.mins, ent.entity.maxs, origin, 0, ent).startsolid;
};

SV.RecursiveHullCheck = function(hull, num, p1f, p2f, p1, p2, trace) {
  if (num < 0) {
    if (num !== Mod.contents.solid) {
      trace.allsolid = false;
      if (num === Mod.contents.empty) {
        trace.inopen = true;
      } else {
        trace.inwater = true;
      }
    } else {
      trace.startsolid = true;
    }
    return true;
  }

  if ((num < hull.firstclipnode) || (num > hull.lastclipnode)) {
    Sys.Error('SV.RecursiveHullCheck: bad node number');
  }

  const node = hull.clipnodes[num];
  const plane = hull.planes[node.planenum];
  let t1; let t2;

  if (plane.type <= 2) {
    t1 = p1[plane.type] - plane.dist;
    t2 = p2[plane.type] - plane.dist;
  } else {
    t1 = plane.normal[0] * p1[0] + plane.normal[1] * p1[1] + plane.normal[2] * p1[2] - plane.dist;
    t2 = plane.normal[0] * p2[0] + plane.normal[1] * p2[1] + plane.normal[2] * p2[2] - plane.dist;
  }

  if ((t1 >= 0.0) && (t2 >= 0.0)) {
    return SV.RecursiveHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace);
  }
  if ((t1 < 0.0) && (t2 < 0.0)) {
    return SV.RecursiveHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace);
  }

  let frac = (t1 + (t1 < 0.0 ? 0.03125 : -0.03125)) / (t1 - t2);
  if (frac < 0.0) {
    frac = 0.0;
  } else if (frac > 1.0) {
    frac = 1.0;
  }

  let midf = p1f + (p2f - p1f) * frac;
  const mid = new Vector(
    p1[0] + frac * (p2[0] - p1[0]),
    p1[1] + frac * (p2[1] - p1[1]),
    p1[2] + frac * (p2[2] - p1[2]),
  );
  const side = t1 < 0.0 ? 1 : 0;

  if (SV.RecursiveHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace) !== true) {
    return;
  }

  if (SV.HullPointContents(hull, node.children[1 - side], mid) !== Mod.contents.solid) {
    return SV.RecursiveHullCheck(hull, node.children[1 - side], midf, p2f, mid, p2, trace);
  }

  if (trace.allsolid === true) {
    return;
  }

  if (side === 0) {
    trace.plane.normal = plane.normal.copy();
    trace.plane.dist = plane.dist;
  } else {
    trace.plane.normal = plane.normal.copy().multiply(-1);
    trace.plane.dist = -plane.dist;
  }

  while (SV.HullPointContents(hull, hull.firstclipnode, mid) === Mod.contents.solid) {
    frac -= 0.1;
    if (frac < 0.0) {
      trace.fraction = midf;
      trace.endpos = mid.copy();
      Con.DPrint('backup past 0\n');
      return;
    }
    midf = p1f + (p2f - p1f) * frac;
    mid[0] = p1[0] + frac * (p2[0] - p1[0]);
    mid[1] = p1[1] + frac * (p2[1] - p1[1]);
    mid[2] = p1[2] + frac * (p2[2] - p1[2]);
  }

  trace.fraction = midf;
  trace.endpos = mid.copy();
};

SV.ClipMoveToEntity = function(ent, start, mins, maxs, end) {
  const trace = {
    fraction: 1.0,
    allsolid: true,
    endpos: end.copy(),
    plane: {normal: new Vector(), dist: 0.0},
    ent: null,
  };
  const offset = new Vector();
  const hull = SV.HullForEntity(ent, mins, maxs, offset);
  SV.RecursiveHullCheck(hull, hull.firstclipnode, 0.0, 1.0, start.copy().subtract(offset), end.copy().subtract(offset), trace);
  if (trace.fraction !== 1.0) {
    trace.endpos.add(offset);
  }
  if ((trace.fraction < 1.0) || (trace.startsolid === true)) {
    trace.ent = ent;
  }
  return trace;
};

SV.ClipToLinks = function(node, clip) {
  let l; let touch; let solid; let trace;
  for (l = node.solid_edicts.next; l !== node.solid_edicts; l = l.next) {
    touch = l.ent;
    solid = touch.entity.solid;
    if ((solid === SV.solid.not) || (touch === clip.passedict)) {
      continue;
    }
    if (solid === SV.solid.trigger) {
      Sys.Error('Trigger in clipping list');
    }
    if (clip.type === SV.move.nomonsters && solid !== SV.solid.bsp) {
      continue;
    }
    if (!clip.boxmins.lte(touch.entity.absmax) || !clip.boxmaxs.gte(touch.entity.absmin)) {
      continue;
    }
    if (clip.passedict) {
      if (clip.passedict.entity.size !== 0.0 && touch.entity.size === 0.0) {
        continue;
      }
    }
    if (clip.trace.allsolid === true) {
      return;
    }
    if (clip.passedict) {
      if (touch.entity.owner && touch.entity.owner.equals(clip.passedict)) { // TODO: Edict vs Entity
        continue;
      }
      if (clip.passedict.entity.owner && clip.passedict.entity.owner.equals(touch)) { // TODO: Edict vs Entity
        continue;
      }
    }
    if ((touch.entity.flags & SV.fl.monster) !== 0) {
      trace = SV.ClipMoveToEntity(touch, clip.start, clip.mins2, clip.maxs2, clip.end);
    } else {
      trace = SV.ClipMoveToEntity(touch, clip.start, clip.mins, clip.maxs, clip.end);
    }
    if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
      trace.ent = touch;
      clip.trace = trace;
      if (trace.startsolid) {
        clip.trace.startsolid = true;
      }
    }
  }
  if (node.axis === -1) {
    return;
  }
  if (clip.boxmaxs[node.axis] > node.dist) {
    SV.ClipToLinks(node.children[0], clip);
  }
  if (clip.boxmins[node.axis] < node.dist) {
    SV.ClipToLinks(node.children[1], clip);
  }
};

SV.Move = function(start, mins, maxs, end, type, passedict) {
  const clip = {
    trace: SV.ClipMoveToEntity(SV.server.edicts[0], start, mins, maxs, end),
    start: start,
    end: end,
    mins: mins,
    mins2: type === SV.move.missile ? new Vector(-15.0, -15.0, -15.0) : mins,
    maxs: maxs,
    maxs2: type === SV.move.missile ? new Vector(15.0, 15.0, 15.0) : maxs,
    type: type,
    passedict: passedict,
    boxmins: new Vector(),
    boxmaxs: new Vector(),
  };
  for (let i = 0; i <= 2; i++) {
    if (end[i] > start[i]) {
      clip.boxmins[i] = start[i] + clip.mins2[i] - 1.0;
      clip.boxmaxs[i] = end[i] + clip.maxs2[i] + 1.0;
      continue;
    }
    clip.boxmins[i] = end[i] + clip.mins2[i] - 1.0;
    clip.boxmaxs[i] = start[i] + clip.maxs2[i] + 1.0;
  }
  SV.ClipToLinks(SV.areanodes[0], clip);
  return clip.trace;
};
