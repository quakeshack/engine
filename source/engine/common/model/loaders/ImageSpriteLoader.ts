import Vector from '../../../../shared/Vector.ts';
import { CRC16CCITT } from '../../CRC.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { SpriteModel } from '../SpriteModel.ts';
import { ImageFormat, ImageHeaders, type ImageHeader } from '../sprite/ImageHeader.ts';
import { SpriteAsset } from '../sprite/SpriteAsset.ts';
import {
  SpriteBlend, SpriteDirection, SpriteOrientation, SpritePhase,
  type SpriteFrame, type SpriteImage, type SpriteSequence,
} from '../sprite/SpriteTypes.ts';

/**
 * Loader for animated and still images used as sprites: GIF, PNG/APNG and WebP.
 *
 * The header pass (`ImageHeaders`) gives the size, the timing and the repeat count, which is all a realm that
 * does not draw needs: bounds for `Edict.setModel()` and the length of the animation. The file plays as one
 * sequence over all its images, starting when the entity gets the model, drawn as a billboard around the
 * image's center at one pixel per world unit.
 */
export class ImageSpriteLoader extends ModelLoader {
  override getMagicNumbers(): number[] {
    // the signatures are not one number at offset 0 (WebP's is split around a size), `canLoad()` looks for them
    return [];
  }

  override getExtensions(): string[] {
    return ['.gif', '.png', '.apng', '.webp'];
  }

  override getName(): string {
    return 'Image Sprite';
  }

  override canLoad(buffer: ArrayBuffer, filename: string): boolean {
    const extension = filename.substring(filename.lastIndexOf('.')).toLowerCase();

    return this.getExtensions().includes(extension) && ImageHeaders.detect(buffer) !== null;
  }

  override load(buffer: ArrayBuffer, name: string): Promise<SpriteModel> {
    const format = ImageHeaders.detect(buffer);
    const header = ImageHeaders.parse(buffer, name);
    const loadmodel = new SpriteModel(name);

    loadmodel.orientation = SpriteOrientation.parallel;
    loadmodel.phase = SpritePhase.spawn;
    loadmodel.width = header.width;
    loadmodel.height = header.height;
    loadmodel.boundingradius = Math.hypot(header.width, header.height) * 0.5;
    loadmodel.mins = new Vector(header.width * -0.5, header.width * -0.5, header.height * -0.5);
    loadmodel.maxs = new Vector(header.width * 0.5, header.width * 0.5, header.height * 0.5);
    loadmodel.asset = new SpriteAsset({
      frames: [ImageSpriteLoader.#buildFrame(header)],
      blend: format === ImageFormat.gif ? SpriteBlend.alphaTest : SpriteBlend.alpha,
      layerWidth: header.width,
      layerHeight: header.height,
    });
    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    if (this.context.loadRenderData) {
      this.context.con.PrintWarning(`${name}: the pixels of image sprites are not decoded yet, it will not be drawn\n`);
    }

    return Promise.resolve(loadmodel);
  }

  /**
   * @returns The picture of a still image, or one sequence over all images of an animation.
   */
  static #buildFrame(header: ImageHeader): SpriteFrame {
    const images: SpriteImage[] = header.frameDurations.map((_duration, layer) => ({
      layer,
      origin: [header.width * -0.5, header.height * -0.5],
      width: header.width,
      height: header.height,
      uvScale: [1, 1],
    }));

    if (images.length === 1) {
      return images[0];
    }

    const endTimes = new Float32Array(images.length);
    let elapsed = 0;

    for (let index = 0; index < images.length; index++) {
      elapsed += ImageHeaders.frameSeconds(header.frameDurations[index]);
      endTimes[index] = elapsed;
    }

    const sequence: SpriteSequence = {
      name: '',
      images,
      endTimes,
      direction: SpriteDirection.forward,
      repeat: header.repeat,
    };

    return sequence;
  }
}
