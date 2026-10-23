import { CRC32 } from '../../../common/CRC.ts';
import { CorruptedResourceError } from '../../../common/Errors.ts';
import { ImageFormat, type ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';
import { PngHeader } from '../../../common/model/sprite/PngHeader.ts';
import { BrowserImagePixels, type StillImagePixels } from './BrowserImagePixels.ts';
import { SpriteImageDecoder } from './SpriteImageDecoder.ts';

/** What happens to a frame's rectangle once the frame has been shown (`dispose_op`). */
export enum ApngDispose {
  none = 0,
  background = 1,
  previous = 2,
}

/** How a frame is combined with the canvas (`blend_op`). */
export enum ApngBlend {
  source = 0,
  over = 1,
}

/** One frame of an APNG, its data chunks not yet decoded. */
export interface ApngFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly dispose: ApngDispose;
  readonly blend: ApngBlend;
  /** The frame's compressed data, in order: `IDAT` chunk data for the default image, `fdAT` without its sequence number. */
  readonly data: Uint8Array[];
}

/** An APNG taken apart. */
export interface ApngFile {
  readonly width: number;
  readonly height: number;
  /** The data of the `IHDR` chunk. */
  readonly header: Uint8Array;
  /** The `PLTE` and `tRNS` chunks every frame needs (type and data), the only ones that matter for decoding. */
  readonly sharedChunks: ReadonlyArray<{ type: string, data: Uint8Array }>;
  readonly frames: ApngFrame[];
}

/** Decodes one standalone PNG file into straight RGBA pixels. */
export type StillPngDecoder = (png: Uint8Array) => Promise<StillImagePixels>;

/**
 * Decodes APNG ourselves, so it looks and times the same in every browser. Each frame is rebuilt as a standalone
 * PNG file (`IHDR` with the frame's size, the palette, its data as `IDAT`, fresh CRCs) that the browser decodes as
 * a still image, then the frames are composited here, in plain code, following `dispose_op` and `blend_op`. The
 * layout of the chunks is in `PngHeader`.
 */
export class ApngSpriteDecoder extends SpriteImageDecoder {
  readonly #decodeStill: StillPngDecoder;

  /**
   * @param decodeStill How a standalone PNG becomes pixels, the browser's decoder unless a test brings its own.
   */
  constructor(decodeStill: StillPngDecoder = (png) => BrowserImagePixels.decodeStill(png, 'image/png')) {
    super();
    this.#decodeStill = decodeStill;
  }

  override getName(): string {
    return 'APNG';
  }

  override canDecode(format: ImageFormat, header: ImageHeader): boolean {
    return format === ImageFormat.png && header.frameDurations.length > 1;
  }

  override async decode(buffer: ArrayBuffer, _format: ImageFormat, _header: ImageHeader, name: string): Promise<DecodedSpriteImages> {
    const file = ApngSpriteDecoder.split(buffer, name);
    const pictures: StillImagePixels[] = [];

    for (const frame of file.frames) {
      const picture = await this.#decodeStill(ApngSpriteDecoder.buildStandalonePng(file, frame));

      if (picture.width !== frame.width || picture.height !== frame.height) {
        throw new CorruptedResourceError(name, `${name} has a frame of ${picture.width}x${picture.height} that the file says is ${frame.width}x${frame.height}`);
      }

      pictures.push(picture);
    }

    return { width: file.width, height: file.height, frames: ApngSpriteDecoder.composite(file, pictures) };
  }

  /**
   * Takes an APNG apart into its frames. The default image (`IDAT`) counts as the first frame only when a
   * frame control chunk comes before it.
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns The frames and what they share.
   */
  static split(buffer: ArrayBuffer, name: string): ApngFile {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const sharedChunks: Array<{ type: string, data: Uint8Array }> = [];
    const frames: ApngFrame[] = [];
    let header: Uint8Array | null = null;
    let current: ApngFrame | null = null;
    let seenImageData = false;
    let defaultImageIsFrame = false;
    let offset = 8;

    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset, false);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      const data = bytes.subarray(offset + 8, offset + 8 + length);

      switch (type) {
        case 'IHDR':
          header = data;
          break;
        case 'PLTE':
        case 'tRNS':
          sharedChunks.push({ type, data });
          break;
        case 'fcTL':
          current = {
            x: view.getUint32(offset + 8 + 12, false),
            y: view.getUint32(offset + 8 + 16, false),
            width: view.getUint32(offset + 8 + 4, false),
            height: view.getUint32(offset + 8 + 8, false),
            dispose: data[24] as ApngDispose,
            blend: data[25] as ApngBlend,
            data: [],
          };
          frames.push(current);
          defaultImageIsFrame ||= !seenImageData;
          break;
        case 'IDAT':
          seenImageData = true;

          if (defaultImageIsFrame) {
            current!.data.push(data);
          }
          break;
        case 'fdAT':
          current?.data.push(data.subarray(4));
          break;
        default:
          break;
      }

