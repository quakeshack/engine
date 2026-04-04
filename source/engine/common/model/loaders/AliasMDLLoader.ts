import Vector from '../../../../shared/Vector.ts';
import Q from '../../../../shared/Q.ts';
import GL, { GLTexture, resampleTexture8 } from '../../../client/GL.ts';
import { registry } from '../../../registry.mjs';
import { CRC16CCITT } from '../../CRC.ts';
import W, { translateIndexToLuminanceRGBA, translateIndexToRGBA } from '../../W.ts';
import { AliasModel, type AliasFrame, type AliasSkin } from '../AliasModel.ts';
import { ModelLoader } from '../ModelLoader.ts';

interface AliasSkinLayers {
  readonly diffuse: Uint8Array;
  readonly luminance: Uint8Array;
}


interface MutableAliasSingleSkin {
  group: false;
  texturenum: GLTexture | null;
  luminanceTexture: GLTexture | null;
  translated?: Uint8Array;
  playertexture?: GLTexture | null;
}

interface MutableAliasGroupedSkinEntry {
  interval: number;
  texturenum?: GLTexture | null;
  luminanceTexture?: GLTexture | null;
  translated?: Uint8Array;
  playertexture?: GLTexture | null;
}

interface MutableAliasGroupedSkin {
  group: true;
  skins: MutableAliasGroupedSkinEntry[];
}

interface MutableAliasPoseVertex {
  v: Vector;
  lightnormalindex: number;
}

interface MutableAliasSingleFrame {
  group: false;
  bboxmin: Vector;
  bboxmax: Vector;
  name: string;
  v: MutableAliasPoseVertex[];
  cmdofs?: number;
}

interface MutableAliasGroupedFrameEntry {
  interval: number;
  bboxmin: Vector;
  bboxmax: Vector;
  name: string;
  v: MutableAliasPoseVertex[];
  cmdofs?: number;
}

interface MutableAliasGroupedFrame {
  group: true;
  bboxmin: Vector;
  bboxmax: Vector;
  frames: MutableAliasGroupedFrameEntry[];
}

type MutableAliasFrame = MutableAliasSingleFrame | MutableAliasGroupedFrame;
type MutableAliasSkin = MutableAliasSingleSkin | MutableAliasGroupedSkin;

/**
 * Builds the diffuse and luminance skin layers for a legacy alias model skin.
 * Fullbright indexed colors stay emissive-only in the luminance layer.
 * @returns The translated diffuse and luminance texture layers.
 */
export function buildAliasSkinLayers(
  skin: Uint8Array,
  width: number,
  height: number,
  palette: Uint8Array = W.d_8to24table_u8,
  transparentColor: number | null = null,
  fullbrightColorStart = 240,
): AliasSkinLayers {
  return {
    diffuse: translateIndexToRGBA(skin, width, height, palette, transparentColor, fullbrightColorStart),
    luminance: translateIndexToLuminanceRGBA(skin, width, height, palette, transparentColor, fullbrightColorStart),
  };
}

/**
 * Pre-computed vertex normals for Quake's Alias Model format.
 *
 * This is a lookup table of 162 pre-calculated normal vectors used for lighting calculations
 * in Quake's MDL format. Each vertex in a frame stores a `lightnormalindex` (0-161) that
 * references one of these normals instead of storing the full normal vector, saving memory.
 *
 * The normals are organized as a flat array where every 3 consecutive values represent
 * a single unit normal vector (x, y, z). These normals are strategically distributed
 * around a sphere to provide good coverage for lighting any surface orientation.
 *
 * During rendering, the lightnormalindex is used to lookup the corresponding normal
 * from this table for proper lighting calculations.
 * @readonly
 */
