import { CorruptedResourceError } from '../../../common/Errors.ts';
import { ImageFormat, type ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';
import { SpriteImageDecoder } from './SpriteImageDecoder.ts';

/** Where an image's rows go when its data is interlaced: the first row, then every 8th, 4th, 2nd. */
const INTERLACE_PASSES: ReadonlyArray<readonly [start: number, step: number]> = [[0, 8], [4, 8], [2, 4], [1, 2]];

/**
 * Decodes GIF ourselves, so it looks and times the same in every browser: LZW, color tables, transparency,
 * sub-rectangle frames, interlacing and the three disposal methods. The byte layout of the blocks is in
 * `GifHeader`.
 *
 * Pixels are composited onto a canvas the size of the logical screen, which starts out transparent. After each
 * frame its disposal method decides what the canvas looks like for the next one: 0 and 1 leave it, 2 clears the
 * frame's rectangle (browsers show transparent, not the background color), 3 puts back what was there before the
 * frame. The result has one full snapshot per frame.
 */
export class GifSpriteDecoder extends SpriteImageDecoder {
  override getName(): string {
    return 'GIF';
  }

  override canDecode(format: ImageFormat, _header: ImageHeader): boolean {
    return format === ImageFormat.gif;
  }

  override decode(buffer: ArrayBuffer, _format: ImageFormat, _header: ImageHeader, name: string): Promise<DecodedSpriteImages> {
    return Promise.resolve(GifSpriteDecoder.decodeFrames(buffer, name));
  }

  /**
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns Every frame of the file as premultiplied RGBA of the logical screen's size.
   * @throws CorruptedResourceError when the file is not a decodable GIF.
   */
  static decodeFrames(buffer: ArrayBuffer, name: string): DecodedSpriteImages {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    const screenPacked = view.getUint8(10);
    let offset = 13;
    let globalPalette: Uint8Array | null = null;

    if ((screenPacked & 0x80) !== 0) {
      const size = 3 * 2 ** ((screenPacked & 0x07) + 1);

      globalPalette = bytes.subarray(offset, offset + size);
      offset += size;
    }

    const canvas = new Uint8Array(width * height * 4);
    const frames: Uint8Array[] = [];
    let disposal = 0;
    let transparentIndex = -1;

    while (offset < bytes.length) {
      const block = bytes[offset++];

      if (block === 0x3b) {
        break;
      }

      if (block === 0x21) {
        const label = bytes[offset++];

        if (label === 0xf9) {
          const packed = bytes[offset + 1];

          disposal = (packed >> 2) & 0x07;
          transparentIndex = (packed & 0x01) !== 0 ? bytes[offset + 4] : -1;
        }

        offset = GifSpriteDecoder.#skipSubBlocks(bytes, offset);
        continue;
      }

      if (block !== 0x2c) {
        throw new CorruptedResourceError(name, `${name} has an unknown GIF block (0x${block.toString(16)})`);
      }

      const left = view.getUint16(offset, true);
      const top = view.getUint16(offset + 2, true);
      const frameWidth = view.getUint16(offset + 4, true);
      const frameHeight = view.getUint16(offset + 6, true);
      const packed = bytes[offset + 8];
      offset += 9;

      let palette = globalPalette;

      if ((packed & 0x80) !== 0) {
        const size = 3 * 2 ** ((packed & 0x07) + 1);

        palette = bytes.subarray(offset, offset + size);
        offset += size;
      }

      if (palette === null) {
        throw new CorruptedResourceError(name, `${name} has an image without a color table`);
      }

      const minimumCodeSize = bytes[offset++];
      const { data, end } = GifSpriteDecoder.#collectSubBlocks(bytes, offset);
      offset = end;

      const indices = GifSpriteDecoder.#decodeLzw(data, minimumCodeSize, frameWidth * frameHeight, name);
      const rows = (packed & 0x40) !== 0 ? GifSpriteDecoder.#interlacedRows(frameHeight) : null;
      const restore = disposal === 3 ? canvas.slice() : null;

      GifSpriteDecoder.#draw(canvas, width, height, { left, top, frameWidth, frameHeight }, indices, rows, palette, transparentIndex);
      frames.push(canvas.slice());

      if (disposal === 2) {
        GifSpriteDecoder.#clearRectangle(canvas, width, height, left, top, frameWidth, frameHeight);
      } else if (restore !== null) {
        canvas.set(restore);
      }

      disposal = 0;
      transparentIndex = -1;
    }

    if (frames.length === 0) {
      throw new CorruptedResourceError(name, `${name} has no images`);
    }

    return { width, height, frames };
  }

  /**
   * @param offset Position of the first sub-block's length byte.
   * @returns Position after the sub-blocks' zero terminator.
   */
  static #skipSubBlocks(bytes: Uint8Array, offset: number): number {
    let position = offset;

    while (position < bytes.length && bytes[position] !== 0) {
      position += 1 + bytes[position];
    }

    return position + 1;
  }

  /**
   * @param offset Position of the first sub-block's length byte.
   * @returns The sub-blocks' bytes joined, and the position after their terminator.
   */
  static #collectSubBlocks(bytes: Uint8Array, offset: number): { data: Uint8Array, end: number } {
    const end = GifSpriteDecoder.#skipSubBlocks(bytes, offset);
    const data = new Uint8Array(end - offset);
    let length = 0;

    for (let position = offset; position < end - 1 && bytes[position] !== 0;) {
      const size = bytes[position];

      data.set(bytes.subarray(position + 1, position + 1 + size), length);
      length += size;
      position += 1 + size;
    }

    return { data: data.subarray(0, length), end };
  }

  /**
   * Decodes GIF's variable width LZW. Codes start one bit wider than the minimum code size and grow with the
   * dictionary up to 12 bits; the clear code resets it, the end code stops.
   * @returns The palette index of each pixel; pixels the data did not reach stay 0.
   */
  static #decodeLzw(data: Uint8Array, minimumCodeSize: number, pixelCount: number, name: string): Uint8Array {
    if (minimumCodeSize < 2 || minimumCodeSize > 11) {
      throw new CorruptedResourceError(name, `${name} has an LZW minimum code size of ${minimumCodeSize}`);
    }

    const output = new Uint8Array(pixelCount);
    const clearCode = 1 << minimumCodeSize;
    const endCode = clearCode + 1;
    const prefix = new Uint16Array(4096);
    const suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    let codeSize = minimumCodeSize + 1;
    let nextCode = endCode + 1;
    let previous = -1;
    let firstByte = 0;
    let written = 0;
    let bitBuffer = 0;
    let bitCount = 0;
    let position = 0;

    for (let index = 0; index < clearCode; index++) {
      suffix[index] = index;
    }

    while (written < pixelCount) {
      while (bitCount < codeSize && position < data.length) {
        bitBuffer |= data[position++] << bitCount;
        bitCount += 8;
      }

      if (bitCount < codeSize) {
        break;
      }

      let code = bitBuffer & ((1 << codeSize) - 1);
      bitBuffer >>>= codeSize;
      bitCount -= codeSize;

      if (code === clearCode) {
        codeSize = minimumCodeSize + 1;
        nextCode = endCode + 1;
        previous = -1;
        continue;
      }

      if (code === endCode) {
        break;
      }

      if (previous === -1) {
        if (code >= clearCode) {
          throw new CorruptedResourceError(name, `${name} has a corrupt LZW stream`);
        }

        output[written++] = code;
        previous = code;
        firstByte = code;
        continue;
      }

      const incoming = code;
      let stackSize = 0;

      if (code >= nextCode) {
        if (code > nextCode) {
          throw new CorruptedResourceError(name, `${name} has a corrupt LZW stream`);
        }

        // the code that is about to be defined: the previous string followed by its own first byte
        stack[stackSize++] = firstByte;
        code = previous;
      }

      while (code >= clearCode) {
        stack[stackSize++] = suffix[code];
        code = prefix[code];
      }

      stack[stackSize++] = code;
      firstByte = code;

      while (stackSize > 0 && written < pixelCount) {
        output[written++] = stack[--stackSize];
      }

      if (nextCode < 4096) {
        prefix[nextCode] = previous;
        suffix[nextCode] = firstByte;
        nextCode++;

        if (nextCode === (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
      }

      previous = incoming;
    }

    return output;
  }

  /**
   * @returns For each row of the image in storage order, the row it belongs to.
   */
  static #interlacedRows(height: number): Uint16Array {
    const rows = new Uint16Array(height);
    let stored = 0;

    for (const [start, step] of INTERLACE_PASSES) {
      for (let row = start; row < height; row += step) {
        rows[stored++] = row;
      }
    }

    return rows;
  }

  /**
   * Paints the opaque pixels of an image onto the canvas; a pixel with the transparent index leaves the canvas as it is.
   */
  static #draw(
    canvas: Uint8Array,
    canvasWidth: number,
    canvasHeight: number,
    rectangle: { left: number, top: number, frameWidth: number, frameHeight: number },
    indices: Uint8Array,
    rows: Uint16Array | null,
    palette: Uint8Array,
    transparentIndex: number,
  ): void {
    const { left, top, frameWidth, frameHeight } = rectangle;

    for (let storedRow = 0; storedRow < frameHeight; storedRow++) {
      const y = top + (rows === null ? storedRow : rows[storedRow]);

      if (y >= canvasHeight) {
        continue;
      }

      for (let column = 0; column < frameWidth; column++) {
        const x = left + column;
        const index = indices[storedRow * frameWidth + column];

        if (x >= canvasWidth || index === transparentIndex) {
          continue;
        }

        const target = (y * canvasWidth + x) * 4;

        canvas[target] = palette[index * 3];
        canvas[target + 1] = palette[index * 3 + 1];
        canvas[target + 2] = palette[index * 3 + 2];
        canvas[target + 3] = 255;
      }
    }
  }

  static #clearRectangle(canvas: Uint8Array, canvasWidth: number, canvasHeight: number, left: number, top: number, width: number, height: number): void {
    for (let y = top; y < Math.min(top + height, canvasHeight); y++) {
      const start = (y * canvasWidth + left) * 4;
      const end = (y * canvasWidth + Math.min(left + width, canvasWidth)) * 4;

      canvas.fill(0, start, end);
    }
  }
}
