import type { ImageFormat, ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';

/**
 * One way of turning an image file into the pixels of its frames. `SpriteImageDecoding` asks them in order and
 * uses the first that takes the file.
 */
export abstract class SpriteImageDecoder {
  /**
   * @returns A name for messages.
   */
  abstract getName(): string;

  /**
   * @param format The format of the file.
   * @param header What the header pass found.
   * @returns Whether this decoder is the right one for the file.
   */
  abstract canDecode(format: ImageFormat, header: ImageHeader): boolean;

  /**
   * @param buffer The file.
   * @param format The format of the file.
   * @param header What the header pass found.
   * @param name File name, for messages.
   * @returns Every frame composited onto the full canvas, premultiplied RGBA.
   */
  abstract decode(buffer: ArrayBuffer, format: ImageFormat, header: ImageHeader, name: string): Promise<DecodedSpriteImages>;
}
