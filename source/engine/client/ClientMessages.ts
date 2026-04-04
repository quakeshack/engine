import * as Protocol from '../network/Protocol.ts';
import * as Def from '../common/Def.ts';
import Vector from '../../shared/Vector.ts';
import { PmovePlayer } from '../common/Pmove.ts';
import { gameCapabilities } from '../../shared/Defs.ts';
import { eventBus, getClientRegistry } from '../registry.mjs';
import { HostError } from '../common/Errors.ts';
import { ClientEdict } from './ClientEntities.ts';

type ClientdataBitsReader = 'readLong' | 'readShort' | 'readByte';

let { CL, COM, NET } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, NET } = getClientRegistry());
});

/**
 * ClientPlayerState is the information needed by a player entity
 * to do move prediction and to generate a drawable entity
 */
export class ClientPlayerState extends Protocol.EntityState {
  /** last command for prediction */
  command: Protocol.UserCmd;

  /** all player's won't be updated each frame */
  messagenum: number;

  /** not the same as the packet time, because player commands come asyncronously */
  stateTime: number;

  declare origin: Vector;
  velocity: Vector;
  weaponframe: number;
  waterjumptime: number;

  /** null in air, else pmove entity number */
  onground: number | null;

  oldbuttons: number;

  /** Q2-style player movement flags (PMF bitmask) */
  pmFlags: number;

  /** Q2-style timing counter for special states */
  pmTime: number;
  pmove: PmovePlayer;

  constructor(pmove: PmovePlayer) {
    super();
    this.command = new Protocol.UserCmd();
    this.messagenum = 0;
    this.stateTime = 0.0;
    this.origin = new Vector();
    this.velocity = new Vector();
    this.weaponframe = 0;
    this.waterjumptime = 0.0;
    this.onground = null;
    this.oldbuttons = 0;
    this.pmFlags = 0;
    this.pmTime = 0;
    this.pmove = pmove;

    Object.seal(this);
  }

  readFromMessage(): void {
    this.flags = NET.message.readShort();
    this.origin.set(NET.message.readCoordVector());
    this.frame = NET.message.readByte();

    this.stateTime = CL.state.time;

    if (this.flags & Protocol.pf.PF_MSEC) {
      const msec = NET.message.readByte();
      this.stateTime -= msec / 1000.0;
    }

    // TODO: stateTime, parsecounttime

    if (this.flags & Protocol.pf.PF_COMMAND) {
      this.command.set(NET.message.readDeltaUsercmd(CL.nullcmd));
    }

    if (this.flags & Protocol.pf.PF_VELOCITY) {
      this.velocity.set(NET.message.readCoordVector());
    }

    if (this.flags & Protocol.pf.PF_MODEL) {
      this.modelindex = NET.message.readByte();
    }

    if (this.flags & Protocol.pf.PF_EFFECTS) {
      this.effects = NET.message.readByte();
    }

    if (this.flags & Protocol.pf.PF_SKINNUM) {
      this.skinnum = NET.message.readByte();
    }

    if (this.flags & Protocol.pf.PF_WEAPONFRAME) {
      this.weaponframe = NET.message.readByte();
    }
  }
}

/**
 * Handles player movement and entity related messages.
 */
export class ClientMessages {
  /** current received time, last received time */
  mtime: [number, number] = [0.0, 0.0];

  playerstates: ClientPlayerState[] = [];

  /** additional private player fields whose values are getting updated each frame */
  #clientdataFields: string[] = [];

  /** shortcut to read the current amount of clientdata field bits */
  #readClientdataFieldsBits: ClientdataBitsReader | null = null;

  set clientdataFields(fields: string[]) {
    this.#clientdataFields.length = 0;
    this.#clientdataFields.push(...fields);

    console.assert(this.#clientdataFields.length <= 32, 'clientdata must not have more than 32 fields');

    if (this.#clientdataFields.length <= 8) {
      this.#readClientdataFieldsBits = 'readByte';
    } else if (this.#clientdataFields.length <= 16) {
      this.#readClientdataFieldsBits = 'readShort';
    } else {
      this.#readClientdataFieldsBits = 'readLong';
    }
  }

  /**
   * Parses Protocol.svc.time message.
   */
  parseTime(): void {
    // This is the time of the last message received from the server.
    this.mtime[1] = this.mtime[0];
    // This is the current time we got from the server.
    this.mtime[0] = NET.message.readFloat();
  }

  /**
   * General client data parsing.
   * @param bits bitmask from Protocol.su describing which general client fields follow
   */
  #parseClientGeneral(bits: number): void {
    // Parse the general client data.

    CL.state.viewheight = ((bits & Protocol.su.viewheight) !== 0) ? NET.message.readChar() : Protocol.default_viewheight;
    CL.state.idealpitch = ((bits & Protocol.su.idealpitch) !== 0) ? NET.message.readChar() : 0.0;

    for (let i = 0; i < 3; i++) {
      if ((bits & (Protocol.su.punch1 << i)) !== 0) {
        CL.state.punchangle[i] = NET.message.readShort() / 90.0;
      } else {
        CL.state.punchangle[i] = 0.0;
      }
    }

    CL.state.onground = (bits & Protocol.su.onground) !== 0;
    CL.state.inwater = (bits & Protocol.su.inwater) !== 0;

    if ((bits & Protocol.su.moveack) !== 0) {
      CL.state.acknowledgedMoveSequence = NET.message.readByte();
      // server sends authoritative PM state alongside the move ack so
      // client-side prediction replays from the correct pmFlags / pmTime
      CL.state.ackedPmFlags = NET.message.readByte();
      CL.state.ackedPmTime = NET.message.readByte();
      CL.state.ackedPmOldButtons = NET.message.readByte();
    }
  }

