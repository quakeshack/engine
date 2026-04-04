import { eventBus, getCommonRegistry } from '../registry.ts';
import { CorruptedResourceError, MissingResourceError, NotImplementedError } from './Errors.ts';
import Q from '../../shared/Q.ts';

let { COM } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM } = getCommonRegistry());
});

export interface WadLumpRecord {
  readonly data: ArrayBuffer;
  readonly type: number;
  readonly size: number;
  readonly name: string;
}

/**
 * WAD lump texture representation.
 * Contains only data, not uploaded to the GPU or anything.
 */
export class WadLumpTexture {
  constructor(
    readonly name: string,
    readonly width: number,
    readonly height: number,
    readonly data: Uint8Array,
  ) {
    Object.freeze(this);
  }

  toDataURL(): string {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('WadLumpTexture.toDataURL: 2D canvas context unavailable');
    }
    const data = ctx.createImageData(canvas.width, canvas.height);
    data.data.set(new Uint8Array(this.data));
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL();
  }

  toString(): string {
    return `WadLumpTexture(${this.name}, ${this.width} x ${this.height} pixels, ${this.data.length} bytes)`;
  }
}

export abstract class WadFileInterface {
  static MAGIC = 0;

  protected _lumps: Record<string, WadLumpRecord> = {};

  getLumpNames(): string[] {
    return Object.keys(this._lumps);
  }

  abstract load(base: ArrayBuffer): void;

  /**
   * This will return the raw data for the given name.
   * @returns the lump data
   */
  abstract getLump(name: string): ArrayBuffer | WadLumpRecord;

  /**
   * This will return the palette translated data for the given name.
   * @returns the decoded texture data
   */
  abstract getLumpMipmap(name: string, mipmapLevel?: number): WadLumpTexture;
}

/** A concrete WAD handler constructor with a static MAGIC identifier. */
interface WadHandlerConstructor {
  readonly MAGIC: number;
  new(): WadFileInterface;
}

export default class W {
  static _handlers: WadHandlerConstructor[] = [];

  /** Current palette in 32 bit words. */
  static d_8to24table = new Uint32Array(256);

  /** Current palette in 256 8 bit tuples for RGB. */
  static d_8to24table_u8 = new Uint8Array(768);

  /** Fill color index. */
  static filledColor: number | null = null;

  /**
   * Loads given WAD file. Supports multiple WAD formats (WAD2, WAD3).
   * @returns the loaded WAD file
   */
  static async LoadFile(filename: string): Promise<WadFileInterface> {
    const base = await COM.LoadFile(filename);

    if (!base) {
      throw new MissingResourceError(filename);
    }

    const view = new DataView(base);
    const magic = view.getUint32(0, true);
    const handler = W._handlers.find((wadHandler) => wadHandler.MAGIC === magic);

    if (handler === undefined) {
      throw new CorruptedResourceError(filename, 'not a valid WAD file');
    }

    const wadFile = new handler();
    wadFile.load(base);
    return wadFile;
  }

  /**
   * Loads the default palette from the given file. Used for all Quake resources.
   * A palette is a 256 color palette, each color is 3 bytes (RGB). 768 bytes in total.
   */
  static async LoadPalette(filename: string) {
    const palette = await COM.LoadFile(filename);

    if (palette === null) {
      throw new MissingResourceError(filename);
    }

    W.d_8to24table_u8 = new Uint8Array(palette);
    W.filledColor = null;

    for (let i = 0, src = 0; i < 256; i++) {
      const pal = W.d_8to24table_u8;

      W.d_8to24table[i] = pal[src++] + (pal[src++] << 8) + (pal[src++] << 16);

      if (W.d_8to24table[i] === 0) {
        W.filledColor = i;
      }
    }

    eventBus.publish('wad.palette.loaded');
  }

  /**
   * Loads a lump from the filesystem as texture.
   * @returns the loaded lump texture
   */
  static async LoadLump(filename: string) { // TODO: this should take a type parameter to specify the type of the lump
    const buf = await COM.LoadFile(filename);

    if (buf === null) {
      throw new MissingResourceError(filename);
    }

    const view = new DataView(buf, 0, 8);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const data = new Uint8Array(buf, 8, width * height);

    return new WadLumpTexture(filename, width, height, translateIndexToRGBA(data, width, height, W.d_8to24table_u8, 255));
  }
}

/**
 * Quake 1 WAD file format handler.
 */
