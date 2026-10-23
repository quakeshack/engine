import { AsepriteFile, type AsepriteData } from './AsepriteFile.ts';
import type { ImageHeader } from './ImageHeader.ts';

/**
 * Header pass for Aseprite files: size, the duration of every frame, the tags (which become named sequences) and the
 * pivot of the first slice that has one (which becomes the origin). Pixels are not touched; the layout of the file
 * is described on {@link AsepriteFile}. A file plays forever by default, like in the editor.
 */
export class AsepriteHeader {
  /**
   * @returns Whether the file is an Aseprite file.
   */
  static matches(buffer: ArrayBuffer): boolean {
    return AsepriteFile.matches(buffer);
  }

  /**
   * @param buffer The file.
   * @param name File name, for error messages.
   * @returns What the header pass finds out.
   */
  static parse(buffer: ArrayBuffer, name: string): ImageHeader {
    return AsepriteHeader.describe(AsepriteFile.parse(buffer, name));
  }

  /**
   * @param data A file that is already taken apart.
   * @returns What the header pass finds out.
   */
  static describe(data: AsepriteData): ImageHeader {
    return {
      width: data.width,
      height: data.height,
      frameDurations: data.frames.map((frame) => frame.duration),
      repeat: 0,
      tags: data.tags,
      origins: AsepriteHeader.#pivots(data),
    };
  }

  /**
   * An artist marks where the sprite's origin is with the pivot of a slice. A slice can move from frame to frame; its
   * keys are valid from their frame to the next key.
   * @returns The pivot pixel of every frame, `null` when no slice has a pivot.
   */
  static #pivots(data: AsepriteData): Array<[number, number]> | null {
    const slice = data.slices.find((candidate) => candidate.keys.some((key) => key.pivot !== null));

    if (slice === undefined) {
      return null;
    }

    const keys = slice.keys.filter((key) => key.pivot !== null).sort((first, second) => first.frame - second.frame);

    return data.frames.map((_frame, frameIndex) => {
      const key = keys.findLast((candidate) => candidate.frame <= frameIndex) ?? keys[0];

      return [key.x + key.pivot![0], key.y + key.pivot![1]];
    });
  }
}
