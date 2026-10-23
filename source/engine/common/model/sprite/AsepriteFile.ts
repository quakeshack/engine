import { CorruptedResourceError } from '../../Errors.ts';
import type { SpriteTag } from './ImageHeader.ts';
import { SpriteDirection } from './SpriteTypes.ts';

/** Bits per pixel of an Aseprite file. */
export enum AsepriteDepth {
  indexed = 8,
  grayscale = 16,
  rgba = 32,
}

export enum AsepriteLayerType {
  image = 0,
  group = 1,
  tilemap = 2,
}

export enum AsepriteCelType {
  raw = 0,
  linked = 1,
  compressed = 2,
  tilemap = 3,
}

/** A layer, in the order of the layer chunks (which is what the cels refer to). */
export interface AsepriteLayer {
  readonly name: string;
  readonly type: AsepriteLayerType;
  /** Whether the layer and every group around it is visible. */
  readonly visible: boolean;
  readonly background: boolean;
  /** A reference layer helps the artist and is never part of the picture. */
  readonly reference: boolean;
  /** 0 is normal; every other value is a blend mode this decoder does not apply. */
  readonly blendMode: number;
  /** 0 to 255; only meaningful when the file's header says layer opacity is valid, else 255. */
  readonly opacity: number;
}

/** One layer's picture in one frame. */
export interface AsepriteCel {
  readonly layerIndex: number;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
  readonly type: AsepriteCelType;
  /** Moves the cel in the draw order: it is drawn as if its layer were `zIndex` layers further up. */
  readonly zIndex: number;
  readonly width: number;
  readonly height: number;
  /** Pixels (raw) or the zlib stream of them (compressed), straight from the file. Empty for a linked cel. */
  readonly data: Uint8Array;
  /** The frame whose cel on the same layer this one shows, for a linked cel. */
  readonly linkedFrame: number;
}

export interface AsepriteFrame {
  /** Milliseconds, the file's default speed when the frame has none of its own. */
  readonly duration: number;
  readonly cels: readonly AsepriteCel[];
}

/** A slice with the position it has from a frame on; its pivot is where an artist marks the sprite's origin. */
export interface AsepriteSliceKey {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly pivot: readonly [number, number] | null;
}

export interface AsepriteSlice {
  readonly name: string;
  readonly keys: readonly AsepriteSliceKey[];
}

/** An Aseprite file taken apart; pixels are still compressed. */
export interface AsepriteData {
  readonly width: number;
  readonly height: number;
  readonly depth: AsepriteDepth;
  /** Whether the layers' opacity values count (bit 1 of the header flags). */
  readonly layerOpacityValid: boolean;
  /** The palette index that is transparent in layers that are not the background (indexed files). */
  readonly transparentIndex: number;
  readonly layers: readonly AsepriteLayer[];
  readonly frames: readonly AsepriteFrame[];
  readonly tags: readonly SpriteTag[];
  readonly slices: readonly AsepriteSlice[];
  /** RGBA of each palette entry, `null` when the file has none (true color). */
  readonly palette: Uint8Array | null;
}

const HEADER_SIZE = 128;
const FRAME_HEADER_SIZE = 16;
const FRAME_MAGIC = 0xf1fa;
const FILE_MAGIC = 0xa5e0;

const TAG_DIRECTIONS: readonly SpriteDirection[] = [
  SpriteDirection.forward,
  SpriteDirection.reverse,
  SpriteDirection.pingpong,
  SpriteDirection.pingpongReverse,
];

/**
 * Reads the structure of an Aseprite file (`.aseprite`, `.ase`), little endian throughout, following
 * `docs/ase-file-specs.md` of the Aseprite source.
 *
 * - Header, 128 bytes: u32 file size, u16 magic `0xA5E0` (at offset 4), u16 frames, u16 width, u16 height, u16 bits per
 *   pixel (32 RGBA, 16 grayscale, 8 indexed), u32 flags (1: layer opacity is valid), u16 speed (the default frame
 *   duration), 8 zero bytes, a byte with the transparent palette index, and more that is not needed here.
 * - Each frame: a 16 byte header (u32 byte count, u16 magic `0xF1FA`, u16 chunk count, u16 duration in ms, 2 bytes,
 *   u32 chunk count that wins when it is not 0) and its chunks: u32 size (including these 6 bytes), u16 type, data.
 * - Chunks used here: `0x2004` layer, `0x2005` cel, `0x2018` tags, `0x2019` palette, `0x0004` and `0x0011` old
 *   palettes, `0x2022` slice. The rest (user data, color profile, tilesets, ...) is skipped by its size.
 *
 * Nothing here decompresses: the header pass of a server needs the timing, the tags and the pivot only.
 */
export class AsepriteFile {
  /**
   * @returns Whether the file has the Aseprite magic number, which is at offset 4 (the file size comes first).
   */
  static matches(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < HEADER_SIZE + FRAME_HEADER_SIZE) {
      return false;
    }