  /**
   * Client data parsing for Quake 1.
   * This will fill CL.state.stats and CL.state.items.
   * @param bits bitmask from Protocol.su describing which legacy client fields follow
   */
  #parseClientLegacy(bits: number): void {
    const item = NET.message.readLong();
    if (CL.state.items !== item) {
      for (let j = 0; j < CL.state.item_gettime.length; j++) {
        if ((((item >>> j) & 1) !== 0) && (((CL.state.items >>> j) & 1) === 0)) {
          CL.state.item_gettime[j] = CL.state.time;
        }
      }
      CL.state.items = item;
    }

    CL.state.stats[Def.stat.weaponframe] = ((bits & Protocol.su.weaponframe) !== 0) ? NET.message.readByte() : 0;
    CL.state.stats[Def.stat.armor] = ((bits & Protocol.su.armor) !== 0) ? NET.message.readByte() : 0;
    CL.state.stats[Def.stat.weapon] = ((bits & Protocol.su.weapon) !== 0) ? NET.message.readByte() : 0;
    CL.state.stats[Def.stat.health] = NET.message.readShort();
    CL.state.stats[Def.stat.ammo] = NET.message.readByte();
    CL.state.stats[Def.stat.shells] = NET.message.readByte();
    CL.state.stats[Def.stat.nails] = NET.message.readByte();
    CL.state.stats[Def.stat.rockets] = NET.message.readByte();
    CL.state.stats[Def.stat.cells] = NET.message.readByte();
    if (COM.standard_quake === true) {
      CL.state.stats[Def.stat.activeweapon] = NET.message.readByte();
    } else {
      CL.state.stats[Def.stat.activeweapon] = 1 << NET.message.readByte();
    }
  }

  /**
   * Client data parsing for QuakeJS based games.
   */
  #parseClientdata(): void {
    if (this.#readClientdataFieldsBits === null) {
      throw new HostError('Clientdata field bits reader not initialized');
    }

    const fieldbits = NET.message[this.#readClientdataFieldsBits]();

    const fields: string[] = [];
    const fieldsToNull: string[] = [];

    for (let i = 0; i < this.#clientdataFields.length; i++) {
      const field = this.#clientdataFields[i];

      if (field === undefined) {
        continue;
      }

      if ((fieldbits & (1 << i)) !== 0) {
        fields.push(field);
      } else {
        fieldsToNull.push(field);
      }
    }

    let counter = 0;

    // we are writing directly into clientdata object
    const clientdata = CL.state.gameAPI.clientdata;

    if (clientdata === null) {
      throw new HostError('Client game API clientdata is not initialized');
    }

    while (true) {
      const dataType = NET.message.readByte();

      if (dataType === Protocol.serializableTypes.none) {
        break;
      }

      const field = fields[counter++];

      if (field === undefined) {
        throw new HostError(`Unknown clientdata field index ${counter - 1} for data type ${dataType}`);
      }

      console.assert(clientdata[field] !== undefined, `Unknown clientdata field ${field} for data type ${dataType}`);

      switch (dataType) {
        case Protocol.serializableTypes.long:
          clientdata[field] = NET.message.readLong();
          break;
        case Protocol.serializableTypes.short:
          clientdata[field] = NET.message.readShort();
          break;
        case Protocol.serializableTypes.byte:
          clientdata[field] = NET.message.readByte();
          break;
        case Protocol.serializableTypes.float:
          clientdata[field] = NET.message.readFloat();
          break;
        case Protocol.serializableTypes.vector:
          clientdata[field] = NET.message.readCoordVector();
          break;
        case Protocol.serializableTypes.string:
          clientdata[field] = NET.message.readString();
          break;
        case Protocol.serializableTypes.true:
          clientdata[field] = true;
          break;
        case Protocol.serializableTypes.false:
          clientdata[field] = false;
          break;
        case Protocol.serializableTypes.null:
          clientdata[field] = null;
          break;
        default:
          throw new HostError(`Unknown or unsupported client event data type: ${dataType}`);
        // TODO: handle custom serializable types, also arrays are missing
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

  parseClientEvent(): void {
    const eventCode = NET.message.readByte();
    const args = NET.message.readSerializablesOnClient();

    CL.state.gameAPI.handleClientEvent(eventCode, ...args);
  }

  /**
   * Parses Protocol.svc.clientdata message.
   */
  parseClient(): void {
    const bits = NET.message.readShort();

    this.#parseClientGeneral(bits);

    if (CL.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_LEGACY)) {
      this.#parseClientLegacy(bits);
    } else {
      this.#parseClientdata();
    }
  }

  parsePlayer(): void {
    const num = NET.message.readByte();

    if (num > CL.state.maxclients) {
      throw new HostError('CL.ParsePlayerinfo: num > maxclients');
    }

    if (this.playerstates[num] === undefined) {
      this.playerstates[num] = new ClientPlayerState(CL.pmove.newPlayerMove());
    }

    const state = this.playerstates[num];

    if (state === undefined) {
      throw new HostError(`Missing client player state ${num}`);
    }

    state.number = num;
    state.readFromMessage();
    state.angles.set(state.command.angles);
  }

  clear(): void {
    this.mtime.fill(0.0);
    this.playerstates.length = 0;
  }
}
