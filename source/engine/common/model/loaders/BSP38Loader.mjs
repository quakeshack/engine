import { content } from '../../../../shared/Defs.ts';
import Q from '../../../../shared/Q.mjs';
import Vector from '../../../../shared/Vector.ts';
import { CRC16CCITT } from '../../CRC.mjs';
import { Plane } from '../BaseModel.mjs';
import { Brush, BrushModel, BrushSide, Node } from '../BSP.mjs';
import { ModelLoader } from '../ModelLoader.mjs';

/** @typedef {Record<number, DataView>} LumpViews */

const BSP_MAGIC = 1347633737; // 'IBSP' little-endian
const BSP_VERSION = 38;

const lumps = Object.freeze({
  LUMP_ENTITIES: 0,
  LUMP_PLANES: 1,
  LUMP_VERTEXES: 2,
  LUMP_VISIBILITY: 3,
  LUMP_NODES: 4,
  LUMP_TEXINFO: 5,
  LUMP_FACES: 6,
  LUMP_LIGHTING: 7,
  LUMP_LEAFS: 8,
  LUMP_LEAFFACES: 9,
  LUMP_LEAFBRUSHES: 10,
  LUMP_EDGES: 11,
  LUMP_SURFEDGES: 12,
  LUMP_MODELS: 13,
  LUMP_BRUSHES: 14,
  LUMP_BRUSHSIDES: 15,
  LUMP_POP: 16,
  LUMP_AREAS: 17,
  LUMP_AREAPORTALS: 18,
});

export class BSP38Loader extends ModelLoader {
  static #contentsMap = Object.freeze({
    0: content.CONTENT_EMPTY,
    1: content.CONTENT_SOLID,
    2: content.CONTENT_SOLID, // window
    4: content.CONTENT_EMPTY, // aux
    8: content.CONTENT_LAVA,
    16: content.CONTENT_SLIME,
    32: content.CONTENT_WATER,
    64: content.CONTENT_EMPTY, // fog

    0x08000: content.CONTENT_EMPTY, // area portal
    0x10000: content.CONTENT_EMPTY, // player clip
    0x20000: content.CONTENT_EMPTY, // monster clip

    0x040000: content.CONTENT_CURRENT_0,
    0x080000: content.CONTENT_CURRENT_90,
    0x100000: content.CONTENT_CURRENT_180,
    0x200000: content.CONTENT_CURRENT_270,
    0x400000: content.CONTENT_CURRENT_UP,
    0x800000: content.CONTENT_CURRENT_DOWN,

