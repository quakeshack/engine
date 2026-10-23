import { ImageFormat, type ImageHeader } from '../../../common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../../common/model/sprite/SpriteImageDecoding.ts';
import { SpritePixels } from '../../../common/model/sprite/SpritePixels.ts';
import { BrowserImagePixels } from './BrowserImagePixels.ts';
import { SpriteImageDecoder } from './SpriteImageDecoder.ts';

/**
 * Animated WebP through WebCodecs' `ImageDecoder`, which hands out every frame composited. It is the one format
 * we do not decode ourselves (that would need a VP8 decoder). Chromium has it since version 94, Firefox on the
 * desktop since 133, Safari not in its stable release; without it a WebP shows its first frame only.
 */
export class WebCodecsSpriteDecoder extends SpriteImageDecoder {
  override getName(): string {
    return 'WebCodecs';
  }

  override canDecode(format: ImageFormat, header: ImageHeader): boolean {
    return format === ImageFormat.webp && header.frameDurations.length > 1 && typeof ImageDecoder !== 'undefined';
  }

  override async decode(buffer: ArrayBuffer, _format: ImageFormat, header: ImageHeader, _name: string): Promise<DecodedSpriteImages> {
    if (!(await ImageDecoder.isTypeSupported('image/webp'))) {
      throw new Error('ImageDecoder does not take image/webp');
    }

    const decoder = new ImageDecoder({ data: buffer, type: 'image/webp', colorSpaceConversion: 'none', preferAnimation: true });

    try {
      await decoder.tracks.ready;

      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? header.frameDurations.length;
      const frames: Uint8Array[] = [];
      let width = header.width;
      let height = header.height;

      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const { image } = await decoder.decode({ frameIndex });

        try {
          width = image.displayWidth;
          height = image.displayHeight;
          frames.push(SpritePixels.premultiply(new Uint8Array(BrowserImagePixels.readPixels(image, width, height))));
        } finally {
          image.close();
        }
      }

      return { width, height, frames };
    } finally {
      decoder.close();
    }
  }
}
