import zlib from 'node:zlib';

import { CRC32 } from '../../source/engine/common/CRC.ts';
import type { StillImagePixels } from '../../source/engine/client/renderer/sprite/BrowserImagePixels.ts';

/** One frame for `encodeGif()`. */
export interface TestGifFrame {
  /** Palette indices, `width * height` of them, in reading order (the encoder interlaces when asked to). */
  readonly indices: readonly number[];
  readonly left?: number;
  readonly top?: number;
  readonly width: number;
  readonly height: number;
  /** Delay in hundredths of a second. */
  readonly delay?: number;
  /** 0 or 1: leave, 2: restore to background, 3: restore to previous. */
  readonly disposal?: number;
  readonly transparentIndex?: number;
  readonly interlaced?: boolean;
  /** A color table of its own (RGB triples). */
  readonly palette?: readonly number[];
}

/** What `encodeGif()` writes. */
export interface TestGif {
  readonly width: number;
  readonly height: number;
  /** The global color table, RGB triples. */
  readonly palette: readonly number[];
  readonly frames: readonly TestGifFrame[];
  /** Writes a NETSCAPE loop extension with this count. */
  readonly loopCount?: number;
}

/**
 * Compresses palette indices the way GIF wants: LZW with variable width codes, least significant bit first.
 * @returns The compressed bytes.
 */
function lzwEncode(indices: readonly number[], minimumCodeSize: number): number[] {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const output: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minimumCodeSize + 1;
  let dictionary = new Map<string, number>();
  let nextCode = endCode + 1;

  const write = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;

    while (bitCount >= 8) {
      output.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  write(clearCode);

  let current = '';

  for (const index of indices) {
    const extended = current === '' ? `${index}` : `${current},${index}`;

    if (current === '' || dictionary.has(extended)) {
      current = extended;
      continue;
    }

    write(current.includes(',') ? dictionary.get(current)! : Number(current));
    dictionary.set(extended, nextCode++);

    if (nextCode - 1 === (1 << codeSize) && codeSize < 12) {
      codeSize++;
    }

    if (nextCode >= 4095) {
      write(clearCode);
      codeSize = minimumCodeSize + 1;
      dictionary = new Map();
      nextCode = endCode + 1;
    }

    current = `${index}`;
  }

  if (current !== '') {
    write(current.includes(',') ? dictionary.get(current)! : Number(current));
  }

  write(endCode);

  if (bitCount > 0) {
    output.push(bitBuffer & 0xff);
  }

  return output;
}

/**
 * @returns Which row of the image each stored row is, for an interlaced image.
 */
function interlaceOrder(height: number): number[] {
  const order: number[] = [];

  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let row = start; row < height; row += step) {
      order.push(row);
    }
  }

  return order;
}

/**
 * @returns The bytes cut into data sub-blocks of at most 255 bytes, with the terminator.
 */
function subBlocks(data: readonly number[]): number[] {
  const output: number[] = [];

  for (let position = 0; position < data.length; position += 255) {
    const chunk = data.slice(position, position + 255);

    output.push(chunk.length, ...chunk);
  }

  output.push(0);

  return output;
}

/**
 * Writes a GIF file, for tests that need a shape the fixtures do not have: disposal methods, transparency,
 * sub-rectangles, local color tables, interlacing.
 * @returns The file.
 */
export function encodeGif(gif: TestGif): ArrayBuffer {
  const bytes: number[] = [...'GIF89a'].map((character) => character.charCodeAt(0));
  const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
  const sizeBits = (palette: readonly number[]): number => Math.max(1, Math.ceil(Math.log2(palette.length / 3))) - 1;
  const tableSize = (palette: readonly number[]): number => 3 * 2 ** (sizeBits(palette) + 1);
  const pad = (palette: readonly number[]): number[] => [...palette, ...new Array<number>(tableSize(palette) - palette.length).fill(0)];

  bytes.push(...u16(gif.width), ...u16(gif.height), 0x80 | sizeBits(gif.palette), 0, 0, ...pad(gif.palette));

  if (gif.loopCount !== undefined) {
    bytes.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((character) => character.charCodeAt(0)), 3, 1, ...u16(gif.loopCount), 0);
  }

  for (const frame of gif.frames) {
    const transparent = frame.transparentIndex !== undefined;

    bytes.push(0x21, 0xf9, 4, ((frame.disposal ?? 0) << 2) | (transparent ? 1 : 0), ...u16(frame.delay ?? 0), frame.transparentIndex ?? 0, 0);

    const palette = frame.palette ?? gif.palette;
    const stored = frame.interlaced === true
      ? interlaceOrder(frame.height).flatMap((row) => frame.indices.slice(row * frame.width, (row + 1) * frame.width))
      : frame.indices;
    const minimumCodeSize = Math.max(2, sizeBits(palette) + 1);

    bytes.push(0x2c, ...u16(frame.left ?? 0), ...u16(frame.top ?? 0), ...u16(frame.width), ...u16(frame.height));
    bytes.push((frame.palette === undefined ? 0 : 0x80 | sizeBits(palette)) | (frame.interlaced === true ? 0x40 : 0));

    if (frame.palette !== undefined) {
      bytes.push(...pad(palette));
    }

    bytes.push(minimumCodeSize, ...subBlocks(lzwEncode(stored, minimumCodeSize)));
  }

  bytes.push(0x3b);

  return new Uint8Array(bytes).buffer;
}