export const avertexnormals = new Float32Array([
  -0.525731, 0.0, 0.850651,
  -0.442863, 0.238856, 0.864188,
  -0.295242, 0.0, 0.955423,
  -0.309017, 0.5, 0.809017,
  -0.16246, 0.262866, 0.951056,
  0.0, 0.0, 1.0,
  0.0, 0.850651, 0.525731,
  -0.147621, 0.716567, 0.681718,
  0.147621, 0.716567, 0.681718,
  0.0, 0.525731, 0.850651,
  0.309017, 0.5, 0.809017,
  0.525731, 0.0, 0.850651,
  0.295242, 0.0, 0.955423,
  0.442863, 0.238856, 0.864188,
  0.16246, 0.262866, 0.951056,
  -0.681718, 0.147621, 0.716567,
  -0.809017, 0.309017, 0.5,
  -0.587785, 0.425325, 0.688191,
  -0.850651, 0.525731, 0.0,
  -0.864188, 0.442863, 0.238856,
  -0.716567, 0.681718, 0.147621,
  -0.688191, 0.587785, 0.425325,
  -0.5, 0.809017, 0.309017,
  -0.238856, 0.864188, 0.442863,
  -0.425325, 0.688191, 0.587785,
  -0.716567, 0.681718, -0.147621,
  -0.5, 0.809017, -0.309017,
  -0.525731, 0.850651, 0.0,
  0.0, 0.850651, -0.525731,
  -0.238856, 0.864188, -0.442863,
  0.0, 0.955423, -0.295242,
  -0.262866, 0.951056, -0.16246,
  0.0, 1.0, 0.0,
  0.0, 0.955423, 0.295242,
  -0.262866, 0.951056, 0.16246,
  0.238856, 0.864188, 0.442863,
  0.262866, 0.951056, 0.16246,
  0.5, 0.809017, 0.309017,
  0.238856, 0.864188, -0.442863,
  0.262866, 0.951056, -0.16246,
  0.5, 0.809017, -0.309017,
  0.850651, 0.525731, 0.0,
  0.716567, 0.681718, 0.147621,
  0.716567, 0.681718, -0.147621,
  0.525731, 0.850651, 0.0,
  0.425325, 0.688191, 0.587785,
  0.864188, 0.442863, 0.238856,
  0.688191, 0.587785, 0.425325,
  0.809017, 0.309017, 0.5,
  0.681718, 0.147621, 0.716567,
  0.587785, 0.425325, 0.688191,
  0.955423, 0.295242, 0.0,
  1.0, 0.0, 0.0,
  0.951056, 0.16246, 0.262866,
  0.850651, -0.525731, 0.0,
  0.955423, -0.295242, 0.0,
  0.864188, -0.442863, 0.238856,
  0.951056, -0.16246, 0.262866,
  0.809017, -0.309017, 0.5,
  0.681718, -0.147621, 0.716567,
  0.850651, 0.0, 0.525731,
  0.864188, 0.442863, -0.238856,
  0.809017, 0.309017, -0.5,
  0.951056, 0.16246, -0.262866,
  0.525731, 0.0, -0.850651,
  0.681718, 0.147621, -0.716567,
  0.681718, -0.147621, -0.716567,
  0.850651, 0.0, -0.525731,
  0.809017, -0.309017, -0.5,
  0.864188, -0.442863, -0.238856,
  0.951056, -0.16246, -0.262866,
  0.147621, 0.716567, -0.681718,
  0.309017, 0.5, -0.809017,
  0.425325, 0.688191, -0.587785,
  0.442863, 0.238856, -0.864188,
  0.587785, 0.425325, -0.688191,
  0.688191, 0.587785, -0.425325,
  -0.147621, 0.716567, -0.681718,
  -0.309017, 0.5, -0.809017,
  0.0, 0.525731, -0.850651,
  -0.525731, 0.0, -0.850651,
  -0.442863, 0.238856, -0.864188,
  -0.295242, 0.0, -0.955423,
  -0.16246, 0.262866, -0.951056,
  0.0, 0.0, -1.0,
  0.295242, 0.0, -0.955423,
  0.16246, 0.262866, -0.951056,
  -0.442863, -0.238856, -0.864188,
  -0.309017, -0.5, -0.809017,
  -0.16246, -0.262866, -0.951056,
  0.0, -0.850651, -0.525731,
  -0.147621, -0.716567, -0.681718,
  0.147621, -0.716567, -0.681718,
  0.0, -0.525731, -0.850651,
  0.309017, -0.5, -0.809017,
  0.442863, -0.238856, -0.864188,
  0.16246, -0.262866, -0.951056,
  0.238856, -0.864188, -0.442863,
  0.5, -0.809017, -0.309017,
  0.425325, -0.688191, -0.587785,
  0.716567, -0.681718, -0.147621,
  0.688191, -0.587785, -0.425325,
  0.587785, -0.425325, -0.688191,
  0.0, -0.955423, -0.295242,
  0.0, -1.0, 0.0,
  0.262866, -0.951056, -0.16246,
  0.0, -0.850651, 0.525731,
  0.0, -0.955423, 0.295242,
  0.238856, -0.864188, 0.442863,
  0.262866, -0.951056, 0.16246,
  0.5, -0.809017, 0.309017,
  0.716567, -0.681718, 0.147621,
  0.525731, -0.850651, 0.0,
  -0.238856, -0.864188, -0.442863,
  -0.5, -0.809017, -0.309017,
  -0.262866, -0.951056, -0.16246,
  -0.850651, -0.525731, 0.0,
  -0.716567, -0.681718, -0.147621,
  -0.716567, -0.681718, 0.147621,
  -0.525731, -0.850651, 0.0,
  -0.5, -0.809017, 0.309017,
  -0.238856, -0.864188, 0.442863,
  -0.262866, -0.951056, 0.16246,
  -0.864188, -0.442863, 0.238856,
  -0.809017, -0.309017, 0.5,
  -0.688191, -0.587785, 0.425325,
  -0.681718, -0.147621, 0.716567,
  -0.442863, -0.238856, 0.864188,
  -0.587785, -0.425325, 0.688191,
  -0.309017, -0.5, 0.809017,
  -0.147621, -0.716567, 0.681718,
  -0.425325, -0.688191, 0.587785,
  -0.16246, -0.262866, 0.951056,
  0.442863, -0.238856, 0.864188,
  0.16246, -0.262866, 0.951056,
  0.309017, -0.5, 0.809017,
  0.147621, -0.716567, 0.681718,
  0.0, -0.525731, 0.850651,
  0.425325, -0.688191, 0.587785,
  0.587785, -0.425325, 0.688191,
  0.688191, -0.587785, 0.425325,
  -0.955423, 0.295242, 0.0,
  -0.951056, 0.16246, 0.262866,
  -1.0, 0.0, 0.0,
  -0.850651, 0.0, 0.525731,
  -0.955423, -0.295242, 0.0,
  -0.951056, -0.16246, 0.262866,
  -0.864188, 0.442863, -0.238856,
  -0.951056, 0.16246, -0.262866,
  -0.809017, 0.309017, -0.5,
  -0.864188, -0.442863, -0.238856,
  -0.951056, -0.16246, -0.262866,
  -0.809017, -0.309017, -0.5,
  -0.681718, 0.147621, -0.716567,
  -0.681718, -0.147621, -0.716567,
  -0.850651, 0.0, -0.525731,
  -0.688191, 0.587785, -0.425325,
  -0.587785, 0.425325, -0.688191,
  -0.425325, 0.688191, -0.587785,
  -0.425325, -0.688191, -0.587785,
  -0.587785, -0.425325, -0.688191,
  -0.688191, -0.587785, -0.425325,
]);

