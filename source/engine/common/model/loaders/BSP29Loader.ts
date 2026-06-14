import Vector from '../../../../shared/Vector.ts';
import Q from '../../../../shared/Q.ts';
import { content } from '../../../../shared/Defs.ts';
import { GLTexture } from '../../../client/GL.ts';
import W, { readWad3Texture, translateIndexToLuminanceRGBA, translateIndexToRGBA } from '../../W.ts';
import { CRC16CCITT } from '../../CRC.ts';
import { CorruptedResourceError } from '../../Errors.ts';
import { eventBus, getCommonRegistry, registry } from '../../../registry.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { Brush, BrushModel, BrushSide, Node, type BSPXLumps, type BrushTexInfo, type Clipnode, type Hull, type LightgridLeaf, type LightgridNode, type LightgridPointSample, type LightgridStyleSample } from '../BSP.ts';
import { Face, Plane } from '../BaseModel.ts';
import { MaterialFlags, noTextureMaterial, PBRMaterial, QuakeMaterial } from '../../../client/renderer/Materials.ts';
import { Quake1Sky, SimpleSkyBox } from '../../../client/renderer/Sky.ts';

// Get registry references (will be set by eventBus)
let { COM, Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con } = getCommonRegistry());
});

interface AllowedClipnodeHull extends Hull {
  allowedClipNodes?: Uint8Array | null;
}

interface MaterialDefinition {
  readonly diffuse?: string;
  readonly luminance?: string;
  readonly specular?: string;
  readonly normal?: string;
  readonly flags?: string[];
}

interface MaterialFile {
  readonly version: number;
  readonly materials: Record<string, MaterialDefinition>;
}

type MaterialTextureCategory = 'luminance' | 'diffuse' | 'specular' | 'normal';

/**
 * Helper function to get a child node from a BSP node, with type assertion.
 * @returns The child node at the specified index.
 */
function getNodeChild(node: Node, childIndex: 0 | 1): Node {
  const child = node.children[childIndex];
  console.assert(child instanceof Node, 'BSP29Loader expected linked BSP child node');
  return child as Node;
}

/**
 * Loader for Quake BSP29 format (.bsp)
 * It supports vanilla BSP29 and a few BSPX extensions (such as lightgrid, RGB lighting).
 */