/** One frame for `encodeApng()`. */
export interface TestApngFrame {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  /** Straight RGBA pixels of the frame, `width * height * 4`. */
  readonly rgba: readonly number[];
  /** Delay in milliseconds. */
  readonly delay?: number;
  /** 0 none, 1 background, 2 previous. */
  readonly dispose?: number;
  /** 0 source, 1 over. */
  readonly blend?: number;
}

/** What `encodeApng()` writes. */
export interface TestApng {
  readonly width: number;
  readonly height: number;
  readonly frames: readonly TestApngFrame[];
  readonly plays?: number;
  /** Whether the default image is the first frame (its `fcTL` comes before `IDAT`), otherwise it is a hidden fallback. */
  readonly defaultImageIsFrame: boolean;
}

/**
 * @returns A PNG chunk: length, type, data, CRC.
 */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, data.length, false);
  chunk.set([...type].map((character) => character.charCodeAt(0)), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, CRC32.Block(chunk.subarray(4, 8 + data.length)), false);

  return chunk;
}

/**
 * @returns The zlib stream of 8 bit RGBA rows, each with filter type 0.
 */
function deflateRgba(rgba: readonly number[], width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));

  for (let row = 0; row < height; row++) {
    raw.set(rgba.slice(row * width * 4, (row + 1) * width * 4), row * (1 + width * 4) + 1);
  }

  return new Uint8Array(zlib.deflateSync(raw));
}

/**
 * Writes an APNG file (8 bit RGBA, no interlacing).
 * @returns The file.
 */
export function encodeApng(apng: TestApng): ArrayBuffer {
  const parts: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  let sequence = 0;

  headerView.setUint32(0, apng.width, false);
  headerView.setUint32(4, apng.height, false);
  header.set([8, 6, 0, 0, 0], 8);
  parts.push(pngChunk('IHDR', header));

  const control = new Uint8Array(8);

  new DataView(control.buffer).setUint32(0, apng.frames.length, false);
  new DataView(control.buffer).setUint32(4, apng.plays ?? 0, false);
  parts.push(pngChunk('acTL', control));

  const frameControl = (frame: TestApngFrame): Uint8Array => {
    const data = new Uint8Array(26);
    const view = new DataView(data.buffer);

    view.setUint32(0, sequence++, false);
    view.setUint32(4, frame.width, false);
    view.setUint32(8, frame.height, false);
    view.setUint32(12, frame.x ?? 0, false);
    view.setUint32(16, frame.y ?? 0, false);
    view.setUint16(20, frame.delay ?? 100, false);
    view.setUint16(22, 1000, false);
    data[24] = frame.dispose ?? 0;
    data[25] = frame.blend ?? 0;

    return pngChunk('fcTL', data);
  };

  apng.frames.forEach((frame, index) => {
    const compressed = deflateRgba(frame.rgba, frame.width, frame.height);

    if (index === 0 && apng.defaultImageIsFrame) {
      parts.push(frameControl(frame), pngChunk('IDAT', compressed));
      return;
    }

    if (index === 0) {
      // a fallback for viewers that do not animate, the first frame's size is not the canvas: paint it in the corner
      const fallback = new Array<number>(apng.width * apng.height * 4).fill(0);

      parts.push(pngChunk('IDAT', deflateRgba(fallback, apng.width, apng.height)));
    }

    const data = new Uint8Array(4 + compressed.length);

    parts.push(frameControl(frame));
    new DataView(data.buffer).setUint32(0, sequence++, false);
    data.set(compressed, 4);
    parts.push(pngChunk('fdAT', data));
  });

  parts.push(pngChunk('IEND', new Uint8Array(0)));

  const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    file.set(part, offset);
    offset += part.length;
  }

  return file.buffer;
}

/**
 * A small PNG decoder for tests, so the APNG decoder can run without a browser: 8 bit RGBA, RGB or palette
 * images, any filter, no interlacing.
 * @returns Straight RGBA pixels.
 */
export function decodeStillPng(png: Uint8Array): Promise<StillImagePixels> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const colorType = png[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;

  for (let offset = 8; offset + 8 <= png.length;) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);

    if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    }

    offset += 12 + length;
  }

  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(idat)));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);

  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));

    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? rows[row * stride + index - channels] : 0;
      const up = row > 0 ? rows[(row - 1) * stride + index] : 0;
      const upLeft = row > 0 && index >= channels ? rows[(row - 1) * stride + index - channels] : 0;
      let predictor = 0;

      switch (filter) {
        case 1: predictor = left; break;
        case 2: predictor = up; break;
        case 3: predictor = (left + up) >> 1; break;
        case 4: {
          const estimate = left + up - upLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceUp = Math.abs(estimate - up);
          const distanceUpLeft = Math.abs(estimate - upLeft);

          predictor = distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft;
          break;
        }
        default: break;
      }

      rows[row * stride + index] = (line[index] + predictor) & 0xff;
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let pixel = 0; pixel < width * height; pixel++) {
    if (colorType === 6) {
      rgba.set(rows.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
    } else if (colorType === 2) {
      rgba.set(rows.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
      rgba[pixel * 4 + 3] = 255;
    } else {
      const index = rows[pixel];

      rgba.set(palette!.subarray(index * 3, index * 3 + 3), pixel * 4);
      rgba[pixel * 4 + 3] = transparency !== null && index < transparency.length ? transparency[index] : 255;
    }
  }

  return Promise.resolve({ width, height, rgba });
}