      if (type === 'IEND') {
        break;
      }

      offset += 12 + length;
    }

    if (header === null || frames.length === 0 || frames.some((frame) => frame.data.length === 0)) {
      throw new CorruptedResourceError(name, `${name} is not a complete APNG`);
    }

    return { width: view.getUint32(16, false), height: view.getUint32(20, false), header, sharedChunks, frames };
  }

  /**
   * @returns One frame as a PNG file of its own.
   */
  static buildStandalonePng(file: ApngFile, frame: ApngFrame): Uint8Array {
    const header = file.header.slice();
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);

    headerView.setUint32(0, frame.width, false);
    headerView.setUint32(4, frame.height, false);

    const chunks: Array<{ type: string, data: Uint8Array }> = [
      { type: 'IHDR', data: header },
      ...file.sharedChunks,
      ...frame.data.map((data) => ({ type: 'IDAT', data })),
      { type: 'IEND', data: new Uint8Array(0) },
    ];
    const png = new Uint8Array(PngHeader.SIGNATURE.length + chunks.reduce((sum, chunk) => sum + 12 + chunk.data.length, 0));
    const view = new DataView(png.buffer);
    let offset = PngHeader.SIGNATURE.length;

    png.set(PngHeader.SIGNATURE, 0);

    for (const chunk of chunks) {
      view.setUint32(offset, chunk.data.length, false);

      for (let index = 0; index < 4; index++) {
        png[offset + 4 + index] = chunk.type.charCodeAt(index);
      }

      png.set(chunk.data, offset + 8);
      view.setUint32(offset + 8 + chunk.data.length, CRC32.Block(png.subarray(offset + 4, offset + 8 + chunk.data.length)), false);
      offset += 12 + chunk.data.length;
    }

    return png;
  }

  /**
   * Plays the frames onto a canvas that starts out transparent black and snapshots it after each frame.
   * @param pictures The decoded frames, straight RGBA, in the order of `file.frames`.
   * @returns One premultiplied RGBA snapshot of the full canvas per frame.
   */
  static composite(file: ApngFile, pictures: readonly StillImagePixels[]): Uint8Array[] {
    const { width, height } = file;
    const canvas = new Uint8Array(width * height * 4);
    const snapshots: Uint8Array[] = [];

    for (let index = 0; index < file.frames.length; index++) {
      const frame = file.frames[index];
      // nothing to go back to before the first frame
      const dispose = index === 0 && frame.dispose === ApngDispose.previous ? ApngDispose.background : frame.dispose;
      const saved = dispose === ApngDispose.previous ? canvas.slice() : null;

      ApngSpriteDecoder.#blendFrame(canvas, width, height, frame, pictures[index]);
      snapshots.push(canvas.slice());

      if (dispose === ApngDispose.background) {
        ApngSpriteDecoder.#clearRectangle(canvas, width, height, frame);
      } else if (saved !== null) {
        canvas.set(saved);
      }
    }

    return snapshots;
  }

  static #blendFrame(canvas: Uint8Array, canvasWidth: number, canvasHeight: number, frame: ApngFrame, picture: StillImagePixels): void {
    for (let row = 0; row < frame.height; row++) {
      const y = frame.y + row;

      if (y >= canvasHeight) {
        break;
      }

      for (let column = 0; column < frame.width; column++) {
        const x = frame.x + column;

        if (x >= canvasWidth) {
          break;
        }

        const source = (row * frame.width + column) * 4;
        const target = (y * canvasWidth + x) * 4;
        const alpha = picture.rgba[source + 3];

        if (frame.blend === ApngBlend.over && alpha === 0) {
          continue;
        }

        // the canvas holds premultiplied color: source over destination is src + dst * (1 - srcAlpha)
        const keep = frame.blend === ApngBlend.over ? 255 - alpha : 0;

        for (let channel = 0; channel < 3; channel++) {
          const color = Math.round(picture.rgba[source + channel] * alpha / 255);

          canvas[target + channel] = keep === 0 ? color : color + Math.round(canvas[target + channel] * keep / 255);
        }

        canvas[target + 3] = keep === 0 ? alpha : alpha + Math.round(canvas[target + 3] * keep / 255);
      }
    }
  }

  static #clearRectangle(canvas: Uint8Array, canvasWidth: number, canvasHeight: number, frame: ApngFrame): void {
    for (let y = frame.y; y < Math.min(frame.y + frame.height, canvasHeight); y++) {
      canvas.fill(0, (y * canvasWidth + frame.x) * 4, (y * canvasWidth + Math.min(frame.x + frame.width, canvasWidth)) * 4);
    }
  }
}