/**
 * Loader for Quake Alias Model format (.mdl).
 * Magic: 0x4f504449 ("IDPO")
 * Version: 6
 */
export class AliasMDLLoader extends ModelLoader {
  override getMagicNumbers(): number[] {
    return [0x4f504449]; // "IDPO"
  }

  override getExtensions(): string[] {
    return ['.mdl'];
  }

  override getName(): string {
    return 'Quake Alias';
  }

  /**
   * Load an Alias MDL model from buffer.
   * @returns The loaded alias model.
   */
  override load(buffer: ArrayBuffer, name: string): Promise<AliasModel> {
    const loadmodel = new AliasModel(name);

    loadmodel.type = 2; // Mod.type.alias
    loadmodel.player = name === 'progs/player.mdl';

    const view = new DataView(buffer);
    const version = view.getUint32(4, true);

    if (version !== 6) {
      throw new Error(`${name} has wrong version number (${version} should be 6)`);
    }

    // Read header
    loadmodel._scale = new Vector(
      view.getFloat32(8, true),
      view.getFloat32(12, true),
      view.getFloat32(16, true),
    );
    loadmodel._scale_origin = new Vector(
      view.getFloat32(20, true),
      view.getFloat32(24, true),
      view.getFloat32(28, true),
    );
    loadmodel.boundingradius = view.getFloat32(32, true);
    loadmodel._num_skins = view.getUint32(48, true);

    if (loadmodel._num_skins === 0) {
      throw new Error(`model ${name} has no skins`);
    }

    loadmodel._skin_width = view.getUint32(52, true);
    loadmodel._skin_height = view.getUint32(56, true);
    loadmodel._num_verts = view.getUint32(60, true);

    if (loadmodel._num_verts === 0) {
      throw new Error(`model ${name} has no vertices`);
    }

    loadmodel._num_tris = view.getUint32(64, true);

    if (loadmodel._num_tris === 0) {
      throw new Error(`model ${name} has no triangles`);
    }

    loadmodel._frames = view.getUint32(68, true);

    if (loadmodel._frames === 0) {
      throw new Error(`model ${name} has no frames`);
    }

    loadmodel.random = view.getUint32(72, true) === 1;
    loadmodel.flags = view.getUint32(76, true);
    loadmodel.mins = new Vector(-16.0, -16.0, -16.0);
    loadmodel.maxs = new Vector(16.0, 16.0, 16.0);

    // Load model data
    let inmodel = this.#loadAllSkins(loadmodel, buffer, 84);
    inmodel = this.#loadSTVerts(loadmodel, buffer, inmodel);
    inmodel = this.#loadTriangles(loadmodel, buffer, inmodel);
    this.#loadAllFrames(loadmodel, buffer, inmodel);

    // Prepare rendering data (if not dedicated server)
    if (!registry.isDedicatedServer) {
      this.#buildRenderCommands(loadmodel);
    }

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return Promise.resolve(loadmodel);
  }

