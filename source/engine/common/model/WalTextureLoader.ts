import Q from '../../../shared/Q.ts';
import W, { translateIndexToRGBA, WadLumpTexture } from '../W.ts';

/** Number of mip levels stored in a `.wal` file. */
const WAL_MIP_LEVELS = 4;

/**
 * Decodes Quake II's standalone `.wal` texture format (id Tech 2's
 * per-file equivalent of Quake 1's embedded WAD3 miptex lumps).
 *
 * Unlike WAD3 textures, `.wal` carries no embedded palette — pixel indices
 * are resolved against whatever palette the engine already has loaded
 * (`W.d_8to24table_u8`, Quake 1's `gfx/palette.lmp`), the same table every
 * other 8-bit Quake asset in this engine already decodes through. `.wal`
 * also has no transparent-key-color or fullbright-palette-range convention
 * the way Q1 WAD3 textures do (`{`-prefixed names, index >= 240); Quake II
 * expresses transparency and emissive surfaces via texinfo SURF_* flags
 * instead, which `BSP38Loader` already translates into `MaterialFlags`.
 */
export class WalTextureLoader {
  private constructor() {
    // Static-only helper class.
  }

  /**
   * Decode a `.wal` file's given mip level into an RGBA texture.
   * @returns The decoded texture, or `null` when the buffer is too small to be a valid `.wal` file.
   */
  static decode(data: ArrayBuffer, name: string, mipmapLevel = 0): WadLumpTexture | null {
    // header: name[32] + width(4) + height(4) + offsets[4](16) + animname[32] + flags(4) + contents(4) + value(4) = 100 bytes
    if (data.byteLength < 100) {
      return null;
    }

    console.assert(mipmapLevel >= 0 && mipmapLevel < WAL_MIP_LEVELS, 'WalTextureLoader: invalid mip level');

    const view = new DataView(data);
    const texName = Q.memstr(new Uint8Array(data, 0, 32)) || name;
    const width = view.getUint32(32, true);
    const height = view.getUint32(36, true);

    if (width === 0 || height === 0) {
      return null;
    }

    const mipOffset = view.getUint32(40 + mipmapLevel * 4, true);
    const scale = 1 << mipmapLevel;
    const mipWidth = Math.max(1, width / scale);
    const mipHeight = Math.max(1, height / scale);

    if (mipOffset + mipWidth * mipHeight > data.byteLength) {
      return null;
    }

    const indexedPixels = new Uint8Array(data, mipOffset, mipWidth * mipHeight);
    const rgba = translateIndexToRGBA(indexedPixels, mipWidth, mipHeight, W.d_8to24table_u8);

    return new WadLumpTexture(texName, mipWidth, mipHeight, rgba);
  }
}
