/* global MSG, Q, NET, SZ */

// eslint-disable-next-line no-global-assign
MSG = {};

MSG.WriteChar = function(sb, c) {
  (new DataView(sb.data)).setInt8(SZ.GetSpace(sb, 1), c);
};

MSG.WriteByte = function(sb, c) {
  (new DataView(sb.data)).setUint8(SZ.GetSpace(sb, 1), c);
};

MSG.WriteShort = function(sb, c) {
  (new DataView(sb.data)).setInt16(SZ.GetSpace(sb, 2), c, true);
};

MSG.WriteLong = function(sb, c) {
  (new DataView(sb.data)).setInt32(SZ.GetSpace(sb, 4), c, true);
};

MSG.WriteFloat = function(sb, f) {
  (new DataView(sb.data)).setFloat32(SZ.GetSpace(sb, 4), f, true);
};

MSG.WriteString = function(sb, s) {
  if (s != null) {
    SZ.Write(sb, new Uint8Array(Q.strmem(s)), s.length);
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

MSG.ReadAngle = function() {
  return MSG.ReadChar() * 1.40625;
};
