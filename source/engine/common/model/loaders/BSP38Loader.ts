import { content } from '../../../../shared/Defs.ts';
import Q from '../../../../shared/Q.ts';
import Vector from '../../../../shared/Vector.ts';
import { CRC16CCITT } from '../../CRC.ts';
import { eventBus, getCommonRegistry, registry } from '../../../registry.ts';
import { Face, Plane } from '../BaseModel.ts';
import { Brush, BrushModel, BrushSide, Node, type BrushRange } from '../BSP.ts';
import type { PortalDefinition } from '../AreaPortals.ts';
import { QSMatLoader } from '../QSMatLoader.ts';
import { BSPXLoader } from '../BSPXLoader.ts';
import { WalTextureLoader } from '../WalTextureLoader.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { GLTexture } from '../../../client/GL.ts';
import { MaterialFlags, QuakeMaterial } from '../../../client/renderer/Materials.ts';

let { COM, Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con } = getCommonRegistry());
});

interface LumpViews {
  [index: number]: DataView;
}

interface LumpTable {
  readonly views: LumpViews;

  /** Byte offset just past the highest-ending lump, where an optional BSPX trailer may begin. */
  readonly bspxoffset: number;
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

/** Quake 2 `texinfo_t.flags` surface bits (bspflags.h). */
enum Q2SurfFlags {
  LIGHT = 0x1,
  SLICK = 0x2,
  SKY = 0x4,
  WARP = 0x8,
  TRANS33 = 0x10,
  TRANS66 = 0x20,
  FLOWING = 0x40,
  NODRAW = 0x80,
}

const BSP_MAGIC = 1347633737;
const BSP_VERSION = 38;

/**
 * Loader for Quake 2 BSP38 format (.bsp).
 */
export class BSP38Loader extends ModelLoader {
  /** Maximum coordinate used to seed brush bounds before clipping against axial planes. */
  static readonly #MAX_WORLD_COORD = 65536;

  /** `CONTENTS_CURRENT_0` through `CONTENTS_CURRENT_DOWN`; take priority over the base classification when set. */
  static readonly #currentContentBits: readonly number[] = [0x040000, 0x080000, 0x100000, 0x200000, 0x400000, 0x800000];

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

  override async load(buffer: ArrayBuffer, name: string): Promise<BrushModel> {
    const loadmodel = new BrushModel(name);

    loadmodel.version = BSP_VERSION;

    const { views: lumpViews, bspxoffset } = this.#loadLumps(buffer);

    this.#loadEntities(lumpViews[BSP38Lump.ENTITIES], loadmodel);
    this.#loadVertexes(lumpViews[BSP38Lump.VERTEXES], loadmodel);
    this.#loadEdges(lumpViews[BSP38Lump.EDGES], loadmodel);
    this.#loadSurfedges(lumpViews[BSP38Lump.SURFEDGES], loadmodel);
    this.#loadPlanes(lumpViews[BSP38Lump.PLANES], loadmodel);
    this.#loadTexinfo(lumpViews[BSP38Lump.TEXINFO], loadmodel);
    await this.#loadWalTextures(loadmodel); // must run before QSMatLoader, whose base-diffuse fallback checks for a decoded texture
    await QSMatLoader.load(loadmodel);
    this.#loadFaces(lumpViews[BSP38Lump.FACES], loadmodel);
    this.#loadMarksurfaces(lumpViews[BSP38Lump.LEAFFACES], loadmodel);
    this.#loadLighting(lumpViews[BSP38Lump.LIGHTING], loadmodel);
    this.#loadLeafs(lumpViews[BSP38Lump.LEAFS], loadmodel);
    this.#loadLeafBrushes(lumpViews[BSP38Lump.LEAFBRUSHES], loadmodel);
    this.#loadBrushes(lumpViews[BSP38Lump.BRUSHES], loadmodel);
    this.#loadBrushSides(lumpViews[BSP38Lump.BRUSHSIDES], loadmodel);
    this.#computeBrushBounds(loadmodel);
    this.#loadNodes(lumpViews[BSP38Lump.NODES], loadmodel);
    this.#loadVisibility(lumpViews[BSP38Lump.VISIBILITY], loadmodel);
    BSPXLoader.load(loadmodel, buffer, bspxoffset); // must run before submodels, which propagate the deluxemap
    this.#loadSubmodels(lumpViews[BSP38Lump.MODELS], loadmodel); // must run after nodes/brushes/leafbrushes are loaded
    this.#loadAreas(lumpViews[BSP38Lump.AREAS], lumpViews[BSP38Lump.AREAPORTALS], loadmodel);
    this.#parseExplicitPortalKeys(loadmodel); // explicit "portal" key overrides, mirrors BSP29Loader's escape hatch
    this.#computeModelPortalMap(loadmodel); // auto-derive from real area data for anything not explicitly overridden
    this.#calculateRadius(loadmodel);

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return loadmodel;
  }