  /**
   * Load ST (texture coordinate) vertices.
   * @returns The next byte offset after the ST vertex block.
   */
  #loadSTVerts(loadmodel: AliasModel, buffer: ArrayBuffer, inmodel: number): number {
    const view = new DataView(buffer);
    loadmodel._stverts.length = loadmodel._num_verts;

    for (let index = 0; index < loadmodel._num_verts; index++) {
      loadmodel._stverts[index] = {
        onseam: view.getUint32(inmodel, true) !== 0,
        s: view.getUint32(inmodel + 4, true),
        t: view.getUint32(inmodel + 8, true),
      };
      inmodel += 12;
    }

    return inmodel;
  }

  /**
   * Load triangles.
   * @returns The next byte offset after the triangle block.
   */
  #loadTriangles(loadmodel: AliasModel, buffer: ArrayBuffer, inmodel: number): number {
    const view = new DataView(buffer);
    loadmodel._triangles.length = loadmodel._num_tris;

    for (let index = 0; index < loadmodel._num_tris; index++) {
      loadmodel._triangles[index] = {
        facesfront: view.getUint32(inmodel, true) !== 0,
        vertindex: [
          view.getUint32(inmodel + 4, true),
          view.getUint32(inmodel + 8, true),
          view.getUint32(inmodel + 12, true),
        ],
      };
      inmodel += 16;
    }

    return inmodel;
  }

  /**
   * Flood fill skin to handle transparent areas.
   */
  #floodFillSkin(loadmodel: AliasModel, skin: Uint8Array): void {
    const fillcolor = skin[0];
    const filledcolor = W.filledColor;

    if (fillcolor === filledcolor) {
      return;
    }

    const width = loadmodel._skin_width;
    const height = loadmodel._skin_height;
    const lifo: Array<[number, number]> = [[0, 0]];

    for (let stackPointer = 1; stackPointer > 0;) {
      const [x, y] = lifo[--stackPointer];
      skin[y * width + x] = filledcolor;

      if (x > 0 && skin[y * width + x - 1] === fillcolor) {
        lifo[stackPointer++] = [x - 1, y];
      }
      if (x < (width - 1) && skin[y * width + x + 1] === fillcolor) {
        lifo[stackPointer++] = [x + 1, y];
      }
      if (y > 0 && skin[(y - 1) * width + x] === fillcolor) {
        lifo[stackPointer++] = [x, y - 1];
      }
      if (y < (height - 1) && skin[(y + 1) * width + x] === fillcolor) {
        lifo[stackPointer++] = [x, y + 1];
      }
    }
  }

  /**
   * Translate player skin for color customization.
   */
  #translatePlayerSkin(loadmodel: AliasModel, data: Uint8Array, skin: MutableAliasSkin): void {
    if (registry.isDedicatedServer) {
      return;
    }

    if (loadmodel._skin_width !== 512 || loadmodel._skin_height !== 256) {
      data = resampleTexture8(data, loadmodel._skin_width, loadmodel._skin_height, 512, 256);
    }

    const out = new Uint8Array(524288);

    for (let index = 0; index < 131072; index++) {
      const original = data[index];
      if ((original >> 4) === 1) {
        out[index << 2] = (original & 15) * 17;
        out[(index << 2) + 1] = 255;
      } else if ((original >> 4) === 6) {
        out[(index << 2) + 2] = (original & 15) * 17;
        out[(index << 2) + 3] = 255;
      }
    }

    skin.playertexture = GLTexture.Allocate(`${loadmodel.name}_playerskin`, 512, 256, out);
  }

  /**
   * Load all skins (textures) for the model.
   * @returns The next byte offset after the skin data.
   */
  #loadAllSkins(loadmodel: AliasModel, buffer: ArrayBuffer, inmodel: number): number {
    loadmodel.skins.length = loadmodel._num_skins;
    const view = new DataView(buffer);
    const skinsize = loadmodel._skin_width * loadmodel._skin_height;

    for (let skinIndex = 0; skinIndex < loadmodel._num_skins; skinIndex++) {
      inmodel += 4;

      if (view.getUint32(inmodel - 4, true) === 0) {
        // Single skin
        const skin = new Uint8Array(buffer, inmodel, skinsize);
        this.#floodFillSkin(loadmodel, skin);
        const { diffuse, luminance } = buildAliasSkinLayers(skin, loadmodel._skin_width, loadmodel._skin_height);
        const singleSkin: MutableAliasSingleSkin = {
          group: false,
          texturenum: !registry.isDedicatedServer
            ? GLTexture.Allocate(`${loadmodel.name}_${skinIndex}`, loadmodel._skin_width, loadmodel._skin_height, diffuse)
            : null,
          luminanceTexture: !registry.isDedicatedServer
            ? GLTexture.Allocate(`${loadmodel.name}_${skinIndex}_luma`, loadmodel._skin_width, loadmodel._skin_height, luminance)
            : null,
        };

        loadmodel.skins[skinIndex] = singleSkin as AliasSkin;

        if (loadmodel.player === true) {
          this.#translatePlayerSkin(loadmodel, new Uint8Array(buffer, inmodel, skinsize), singleSkin);
        }

        inmodel += skinsize;
      } else {
        // Skin group (animated skins)
        const group: MutableAliasGroupedSkin = {
          group: true,
          skins: [],
        };
        const numskins = view.getUint32(inmodel, true);
        inmodel += 4;

        for (let groupIndex = 0; groupIndex < numskins; groupIndex++) {
          group.skins[groupIndex] = { interval: view.getFloat32(inmodel, true) };
          if (group.skins[groupIndex].interval <= 0.0) {
            throw new Error('AliasMDLLoader: skin interval <= 0');
          }
          inmodel += 4;
        }

        for (let groupIndex = 0; groupIndex < numskins; groupIndex++) {
          const skin = new Uint8Array(buffer, inmodel, skinsize);
          this.#floodFillSkin(loadmodel, skin);
          const { diffuse, luminance } = buildAliasSkinLayers(skin, loadmodel._skin_width, loadmodel._skin_height);

          group.skins[groupIndex].texturenum = !registry.isDedicatedServer
            ? GLTexture.Allocate(`${loadmodel.name}_${skinIndex}_${groupIndex}`, loadmodel._skin_width, loadmodel._skin_height, diffuse)
            : null;
          group.skins[groupIndex].luminanceTexture = !registry.isDedicatedServer
            ? GLTexture.Allocate(`${loadmodel.name}_${skinIndex}_${groupIndex}_luma`, loadmodel._skin_width, loadmodel._skin_height, luminance)
            : null;

          if (loadmodel.player === true) {
            this.#translatePlayerSkin(loadmodel, new Uint8Array(buffer, inmodel, skinsize), group.skins[groupIndex]);
          }

          inmodel += skinsize;
        }

        loadmodel.skins[skinIndex] = group as AliasSkin;
      }
    }

    return inmodel;
  }

  /**
   * Load all animation frames.
   */
  #loadAllFrames(loadmodel: AliasModel, buffer: ArrayBuffer, inmodel: number): void {
    loadmodel.frames = [];
    const view = new DataView(buffer);

    for (let frameIndex = 0; frameIndex < loadmodel._frames; frameIndex++) {
      inmodel += 4;

      if (view.getUint32(inmodel - 4, true) === 0) {
        // Single frame
        const frame: MutableAliasSingleFrame = {
          group: false,
          bboxmin: new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2)),
          bboxmax: new Vector(view.getUint8(inmodel + 4), view.getUint8(inmodel + 5), view.getUint8(inmodel + 6)),
          name: Q.memstr(new Uint8Array(buffer, inmodel + 8, 16)),
          v: [],
        };
        inmodel += 24;

        for (let vertexIndex = 0; vertexIndex < loadmodel._num_verts; vertexIndex++) {
          frame.v[vertexIndex] = {
            v: new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2)),
            lightnormalindex: view.getUint8(inmodel + 3),
          };
          inmodel += 4;
        }

        loadmodel.frames[frameIndex] = frame as AliasFrame;
      } else {
        // Frame group (animated frames)
        const group: MutableAliasGroupedFrame = {
          group: true,
          bboxmin: new Vector(view.getUint8(inmodel + 4), view.getUint8(inmodel + 5), view.getUint8(inmodel + 6)),
          bboxmax: new Vector(view.getUint8(inmodel + 8), view.getUint8(inmodel + 9), view.getUint8(inmodel + 10)),
          frames: [],
        };
        const numframes = view.getUint32(inmodel, true);
        inmodel += 12;

        for (let groupIndex = 0; groupIndex < numframes; groupIndex++) {
          group.frames[groupIndex] = {
            interval: view.getFloat32(inmodel, true),
            bboxmin: new Vector(),
            bboxmax: new Vector(),
            name: '',
            v: [],
          };
          if (group.frames[groupIndex].interval <= 0.0) {
            throw new Error('AliasMDLLoader: frame interval <= 0');
          }
          inmodel += 4;
        }

        for (let groupIndex = 0; groupIndex < numframes; groupIndex++) {
          const frame = group.frames[groupIndex];
          frame.bboxmin = new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2));
          frame.bboxmax = new Vector(view.getUint8(inmodel + 4), view.getUint8(inmodel + 5), view.getUint8(inmodel + 6));
          frame.name = Q.memstr(new Uint8Array(buffer, inmodel + 8, 16));
          frame.v = [];
          inmodel += 24;

          for (let vertexIndex = 0; vertexIndex < loadmodel._num_verts; vertexIndex++) {
            frame.v[vertexIndex] = {
              v: new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2)),
              lightnormalindex: view.getUint8(inmodel + 3),
            };
            inmodel += 4;
          }
        }

        loadmodel.frames[frameIndex] = group as AliasFrame;
      }
    }
  }

  /**
   * Build rendering commands (WebGL buffers) for efficient rendering.
   */
  #buildRenderCommands(loadmodel: AliasModel): void {
    const gl = GL.gl;
    const scale = loadmodel._scale;
    const scaleOrigin = loadmodel._scale_origin;

    console.assert(scale !== null && scaleOrigin !== null);

    const activeScale = scale!;
    const activeScaleOrigin = scaleOrigin!;

    const cmds: number[] = [];

    // Build texture coordinates
    for (let triangleIndex = 0; triangleIndex < loadmodel._num_tris; triangleIndex++) {
      const triangle = loadmodel._triangles[triangleIndex];

      if (triangle.facesfront === true) {
        const vert0 = loadmodel._stverts[triangle.vertindex[0]];
        cmds.push((vert0.s + 0.5) / loadmodel._skin_width);
        cmds.push((vert0.t + 0.5) / loadmodel._skin_height);

        const vert1 = loadmodel._stverts[triangle.vertindex[1]];
        cmds.push((vert1.s + 0.5) / loadmodel._skin_width);
        cmds.push((vert1.t + 0.5) / loadmodel._skin_height);

        const vert2 = loadmodel._stverts[triangle.vertindex[2]];
        cmds.push((vert2.s + 0.5) / loadmodel._skin_width);
        cmds.push((vert2.t + 0.5) / loadmodel._skin_height);
        continue;
      }

      for (let vertexOffset = 0; vertexOffset < 3; vertexOffset++) {
        const vert = loadmodel._stverts[triangle.vertindex[vertexOffset]];
        if (vert.onseam === true) {
          cmds.push((vert.s + loadmodel._skin_width / 2 + 0.5) / loadmodel._skin_width);
        } else {
          cmds.push((vert.s + 0.5) / loadmodel._skin_width);
        }
        cmds.push((vert.t + 0.5) / loadmodel._skin_height);
      }
    }

    // Build vertex data for each frame
    for (let frameIndex = 0; frameIndex < loadmodel.frames.length; frameIndex++) {
      const group = loadmodel.frames[frameIndex] as MutableAliasFrame;

      if (group.group === true) {
        for (let groupIndex = 0; groupIndex < group.frames.length; groupIndex++) {
          const frame = group.frames[groupIndex];
          frame.cmdofs = cmds.length * 4;

          for (let triangleIndex = 0; triangleIndex < loadmodel._num_tris; triangleIndex++) {
            const triangle = loadmodel._triangles[triangleIndex];

            for (let vertexOffset = 0; vertexOffset < 3; vertexOffset++) {
              const vert = frame.v[triangle.vertindex[vertexOffset]];
              console.assert(vert.lightnormalindex < avertexnormals.length / 3);
              cmds.push(vert.v[0] * activeScale[0] + activeScaleOrigin[0]);
              cmds.push(vert.v[1] * activeScale[1] + activeScaleOrigin[1]);
              cmds.push(vert.v[2] * activeScale[2] + activeScaleOrigin[2]);
              cmds.push(avertexnormals[vert.lightnormalindex * 3]);
              cmds.push(avertexnormals[vert.lightnormalindex * 3 + 1]);
              cmds.push(avertexnormals[vert.lightnormalindex * 3 + 2]);
            }
          }
        }
        continue;
      }

      const frame = group;
      frame.cmdofs = cmds.length * 4;

      for (let triangleIndex = 0; triangleIndex < loadmodel._num_tris; triangleIndex++) {
        const triangle = loadmodel._triangles[triangleIndex];

        for (let vertexOffset = 0; vertexOffset < 3; vertexOffset++) {
          const vert = frame.v[triangle.vertindex[vertexOffset]];
          console.assert(vert.lightnormalindex < avertexnormals.length / 3);
          cmds.push(vert.v[0] * activeScale[0] + activeScaleOrigin[0]);
          cmds.push(vert.v[1] * activeScale[1] + activeScaleOrigin[1]);
          cmds.push(vert.v[2] * activeScale[2] + activeScaleOrigin[2]);
          cmds.push(avertexnormals[vert.lightnormalindex * 3]);
          cmds.push(avertexnormals[vert.lightnormalindex * 3 + 1]);
          cmds.push(avertexnormals[vert.lightnormalindex * 3 + 2]);
        }
      }

      frame.v.length = 0; // Free memory
    }

    // Upload to WebGL
    loadmodel.cmds = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, loadmodel.cmds);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
  }
}
