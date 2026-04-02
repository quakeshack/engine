import Vector from '../../../../shared/Vector.ts';
import { GLTexture } from '../../../client/GL.mjs';
import W, { translateIndexToRGBA } from '../../W.mjs';
import { CRC16CCITT } from '../../CRC.mjs';
import { registry } from '../../../registry.mjs';
import { ModelLoader } from '../ModelLoader.mjs';
import { SpriteModel } from '../SpriteModel.mjs';

/**
 * Loader for Quake Sprite format (.spr)
 * Magic: 0x50534449 ("IDSP")
 * Version: 1
 */
export class SpriteSPRLoader extends ModelLoader {
  /**
   * Get magic numbers that identify this format
   * @returns {number[]} Array of magic numbers
   */
  getMagicNumbers() {
    return [0x50534449]; // "IDSP"
  }

  /**
   * Get file extensions for this format
   * @returns {string[]} Array of file extensions
   */
  getExtensions() {
    return ['.spr'];
  }

  /**
   * Get human-readable name of this loader
   * @returns {string} Loader name
   */
  getName() {
    return 'Quake Sprite';
  }

  /**
   * Load a Sprite SPR model from buffer
   * @param {ArrayBuffer} buffer - The model file data
   * @param {string} name - The model name/path
   * @returns {Promise<SpriteModel>} The loaded model
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async load(buffer, name) {
    const loadmodel = new SpriteModel(name);

    loadmodel.type = 1; // Mod.type.sprite

    const view = new DataView(buffer);
    const version = view.getUint32(4, true);

    if (version !== 1) {
      throw new Error(`${name} has wrong version number (${version} should be 1)`);
    }

    loadmodel.oriented = view.getUint32(8, true) === 3;
    loadmodel.boundingradius = view.getFloat32(12, true);
    loadmodel.width = view.getUint32(16, true);
    loadmodel.height = view.getUint32(20, true);
    loadmodel._frames = view.getUint32(24, true);

    if (loadmodel._frames === 0) {
      throw new Error(`model ${name} has no frames`);
    }

    loadmodel.random = view.getUint32(32, true) === 1;
    loadmodel.numframes = loadmodel._frames;
    loadmodel.mins = new Vector(
      loadmodel.width * -0.5,
      loadmodel.width * -0.5,
      loadmodel.height * -0.5,
    );
    loadmodel.maxs = new Vector(
      loadmodel.width * 0.5,
      loadmodel.width * 0.5,
      loadmodel.height * 0.5,
    );

    loadmodel.frames.length = loadmodel._frames;
    let inframe = 36;

    for (let i = 0; i < loadmodel._frames; i++) {
      inframe += 4;

      if (view.getUint32(inframe - 4, true) === 0) {
        // Single frame
        const frame = { group: false };
        loadmodel.frames[i] = frame;
        inframe = this._loadSpriteFrame(name + '_' + i, buffer, inframe, frame);
      } else {
        // Frame group (animated frames)
        const group = {
          group: true,
          frames: [],
        };
        loadmodel.frames[i] = group;
        const numframes = view.getUint32(inframe, true);
        inframe += 4;

        for (let j = 0; j < numframes; j++) {
          group.frames[j] = { interval: view.getFloat32(inframe, true) };
          if (group.frames[j].interval <= 0.0) {
            throw new Error('SpriteSPRLoader: interval <= 0');
          }
          inframe += 4;
        }

        for (let j = 0; j < numframes; j++) {
          inframe = this._loadSpriteFrame(name + '_' + i + '_' + j, buffer, inframe, group.frames[j]);
        }
      }
    }

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return loadmodel;
  }

  /**
   * Load a single sprite frame from buffer
   * @protected
   * @param {string} identifier - Frame texture identifier
   * @param {ArrayBuffer} buffer - The model file data
   * @param {number} inframe - Current offset in buffer
   * @param {object} frame - Frame object to populate with texture data
   * @returns {number|null} New offset after reading frame, or null if dedicated server
   */
  _loadSpriteFrame(identifier, buffer, inframe, frame) {
    if (registry.isDedicatedServer) {
      return null;
    }

    const view = new DataView(buffer);
    frame.origin = [view.getInt32(inframe, true), -view.getInt32(inframe + 4, true)];
    frame.width = view.getUint32(inframe + 8, true);
    frame.height = view.getUint32(inframe + 12, true);

    const data = new Uint8Array(buffer, inframe + 16, frame.width * frame.height);

    const rgba = translateIndexToRGBA(data, frame.width, frame.height, W.d_8to24table_u8, 255);
    const glt = GLTexture.Allocate(identifier, frame.width, frame.height, rgba);

    frame.glt = glt;
    frame.texturenum = glt.texnum;

    return inframe + 16 + frame.width * frame.height;
  }
}