  /**
   * Slice all BSP38 lumps into DataViews and locate the optional BSPX trailer,
   * which (unlike BSP29's scattered per-lump bookkeeping) can be derived in one
   * pass here since every lump offset/length is already read up front.
   * @returns Per-lump DataViews indexed by BSP38 lump number, plus the BSPX trailer offset.
   */
  #loadLumps(buffer: ArrayBuffer): LumpTable {
    const lumpViews: LumpViews = {};
    const view = new DataView(buffer);
    let bspxoffset = 0;

    for (let lumpIndex = BSP38Lump.ENTITIES; lumpIndex <= BSP38Lump.AREAPORTALS; lumpIndex++) {
      const offset = view.getUint32(8 + lumpIndex * 8, true);
      const length = view.getUint32(8 + lumpIndex * 8 + 4, true);
      lumpViews[lumpIndex] = new DataView(buffer, offset, length);
      bspxoffset = Math.max(bspxoffset, offset + length);
    }

    return { views: lumpViews, bspxoffset };
  }

  /**
   * Read a null-terminated string from a lump view.
   * @returns The decoded lump string.
   */
  #readString(dataView: DataView, offset = 0, length = dataView.byteLength - offset): string {
    return Q.memstr(new Uint8Array(dataView.buffer, dataView.byteOffset + offset, length));
  }

  /**
   * Load entity text from the BSP38 entities lump and parse the worldspawn
   * entity's key/values into `worldspawnInfo` (needed for `_qs_mat` and the
   * other `WorldspawnInfo` keys).
   */
  #loadEntities(entitiesLump: DataView, loadmodel: BrushModel): void {
    loadmodel.entities = this.#readString(entitiesLump, 0, entitiesLump.byteLength);
    loadmodel.worldspawnInfo = {};

    for (const currentEntity of COM.ParseEntityLump(loadmodel.entities)) {
      if (currentEntity.classname === 'worldspawn') {
        Object.assign(loadmodel.worldspawnInfo, currentEntity);
        break;
      }
    }
  }

  /**
   * Load vertex positions from the BSP38 vertexes lump.
   */
  #loadVertexes(vertexesLump: DataView, loadmodel: BrushModel): void {
    const stride = 12;
    const count = vertexesLump.byteLength / stride;
    loadmodel.vertexes.length = 0;

    for (let index = 0; index < count; index++) {
      const offset = index * stride;

      loadmodel.vertexes[index] = new Vector(
        vertexesLump.getFloat32(offset + 0, true),
        vertexesLump.getFloat32(offset + 4, true),
        vertexesLump.getFloat32(offset + 8, true),
      );
    }
  }

  /**
   * Load edge vertex-index pairs from the BSP38 edges lump.
   */
  #loadEdges(edgesLump: DataView, loadmodel: BrushModel): void {
    const stride = 4;
    const count = edgesLump.byteLength / stride;
    loadmodel.edges.length = 0;

    for (let index = 0; index < count; index++) {
      const offset = index * stride;
      loadmodel.edges[index] = [edgesLump.getUint16(offset, true), edgesLump.getUint16(offset + 2, true)];
    }
  }

  /**
   * Load surface edges (indices into the edges array, negative = reversed) from the BSP38 lump.
   */
  #loadSurfedges(surfedgesLump: DataView, loadmodel: BrushModel): void {
    const count = surfedgesLump.byteLength / 4;
    loadmodel.surfedges.length = 0;

    for (let index = 0; index < count; index++) {
      loadmodel.surfedges[index] = surfedgesLump.getInt32(index * 4, true);
    }
  }

  /**
   * Load BSP38 planes, including the type/signbits needed by BSP traversal and collision.
   */
  #loadPlanes(planesLump: DataView, loadmodel: BrushModel): void {
    loadmodel.planes.length = 0;

    const stride = 20;
    const count = planesLump.byteLength / stride;

    for (let index = 0; index < count; index++) {
      const offset = index * stride;

      const normal = new Vector(
        planesLump.getFloat32(offset + 0, true),
        planesLump.getFloat32(offset + 4, true),
        planesLump.getFloat32(offset + 8, true),
      );
      const dist = planesLump.getFloat32(offset + 12, true);

      const plane = new Plane(normal, dist);
      plane.type = planesLump.getInt32(offset + 16, true);

      if (normal[0] < 0) { plane.signbits |= 1; }
      if (normal[1] < 0) { plane.signbits |= 2; }
      if (normal[2] < 0) { plane.signbits |= 4; }

      loadmodel.planes[index] = plane;
    }
  }

  /**
   * Translate Quake 2 SURF_* texinfo flags to the engine's renderer-facing MaterialFlags.
   * @returns Combined MaterialFlags bits.
   */
  static #translateSurfaceFlags(q2Flags: number): MaterialFlags {
    let flags = MaterialFlags.MF_NONE;

    if (q2Flags & Q2SurfFlags.SKY) {
      flags |= MaterialFlags.MF_SKY;
    }

    if (q2Flags & Q2SurfFlags.WARP) {
      flags |= MaterialFlags.MF_TURBULENT;
    }

    if (q2Flags & (Q2SurfFlags.TRANS33 | Q2SurfFlags.TRANS66)) {
      flags |= MaterialFlags.MF_TRANSPARENT;
    }

    if (q2Flags & Q2SurfFlags.NODRAW) {
      flags |= MaterialFlags.MF_SKIP;
    }

    return flags;
  }

  /**
   * Load BSP38 texinfo entries and register one placeholder material per
   * distinct texture name (`loadmodel.textures`), resolving each texinfo's
   * texture name to a numeric index the same way BSP29/BSP2 index their
   * miptex array. `#loadWalTextures` fills in real pixel data for these
   * placeholders afterwards, and `QSMatLoader` may replace them with real
   * `PBRMaterial`s on top of that, both matched by name.
   */
  #loadTexinfo(texinfoLump: DataView, loadmodel: BrushModel): void {
    loadmodel.texinfo.length = 0;

    const stride = 76;
    const count = texinfoLump.byteLength / stride;
    const textureIndexByName: Record<string, number> = {};

    for (let index = 0; index < count; index++) {
      const offset = index * stride;
      const flags = texinfoLump.getInt32(offset + 32, true);
      const textureName = this.#readString(texinfoLump, offset + 40, 32);

      let textureIndex = textureIndexByName[textureName];

      if (textureIndex === undefined) {
        textureIndex = loadmodel.textures.length;
        textureIndexByName[textureName] = textureIndex;
        loadmodel.textures.push(new QuakeMaterial(textureName, 1, 1));
      }

      loadmodel.textures[textureIndex].flags |= BSP38Loader.#translateSurfaceFlags(flags);

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
        flags,
        value: texinfoLump.getInt32(offset + 36, true),
        texture: textureIndex,
        nexttexinfo: texinfoLump.getInt32(offset + 72, true),
      });
    }
  }

  /**
   * Load real `.wal` pixel data for each placeholder texture registered by
   * `#loadTexinfo`, matched by name. `.wal` files live standalone under
   * `textures/<name>.wal` (unlike Q1 miptex, which is embedded in the BSP
   * itself), so this needs its own file load per texture. Missing files are
   * expected and skipped silently (dev-only textures like `skip`/`clip`/
   * `trigger` never have real art), leaving that material as an untextured
   * placeholder — the same fallback behavior as before this method existed.
   *
   * Opt-in via the worldspawn `_qs_wal` key (see `WorldspawnInfo`): a map
   * fully covered by qsmat has no use for `.wal` data, and firing off a
   * `textures/<name>.wal` load per distinct texture regardless would mean a
   * request per texture, almost all guaranteed to fail.
   */
  async #loadWalTextures(loadmodel: BrushModel): Promise<void> {
    if (registry.isDedicatedServer || loadmodel.worldspawnInfo._qs_wal !== '1') {
      return;
    }

    await Promise.all(loadmodel.textures.map(async (material) => {
      if (!(material instanceof QuakeMaterial)) {
        return;
      }

      const filename = `textures/${material.name}.wal`;
      const data = await COM.LoadFile(filename);

      if (data === null) {
        return;
      }

      const decoded = WalTextureLoader.decode(data, material.name);

      if (decoded === null) {
        Con.PrintWarning(`BSP38Loader: corrupt .wal texture ${filename}\n`);
        return;
      }

      const textureId = `${material.name}/${CRC16CCITT.Block(new Uint8Array(data))}`;
      material.texture = GLTexture.Allocate(textureId, decoded.width, decoded.height, decoded.data);
      material.width = decoded.width;
      material.height = decoded.height;
    }));
  }

  /**
   * Load faces (surfaces) from the BSP38 lump and derive oriented face normals.
   * Mirrors BSP29Loader's texturemins/extents math; turbulent/sky classification
   * comes from the texinfo SURF_WARP/SURF_SKY bits rather than a shared texture flag,
   * since Q2 surface flags are per-texinfo rather than per-texture.
   */
  #loadFaces(facesLump: DataView, loadmodel: BrushModel): void {
    const stride = 20;
    const count = facesLump.byteLength / stride;

    const lmshift = loadmodel.worldspawnInfo._lightmap_scale ? Math.log2(parseInt(loadmodel.worldspawnInfo._lightmap_scale, 10)) : 4;

    loadmodel.firstface = 0;
    loadmodel.numfaces = count;
    loadmodel.faces.length = 0;

    for (let index = 0; index < count; index++) {
      const offset = index * stride;
      const styles = new Uint8Array(facesLump.buffer, facesLump.byteOffset + offset + 12, 4);
      const texinfoIndex = facesLump.getInt16(offset + 10, true);
      const tex = loadmodel.texinfo[texinfoIndex];

      // Q2's dface_t.lightofs is a byte offset directly into the (always RGB)
      // LIGHTING lump, unlike BSP29/BSP2 where lightofs is a sample count into
      // the mono lump and the renderer derives the RGB byte offset itself via
      // `* 3`/`* channels` (BSPX RGB extension convention). Normalize here by
      // dividing out the 3 so `Face.lightofs` means "sample count" uniformly
      // across every BSP format, matching what BuildLightMapEx/RecursiveLightPoint
      // already assume. -1 (no lightmap / fullbright) must pass through unchanged.
      const rawLightofs = facesLump.getInt32(offset + 16, true);
      console.assert(rawLightofs < 0 || rawLightofs % 3 === 0, 'BSP38Loader: expected lightofs to be a multiple of 3 (RGB byte offset)');
      const lightofs = rawLightofs >= 0 ? rawLightofs / 3 : rawLightofs;

      const face = Object.assign(new Face(), {
        plane: loadmodel.planes[facesLump.getUint16(offset + 0, true)],
        planeBack: facesLump.getInt16(offset + 2, true) !== 0,
        firstedge: facesLump.getInt32(offset + 4, true),
        numedges: facesLump.getUint16(offset + 8, true),
        texinfo: texinfoIndex,
        lightofs,
        lmshift,
        texture: tex.texture as number,
      });

      for (let j = 0; j < 4; j++) {
        if (styles[j] !== 255) {
          face.styles[j] = styles[j];
        }
      }

      const mins = [Infinity, Infinity];
      const maxs = [-Infinity, -Infinity];

      for (let j = 0; j < face.numedges; j++) {
        const e = loadmodel.surfedges[face.firstedge + j];
        const v = e >= 0
          ? loadmodel.vertexes[loadmodel.edges[e][0]]
          : loadmodel.vertexes[loadmodel.edges[-e][1]];

        const val0 = v.dot(new Vector(tex.vecs[0][0], tex.vecs[0][1], tex.vecs[0][2])) + tex.vecs[0][3];
        const val1 = v.dot(new Vector(tex.vecs[1][0], tex.vecs[1][1], tex.vecs[1][2])) + tex.vecs[1][3];

        if (val0 < mins[0]) {
          mins[0] = val0;
        }

        if (val0 > maxs[0]) {
          maxs[0] = val0;
        }

        if (val1 < mins[1]) {
          mins[1] = val1;
        }

        if (val1 > maxs[1]) {
          maxs[1] = val1;
        }
      }

      const lmscale = 1 << face.lmshift!;
      face.texturemins = [Math.floor(mins[0] / lmscale) * lmscale, Math.floor(mins[1] / lmscale) * lmscale];
      face.extents = [Math.ceil(maxs[0] / lmscale) * lmscale - face.texturemins[0], Math.ceil(maxs[1] / lmscale) * lmscale - face.texturemins[1]];

      if (tex.flags & Q2SurfFlags.WARP) {
        face.turbulent = true;
      } else if (tex.flags & Q2SurfFlags.SKY) {
        face.sky = true;
      }

      face.normal.set(face.plane!.normal);
      if (face.planeBack) {
        face.normal.multiply(-1.0);
      }

      loadmodel.faces[index] = face;
    }
  }

  /**
   * Load marksurfaces (face indices visible from each leaf) from the BSP38 leaffaces lump.
   */
  #loadMarksurfaces(leaffacesLump: DataView, loadmodel: BrushModel): void {
    const count = leaffacesLump.byteLength / 2;
    loadmodel.marksurfaces.length = 0;

    for (let index = 0; index < count; index++) {
      loadmodel.marksurfaces[index] = leaffacesLump.getUint16(index * 2, true);
    }
  }

  /**
   * Load native RGB lightmap samples from the BSP38 lighting lump.
   * Unlike BSP29, Q2 lightmaps are always RGB24 — there is no separate
   * greyscale/BSPX-RGB distinction to make.
   */
  #loadLighting(lightingLump: DataView, loadmodel: BrushModel): void {
    if (lightingLump.byteLength === 0) {
      loadmodel.lightdata_rgb = null;
      return;
    }

    loadmodel.lightdata_rgb = new Uint8Array(lightingLump.buffer, lightingLump.byteOffset, lightingLump.byteLength);
    loadmodel.coloredlights = true;
  }

  /**
   * Translate Quake 2 brush/leaf contents to Quake contents constants.
   * Q2 contents are a bitmask (e.g. CONTENTS_SOLID combined with CONTENTS_DETAIL
   * or a CONTENTS_CURRENT_* flow direction), so this decomposes known bits
   * rather than requiring an exact match on the combined value.
   * @returns The translated Quake contents constant.
   */
  #translateQ2Contents(q2Contents: number): number {
    for (const currentBit of BSP38Loader.#currentContentBits) {
      if ((q2Contents & currentBit) !== 0) {
        return BSP38Loader.#contentsMap[currentBit];
      }
    }

    const classification = q2Contents & 0x7f;

    if (classification in BSP38Loader.#contentsMap) {
      return BSP38Loader.#contentsMap[classification];
    }

    return content.CONTENT_EMPTY;
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

      const leaf = Object.assign(new Node(loadmodel), {
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
      });

      leaf.baseMins = leaf.mins!.copy();
      leaf.baseMaxs = leaf.maxs!.copy();
      loadmodel.leafs[index] = leaf;
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
   * Compute each brush's AABB from its axial side planes.
   * Real compiled Q2 brushes always carry explicit axial bevel planes (added
   * by qbsp during CSG so box-sweep collision works against any brush shape),
   * in addition to their visible faces, so the AABB can be read directly off
   * those sides without needing clipping math.
   */
  #computeBrushBounds(loadmodel: BrushModel): void {
    if (loadmodel.brushes === null) {
      return;
    }

    const boundary = BSP38Loader.#MAX_WORLD_COORD;

    for (const brush of loadmodel.brushes) {
      const mins = new Vector(-boundary, -boundary, -boundary);
      const maxs = new Vector(boundary, boundary, boundary);

      for (const side of brush.sidesIter()) {
        const plane = loadmodel.planes[side.planenum];

        if (plane.type > 2) {
          continue;
        }

        const axis = plane.type;

        if (plane.normal[axis] > 0) {
          maxs[axis] = Math.min(maxs[axis], plane.dist);
        } else {
          mins[axis] = Math.max(mins[axis], -plane.dist);
        }
      }

      brush.mins = mins;
      brush.maxs = maxs;
    }
  }

  /**
   * Recursively set parent references for BSP tree nodes.
   */
  #setParent(node: Node, parent: Node | null): void {
    node.parent = parent;

    if (node.contents < content.CONTENT_NONE) {
      return;
    }

    this.#setParent(node.children[0] as Node, node);
    this.#setParent(node.children[1] as Node, node);
  }

  /**
   * Load BSP38 tree nodes and link them to their plane and child leaf/node references.
   * Q2 node children are 32-bit indices (unlike BSP29's 16-bit ones), since Q2 maps
   * can exceed the ~32k node limit that constrained Quake 1.
   */
  #loadNodes(nodesLump: DataView, loadmodel: BrushModel): void {
    const stride = 28;
    const count = nodesLump.byteLength / stride;
    loadmodel.nodes.length = 0;

    for (let index = 0; index < count; index++) {
      const offset = index * stride;

      const node = Object.assign(new Node(loadmodel), {
        num: index,
        planenum: nodesLump.getInt32(offset + 0, true),
        children: [nodesLump.getInt32(offset + 4, true), nodesLump.getInt32(offset + 8, true)],
        mins: new Vector(
          nodesLump.getInt16(offset + 12, true),
          nodesLump.getInt16(offset + 14, true),
          nodesLump.getInt16(offset + 16, true),
        ),
        maxs: new Vector(
          nodesLump.getInt16(offset + 18, true),
          nodesLump.getInt16(offset + 20, true),
          nodesLump.getInt16(offset + 22, true),
        ),
        firstface: nodesLump.getUint16(offset + 24, true),
        numfaces: nodesLump.getUint16(offset + 26, true),
      });

      node.baseMins = node.mins!.copy();
      node.baseMaxs = node.maxs!.copy();
      loadmodel.nodes[index] = node;
    }

    for (let index = 0; index < count; index++) {
      const node = loadmodel.nodes[index];
      node.plane = loadmodel.planes[node.planenum];

      const child0Idx = node.children[0] as number;
      const child1Idx = node.children[1] as number;

      node.children[0] = child0Idx >= 0 ? loadmodel.nodes[child0Idx] : loadmodel.leafs[-1 - child0Idx];
      node.children[1] = child1Idx >= 0 ? loadmodel.nodes[child1Idx] : loadmodel.leafs[-1 - child1Idx];
    }

    if (loadmodel.nodes.length > 0) {
      this.#setParent(loadmodel.nodes[0], null);
    }
  }

  /**
   * Load native PVS/PHS visibility data from the BSP38 visibility lump.
   * Unlike BSP29 (which only stores PVS and needs a transitive-closure PHS
   * approximation), Q2's dvis_t already stores both PVS and PHS bit rows per
   * cluster directly.
   */
  #loadVisibility(visLump: DataView, loadmodel: BrushModel): void {
    if (visLump.byteLength < 4) {
      loadmodel.numclusters = 0;
      loadmodel.visdata = null;
      loadmodel.phsdata = null;
      loadmodel.clusterPvsOffsets = null;
      loadmodel.clusterPhsOffsets = null;
      return;
    }

    const numclusters = visLump.getInt32(0, true);
    const raw = new Uint8Array(visLump.buffer, visLump.byteOffset, visLump.byteLength);

    const clusterPvsOffsets: number[] = new Array(numclusters);
    const clusterPhsOffsets: number[] = new Array(numclusters);

    for (let cluster = 0; cluster < numclusters; cluster++) {
      clusterPvsOffsets[cluster] = visLump.getInt32(4 + cluster * 8, true);
      clusterPhsOffsets[cluster] = visLump.getInt32(4 + cluster * 8 + 4, true);
    }

    loadmodel.numclusters = numclusters;
    loadmodel.visdata = raw;
    loadmodel.phsdata = raw;
    loadmodel.clusterPvsOffsets = clusterPvsOffsets;
    loadmodel.clusterPhsOffsets = clusterPhsOffsets;
  }

  /**
   * Derive a submodel's brush range for `BrushTrace`'s brute-force submodel
   * collision path. Q2's MODELS lump gives each inline model its own headnode
   * but no direct brush range, unlike Q1's BSPX BRUSHLIST extension. Real qbsp
   * output emits each entity's brushes contiguously, so walking the headnode
   * subtree's leafs and taking the min/max referenced brush index reconstructs
   * the same kind of contiguous range BSP29Loader gets natively from BRUSHLIST.
   * @returns The submodel's brush range, or an empty range when none is found.
   */
  #computeSubmodelBrushRange(loadmodel: BrushModel, headnode: number): BrushRange {
    const rootNode = loadmodel.nodes[headnode];

    if (rootNode === undefined || loadmodel.leafbrushes === null) {
      return { firstBrush: 0, numBrushes: 0 };
    }

    let minBrush = Infinity;
    let maxBrush = -Infinity;
    const brushIndices = new Set<number>();
    const stack: Node[] = [rootNode];

    while (stack.length > 0) {
      const node = stack.pop()!;

      if (node.contents < content.CONTENT_NONE) {
        for (let i = 0; i < node.numleafbrushes; i++) {
          const brushIndex = loadmodel.leafbrushes[node.firstleafbrush + i];
          brushIndices.add(brushIndex);
          minBrush = Math.min(minBrush, brushIndex);
          maxBrush = Math.max(maxBrush, brushIndex);
        }
        continue;
      }

      stack.push(node.children[0] as Node, node.children[1] as Node);
    }

    if (brushIndices.size === 0) {
      return { firstBrush: 0, numBrushes: 0 };
    }

    const numBrushes = maxBrush - minBrush + 1;
    console.assert(brushIndices.size === numBrushes, `BSP38Loader: submodel brush indices under headnode ${headnode} are not contiguous`);

    return { firstBrush: minBrush, numBrushes };
  }

  /**
   * Load submodels (inline brush models for doors, plats, triggers, etc.)
   * from the BSP38 models lump.
   */
  #loadSubmodels(modelsLump: DataView, loadmodel: BrushModel): void {
    const stride = 48;
    const count = modelsLump.byteLength / stride;
    loadmodel.submodels.length = 0;

    if (count === 0) {
      return;
    }

    loadmodel.mins.setTo(
      modelsLump.getFloat32(0, true) - 1.0,
      modelsLump.getFloat32(4, true) - 1.0,
      modelsLump.getFloat32(8, true) - 1.0,
    );
    loadmodel.maxs.setTo(
      modelsLump.getFloat32(12, true) + 1.0,
      modelsLump.getFloat32(16, true) + 1.0,
      modelsLump.getFloat32(20, true) + 1.0,
    );

    for (let index = 1; index < count; index++) {
      const offset = index * stride;
      const out = new BrushModel(`*${index}`);
      out.submodel = true;

      out.mins.setTo(
        modelsLump.getFloat32(offset + 0, true) - 1.0,
        modelsLump.getFloat32(offset + 4, true) - 1.0,
        modelsLump.getFloat32(offset + 8, true) - 1.0,
      );
      out.maxs.setTo(
        modelsLump.getFloat32(offset + 12, true) + 1.0,
        modelsLump.getFloat32(offset + 16, true) + 1.0,
        modelsLump.getFloat32(offset + 20, true) + 1.0,
      );
      out.origin.setTo(
        modelsLump.getFloat32(offset + 24, true),
        modelsLump.getFloat32(offset + 28, true),
        modelsLump.getFloat32(offset + 32, true),
      );

      const headnode = modelsLump.getInt32(offset + 36, true);

      out.vertexes = loadmodel.vertexes;
      out.edges = loadmodel.edges;
      out.surfedges = loadmodel.surfedges;
      out.nodes = loadmodel.nodes;
      out.leafs = loadmodel.leafs;
      out.texinfo = loadmodel.texinfo;
      out.textures = loadmodel.textures;
      out.marksurfaces = loadmodel.marksurfaces;
      out.lightdata_rgb = loadmodel.lightdata_rgb;
      out.deluxemap = loadmodel.deluxemap;
      out.faces = loadmodel.faces;
      out.visdata = loadmodel.visdata;
      out.numclusters = loadmodel.numclusters;
      out.clusterPvsOffsets = loadmodel.clusterPvsOffsets;
      out.phsdata = loadmodel.phsdata;
      out.clusterPhsOffsets = loadmodel.clusterPhsOffsets;
      out.coloredlights = loadmodel.coloredlights;
      out.worldspawnInfo = loadmodel.worldspawnInfo;

      out.firstface = modelsLump.getInt32(offset + 40, true);
      out.numfaces = modelsLump.getInt32(offset + 44, true);

      if (loadmodel.hasBrushData) {
        out.planes = loadmodel.planes;
        out.brushes = loadmodel.brushes;
        out.brushsides = loadmodel.brushsides;
        out.leafbrushes = loadmodel.leafbrushes;

        const range = this.#computeSubmodelBrushRange(loadmodel, headnode);
        out.firstBrush = range.firstBrush;
        out.numBrushes = range.numBrushes;
      }

      for (let j = 0; j < out.numfaces; j++) {
        loadmodel.faces[out.firstface + j].submodel = true;
      }

      loadmodel.submodels[index - 1] = out;
    }
  }

  /**
   * Load native area/areaportal connectivity from the BSP38 areas and
   * areaportals lumps. Unlike BSP29 (which has to synthesize approximate
   * areas from door bounding boxes and PHS sampling), Q2 stores real area
   * and portal data directly, so this is a straight translation.
   */
  #loadAreas(areasLump: DataView, areaportalsLump: DataView, loadmodel: BrushModel): void {
    const areaStride = 8;
    const numAreas = areasLump.byteLength / areaStride;
    loadmodel.numAreas = numAreas;

    const portalDefs: PortalDefinition[] = [];
    const seen = new Set<string>();

    for (let area = 1; area < numAreas; area++) {
      const offset = area * areaStride;
      const numareaportals = areasLump.getInt32(offset + 0, true);
      const firstareaportal = areasLump.getInt32(offset + 4, true);

      for (let i = 0; i < numareaportals; i++) {
        const apOffset = (firstareaportal + i) * 8;
        const portalnum = areaportalsLump.getInt32(apOffset + 0, true);
        const otherarea = areaportalsLump.getInt32(apOffset + 4, true);

        // Each physical portal is listed once per area it connects (from
        // both sides), so dedupe on the unordered area pair + portal number.
        const key = `${Math.min(area, otherarea)}-${Math.max(area, otherarea)}-${portalnum}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        portalDefs.push({ area0: area, area1: otherarea, group: portalnum });
      }
    }

    loadmodel.portalDefs = portalDefs;
    loadmodel.areaPortals.init(numAreas, portalDefs);

    Con.DPrint(`BSP38Loader: loaded ${numAreas} areas with ${portalDefs.length} portal connections\n`);
  }

  /**
   * Parse explicit "portal" key overrides from brush entities, mirroring
   * BSP29Loader's `#parsePortalEntities` escape hatch. Takes priority over
   * `#computeModelPortalMap`'s automatic derivation, for cases the geometric
   * heuristic can't resolve on its own (e.g. a door touching more than two
   * areas at a T-junction).
   */
  #parseExplicitPortalKeys(loadmodel: BrushModel): void {
    for (const ent of COM.ParseEntityLump(loadmodel.entities)) {
      if (ent.model === undefined || ent.portal === undefined) {
        continue;
      }

      const portalNum = parseInt(ent.portal, 10);

      if (!isNaN(portalNum) && portalNum >= 0) {
        loadmodel.modelPortalMap[ent.model] = portalNum;
      }
    }
  }

  /**
   * Recursively collect the set of leaf areas touched by an AABB, descending
   * the world BSP tree via plane classification only (never a raw leaf-bounds
   * comparison) — the same technique `ServerArea.findTouchedLeafs` uses for
   * entity-leaf linking.
   */
  #collectTouchedAreas(node: Node, mins: Vector, maxs: Vector, areas: Set<number>): void {
    if (node.contents === content.CONTENT_SOLID) {
      return;
    }

    if (node.contents < content.CONTENT_NONE) {
      areas.add(node.area);
      return;
    }

    const sides = Vector.boxOnPlaneSide(mins, maxs, node.plane!);

    if ((sides & 1) !== 0) {
      this.#collectTouchedAreas(node.children[0] as Node, mins, maxs, areas);
    }

    if ((sides & 2) !== 0) {
      this.#collectTouchedAreas(node.children[1] as Node, mins, maxs, areas);
    }
  }

  /**
   * Auto-derive `modelPortalMap` for submodels not already covered by an
   * explicit "portal" key. Unlike BSP29Loader's synthetic door-bbox/PVS-gap
   * heuristic, BSP38's area data is exact, so this only needs to find which
   * two real areas a submodel's own bounding box touches — its brush occupies
   * the same doorway gap the compiled CONTENTS_AREAPORTAL brush does, by
   * normal Q2 mapping convention — and match that pair against the
   * already-parsed `portalDefs`. Requires no mapper cooperation beyond that
   * normal convention: no "func_areaportal" entity lookup or target/targetname
   * linkage needed, since real BSP38 area data is exact rather than
   * synthesized.
   */
  #computeModelPortalMap(loadmodel: BrushModel): void {
    if (loadmodel.nodes.length === 0 || loadmodel.portalDefs.length === 0) {
      return;
    }

    const root = loadmodel.nodes[0];
    let derived = 0;

    for (let index = 0; index < loadmodel.submodels.length; index++) {
      const modelName = `*${index + 1}`;

      if (loadmodel.modelPortalMap[modelName] !== undefined) {
        continue;
      }

      const submodel = loadmodel.submodels[index];
      console.assert(submodel.mins !== null && submodel.maxs !== null, 'BSP38Loader: submodel bounds required for portal derivation');

      const areas = new Set<number>();
      this.#collectTouchedAreas(root, submodel.mins!, submodel.maxs!, areas);
      areas.delete(0); // area 0 = outside/unassigned, never a real portal side

      if (areas.size !== 2) {
        continue;
      }

      const [area0, area1] = [...areas];
      const portal = loadmodel.portalDefs.find((p) =>
        (p.area0 === area0 && p.area1 === area1) || (p.area0 === area1 && p.area1 === area0));

      if (portal?.group === undefined) {
        continue;
      }

      loadmodel.modelPortalMap[modelName] = portal.group;
      derived++;
    }

    if (derived > 0) {
      Con.DPrint(`BSP38Loader: auto-derived ${derived} model-to-portal mapping(s) from area data\n`);
    }
  }

  /**
   * Calculate the bounding radius used for frustum culling.
   */
  #calculateRadius(loadmodel: BrushModel): void {
    const mins = new Vector();
    const maxs = new Vector();

    for (let index = 0; index < loadmodel.vertexes.length; index++) {
      const vert = loadmodel.vertexes[index];

      if (vert[0] < mins[0]) {
        mins[0] = vert[0];
      } else if (vert[0] > maxs[0]) {
        maxs[0] = vert[0];
      }

      if (vert[1] < mins[1]) {
        mins[1] = vert[1];
      } else if (vert[1] > maxs[1]) {
        maxs[1] = vert[1];
      }

      if (vert[2] < mins[2]) {
        mins[2] = vert[2];
      } else if (vert[2] > maxs[2]) {
        maxs[2] = vert[2];
      }
    }

    loadmodel.radius = (new Vector(
      Math.abs(mins[0]) > Math.abs(maxs[0]) ? Math.abs(mins[0]) : Math.abs(maxs[0]),
      Math.abs(mins[1]) > Math.abs(maxs[1]) ? Math.abs(mins[1]) : Math.abs(maxs[1]),
      Math.abs(mins[2]) > Math.abs(maxs[2]) ? Math.abs(mins[2]) : Math.abs(maxs[2]),
    )).len();
  }
}
