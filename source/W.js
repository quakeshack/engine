/* global W, COM, Q, VID, Sys */

// eslint-disable-next-line no-global-assign
W = {};

/** @private */
W._handlers = [];

/** @private */
W.WadFileInterface = class WadFileInterface {
  constructor() {
    /** @private */
    this._lumps = {};
  }

  // eslint-disable-next-line no-unused-vars
  load(view) {
    console.assert(null, 'WadFileInterface.load: not implemented');
  }

  /**
   * This will return the raw data for the given name.
   * @param {string} name identifer of the lump to retrieve
   * @returns {ArrayBuffer} the lump data
   */
  // eslint-disable-next-line no-unused-vars
  getLump(name) {
    console.assert(null, 'WadFileInterface.getLump: not implemented');
    return new ArrayBuffer(0);
  }

  /**
   * This will return the palette translated data for the given name.
   * @param {string} name identifer of the lump to retrieve
   * @param {?number} mipmapLevel mipmap level to retrieve, will always take the most available mipmap level
   * @returns {W._WadLumpTexture} the decoded texture data
   */
  // eslint-disable-next-line no-unused-vars
  getLumpMipmap(name, mipmapLevel) {
    console.assert(null, 'WadFileInterface.getLumpMipmap: not implemented');
    return new ArrayBuffer(0);
  }

  /**
   * Helper function to convert indexed 8-bit data to RGBA format.
   * @param {Uint8Array} uint8data indexed 8-bit data, each byte is an index to the palette
   * @param {number} width width
   * @param {number} height height
   * @param {Uint8Array} palette palette data, 256 colors, each color is 3 bytes (RGB)
   * @param {?number} transparentColor optional color index to treat as transparent (default is null, no transparency)
   * @returns {Uint8Array} RGBA data, each pixel is 4 bytes (R, G, B, A)
   */
  _indexToRGB(uint8data, width, height, palette, transparentColor = null) {
    const rgba = new Uint8Array(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      const colorIndex = uint8data[i];
      if (transparentColor !== null && colorIndex === transparentColor) {
        rgba[i * 4 + 0] = 0;
        rgba[i * 4 + 1] = 0;
        rgba[i * 4 + 2] = 0;
        rgba[i * 4 + 3] = 0;
        continue;
      }
      // lookup the color in the palette
      rgba[i * 4 + 0] = palette[colorIndex * 3];
      rgba[i * 4 + 1] = palette[colorIndex * 3 + 1];
      rgba[i * 4 + 2] = palette[colorIndex * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }

    return rgba;
  }
};

/**
 * WAD lump texture representation.
 * @private
 */
W.WadLumpTexture = class WadLumpTexture {
  /**
   * @param {string} name internal texture name
   * @param {number} width width
   * @param {number} height height
   * @param {Uint8Array} data RGBA texture data
   */
  constructor(name, width, height, data) {
    this.name = name; // lump name
    this.width = width; // texture width
    this.height = height; // texture height
    this.data = data; // texture data (Uint8Array)

    Object.freeze(this);
  }

  toString() {
    return `WadLumpTexture(${this.name}, ${this.width} x ${this.height} pixels, ${this.data.length} bytes)`;
  }
};

/**
 * Quake 1 WAD file format handler.
 * @private
 */
W.Wad2File = class Wad2File extends W.WadFileInterface {
  static MAGIC = 0x32444157; // 'WAD2'

  constructor() {
    super();
    this.palette = VID.d_8to24table_u8; // use the palette from VID
  }

  load(base) {
    const view = new DataView(base);
    console.assert(view.getUint32(0, true) === this.constructor.MAGIC, 'magic number');
    const numlumps = view.getUint32(4, true);
    let infotableofs = view.getUint32(8, true);
    for (let i = 0; i < numlumps; ++i) {
      const size = view.getUint32(infotableofs + 4, true);
      const type = view.getUint8(infotableofs + 12);
      const lump = new ArrayBuffer(size);
      const name = Q.memstr(new Uint8Array(base, infotableofs + 16, 16));
      (new Uint8Array(lump)).set(new Uint8Array(base, view.getUint32(infotableofs, true), size));
      this._lumps[name.toUpperCase()] = {
        data: lump,
        type: type, // lump type
        size: size, // uncompressed size
        name: name,
      };
      infotableofs += 32;
    }
  }

  /**
   * This will return the raw data for the given name.
   * @param {string} name identifer of the lump to retrieve
   * @returns {ArrayBuffer} the lump data
   */
  getLump(name) {
    const lump = this._lumps[name.toUpperCase()];

    if (!lump) {
      Sys.Error('Wad2File.getLump: ' + name + ' not found');
      return null;
    }

    return lump.data;
  }

  /**
   * This will return the palette translated data for the given name.
   * @param {string} name identifer of the lump to retrieve
   * @param {?number} mipmapLevel always 0, WAD2 does not support mipmaps
   * @returns {W._WadLumpTexture} the decoded texture data
   */
  // eslint-disable-next-line no-unused-vars
  getLumpMipmap(name, mipmapLevel = 0) {
    const data = this.getLump(name);
    const view = new DataView(data);

    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);

    // TODO: handle different types of lumps, right now it’s only supports pichead_t

    const rgba = this._indexToRGB(new Uint8Array(data, 8, width * height), width, height, this.palette, 255);

    return new W.WadLumpTexture(name, width, height, rgba);
  }
};

