import Q from '../../shared/Q.ts';
import Vector from '../../shared/Vector.ts';
import * as Protocol from '../network/Protocol.ts';
import { eventBus, registry } from '../registry.mjs';

let { Con } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ Con } = registry);
});

/** @type {{id: number, constructor: Function, serialize: (sz: SzBuffer, object: object) => void, deserializeOnServer: (sz: SzBuffer) => object, deserializeOnClient: (sz: SzBuffer) => object}[]} */
const serializableHandlers = [];

/**
 * Registers a custom serializable type for network transmission.
 * @param {Function} constructor The constructor function of the type
 * @param {{ serialize: (sz: SzBuffer, object: object) => void, deserializeOnServer: (sz: SzBuffer) => object, deserializeOnClient: (sz: SzBuffer) => object }} handlers serialization handlers
 */
export function registerSerializableType(constructor, { serialize, deserializeOnServer, deserializeOnClient }) {
  serializableHandlers.push({
    constructor,
    serialize,
    deserializeOnServer,
    deserializeOnClient,
    id: Object.keys(Protocol.serializableTypes).length + serializableHandlers.length,
  });
}

export class SzBuffer {
  /** current read position in the buffer */
  readcount = 0;

  /** set to true when a read operation fails due to insufficient data */
  badread = false;

  /**
   * @param {number} size maximum size of the buffer
   * @param {string} name name for debugging purposes
   */
  constructor(size, name = 'anonymous') {
    this.name = name;
    this.data = new ArrayBuffer(size);
    this.cursize = 0;
    /** if false, overflow will cause a crash */
    this.allowoverflow = false;
    /** set to true, when an overflow has occurred */
    this.overflowed = false;
  }

  get maxsize() {
    return this.data.byteLength;
  }

  clear() {
    this.cursize = 0;
    this.overflowed = false;
  }

  copy() {
    const copy = new SzBuffer(this.maxsize, this.name);
    copy.cursize = this.cursize;
    copy.overflowed = this.overflowed;
    const u8 = new Uint8Array(this.data);
    const u8copy = new Uint8Array(copy.data);
    u8copy.set(u8);
    return copy;
  }

  set(other) {
    this.name = other.name;
    this.data = new ArrayBuffer(other.maxsize);
    new Uint8Array(this.data).set(new Uint8Array(other.data));
    this.cursize = other.cursize;
    this.allowoverflow = other.allowoverflow;
    this.overflowed = other.overflowed;
    return this;
  }

  allocate(size) {
    if (this.cursize + size > this.maxsize) {
      if (this.allowoverflow !== true) {
        throw RangeError('SzBuffer.allocate: overflow without allowoverflow set');
      }

      if (size > this.maxsize) {
        throw RangeError('SzBuffer.allocate: ' + size + ' is > full buffer size');
      }

      this.overflowed = true;
      this.cursize = 0;

      Con.Print('SzBuffer.allocate: overflow\n');
      // eslint-disable-next-line no-debugger
      debugger;
    }

    const cursize = this.cursize;
    this.cursize += size;
    return cursize;
  }

  write(data, length) {
    const u = new Uint8Array(this.data, this.allocate(length), length);
    u.set(data.subarray(0, length));
  }

  print(data) {
    const buf = new Uint8Array(this.data);
    let dest;
    if (this.cursize !== 0) {
      if (buf[this.cursize - 1] === 0) {
        dest = this.allocate(data.length - 1) - 1;
      } else {
        dest = this.allocate(data.length);
      }
    } else {
      dest = this.allocate(data.length);
    }
    for (let i = 0; i < data.length; i++) {
      buf[dest + i] = data.charCodeAt(i);
    }
  }