class Wad2File extends WadFileInterface {
  static override MAGIC = 0x32444157; // 'WAD2'

  /** Active palette, sourced from {@link W.d_8to24table_u8}. */
  readonly palette: Uint8Array;

  constructor() {
    super();
    this.palette = W.d_8to24table_u8;
  }

  override load(base: ArrayBuffer) {
    const view = new DataView(base);
    console.assert(view.getUint32(0, true) === Wad2File.MAGIC, 'magic number');
    const numlumps = view.getUint32(4, true);
    let infotableofs = view.getUint32(8, true);
    for (let i = 0; i < numlumps; i++) {
      const size = view.getUint32(infotableofs + 4, true);
      const type = view.getUint8(infotableofs + 12);
      const lump = new ArrayBuffer(size);
      const name = Q.memstr(new Uint8Array(base, infotableofs + 16, 16));
      new Uint8Array(lump).set(new Uint8Array(base, view.getUint32(infotableofs, true), size));
      this._lumps[name.toUpperCase()] = {
        data: lump,
        type, // lump type
        size, // uncompressed size
        name,
      };
      infotableofs += 32;
    }
  }

  /**
   * This will return the raw data for the given name.
   * @returns the lump data
   */
  override getLump(name: string): ArrayBuffer {
    const lump = this._lumps[name.toUpperCase()];

    if (!lump) {
      throw new MissingResourceError(name);
    }

    return lump.data;
  }

  /**
   * This will return the palette translated data for the given name.
   * @returns the decoded texture data
   */
  override getLumpMipmap(name: string, _mipmapLevel = 0): WadLumpTexture {
    const data = this.getLump(name);
    const view = new DataView(data);

    // The font lump is a special case, it has a different format
    if (name === 'CONCHARS') {
      const width = 16 * 8; // 16 characters, each 8 pixels wide
      const height = 16 * 8; // 16 characters, each 8 pixels high
      const rgba = translateIndexToRGBA(new Uint8Array(data, 0, width * height), width, height, this.palette, 0);
      return new WadLumpTexture(name, width, height, rgba);
    }

    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);

    // TODO: handle different types of lumps, right now it’s only supports pichead_t

    const rgba = translateIndexToRGBA(new Uint8Array(data, 8, width * height), width, height, this.palette, 255);

    return new WadLumpTexture(name, width, height, rgba);
  }
}

W._handlers.push(Wad2File);

/**
 * GoldSrc WAD3 file format handler.
 */
class Wad3File extends WadFileInterface {
  static override MAGIC = 0x33444157; // 'WAD3'

  override load(base: ArrayBuffer) {
    const view = new DataView(base);
    console.assert(view.getUint32(0, true) === Wad3File.MAGIC, 'magic number');
    const numlumps = view.getUint32(4, true);
    let infotableofs = view.getUint32(8, true);

    for (let i = 0; i < numlumps; i++) {
      const filepos = view.getUint32(infotableofs, true);
      const disksize = view.getUint32(infotableofs + 4, true);
      const size = view.getUint32(infotableofs + 8, true); // uncompressed size
      const type = view.getUint8(infotableofs + 12);
      const compression = view.getUint8(infotableofs + 13);
      const name = Q.memstr(new Uint8Array(base, infotableofs + 16, 16));
      const lump = new ArrayBuffer(size);

      if (!compression) { // Uncompressed
        new Uint8Array(lump).set(new Uint8Array(base, filepos, disksize));
      } else { // Compressed
        const compressedData = new Uint8Array(base, filepos, disksize);
        const decompressed = Wad3File.#decompressLZ(compressedData, size);
        new Uint8Array(lump).set(decompressed);
      }

      this._lumps[name.toUpperCase()] = {
        data: lump,
        type,
        size,
        name,
      };

      infotableofs += 32;
    }
  }

