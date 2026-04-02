import type { GLTexture } from '../../client/GL.mjs';

import { BaseModel } from './BaseModel.ts';

interface SpriteFrameImage {
  readonly interval?: number;
  readonly origin: [number, number];
  readonly width: number;
  readonly height: number;
  readonly glt: GLTexture;
  readonly texturenum: number;
}

interface SpriteSingleFrame {
  readonly group: false;
  readonly origin: [number, number];
  readonly width: number;
  readonly height: number;
  readonly glt: GLTexture;
  readonly texturenum: number;
}

interface SpriteFrameGroup {
  readonly group: true;
  readonly frames: SpriteFrameImage[];
}

export type SpriteFrame = SpriteSingleFrame | SpriteFrameGroup;

/**
 * Sprite model (.spr), Quake's 2D billboard sprite format.
 * Used for explosions, particles, and other effects that always face the camera.
 */
export class SpriteModel extends BaseModel {
  /** Whether sprite orientation is fixed or faces the camera. */
  oriented = false;

  /** Bounding sphere radius. */
  boundingradius = 0;

  /** Sprite width. */
  width = 0;

  /** Sprite height. */
  height = 0;

  /** Number of frames in file, used during loading. */
  _frames = 0;

  /** Sprite frames, stored as single images or grouped animations. */
  frames: SpriteFrame[] = [];

  /** True when frame selection should be randomized. */
  random = false;

  /** Total number of frames. */
  numframes = 0;

  constructor(name: string) {
    super(name);
    this.type = 1;
  }

  override reset(): void {
    super.reset();
    this.oriented = false;
    this.boundingradius = 0;
    this.width = 0;
    this.height = 0;
    this._frames = 0;
    this.frames = [];
    this.random = false;
    this.numframes = 0;
  }
}
