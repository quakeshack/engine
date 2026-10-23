import { ImageFormat, type ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';
import { SpritePixels } from '../../../common/model/sprite/SpritePixels.ts';
import { BrowserImagePixels } from './BrowserImagePixels.ts';
import { SpriteImageDecoder } from './SpriteImageDecoder.ts';

const MIME_TYPES: Record<ImageFormat, string> = {
  [ImageFormat.gif]: 'image/gif',
  [ImageFormat.png]: 'image/png',
  [ImageFormat.webp]: 'image/webp',
};

/**
 * The last resort: whatever the browser decodes as a still image, which is the first frame of an animation.
 * Every browser can do this, so it also decodes plain PNG and static WebP files.
 */
export class StillSpriteDecoder extends SpriteImageDecoder {
  override getName(): string {
    return 'still image';
  }

  override canDecode(_format: ImageFormat, _header: ImageHeader): boolean {
    return true;
  }

  override async decode(buffer: ArrayBuffer, format: ImageFormat, _header: ImageHeader, _name: string): Promise<DecodedSpriteImages> {
    const still = await BrowserImagePixels.decodeStill(new Uint8Array(buffer), MIME_TYPES[format]);

    return { width: still.width, height: still.height, frames: [SpritePixels.premultiply(new Uint8Array(still.rgba))] };
  }
}
