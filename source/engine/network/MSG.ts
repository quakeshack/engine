import type { ClientEventValue, SerializableType } from '../../shared/GameInterfaces.ts';
import Q from '../../shared/Q.ts';
import Vector from '../../shared/Vector.ts';
import * as Protocol from '../network/Protocol.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';

type SerializableVectorLike = ArrayLike<number>;
type ServerSerializableValue = SerializableType | object;
type SerializableValue = ClientEventValue;
type SerializableConstructor<T extends object = object> = abstract new (...args: never[]) => T;

type SerializableHandlers<T extends object = object, ServerValue = object, ClientValue = object> = {
  serialize: (sz: SzBuffer, object: T) => void;
  deserializeOnServer: (sz: SzBuffer) => ServerValue;
  deserializeOnClient: (sz: SzBuffer) => ClientValue;
};

type RegisteredSerializableHandler = {
  id: number;
  constructor: SerializableConstructor;
  serialize: (sz: SzBuffer, object: object) => void;
  deserializeOnServer: (sz: SzBuffer) => unknown;
  deserializeOnClient: (sz: SzBuffer) => unknown;
};

let { Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con } = getCommonRegistry());
});

const serializableHandlers: RegisteredSerializableHandler[] = [];

/**
 * Registers a custom serializable type for network transmission.
 * @param constructor constructor used to match values during serialization
 * @param root0 serialization handlers
 * @param root0.serialize writes the object into the size buffer
 * @param root0.deserializeOnServer reads the object on the server side
 * @param root0.deserializeOnClient reads the object on the client side
 */
export function registerSerializableType<T extends object, ServerValue = T, ClientValue = T>(
  constructor: SerializableConstructor<T>,
  { serialize, deserializeOnServer, deserializeOnClient }: SerializableHandlers<T, ServerValue, ClientValue>,
): void {
  serializableHandlers.push({
    constructor,
    serialize: serialize as (sz: SzBuffer, object: object) => void,
    deserializeOnServer,
    deserializeOnClient,
    id: Object.keys(Protocol.serializableTypes).length + serializableHandlers.length,
  });
}

export class SzBuffer {
  readcount = 0;
  badread = false;
  name: string;
  data: ArrayBuffer;
  cursize: number;
  allowoverflow: boolean;
  overflowed: boolean;

  constructor(size: number, name = 'anonymous') {
    this.name = name;
    this.data = new ArrayBuffer(size);
    this.cursize = 0;
    this.allowoverflow = false;
    this.overflowed = false;
  }

  get maxsize(): number {
    return this.data.byteLength;
  }

  clear(): void {
    this.cursize = 0;
    this.overflowed = false;
  }

  copy(): SzBuffer {
    const copy = new SzBuffer(this.maxsize, this.name);

    copy.cursize = this.cursize;
    copy.overflowed = this.overflowed;

    const source = new Uint8Array(this.data);
    const destination = new Uint8Array(copy.data);

    destination.set(source);

    return copy;
  }

  set(other: SzBuffer): this {
    this.name = other.name;
    this.data = new ArrayBuffer(other.maxsize);
    new Uint8Array(this.data).set(new Uint8Array(other.data));
    this.cursize = other.cursize;
    this.allowoverflow = other.allowoverflow;
    this.overflowed = other.overflowed;

    return this;
  }

  allocate(size: number): number {
    if (this.cursize + size > this.maxsize) {
      if (!this.allowoverflow) {
        throw new RangeError('SzBuffer.allocate: overflow without allowoverflow set');
      }

      if (size > this.maxsize) {
        throw new RangeError(`SzBuffer.allocate: ${size} is > full buffer size`);
      }

      this.overflowed = true;
      this.cursize = 0;

      Con.Print('SzBuffer.allocate: overflow\n');
      // eslint-disable-next-line no-debugger
      debugger;
    }

    const cursorSize = this.cursize;

    this.cursize += size;

    return cursorSize;
  }

  write(data: Uint8Array, length: number): void {
    const view = new Uint8Array(this.data, this.allocate(length), length);

    view.set(data.subarray(0, length));
  }

  print(data: string): void {
    const buffer = new Uint8Array(this.data);
    let destination: number;

    if (this.cursize !== 0) {
      if (buffer[this.cursize - 1] === 0) {
        destination = this.allocate(data.length - 1) - 1;
      } else {
        destination = this.allocate(data.length);
      }
    } else {
      destination = this.allocate(data.length);
    }

    for (let i = 0; i < data.length; i++) {
      buffer[destination + i] = data.charCodeAt(i);
    }
  }

  toHexString(): string {
    let output = '';
    const bytes = new Uint8Array(this.data, 0, this.cursize);
    const lineBytes = 16;

    for (let i = 0; i < bytes.length; i += lineBytes) {
      let line = `00000000${i.toString(16)}`.slice(-8) + ': ';
      let hexPart = '';
      let asciiPart = '';

      for (let j = 0; j < lineBytes; j++) {
        if (i + j < bytes.length) {
          const byte = bytes[i + j];

          hexPart += `0${byte.toString(16)}`.slice(-2) + ' ';
          asciiPart += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
        } else {
          hexPart += '   ';
          asciiPart += ' ';
        }
      }

      line += `${hexPart} ${asciiPart}`;
      output += `${line}\n`;
    }

    return output;
  }

  toString(): string {
    return `SzBuffer: (${this.name}) ${this.cursize} bytes of ${this.maxsize} bytes used, overflowed? ${this.overflowed ? 'yes' : 'no'}`;
  }

  writeChar(value: number): void {
    console.assert(value >= -128 && value <= 127, 'must be signed byte', value);
    new DataView(this.data).setInt8(this.allocate(1), value);
  }

