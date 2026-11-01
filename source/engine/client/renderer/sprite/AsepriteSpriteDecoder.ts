import { CorruptedResourceError } from '../../../common/Errors.ts';
import {
  AsepriteCelType, AsepriteDepth, AsepriteFile, AsepriteLayerType,
  type AsepriteCel, type AsepriteData, type AsepriteLayer,
} from '../../../common/model/sprite/AsepriteFile.ts';
import { ImageFormat, type ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';
import { SpriteImageDecoder } from './SpriteImageDecoder.ts';

/** The longest chain of linked cels followed before the file is called damaged. */
const MAX_LINK_DEPTH = 32;

/**
 * Decodes Aseprite files ourselves: inflates the cels (`DecompressionStream`, the zlib format), turns indexed and
 * grayscale pixels into RGBA and composites the visible layers of every frame.
 *
 * What is drawn is what the editor shows: a layer is skipped when it, or a group around it, is hidden, and reference
 * layers are never part of the picture. Cels are ordered by `layer index + z-index`, then by z-index (NOTE.5 of the
 * file spec). Layer opacity counts when the file says it is valid, together with the cel's own opacity. In an indexed
 * file the header's transparent index is transparent in every layer but the background. Linked cels show the picture
 * of the cel they link to.
 *
 * Not supported: blend modes other than normal (drawn as normal) and tilemap layers (skipped), each reported once
 * through `warn`; and a group's own opacity or blend mode (its layers are composited straight onto the picture).
 */
export class AsepriteSpriteDecoder extends SpriteImageDecoder {
  readonly #warn: (text: string) => void;

  /**
   * @param warn Where problems with an unsupported feature go, once per file and feature.
   */
  constructor(warn: (text: string) => void = () => {}) {
    super();
    this.#warn = warn;
  }

  override getName(): string {
    return 'Aseprite';
  }

  override canDecode(format: ImageFormat, _header: ImageHeader): boolean {
    return format === ImageFormat.aseprite;
  }

  override async decode(buffer: ArrayBuffer, _format: ImageFormat, _header: ImageHeader, name: string): Promise<DecodedSpriteImages> {
    const data = AsepriteFile.parse(buffer, name);
    const warnings = new Set<string>();
    const pictures = new Map<AsepriteCel, Uint8Array>();
    const frames: Uint8Array[] = [];

    for (let frameIndex = 0; frameIndex < data.frames.length; frameIndex++) {
      frames.push(await this.#compositeFrame(data, frameIndex, pictures, warnings, name));
    }

    return { width: data.width, height: data.height, frames };
  }

  async #compositeFrame(data: AsepriteData, frameIndex: number, pictures: Map<AsepriteCel, Uint8Array>, warnings: Set<string>, name: string): Promise<Uint8Array> {
    const canvas = new Float32Array(data.width * data.height * 4);
    const cels = data.frames[frameIndex].cels
      .filter((cel) => AsepriteSpriteDecoder.#isDrawn(data.layers[cel.layerIndex], warnings, this.#warn, name))
      .sort((first, second) => (first.layerIndex + first.zIndex) - (second.layerIndex + second.zIndex) || first.zIndex - second.zIndex);

    for (const cel of cels) {
      const layer = data.layers[cel.layerIndex];
      const source = AsepriteSpriteDecoder.#resolveLink(data, frameIndex, cel, name);
      const rgba = await AsepriteSpriteDecoder.#pictureOf(data, source, layer, pictures, name);

      AsepriteSpriteDecoder.#blend(canvas, data.width, data.height, cel, source, rgba, (cel.opacity / 255) * (layer.opacity / 255));
    }

    const output = new Uint8Array(canvas.length);

    for (let index = 0; index < canvas.length; index++) {
      output[index] = Math.round(canvas[index] * 255);
    }

    return output;
  }

  /**
   * @returns Whether a layer's cels are part of the picture, reporting what the decoder cannot do.
   */
  static #isDrawn(layer: AsepriteLayer | undefined, warnings: Set<string>, warn: (text: string) => void, name: string): boolean {
    if (layer === undefined || !layer.visible || layer.reference || layer.type === AsepriteLayerType.group) {
      return false;
    }

    if (layer.type === AsepriteLayerType.tilemap) {
      AsepriteSpriteDecoder.#warnOnce(warnings, warn, `${name}: tilemap layers are not drawn ("${layer.name}")`);
      return false;
    }

    if (layer.blendMode !== 0) {
      AsepriteSpriteDecoder.#warnOnce(warnings, warn, `${name}: blend mode ${layer.blendMode} of layer "${layer.name}" is not supported, it is drawn as normal`);
    }

    return true;
  }

  static #warnOnce(warnings: Set<string>, warn: (text: string) => void, text: string): void {
    if (!warnings.has(text)) {
      warnings.add(text);
      warn(`${text}\n`);
    }
  }

  /**
   * @returns The cel that holds the picture: the cel itself, or the one a linked cel points to.
   */
  static #resolveLink(data: AsepriteData, frameIndex: number, cel: AsepriteCel, name: string): AsepriteCel {
    let source = cel;

    for (let depth = 0; source.type === AsepriteCelType.linked; depth++) {
      const next: AsepriteCel | undefined = data.frames[source.linkedFrame]?.cels.find((candidate) => candidate.layerIndex === cel.layerIndex);

      if (next === undefined || depth > MAX_LINK_DEPTH) {
        throw new CorruptedResourceError(name, `${name} has a linked cel in frame ${frameIndex} that links to nothing`);
      }

      source = next;
    }

    return source;
  }

  /**
   * @returns The cel's picture as straight RGBA, decoded once per cel.
   */
  static async #pictureOf(data: AsepriteData, cel: AsepriteCel, layer: AsepriteLayer, pictures: Map<AsepriteCel, Uint8Array>, name: string): Promise<Uint8Array> {
    const known = pictures.get(cel);

    if (known !== undefined) {
      return known;
    }

    const pixels = cel.type === AsepriteCelType.compressed ? await AsepriteSpriteDecoder.#inflate(cel.data) : cel.data;
    const rgba = AsepriteSpriteDecoder.#toRgba(data, pixels, cel.width * cel.height, layer, name);

    pictures.set(cel, rgba);

    return rgba;
  }

  /**
   * Inflates a zlib stream (the format of `DecompressionStream('deflate')`, not 'deflate-raw').
   * @returns The bytes the stream holds.
   */
  static async #inflate(compressed: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));

    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * @returns Straight RGBA for pixels of the file's color depth.
   */
  static #toRgba(data: AsepriteData, pixels: Uint8Array, count: number, layer: AsepriteLayer, name: string): Uint8Array {
    const rgba = new Uint8Array(count * 4);

    switch (data.depth) {
      case AsepriteDepth.rgba:
        rgba.set(pixels.subarray(0, count * 4));
        break;
      case AsepriteDepth.grayscale:
        for (let pixel = 0; pixel < count; pixel++) {
          rgba.set([pixels[pixel * 2], pixels[pixel * 2], pixels[pixel * 2], pixels[pixel * 2 + 1]], pixel * 4);
        }
        break;
      default: {
        if (data.palette === null) {
          throw new CorruptedResourceError(name, `${name} is indexed but has no palette`);
        }

        for (let pixel = 0; pixel < count; pixel++) {
          const index = pixels[pixel];

          if (index !== data.transparentIndex || layer.background) {
            rgba.set(data.palette.subarray(index * 4, index * 4 + 4), pixel * 4);
          }
        }
        break;
      }
    }

    return rgba;
  }

  /**
   * Draws a cel over the canvas (premultiplied, 0 to 1): source over destination.
   */
  static #blend(canvas: Float32Array, width: number, height: number, cel: AsepriteCel, source: AsepriteCel, rgba: Uint8Array, opacity: number): void {
    for (let row = 0; row < source.height; row++) {
      const y = cel.y + row;

      if (y < 0 || y >= height) {
        continue;
      }

      for (let column = 0; column < source.width; column++) {
        const x = cel.x + column;

        if (x < 0 || x >= width) {
          continue;
        }

        const from = (row * source.width + column) * 4;
        const alpha = (rgba[from + 3] / 255) * opacity;

        if (alpha <= 0) {
          continue;
        }

        const to = (y * width + x) * 4;
        const keep = 1 - alpha;

        canvas[to] = (rgba[from] / 255) * alpha + canvas[to] * keep;
        canvas[to + 1] = (rgba[from + 1] / 255) * alpha + canvas[to + 1] * keep;
        canvas[to + 2] = (rgba[from + 2] / 255) * alpha + canvas[to + 2] * keep;
        canvas[to + 3] = alpha + canvas[to + 3] * keep;
      }
    }
  }
}
