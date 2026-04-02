import Vector from '../../../../shared/Vector.ts';
import Q from '../../../../shared/Q.mjs';
import GL, { GLTexture, resampleTexture8 } from '../../../client/GL.mjs';
import W, { translateIndexToLuminanceRGBA, translateIndexToRGBA } from '../../W.mjs';
import { CRC16CCITT } from '../../CRC.mjs';
import { registry } from '../../../registry.mjs';
import { ModelLoader } from '../ModelLoader.mjs';
import { AliasModel } from '../AliasModel.mjs';

/**
 * Builds the diffuse and luminance skin layers for a legacy alias model skin.
 * Fullbright indexed colors stay emissive-only in the luminance layer.
 * @param {Uint8Array} skin indexed Quake skin pixels
 * @param {number} width skin width
 * @param {number} height skin height
 * @param {Uint8Array} [palette] RGB palette data
 * @param {?number} [transparentColor] optional transparent palette index
 * @param {number} [fullbrightColorStart] first fullbright palette index
 * @returns {{diffuse: Uint8Array, luminance: Uint8Array}} translated texture layers
 */
export function buildAliasSkinLayers(
  skin,
  width,
  height,
  palette = W.d_8to24table_u8,
  transparentColor = null,
  fullbrightColorStart = 240,
) {
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
 * Loader for Quake Alias Model format (.mdl)
 * Magic: 0x4f504449 ("IDPO")
 * Version: 6
 */
export class AliasMDLLoader extends ModelLoader {
  /**
   * Get magic numbers that identify this format
   * @returns {number[]} Array of magic numbers
   */
  getMagicNumbers() {
    return [0x4f504449]; // "IDPO"
  }

  /**
   * Get file extensions for this format
   * @returns {string[]} Array of file extensions
   */
  getExtensions() {
    return ['.mdl'];
  }

  /**
   * Get human-readable name of this loader
   * @returns {string} Loader name
   */
  getName() {
    return 'Quake Alias';
  }

  /**
   * Load an Alias MDL model from buffer
   * @param {ArrayBuffer} buffer - The model file data
   * @param {string} name - The model name/path
   * @returns {Promise<AliasModel>} The loaded model
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async load(buffer, name) {
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
    let inmodel = this._loadAllSkins(loadmodel, buffer, 84);
    inmodel = this._loadSTVerts(loadmodel, buffer, inmodel);
    inmodel = this._loadTriangles(loadmodel, buffer, inmodel);
    this._loadAllFrames(loadmodel, buffer, inmodel);

    // Prepare rendering data (if not dedicated server)
    if (!registry.isDedicatedServer) {
      this._buildRenderCommands(loadmodel);
    }

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return loadmodel;
  }

  /**
   * Load ST (texture coordinate) vertices
   * @param {import('../AliasModel.mjs').AliasModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buffer - The model file data
   * @param {number} inmodel - Current offset in buffer
   * @returns {number} New offset after reading vertices
   * @private
   */
  _loadSTVerts(loadmodel, buffer, inmodel) {
    const view = new DataView(buffer);
    loadmodel._stverts.length = loadmodel._num_verts;

    for (let i = 0; i < loadmodel._num_verts; i++) {
      loadmodel._stverts[i] = {
        onseam: view.getUint32(inmodel, true) !== 0,
        s: view.getUint32(inmodel + 4, true),
        t: view.getUint32(inmodel + 8, true),
      };
      inmodel += 12;
    }

    return inmodel;
  }

  /**
   * Load triangles
   * @param {import('../AliasModel.mjs').AliasModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buffer - The model file data
   * @param {number} inmodel - Current offset in buffer
   * @returns {number} New offset after reading triangles
   * @private
   */
  _loadTriangles(loadmodel, buffer, inmodel) {
    const view = new DataView(buffer);
    loadmodel._triangles.length = loadmodel._num_tris;

    for (let i = 0; i < loadmodel._num_tris; i++) {
      loadmodel._triangles[i] = {
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
   * Flood fill skin to handle transparent areas
   * @param {import('../AliasModel.mjs').AliasModel} loadmodel - The model being loaded
   * @param {Uint8Array} skin - The skin pixel data
   * @private
   */
  _floodFillSkin(loadmodel, skin) {
    const fillcolor = skin[0];
    const filledcolor = W.filledColor;

    if (fillcolor === filledcolor) {
      return;
    }

    const width = loadmodel._skin_width;
    const height = loadmodel._skin_height;

    const lifo = [[0, 0]];

    for (let sp = 1; sp > 0;) {
      const cur = lifo[--sp];
      const x = cur[0];
      const y = cur[1];
      skin[y * width + x] = filledcolor;

      if (x > 0 && skin[y * width + x - 1] === fillcolor) {
        lifo[sp++] = [x - 1, y];
      }
      if (x < (width - 1) && skin[y * width + x + 1] === fillcolor) {
        lifo[sp++] = [x + 1, y];
      }
      if (y > 0 && skin[(y - 1) * width + x] === fillcolor) {
        lifo[sp++] = [x, y - 1];
      }
      if (y < (height - 1) && skin[(y + 1) * width + x] === fillcolor) {
        lifo[sp++] = [x, y + 1];
      }
    }
  }

  /**
   * Translate player skin for color customization
   * @param {import('../AliasModel.mjs').AliasModel} loadmodel - The model being loaded
   * @param {Uint8Array} data - The original skin data
   * @param {*} skin - The skin object to store the result
   * @private
   */
  _translatePlayerSkin(loadmodel, data, skin) {
    if (registry.isDedicatedServer) {
      return;
    }

    if ((loadmodel._skin_width !== 512) || (loadmodel._skin_height !== 256)) {
      data = resampleTexture8(data, loadmodel._skin_width, loadmodel._skin_height, 512, 256);
    }

    const out = new Uint8Array(new ArrayBuffer(524288));

    for (let i = 0; i < 131072; i++) {
      const original = data[i];
      if ((original >> 4) === 1) {
        out[i << 2] = (original & 15) * 17;
        out[(i << 2) + 1] = 255;
      } else if ((original >> 4) === 6) {
        out[(i << 2) + 2] = (original & 15) * 17;
        out[(i << 2) + 3] = 255;
      }
    }

    skin.playertexture = GLTexture.Allocate(loadmodel.name + '_playerskin', 512, 256, out);
  }

  /**
   * Load all skins (textures) for the model
   * @param {import('../AliasModel.mjs').AliasModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buffer - The model file data
   * @param {number} inmodel - Current offset in buffer
   * @returns {number} New offset after reading skins
   * @private
   */
  _loadAllSkins(loadmodel, buffer, inmodel) {
    loadmodel.skins.length = loadmodel._num_skins;
    const view = new DataView(buffer);
    const skinsize = loadmodel._skin_width * loadmodel._skin_height;

    for (let i = 0; i < loadmodel._num_skins; i++) {
      inmodel += 4;

      if (view.getUint32(inmodel - 4, true) === 0) {
        // Single skin
        const skin = new Uint8Array(buffer, inmodel, skinsize);
        this._floodFillSkin(loadmodel, skin);
        const { diffuse, luminance } = buildAliasSkinLayers(skin, loadmodel._skin_width, loadmodel._skin_height);

        loadmodel.skins[i] = {
          group: false,
          texturenum: !registry.isDedicatedServer
            ? GLTexture.Allocate(loadmodel.name + '_' + i, loadmodel._skin_width, loadmodel._skin_height, diffuse)
            : null,
          luminanceTexture: !registry.isDedicatedServer
            ? GLTexture.Allocate(loadmodel.name + '_' + i + '_luma', loadmodel._skin_width, loadmodel._skin_height, luminance)
            : null,
        };

        if (loadmodel.player === true) {
          this._translatePlayerSkin(loadmodel, new Uint8Array(buffer, inmodel, skinsize), loadmodel.skins[i]);
        }

        inmodel += skinsize;
      } else {
        // Skin group (animated skins)
        const group = {
          group: true,
          skins: [],
        };
        const numskins = view.getUint32(inmodel, true);
        inmodel += 4;

        for (let j = 0; j < numskins; j++) {
          group.skins[j] = { interval: view.getFloat32(inmodel, true) };
          if (group.skins[j].interval <= 0.0) {
            throw new Error('AliasMDLLoader: skin interval <= 0');
          }
          inmodel += 4;
        }

        for (let j = 0; j < numskins; j++) {
          const skin = new Uint8Array(buffer, inmodel, skinsize);
          this._floodFillSkin(loadmodel, skin);
          const { diffuse, luminance } = buildAliasSkinLayers(skin, loadmodel._skin_width, loadmodel._skin_height);

          group.skins[j].texturenum = !registry.isDedicatedServer
            ? GLTexture.Allocate(loadmodel.name + '_' + i + '_' + j, loadmodel._skin_width, loadmodel._skin_height, diffuse)
            : null;
          group.skins[j].luminanceTexture = !registry.isDedicatedServer
            ? GLTexture.Allocate(loadmodel.name + '_' + i + '_' + j + '_luma', loadmodel._skin_width, loadmodel._skin_height, luminance)
            : null;

          if (loadmodel.player === true) {
            this._translatePlayerSkin(loadmodel, new Uint8Array(buffer, inmodel, skinsize), group.skins[j]);
          }

          inmodel += skinsize;
        }

        loadmodel.skins[i] = group;
      }
    }

    return inmodel;
  }

  /**
   * Load all animation frames
   * @param {import('../AliasModel.mjs').AliasModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buffer - The model file data
   * @param {number} inmodel - Current offset in buffer
   * @private
   */
  _loadAllFrames(loadmodel, buffer, inmodel) {
    loadmodel.frames = [];
    const view = new DataView(buffer);

    for (let i = 0; i < loadmodel._frames; i++) {
      inmodel += 4;

      if (view.getUint32(inmodel - 4, true) === 0) {
        // Single frame
        const frame = {
          group: false,
          bboxmin: new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2)),
          bboxmax: new Vector(view.getUint8(inmodel + 4), view.getUint8(inmodel + 5), view.getUint8(inmodel + 6)),
          name: Q.memstr(new Uint8Array(buffer, inmodel + 8, 16)),
          v: [],
        };
        inmodel += 24;

        for (let j = 0; j < loadmodel._num_verts; j++) {
          frame.v[j] = {
            v: new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2)),
            lightnormalindex: view.getUint8(inmodel + 3),
          };
          inmodel += 4;
        }

        loadmodel.frames[i] = frame;
      } else {
        // Frame group (animated frames)
        const group = {
          group: true,
          bboxmin: new Vector(view.getUint8(inmodel + 4), view.getUint8(inmodel + 5), view.getUint8(inmodel + 6)),
          bboxmax: new Vector(view.getUint8(inmodel + 8), view.getUint8(inmodel + 9), view.getUint8(inmodel + 10)),
          frames: [],
        };
        const numframes = view.getUint32(inmodel, true);
        inmodel += 12;

        for (let j = 0; j < numframes; j++) {
          group.frames[j] = { interval: view.getFloat32(inmodel, true) };
          if (group.frames[j].interval <= 0.0) {
            throw new Error('AliasMDLLoader: frame interval <= 0');
          }
          inmodel += 4;
        }

        for (let j = 0; j < numframes; j++) {
          const frame = group.frames[j];
          frame.bboxmin = new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2));
          frame.bboxmax = new Vector(view.getUint8(inmodel + 4), view.getUint8(inmodel + 5), view.getUint8(inmodel + 6));
          frame.name = Q.memstr(new Uint8Array(buffer, inmodel + 8, 16));
          frame.v = [];
          inmodel += 24;

          for (let k = 0; k < loadmodel._num_verts; k++) {
            frame.v[k] = {
              v: new Vector(view.getUint8(inmodel), view.getUint8(inmodel + 1), view.getUint8(inmodel + 2)),
              lightnormalindex: view.getUint8(inmodel + 3),
            };
            inmodel += 4;
          }
        }

        loadmodel.frames[i] = group;
      }
    }
  }

  /**
   * Build rendering commands (WebGL buffers) for efficient rendering
   * @param {import('../AliasModel.mjs').AliasModel} loadmodel - The model being loaded
   * @private
   */
  _buildRenderCommands(loadmodel) {
    const gl = GL.gl;
    const cmds = [];

    // Build texture coordinates

    for (let i = 0; i < loadmodel._num_tris; i++) {
      const triangle = loadmodel._triangles[i];

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

      for (let j = 0; j < 3; j++) {
        const vert = loadmodel._stverts[triangle.vertindex[j]];
        if (vert.onseam === true) {
          cmds.push((vert.s + loadmodel._skin_width / 2 + 0.5) / loadmodel._skin_width);
        } else {
          cmds.push((vert.s + 0.5) / loadmodel._skin_width);
        }
        cmds.push((vert.t + 0.5) / loadmodel._skin_height);
      }
    }

    // Build vertex data for each frame
    for (let i = 0; i < loadmodel.frames.length; i++) {
      const group = loadmodel.frames[i];

      if (group.group === true) {
        for (let j = 0; j < group.frames.length; j++) {
          const frame = group.frames[j];
          frame.cmdofs = cmds.length * 4;

          for (let k = 0; k < loadmodel._num_tris; k++) {
            const triangle = loadmodel._triangles[k];

            for (let l = 0; l < 3; l++) {
              const vert = frame.v[triangle.vertindex[l]];
              console.assert(vert.lightnormalindex < avertexnormals.length / 3);
              cmds.push(vert.v[0] * loadmodel._scale[0] + loadmodel._scale_origin[0]);
              cmds.push(vert.v[1] * loadmodel._scale[1] + loadmodel._scale_origin[1]);
              cmds.push(vert.v[2] * loadmodel._scale[2] + loadmodel._scale_origin[2]);
              cmds.push(avertexnormals[vert.lightnormalindex * 3 + 0]);
              cmds.push(avertexnormals[vert.lightnormalindex * 3 + 1]);
              cmds.push(avertexnormals[vert.lightnormalindex * 3 + 2]);
            }
          }
        }
        continue;
      }

      const frame = group;
      frame.cmdofs = cmds.length * 4;

      for (let j = 0; j < loadmodel._num_tris; j++) {
        const triangle = loadmodel._triangles[j];

        for (let k = 0; k < 3; k++) {
          const vert = frame.v[triangle.vertindex[k]];
          console.assert(vert.lightnormalindex < avertexnormals.length / 3);
          cmds.push(vert.v[0] * loadmodel._scale[0] + loadmodel._scale_origin[0]);
          cmds.push(vert.v[1] * loadmodel._scale[1] + loadmodel._scale_origin[1]);
          cmds.push(vert.v[2] * loadmodel._scale[2] + loadmodel._scale_origin[2]);
          cmds.push(avertexnormals[vert.lightnormalindex * 3 + 0]);
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
