/* global MSG, Q, NET, Vector, Protocol, Con */

// eslint-disable-next-line no-global-assign
MSG = {};

MSG.Buffer = class SzBuffer {
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
    for (let i = 0; i < data.length; ++i) {
      buf[dest + i] = data.charCodeAt(i);
    }
  }

  toHexString() {
    let output = "";
    const u8 = new Uint8Array(this.data, 0, this.cursize);
    const lineBytes = 16;
    for (let i = 0; i < u8.length; i += lineBytes) {
      let line = ("00000000" + i.toString(16)).slice(-8) + ": ";
      let hexPart = "";
      let asciiPart = "";
      for (let j = 0; j < lineBytes; j++) {
        if (i + j < u8.length) {
          const byte = u8[i + j];
          hexPart += ("0" + byte.toString(16)).slice(-2) + " ";
          asciiPart += (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".");
        } else {
          hexPart += "   ";
          asciiPart += " ";
        }
      }
      line += hexPart + " " + asciiPart;
      output += line + "\n";
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

  writeLong(c) {
    console.assert(c >= -2147483648 && c <= 2147483647, 'must be signed long', c);
    new DataView(this.data).setInt32(this.allocate(4), c, true);
  }

  writeFloat(f) {
    console.assert(typeof f === 'number' && !isNaN(f) && isFinite(f), 'must be a real number, not NaN or Infinity');
    new DataView(this.data).setFloat32(this.allocate(4), f, true);
  }

  writeString(s) {
    if (s) {
      this.write(new Uint8Array(Q.strmem(s)), s.length);
    }
    this.writeChar(0);
  }

  writeCoord(f) {
    this.writeShort(f * 8.0);
  }

  writeCoordVector(vec) {
    this.writeCoord(vec[0]);
    this.writeCoord(vec[1]);
    this.writeCoord(vec[2]);
  }

  writeAngle(f) {
    this.writeByte((f * (256.0 / 360.0)) & 255);
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
};

MSG.WriteChar = function(sb, c) {
  console.assert(c >= -128 && c <= 127, 'must be signed byte', c);

  (new DataView(sb.data)).setInt8(sb.allocate(1), c);
};

MSG.WriteByte = function(sb, c) {
  console.assert(c >= 0 && c <= 255, 'must be unsigned byte', c);

  (new DataView(sb.data)).setUint8(sb.allocate(1), c);
};

MSG.WriteShort = function(sb, c) {
  console.assert(c >= -32768 && c <= 32767, 'must be signed short', c);

  (new DataView(sb.data)).setInt16(sb.allocate(2), c, true);
};

MSG.WriteLong = function(sb, c) {
  console.assert(c >= -2147483648 && c <= 2147483647, 'must be signed long', c);

  (new DataView(sb.data)).setInt32(sb.allocate(4), c, true);
};

MSG.WriteFloat = function(sb, f) {
  console.assert(typeof f === 'number' && !isNaN(f) && isFinite(f), 'must be a real number, not NaN or Infinity',);

  (new DataView(sb.data)).setFloat32(sb.allocate(4), f, true);
};

MSG.WriteString = function(sb, s) {
  if (s != null) {
    sb.write(new Uint8Array(Q.strmem(s)), s.length);
  }
  MSG.WriteChar(sb, 0);
};

MSG.WriteCoord = function(sb, f) {
  MSG.WriteShort(sb, f * 8.0);
};

MSG.WriteCoordVector = function(sb, vec) {
  MSG.WriteCoord(sb, vec[0]);
  MSG.WriteCoord(sb, vec[1]);
  MSG.WriteCoord(sb, vec[2]);
};

MSG.WriteAngle = function(sb, f) {
  MSG.WriteByte(sb, ((f >> 0) * (256.0 / 360.0)) & 255);
};

MSG.WriteAngleVector = function(sb, vec) {
  MSG.WriteAngle(sb, vec[0]);
  MSG.WriteAngle(sb, vec[1]);
  MSG.WriteAngle(sb, vec[2]);
};

MSG.WriteRGB = function(sb, color) {
  MSG.WriteByte(sb, Math.round(color[0] * 255));
  MSG.WriteByte(sb, Math.round(color[1] * 255));
  MSG.WriteByte(sb, Math.round(color[2] * 255));
};

MSG.WriteRGBA = function(sb, color, alpha) {
  MSG.WriteRGB(sb, color);
  MSG.WriteByte(sb, Math.round(alpha * 255));
};

/**
 * Write a delta usercmd to the message buffer.
 * @param {*} sb message buffer
 * @param {Protocol.UserCmd} from previous usercmd
 * @param {Protocol.UserCmd} to current usercmd
 */
MSG.WriteDeltaUsercmd = function(sb, from, to) {
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

  MSG.WriteByte(sb, bits);

  if (bits & Protocol.cm.CM_FORWARD) {
    MSG.WriteShort(sb, to.forwardmove);
  }

  if (bits & Protocol.cm.CM_SIDE) {
    MSG.WriteShort(sb, to.sidemove);
  }

  if (bits & Protocol.cm.CM_UP) {
    MSG.WriteShort(sb, to.upmove);
  }

  if (bits & Protocol.cm.CM_ANGLE1) {
    MSG.WriteAngle(sb, to.angles[0]);
  }

  if (bits & Protocol.cm.CM_ANGLE2) {
    MSG.WriteAngle(sb, to.angles[1]);
  }

  if (bits & Protocol.cm.CM_ANGLE3) {
    MSG.WriteAngle(sb, to.angles[2]);
  }

  if (bits & Protocol.cm.CM_BUTTONS) {
    MSG.WriteByte(sb, to.buttons);
  }

  if (bits & Protocol.cm.CM_IMPULSE) {
    MSG.WriteByte(sb, to.impulse);
  }

  MSG.WriteByte(sb, to.msec);
};



/**
 * Read a delta usercmd from the message buffer.
 * To will be set to from and updated with the new values in-place.
 * @param {Protocol.UserCmd} from previous usercmd
 * @returns {Protocol.UserCmd} current usercmd
 */
MSG.ReadDeltaUsercmd = function(from) {
  const to = new Protocol.UserCmd();

  to.set(from);

  const bits = MSG.ReadByte();

  if (bits & Protocol.cm.CM_FORWARD) {
    to.forwardmove = MSG.ReadShort();
  }

  if (bits & Protocol.cm.CM_SIDE) {
    to.sidemove = MSG.ReadShort();
  }

  if (bits & Protocol.cm.CM_UP) {
    to.upmove = MSG.ReadShort();
  }

  if (bits & Protocol.cm.CM_ANGLE1) {
    to.angles[0] = MSG.ReadAngle();
  }

  if (bits & Protocol.cm.CM_ANGLE2) {
    to.angles[1] = MSG.ReadAngle();
  }

  if (bits & Protocol.cm.CM_ANGLE3) {
    to.angles[2] = MSG.ReadAngle();
  }

  if (bits & Protocol.cm.CM_BUTTONS) {
    to.buttons = MSG.ReadByte();
  }

  if (bits & Protocol.cm.CM_IMPULSE) {
    to.impulse = MSG.ReadByte();
  }

  to.msec = MSG.ReadByte();

  return to;
};

// MSG._messageLog = [];

MSG.BeginReading = function() {
  // MSG._messageLog = [];
  MSG.readcount = 0;
  MSG.badread = false;
};

MSG.PrintLastRead = function() {
  for (const {type, value} of MSG._messageLog) {
    Con.Print(`"${value}" (${type})\n`);
  }
};

MSG.ReadChar = function() {
  if (MSG.readcount >= NET.message.cursize) {
    MSG.badread = true;
    // debugger;
    return -1;
  }
  const c = (new Int8Array(NET.message.data, MSG.readcount, 1))[0];
  ++MSG.readcount;
  // MSG._messageLog.push({type: 'char', value: c});
  return c;
};

MSG.ReadByte = function() {
  if (MSG.readcount >= NET.message.cursize) {
    MSG.badread = true;
    // debugger;
    return -1;
  }
  const c = (new Uint8Array(NET.message.data, MSG.readcount, 1))[0];
  ++MSG.readcount;
  // MSG._messageLog.push({type: 'byte', value: c});
  return c;
};

MSG.ReadShort = function() {
  if ((MSG.readcount + 2) > NET.message.cursize) {
    MSG.badread = true;
    // debugger;
    return -1;
  }
  const c = (new DataView(NET.message.data)).getInt16(MSG.readcount, true);
  MSG.readcount += 2;
  // MSG._messageLog.push({type: 'short', value: c});
  return c;
};

MSG.ReadLong = function() {
  if ((MSG.readcount + 4) > NET.message.cursize) {
    MSG.badread = true;
    // debugger;
    return -1;
  }
  const c = (new DataView(NET.message.data)).getInt32(MSG.readcount, true);
  MSG.readcount += 4;
  // MSG._messageLog.push({type: 'long', value: c});
  return c;
};

MSG.ReadFloat = function() {
  if ((MSG.readcount + 4) > NET.message.cursize) {
    MSG.badread = true;
    // debugger;
    return -1;
  }
  const f = (new DataView(NET.message.data)).getFloat32(MSG.readcount, true);
  MSG.readcount += 4;
  // MSG._messageLog.push({type: 'float', value: f});
  return f;
};

MSG.ReadString = function() {
  const string = []; let l; let c;
  for (l = 0; l < 2048; ++l) {
    c = MSG.ReadByte();
    if (c <= 0) {
      break;
    }
    string[l] = String.fromCharCode(c);
  }
  const s = string.join('');
  // MSG._messageLog.push({type: 'string', value: s});
  return s;
};

MSG.ReadCoord = function() {
  return MSG.ReadShort() * 0.125;
};

MSG.ReadCoordVector = function() {
  return new Vector(MSG.ReadCoord(), MSG.ReadCoord(), MSG.ReadCoord());
};

MSG.ReadAngle = function() {
  return MSG.ReadChar() * 1.40625;
};

MSG.ReadAngleVector = function() {
  return new Vector(MSG.ReadAngle(), MSG.ReadAngle(), MSG.ReadAngle());
};

MSG.ReadRGB = function() {
  return new Vector(MSG.ReadByte() / 255, MSG.ReadByte() / 255, MSG.ReadByte() / 255);
};

MSG.ReadRGBA = function() {
  return [MSG.ReadRGB(), MSG.ReadByte() / 255];
};