export class BSP29Loader extends ModelLoader {
  /** BSP29 lump indices. */
  static readonly #lump = Object.freeze({
    entities: 0,
    planes: 1,
    textures: 2,
    vertexes: 3,
    visibility: 4,
    nodes: 5,
    texinfo: 6,
    faces: 7,
    lighting: 8,
    clipnodes: 9,
    leafs: 10,
    marksurfaces: 11,
    edges: 12,
    surfedges: 13,
    models: 14,
  });

  override getMagicNumbers(): number[] {
    return [29]; // BSP version 29
  }

  override getExtensions(): string[] {
    return ['.bsp'];
  }

  override getName(): string {
    return 'Quake BSP29';
  }

  /**
   * Load a BSP29 map model from buffer.
   * @returns The loaded brush model.
   */
  override async load(buffer: ArrayBuffer, name: string): Promise<BrushModel> {
    const loadmodel = new BrushModel(name);

    loadmodel.version = (new DataView(buffer)).getUint32(0, true) as 29 | 844124994;
    loadmodel.bspxoffset = 0;

    // Load all BSP lumps
    this.#loadEntities(loadmodel, buffer);
    this.#loadVertexes(loadmodel, buffer);
    this._loadEdges(loadmodel, buffer);
    this.#loadSurfedges(loadmodel, buffer);
    this.#loadTextures(loadmodel, buffer);
    await this.#loadMaterials(loadmodel);
    this.#loadLighting(loadmodel, buffer);
    this.#loadPlanes(loadmodel, buffer);
    this.#loadTexinfo(loadmodel, buffer);
    this._loadFaces(loadmodel, buffer);
    this._loadMarksurfaces(loadmodel, buffer);
    this.#loadVisibility(loadmodel, buffer);
    this._loadLeafs(loadmodel, buffer);
    this.#buildClusterData(loadmodel);
    this._loadNodes(loadmodel, buffer);
    this._loadClipnodes(loadmodel, buffer);
    this.#makeHull0(loadmodel);
    this.#loadBSPX(loadmodel, buffer);
    this._loadBrushList(loadmodel, buffer);
    this.#loadLightingRGB(loadmodel, buffer);
    this.#loadDeluxeMap(loadmodel, buffer);
    this.#loadLightgridOctree(loadmodel, buffer);
    this.#loadSubmodels(loadmodel, buffer); // CR: must be last, since it creates additional models based on this one
    this.#parseFogVolumes(loadmodel); // must be after submodels load so we can scan submodel faces
    this.#computeAreas(loadmodel);

    if (loadmodel.coloredlights && !loadmodel.lightdata_rgb) {
      await this.#loadExternalLighting(loadmodel, name);
    }

    await this.#loadSkybox(loadmodel);

    // Calculate bounding radius
    this.#calculateRadius(loadmodel);

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return loadmodel;
  }

  async #loadSkybox(loadmodel: BrushModel): Promise<void> {
    if (registry.isDedicatedServer) {
      return;
    }

    const skyname = loadmodel.worldspawnInfo.skyname;

    if (!skyname) {
      return;
    }

    const [front, back, left, right, up, down] = await Promise.all([
      GLTexture.FromImageFile(`gfx/env/${skyname}ft.png`),
      GLTexture.FromImageFile(`gfx/env/${skyname}bk.png`),
      GLTexture.FromImageFile(`gfx/env/${skyname}lf.png`),
      GLTexture.FromImageFile(`gfx/env/${skyname}rt.png`),
      GLTexture.FromImageFile(`gfx/env/${skyname}up.png`),
      GLTexture.FromImageFile(`gfx/env/${skyname}dn.png`),
    ]);

    if (front === null || back === null || left === null || right === null || up === null || down === null) {
      return;
    }

    // CR: unholy yet convenient hack to pass sky texture data to SkyRenderer
    loadmodel.newSkyRenderer = function () {
      const skyrenderer = new SimpleSkyBox(this);
      skyrenderer.setSkyTextures(front, back, left, right, up, down);
      return skyrenderer;
    };
  }

  /**
   * Calculate the bounding radius of the model from its vertices.
   */
  #calculateRadius(loadmodel: BrushModel): void {
    const mins = new Vector();
    const maxs = new Vector();

    for (let i = 0; i < loadmodel.vertexes.length; i++) {
      const vert = loadmodel.vertexes[i];

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

  /**
   * Load texture information and create GL textures from BSP texture lump.
   */
  #loadTextures(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.textures << 3) + 4, true);
    const filelen = view.getUint32((lump.textures << 3) + 8, true);
    loadmodel.textures.length = 0;
    const nummiptex = view.getUint32(fileofs, true);
    let dataofs = fileofs + 4;

    const materials: Record<string, QuakeMaterial> = {};

    for (let i = 0; i < nummiptex; i++) {
      const miptexofs = view.getInt32(dataofs, true);
      dataofs += 4;
      if (miptexofs === -1) {
        loadmodel.textures[i] = noTextureMaterial;
        continue;
      }
      const absofs = miptexofs + fileofs;

      const name = Q.memstr(new Uint8Array(buf, absofs, 16));
      const cleanName = name.replace(/^\+[0-9a-j]/, ''); // no anim prefix

      if (!materials[cleanName]) {
        materials[cleanName] = new QuakeMaterial(name, view.getUint32(absofs + 16, true), view.getUint32(absofs + 20, true));
      }

      const tx = materials[cleanName];

      let glt = null;
      let luminanceTexture = null;

      // Load texture data (skip for dedicated server)
      if (!registry.isDedicatedServer) {
        if (tx.name.substring(0, 3).toLowerCase() === 'sky') {
          const skyTexture = new Uint8Array(buf, absofs + view.getUint32(absofs + 24, true), 32768);

          // CR: unholy yet convenient hack to pass sky texture data to SkyRenderer
          loadmodel.newSkyRenderer = function () {
            const skyrenderer = new Quake1Sky(this);
            skyrenderer.setSkyTexture(skyTexture);
            return skyrenderer;
          };

          tx.flags |= MaterialFlags.MF_SKY;
        } else {
          // Try loading WAD3 texture
          const len = 40 + tx.width * tx.height * (1 + 0.25 + 0.0625 + 0.015625) + 2 + 768;
          if (absofs + len - 2 - 768 < buf.byteLength) {
            const magic = view.getInt16(absofs + len - 2 - 768, true);
            if (magic === 256) {
              const data = new ArrayBuffer(len);
              new Uint8Array(data).set(new Uint8Array(buf, absofs, len));
              const wtex = readWad3Texture(data, tx.name, 0);
              glt = GLTexture.FromLumpTexture(wtex);
              const wadLuminance = BSP29Loader.#createWadLuminanceTexture(data, tx.name, tx.width, tx.height);
              if (wadLuminance !== null) {
                luminanceTexture = wadLuminance;
              }
              tx.averageColor = BSP29Loader.#computeAverageColor(wtex.data);
            }
          }
        }

        if (!glt) {
          const pixelData = new Uint8Array(buf, absofs + view.getUint32(absofs + 24, true), tx.width * tx.height);
          const rgba = translateIndexToRGBA(pixelData, tx.width, tx.height, W.d_8to24table_u8, tx.name[0] === '{' ? 255 : null, 240);
          const textureId = `${tx.name}/${CRC16CCITT.Block(pixelData)}`; // CR: unique texture ID to avoid conflicts across maps
          glt = GLTexture.Allocate(textureId, tx.width, tx.height, rgba);
          const luminanceRGBA = translateIndexToLuminanceRGBA(pixelData, tx.width, tx.height, W.d_8to24table_u8, tx.name[0] === '{' ? 255 : null, 240);
          if (BSP29Loader.#hasVisiblePixels(luminanceRGBA)) {
            luminanceTexture = GLTexture.Allocate(`${textureId}:luminance`, tx.width, tx.height, luminanceRGBA);
          }
          tx.averageColor = BSP29Loader.#computeAverageColor(rgba);
        }

        if (tx.name[0] === '*' || tx.name[0] === '!') {
          tx.flags |= MaterialFlags.MF_TURBULENT;
        }

        // Mark textures with '{' prefix as transparent (for alpha blending)
        if (tx.name[0] === '{') {
          tx.flags |= MaterialFlags.MF_TRANSPARENT;
        }

        if (tx.name.toLowerCase().startsWith('*lava')) {
          tx.flags |= MaterialFlags.MF_FULLBRIGHT;
        }
      }

      if (name[0] === '+') { // animation prefix
        const frame = name.toUpperCase().charCodeAt(1);

        if (glt !== null) {
          if (frame >= 48 && frame <= 57) { // '0'-'9'
            const frameIndex = frame - 48;
            tx.addAnimationFrame(frameIndex, glt, luminanceTexture);
          } else if (frame >= 65 && frame <= 74) { // 'A'-'J'
            const frameIndex = frame - 65;
            tx.addAlternateFrame(frameIndex, glt, luminanceTexture);
          }
        }
      } else {
        if (glt !== null) {
          tx.texture = glt;
        }

        if (luminanceTexture !== null) {
          tx.luminanceTexture = luminanceTexture;
        }
      }

      loadmodel.textures[i] = tx;
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Upload a luminance texture when the source WAD3 texture has fullbright pixels.
   * @returns The uploaded luminance texture, or null when no visible fullbright pixels exist.
   */
  static #createWadLuminanceTexture(wadTextureData: ArrayBuffer, textureName: string, width: number, height: number): GLTexture | null {
    const indexedData = new Uint8Array(wadTextureData, 40, width * height);
    const palette = new Uint8Array(wadTextureData,
      40 +
      width * height +
      width / 2 * height / 2 +
      width / 4 * height / 4 +
      width / 8 * height / 8 +
      2,
    768);
    const luminanceRGBA = translateIndexToLuminanceRGBA(indexedData, width, height, palette, textureName[0] === '{' ? 255 : null, 240);

    if (!BSP29Loader.#hasVisiblePixels(luminanceRGBA)) {
      return null;
    }

    return GLTexture.Allocate(`${textureName}/${CRC16CCITT.Block(indexedData)}:luminance`, width, height, luminanceRGBA);
  }

  /**
   * Check whether any pixel in the RGBA data contributes visible color.
   * @returns True when any pixel is visible.
   */
  static #hasVisiblePixels(rgba: Uint8Array): boolean {
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] !== 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Load material definitions from .qsmat.json files if available.
   */
  async #loadMaterials(loadmodel: BrushModel): Promise<void> {
    if (registry.isDedicatedServer) {
      return;
    }

    const filenames = [] as string[];

    // build list of filenames based on _qs_mat
    for (const qsMat of (loadmodel.worldspawnInfo._qs_mat?.split(/;\s*/) || [])) {
      const filename = qsMat.trim();

      if (filename === '') {
        continue;
      }

      filenames.push(filename);
    }

    // load all files in parallel
    const matfiles = await Promise.all(filenames.map((filename) => COM.LoadTextFile(filename)));

    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      const matfile = matfiles[i];

      if (!matfile) {
        continue;
      }

      Con.DPrint(`BSP29Loader: loaded material file ${filename}\n`);
      const materialData = JSON.parse(matfile) as MaterialFile;
      console.assert(materialData.version === 1);

      for (const [txName, textures] of Object.entries(materialData.materials)) {
        const textureEntry = Array.from(loadmodel.textures.entries()).find(([, t]) => t.name === txName);

        if (!textureEntry) {
          continue;
        }

        const [txIndex, texture] = textureEntry;
        const pbr = new PBRMaterial(texture.name, texture.width, texture.height);

        const materialTextureCategories: MaterialTextureCategory[] = ['luminance', 'diffuse', 'specular', 'normal'];

        for (const category of materialTextureCategories) {
          const texturePath = textures[category];

          if (texturePath) {
            try {
              const loadedTexture = await GLTexture.FromImageFile(texturePath);

              if (loadedTexture !== null) {
                pbr[category] = loadedTexture;
              }

              Con.DPrint(`BSP29Loader: loaded ${category} texture for ${texture.name} from ${texturePath} (material file ${filename})\n`);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              Con.PrintError(`BSP29Loader: failed to load ${texturePath} (material file ${filename}): ${errorMessage}\n`);
            }
          }
        }

        if (textures.flags) {
          for (const flagName of textures.flags) {
            const flagValue = MaterialFlags[flagName as keyof typeof MaterialFlags];
            console.assert(typeof flagValue === 'number', `BSP29Loader: unknown material flag ${flagName} in ${loadmodel.name} (material file ${filename})`);
            if (typeof flagValue === 'number') {
              pbr.flags |= flagValue;
            }
          }
        }

        if (!textures.diffuse && texture instanceof QuakeMaterial && texture.texture !== null) {
          pbr.diffuse = texture.texture; // keep original diffuse as base
        }

        loadmodel.textures[txIndex] = pbr; // replace with PBR material
      }
    }
  }

  /**
   * Load lighting data from BSP lump.
   */
  #loadLighting(loadmodel: BrushModel, buf: ArrayBuffer): void {
    loadmodel.lightdata_rgb = null;
    loadmodel.lightdata = null;

    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.lighting << 3) + 4, true);
    const filelen = view.getUint32((lump.lighting << 3) + 8, true);

    if (filelen === 0) {
      return;
    }

    loadmodel.lightdata = new Uint8Array(new ArrayBuffer(filelen));
    loadmodel.lightdata.set(new Uint8Array(buf, fileofs, filelen));
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load visibility data for potentially visible set (PVS) calculations.
   */
  #loadVisibility(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.visibility << 3) + 4, true);
    const filelen = view.getUint32((lump.visibility << 3) + 8, true);

    if (filelen === 0) {
      return;
    }

    loadmodel.visdata = new Uint8Array(new ArrayBuffer(filelen));
    loadmodel.visdata.set(new Uint8Array(buf, fileofs, filelen));
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Build cluster-native visibility data structures after vis + leafs are loaded.
   * Sets numclusters, builds clusterPvsOffsets from leaf visofs values, and
   * computes PHS (Potentially Hearable Set) via transitive closure of PVS.
   */
  #buildClusterData(loadmodel: BrushModel): void {
    const numclusters = loadmodel.leafs.length - 1; // leaf 0 is outside sentinel
    loadmodel.numclusters = numclusters;

    // BSP29/BSP2 maps have no area data — single area, no portals
    loadmodel.numAreas = 1;
    loadmodel.areaPortals.init(1, []);

    if (loadmodel.visdata === null || numclusters <= 0) {
      return;
    }

    // Build clusterPvsOffsets from leaf visofs values
    // For BSP29: cluster c = leaf c+1, so clusterPvsOffsets[c] = leafs[c+1].visofs
    const clusterPvsOffsets = new Array(numclusters);

    for (let c = 0; c < numclusters; c++) {
      clusterPvsOffsets[c] = loadmodel.leafs[c + 1].visofs;
    }

    loadmodel.clusterPvsOffsets = clusterPvsOffsets;

    // Compute PHS via transitive closure of PVS
    this.#computePHS(loadmodel);
  }

  /**
   * Compute PHS (Potentially Hearable Set) data by transitive closure of PVS.
   * For each cluster, the PHS includes all clusters visible from any cluster
   * that is itself visible from the source cluster (one-hop expansion).
   */
  #computePHS(loadmodel: BrushModel): void {
    const numclusters = loadmodel.numclusters;
    const clusterBytes = (numclusters + 7) >> 3;
    const visdata = loadmodel.visdata;
    const offsets = loadmodel.clusterPvsOffsets;

    if (visdata === null || offsets === null || numclusters <= 0) {
      return;
    }

    // Decompress all PVS rows into a flat buffer for fast OR operations
    const pvsRows = new Uint8Array(numclusters * clusterBytes);
    for (let c = 0; c < numclusters; c++) {
      const rowStart = c * clusterBytes;

      if (offsets[c] < 0) {
        continue; // no vis for this cluster; row stays zero
      }

      for (let _out = 0, _in = offsets[c]; _out < clusterBytes;) {
        // Bounds check to prevent reading past end of visdata
        // Note: It's normal for visibility data to end before clusterBytes is filled;
        // remaining bytes stay zero, which is correct for unvisible clusters.
        if (_in >= visdata.length) {
          break;
        }

        if (visdata[_in] !== 0) {
          pvsRows[rowStart + _out++] = visdata[_in++];
          continue;
        }

        // RLE: 0 byte followed by count of zeros
        if (_in + 1 >= visdata.length) {
          // End of RLE data; remaining output stays zero (unvisible)
          break;
        }

        for (let skip = visdata[_in + 1]; skip > 0; skip--) {
          pvsRows[rowStart + _out++] = 0x00;
        }

        _in += 2;
      }
    }

    // Transitive closure: PHS[src] = OR of PVS[c] for all c where PVS[src] has bit c set
    const phsRows = new Uint8Array(numclusters * clusterBytes);
    for (let src = 0; src < numclusters; src++) {
      const srcPvsStart = src * clusterBytes;
      const dstPhsStart = src * clusterBytes;

      // Start with the PVS itself
      for (let b = 0; b < clusterBytes; b++) {
        phsRows[dstPhsStart + b] = pvsRows[srcPvsStart + b];
      }

      // OR in PVS of every cluster visible from src
      for (let c = 0; c < numclusters; c++) {
        if ((pvsRows[srcPvsStart + (c >> 3)] & (1 << (c & 7))) === 0) {
          continue;
        }

        const neighborPvsStart = c * clusterBytes;

        for (let b = 0; b < clusterBytes; b++) {
          phsRows[dstPhsStart + b] |= pvsRows[neighborPvsStart + b];
        }
      }
    }

    // RLE-compress PHS rows into phsdata + build clusterPhsOffsets
    // Worst case: each row expands to clusterBytes (no compression)
    // Typical case: significant compression due to zero runs
    // Format: Non-zero bytes are literal, [0, count] represents count zero bytes
    const phsBuffer = [];
    const clusterPhsOffsets = new Array(numclusters);

    for (let c = 0; c < numclusters; c++) {
      clusterPhsOffsets[c] = phsBuffer.length;
      const rowStart = c * clusterBytes;
      let i = 0;

      while (i < clusterBytes) {
        if (phsRows[rowStart + i] !== 0) {
          // Literal non-zero byte
          phsBuffer.push(phsRows[rowStart + i]);
          i++;
        } else {
          // Count zero run (up to 255 bytes)
          let zeroCount = 0;

          while (i < clusterBytes && phsRows[rowStart + i] === 0 && zeroCount < 255) {
            i++;
            zeroCount++;
          }

          // Encode as [0, count]
          phsBuffer.push(0);
          phsBuffer.push(zeroCount);
        }
      }
    }

    loadmodel.phsdata = new Uint8Array(phsBuffer);
    loadmodel.clusterPhsOffsets = clusterPhsOffsets;
  }

  /**
   * Compute visibility areas and portals based on door entities and PHS.
   * This traverses the BSP tree to classify leaves against door planes,
   * then clusters them based on PVS connectivity.
   */
  #computeAreas(loadmodel: BrushModel): void {
    // 1. Identify Portal Definitions (Doors)
    const portalDefs = this.#parsePortalEntities(loadmodel);

    // 2. Build Portal Planes from Door BBoxes
    // Merge bboxes for shared portalNums (e.g. double doors)
    const mergedBboxes = new Map();

    for (const def of portalDefs) {
      const submodel = loadmodel.submodels[def.modelIndex - 1]; // *N -> submodels[N-1]

      if (!submodel) {
        Con.PrintWarning(`BSP29Loader.computeAreas: portal ${def.portalNum} references invalid model *${def.modelIndex}\n`);
        continue;
      }

      const existing = mergedBboxes.get(def.portalNum);

      if (existing) {
        for (let k = 0; k < 3; k++) {
          existing.mins[k] = Math.min(existing.mins[k], submodel.mins[k]);
          existing.maxs[k] = Math.max(existing.maxs[k], submodel.maxs[k]);
        }
      } else {
        mergedBboxes.set(def.portalNum, {
          mins: [submodel.mins[0], submodel.mins[1], submodel.mins[2]],
          maxs: [submodel.maxs[0], submodel.maxs[1], submodel.maxs[2]],
        });
      }
    }

    const portals: Array<{
      readonly portalNum: number;
      readonly axis: 0 | 1 | 2;
      readonly dist: number;
      readonly backVis: ReturnType<BrushModel['getPhsByPoint']>;
      readonly frontVis: ReturnType<BrushModel['getPhsByPoint']>;
    }> = [];

    for (const [portalNum, bbox] of mergedBboxes) {
      // Determine split plane (thinnest axis)
      const size: [number, number, number] = [bbox.maxs[0] - bbox.mins[0], bbox.maxs[1] - bbox.mins[1], bbox.maxs[2] - bbox.mins[2]];
      let axis: 0 | 1 | 2 = 0;

      if (size[1] < size[0]) {
        axis = 1;
      }

      if (size[2] < size[axis]) {
        axis = 2;
      }

      const dist = (bbox.mins[axis] + bbox.maxs[axis]) * 0.5;
      const thickness = (bbox.maxs[axis] - bbox.mins[axis]) * 0.5;
      const offset = Math.max(24.0, thickness + 16.0); // Offset for PHS sampling

      // Sample PHS points
      const center = [(bbox.mins[0] + bbox.maxs[0]) * 0.5, (bbox.mins[1] + bbox.maxs[1]) * 0.5, (bbox.mins[2] + bbox.maxs[2]) * 0.5];
      const backPt = [...center];
      backPt[axis] -= offset;
      const frontPt = [...center];
      frontPt[axis] += offset;

      portals.push({
        portalNum,
        axis,
        dist,
        backVis: loadmodel.getPhsByPoint(new Vector(...backPt)),
        frontVis: loadmodel.getPhsByPoint(new Vector(...frontPt)),
      });
    }

    // 3. Traverse BSP Nodes to assign "Side" Signatures
    // Optimization: If a node is fully on one side of a portal plane, all its children are too.
    const leafSignatures = new Map<number, string>();

    /** Recursively classify nodes against portal planes. */
    const classifyRecursive = (node: Node, states: number[]): void => {
      // Check unknown portals against node bounds
      const nextStates = states.slice();

      for (let i = 0; i < portals.length; i++) {
        if (nextStates[i] !== -1) {
          continue;
        }

        const p = portals[i];
        const nodeMins = node.mins;
        const nodeMaxs = node.maxs;

        if (nodeMins === null || nodeMaxs === null) {
          continue;
        }

        if (nodeMaxs[p.axis] < p.dist) {
          nextStates[i] = 0;
        } else if (nodeMins[p.axis] > p.dist) {
          nextStates[i] = 1;
        }
      }

      if (node.contents < content.CONTENT_NONE) {
        // Leaf Node
        if (node.contents === content.CONTENT_SOLID) {
          node.area = 0;
          return;
        }

        const nodeMins = node.mins;
        const nodeMaxs = node.maxs;
        console.assert(nodeMins !== null && nodeMaxs !== null, 'leaf nodes require bounds for area computation');

        if (nodeMins === null || nodeMaxs === null) {
          return;
        }

        const cx = (nodeMins[0] + nodeMaxs[0]) * 0.5;
        const cy = (nodeMins[1] + nodeMaxs[1]) * 0.5;
        const cz = (nodeMins[2] + nodeMaxs[2]) * 0.5;
        const center = [cx, cy, cz];

        let sig = '';

        for (let i = 0; i < portals.length; i++) {
          let side = nextStates[i];

          if (side === -1) {
            side = center[portals[i].axis] >= portals[i].dist ? 1 : 0;
          }

          // Nearness check via PHS
          const p = portals[i];
          const isNear = side === 0 ? p.backVis.isRevealed(node.num) : p.frontVis.isRevealed(node.num);

          // Sig Codes: 0=BackFar, 1=BackNear, 2=FrontNear, 3=FrontFar
          let code = 0;

          if (side === 0) {
            code = isNear ? 1 : 0;
          } else {
            code = isNear ? 2 : 3;
          }

          sig += code.toString();
        }

        leafSignatures.set(node.num, sig);
        return;
      }

      // Inner Node
      if (node.children[0]) {
        classifyRecursive(getNodeChild(node, 0), nextStates);
      }
      if (node.children[1]) {
        classifyRecursive(getNodeChild(node, 1), nextStates);
      }
    };

    // Start traversal from root
    const initialStates = new Array(portals.length).fill(-1);
    classifyRecursive(loadmodel.nodes[0], initialStates);

    // 4. Cluster Signatures into Areas (PVS connectivity)
    const sigGroups = new Map();

    for (const [leafNum, sig] of leafSignatures) {
      if (!sigGroups.has(sig)) {
        sigGroups.set(sig, []);
      }
      sigGroups.get(sig).push(leafNum);
    }

    let nextArea = 1;
    const areasList: { sig: string; area: number }[] = [];
    const areaLeafsMap = new Map<number, number[]>();

    for (const [sig, leafIndices] of sigGroups) {
      const visited = new Set();

      for (const startLeaf of leafIndices) {
        if (visited.has(startLeaf)) {
          continue;
        }

        const area = nextArea++;
        areasList.push({ sig, area });
        areaLeafsMap.set(area, []);
        const areaLeafs = areaLeafsMap.get(area);
        console.assert(areaLeafs !== undefined, 'area leaf list must exist after initialization');

        if (areaLeafs === undefined) {
          continue;
        }

        // BFS within this signature group using PVS
        const queue = [startLeaf];
        visited.add(startLeaf);
        loadmodel.leafs[startLeaf].area = area;
        areaLeafs.push(startLeaf);

        while (queue.length > 0) {
          const current = queue.shift();
          const pvs = loadmodel.getPvsByLeaf(loadmodel.leafs[current]);

          // We only need to check leaves in the same signature group
          for (const candidate of leafIndices) {
            if (!visited.has(candidate) && pvs.isRevealed(candidate)) {
              visited.add(candidate);
              loadmodel.leafs[candidate].area = area;
              areaLeafs.push(candidate);
              queue.push(candidate);
            }
          }
        }
      }
    }

    loadmodel.numAreas = nextArea;

    // 5. Connect Areas
    const allConnections: { area0: number; area1: number; group: number }[] = [];

    for (let i = 0; i < areasList.length; i++) {
      for (let j = i + 1; j < areasList.length; j++) {
        const { sig: sigA, area: areaA } = areasList[i];
        const { sig: sigB, area: areaB } = areasList[j];

        // Differences logic:
        // 1 -> 2 (BackNear <-> FrontNear) : Door Crossing (Gated)
        // Others: Open connection (just movement)
        let diffCount = 0;
        let doorCount = 0;
        let doorGroup = -1;

        for (let k = 0; k < sigA.length; k++) {
          if (sigA[k] !== sigB[k]) {
            diffCount++;
            const s1 = parseInt(sigA[k]);
            const s2 = parseInt(sigB[k]);

            // Check if transition is BackNear(1) <-> FrontNear(2)
            if ((s1 === 1 && s2 === 2) || (s1 === 2 && s2 === 1)) {
              doorCount++;
              doorGroup = portals[k].portalNum;
            }
          }
        }

        if (diffCount === 0) {
          continue;
        }

        // PVS Adjacency Check
        const leafsA = areaLeafsMap.get(areaA);
        const leafsB = areaLeafsMap.get(areaB);

        if (leafsA === undefined || leafsB === undefined) {
          continue;
        }

        let pvsAdjacent = false;

        // Check A seeing B (optimization: only check first few or scan until hit)
        for (let li = 0; li < leafsA.length && !pvsAdjacent; li++) {
          const pvs = loadmodel.getPvsByLeaf(loadmodel.leafs[leafsA[li]]);
          for (let lj = 0; lj < leafsB.length; lj++) {
            if (pvs.isRevealed(leafsB[lj])) {
              pvsAdjacent = true;
              break;
            }
          }
        }

        if (!pvsAdjacent) {
          continue;
        }

        if (doorCount === 1) {
          allConnections.push({ area0: areaA, area1: areaB, group: doorGroup });
        } else if (doorCount === 0) {
          allConnections.push({ area0: areaA, area1: areaB, group: -1 });
        }
      }
    }

    let maxGroup = 0;
    for (const c of allConnections) {
      if (c.group > maxGroup) {
        maxGroup = c.group;
      }
    }
    const numGroups = maxGroup + 1;

    loadmodel.portalDefs = allConnections;
    loadmodel.areaPortals.init(loadmodel.numAreas, allConnections, numGroups);

    Con.DPrint(`BSP29Loader.computeAreas: computed ${loadmodel.numAreas} areas, ${allConnections.length} connections, ${numGroups} groups\n`);
  }

  /**
   * Parse the entity lump for portal entity definitions.
   * Entities with an explicit "portal" key are used directly. Door entities
   * (func_door, func_door_secret) with brush models are auto-assigned portal
   * numbers if they don't have an explicit one. The mapping from model name
   * to portal number is stored in loadmodel.modelPortalMap.
   * @returns Portal definitions keyed by submodel index.
   */
  #parsePortalEntities(loadmodel: BrushModel): { portalNum: number; modelIndex: number }[] {
    const portals: { portalNum: number; modelIndex: number }[] = [];

    // First pass: collect explicit portals and door entities needing auto-assignment
    const autoAssignDoors: { modelIndex: number; model: string }[] = [];
    let maxExplicitPortal = -1;

    let data: string | null = loadmodel.entities;

    Con.DPrint('BSP29Loader.#parsePortalEntities: looking for portals in entity lump...\n');

    while (data) {
      const parsed = COM.Parse(data);
      data = parsed.data;

      if (!data) {
        break;
      }

      // Parse one entity block
      const ent: Record<string, string> = {};

      while (data) {
        const parsedKey = COM.Parse(data);
        data = parsedKey.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        const parsedValue = COM.Parse(data);
        data = parsedValue.data;

        if (!data || parsedValue.token === '}') {
          break;
        }

        ent[parsedKey.token] = parsedValue.token;
      }

      if (!ent.model || !ent.model.startsWith('*')) {
        continue;
      }

      const modelIndex = parseInt(ent.model.substring(1), 10);

      if (isNaN(modelIndex) || modelIndex <= 0) {
        continue;
      }

      // Explicit portal key takes priority
      if (ent.portal !== undefined) {
        const portalNum = parseInt(ent.portal, 10);

        if (!isNaN(portalNum) && portalNum >= 0) {
          portals.push({ portalNum, modelIndex });
          loadmodel.modelPortalMap[ent.model] = portalNum;

          if (portalNum > maxExplicitPortal) {
            maxExplicitPortal = portalNum;
          }
        }

        continue;
      }

      // CR: temporarily disabled due to funny bugs
      // // Auto-assign portal numbers to door entities
      // if (ent.classname is an auto-assigned door classname) {
      //   Con.DPrint(`...detected portal ${ent.classname} with model ${ent.model}\n`);
      //   autoAssignDoors.push({ modelIndex, model: ent.model });
      // }
    }

    // Auto-assign portal numbers starting after the highest explicit one.
    // Double doors (two touching door halves) must share a single portal
    // number, otherwise each half generates its own splitting plane and
    // the area assignment breaks.
    let nextPortal = maxExplicitPortal + 1;

    // Group touching doors using union-find so linked door pairs share
    // a portal. This mirrors the game-side _linkDoors() touching test.
    const doorCount = autoAssignDoors.length;

    const parent: number[] = autoAssignDoors.map((_, i) => i);

    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]]; // path compression
        i = parent[i];
      }

      return i;
    };

    const union = (a: number, b: number): void => {
      parent[find(a)] = find(b);
    };

    for (let i = 0; i < doorCount; i++) {
      const smA = loadmodel.submodels[autoAssignDoors[i].modelIndex - 1];

      if (!smA) {
        continue;
      }

      for (let j = i + 1; j < doorCount; j++) {
        const smB = loadmodel.submodels[autoAssignDoors[j].modelIndex - 1];

        if (!smB) {
          continue;
        }

        // Same touching test as BaseEntity.isTouching / QuakeC EntitiesTouching
        if (smA.mins[0] <= smB.maxs[0] && smA.maxs[0] >= smB.mins[0]
          && smA.mins[1] <= smB.maxs[1] && smA.maxs[1] >= smB.mins[1]
          && smA.mins[2] <= smB.maxs[2] && smA.maxs[2] >= smB.mins[2]) {
          union(i, j);
        }
      }
    }

    // Assign one portal number per group
    const groupPortal = new Map<number, number>();

    for (let i = 0; i < doorCount; i++) {
      const door = autoAssignDoors[i];

      if (loadmodel.modelPortalMap[door.model]) {
        continue;
      }

      const root = find(i);
      let portalNum = groupPortal.get(root);

      if (portalNum === undefined) {
        portalNum = nextPortal++;
        groupPortal.set(root, portalNum);
      }

      portals.push({ portalNum, modelIndex: door.modelIndex });
      loadmodel.modelPortalMap[door.model] = portalNum;
    }

    if (autoAssignDoors.length > 0) {
      Con.DPrint(`BSP29Loader.#parsePortalEntities: auto-assigned ${autoAssignDoors.length} door portals (${groupPortal.size} groups)\n`);
    }

    return portals;
  }

  /**
   * Load entities from BSP lump and parse worldspawn properties.
   * Also tries to parse light entities to determine if RGB lighting is used
   * and whether we need to load the .lit file.
   */
  #loadEntities(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.entities << 3) + 4, true);
    const filelen = view.getUint32((lump.entities << 3) + 8, true);
    loadmodel.entities = Q.memstr(new Uint8Array(buf, fileofs, filelen));
    loadmodel.worldspawnInfo = {};

    let data = loadmodel.entities as string | null;

    // going for worldspawn and light
    let stillLooking = 2;
    while (stillLooking > 0) {
      const parsed = COM.Parse(data!);
      data = parsed.data;

      if (!data) {
        break;
      }

      const currentEntity: Record<string, string> = {};
      while (data) {
        const parsedKey = COM.Parse(data);
        data = parsedKey.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        const parsedValue = COM.Parse(data);
        data = parsedValue.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        currentEntity[parsedKey.token] = parsedValue.token;
      }

      if (!currentEntity.classname) {
        break;
      }

      switch (currentEntity.classname) {
        case 'worldspawn':
          Object.assign(loadmodel.worldspawnInfo, currentEntity);
          stillLooking--;
          break;

        case 'light':
          if (currentEntity._color) {
            loadmodel.coloredlights = true;
            stillLooking--;
          }
          break;
      }
    }

    // Second pass: parse func_fog entities from the entity lump
    // (moved to load() after submodels load so we can also scan submodel faces)

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Parse func_fog entities from the BSP entity lump and store
   * them as fog volume descriptors on the model.
   */
  #parseFogVolumes(loadmodel: BrushModel): void {
    loadmodel.fogVolumes.length = 0;

    let data = loadmodel.entities;
    if (!data) {
      return;
    }

    while (data) {
      const parsed = COM.Parse(data);
      data = parsed.data;

      if (!data) {
        break;
      }

      const entity: Record<string, string> = {};

      while (data) {
        const parsedKey = COM.Parse(data);
        data = parsedKey.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        const parsedValue = COM.Parse(data);
        data = parsedValue.data;

        if (!data || parsedValue.token === '}') {
          break;
        }

        entity[parsedKey.token] = parsedValue.token;
      }

      if (entity.classname !== 'func_fog' || !entity.model) {
        continue;
      }

      const modelIndex = parseInt(entity.model.substring(1), 10);

      if (isNaN(modelIndex) || modelIndex <= 0) {
        Con.PrintWarning(`func_fog has invalid model '${entity.model}'\n`);
        continue;
      }

      const colorParts = (entity.fog_color || '128 128 128').split(/\s+/).map(Number);
      const submodel = loadmodel.submodels[modelIndex - 1];

      loadmodel.fogVolumes.push({
        modelIndex,
        color: [colorParts[0] || 128, colorParts[1] || 128, colorParts[2] || 128],
        density: parseFloat(entity.fog_density || '0.01'),
        maxOpacity: Math.min(1.0, Math.max(0.0, parseFloat(entity.fog_max_opacity || '0.8'))),
        mins: submodel ? [submodel.mins[0], submodel.mins[1], submodel.mins[2]] : [0, 0, 0],
        maxs: submodel ? [submodel.maxs[0], submodel.maxs[1], submodel.maxs[2]] : [0, 0, 0],
      });

      Con.DPrint(`Found func_fog: model *${modelIndex}, color ${colorParts}, density ${entity.fog_density || '0.01'}\n`);
    }

    if (loadmodel.worldspawnInfo._qs_autogen_fog !== '1') {
      Con.DPrint('Auto-generation of fog volumes is disabled.\n');
      return;
    }

    // Auto-generate fog volumes for turbulent submodels (water, slime, lava)
    // that weren't already claimed by a func_fog entity
    const claimedModels = new Set(loadmodel.fogVolumes.map((fv) => fv.modelIndex));

    for (let i = 0; i < loadmodel.submodels.length; i++) {
      const modelIndex = i + 1; // submodels[0] = *1, submodels[1] = *2, etc.

      if (claimedModels.has(modelIndex)) {
        continue;
      }

      const submodel = loadmodel.submodels[i];

      // Check if ALL faces in this submodel are turbulent
      let allTurbulent = submodel.numfaces > 0;
      let turbulentTextureIndex = -1;

      for (let j = 0; j < submodel.numfaces; j++) {
        const face = submodel.faces[submodel.firstface + j];
        const material = loadmodel.textures[face.texture];

        if (!(material.flags & MaterialFlags.MF_TURBULENT)) {
          allTurbulent = false;
          break;
        }

        if (turbulentTextureIndex === -1) {
          turbulentTextureIndex = face.texture;
        }
      }

      if (!allTurbulent || turbulentTextureIndex === -1) {
        continue;
      }

      // Derive fog color from the texture's average color, modulated by ambient light
      const material = loadmodel.textures[turbulentTextureIndex];
      const baseColor: [number, number, number] = material.averageColor || [128, 128, 128];
      const volMins: [number, number, number] = [submodel.mins[0], submodel.mins[1], submodel.mins[2]];
      const volMaxs: [number, number, number] = [submodel.maxs[0], submodel.maxs[1], submodel.maxs[2]];
      const lightFactor = this.#sampleAmbientLightForVolume(loadmodel, volMins, volMaxs);
      const color: [number, number, number] = [
        Math.round(baseColor[0] * lightFactor),
        Math.round(baseColor[1] * lightFactor),
        Math.round(baseColor[2] * lightFactor),
      ];

      loadmodel.fogVolumes.push({
        modelIndex,
        color,
        density: 0.02,
        maxOpacity: 0.85,
        mins: volMins,
        maxs: volMaxs,
      });

      Con.DPrint(`Auto-fog for turbulent *${modelIndex} (${material.name}): color [${color}], light=${lightFactor.toFixed(2)}\n`);
    }

    // Phase 3: Auto-generate fog volumes for world-level turbulent surfaces
    // (water/slime/lava that belong to the worldspawn, not a brush entity).
    // These exist as BSP leafs with CONTENT_WATER/SLIME/LAVA contents.
    // We cluster adjacent leafs of the same type and create fog volumes from their merged AABBs.
    this.#parseFogVolumesFromWorldLeafs(loadmodel);
  }

  /**
   * Create fog volumes for world-level water/slime/lava directly from BSP leafs.
   * Each liquid leaf gets its own fog volume with exact bounds from the BSP compiler,
   * avoiding imprecision from merging AABBs across multiple leafs.
   */
  #parseFogVolumesFromWorldLeafs(loadmodel: BrushModel): void {
    if (!loadmodel.leafs || loadmodel.leafs.length === 0) {
      return;
    }

    const liquidLeafsByType = new Map<content, number[]>();

    for (let i = 0; i < loadmodel.leafs.length; i++) {
      const leaf = loadmodel.leafs[i];
      const c = leaf.contents;

      if (c !== content.CONTENT_WATER && c !== content.CONTENT_SLIME && c !== content.CONTENT_LAVA) {
        continue;
      }

      if (!liquidLeafsByType.has(c)) {
        liquidLeafsByType.set(c, []);
      }
      liquidLeafsByType.get(c)?.push(i);
    }

    if (liquidLeafsByType.size === 0) {
      return;
    }

    for (const [contentType, leafIndices] of liquidLeafsByType) {
      // Find dominant turbulent texture color across all leafs of this type
      const clusterColor = this.#findClusterTurbulentColor(loadmodel, leafIndices);
      const color: [number, number, number] = clusterColor !== null
        ? [clusterColor[0], clusterColor[1], clusterColor[2]]
        : [128, 128, 128];

      const contentName = contentType === content.CONTENT_WATER ? 'water'
        : contentType === content.CONTENT_SLIME ? 'slime' : 'lava';

      const density = contentType === content.CONTENT_LAVA ? 0.05
        : contentType === content.CONTENT_SLIME ? 0.01 : 0.005;

      // Create one fog volume per leaf with exact BSP bounds, modulated by ambient light
      for (const leafIdx of leafIndices) {
        const leaf = loadmodel.leafs[leafIdx];
        if (leaf.mins === null || leaf.maxs === null) {
          continue;
        }
        const volMins: [number, number, number] = [leaf.mins[0], leaf.mins[1], leaf.mins[2]];
        const volMaxs: [number, number, number] = [leaf.maxs[0], leaf.maxs[1], leaf.maxs[2]];
        const lightFactor = this.#sampleAmbientLightForVolume(loadmodel, volMins, volMaxs);
        const dimmedColor: [number, number, number] = [
          Math.round(color[0] * lightFactor),
          Math.round(color[1] * lightFactor),
          Math.round(color[2] * lightFactor),
        ];

        loadmodel.fogVolumes.push({
          modelIndex: 0,
          color: dimmedColor,
          density,
          maxOpacity: 0.85,
          mins: volMins,
          maxs: volMaxs,
        });

        Con.DPrint(`Auto-fog: ${leafIdx} ${contentName} leaf volume, base color [${color}], lightFactor = ${lightFactor.toFixed(2)}\n`);
      }
    }
  }

  /**
   * Find the average color of the dominant turbulent texture in a set of leafs.
   * Scans marksurfaces for turbulent faces and returns the most common texture's color.
   * @returns The dominant turbulent color, or null when no turbulent face is present.
   */
  #findClusterTurbulentColor(loadmodel: BrushModel, leafIndices: number[]): number[] | null {
    const textureCounts = new Map<number, number>();

    for (const leafIdx of leafIndices) {
      const leaf = loadmodel.leafs[leafIdx];

      for (let k = 0; k < leaf.nummarksurfaces; k++) {
        const faceIdx = loadmodel.marksurfaces[leaf.firstmarksurface + k];
        const face = loadmodel.faces[faceIdx];

        if (!face.turbulent) {
          continue;
        }

        textureCounts.set(face.texture, (textureCounts.get(face.texture) || 0) + 1);
      }
    }

    if (textureCounts.size === 0) {
      return null;
    }

    // Find the most common turbulent texture
    let bestTexture = -1;
    let bestCount = 0;

    for (const [texIdx, count] of textureCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestTexture = texIdx;
      }
    }

    const material = loadmodel.textures[bestTexture];
    return material?.averageColor || null;
  }

  /**
   * Sample the average ambient light intensity near a fog volume's bounding box.
   * Scans BSP leafs that overlap the expanded AABB and samples lightmap data
   * from non-turbulent, non-sky faces to estimate the local light level.
   * @returns A normalized lighting factor in the range used for fog modulation.
   */
  #sampleAmbientLightForVolume(loadmodel: BrushModel, mins: number[], maxs: number[]): number {
    if ((loadmodel.lightdata_rgb === null && loadmodel.lightdata === null) || !loadmodel.leafs || loadmodel.leafs.length === 0) {
      return 1.0;
    }

    // Expand AABB by 64 units to catch nearby lit surfaces
    const expand = 64;
    const eMins = [mins[0] - expand, mins[1] - expand, mins[2] - expand];
    const eMaxs = [maxs[0] + expand, maxs[1] + expand, maxs[2] + expand];

    let totalIntensity = 0;
    let sampleCount = 0;

    const hasRGB = loadmodel.lightdata_rgb !== null;

    for (let i = 0; i < loadmodel.leafs.length; i++) {
      const leaf = loadmodel.leafs[i];
      const leafMins = leaf.mins;
      const leafMaxs = leaf.maxs;

      if (leafMins === null || leafMaxs === null) {
        continue;
      }

      // Skip liquid leafs — we want light from surrounding solid geometry
      if (leaf.contents === content.CONTENT_WATER
        || leaf.contents === content.CONTENT_SLIME
        || leaf.contents === content.CONTENT_LAVA) {
        continue;
      }

      // AABB overlap test
      if (leafMins[0] > eMaxs[0] || leafMaxs[0] < eMins[0]
        || leafMins[1] > eMaxs[1] || leafMaxs[1] < eMins[1]
        || leafMins[2] > eMaxs[2] || leafMaxs[2] < eMins[2]) {
        continue;
      }

      // Scan marksurfaces in this leaf
      for (let k = 0; k < leaf.nummarksurfaces; k++) {
        const faceIdx = loadmodel.marksurfaces[leaf.firstmarksurface + k];
        const face = loadmodel.faces[faceIdx];

        if (face.turbulent || face.sky || face.lightofs < 0 || face.styles.length === 0) {
          continue;
        }

        const lmshift = face.lmshift;

        if (lmshift === null) {
          continue;
        }

        // Compute lightmap dimensions for this face
        const smax = (face.extents[0] >> lmshift) + 1;
        const tmax = (face.extents[1] >> lmshift) + 1;
        const size = smax * tmax;

        if (size <= 0 || size > 4096) {
          continue;
        }

        // Sample only the first light style (style 0 = static light)
        if (hasRGB) {
          const lightdataRgb = loadmodel.lightdata_rgb;

          if (lightdataRgb === null) {
            continue;
          }

          const offset = face.lightofs * 3;

          if (offset + size * 3 > lightdataRgb.length) {
            continue;
          }

          for (let s = 0; s < size * 3; s += 3) {
            // Perceptual luminance
            totalIntensity += lightdataRgb[offset + s] * 0.299
              + lightdataRgb[offset + s + 1] * 0.587
              + lightdataRgb[offset + s + 2] * 0.114;
            sampleCount++;
          }
        } else {
          const lightdata = loadmodel.lightdata;

          if (lightdata === null) {
            continue;
          }

          const offset = face.lightofs;

          if (offset + size > lightdata.length) {
            continue;
          }

          for (let s = 0; s < size; s++) {
            totalIntensity += lightdata[offset + s];
            sampleCount++;
          }
        }
      }
    }

    if (sampleCount === 0) {
      return 1.0;
    }

    // Average intensity in 0-255 range, normalize to a 0-1 scale.
    // Quake lighting with value ~200 is considered well-lit; we use 200 as reference
    // so well-lit areas keep the fog color roughly unchanged.
    const avgIntensity = totalIntensity / sampleCount;
    const factor = Math.min(1.0, Math.max(0.15, avgIntensity / 200.0));
    return factor;
  }

  /**
   * Compute the average color of an RGBA texture buffer.
   * Skips fully transparent pixels so alpha-masked areas don't dilute the color.
   * @returns The average RGB color.
   */
  static #computeAverageColor(rgba: Uint8Array): [number, number, number] {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 0) {
        continue; // skip fully transparent pixels
      }
      r += rgba[i];
      g += rgba[i + 1];
      b += rgba[i + 2];
      count++;
    }

    if (count === 0) {
      return [128, 128, 128];
    }

    return [
      Math.round(r / count),
      Math.round(g / count),
      Math.round(b / count),
    ];
  }

  /**
   * Load vertices from BSP lump.
   */
  #loadVertexes(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.vertexes << 3) + 4, true);
    const filelen = view.getUint32((lump.vertexes << 3) + 8, true);
    if ((filelen % 12) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: vertexes lump size is not a multiple of 12');
    }
    const count = filelen / 12;
    loadmodel.vertexes.length = 0;
    for (let i = 0; i < count; i++) {
      loadmodel.vertexes[i] = new Vector(
        view.getFloat32(fileofs, true),
        view.getFloat32(fileofs + 4, true),
        view.getFloat32(fileofs + 8, true),
      );
      fileofs += 12;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load edges from BSP lump.
   */
  protected _loadEdges(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.edges << 3) + 4, true);
    const filelen = view.getUint32((lump.edges << 3) + 8, true);
    if ((filelen & 3) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: edges lump size is not a multiple of 4');
    }
    const count = filelen >> 2;
    loadmodel.edges.length = 0;
    for (let i = 0; i < count; i++) {
      loadmodel.edges[i] = [view.getUint16(fileofs, true), view.getUint16(fileofs + 2, true)];
      fileofs += 4;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load surface edges from BSP lump (indices into edge array, negative = reversed).
   */
  #loadSurfedges(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.surfedges << 3) + 4, true);
    const filelen = view.getUint32((lump.surfedges << 3) + 8, true);
    const count = filelen >> 2;
    loadmodel.surfedges.length = 0;
    for (let i = 0; i < count; i++) {
      loadmodel.surfedges[i] = view.getInt32(fileofs + (i << 2), true);
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load planes from BSP lump.
   */
  #loadPlanes(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.planes << 3) + 4, true);
    const filelen = view.getUint32((lump.planes << 3) + 8, true);
    if ((filelen % 20) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: planes lump size is not a multiple of 20');
    }
    const count = filelen / 20;
    loadmodel.planes.length = 0;
    for (let i = 0; i < count; i++) {
      const normal = new Vector(
        view.getFloat32(fileofs, true),
        view.getFloat32(fileofs + 4, true),
        view.getFloat32(fileofs + 8, true),
      );
      const dist = view.getFloat32(fileofs + 12, true);
      const out = new Plane(normal, dist);
      out.type = view.getUint32(fileofs + 16, true);
      if (out.normal[0] < 0) { out.signbits |= 1; }
      if (out.normal[1] < 0) { out.signbits |= 2; }
      if (out.normal[2] < 0) { out.signbits |= 4; }
      loadmodel.planes[i] = out;
      fileofs += 20;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load texture coordinate information from BSP lump.
   */
  #loadTexinfo(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.texinfo << 3) + 4, true);
    const filelen = view.getUint32((lump.texinfo << 3) + 8, true);
    if ((filelen % 40) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: texinfo lump size is not a multiple of 40');
    }
    const count = filelen / 40;
    loadmodel.texinfo.length = 0;
    for (let i = 0; i < count; i++) {
      const vecs: BrushTexInfo['vecs'] = [
        [view.getFloat32(fileofs, true), view.getFloat32(fileofs + 4, true), view.getFloat32(fileofs + 8, true), view.getFloat32(fileofs + 12, true)],
        [view.getFloat32(fileofs + 16, true), view.getFloat32(fileofs + 20, true), view.getFloat32(fileofs + 24, true), view.getFloat32(fileofs + 28, true)],
      ];
      let texture = view.getUint32(fileofs + 32, true);
      let flags = view.getUint32(fileofs + 36, true);
      if (texture >= loadmodel.textures.length) {
        texture = loadmodel.textures.length - 1;
        flags = 0;
      }
      const out: BrushTexInfo = { vecs, texture, flags };
      loadmodel.texinfo[i] = out;
      fileofs += 40;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load faces (surfaces) from BSP lump and derive oriented face normals.
   */
  protected _loadFaces(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.faces << 3) + 4, true);
    const filelen = view.getUint32((lump.faces << 3) + 8, true);
    if ((filelen % 20) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: faces lump size is not a multiple of 20');
    }

    const lmshift = loadmodel.worldspawnInfo._lightmap_scale ? Math.log2(parseInt(loadmodel.worldspawnInfo._lightmap_scale)) : 4;
    const count = filelen / 20;
    loadmodel.firstface = 0;
    loadmodel.numfaces = count;
    loadmodel.faces.length = 0;

    for (let i = 0; i < count; i++) {
      const styles = new Uint8Array(buf, fileofs + 12, 4);
      const face = Object.assign(new Face(), {
        plane: loadmodel.planes[view.getUint16(fileofs, true)],
        planeBack: view.getInt16(fileofs + 2, true) !== 0,
        firstedge: view.getInt32(fileofs + 4, true),
        numedges: view.getUint16(fileofs + 8, true),
        texinfo: view.getUint16(fileofs + 10, true),
        lightofs: view.getInt32(fileofs + 16, true),
        lmshift,
      });

      for (let j = 0; j < 4; j++) {
        if (styles[j] !== 255) {
          face.styles[j] = styles[j];
        }
      }

      const mins = [Infinity, Infinity];
      const maxs = [-Infinity, -Infinity];
      const tex = loadmodel.texinfo[face.texinfo];
      face.texture = typeof tex.texture === 'number' ? tex.texture : 0;

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

      const lmscale = 1 << face.lmshift;
      face.texturemins = [Math.floor(mins[0] / lmscale) * lmscale, Math.floor(mins[1] / lmscale) * lmscale];
      face.extents = [Math.ceil(maxs[0] / lmscale) * lmscale - face.texturemins[0], Math.ceil(maxs[1] / lmscale) * lmscale - face.texturemins[1]];

      if (loadmodel.textures[face.texture].flags & MaterialFlags.MF_TURBULENT) {
        face.turbulent = true;
      } else if (loadmodel.textures[face.texture].flags & MaterialFlags.MF_SKY) {
        face.sky = true;
      }

      face.normal.set(face.plane.normal);
      if (face.planeBack) {
        face.normal.multiply(-1.0);
      }

      loadmodel.faces[i] = face;
      fileofs += 20;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
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
   * Load BSP tree nodes from BSP lump.
   */
  protected _loadNodes(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.nodes << 3) + 4, true);
    const filelen = view.getUint32((lump.nodes << 3) + 8, true);

    if ((filelen === 0) || ((filelen % 24) !== 0)) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: nodes lump size is invalid');
    }

    const count = filelen / 24;
    loadmodel.nodes.length = 0;

    for (let i = 0; i < count; i++) {
      loadmodel.nodes[i] = Object.assign(new Node(loadmodel), {
        num: i,
        planenum: view.getUint32(fileofs, true),
        children: [view.getInt16(fileofs + 4, true), view.getInt16(fileofs + 6, true)],
        mins: new Vector(view.getInt16(fileofs + 8, true), view.getInt16(fileofs + 10, true), view.getInt16(fileofs + 12, true)),
        maxs: new Vector(view.getInt16(fileofs + 14, true), view.getInt16(fileofs + 16, true), view.getInt16(fileofs + 18, true)),
        firstface: view.getUint16(fileofs + 20, true),
        numfaces: view.getUint16(fileofs + 22, true),
      });
      loadmodel.nodes[i].baseMins = loadmodel.nodes[i].mins!.copy();
      loadmodel.nodes[i].baseMaxs = loadmodel.nodes[i].maxs!.copy();
      fileofs += 24;
    }

    for (let i = 0; i < count; i++) {
      const out = loadmodel.nodes[i];
      out.plane = loadmodel.planes[out.planenum];
      // At this point children contain indices, we convert them to Node references
      const child0Idx = out.children[0] as number;
      const child1Idx = out.children[1] as number;
      out.children[0] = child0Idx >= 0
        ? loadmodel.nodes[child0Idx]
        : loadmodel.leafs[-1 - child0Idx];
      out.children[1] = child1Idx >= 0
        ? loadmodel.nodes[child1Idx]
        : loadmodel.leafs[-1 - child1Idx];
    }

    this.#setParent(loadmodel.nodes[0], null);
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load BSP leaf nodes from BSP lump.
   */
  protected _loadLeafs(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.leafs << 3) + 4, true);
    const filelen = view.getUint32((lump.leafs << 3) + 8, true);
    if ((filelen % 28) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: leafs lump size is not a multiple of 28');
    }
    const count = filelen / 28;
    loadmodel.leafs.length = count;

    for (let i = 0; i < count; i++) {
      loadmodel.leafs[i] = Object.assign(new Node(loadmodel), {
        num: i,
        contents: view.getInt32(fileofs, true),
        visofs: view.getInt32(fileofs + 4, true),
        cluster: i > 0 ? i - 1 : -1,
        mins: new Vector(view.getInt16(fileofs + 8, true), view.getInt16(fileofs + 10, true), view.getInt16(fileofs + 12, true)),
        maxs: new Vector(view.getInt16(fileofs + 14, true), view.getInt16(fileofs + 16, true), view.getInt16(fileofs + 18, true)),
        firstmarksurface: view.getUint16(fileofs + 20, true),
        nummarksurfaces: view.getUint16(fileofs + 22, true),
        ambient_level: [
          view.getUint8(fileofs + 24),
          view.getUint8(fileofs + 25),
          view.getUint8(fileofs + 26),
          view.getUint8(fileofs + 27),
        ],
      });
      loadmodel.leafs[i].baseMins = loadmodel.leafs[i].mins!.copy();
      loadmodel.leafs[i].baseMaxs = loadmodel.leafs[i].maxs!.copy();
      fileofs += 28;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load collision clipnodes and initialize physics hulls.
   */
  protected _loadClipnodes(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.clipnodes << 3) + 4, true);
    const filelen = view.getUint32((lump.clipnodes << 3) + 8, true);
    const count = filelen >> 3;
    loadmodel.clipnodes.length = 0;

    loadmodel.hulls.length = 0;
    loadmodel.hulls[1] = {
      clipnodes: loadmodel.clipnodes,
      firstclipnode: 0,
      lastclipnode: count - 1,
      planes: loadmodel.planes,
      clip_mins: new Vector(-16.0, -16.0, -24.0),
      clip_maxs: new Vector(16.0, 16.0, 32.0),
    };
    loadmodel.hulls[2] = {
      clipnodes: loadmodel.clipnodes,
      firstclipnode: 0,
      lastclipnode: count - 1,
      planes: loadmodel.planes,
      clip_mins: new Vector(-32.0, -32.0, -24.0),
      clip_maxs: new Vector(32.0, 32.0, 64.0),
    };

    for (let i = 0; i < count; i++) {
      loadmodel.clipnodes[i] = {
        planenum: view.getUint32(fileofs, true),
        children: [view.getInt16(fileofs + 4, true), view.getInt16(fileofs + 6, true)],
      };
      fileofs += 8;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Create hull0 (point hull) from BSP nodes for collision detection.
   */
  #makeHull0(loadmodel: BrushModel): void {
    type Clipnode = { planenum: number; children: (number | Node)[] };

    const clipnodes = [] as Clipnode[];
    const hull = {
      clipnodes: clipnodes,
      lastclipnode: loadmodel.nodes.length - 1,
      planes: loadmodel.planes,
      clip_mins: new Vector(),
      clip_maxs: new Vector(),
    } as Hull;

    for (let i = 0; i < loadmodel.nodes.length; i++) {
      const node = loadmodel.nodes[i];
      const out = { planenum: node.planenum, children: [] } as Clipnode;
      const child0 = node.children[0] as Node;
      const child1 = node.children[1] as Node;
      out.children[0] = child0.contents < content.CONTENT_NONE ? child0.contents : child0.num;
      out.children[1] = child1.contents < content.CONTENT_NONE ? child1.contents : child1.num;
      clipnodes[i] = out;
    }
    loadmodel.hulls[0] = hull;
  }

  /**
   * Build a reachability mask for the clipnodes owned by a model headnode.
   * Legacy BSP29 clipnode arrays are shared across worldspawn and inline
   * submodels, so traces must stay within the owning subtree.
   * @returns A mask of reachable clipnodes, or null when the requested root is invalid.
   */
  _buildAllowedClipnodeMask(clipnodes: Clipnode[], firstclipnode: number): Uint8Array | null {
    if (!clipnodes || clipnodes.length === 0 || firstclipnode < 0 || firstclipnode >= clipnodes.length) {
      return null;
    }

    const allowedClipNodes = new Uint8Array(clipnodes.length);
    const stack = [firstclipnode];

    while (stack.length > 0) {
      const nodeIndex = stack.pop()!;

      if (nodeIndex < 0 || nodeIndex >= clipnodes.length || allowedClipNodes[nodeIndex] === 1) {
        continue;
      }

      allowedClipNodes[nodeIndex] = 1;

      const node = clipnodes[nodeIndex];
      if (!node) {
        continue;
      }

      for (const childIndex of node.children) {
        if (childIndex >= 0) {
          stack.push(childIndex);
        }
      }
    }

    return allowedClipNodes;
  }

  /**
   * Attach the owning subtree mask to a legacy hull.
   */
  #assignAllowedClipnodeMask(hull?: AllowedClipnodeHull): void {
    if (!hull || hull.firstclipnode === undefined) {
      return;
    }

    hull.allowedClipNodes = this._buildAllowedClipnodeMask(hull.clipnodes, hull.firstclipnode);
  }

  /**
   * Load marksurfaces (face indices visible from each leaf).
   */
  protected _loadMarksurfaces(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.marksurfaces << 3) + 4, true);
    const filelen = view.getUint32((lump.marksurfaces << 3) + 8, true);
    const count = filelen >> 1;
    loadmodel.marksurfaces.length = 0;

    for (let i = 0; i < count; i++) {
      const j = view.getUint16(fileofs + (i << 1), true);
      if (j > loadmodel.faces.length) {
        throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: bad surface number in marksurfaces');
      }
      loadmodel.marksurfaces[i] = j;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load submodels (brush models for doors, lifts, etc.).
   */
  #loadSubmodels(loadmodel: BrushModel, buf: ArrayBuffer): void {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.models << 3) + 4, true);
    const filelen = view.getUint32((lump.models << 3) + 8, true);
    const count = filelen >> 6;
    if (count === 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: no submodels');
    }
    loadmodel.submodels.length = 0;

    loadmodel.mins.setTo(view.getFloat32(fileofs, true) - 1.0, view.getFloat32(fileofs + 4, true) - 1.0, view.getFloat32(fileofs + 8, true) - 1.0);
    loadmodel.maxs.setTo(view.getFloat32(fileofs + 12, true) + 1.0, view.getFloat32(fileofs + 16, true) + 1.0, view.getFloat32(fileofs + 20, true) + 1.0);
    loadmodel.hulls[0].firstclipnode = view.getUint32(fileofs + 36, true);
    loadmodel.hulls[1].firstclipnode = view.getUint32(fileofs + 40, true);
    loadmodel.hulls[2].firstclipnode = view.getUint32(fileofs + 44, true);
    this.#assignAllowedClipnodeMask(loadmodel.hulls[0]);
    this.#assignAllowedClipnodeMask(loadmodel.hulls[1]);
    this.#assignAllowedClipnodeMask(loadmodel.hulls[2]);
    fileofs += 64;

    const clipnodes = loadmodel.hulls[0].clipnodes;
    for (let i = 1; i < count; i++) {
      const out = new BrushModel('*' + i);
      out.submodel = true;
      out.mins.setTo(view.getFloat32(fileofs, true) - 1.0, view.getFloat32(fileofs + 4, true) - 1.0, view.getFloat32(fileofs + 8, true) - 1.0);
      out.maxs.setTo(view.getFloat32(fileofs + 12, true) + 1.0, view.getFloat32(fileofs + 16, true) + 1.0, view.getFloat32(fileofs + 20, true) + 1.0);
      out.origin.setTo(view.getFloat32(fileofs + 24, true), view.getFloat32(fileofs + 28, true), view.getFloat32(fileofs + 32, true));
      out.hulls = [
        {
          clipnodes: clipnodes,
          firstclipnode: view.getUint32(fileofs + 36, true),
          lastclipnode: loadmodel.nodes.length - 1,
          planes: loadmodel.planes,
          clip_mins: new Vector(),
          clip_maxs: new Vector(),
        },
        {
          clipnodes: loadmodel.clipnodes,
          firstclipnode: view.getUint32(fileofs + 40, true),
          lastclipnode: loadmodel.clipnodes.length - 1,
          planes: loadmodel.planes,
          clip_mins: new Vector(-16.0, -16.0, -24.0),
          clip_maxs: new Vector(16.0, 16.0, 32.0),
        },
        {
          clipnodes: loadmodel.clipnodes,
          firstclipnode: view.getUint32(fileofs + 44, true),
          lastclipnode: loadmodel.clipnodes.length - 1,
          planes: loadmodel.planes,
          clip_mins: new Vector(-32.0, -32.0, -24.0),
          clip_maxs: new Vector(32.0, 32.0, 64.0),
        },
      ];
      this.#assignAllowedClipnodeMask(out.hulls[0]);
      this.#assignAllowedClipnodeMask(out.hulls[1]);
      this.#assignAllowedClipnodeMask(out.hulls[2]);
      out.vertexes = loadmodel.vertexes;
      out.edges = loadmodel.edges;
      out.surfedges = loadmodel.surfedges;
      out.nodes = loadmodel.nodes;
      out.leafs = loadmodel.leafs;
      out.texinfo = loadmodel.texinfo;
      out.textures = loadmodel.textures;
      out.marksurfaces = loadmodel.marksurfaces;
      out.lightdata = loadmodel.lightdata;
      out.lightdata_rgb = loadmodel.lightdata_rgb;
      out.deluxemap = loadmodel.deluxemap;
      out.faces = loadmodel.faces;
      out.visdata = loadmodel.visdata;
      out.numclusters = loadmodel.numclusters;
      out.clusterPvsOffsets = loadmodel.clusterPvsOffsets;
      out.phsdata = loadmodel.phsdata;
      out.clusterPhsOffsets = loadmodel.clusterPhsOffsets;
      out.firstface = view.getUint32(fileofs + 56, true);
      out.numfaces = view.getUint32(fileofs + 60, true);

      // Propagate brush data from world model to submodels (shared arrays)
      if (loadmodel.hasBrushData) {
        out.brushes = loadmodel.brushes;
        out.brushsides = loadmodel.brushsides;
        out.leafbrushes = loadmodel.leafbrushes;
        out.planes = loadmodel.planes;

        // Set per-submodel brush range from BRUSHLIST data
        const brushRange = loadmodel._brushRanges?.get(i);
        if (brushRange) {
          out.firstBrush = brushRange.firstBrush;
          out.numBrushes = brushRange.numBrushes;
        }
      }

      out.worldspawnInfo = loadmodel.worldspawnInfo;

      loadmodel.submodels[i - 1] = out;
      fileofs += 64;

      for (let j = 0; j < out.numfaces; j++) {
        out.faces[out.firstface + j].submodel = true;
      }
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load BSPX extended format data (optional extra lumps).
   */
  #loadBSPX(loadmodel: BrushModel, buffer: ArrayBuffer): void {
    loadmodel.bspxoffset = (loadmodel.bspxoffset + 3) & ~3;
    if (loadmodel.bspxoffset >= buffer.byteLength) {
      Con.DPrint('BSP29Loader: no BSPX data found\n');
      return;
    }

    const view = new DataView(buffer);
    const magic = view.getUint32(loadmodel.bspxoffset, true);
    console.assert(magic === 0x58505342, 'BSP29Loader: bad BSPX magic');

    const numlumps = view.getUint32(loadmodel.bspxoffset + 4, true);
    Con.DPrint(`BSP29Loader: found BSPX data with ${numlumps} lumps\n`);

    const bspxLumps: BSPXLumps = {};
    for (let i = 0, pointer = loadmodel.bspxoffset + 8; i < numlumps; i++, pointer += 32) {
      const name = Q.memstr(new Uint8Array(buffer, pointer, 24));
      const fileofs = view.getUint32(pointer + 24, true);
      const filelen = view.getUint32(pointer + 28, true);
      bspxLumps[name] = { fileofs, filelen };
    }
    loadmodel.bspxlumps = bspxLumps;
  }

  /**
   * Load BSPX BRUSHLIST lump if available.
   * Parses per-model brush data from the BSPX extension, creates Brush and
   * BrushSide objects, generates the 6 axial planes that the spec says must
   * be inferred from each brush's mins/maxs, and inserts brushes into BSP
   * leaf nodes so that BrushTrace can find them during collision testing.
   */
  _loadBrushList(loadmodel: BrushModel, buf: ArrayBuffer): void {
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['BRUSHLIST']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['BRUSHLIST'];

    if (filelen === 0) {
      return;
    }

    const view = new DataView(buf);
    let offset = fileofs;
    const endOffset = fileofs + filelen;

    const allBrushes: Brush[] = [];
    const allBrushSides: BrushSide[] = [];
    const allBrushPlanes: Plane[] = [];

    /**
     * Create a Plane with type and signbits set.
     * type: 0=X, 1=Y, 2=Z for axial, 3/4/5 for non-axial dominant axis.
     * @returns A plane with precomputed type and sign bits.
     */
    const makePlane = (normal: Vector, dist: number): Plane => {
      const p = new Plane(normal, dist);
      const ax = Math.abs(normal[0]);
      const ay = Math.abs(normal[1]);
      const az = Math.abs(normal[2]);
      if (ax === 1 && ay === 0 && az === 0) {
        p.type = 0;
      } else if (ax === 0 && ay === 1 && az === 0) {
        p.type = 1;
      } else if (ax === 0 && ay === 0 && az === 1) {
        p.type = 2;
      } else if (ax >= ay && ax >= az) {
        p.type = 3;
      } else if (ay >= ax && ay >= az) {
        p.type = 4;
      } else {
        p.type = 5;
      }
      if (normal[0] < 0) { p.signbits |= 1; }
      if (normal[1] < 0) { p.signbits |= 2; }
      if (normal[2] < 0) { p.signbits |= 4; }
      return p;
    };

    // Track per-model brush ranges for submodel assignment
    const modelBrushRanges = new Map<number, { firstBrush: number; numBrushes: number }>();

    while (offset + 16 <= endOffset) {
      const ver = view.getUint32(offset, true);
      offset += 4;

      if (ver !== 1) {
        Con.Print(`BSP29Loader: unsupported BRUSHLIST version ${ver}\n`);
        return;
      }

      const modelnum = view.getUint32(offset, true);
      offset += 4;
      const numbrushes = view.getUint32(offset, true);
      offset += 4;
      const numplanes = view.getUint32(offset, true);
      offset += 4;

      const firstBrush = allBrushes.length;

      let planesRead = 0;

      for (let b = 0; b < numbrushes; b++) {
        if (offset + 28 > endOffset) {
          Con.Print('BSP29Loader: BRUSHLIST lump truncated at brush header\n');
          return;
        }

        // Parse brush header: vec3 mins (12) + vec3 maxs (12) + short contents (2) + ushort numplanes (2) = 28 bytes
        // Actually: vec_t mins is 3 floats, vec_t maxs is 3 floats
        const bmins = new Vector(
          view.getFloat32(offset, true),
          view.getFloat32(offset + 4, true),
          view.getFloat32(offset + 8, true),
        );
        offset += 12;

        const bmaxs = new Vector(
          view.getFloat32(offset, true),
          view.getFloat32(offset + 4, true),
          view.getFloat32(offset + 8, true),
        );
        offset += 12;

        const brushContents = view.getInt16(offset, true);
        offset += 2;
        const brushNumPlanes = view.getUint16(offset, true);
        offset += 2;

        const firstside = allBrushSides.length;

        // Parse the non-axial planes from the lump
        if (offset + brushNumPlanes * 16 > endOffset) {
          Con.Print('BSP29Loader: BRUSHLIST lump truncated at brush planes\n');
          return;
        }

        for (let p = 0; p < brushNumPlanes; p++) {
          const normal = new Vector(
            view.getFloat32(offset, true),
            view.getFloat32(offset + 4, true),
            view.getFloat32(offset + 8, true),
          );
          const dist = view.getFloat32(offset + 12, true);
          offset += 16;

          const planeIdx = allBrushPlanes.length;
          allBrushPlanes.push(makePlane(normal, dist));

          const side = new BrushSide(loadmodel);
          side.planenum = planeIdx;
          allBrushSides.push(side);
        }

        // Generate the 6 axial planes inferred from mins/maxs.
        // Per the BSPX spec: "Axial planes MUST NOT be written - they will be
        // inferred from the brush's mins+maxs."
        // Keep these after the explicit non-axial planes to match FTE's
        // ordering and preserve equivalent tie-break behavior in collision.
        // +X, -X, +Y, -Y, +Z, -Z
        const axialDefs: [Vector, number][] = [
          [new Vector(1, 0, 0), bmaxs[0]],
          [new Vector(-1, 0, 0), -bmins[0]],
          [new Vector(0, 1, 0), bmaxs[1]],
          [new Vector(0, -1, 0), -bmins[1]],
          [new Vector(0, 0, 1), bmaxs[2]],
          [new Vector(0, 0, -1), -bmins[2]],
        ];

        for (const [normal, dist] of axialDefs) {
          const planeIdx = allBrushPlanes.length;
          allBrushPlanes.push(makePlane(normal, dist));

          const side = new BrushSide(loadmodel);
          side.planenum = planeIdx;
          allBrushSides.push(side);
        }

        planesRead += brushNumPlanes;

        const brush = new Brush(loadmodel);
        brush.firstside = firstside;
        brush.numsides = 6 + brushNumPlanes; // axial + explicit
        brush.contents = brushContents;
        brush.mins = bmins;
        brush.maxs = bmaxs;
        allBrushes.push(brush);
      }

      if (planesRead !== numplanes) {
        Con.Print(`BSP29Loader: BRUSHLIST plane count mismatch for model ${modelnum}: expected ${numplanes}, got ${planesRead}\n`);
      }

      modelBrushRanges.set(modelnum, { firstBrush, numBrushes: numbrushes });
    }

    if (allBrushes.length === 0) {
      return;
    }

    // Assign brush data to the world model
    loadmodel.brushes = allBrushes;
    loadmodel.brushsides = allBrushSides;

    // Use allBrushPlanes as a separate plane array for brush collision.
    // These are stored alongside BSP planes but indexed separately by brushsides.
    // We store them on the world model where BrushTrace can reference them.
    loadmodel.planes = loadmodel.planes.concat(allBrushPlanes);

    // Remap brushside plane indices to account for the offset into the combined array
    const planeOffset = loadmodel.planes.length - allBrushPlanes.length;
    for (const side of allBrushSides) {
      side.planenum += planeOffset;
    }

    // Insert brushes into BSP leaf nodes by walking the node tree.
    // Each model's brushes are only inserted under that model's headnode,
    // so that world traces don't collide with submodel brushes (func_plat,
    // trigger_*, func_door, etc.) and vice versa.

    const leafIndexMap = new Map<Node, number>();
    for (let i = 0; i < loadmodel.leafs.length; i++) {
      leafIndexMap.set(loadmodel.leafs[i], i);
    }

    const leafBrushLists: number[][] = new Array(loadmodel.leafs.length);
    for (let i = 0; i < loadmodel.leafs.length; i++) {
      leafBrushLists[i] = [];
    }

    /** Recursively insert a brush into BSP leaf nodes whose bounds overlap. */
    const insertBrushRecursive = (node: Node, brushIdx: number, brush: Brush): void => {
      // Leaf node: add the brush here
      if (node.contents < content.CONTENT_NONE) {
        const leafIndex = leafIndexMap.get(node);
        if (leafIndex !== undefined) {
          leafBrushLists[leafIndex].push(brushIdx);
        }
        return;
      }

      // Internal node: test brush AABB against splitting plane
      const plane = node.plane!;
      console.assert(plane !== undefined, 'BSP node without plane');

      let d1, d2;

      if (plane.type < 3) {
        // Axial plane: fast path
        d1 = brush.maxs![plane.type] - plane.dist;
        d2 = brush.mins![plane.type] - plane.dist;
      } else {
        // General plane: compute support points using worst-case AABB corners
        const nx = plane.normal[0];
        const ny = plane.normal[1];
        const nz = plane.normal[2];

        d1 = nx * (nx >= 0 ? brush.maxs![0] : brush.mins![0])
           + ny * (ny >= 0 ? brush.maxs![1] : brush.mins![1])
           + nz * (nz >= 0 ? brush.maxs![2] : brush.mins![2])
           - plane.dist;
        d2 = nx * (nx >= 0 ? brush.mins![0] : brush.maxs![0])
           + ny * (ny >= 0 ? brush.mins![1] : brush.maxs![1])
           + nz * (nz >= 0 ? brush.mins![2] : brush.maxs![2])
           - plane.dist;
      }

      if (d1 >= 0) {
        const frontChild = node.children[0];
        console.assert(frontChild !== null, 'brush insertion requires linked BSP child');

        if (frontChild !== null) {
          insertBrushRecursive(frontChild as Node, brushIdx, brush);
        }
      }
      // Brushes that touch the split plane on their back-most extent must be
      // inserted into both leaves. Otherwise exact-boundary player positions
      // can miss a clip brush in one leaf and hit it only after a tiny move
      // into the adjacent leaf, producing false stuck/allsolid behavior.
      if (d2 <= 0) {
        const backChild = node.children[1];
        console.assert(backChild !== null, 'brush insertion requires linked BSP child');

        if (backChild !== null) {
          insertBrushRecursive(backChild as Node, brushIdx, brush);
        }
      }
    };

    // Only insert world (model 0) brushes into leaf nodes.
    // Submodel brushes must NOT be inserted into the BSP leaf-brush index
    // because Q1 BSP leaf nodes are shared between the world tree and
    // submodel subtrees — inserting submodel brushes would make them
    // appear in world traces, causing phantom collisions with triggers,
    // removed entities (func_fog), etc.
    // Submodel collision is handled by brute-force testing against the
    // submodel's brush range (see BrushTrace.boxTraceModel).
    const worldRange = modelBrushRanges.get(0);
    if (worldRange) {
      const rootNode = loadmodel.nodes[0];
      if (rootNode) {
        for (let brushIdx = worldRange.firstBrush; brushIdx < worldRange.firstBrush + worldRange.numBrushes; brushIdx++) {
          insertBrushRecursive(rootNode, brushIdx, allBrushes[brushIdx]);
        }
      }
    }

    // Store brush ranges on the world model for submodel propagation
    loadmodel._brushRanges = modelBrushRanges;
    if (worldRange) {
      loadmodel.firstBrush = worldRange.firstBrush;
      loadmodel.numBrushes = worldRange.numBrushes;
    }

    // Build the flat leafbrushes array from per-leaf lists
    const leafbrushes: number[] = [];

    for (let i = 0; i < loadmodel.leafs.length; i++) {
      const leaf = loadmodel.leafs[i];
      const list = leafBrushLists[i];
      leaf.firstleafbrush = leafbrushes.length;
      leaf.numleafbrushes = list.length;
      for (const brushIdx of list) {
        leafbrushes.push(brushIdx);
      }
    }

    loadmodel.leafbrushes = leafbrushes;

    Con.DPrint(`BSP29Loader: loaded BRUSHLIST with ${allBrushes.length} brushes, ${allBrushSides.length} sides, ${leafbrushes.length} leaf-brush refs\n`);
  }

  /**
   * Load RGB colored lighting from BSPX lump if available.
   */
  #loadLightingRGB(loadmodel: BrushModel, buf: ArrayBuffer): void {
    loadmodel.lightdata_rgb = null;

    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['RGBLIGHTING']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['RGBLIGHTING'];

    if (filelen === 0) {
      return;
    }

    loadmodel.lightdata_rgb = new Uint8Array(buf.slice(fileofs, fileofs + filelen));
  }

  /**
   * Load external RGB lighting from .lit file if available.
   */
  async #loadExternalLighting(loadmodel: BrushModel, filename: string): Promise<void> {
    const rgbFilename = filename.replace(/\.bsp$/i, '.lit');

    const data = await COM.LoadFile(rgbFilename);

    if (!data) {
      Con.DPrint(`BSP29Loader: no external RGB lighting file found: ${rgbFilename}\n`);
      return;
    }

    const dv = new DataView(data);

    console.assert(dv.getUint32(0, true) === 0x54494C51, 'QLIT header');
    console.assert(dv.getUint32(4, true) === 0x00000001, 'QLIT version 1');

    loadmodel.lightdata_rgb = new Uint8Array(data.slice(8)); // Skip header
  }

  /**
   * Load deluxemap (directional lighting normals) from BSPX lump if available.
   */
  #loadDeluxeMap(loadmodel: BrushModel, buf: ArrayBuffer): void {
    loadmodel.deluxemap = null;

    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTINGDIR']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTINGDIR'];

    if (filelen === 0) {
      return;
    }

    loadmodel.deluxemap = new Uint8Array(buf.slice(fileofs, fileofs + filelen));
  }

  /**
   * Load lightgrid octree from BSPX lump if available.
   */
  #loadLightgridOctree(loadmodel: BrushModel, buf: ArrayBuffer): void {
    loadmodel.lightgrid = null;

    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTGRID_OCTREE']) {
      return;
    }

    const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTGRID_OCTREE'];

    if (filelen === 0) {
      return;
    }

    try {
      const view = new DataView(buf);
      let offset = fileofs;
      const endOffset = fileofs + filelen;

      // Minimum size check: vec3_t step (12) + ivec3_t size (12) + vec3_t mins (12) + byte numstyles (1) + uint32_t rootnode (4) + uint32_t numnodes (4) + uint32_t numleafs (4) = 49 bytes
      if (filelen < 49) {
        Con.DPrint('BSP29Loader: LIGHTGRID_OCTREE lump too small\n');
        return;
      }

      // vec3_t step
      const step: [number, number, number] = [
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      ];
      offset += 12;

      // ivec3_t size
      const size: [number, number, number] = [
        view.getInt32(offset, true),
        view.getInt32(offset + 4, true),
        view.getInt32(offset + 8, true),
      ];
      offset += 12;

      // vec3_t mins
      const mins = new Vector(
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      );
      offset += 12;

      // byte numstyles (WARNING: misaligns the rest of the data)
      const numstyles = view.getUint8(offset);
      offset += 1;

      // uint32_t rootnode
      const rootnode = view.getUint32(offset, true);
      offset += 4;

      // uint32_t numnodes
      const numnodes = view.getUint32(offset, true);
      offset += 4;

      // Check if we have enough data for nodes (each node is 44 bytes: 3*4 for mid + 8*4 for children)
      if (offset + (numnodes * 44) > endOffset) {
        Con.DPrint('BSP29Loader: LIGHTGRID_OCTREE nodes data truncated\n');
        return;
      }

      // Parse nodes
      const nodes = [] as LightgridNode[];
      for (let i = 0; i < numnodes; i++) {
        const mid = [
          view.getUint32(offset, true),
          view.getUint32(offset + 4, true),
          view.getUint32(offset + 8, true),
        ] as [number, number, number];
        offset += 12;

        const child = [] as number[];
        for (let j = 0; j < 8; j++) {
          child[j] = view.getUint32(offset, true);
          offset += 4;
        }

        nodes[i] = { mid, child };
      }

      // uint32_t numleafs
      if (offset + 4 > endOffset) {
        Con.DPrint('BSP29Loader: LIGHTGRID_OCTREE numleafs missing\n');
        return;
      }
      const numleafs = view.getUint32(offset, true);
      offset += 4;

      // Parse leafs
      const leafs = [] as LightgridLeaf[];
      for (let i = 0; i < numleafs; i++) {
        // Check bounds for leaf header (mins + size = 24 bytes)
        if (offset + 24 > endOffset) {
          Con.DPrint(`BSP29Loader: LIGHTGRID_OCTREE leaf ${i} header truncated\n`);
          return;
        }

        const leafMins: [number, number, number] = [
          view.getInt32(offset, true),
          view.getInt32(offset + 4, true),
          view.getInt32(offset + 8, true),
        ];
        offset += 12;

        const leafSize: [number, number, number] = [
          view.getInt32(offset, true),
          view.getInt32(offset + 4, true),
          view.getInt32(offset + 8, true),
        ];
        offset += 12;

        // Parse per-point data
        const totalPoints = leafSize[0] * leafSize[1] * leafSize[2];
        const points = [] as LightgridPointSample[];

        for (let p = 0; p < totalPoints; p++) {
          // Check bounds for stylecount byte
          if (offset >= endOffset) {
            Con.DPrint(`BSP29Loader: LIGHTGRID_OCTREE leaf ${i} point ${p} truncated\n`);
            return;
          }

          const stylecount = view.getUint8(offset);
          offset += 1;

          // Skip points with no data (stylecount = 0xff means missing)
          if (stylecount === 0xff) {
            points.push({ stylecount, styles: [] });
            continue;
          }

          const styles = [] as LightgridStyleSample[];
          for (let s = 0; s < stylecount; s++) {
            // Check bounds for style data (1 byte stylenum + 3 bytes rgb = 4 bytes)
            if (offset + 3 >= endOffset) {
              Con.DPrint(`BSP29Loader: LIGHTGRID_OCTREE leaf ${i} point ${p} style ${s} truncated\n`);
              return;
            }

            const stylenum = view.getUint8(offset);

            offset += 1;

            const rgb = [
              view.getUint8(offset),
              view.getUint8(offset + 1),
              view.getUint8(offset + 2),
            ] as [number, number, number];
            offset += 3;

            styles.push({ stylenum, rgb });
          }

          points.push({ stylecount, styles });
        }

        leafs.push({ mins: leafMins, size: leafSize, points });
      }

      loadmodel.lightgrid = {
        step,
        size,
        mins,
        numstyles,
        rootnode,
        nodes,
        leafs,
      };

      Con.DPrint(`BSP29Loader: loaded LIGHTGRID_OCTREE with ${numnodes} nodes and ${numleafs} leafs\n`);
    } catch (error) {
      if (error instanceof Error) {
        Con.PrintError(`BSP29Loader: error loading LIGHTGRID_OCTREE: ${error.message}\n`);
      } else {
        Con.PrintError('BSP29Loader: error loading LIGHTGRID_OCTREE\n');
        // eslint-disable-next-line no-debugger
        debugger;
      }
      loadmodel.lightgrid = null;
    }
  }
}
