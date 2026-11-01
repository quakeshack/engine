import { ImageFormat, type ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';
import { SpritePixels } from '../../../common/model/sprite/SpritePixels.ts';
import { BrowserImagePixels } from './BrowserImagePixels.ts';
import { SpriteImageDecoder } from './SpriteImageDecoder.ts';

/** The formats a browser decodes as a still image. */
const MIME_TYPES: Partial<Record<ImageFormat, string>> = {
  [ImageFormat.gif]: 'image/gif',
  [ImageFormat.png]: 'image/png',
  [ImageFormat.webp]: 'image/webp',
};

/**
 * The last resort: whatever the browser decodes as a still image, which is the first frame of an animation.
 * Every browser can do this, so it also decodes plain PNG and static WebP files. It cannot read Aseprite files.
 */
export class StillSpriteDecoder extends SpriteImageDecoder {
  override getName(): string {
    return 'still image';
  }

  override canDecode(format: ImageFormat, _header: ImageHeader): boolean {
    return MIME_TYPES[format] !== undefined;
  }

  override async decode(buffer: ArrayBuffer, format: ImageFormat, _header: ImageHeader, _name: string): Promise<DecodedSpriteImages> {
    const still = await BrowserImagePixels.decodeStill(new Uint8Array(buffer), MIME_TYPES[format]!);

    return { width: still.width, height: still.height, frames: [SpritePixels.premultiply(new Uint8Array(still.rgba))] };
  }
}
