import MSG from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from '../common/Def.mjs';
import { eventBus, registry } from '../registry.mjs';
import { HostError } from '../common/Errors.mjs';
import Vector from '../../shared/Vector.mjs';
import { PmovePlayer } from '../common/Pmove.mjs';
import { gameCapabilities } from '../../shared/Defs.mjs';
import { ClientEdict } from './ClientEntities.mjs';

let { CL, COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
});

/**
 * ClientPlayerState is the information needed by a player entity
 * to do move prediction and to generate a drawable entity
 */
export class ClientPlayerState extends Protocol.EntityState {
  /**
   * @param {PmovePlayer} pmove pmove for player
   */
  constructor(pmove) {
    super();
    /** @type {Protocol.UserCmd} last command for prediction */
    this.command = new Protocol.UserCmd();

    /** all player's won't be updated each frame */
    this.messagenum = 0;

    /** not the same as the packet time, because player commands come asyncronously */
    this.stateTime = 0.0;

    this.origin = new Vector();
    this.velocity = new Vector();

    this.weaponframe = 0;

    this.waterjumptime = 0.0;
    /** @type {?number} null in air, else pmove entity number */
    this.onground = null;
    this.oldbuttons = 0;

    this.pmove = pmove;

    Object.seal(this);
  }

  readFromMessage() {
    this.flags = MSG.ReadShort();
    this.origin.set(MSG.ReadCoordVector());
    this.frame = MSG.ReadByte();

    this.stateTime = CL.state.time;

    if (this.flags & Protocol.pf.PF_MSEC) {
      const msec = MSG.ReadByte();
      this.stateTime -= (msec / 1000.0);
    }

    // TODO: stateTime, parsecounttime

    if (this.flags & Protocol.pf.PF_COMMAND) {
      this.command.set(MSG.ReadDeltaUsercmd(CL.nullcmd));
    }

    if (this.flags & Protocol.pf.PF_VELOCITY) {
      this.velocity.set(MSG.ReadCoordVector());
    }

    if (this.flags & Protocol.pf.PF_MODEL) {
      this.modelindex = MSG.ReadByte();
    }

    if (this.flags & Protocol.pf.PF_EFFECTS) {
      this.effects = MSG.ReadByte();
    }

    if (this.flags & Protocol.pf.PF_SKINNUM) {
      this.skin = MSG.ReadByte();
    }

    if (this.flags & Protocol.pf.PF_WEAPONFRAME) {
      this.weaponframe = MSG.ReadByte();
    }
  }
};


/**
 * Handles player movement and entity related messages.
 */
export class ClientMessages {
  /** @type {number[]} current received time, last received time */
  mtime = [0.0, 0.0];

  /** @type {ClientPlayerState[]} */
  playerstates = [];

  /**
   * Parses Protocol.svc.time message.
   */
  parseTime() {
    // This is the time of the last message received from the server.
    this.mtime[1] = this.mtime[0];
    // This is the current time we got from the server.
    this.mtime[0] = MSG.ReadFloat();
  }

  /**
   * General client data parsing.
   * @param {number} bits
   */
  #parseClientGeneral(bits) {
    // Parse the general client data.

    CL.state.viewheight = ((bits & Protocol.su.viewheight) !== 0) ? MSG.ReadChar() : Protocol.default_viewheight;
    CL.state.idealpitch = ((bits & Protocol.su.idealpitch) !== 0) ? MSG.ReadChar() : 0.0;

    for (let i = 0; i < 3; i++) {
      if ((bits & (Protocol.su.punch1 << i)) !== 0) {
        CL.state.punchangle[i] = MSG.ReadShort() / 90.0;
      } else {
        CL.state.punchangle[i] = 0.0;
      }
    }

