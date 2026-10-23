import { CorruptedResourceError } from '../../Errors.ts';
import type { ImageHeader } from './ImageHeader.ts';

/**
 * Header pass for GIF (87a and 89a), little endian throughout.
 *
 * - Header: `GIF87a` or `GIF89a`, then the Logical Screen Descriptor: u16 width, u16 height, a packed byte
 *   (bit 7: a global color table follows, bits 0-2: its size is `3 * 2^(n + 1)` bytes), background index, aspect.
 * - Then blocks until the trailer `0x3B`:
 *   - `0x21` extension, a label, then data sub-blocks (a length byte and that many bytes) ending in a zero length.
 *     Label `0xF9` is the Graphic Control Extension: a block of four bytes (packed byte, u16 delay in hundredths of
 *     a second, transparent index); it applies to the next image. Label `0xFF` is an application extension; the
 *     one called `NETSCAPE2.0` carries sub-block `01 <u16 loop count>`, which is where a file says how often it
 *     repeats. GIF89a itself does not define it, and a file without it plays once.
 *   - `0x2C` image: u16 left, top, width, height, a packed byte (bit 7: a local color table follows, bits 0-2 its
 *     size as above), the table, a byte with the minimum LZW code size, then data sub-blocks.
 *
 * A pixel pass has more to handle: disposal methods, sub-rectangles, interlacing and transparency. The header
 * pass skips the LZW data by its sub-block lengths.
 */
export class GifHeader {
  /**
   * @returns Whether the file starts with a GIF signature.
   */
  static matches(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 13) {
      return false;
    }

    const bytes = new Uint8Array(buffer, 0, 6);
    const text = String.fromCharCode(...bytes);

    return text === 'GIF87a' || text === 'GIF89a';
  }

  /**
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns The size, the delay of each image and the repeat count. A repeat count of N in the loop extension
   * means N repeats after the first play, as browsers read it, so the file plays N + 1 times.
   */
  static parse(buffer: ArrayBuffer, name: string): ImageHeader {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    const frameDurations: number[] = [];
    let repeat = 1;
    let pendingDelay = 0;
    let offset = 13 + GifHeader.#colorTableSize(view.getUint8(10));

    while (offset < buffer.byteLength) {
      const block = view.getUint8(offset);
      offset += 1;

      if (block === 0x3b) {
        break;
      }

      if (block === 0x21) {
        const label = view.getUint8(offset);
        offset += 1;

        if (label === 0xf9) {
          // block size 4, packed byte, delay, transparent index, terminator
          pendingDelay = view.getUint16(offset + 2, true) * 10;
        } else if (label === 0xff && GifHeader.#isNetscape(bytes, offset)) {
          const loopCount = GifHeader.#readLoopCount(view, offset);

          if (loopCount !== null) {
            repeat = loopCount === 0 ? 0 : loopCount + 1;
          }
        }

        offset = GifHeader.#skipSubBlocks(view, offset);
        continue;
      }

      if (block === 0x2c) {
        const packed = view.getUint8(offset + 8);
        offset += 9 + GifHeader.#colorTableSize(packed);
        offset += 1; // minimum LZW code size
        offset = GifHeader.#skipSubBlocks(view, offset);
        frameDurations.push(pendingDelay);
        pendingDelay = 0;
        continue;
      }

      throw new CorruptedResourceError(name, `${name} has an unknown GIF block (0x${block.toString(16)})`);
    }

    if (frameDurations.length === 0) {
      throw new CorruptedResourceError(name, `${name} has no images`);
    }

    return { width, height, frameDurations, repeat, tags: [] };
  }

  /**
   * @returns Bytes of the color table a packed byte announces, 0 when it announces none.
   */
  static #colorTableSize(packed: number): number {
    return (packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
  }

  /**
   * @param offset Position of the application extension's first sub-block (its length, 11).
   * @returns Whether the extension is `NETSCAPE2.0`.
   */
  static #isNetscape(bytes: Uint8Array, offset: number): boolean {
    return bytes[offset] === 11 && String.fromCharCode(...bytes.subarray(offset + 1, offset + 12)) === 'NETSCAPE2.0';
  }

  /**
   * @param offset Position of the application extension's first sub-block.
   * @returns The loop count, `null` when the sub-block after the identifier is not a loop count.
   */
  static #readLoopCount(view: DataView, offset: number): number | null {
    const next = offset + 12;

    if (view.getUint8(next) < 3 || view.getUint8(next + 1) !== 1) {
      return null;
    }

    return view.getUint16(next + 2, true);
  }

  /**
   * @param offset Position of the first sub-block's length byte.
   * @returns Position after the sub-blocks' zero terminator.
   */
  static #skipSubBlocks(view: DataView, offset: number): number {
    let position = offset;

    for (let length = view.getUint8(position); length !== 0; length = view.getUint8(position)) {
      position += 1 + length;
    }

    return position + 1;
  }
}