    const view = new DataView(buffer);

    return view.getUint16(4, true) === FILE_MAGIC && view.getUint16(HEADER_SIZE + 4, true) === FRAME_MAGIC;
  }

  /**
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns The layers, the cels of every frame, the tags and slices, and the palette.
   * @throws CorruptedResourceError when the file is not a readable Aseprite file.
   */
  static parse(buffer: ArrayBuffer, name: string): AsepriteData {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const frameCount = view.getUint16(6, true);
    const depth = view.getUint16(12, true);
    const defaultDuration = view.getUint16(18, true);

    if (view.getUint16(4, true) !== FILE_MAGIC || frameCount === 0 || (depth !== 8 && depth !== 16 && depth !== 32)) {
      throw new CorruptedResourceError(name, `${name} is not an Aseprite file this engine can read`);
    }

    const state = new ParseState();
    const frames: AsepriteFrame[] = [];
    let offset = HEADER_SIZE;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      if (view.getUint16(offset + 4, true) !== FRAME_MAGIC) {
        throw new CorruptedResourceError(name, `${name} has a damaged frame header`);
      }

      const frameBytes = view.getUint32(offset, true);
      const oldChunkCount = view.getUint16(offset + 6, true);
      const duration = view.getUint16(offset + 8, true);
      const newChunkCount = view.getUint32(offset + 12, true);
      const chunkCount = newChunkCount !== 0 ? newChunkCount : oldChunkCount;
      const cels: AsepriteCel[] = [];
      let chunkOffset = offset + FRAME_HEADER_SIZE;

      for (let chunk = 0; chunk < chunkCount; chunk++) {
        const size = view.getUint32(chunkOffset, true);
        const type = view.getUint16(chunkOffset + 4, true);

        if (size < 6) {
          throw new CorruptedResourceError(name, `${name} has a damaged chunk`);
        }

        state.readChunk(type, view, bytes, chunkOffset + 6, chunkOffset + size, cels);
        chunkOffset += size;
      }

      frames.push({ duration: duration > 0 ? duration : defaultDuration, cels });
      offset += frameBytes;
    }

    return {
      width: view.getUint16(8, true),
      height: view.getUint16(10, true),
      depth,
      layerOpacityValid: (view.getUint32(14, true) & 1) !== 0,
      transparentIndex: view.getUint8(28),
      layers: state.finishLayers(view.getUint32(14, true) & 1),
      frames,
      tags: state.tags,
      slices: state.slices,
      palette: state.palette,
    };
  }
}

/** What the chunks of all frames add up to. */
class ParseState {
  readonly #rawLayers: Array<{ name: string, type: AsepriteLayerType, flags: number, childLevel: number, blendMode: number, opacity: number }> = [];
  readonly tags: SpriteTag[] = [];
  readonly slices: AsepriteSlice[] = [];
  palette: Uint8Array | null = null;
  /** The old palette chunks are only used when the file has no new one. */
  #hasNewPalette = false;

