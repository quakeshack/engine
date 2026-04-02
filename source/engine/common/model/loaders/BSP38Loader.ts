import { content } from '../../../../shared/Defs.ts';
import Q from '../../../../shared/Q.ts';
import Vector from '../../../../shared/Vector.ts';
import { CRC16CCITT } from '../../CRC.ts';
import { Plane } from '../BaseModel.ts';
import { Brush, BrushModel, BrushSide, Node } from '../BSP.ts';
import { ModelLoader } from '../ModelLoader.ts';

interface LumpViews {
  [index: number]: DataView;
}

enum BSP38Lump {
  ENTITIES = 0,
  PLANES = 1,
  VERTEXES = 2,
  VISIBILITY = 3,
  NODES = 4,
  TEXINFO = 5,
  FACES = 6,
  LIGHTING = 7,
  LEAFS = 8,
  LEAFFACES = 9,
  LEAFBRUSHES = 10,
  EDGES = 11,
  SURFEDGES = 12,
  MODELS = 13,
  BRUSHES = 14,
  BRUSHSIDES = 15,
  POP = 16,
  AREAS = 17,
  AREAPORTALS = 18,
}

const BSP_MAGIC = 1347633737;
const BSP_VERSION = 38;

/**
 * Loader for Quake 2 BSP38 format (.bsp).
 */
export class BSP38Loader extends ModelLoader {
  static readonly #contentsMap: Record<number, number> = Object.freeze({
    0: content.CONTENT_EMPTY,
    1: content.CONTENT_SOLID,
    2: content.CONTENT_SOLID,
    4: content.CONTENT_EMPTY,
    8: content.CONTENT_LAVA,
    16: content.CONTENT_SLIME,
    32: content.CONTENT_WATER,
    64: content.CONTENT_EMPTY,

    0x08000: content.CONTENT_EMPTY,
    0x10000: content.CONTENT_EMPTY,
    0x20000: content.CONTENT_EMPTY,

    0x040000: content.CONTENT_CURRENT_0,
    0x080000: content.CONTENT_CURRENT_90,
    0x100000: content.CONTENT_CURRENT_180,
    0x200000: content.CONTENT_CURRENT_270,
    0x400000: content.CONTENT_CURRENT_UP,
    0x800000: content.CONTENT_CURRENT_DOWN,