  writeByte(value: number): void {
    console.assert(value >= 0 && value <= 255, 'must be unsigned byte', value);
    new DataView(this.data).setUint8(this.allocate(1), value);
  }

  writeShort(value: number): void {
    console.assert(value >= -32768 && value <= 32767, 'must be signed short', value);
    new DataView(this.data).setInt16(this.allocate(2), value, true);
  }

  writeUint16(value: number): void {
    console.assert(value >= 0 && value <= 65535, 'must be unsigned short', value);
    new DataView(this.data).setUint16(this.allocate(2), value, true);
  }

  writeLong(value: number): void {
    console.assert(value >= -2147483648 && value <= 2147483647, 'must be signed long', value);
    new DataView(this.data).setInt32(this.allocate(4), value, true);
  }

  writeFloat(value: number): void {
    console.assert(typeof value === 'number' && !Q.isNaN(value) && Number.isFinite(value), 'must be a real number, not NaN or Infinity');
    new DataView(this.data).setFloat32(this.allocate(4), value, true);
  }

  writeString(value: string): void {
    if (value) {
      this.write(new Uint8Array(Q.strmem(value)), value.length);
    }

    this.writeChar(0);
  }

  writeCoord(value: number): void {
    this.writeLong(value * 8.0);
  }

  writeCoordVector(vector: SerializableVectorLike): void {
    this.writeCoord(vector[0]);
    this.writeCoord(vector[1]);
    this.writeCoord(vector[2]);
  }

  writeAngle(value: number): void {
    this.writeShort(Math.round((value / 360.0 * 32768.0)) % 32768);
  }

  writeAngleVector(vector: SerializableVectorLike): void {
    this.writeAngle(vector[0]);
    this.writeAngle(vector[1]);
    this.writeAngle(vector[2]);
  }

  writeRGB(color: SerializableVectorLike): void {
    this.writeByte(Math.round(color[0] * 255));
    this.writeByte(Math.round(color[1] * 255));
    this.writeByte(Math.round(color[2] * 255));
  }

  writeRGBA(color: SerializableVectorLike, alpha: number): void {
    this.writeRGB(color);
    this.writeByte(Math.round(alpha * 255));
  }

  beginReading(): void {
    this.readcount = 0;
    this.badread = false;
  }

  readChar(): number {
    if (this.readcount >= this.cursize) {
      this.badread = true;
      return -1;
    }

    const value = new Int8Array(this.data, this.readcount, 1)[0];

    this.readcount++;

    return value;
  }

  readByte(): number {
    if (this.readcount >= this.cursize) {
      this.badread = true;
      return -1;
    }

    const value = new Uint8Array(this.data, this.readcount, 1)[0];

    this.readcount++;

    return value;
  }

  readShort(): number {
    if (this.readcount + 2 > this.cursize) {
      this.badread = true;
      return -1;
    }

    const value = new DataView(this.data).getInt16(this.readcount, true);

    this.readcount += 2;

    return value;
  }

  readUint16(): number {
    if (this.readcount + 2 > this.cursize) {
      this.badread = true;
      return -1;
    }

    const value = new DataView(this.data).getUint16(this.readcount, true);

    this.readcount += 2;

    return value;
  }

  readLong(): number {
    if (this.readcount + 4 > this.cursize) {
      this.badread = true;
      return -1;
    }

    const value = new DataView(this.data).getInt32(this.readcount, true);

    this.readcount += 4;

    return value;
  }

  readFloat(): number {
    if (this.readcount + 4 > this.cursize) {
      this.badread = true;
      return -1;
    }

    const value = new DataView(this.data).getFloat32(this.readcount, true);

    this.readcount += 4;

    return value;
  }

  readString(): string {
    const chars: string[] = [];

    for (let i = 0; i < this.cursize; i++) {
      const character = this.readByte();

      if (character <= 0) {
        break;
      }

      chars.push(String.fromCharCode(character));
    }

    return chars.join('');
  }

  readCoord(): number {
    return this.readLong() * 0.125;
  }

  readCoordVector(): Vector {
    return new Vector(this.readCoord(), this.readCoord(), this.readCoord());
  }

  readAngle(): number {
    return this.readShort() * (360.0 / 32768.0);
  }

  readAngleVector(): Vector {
    return new Vector(this.readAngle(), this.readAngle(), this.readAngle());
  }

  readRGB(): Vector {
    return new Vector(
      this.readByte() / 255,
      this.readByte() / 255,
      this.readByte() / 255,
    );
  }

  readRGBA(): [Vector, number] {
    return [this.readRGB(), this.readByte() / 255];
  }

  writeDeltaUsercmd(from: Protocol.UserCmd, to: Protocol.UserCmd): void {
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

  readDeltaUsercmd(from: Protocol.UserCmd): Protocol.UserCmd {
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

  writeSerializables(serializables: readonly ServerSerializableValue[]): void {
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

      const handler = serializableHandlers.find((candidate) => serializable instanceof candidate.constructor);

      if (handler) {
        this.writeByte(handler.id);
        handler.serialize(this, serializable);
        continue;
      }

      throw new TypeError(`Unsupported argument type: ${typeof serializable}`);
    }

    this.writeByte(Protocol.serializableTypes.none);
  }

  readSerializablesOnClient(): SerializableValue[] {
    const serializables: SerializableValue[] = [];

    while (true) {
      const type = this.readByte();

      if (type === Protocol.serializableTypes.none) {
        break;
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

      const handler = serializableHandlers.find((candidate) => candidate.id === type);

      if (handler) {
        serializables.push(handler.deserializeOnClient(this) as SerializableValue);
        continue;
      }

      throw new TypeError(`Unsupported serializable type: ${type}`);
    }

    return serializables;
  }
}
