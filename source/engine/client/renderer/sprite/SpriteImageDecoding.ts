import { CorruptedResourceError } from '../../../common/Errors.ts';
import type { ConsoleOutput } from '../../../common/Services.ts';
import type { ImageFormat, ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages, SpriteImageDecoding as SpriteImageDecodingContract } from '../../../common/model/sprite/SpriteImageDecoding.ts';
import { ApngSpriteDecoder } from './ApngSpriteDecoder.ts';
import { AsepriteSpriteDecoder } from './AsepriteSpriteDecoder.ts';
import { GifSpriteDecoder } from './GifSpriteDecoder.ts';
import type { SpriteImageDecoder } from './SpriteImageDecoder.ts';
import { SpriteImageLimits, type SpriteImageLimitValues } from './SpriteImageLimits.ts';
import { StillSpriteDecoder } from './StillSpriteDecoder.ts';
import { WebCodecsSpriteDecoder } from './WebCodecsSpriteDecoder.ts';

/**
 * Decodes image sprites: picks the first decoder that takes the file (our own for GIF and APNG, WebCodecs for
 * animated WebP, the browser's still image decoding for PNG and WebP), and keeps the result within the
 * limits of the hardware and the memory budget. A decoder that fails hands over to the next one.
 */
export class SpriteImageDecoding implements SpriteImageDecodingContract {
  readonly #con: ConsoleOutput;
  readonly #limits: () => SpriteImageLimitValues;
  readonly #decoders: readonly SpriteImageDecoder[];

  /**
   * @param con Where to say what went wrong or was cut.
   * @param limits What one sprite may take. Asked for at each decode, the player can change the budget at any time.
   * @param decoders The strategies in the order they are tried, the last one has to take anything.
   */
  constructor(
    con: ConsoleOutput,
    limits: () => SpriteImageLimitValues,
    decoders: readonly SpriteImageDecoder[] = [
      new GifSpriteDecoder(),
      new ApngSpriteDecoder(),
      new AsepriteSpriteDecoder((text) => { con.PrintWarning(text); }),
      new WebCodecsSpriteDecoder(),
      new StillSpriteDecoder(),
    ],
  ) {
    this.#con = con;
    this.#limits = limits;
    this.#decoders = decoders;
  }

  async decode(buffer: ArrayBuffer, format: ImageFormat, header: ImageHeader, name: string): Promise<DecodedSpriteImages> {
    for (const decoder of this.#decoders) {
      if (!decoder.canDecode(format, header)) {
        continue;
      }

      let decoded: DecodedSpriteImages;

      try {
        decoded = await decoder.decode(buffer, format, header, name);
      } catch (error) {
        this.#con.PrintWarning(`${name}: the ${decoder.getName()} decoder failed (${error instanceof Error ? error.message : String(error)}), trying the next one\n`);
        continue;
      }

      if (decoded.frames.length < header.frameDurations.length) {
        this.#con.PrintWarning(`${name}: ${decoder.getName()} decoding gives ${decoded.frames.length} of ${header.frameDurations.length} frames, the sprite will not animate fully in this browser\n`);
      }

      return SpriteImageLimits.fit(decoded, this.#limits(), this.#con, name);
    }

    throw new CorruptedResourceError(name, `${name} could not be decoded`);
  }
}