  #parseQPicLump(name: string, data: ArrayBuffer, _mipmapLevel: number): WadLumpTexture {
    const view = new DataView(data);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);

    const palette = new Uint8Array(data,
      8 + // 8 = header
      width * height + // pixel data
      2, // how many colors being used for palette in short
      768, // 768 = 256 colors * 3 bytes (RGB)
    );

    const uint8data = new Uint8Array(data, 8, width * height);
    const rgba = translateIndexToRGBA(uint8data, width, height, palette, 255);

    return new WadLumpTexture(name, width, height, rgba);
  }

  #parseMiptexLump(name: string, data: ArrayBuffer, mipmapLevel: number): WadLumpTexture {
    return readWad3Texture(data, name, mipmapLevel);
  }

  /**
   * This will return the raw data for the given name.
   * @returns the lump data
   */
  override getLump(name: string): WadLumpRecord {
    const lump = this._lumps[name.toUpperCase()];

    if (!lump) {
      throw new MissingResourceError(name);
    }

    return lump;
  }

  /**
   * This will return the palette translated data for the given name.
   * @returns the decoded texture data
   */
  override getLumpMipmap(name: string, mipmapLevel = 0): WadLumpTexture {
    const lumpInfo = this._lumps[name.toUpperCase()];

    if (!lumpInfo) {
      throw new MissingResourceError(name);
    }

    switch (lumpInfo.type) {
      case 0x43: // miptex
      case 0x40: // spraydecal
        return this.#parseMiptexLump(lumpInfo.name, lumpInfo.data, mipmapLevel);

      case 0x42: // QPic
        return this.#parseQPicLump(lumpInfo.name, lumpInfo.data, mipmapLevel);

      case 0x46: // font
        console.assert(false, 'Wad3File.getLumpMipmap: font handling not implemented');
        throw new NotImplementedError('font (lump type 0x46) handling not implemented');
    }

    throw new CorruptedResourceError(name, `not a valid lump type (${lumpInfo.type})`);
  }

  /**
   * Decompress LZ-compressed data from GoldSrc WAD3 files
   * @returns the decompressed data
   */
  static #decompressLZ(compressed: Uint8Array, uncompressedSize: number): Uint8Array {
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
          if (inPos + 1 >= compressed.length) {
            break;
          }

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
  }
}

W._handlers.push(Wad3File);

/**
 * Helper function to convert indexed 8-bit data to RGBA format.
 * It has options for transparency and fullbright colors.
 * @returns RGBA data, each pixel is 4 bytes (R, G, B, A)
 */
export function translateIndexToRGBA(
  uint8data: Uint8Array,
  width: number,
  height: number,
  palette: Uint8Array | null = W.d_8to24table_u8,
  transparentColor: number | null = null,
  fullbrightColorStart: number | null = null,
): Uint8Array {
  const resolvedPalette = palette ?? W.d_8to24table_u8;
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
    rgba[i * 4 + 0] = resolvedPalette[colorIndex * 3];
    rgba[i * 4 + 1] = resolvedPalette[colorIndex * 3 + 1];
    rgba[i * 4 + 2] = resolvedPalette[colorIndex * 3 + 2];

    // our pixel shader is considering the alpha channel whether to use the lightmap or not
    rgba[i * 4 + 3] = fullbrightColorStart !== null && colorIndex >= fullbrightColorStart ? 0 : 255;
  }

  return rgba;
}

/**
 * Convert indexed 8-bit data into an RGBA emissive texture containing only
 * Quake fullbright pixels.
 * @returns RGBA data containing only fullbright pixels
 */
export function translateIndexToLuminanceRGBA(
  uint8data: Uint8Array,
  width: number,
  height: number,
  palette: Uint8Array | null = W.d_8to24table_u8,
  transparentColor: number | null = null,
  fullbrightColorStart: number | null = 240,
): Uint8Array {
  const resolvedPalette = palette ?? W.d_8to24table_u8;
  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const colorIndex = uint8data[i];

    if (transparentColor !== null && colorIndex === transparentColor) {
      continue;
    }

    if (fullbrightColorStart === null || colorIndex < fullbrightColorStart) {
      continue;
    }

    rgba[i * 4 + 0] = resolvedPalette[colorIndex * 3];
    rgba[i * 4 + 1] = resolvedPalette[colorIndex * 3 + 1];
    rgba[i * 4 + 2] = resolvedPalette[colorIndex * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }

  return rgba;
}

/**
 * Reads a WAD3 texture from the given data.
 * @returns the decoded texture data
 */
export function readWad3Texture(data: ArrayBuffer, name: string, mipmapLevel = 0): WadLumpTexture {
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
    768, // 768 = 256 colors * 3 bytes (RGB)
  );

  // Textures with a name starting with '{' are transparent, so we set the transparent color to 255
  const rgba = translateIndexToRGBA(
    uint8data,
    swidth,
    sheight,
    palette,
    texName[0] === '{' ? 255 : null,
    (texName[0] === '~' || texName[2] === '~') ? 240 : null,
  );

  return new WadLumpTexture(texName, swidth, sheight, rgba);
}