    0x10000000: content.CONTENT_EMPTY,
    0x20000000: content.CONTENT_EMPTY,
  });

  override getMagicNumbers(): number[] {
    return [BSP_MAGIC];
  }

  override getExtensions(): string[] {
    return ['.bsp'];
  }

  override getName(): string {
    return 'Quake 2 BSP38';
  }

  override canLoad(buffer: ArrayBuffer, filename: string): boolean {
    const view = new DataView(buffer);

    return super.canLoad(buffer, filename) && view.getUint32(4, true) === BSP_VERSION;
  }

  override load(buffer: ArrayBuffer, name: string): Promise<BrushModel> {
    const loadmodel = new BrushModel(name);

    loadmodel.version = BSP_VERSION;

    const lumpViews = this.#loadLumps(buffer);
    this.#loadEntities(lumpViews[BSP38Lump.ENTITIES], loadmodel);
    this.#loadSurfaces(lumpViews[BSP38Lump.TEXINFO], loadmodel);
    this.#loadLeafs(lumpViews[BSP38Lump.LEAFS], loadmodel);
    this.#loadLeafBrushes(lumpViews[BSP38Lump.LEAFBRUSHES], loadmodel);
    this.#loadPlanes(lumpViews[BSP38Lump.PLANES], loadmodel);
    this.#loadBrushes(lumpViews[BSP38Lump.BRUSHES], loadmodel);
    this.#loadBrushSides(lumpViews[BSP38Lump.BRUSHSIDES], loadmodel);
    this.#loadSubmodels(lumpViews[BSP38Lump.MODELS], loadmodel);

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return Promise.resolve(loadmodel);
  }

  /**
   * Slice all BSP38 lumps into DataViews.
   * @returns Per-lump DataViews indexed by BSP38 lump number.
   */
  #loadLumps(buffer: ArrayBuffer): LumpViews {
    const lumpViews: LumpViews = {};
    const view = new DataView(buffer);

    for (let lumpIndex = BSP38Lump.ENTITIES; lumpIndex <= BSP38Lump.AREAPORTALS; lumpIndex++) {
      const offset = view.getUint32(8 + lumpIndex * 8, true);
      const length = view.getUint32(8 + lumpIndex * 8 + 4, true);
      lumpViews[lumpIndex] = new DataView(buffer, offset, length);
    }

    return lumpViews;
  }

  /**
   * Read a null-terminated string from a lump view.
   * @returns The decoded lump string.
   */
  #readString(dataView: DataView, offset = 0, length = dataView.byteLength - offset): string {
    return Q.memstr(new Uint8Array(dataView.buffer, dataView.byteOffset + offset, length));
  }

  /**
   * Load entity text from the BSP38 entities lump.
   */
  #loadEntities(entitiesLump: DataView, loadmodel: BrushModel): void {
    loadmodel.entities = this.#readString(entitiesLump, 0, entitiesLump.byteLength);
  }

  /**
   * Load BSP38 texinfo entries.
   */
  #loadSurfaces(texinfoLump: DataView, loadmodel: BrushModel): void {
    loadmodel.texinfo.length = 0;

    const stride = 76;
    const length = texinfoLump.byteLength / stride;

    for (let index = 0; index < length; index++) {
      const offset = index * stride;

      loadmodel.texinfo.push({
        vecs: [
          [
            texinfoLump.getFloat32(offset + 0, true),
            texinfoLump.getFloat32(offset + 4, true),
            texinfoLump.getFloat32(offset + 8, true),
            texinfoLump.getFloat32(offset + 12, true),
          ],
          [
            texinfoLump.getFloat32(offset + 16, true),
            texinfoLump.getFloat32(offset + 20, true),
            texinfoLump.getFloat32(offset + 24, true),
            texinfoLump.getFloat32(offset + 28, true),
          ],
        ],
        flags: texinfoLump.getInt32(offset + 32, true),
        value: texinfoLump.getInt32(offset + 36, true),
        texture: this.#readString(texinfoLump, offset + 40, 32),
        nexttexinfo: texinfoLump.getInt32(offset + 72, true),
      });
    }
  }

  /**
   * Translate Quake 2 brush contents to Quake contents constants.
   * @returns The translated Quake contents constant.
   */
  #translateQ2Contents(q2Contents: number): number {
    console.assert(q2Contents in BSP38Loader.#contentsMap);
    return BSP38Loader.#contentsMap[q2Contents];
  }

  /**
   * Load BSP38 leafs.
   */
  #loadLeafs(leafsLump: DataView, loadmodel: BrushModel): void {
    loadmodel.leafs.length = 0;

    const stride = 28;
    const length = leafsLump.byteLength / stride;

    for (let index = 0; index < length; index++) {
      const offset = index * stride;

      loadmodel.leafs.push(Object.assign(new Node(loadmodel), {
        num: index,
        contents: this.#translateQ2Contents(leafsLump.getInt32(offset + 0, true)),
        cluster: leafsLump.getInt16(offset + 4, true),
        area: leafsLump.getInt16(offset + 6, true),
        mins: new Vector(
          leafsLump.getInt16(offset + 8, true),
          leafsLump.getInt16(offset + 10, true),
          leafsLump.getInt16(offset + 12, true),
        ),
        maxs: new Vector(
          leafsLump.getInt16(offset + 14, true),
          leafsLump.getInt16(offset + 16, true),
          leafsLump.getInt16(offset + 18, true),
        ),
        firstmarksurface: leafsLump.getUint16(offset + 20, true),
        nummarksurfaces: leafsLump.getUint16(offset + 22, true),
        firstleafbrush: leafsLump.getUint16(offset + 24, true),
        numleafbrushes: leafsLump.getUint16(offset + 26, true),
      }));
    }
  }

  /**
   * Load BSP38 leafbrush links.
   */
  #loadLeafBrushes(leafbrushesLump: DataView, loadmodel: BrushModel): void {
    const count = leafbrushesLump.byteLength / 2;
    loadmodel.leafbrushes = new Array(count);

    for (let index = 0; index < count; index++) {
      loadmodel.leafbrushes[index] = leafbrushesLump.getUint16(index * 2, true);
    }
  }

  /**
   * Load BSP38 planes.
   */
  #loadPlanes(planesLump: DataView, loadmodel: BrushModel): void {
    loadmodel.planes.length = 0;

    const stride = 20;
    const length = planesLump.byteLength / stride;

    for (let index = 0; index < length; index++) {
      const offset = index * stride;

      loadmodel.planes.push(new Plane(
        new Vector(
          planesLump.getFloat32(offset + 0, true),
          planesLump.getFloat32(offset + 4, true),
          planesLump.getFloat32(offset + 8, true),
        ),
        planesLump.getFloat32(offset + 12, true),
      ));
    }
  }

  /**
   * Load BSP38 brushes.
   */
  #loadBrushes(brushesLump: DataView, loadmodel: BrushModel): void {
    const stride = 12;
    const length = brushesLump.byteLength / stride;

    loadmodel.brushes = new Array(length);

    for (let index = 0; index < length; index++) {
      const offset = index * stride;

      loadmodel.brushes[index] = Object.assign(new Brush(loadmodel), {
        firstside: brushesLump.getInt32(offset + 0, true),
        numsides: brushesLump.getInt32(offset + 4, true),
        contents: this.#translateQ2Contents(brushesLump.getInt32(offset + 8, true)),
      });
    }
  }

  /**
   * Load BSP38 brush sides.
   */
  #loadBrushSides(brushsidesLump: DataView, loadmodel: BrushModel): void {
    const stride = 4;
    const length = brushsidesLump.byteLength / stride;
    loadmodel.brushsides = new Array(length);

    for (let index = 0; index < length; index++) {
      const offset = index * stride;

      loadmodel.brushsides[index] = Object.assign(new BrushSide(loadmodel), {
        planenum: brushsidesLump.getUint16(offset + 0, true),
        texinfo: brushsidesLump.getInt16(offset + 2, true),
      });
    }
  }

  /**
   * Load BSP38 submodels.
   */
  #loadSubmodels(modelsLump: DataView, loadmodel: BrushModel): void {
    void modelsLump;
    loadmodel.submodels.length = 0;
  }
}
