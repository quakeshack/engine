import Vector from '../../../../shared/Vector.ts';
import { GLTextureArray } from '../../../client/GL.ts';
import { CRC16CCITT } from '../../CRC.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { DEFAULT_MODEL_LOAD_OPTIONS, type ModelLoadOptions } from '../ModelLoadContext.ts';
import { SpriteModel } from '../SpriteModel.ts';
import { ImageFormat, ImageHeaders, type ImageHeader, type SpriteTag } from '../sprite/ImageHeader.ts';
import { SpriteAsset } from '../sprite/SpriteAsset.ts';
import type { DecodedSpriteImages } from '../sprite/SpriteImageDecoding.ts';
import { SpritePixels } from '../sprite/SpritePixels.ts';
import { SpriteSidecars, type SpriteSidecar, type SpriteSidecarSequence } from '../sprite/SpriteSidecar.ts';
import {
  SpriteBlend, SpriteDirection, SpriteOrientation, SpritePhase,
  type SpriteFrame, type SpriteImage, type SpriteRegion, type SpriteSequence,
} from '../sprite/SpriteTypes.ts';

/** Where the images sit relative to the entity, in world units. */
interface SpriteGeometry {
  /** Each image of the file, without its layer. */
  readonly images: ReadonlyArray<Omit<SpriteImage, 'layer'>>;
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
    return ['.gif', '.png', '.apng', '.webp', '.aseprite', '.ase'];
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
    loadmodel.lit = sidecar.lit ?? false;
    loadmodel.width = geometry.images[0].width;
    loadmodel.height = geometry.images[0].height;
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
      regions: this.#mergeRegions(header, sidecar, name),
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
   * The file's own regions (Aseprite slices) with the sidecar's on top: the sidecar wins on a name clash. A region
   * that reaches outside the image would sample the edge pixel over and over, so it is left out.
   * @returns The regions by name.
   */
  #mergeRegions(header: ImageHeader, sidecar: SpriteSidecar, name: string): Map<string, SpriteRegion> {
    const regions = new Map<string, SpriteRegion>();

    for (const source of [header.regions, sidecar.regions]) {
      for (const [regionName, region] of source) {
        if (region.x < 0 || region.y < 0 || region.x + region.width > header.width || region.y + region.height > header.height) {
          this.context.con.PrintWarning(`${name}: region "${regionName}" reaches outside the ${header.width}x${header.height} image, it is left out\n`);
          continue;
        }

        regions.set(regionName, region);
      }
    }

    return regions;
  }

  /**
   * Works out the size of the images in world units, where the entity's origin sits in them and the bounds that
   * follow. The origin is a pixel of the image counted from its top left corner: the sidecar's, else the pivot of an
   * Aseprite slice (which may differ from image to image), else the center. A billboard turns around the origin, so
   * the bounds reach as far as the farthest side in every horizontal direction.
   * @returns The pictures' size and place, the bounds and the bounding radius.
   */
  static #placeImages(header: ImageHeader, sidecar: SpriteSidecar): SpriteGeometry {
    const { scale } = sidecar;
    let reach = 0;
    let above = 0;
    let below = 0;

    const images = header.frameDurations.map((_duration, index) => {
      const [originX, originY] = sidecar.origin ?? header.origins?.[index] ?? [header.width / 2, header.height / 2];

      reach = Math.max(reach, Math.max(originX, header.width - originX) * scale);
      above = Math.max(above, originY * scale);
      below = Math.max(below, (header.height - originY) * scale);

      return {
        origin: [0 - originX * scale, 0 - (header.height - originY) * scale] as [number, number],
        width: header.width * scale,
        height: header.height * scale,
        pixelWidth: header.width,
        pixelHeight: header.height,
        uvScale: [1, 1] as [number, number],
      };
    });

    return {
      images,
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
    const images: SpriteImage[] = Array.from({ length: frameCount }, (_value, layer) => ({ layer, ...geometry.images[layer] }));
    const seconds = header.frameDurations.slice(0, frameCount).map((milliseconds) => (sidecar.fps !== null ? 1 / sidecar.fps : ImageHeaders.frameSeconds(milliseconds)));
    const repeat = sidecar.repeat ?? header.repeat;

    // an Aseprite file names its animations with tags, unless the sidecar says otherwise
    const sequences = sidecar.sequences ?? (header.tags.length > 0 ? header.tags.map((tag) => ImageSpriteLoader.#sequenceOfTag(tag, sidecar.repeat)) : null);

    if (sequences === null) {
      return [images.length === 1 ? images[0] : ImageSpriteLoader.#buildSequence('', images, seconds, SpriteDirection.forward, repeat)];
    }

    return sequences.map((entry) => this.#buildNamedSequence(entry, images, seconds, repeat, name));
  }

  /**
   * Aseprite counts the legs of a ping-pong ("repeat 2" is forward once and back once), a sequence counts its
   * cycles, so the count is halved there (rounded, at least one cycle).
   * @param repeatOverride What the sidecar says for all sequences, `null` to take the tag's.
   * @returns The tag as a sidecar sequence entry.
   */
  static #sequenceOfTag(tag: SpriteTag, repeatOverride: number | null): SpriteSidecarSequence {
    const pingpong = tag.direction === SpriteDirection.pingpong || tag.direction === SpriteDirection.pingpongReverse;

    return {
      name: tag.name,
      from: tag.from,
      to: tag.to,
      direction: tag.direction,
      repeat: repeatOverride ?? (pingpong && tag.repeat > 0 ? Math.max(1, Math.round(tag.repeat / 2)) : tag.repeat),
      fps: null,
    };
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