    CL.state.onground = (bits & Protocol.su.onground) !== 0;
    CL.state.inwater = (bits & Protocol.su.inwater) !== 0;
  }

  /**
   * Client data parsing for Quake 1.
   * This will fill CL.state.stats and CL.state.items.
   * @param {number} bits
   */
  #parseClientLegacy(bits) {
    const item = MSG.ReadLong();
    if (CL.state.items !== item) {
      for (let j = 0; j < CL.state.item_gettime.length; j++) {
        if ((((item >>> j) & 1) !== 0) && (((CL.state.items >>> j) & 1) === 0)) {
          CL.state.item_gettime[j] = CL.state.time;
        }
      }
      CL.state.items = item;
    }

    CL.state.stats[Def.stat.weaponframe] = ((bits & Protocol.su.weaponframe) !== 0) ? MSG.ReadByte() : 0;
    CL.state.stats[Def.stat.armor] = ((bits & Protocol.su.armor) !== 0) ? MSG.ReadByte() : 0;
    CL.state.stats[Def.stat.weapon] = ((bits & Protocol.su.weapon) !== 0) ? MSG.ReadByte() : 0;
    CL.state.stats[Def.stat.health] = MSG.ReadShort();
    CL.state.stats[Def.stat.ammo] = MSG.ReadByte();
    CL.state.stats[Def.stat.shells] = MSG.ReadByte();
    CL.state.stats[Def.stat.nails] = MSG.ReadByte();
    CL.state.stats[Def.stat.rockets] = MSG.ReadByte();
    CL.state.stats[Def.stat.cells] = MSG.ReadByte();
    if (COM.standard_quake === true) {
      CL.state.stats[Def.stat.activeweapon] = MSG.ReadByte();
    } else {
      CL.state.stats[Def.stat.activeweapon] = 1 << MSG.ReadByte();
    }
  }

  /**
   * Client data parsing for QuakeJS based games.
   */
  #parseClientdata(bits) {
    CL.state.stats[Def.stat.weapon] = ((bits & Protocol.su.weapon) !== 0) ? MSG.ReadByte() : 0;
    CL.state.stats[Def.stat.weaponframe] = ((bits & Protocol.su.weaponframe) !== 0) ? MSG.ReadByte() : 0;
    CL.state.stats[Def.stat.health] = MSG.ReadShort();

    const fieldbits = CL.state.clientdataFields.length > 8 ? MSG.ReadShort() : MSG.ReadByte();

    const fields = [];
    const fieldsToNull = [];

    for (let i = 0; i < CL.state.clientdataFields.length; i++) {
      const field = CL.state.clientdataFields[i];

      if ((fieldbits & (1 << i)) !== 0) {
        fields.push(field);
      } else {
        fieldsToNull.push(field);
      }
    }

    let counter = 0;

    // we are writing directly into clientdata object
    const clientdata = CL.state.gameAPI.clientdata;

    while (true) {
      const dataType = MSG.ReadByte();

      if (dataType === Protocol.serializableTypes.none) {
        break;
      }

      const field = fields[counter++];

      console.assert(field !== undefined, `Unknown clientdata field index ${counter - 1} for data type ${dataType}`);
      console.assert(clientdata[field] !== undefined, `Unknown clientdata field ${field} for data type ${dataType}`);

      switch (dataType) {
        case Protocol.serializableTypes.number:
          clientdata[field] = MSG.ReadLong();
          break;
        case Protocol.serializableTypes.vector:
          clientdata[field] = MSG.ReadCoordVector();
          break;
        case Protocol.serializableTypes.string:
          clientdata[field] = MSG.ReadString();
          break;
        case Protocol.serializableTypes.entity:
          clientdata[field] = CL.state.clientEntities.getEntity(MSG.ReadShort());
          break;
        case Protocol.serializableTypes.boolean:
          clientdata[field] = MSG.ReadByte() !== 0;
          break;
        default:
          throw new HostError(`Unknown client event data type: ${dataType}`);
      }
    }

    for (const field of fieldsToNull) { // TODO: remove this once the server only pushes updated fields and no longer non-null/non-zero fields
      const value = clientdata[field];
      switch (true) {
        case value === null:
          // already null, do nothing
          break;
        case value instanceof Vector:
          value.clear();
          break;
        case value instanceof ClientEdict:
        case typeof value === 'string':
          clientdata[field] = null;
          break;
        case typeof value === 'number':
          clientdata[field] = 0;
          break;
        case typeof value === 'boolean':
          clientdata[field] = false;
          break;
        default:
          throw new HostError(`Unknown client event data type for field ${field}: ${typeof value}`);
      }

      // TODO: trigger a client event for a changed field
    }
  }

  parseClientEvent() {
    const eventCode = MSG.ReadByte();

    /** @type {(import('../../shared/GameInterfaces').SerializableType)[]} */
    const args = [];

    while (true) {
      const dataType = MSG.ReadByte();

      if (dataType === Protocol.serializableTypes.none) {
        break;
      }

      switch (dataType) {
        case Protocol.serializableTypes.number:
          args.push(MSG.ReadLong());
          break;
        case Protocol.serializableTypes.vector:
          args.push(MSG.ReadCoordVector());
          break;
        case Protocol.serializableTypes.string:
          args.push(MSG.ReadString());
          break;
        case Protocol.serializableTypes.entity:
          args.push(CL.state.clientEntities.getEntity(MSG.ReadShort()));
          break;
        case Protocol.serializableTypes.boolean:
          args.push(MSG.ReadByte() !== 0);
          break;
        default:
          throw new HostError(`Unknown client event data type: ${dataType}`);
      }
    }

    CL.state.gameAPI.handleClientEvent(eventCode, ...args);
  }

  /**
   * Parses Protocol.svc.clientdata message.
   */
  parseClient() {
    const bits = MSG.ReadShort();

    this.#parseClientGeneral(bits);

    if (CL.gameCapabilities.includes(gameCapabilities.CAP_LEGACY_CLIENTDATA)) {
      this.#parseClientLegacy(bits);
    } else {
      this.#parseClientdata(bits);
    }
  }

  parsePlayer() {
    const num = MSG.ReadByte();

    if (num > CL.state.maxclients) {
      throw new HostError('CL.ParsePlayerinfo: num > maxclients');
    }

    const state = this.playerstates[num] || new ClientPlayerState(CL.pmove.newPlayerMove());

    state.number = num;
    state.readFromMessage();
    state.angles.set(state.command.angles);

    this.playerstates[num] = state;
  }

  clear() {
    this.mtime.fill(0.0);
  }
};
