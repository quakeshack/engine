import { BaseModel } from './BaseModel.ts';
import type { SpriteAsset } from './sprite/SpriteAsset.ts';
import { SpriteOrientation, SpritePhase, type SpriteFrame } from './sprite/SpriteTypes.ts';

export { SpriteOrientation, SpritePhase } from './sprite/SpriteTypes.ts';
export type { SpriteFrame, SpriteImage, SpriteSequence } from './sprite/SpriteTypes.ts';

/**
 * Sprite model: a 2D picture or animation placed in the world as an entity. Quake's `.spr` format is
 * one source; the images, their timing and the texture live in a {@link SpriteAsset}.
 */
export class SpriteModel extends BaseModel {
  /** The images, `null` until the model is loaded. */
  asset: SpriteAsset | null = null;

  /** How the sprite is turned towards the viewer. */
  orientation = SpriteOrientation.parallel;

  /** Which clock the animation follows. */
  phase = SpritePhase.global;

  /** Bounding sphere radius. */
  boundingradius = 0;

  /** Sprite width. */
  width = 0;

  /** Sprite height. */
  height = 0;

  constructor(name: string) {
    super(name);
    this.type = 1;
  }

  /**
   * @returns The frames an entity's `frame` selects from.
   */
  get frames(): readonly SpriteFrame[] {
    return this.asset?.frames ?? [];
  }

  /**
   * @returns The number of frames an entity's `frame` can select.
   */
  get numframes(): number {
    return this.frames.length;
  }

  override reset(): void {
    super.reset();
    this.asset = null;
    this.orientation = SpriteOrientation.parallel;
    this.phase = SpritePhase.global;
    this.boundingradius = 0;
    this.width = 0;
    this.height = 0;
  }
}
