import { CorruptedResourceError } from '../../Errors.ts';
import type { ImageHeader } from './ImageHeader.ts';

/**
 * Header pass for WebP, little endian throughout (RFC 9649, the lossy bitstream in RFC 6386 section 9.1).
 *
 * - `RIFF`, u32 file size, `WEBP`, then chunks: four letters of type, u32 size, the data, and a pad byte when the
 *   size is odd.
 * - A simple file has one `VP8 ` (lossy) or `VP8L` (lossless) chunk and no extended header. `VP8 `: a 3 byte frame
 *   tag, the key frame start code `9D 01 2A`, then u16 width and u16 height, each 14 bits with a 2 bit scale above
 *   them. `VP8L`: the signature `2F`, then 14 bits of width minus one and 14 bits of height minus one.
 * - `VP8X` comes first in an extended file: a flags byte (bit `0x02` animation, `0x10` alpha), three reserved
 *   bytes, 24 bit canvas width minus one and canvas height minus one.
 * - `ANIM` (animated files): u32 background color (blue, green, red, alpha), u16 loop count, 0 for forever.
 * - `ANMF`, one per frame: 24 bit x offset and y offset (both stored halved), 24 bit width and height (minus
 *   one), 24 bit duration in milliseconds, a flags byte (bit 1 blending method, bit 0 disposal method), then the
 *   frame's own `VP8 `/`VP8L` chunks.
 */
export class WebpHeader {
  /**
   * @returns Whether the file is a RIFF container of type `WEBP`.
   */
  static matches(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 20) {
      return false;
    }

    const bytes = new Uint8Array(buffer, 0, 12);

    return String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  }

  /**
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns The canvas size, the duration of each frame and the loop count. A file that is not animated is a
   * single image.
   */
  static parse(buffer: ArrayBuffer, name: string): ImageHeader {
    const view = new DataView(buffer);
    const frameDurations: number[] = [];
    let width = 0;
    let height = 0;
    let animated = false;
    let loopCount = 0;
    let offset = 12;

    while (offset + 8 <= buffer.byteLength) {
      const type = String.fromCharCode(...new Uint8Array(buffer, offset, 4));
      const size = view.getUint32(offset + 4, true);
      const data = offset + 8;

      switch (type) {
        case 'VP8X':
          animated = (view.getUint8(data) & 0x02) !== 0;
          width = WebpHeader.#uint24(view, data + 4) + 1;
          height = WebpHeader.#uint24(view, data + 7) + 1;
          break;
        case 'VP8L':
          if (width === 0) {
            const bits = view.getUint32(data + 1, true);

            width = (bits & 0x3fff) + 1;
            height = ((bits >>> 14) & 0x3fff) + 1;
          }
          break;
        case 'VP8 ':
          if (width === 0) {
            width = view.getUint16(data + 6, true) & 0x3fff;
            height = view.getUint16(data + 8, true) & 0x3fff;
          }
          break;
        case 'ANIM':
          loopCount = view.getUint16(data + 4, true);
          break;
        case 'ANMF':
          frameDurations.push(WebpHeader.#uint24(view, data + 12));
          break;
        default:
          break;
      }

      offset = data + size + (size & 1);
    }

    if (width === 0 || height === 0) {
      throw new CorruptedResourceError(name, `${name} has no image size`);
    }

    if (!animated) {
      return { width, height, frameDurations: [0], repeat: 1, tags: [] };
    }

    if (frameDurations.length === 0) {
      throw new CorruptedResourceError(name, `${name} is animated but has no frames`);
    }

    return { width, height, frameDurations, repeat: loopCount, tags: [] };
  }

  static #uint24(view: DataView, offset: number): number {
    return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  }
}