W._handlers.push(W.Wad2File);

/**
 * GoldSrc WAD3 file format handler.
 * @private
 */
W.Wad3File = class Wad3File extends W.WadFileInterface {
  static MAGIC = 0x33444157; // 'WAD3'

  load(base) {
    const view = new DataView(base);
    console.assert(view.getUint32(0, true) === this.constructor.MAGIC, 'magic number');
    const numlumps = view.getUint32(4, true);
    let infotableofs = view.getUint32(8, true);

    for (let i = 0; i < numlumps; ++i) {
      const filepos = view.getUint32(infotableofs, true);
      const disksize = view.getUint32(infotableofs + 4, true);
      const size = view.getUint32(infotableofs + 8, true); // uncompressed size
      const type = view.getUint8(infotableofs + 12);
      const compression = view.getUint8(infotableofs + 13);
      const name = Q.memstr(new Uint8Array(base, infotableofs + 16, 16));
      const lump = new ArrayBuffer(size);

      if (!compression) { // Uncompressed
        (new Uint8Array(lump)).set(new Uint8Array(base, filepos, disksize));
      } else { // Compressed
        const compressedData = new Uint8Array(base, filepos, disksize);
        const decompressed = this.constructor._decompressLZ(compressedData, size);
        (new Uint8Array(lump)).set(decompressed);
      }

      this._lumps[name.toUpperCase()] = {
        data: lump,
        type: type,
        size: size,
        name: name,
      };

      infotableofs += 32;
    }
  }

  // eslint-disable-next-line no-unused-vars
  _parseQPicLump(name, data, mipmapLevel) {
    const view = new DataView(data);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);

    const palette = new Uint8Array(data,
      8 + // 8 = header
      width * height + // pixel data
      2, // how many colors being used for palette in short
      768 // 768 = 256 colors * 3 bytes (RGB)
    );

    const uint8data = new Uint8Array(data, 8, width * height);
    const rgba = this._indexToRGB(uint8data, width, height, palette, 255);

    return new W.WadLumpTexture(name, width, height, rgba);
  }

  _parseMiptexLump(name, data, mipmapLevel) {
    const view = new DataView(data);
    const width = view.getUint32(16, true);
    const height = view.getUint32(20, true);

    const mipoffsets = [
      view.getUint32(24, true),
      view.getUint32(28, true),
      view.getUint32(32, true),
      view.getUint32(36, true),
    ];

    console.assert(mipmapLevel >= 0 && mipmapLevel < mipoffsets.length, 'valid mipmap level');

    const texName = Q.memstr(new Uint8Array(data, 0, 16)) || name;

    const mipDataOffset = mipoffsets[mipmapLevel];
    const scale = 1 << mipmapLevel;
    const swidth = width / scale;
    const sheight = height / scale;

    const uint8data = new Uint8Array(data, mipDataOffset, swidth * sheight);

    const palette = new Uint8Array(data,
      40 + // 40 = header
      width * height + // pixel data
      width / 2 * height / 2 + // mipmap level 1
      width / 4 * height / 4 + // mipmap level 2
      width / 8 * height / 8 + // mipmap level 3
      2, // how many colors being used for palette in short
      768 // 768 = 256 colors * 3 bytes (RGB)
    );

    const rgba = this._indexToRGB(uint8data, swidth, sheight, palette, 255);

    return new W.WadLumpTexture(texName, swidth, sheight, rgba);
  }

  /**
   * This will return the raw data for the given name.
   * @param {string} name identifer of the lump to retrieve
   * @returns {ArrayBuffer} the lump data
   */
  getLump(name) {
    const lump = this._lumps[name.toUpperCase()];

    if (!lump) {
      Sys.Error('Wad2File.getLump: ' + name + ' not found');
      return null;
    }

    return lump;
  }

  /**
   * This will return the palette translated data for the given name.
   * @param {string} name name of the lump to retrieve
   * @param {number} mipmapLevel 0..3, 0 is the base level
   * @returns {W._WadLumpTexture} the decoded texture data
   */
  getLumpMipmap(name, mipmapLevel = 0) {
    const lumpInfo = this._lumps[name.toUpperCase()];

    if (!lumpInfo) {
      Sys.Error('Wad3File.getLump: ' + name + ' not found');
      return null;
    }

    switch (lumpInfo.type) {
      case 0x43: // miptex
      case 0x40: // spraydecal
        return this._parseMiptexLump(lumpInfo.name, lumpInfo.data, mipmapLevel);

      case 0x42: // QPic
        return this._parseQPicLump(lumpInfo.name, lumpInfo.data, mipmapLevel);

      case 0x46: // font
        console.assert(false, 'Wad3File.getLumpMipmap: font handling not implemented');
        return null; // TODO: implement font handling
    }

    Sys.Error('Wad3File.getLumpMipmap: ' + name + ' has not a valid lump type (' + lumpInfo.type + ')');
    return null;
  }

  /**
   * Decompress LZ-compressed data from GoldSrc WAD3 files
   * @param {Uint8Array} compressed - The compressed data
   * @param {number} uncompressedSize - Expected size of uncompressed data
   * @returns {Uint8Array} - The decompressed data
   */
  static _decompressLZ(compressed, uncompressedSize) {
    const output = new Uint8Array(uncompressedSize);
    let inPos = 0;
    let outPos = 0;

    while (inPos < compressed.length && outPos < uncompressedSize) {
      const controlByte = compressed[inPos++];

      // Process each bit in the control byte
      for (let bit = 0; bit < 8 && inPos < compressed.length && outPos < uncompressedSize; bit++) {
        if ((controlByte & (1 << bit)) === 0) {
          // Literal byte - copy directly
          output[outPos++] = compressed[inPos++];
        } else {
          // Back-reference - extract offset and length
          if (inPos + 1 >= compressed.length) break;

          const byte1 = compressed[inPos++];
          const byte2 = compressed[inPos++];

          // GoldSrc LZ format:
          // - First 12 bits are offset (from current position backwards)
          // - Last 4 bits are length - 3 (minimum match length is 3)
          const offset = ((byte2 & 0x0F) << 8) | byte1;
          const length = (byte2 >> 4) + 3;

          // Copy from the sliding window
          const copyStart = outPos - offset;
          if (copyStart < 0 || offset === 0) {
            // Invalid offset, skip this match
            continue;
          }

          // Copy bytes, handling overlapping regions
          for (let i = 0; i < length && outPos < uncompressedSize; i++) {
            output[outPos] = output[copyStart + i];
            outPos++;
          }
        }
      }
    }

    return output;
  };
};

W._handlers.push(W.Wad3File);

/**
 * Loads given WAD file. Supports multiple WAD formats (WAD2, WAD3).
 * @param {string} filename wad file path
 * @returns {W.WadFileInterface|null} the loaded WAD file or null if not found
 */
W.LoadFile = async function(filename) {
  const base = await COM.LoadFileAsync(filename);

  if (!base) {
    Sys.Error('W.LoadFile: ' + filename + ' not found');
    return null;
  }

  const view = new DataView(base);
  const magic = view.getUint32(0, true);
  const handler = W._handlers.find((h) => h.MAGIC === magic);

  if (!handler) {
    Sys.Error('W.LoadFile: ' + filename + ' is not a valid WAD file');
    return null;
  }

  const wadFile = new handler();
  wadFile.load(base);
  return wadFile;
};