    0x10000000: content.CONTENT_EMPTY, // translucent
    0x20000000: content.CONTENT_EMPTY, // ladder
  });

  getMagicNumbers() {
    return [BSP_MAGIC];
  }

  getExtensions() {
    return ['.bsp'];
  }

  getName() {
    return 'Quake 2 BSP38';
  }

  canLoad(buffer, filename) {
    const view = new DataView(buffer);

    return super.canLoad(buffer, filename) && view.getUint32(4, true) === BSP_VERSION;
  }

  _loadLumps(buffer) {
    /** @type {LumpViews} */
    const lumpViews = {};

    const dv = new DataView(buffer);

    for (let i = 0; i < Object.keys(lumps).length; i++) {
      const offset = dv.getUint32(8 + i * 8, true);
      const length = dv.getUint32(8 + i * 8 + 4, true);

      lumpViews[i] = new DataView(buffer, offset, length);
    }

    return lumpViews;
  }

  /**
   * Reads a null-terminated string from a DataView.
   * @param {DataView} dataView data view to read from
   * @param {number} offset optional, offset to start reading
   * @param {number} length optional, length of the string to read
   * @returns {string} string, null-terminated or up to length
   */
  _readString(dataView, offset = 0, length = dataView.byteLength - offset) {
    return Q.memstr(new Uint8Array(dataView.buffer, dataView.byteOffset + offset, length));
  }

  /**
   * @param {DataView} entitiesLump data view of entities lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadEntities(entitiesLump, loadmodel) {
    loadmodel.entities = this._readString(entitiesLump, 0, entitiesLump.byteLength);
  }

  /**
   * @param {DataView} texinfoLump data view of texinfo lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadSurfaces(texinfoLump, loadmodel) {
    loadmodel.texinfo.length = 0;

    // float		vecs[2][4];		// [s/t][xyz offset]
    // int32		flags;			// miptex flags + overrides
    // int32		value;			// light emission, etc
    // char		texture[32];	// texture name (textures/*.wal)
    // int32		nexttexinfo;	// for animations, -1 = end of chain

    const stride = 76;
    const length = texinfoLump.byteLength / stride;
    for (let i = 0; i < length; i++) {
      const offset = i * stride;

      // TODO: class
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
        texture: this._readString(texinfoLump, offset + 40, 32),
        nexttexinfo: texinfoLump.getInt32(offset + 72, true),
      });
    }
  }

  /**
   * @param {number} contents Quake2 contents
   * @returns {number} translated contents
   */
  _translateQ2Contents(contents) {
    console.assert(contents in BSP38Loader.#contentsMap);
    return BSP38Loader.#contentsMap[contents];
  }

  /**
   * @param {DataView} leafsLump data view of leafs lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadLeafs(leafsLump, loadmodel) {
    loadmodel.leafs.length = 0;

    // int32			contents;			// OR of all brushes (not needed?)
    // int16			cluster;
    // int16			area;
    // int16			mins[3];			// for frustum culling
    // int16			maxs[3];
    // uint16			firstleafface;
    // uint16			numleaffaces;
    // uint16			firstleafbrush;
    // uint16			numleafbrushes;

    const stride = 28;
    const length = leafsLump.byteLength / stride;
    for (let i = 0; i < length; i++) {
      const offset = i * stride;

      loadmodel.leafs.push(/** @type {Node} */(Object.assign(new Node(loadmodel), {
        num: i,
        contents: this._translateQ2Contents(leafsLump.getInt32(offset + 0, true)),
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
      })));
    }
  }

  /**
   * @param {DataView} leafbrushesLump data view of leafbrushes lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadLeafBrushes(leafbrushesLump, loadmodel) {
    const count = leafbrushesLump.byteLength / 2; // all uint16
    loadmodel.leafbrushes = new Array(count);

    for (let i = 0; i < count; i++) {
      loadmodel.leafbrushes[i] = leafbrushesLump.getUint16(i * 2, true);
    }
  }

  /**
   * @param {DataView} planesLump data view of planes lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadPlanes(planesLump, loadmodel) {
    loadmodel.planes.length = 0;

    // float	normal[3];
    // float	dist;
    // int32	type;		// PLANE_X - PLANE_ANYZ ?remove? trivial to regenerate

    const stride = 20;
    const length = planesLump.byteLength / stride;
    for (let i = 0; i < length; i++) {
      const offset = i * stride;

      loadmodel.planes.push(new Plane(
        new Vector(
          planesLump.getFloat32(offset + 0, true),
          planesLump.getFloat32(offset + 4, true),
          planesLump.getFloat32(offset + 8, true),
        ),
        planesLump.getFloat32(offset + 12, true),
      ));

      // CR: not reading in type
    }
  }

  /**
   * @param {DataView} brushesLump data view of brushes lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadBrushes(brushesLump, loadmodel) {
    // int32			firstside;
    // int32			numsides;
    // int32			contents;

    const stride = 12;
    const length = brushesLump.byteLength / stride;

    loadmodel.brushes = new Array(length);

    for (let i = 0; i < length; i++) {
      const offset = i * stride;

      loadmodel.brushes[i] = Object.assign(new Brush(loadmodel), {
        firstside: brushesLump.getInt32(offset + 0, true),
        numsides: brushesLump.getInt32(offset + 4, true),
        contents: this._translateQ2Contents(brushesLump.getInt32(offset + 8, true)),
      });
    }
  }

  _loadBrushSides(brushsidesLump, loadmodel) {
    // uint16	planenum;		// facing out of the leaf
    // int16	texinfo;

    const stride = 4;
    const length = brushsidesLump.byteLength / stride;
    loadmodel.brushsides = new Array(length);

    for (let i = 0; i < length; i++) {
      const offset = i * stride;

      loadmodel.brushsides[i] = /** @type {BrushSide} */ (Object.assign(new BrushSide(loadmodel), {
        planenum: brushsidesLump.getUint16(offset + 0, true),
        texinfo: brushsidesLump.getInt16(offset + 2, true),
      }));
    }
  }

  _loadSubmodels(modelsLump, loadmodel) {
    // float		mins[3], maxs[3];
    // float		origin[3];		// for sounds or lights
    // int32		headnode;
    // int32		firstface, numfaces;	// submodels just draw faces
    //                   // without walking the bsp tree

    const stride = 48;
    const length = modelsLump.byteLength / stride;
    loadmodel.submodels.length = 0;


  }

  async load(buffer, name) {
    const loadmodel = new BrushModel(name);

    loadmodel.version = BSP_VERSION;

    const lviews = this._loadLumps(buffer);
    this._loadEntities(lviews[lumps.LUMP_ENTITIES], loadmodel);
    this._loadSurfaces(lviews[lumps.LUMP_TEXINFO], loadmodel);
    this._loadLeafs(lviews[lumps.LUMP_LEAFS], loadmodel);
    this._loadLeafBrushes(lviews[lumps.LUMP_LEAFBRUSHES], loadmodel);
    this._loadPlanes(lviews[lumps.LUMP_PLANES], loadmodel);
    this._loadBrushes(lviews[lumps.LUMP_BRUSHES], loadmodel);
    this._loadBrushSides(lviews[lumps.LUMP_BRUSHSIDES], loadmodel);
    this._loadSubmodels(lviews[lumps.LUMP_MODELS], loadmodel);

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    debugger;

    return loadmodel;
  }
};