  /**
   * Reads the data of one chunk into the state, or into `cels`.
   */
  readChunk(type: number, view: DataView, bytes: Uint8Array, start: number, end: number, cels: AsepriteCel[]): void {
    switch (type) {
      case 0x2004:
        this.#readLayer(view, bytes, start);
        break;
      case 0x2005:
        cels.push(ParseState.#readCel(view, bytes, start, end));
        break;
      case 0x2018:
        this.#readTags(view, bytes, start);
        break;
      case 0x2019:
        this.#readPalette(view, start);
        break;
      case 0x0004:
      case 0x0011:
        this.#readOldPalette(view, start, type === 0x0011 ? 4 : 1);
        break;
      case 0x2022:
        this.#readSlice(view, bytes, start);
        break;
      default:
        break;
    }
  }

  /**
   * Works out which layers are really visible: a hidden group hides everything inside it.
   * @returns The layers in file order.
   */
  finishLayers(opacityFlag: number): AsepriteLayer[] {
    const layers: AsepriteLayer[] = [];
    /** visibility of the groups around the layer being read, by child level */
    const groupVisible: boolean[] = [];

    for (const raw of this.#rawLayers) {
      const parentsVisible = groupVisible.slice(0, raw.childLevel).every(Boolean);
      const visible = (raw.flags & 1) !== 0 && parentsVisible;

      groupVisible[raw.childLevel] = visible;
      layers.push({
        name: raw.name,
        type: raw.type,
        visible,
        background: (raw.flags & 8) !== 0,
        reference: (raw.flags & 64) !== 0,
        blendMode: raw.blendMode,
        opacity: opacityFlag !== 0 ? raw.opacity : 255,
      });
    }

    return layers;
  }

  #readLayer(view: DataView, bytes: Uint8Array, start: number): void {
    this.#rawLayers.push({
      flags: view.getUint16(start, true),
      type: view.getUint16(start + 2, true) as AsepriteLayerType,
      childLevel: view.getUint16(start + 4, true),
      blendMode: view.getUint16(start + 10, true),
      opacity: view.getUint8(start + 12),
      name: ParseState.#readString(view, bytes, start + 16).text,
    });
  }

  static #readCel(view: DataView, bytes: Uint8Array, start: number, end: number): AsepriteCel {
    const type = view.getUint16(start + 7, true) as AsepriteCelType;
    const common = {
      layerIndex: view.getUint16(start, true),
      x: view.getInt16(start + 2, true),
      y: view.getInt16(start + 4, true),
      opacity: view.getUint8(start + 6),
      type,
      zIndex: view.getInt16(start + 9, true),
    };
    const body = start + 16;

    switch (type) {
      case AsepriteCelType.linked:
        return { ...common, width: 0, height: 0, data: new Uint8Array(0), linkedFrame: view.getUint16(body, true) };
      case AsepriteCelType.tilemap:
        // the tiles need their tileset, which sprites do not draw; the cel stays so a layer can be reported
        return { ...common, width: view.getUint16(body, true), height: view.getUint16(body + 2, true), data: new Uint8Array(0), linkedFrame: 0 };
      default:
        return {
          ...common,
          width: view.getUint16(body, true),
          height: view.getUint16(body + 2, true),
          data: bytes.subarray(body + 4, end),
          linkedFrame: 0,
        };
    }
  }

  #readTags(view: DataView, bytes: Uint8Array, start: number): void {
    const count = view.getUint16(start, true);
    let offset = start + 10;

    for (let index = 0; index < count; index++) {
      const { text, end } = ParseState.#readString(view, bytes, offset + 17);

      this.tags.push({
        name: text,
        from: view.getUint16(offset, true),
        to: view.getUint16(offset + 2, true),
        direction: TAG_DIRECTIONS[view.getUint8(offset + 4)] ?? SpriteDirection.forward,
        repeat: view.getUint16(offset + 5, true),
      });
      offset = end;
    }
  }

  #readPalette(view: DataView, start: number): void {
    const size = view.getUint32(start, true);
    const first = view.getUint32(start + 4, true);
    const last = view.getUint32(start + 8, true);
    let offset = start + 20;

    this.#hasNewPalette = true;

    if (this.palette === null || this.palette.length < size * 4) {
      const grown = new Uint8Array(size * 4);

      if (this.palette !== null) {
        grown.set(this.palette);
      }

      this.palette = grown;
    }

    for (let index = first; index <= last; index++) {
      const flags = view.getUint16(offset, true);

      this.palette.set([view.getUint8(offset + 2), view.getUint8(offset + 3), view.getUint8(offset + 4), view.getUint8(offset + 5)], index * 4);
      offset += 6;

      if ((flags & 1) !== 0) {
        offset += 2 + view.getUint16(offset, true);
      }
    }
  }

  /**
   * @param scale 1 for the 8 bit palette chunk, 4 for the 6 bit one.
   */
  #readOldPalette(view: DataView, start: number, scale: number): void {
    if (this.#hasNewPalette) {
      return;
    }

    const palette = this.palette ?? new Uint8Array(256 * 4);
    const packets = view.getUint16(start, true);
    let offset = start + 2;
    let index = 0;

    for (let packet = 0; packet < packets; packet++) {
      index += view.getUint8(offset);
      const count = view.getUint8(offset + 1) || 256;

      offset += 2;

      for (let entry = 0; entry < count; entry++, index++) {
        palette.set([view.getUint8(offset) * scale, view.getUint8(offset + 1) * scale, view.getUint8(offset + 2) * scale, 255], index * 4);
        offset += 3;
      }
    }

    this.palette = palette;
  }

  #readSlice(view: DataView, bytes: Uint8Array, start: number): void {
    const keyCount = view.getUint32(start, true);
    const flags = view.getUint32(start + 4, true);
    const { text, end } = ParseState.#readString(view, bytes, start + 12);
    const keys: AsepriteSliceKey[] = [];
    let offset = end;

    for (let index = 0; index < keyCount; index++) {
      const key = { frame: view.getUint32(offset, true), x: view.getInt32(offset + 4, true), y: view.getInt32(offset + 8, true) };

      offset += 20;

      if ((flags & 1) !== 0) {
        offset += 16;
      }

      let pivot: readonly [number, number] | null = null;

      if ((flags & 2) !== 0) {
        pivot = [view.getInt32(offset, true), view.getInt32(offset + 4, true)];
        offset += 8;
      }

      keys.push({ ...key, pivot });
    }

    this.slices.push({ name: text, keys });
  }

  /**
   * @returns The string at `offset` (u16 length, UTF-8 bytes) and the position after it.
   */
  static #readString(view: DataView, bytes: Uint8Array, offset: number): { text: string, end: number } {
    const length = view.getUint16(offset, true);

    return { text: new TextDecoder().decode(bytes.subarray(offset + 2, offset + 2 + length)), end: offset + 2 + length };
  }
}
