import Vector from '../../../../shared/Vector.ts';
import { GLTextureArray } from '../../../client/GL.ts';
import { CRC16CCITT } from '../../CRC.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { DEFAULT_MODEL_LOAD_OPTIONS, type ModelLoadOptions } from '../ModelLoadContext.ts';
import { SpriteModel } from '../SpriteModel.ts';
import { ImageFormat, ImageHeaders, type ImageHeader } from '../sprite/ImageHeader.ts';
import { SpriteAsset } from '../sprite/SpriteAsset.ts';
import type { DecodedSpriteImages } from '../sprite/SpriteImageDecoding.ts';
import { SpritePixels } from '../sprite/SpritePixels.ts';
import { SpriteSidecars, type SpriteSidecar, type SpriteSidecarSequence } from '../sprite/SpriteSidecar.ts';
import {
  SpriteBlend, SpriteDirection, SpriteOrientation, SpritePhase,
  type SpriteFrame, type SpriteImage, type SpriteSequence,
} from '../sprite/SpriteTypes.ts';

/** Where the images sit relative to the entity, in world units. */
interface SpriteGeometry {
  readonly image: Omit<SpriteImage, 'layer'>;
  readonly mins: Vector;
  readonly maxs: Vector;
  readonly radius: number;
}

/**
 * Loader for animated and still images used as sprites: GIF, PNG/APNG and WebP.
 *
 * The header pass (`ImageHeaders`) gives the size, the timing and the repeat count, which is all a realm that
 * does not draw needs: bounds for `Edict.setModel()` and the length of the animation. A realm that draws also
 * has the pixels decoded (`ModelLoadContext.spriteImages`) and uploads the frames as the layers of one array
 * texture. Without a sidecar the file plays as one sequence over all its images, starting when the entity gets
 * the model, drawn as a billboard around the image's center at one pixel per world unit. The optional sidecar
 * (`<file>.json`, see `SpriteSidecar`) changes all of that, in every realm: it can scale the sprite, so the
 * server needs it for the bounds too.
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

  override async load(buffer: ArrayBuffer, name: string, options: ModelLoadOptions = DEFAULT_MODEL_LOAD_OPTIONS): Promise<SpriteModel> {
    const format = ImageHeaders.detect(buffer)!;
    const header = ImageHeaders.parse(buffer, name);
    const sidecar = options.sidecar ? await this.#readSidecar(name) : SpriteSidecars.EMPTY;
    const geometry = ImageSpriteLoader.#placeImages(header, sidecar);
    const loadmodel = new SpriteModel(name);

    loadmodel.orientation = sidecar.orientation ?? SpriteOrientation.parallel;
    loadmodel.phase = sidecar.phase ?? SpritePhase.spawn;
    loadmodel.random = loadmodel.phase === SpritePhase.random;
    loadmodel.width = geometry.image.width;
    loadmodel.height = geometry.image.height;
    loadmodel.boundingradius = geometry.radius;
    loadmodel.mins = geometry.mins;
    loadmodel.maxs = geometry.maxs;
    loadmodel.sidecarSkipped = !options.sidecar;

    // a realm that draws needs the pixels, and they tell how many frames there really are
    const decoded = this.context.loadRenderData && this.context.spriteImages !== null
      ? await this.context.spriteImages.decode(buffer, format, header, name)
      : null;
    const frameCount = decoded === null ? header.frameDurations.length : Math.min(decoded.frames.length, header.frameDurations.length);

    loadmodel.asset = new SpriteAsset({
      frames: this.#buildFrames(header, frameCount, geometry, sidecar, name),
      blend: sidecar.blend ?? (format === ImageFormat.gif ? SpriteBlend.alphaTest : SpriteBlend.alpha),
      filter: sidecar.filter,
      interpolate: sidecar.interpolate ?? false,
      layerWidth: decoded?.width ?? header.width,
      layerHeight: decoded?.height ?? header.height,
      texture: decoded === null ? null : ImageSpriteLoader.#uploadFrames(decoded, frameCount, sidecar),
    });
    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return loadmodel;
  }

  /**
   * Reads and parses the sidecar next to the file, if there is one.
   * @returns The settings, all at their defaults when there is no sidecar.
   */
  async #readSidecar(name: string): Promise<SpriteSidecar> {
    const sidecarName = `${name}.json`;
    const text = await this.context.files.LoadOptionalTextFile(sidecarName);

    return text === null ? SpriteSidecars.EMPTY : SpriteSidecars.parse(text, sidecarName, this.context.con);
  }

  /**
   * Works out the size of the images in world units, where the entity's origin sits in them and the bounds that
   * follow. The origin is a pixel of the image counted from its top left corner and defaults to the center. A
   * billboard turns around the origin, so the bounds reach as far as the farthest side in every horizontal direction.
   * @returns The picture's size and place, the bounds and the bounding radius.
   */
  static #placeImages(header: ImageHeader, sidecar: SpriteSidecar): SpriteGeometry {
    const { scale } = sidecar;
    const [originX, originY] = sidecar.origin ?? [header.width / 2, header.height / 2];
    const reach = Math.max(originX, header.width - originX) * scale;
    const below = (header.height - originY) * scale;
    const above = originY * scale;

    return {
      image: {
        origin: [0 - originX * scale, 0 - below],
        width: header.width * scale,
        height: header.height * scale,
        uvScale: [1, 1],
      },
      mins: new Vector(0 - reach, 0 - reach, 0 - below),
      maxs: new Vector(reach, reach, above),
      radius: Math.hypot(reach, Math.max(above, below)),
    };
  }

  /**
   * Makes the pixels ready for the texture: the color key (a sidecar setting) turns a color transparent.
   * @returns The texture, one layer per frame.
   */
  static #uploadFrames(decoded: DecodedSpriteImages, frameCount: number, sidecar: SpriteSidecar): GLTextureArray {
    const frames = decoded.frames.slice(0, frameCount);

    if (sidecar.colorKey !== null) {
      for (const frame of frames) {
        SpritePixels.keyColor(frame, sidecar.colorKey.color, sidecar.colorKey.tolerance);
      }
    }

    return GLTextureArray.FromRGBALayers(decoded.width, decoded.height, frames, sidecar.filter);
  }

  /**
   * @param frameCount How many of the file's frames there are pixels for.
   * @returns What an entity's `frame` selects: the sequences of the sidecar, or the picture of a still image,
   * or one sequence over the images of an animation.
   */
  #buildFrames(header: ImageHeader, frameCount: number, geometry: SpriteGeometry, sidecar: SpriteSidecar, name: string): SpriteFrame[] {
    const images: SpriteImage[] = Array.from({ length: frameCount }, (_value, layer) => ({ layer, ...geometry.image }));
    const seconds = header.frameDurations.slice(0, frameCount).map((milliseconds) => (sidecar.fps !== null ? 1 / sidecar.fps : ImageHeaders.frameSeconds(milliseconds)));
    const repeat = sidecar.repeat ?? header.repeat;

    if (sidecar.sequences === null) {
      return [images.length === 1 ? images[0] : ImageSpriteLoader.#buildSequence('', images, seconds, SpriteDirection.forward, repeat)];
    }

    return sidecar.sequences.map((entry) => this.#buildNamedSequence(entry, images, seconds, repeat, name));
  }

  #buildNamedSequence(entry: SpriteSidecarSequence, images: readonly SpriteImage[], seconds: readonly number[], repeat: number, name: string): SpriteSequence {
    const last = images.length - 1;
    const from = Math.min(entry.from ?? 0, last);
    const to = Math.min(Math.max(entry.to ?? last, from), last);

    if ((entry.from !== null && entry.from > last) || (entry.to !== null && (entry.to > last || entry.to < from))) {
      this.context.con.PrintWarning(`${name}: sequence "${entry.name}" runs from ${entry.from ?? 0} to ${entry.to ?? last}, the file has the images 0 to ${last}; using ${from} to ${to}\n`);
    }

    return ImageSpriteLoader.#buildSequence(
      entry.name,
      images.slice(from, to + 1),
      entry.fps === null ? seconds.slice(from, to + 1) : new Array<number>(to - from + 1).fill(1 / entry.fps),
      entry.direction ?? SpriteDirection.forward,
      entry.repeat ?? repeat,
    );
  }

  static #buildSequence(sequenceName: string, images: readonly SpriteImage[], seconds: readonly number[], direction: SpriteDirection, repeat: number): SpriteSequence {
    const endTimes = new Float32Array(images.length);
    let elapsed = 0;

    for (let index = 0; index < images.length; index++) {
      elapsed += seconds[index];
      endTimes[index] = elapsed;
    }

    return { name: sequenceName, images, endTimes, direction, repeat };
  }
}
