/* global Con, SZ, Sys */

// eslint-disable-next-line no-global-assign
SZ = {};

SZ.Buffer = class SzBuffer {
  constructor(size) {
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
        Sys.Error('SzBuffer.allocate: overflow without allowoverflow set');
      }

      if (size > this.maxsize) {
        Sys.Error('SzBuffer.allocate: ' + size + ' is > full buffer size');
      }

      this.overflowed = true;
      Con.Print('SzBuffer.allocate: overflow\n');
      this.cursize = 0;
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
};
