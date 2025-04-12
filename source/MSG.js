/* global MSG, Q, NET, SZ, Vector, Protocol */

// eslint-disable-next-line no-global-assign
MSG = {};

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

MSG.BeginReading = function() {
  MSG.readcount = 0;
  MSG.badread = false;
};

MSG.ReadChar = function() {
  if (MSG.readcount >= NET.message.cursize) {
    MSG.badread = true;
    return -1;
  }
  const c = (new Int8Array(NET.message.data, MSG.readcount, 1))[0];
  ++MSG.readcount;
  return c;
};

MSG.ReadByte = function() {
  if (MSG.readcount >= NET.message.cursize) {
    MSG.badread = true;
    return -1;
  }
  const c = (new Uint8Array(NET.message.data, MSG.readcount, 1))[0];
  ++MSG.readcount;
  return c;
};

MSG.ReadShort = function() {
  if ((MSG.readcount + 2) > NET.message.cursize) {
    MSG.badread = true;
    return -1;
  }
  const c = (new DataView(NET.message.data)).getInt16(MSG.readcount, true);
  MSG.readcount += 2;
  return c;
};

MSG.ReadLong = function() {
  if ((MSG.readcount + 4) > NET.message.cursize) {
    MSG.badread = true;
    return -1;
  }
  const c = (new DataView(NET.message.data)).getInt32(MSG.readcount, true);
  MSG.readcount += 4;
  return c;
};

MSG.ReadFloat = function() {
  if ((MSG.readcount + 4) > NET.message.cursize) {
    MSG.badread = true;
    return -1;
  }
  const f = (new DataView(NET.message.data)).getFloat32(MSG.readcount, true);
  MSG.readcount += 4;
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
  return string.join('');
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
