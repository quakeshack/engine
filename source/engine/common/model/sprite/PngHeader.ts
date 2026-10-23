import { CorruptedResourceError } from '../../Errors.ts';
import type { ImageHeader } from './ImageHeader.ts';

/**
 * Header pass for PNG and APNG, big endian throughout (PNG Third Edition, section 11.3.6).
 *
 * - Signature `89 50 4E 47 0D 0A 1A 0A`, then chunks: u32 data length, four letters of type, the data, u32 CRC.
 * - `IHDR`: u32 width, u32 height, and the pixel format.
 * - `acTL` (before the first `IDAT`) makes the file animated: u32 `num_frames`, u32 `num_plays` (0 for forever).
 * - `fcTL`, one per frame: u32 sequence number, u32 width, height, x offset, y offset, u16 `delay_num`, u16
 *   `delay_den` (the delay is `delay_num / delay_den` seconds, a zero denominator means 100), u8 `dispose_op`,
 *   u8 `blend_op`.
 *
 * The default image (the `IDAT` chunks) is the first frame only when an `fcTL` comes before it; otherwise it is
 * a fallback for viewers that do not play animations and is not part of the animation. `fdAT` chunks carry
 * the data of the other frames. A pixel pass needs the offsets and operations, the header pass only the delays.
 */
export class PngHeader {
  static readonly SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  /**
   * @returns Whether the file starts with the PNG signature.
   */
  static matches(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 8 + 25) {
      return false;
    }

    const bytes = new Uint8Array(buffer, 0, 8);

    return PngHeader.SIGNATURE.every((value, index) => bytes[index] === value);
  }

  /**
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns The size, the delay of each frame and the number of plays. A file without `acTL` is a single image.
   */
  static parse(buffer: ArrayBuffer, name: string): ImageHeader {
    const view = new DataView(buffer);
    const frameDurations: number[] = [];
    let width = 0;
    let height = 0;
    let animated = false;
    let plays = 1;
    let offset = 8;

    while (offset + 8 <= buffer.byteLength) {
      const length = view.getUint32(offset, false);
      const type = String.fromCharCode(...new Uint8Array(buffer, offset + 4, 4));
      const data = offset + 8;

      if (type === 'IHDR') {
        width = view.getUint32(data, false);
        height = view.getUint32(data + 4, false);
      } else if (type === 'acTL') {
        animated = true;
        plays = view.getUint32(data + 4, false);
      } else if (type === 'fcTL') {
        const numerator = view.getUint16(data + 20, false);
        const denominator = view.getUint16(data + 22, false) || 100;

        frameDurations.push(Math.round(numerator * 1000 / denominator));
      } else if (type === 'IEND') {
        break;
      }

      offset = data + length + 4;
    }

    if (width === 0 || height === 0) {
      throw new CorruptedResourceError(name, `${name} has no IHDR chunk`);
    }

    if (!animated) {
      return { width, height, frameDurations: [0], repeat: 1, tags: [] };
    }

    if (frameDurations.length === 0) {
      throw new CorruptedResourceError(name, `${name} is animated but has no frame control chunk`);
    }

    return { width, height, frameDurations, repeat: plays, tags: [] };
  }
}
