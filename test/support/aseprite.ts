import zlib from 'node:zlib';

/** A layer for `encodeAseprite()`. */
export interface TestAseLayer {
  readonly name: string;
  /** Bit 1 visible, 8 background, 64 reference. Visible by default. */
  readonly flags?: number;
  /** 0 image, 1 group, 2 tilemap. */
  readonly type?: number;
  readonly childLevel?: number;
  readonly blendMode?: number;
  readonly opacity?: number;
}

/** A cel for `encodeAseprite()`. */
export interface TestAseCel {
  readonly layer: number;
  readonly x?: number;
  readonly y?: number;
  readonly opacity?: number;
  readonly zIndex?: number;
  /** `raw` and `compressed` carry `pixels`, `linked` points to a frame. */
  readonly kind?: 'raw' | 'compressed' | 'linked';
  readonly width?: number;
  readonly height?: number;
  /** Bytes in the file's color depth: RGBA, value+alpha or palette indices. */
  readonly pixels?: readonly number[];
  readonly linkedFrame?: number;
}

/** What `encodeAseprite()` writes. */
export interface TestAseprite {
  readonly width: number;
  readonly height: number;
  /** 32, 16 or 8; 32 by default. */
  readonly depth?: number;
  /** Header flags, 1 means the layers' opacity counts. */
  readonly flags?: number;
  /** The header's default duration. */
  readonly speed?: number;
  readonly transparentIndex?: number;
  /** RGBA of each palette entry, written as a new palette chunk. */
  readonly palette?: readonly number[];
  /** RGB of each entry, written as an old palette chunk (0x0004). */
  readonly oldPalette?: readonly number[];
  readonly layers?: readonly TestAseLayer[];
  /** Milliseconds, 0 for none (the default speed applies), and the frame's cels. */
  readonly frames: ReadonlyArray<{ readonly duration?: number, readonly cels?: readonly TestAseCel[] }>;
  readonly tags?: ReadonlyArray<{ readonly name: string, readonly from: number, readonly to: number, readonly direction?: number, readonly repeat?: number }>;
  readonly slices?: ReadonlyArray<{ readonly name: string, readonly keys: ReadonlyArray<{ readonly frame: number, readonly x: number, readonly y: number, readonly pivot?: readonly [number, number] }> }>;
}

/** Collects little endian values. */
class Writer {
  readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >> 8);
  }

  i16(value: number): this {
    return this.u16(value & 0xffff);
  }

  u32(value: number): this {
    return this.u16(value & 0xffff).u16(value >>> 16);
  }

  zeros(count: number): this {
    this.bytes.push(...new Array<number>(count).fill(0));
    return this;
  }

  string(text: string): this {
    const encoded = [...new TextEncoder().encode(text)];

    return this.u16(encoded.length).raw(encoded);
  }

  raw(bytes: readonly number[] | Uint8Array): this {
    this.bytes.push(...bytes);
    return this;
  }
}

/**
 * @returns A chunk: u32 size (with these 6 bytes), u16 type, the data.
 */
function chunk(type: number, data: Writer): number[] {
  return new Writer().u32(data.bytes.length + 6).u16(type).raw(data.bytes).bytes;
}

/**
 * Writes an Aseprite file following the file specification, for tests that need layouts the fixtures do not have.
 * @returns The file.
 */
export function encodeAseprite(file: TestAseprite): ArrayBuffer {
  const layers = file.layers ?? [{ name: 'Layer' }];
  const frames: number[][] = [];

  file.frames.forEach((frame, frameIndex) => {
    const chunks: number[][] = [];

    if (frameIndex === 0) {
      if (file.palette !== undefined) {
        const palette = new Writer().u32(file.palette.length / 4).u32(0).u32(file.palette.length / 4 - 1).zeros(8);

        for (let entry = 0; entry < file.palette.length; entry += 4) {
          palette.u16(0).raw(file.palette.slice(entry, entry + 4));
        }

        chunks.push(chunk(0x2019, palette));
      }

      if (file.oldPalette !== undefined) {
        chunks.push(chunk(0x0004, new Writer().u16(1).u8(0).u8(file.oldPalette.length / 3 % 256).raw(file.oldPalette)));
      }

      for (const layer of layers) {
        chunks.push(chunk(0x2004, new Writer()
          .u16(layer.flags ?? 1).u16(layer.type ?? 0).u16(layer.childLevel ?? 0).u16(0).u16(0)
          .u16(layer.blendMode ?? 0).u8(layer.opacity ?? 255).zeros(3).string(layer.name)));
      }

      if (file.tags !== undefined) {
        const tags = new Writer().u16(file.tags.length).zeros(8);

        for (const tag of file.tags) {
          tags.u16(tag.from).u16(tag.to).u8(tag.direction ?? 0).u16(tag.repeat ?? 0).zeros(6).zeros(3).u8(0).string(tag.name);
        }

        chunks.push(chunk(0x2018, tags));
      }

      for (const slice of file.slices ?? []) {
        const hasPivot = slice.keys.some((key) => key.pivot !== undefined);
        const data = new Writer().u32(slice.keys.length).u32(hasPivot ? 2 : 0).u32(0).string(slice.name);

        for (const key of slice.keys) {
          data.u32(key.frame).u32(key.x).u32(key.y).u32(4).u32(4);

          if (hasPivot) {
            data.u32(key.pivot?.[0] ?? 0).u32(key.pivot?.[1] ?? 0);
          }
        }

        chunks.push(chunk(0x2022, data));
      }
    }

    for (const cel of frame.cels ?? []) {
      const kind = cel.kind ?? 'compressed';
      const data = new Writer().u16(cel.layer).i16(cel.x ?? 0).i16(cel.y ?? 0).u8(cel.opacity ?? 255)
        .u16(kind === 'raw' ? 0 : kind === 'linked' ? 1 : 2).i16(cel.zIndex ?? 0).zeros(5);

      if (kind === 'linked') {
        data.u16(cel.linkedFrame ?? 0);
      } else {
        data.u16(cel.width ?? 0).u16(cel.height ?? 0).raw(kind === 'raw' ? cel.pixels ?? [] : zlib.deflateSync(Uint8Array.from(cel.pixels ?? [])));
      }

      chunks.push(chunk(0x2005, data));
    }

    // an unknown chunk, which a reader has to skip by its size
    chunks.push(chunk(0x2020, new Writer().u32(0)));

    const body = chunks.flat();

    frames.push(new Writer().u32(16 + body.length).u16(0xf1fa).u16(chunks.length).u16(frame.duration ?? 0).zeros(2).u32(0).raw(body).bytes);
  });

  const frameBytes = frames.flat();
  const header = new Writer()
    .u32(128 + frameBytes.length).u16(0xa5e0).u16(file.frames.length).u16(file.width).u16(file.height).u16(file.depth ?? 32)
    .u32(file.flags ?? 0).u16(file.speed ?? 100).u32(0).u32(0).u8(file.transparentIndex ?? 0).zeros(3)
    .u16(file.palette === undefined ? 0 : file.palette.length / 4).zeros(128 - 34);

  return new Uint8Array([...header.bytes, ...frameBytes]).buffer;
}