  toHexString() {
    let output = '';
    const u8 = new Uint8Array(this.data, 0, this.cursize);
    const lineBytes = 16;
    for (let i = 0; i < u8.length; i += lineBytes) {
      let line = ('00000000' + i.toString(16)).slice(-8) + ': ';
      let hexPart = '';
      let asciiPart = '';
      for (let j = 0; j < lineBytes; j++) {
        if (i + j < u8.length) {
          const byte = u8[i + j];
          hexPart += ('0' + byte.toString(16)).slice(-2) + ' ';
          asciiPart += (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.');
        } else {
          hexPart += '   ';
          asciiPart += ' ';
        }
      }
      line += hexPart + ' ' + asciiPart;
      output += line + '\n';
    }
    return output;
  }

  toString() {
    return `SzBuffer: (${this.name}) ${this.cursize} bytes of ${this.maxsize} bytes used, overflowed? ${this.overflowed ? 'yes' : 'no'}`;
  }

  writeChar(c) {
    console.assert(c >= -128 && c <= 127, 'must be signed byte', c);
    new DataView(this.data).setInt8(this.allocate(1), c);
  }

  writeByte(c) {
    console.assert(c >= 0 && c <= 255, 'must be unsigned byte', c);
    new DataView(this.data).setUint8(this.allocate(1), c);
  }

  writeShort(c) {
    console.assert(c >= -32768 && c <= 32767, 'must be signed short', c);
    new DataView(this.data).setInt16(this.allocate(2), c, true);
  }

  writeUint16(c) {
    console.assert(c >= 0 && c <= 65535, 'must be unsigned short', c);
    new DataView(this.data).setUint16(this.allocate(2), c, true);
  }

  writeLong(c) {
    console.assert(c >= -2147483648 && c <= 2147483647, 'must be signed long', c);
    new DataView(this.data).setInt32(this.allocate(4), c, true);
  }

  writeFloat(f) {
    console.assert(typeof f === 'number' && !Q.isNaN(f) && isFinite(f), 'must be a real number, not NaN or Infinity');
    new DataView(this.data).setFloat32(this.allocate(4), f, true);
  }

  writeString(s) {
    if (s) {
      this.write(new Uint8Array(Q.strmem(s)), s.length);
    }
    this.writeChar(0);
  }

  writeCoord(f) {
    // NOTE: when adjusting quantization of coordinates, make sure to update the snap/nudge position logic in Pmove as well
    this.writeLong(f * 8.0);
  }

  writeCoordVector(vec) {
    this.writeCoord(vec[0]);
    this.writeCoord(vec[1]);
    this.writeCoord(vec[2]);
  }

  writeAngle(f) {
    this.writeShort(Math.round((f / 360.0 * 32768.0)) % 32768);
  }

  writeAngleVector(vec) {
    this.writeAngle(vec[0]);
    this.writeAngle(vec[1]);
    this.writeAngle(vec[2]);
  }

  writeRGB(color) {
    this.writeByte(Math.round(color[0] * 255));
    this.writeByte(Math.round(color[1] * 255));
    this.writeByte(Math.round(color[2] * 255));
  }

  writeRGBA(color, alpha) {
    this.writeRGB(color);
    this.writeByte(Math.round(alpha * 255));
  }

  beginReading() {
    this.readcount = 0;
    this.badread = false;
  }

  readChar() {
    if (this.readcount >= this.cursize) {
      this.badread = true;
      // debugger;
      return -1;
    }
    const c = new Int8Array(this.data, this.readcount, 1)[0];
    this.readcount++;
    return c;
  }

  readByte() {
    if (this.readcount >= this.cursize) {
      this.badread = true;
      // debugger;
      return -1;
    }
    const c = new Uint8Array(this.data, this.readcount, 1)[0];
    this.readcount++;
    return c;
  }

  readShort() {
    if ((this.readcount + 2) > this.cursize) {
      this.badread = true;
      // debugger;
      return -1;
    }
    const num = new DataView(this.data).getInt16(this.readcount, true);
    this.readcount += 2;
    return num;
  }

  readUint16() {
    if ((this.readcount + 2) > this.cursize) {
      this.badread = true;
      // debugger;
      return -1;
    }
    const num = new DataView(this.data).getUint16(this.readcount, true);
    this.readcount += 2;
    return num;
  }

  readLong() {
    if ((this.readcount + 4) > this.cursize) {
      this.badread = true;
      // debugger;
      return -1;
    }
    const num = new DataView(this.data).getInt32(this.readcount, true);
    this.readcount += 4;
    return num;
  }

  readFloat() {
    if ((this.readcount + 4) > this.cursize) {
      this.badread = true;
      // debugger;
      return -1;
    }
    const num = new DataView(this.data).getFloat32(this.readcount, true);
    this.readcount += 4;
    return num;
  }

  readString() {
    const chars = [];
    for (let i = 0; i < this.cursize; i++) {
      const c = this.readByte();
      if (c <= 0) {
        break;
      }
      chars.push(String.fromCharCode(c));
    }
    return chars.join('');
  }

  readCoord() {
    return this.readLong() * 0.125;
  }

  readCoordVector() {
    return new Vector(this.readCoord(), this.readCoord(), this.readCoord());
  }

  readAngle() {
    return this.readShort() * (360.0 / 32768.0);
  }

  readAngleVector() {
    return new Vector(this.readAngle(), this.readAngle(), this.readAngle());
  }

  readRGB() {
    return new Vector(
      this.readByte() / 255,
      this.readByte() / 255,
      this.readByte() / 255,
    );
  }

  readRGBA() {
    return [this.readRGB(), this.readByte() / 255];
  }

  /**
   * Write a delta usercmd to the message buffer.
   * @param {Protocol.UserCmd} from previous usercmd
   * @param {Protocol.UserCmd} to current usercmd
   */
  writeDeltaUsercmd(from, to) {
    let bits = 0;

    if (to.forwardmove !== from.forwardmove) {
      bits |= Protocol.cm.CM_FORWARD;
    }

    if (to.sidemove !== from.sidemove) {
      bits |= Protocol.cm.CM_SIDE;
    }

    if (to.upmove !== from.upmove) {
      bits |= Protocol.cm.CM_UP;
    }

    if (to.angles[0] !== from.angles[0]) {
      bits |= Protocol.cm.CM_ANGLE1;
    }

    if (to.angles[1] !== from.angles[1]) {
      bits |= Protocol.cm.CM_ANGLE2;
    }

    if (to.angles[2] !== from.angles[2]) {
      bits |= Protocol.cm.CM_ANGLE3;
    }

    if (to.buttons !== from.buttons) {
      bits |= Protocol.cm.CM_BUTTONS;
    }

    if (to.impulse !== from.impulse) {
      bits |= Protocol.cm.CM_IMPULSE;
    }

    this.writeByte(bits);

    if (bits & Protocol.cm.CM_FORWARD) {
      this.writeShort(to.forwardmove);
    }

    if (bits & Protocol.cm.CM_SIDE) {
      this.writeShort(to.sidemove);
    }

    if (bits & Protocol.cm.CM_UP) {
      this.writeShort(to.upmove);
    }

    if (bits & Protocol.cm.CM_ANGLE1) {
      this.writeAngle(to.angles[0]);
    }

    if (bits & Protocol.cm.CM_ANGLE2) {
      this.writeAngle(to.angles[1]);
    }

    if (bits & Protocol.cm.CM_ANGLE3) {
      this.writeAngle(to.angles[2]);
    }

    if (bits & Protocol.cm.CM_BUTTONS) {
      this.writeByte(to.buttons);
    }

    if (bits & Protocol.cm.CM_IMPULSE) {
      this.writeByte(to.impulse);
    }

    this.writeByte(to.msec);
  }

  /**
   * Read a delta usercmd from the message buffer.
   * @param {Protocol.UserCmd} from previous usercmd
   * @returns {Protocol.UserCmd} current usercmd
   */
  readDeltaUsercmd(from) {
    const to = new Protocol.UserCmd();

    to.set(from);

    const bits = this.readByte();

    if (bits & Protocol.cm.CM_FORWARD) {
      to.forwardmove = this.readShort();
    }

    if (bits & Protocol.cm.CM_SIDE) {
      to.sidemove = this.readShort();
    }

    if (bits & Protocol.cm.CM_UP) {
      to.upmove = this.readShort();
    }

    if (bits & Protocol.cm.CM_ANGLE1) {
      to.angles[0] = this.readAngle();
    }

    if (bits & Protocol.cm.CM_ANGLE2) {
      to.angles[1] = this.readAngle();
    }

    if (bits & Protocol.cm.CM_ANGLE3) {
      to.angles[2] = this.readAngle();
    }

    if (bits & Protocol.cm.CM_BUTTONS) {
      to.buttons = this.readByte();
    }

    if (bits & Protocol.cm.CM_IMPULSE) {
      to.impulse = this.readByte();
    }

    to.msec = this.readByte();

    return to;
  }

  /**
   * Write an array of serializable values to the buffer.
   * @param {Array} serializables array of values to serialize
   */
  writeSerializables(serializables) {
    for (const serializable of serializables) {
      switch (true) {
      case serializable === undefined:
        console.assert(false, 'serializable must not be undefined');
        this.writeByte(Protocol.serializableTypes.null);
        continue;
      case serializable === null:
        this.writeByte(Protocol.serializableTypes.null);
        continue;
      case typeof serializable === 'string':
        this.writeByte(Protocol.serializableTypes.string);
        this.writeString(serializable);
        continue;
      case typeof serializable === 'number':
        if (Number.isInteger(serializable)) {
          if (serializable >= 0 && serializable < 256) {
            this.writeByte(Protocol.serializableTypes.byte);
            this.writeByte(serializable);
          } else if (serializable >= -32768 && serializable < 32768) {
            this.writeByte(Protocol.serializableTypes.short);
            this.writeShort(serializable);
          } else {
            this.writeByte(Protocol.serializableTypes.long);
            this.writeLong(serializable);
          }
        } else {
          this.writeByte(Protocol.serializableTypes.float);
          this.writeFloat(serializable);
        }
        continue;
      case typeof serializable === 'boolean':
        this.writeByte(serializable ? Protocol.serializableTypes.true : Protocol.serializableTypes.false);
        continue;
      case serializable instanceof Vector:
        this.writeByte(Protocol.serializableTypes.vector);
        this.writeCoordVector(serializable);
        continue;
      case serializable instanceof Array:
        this.writeByte(Protocol.serializableTypes.array);
        this.writeSerializables(serializable);
        continue;
      }

      const handler = serializableHandlers.find((h) => serializable instanceof h.constructor);

      if (handler) {
        this.writeByte(handler.id);
        handler.serialize(this, serializable);
        continue;
      }

      throw new TypeError(`Unsupported argument type: ${typeof serializable}`);
    }

    // end of event data
    this.writeByte(Protocol.serializableTypes.none);
  }

  /**
   * Read an array of serializable values from the buffer (client-side).
   * @returns {Array} array of deserialized values
   */
  readSerializablesOnClient() {
    const serializables = [];

    while (true) {
      const type = this.readByte();
      if (type === Protocol.serializableTypes.none) {
        break; // end of stream of serializables
      }

      switch (type) {
      case Protocol.serializableTypes.string:
        serializables.push(this.readString());
        continue;
      case Protocol.serializableTypes.long:
        serializables.push(this.readLong());
        continue;
      case Protocol.serializableTypes.short:
        serializables.push(this.readShort());
        continue;
      case Protocol.serializableTypes.byte:
        serializables.push(this.readByte());
        continue;
      case Protocol.serializableTypes.float:
        serializables.push(this.readFloat());
        continue;
      case Protocol.serializableTypes.true:
        serializables.push(true);
        continue;
      case Protocol.serializableTypes.false:
        serializables.push(false);
        continue;
      case Protocol.serializableTypes.null:
        serializables.push(null);
        continue;
      case Protocol.serializableTypes.vector:
        serializables.push(this.readCoordVector());
        continue;
      case Protocol.serializableTypes.array:
        serializables.push(this.readSerializablesOnClient());
        continue;
      }

      const handler = serializableHandlers.find((h) => h.id === type);

      if (handler) {
        serializables.push(handler.deserializeOnClient(this));
        continue;
      }

      throw new TypeError(`Unsupported serializable type: ${type}`);
    }

    return serializables;
  }
};
