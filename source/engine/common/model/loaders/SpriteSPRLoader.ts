import Vector from '../../../../shared/Vector.ts';
import { GLTexture } from '../../../client/GL.ts';
import { registry } from '../../../registry.ts';
import { CRC16CCITT } from '../../CRC.ts';
import W, { translateIndexToRGBA } from '../../W.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { SpriteModel, type SpriteFrame } from '../SpriteModel.ts';

interface MutableSpriteFrameImage {
  interval?: number;
  origin: [number, number];
  width: number;
  height: number;
  glt: GLTexture;
  texturenum: WebGLTexture | null;
}

interface MutableSpriteSingleFrame extends MutableSpriteFrameImage {
  group: false;
}

interface MutableSpriteFrameGroup {
  group: true;
  frames: MutableSpriteFrameImage[];
}

/**
 * Loader for Quake Sprite format (.spr).
 */
export class SpriteSPRLoader extends ModelLoader {
  override getMagicNumbers(): number[] {
    return [0x50534449];
  }

  override getExtensions(): string[] {
    return ['.spr'];
  }

  override getName(): string {
    return 'Quake Sprite';
  }

  override load(buffer: ArrayBuffer, name: string): Promise<SpriteModel> {
    const loadmodel = new SpriteModel(name);
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
        const frame = { group: false } as MutableSpriteSingleFrame;
        loadmodel.frames[i] = frame as SpriteFrame;
        inframe = this.#loadSpriteFrame(`${name}_${i}`, buffer, inframe, frame)!;
        continue;
      }

      const group: MutableSpriteFrameGroup = {
        group: true,
        frames: [],
      };
      loadmodel.frames[i] = group as SpriteFrame;
      const numframes = view.getUint32(inframe, true);
      inframe += 4;

      for (let j = 0; j < numframes; j++) {
        group.frames[j] = { interval: view.getFloat32(inframe, true) } as MutableSpriteFrameImage;
        if ((group.frames[j].interval ?? 0) <= 0.0) {
          throw new Error('SpriteSPRLoader: interval <= 0');
        }
        inframe += 4;
      }

      for (let j = 0; j < numframes; j++) {
        inframe = this.#loadSpriteFrame(`${name}_${i}_${j}`, buffer, inframe, group.frames[j])!;
      }
    }

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return Promise.resolve(loadmodel);
  }

  /**
   * Load a single sprite frame from the SPR data.
   * @returns The next byte offset after the frame, or null on dedicated server.
   */
  #loadSpriteFrame(identifier: string, buffer: ArrayBuffer, inframe: number, frame: MutableSpriteFrameImage): number | null {
    if (registry.isDedicatedServer) {
      return null;
    }

    const view = new DataView(buffer);
    frame.origin = [view.getInt32(inframe, true), -view.getInt32(inframe + 4, true)];
    frame.width = view.getUint32(inframe + 8, true);
    frame.height = view.getUint32(inframe + 12, true);

    const data = new Uint8Array(buffer, inframe + 16, frame.width * frame.height);
    const rgba = translateIndexToRGBA(data, frame.width, frame.height, W.d_8to24table_u8, 255);
    const texture = GLTexture.Allocate(identifier, frame.width, frame.height, rgba);

    frame.glt = texture;
    frame.texturenum = texture.texnum;

    return inframe + 16 + frame.width * frame.height;
  }
}
