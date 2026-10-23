import Vector from '../../../../shared/Vector.ts';
import { GLTextureArray } from '../../../client/GL.ts';
import { CRC16CCITT } from '../../CRC.ts';
import { CorruptedResourceError } from '../../Errors.ts';
import W, { translateIndexToRGBA } from '../../W.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { SpriteModel } from '../SpriteModel.ts';
import { SpriteAsset } from '../sprite/SpriteAsset.ts';
import { SpritePixels } from '../sprite/SpritePixels.ts';
import {
  SpriteBlend, SpriteDirection, SpriteOrientation, SpritePhase,
  type SpriteFrame, type SpriteImage, type SpriteSequence,
} from '../sprite/SpriteTypes.ts';

/** An image as it is stored in the file, before it gets a layer. */
interface SPRImage {
  readonly origin: [number, number];
  readonly width: number;
  readonly height: number;
  /** Palette indices, `width * height` bytes. */
  readonly pixels: Uint8Array;
}

/** A frame of the file: one image, or a group with the end time of each image. */
interface SPRFrame {
  readonly images: SPRImage[];
  readonly endTimes: number[] | null;
}

const SPR_HEADER_SIZE = 36;

/**
 * Loader for Quake Sprite format (.spr), version 1.
 *
 * Header (little endian): magic `IDSP`, u32 version, u32 type (the {@link SpriteOrientation}), f32
 * bounding radius, u32 width, u32 height, u32 frame count, f32 beam length, u32 sync type (1 = random
 * phase). Then each frame: u32 group flag; a single image follows directly, a group has u32 image
 * count, one f32 end time per image, then the images. An image is s32 x, s32 y, u32 width, u32 height
 * and `width * height` palette indices, 255 being transparent.
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
      throw new CorruptedResourceError(name, `${name} has wrong version number (${version} should be 1)`);
    }

    const type = view.getUint32(8, true);

    if (SpriteOrientation[type] === undefined) {
      this.context.con.PrintWarning(`${name} has an unknown sprite type (${type}), drawing it as a plain billboard\n`);
      loadmodel.orientation = SpriteOrientation.parallel;
    } else {
      loadmodel.orientation = type as SpriteOrientation;
    }
    loadmodel.boundingradius = view.getFloat32(12, true);
    loadmodel.width = view.getUint32(16, true);
    loadmodel.height = view.getUint32(20, true);

    const frameCount = view.getUint32(24, true);

    if (frameCount === 0) {
      throw new CorruptedResourceError(name, `model ${name} has no frames`);
    }

    loadmodel.phase = view.getUint32(32, true) === 1 ? SpritePhase.random : SpritePhase.global;
    // the client derives an entity's `syncbase` from this flag
    loadmodel.random = loadmodel.phase === SpritePhase.random;
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

    loadmodel.asset = this.#buildAsset(this.#readFrames(name, view, buffer, frameCount));
    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return Promise.resolve(loadmodel);
  }

  #readFrames(name: string, view: DataView, buffer: ArrayBuffer, frameCount: number): SPRFrame[] {
    const frames: SPRFrame[] = [];
    let offset = SPR_HEADER_SIZE;

    for (let i = 0; i < frameCount; i++) {
      const isGroup = view.getUint32(offset, true) !== 0;
      offset += 4;

      if (!isGroup) {
        const image = SpriteSPRLoader.#readImage(view, buffer, offset);
        offset += 16 + image.pixels.length;
        frames.push({ images: [image], endTimes: null });
        continue;
      }

      const imageCount = view.getUint32(offset, true);
      offset += 4;

      if (imageCount === 0) {
        throw new CorruptedResourceError(name, `${name} has an empty frame group`);
      }

      const endTimes: number[] = [];

      for (let j = 0; j < imageCount; j++) {
        const endTime = view.getFloat32(offset, true);
        offset += 4;

        if (endTime <= 0.0) {
          throw new CorruptedResourceError(name, 'SpriteSPRLoader: interval <= 0');
        }

        endTimes.push(endTime);
      }

      const images: SPRImage[] = [];

      for (let j = 0; j < imageCount; j++) {
        const image = SpriteSPRLoader.#readImage(view, buffer, offset);
        offset += 16 + image.pixels.length;
        images.push(image);
      }

      frames.push({ images, endTimes });
    }

    return frames;
  }

  static #readImage(view: DataView, buffer: ArrayBuffer, offset: number): SPRImage {
    const width = view.getUint32(offset + 8, true);
    const height = view.getUint32(offset + 12, true);

    return {
      origin: [view.getInt32(offset, true), -view.getInt32(offset + 4, true)],
      width,
      height,
      pixels: new Uint8Array(buffer, offset + 16, width * height),
    };
  }

  /**
   * Gives every image a layer and, where something is drawn, uploads them as one array texture.
   * The images are padded to the size of the largest one, `uvScale` keeps them from showing the padding.
   * @returns The sprite's images and timing.
   */
  #buildAsset(sprFrames: readonly SPRFrame[]): SpriteAsset {
    let layerWidth = 0;
    let layerHeight = 0;

    for (const sprFrame of sprFrames) {
      for (const image of sprFrame.images) {
        layerWidth = Math.max(layerWidth, image.width);
        layerHeight = Math.max(layerHeight, image.height);
      }
    }

    const layers: Uint8Array[] = [];
    let layerCount = 0;
    const frames: SpriteFrame[] = [];

    for (const sprFrame of sprFrames) {
      const images: SpriteImage[] = [];

      for (const image of sprFrame.images) {
        images.push({
          layer: layerCount++,
          origin: image.origin,
          width: image.width,
          height: image.height,
          uvScale: [image.width / layerWidth, image.height / layerHeight],
        });

        if (this.context.loadRenderData) {
          const rgba = translateIndexToRGBA(image.pixels, image.width, image.height, W.d_8to24table_u8, 255);
          layers.push(SpritePixels.padToLayer(rgba, image.width, image.height, layerWidth, layerHeight));
        }
      }

      if (sprFrame.endTimes === null) {
        frames.push(images[0]);
        continue;
      }

      const sequence: SpriteSequence = {
        name: '',
        images,
        endTimes: Float32Array.from(sprFrame.endTimes),
        direction: SpriteDirection.forward,
        repeat: 0,
      };
      frames.push(sequence);
    }

    return new SpriteAsset({
      frames,
      blend: SpriteBlend.alphaTest,
      layerWidth,
      layerHeight,
      texture: this.context.loadRenderData ? GLTextureArray.FromRGBALayers(layerWidth, layerHeight, layers) : null,
    });
  }
}
