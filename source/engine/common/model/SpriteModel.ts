import { BaseModel } from './BaseModel.ts';
import { SpriteAnimator } from './sprite/SpriteAnimator.ts';
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

  /** Whether the light of the map at the sprite's origin shades it. */
  lit = false;

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

  /**
   * How long the sequence an entity's `frame` selects plays, as far as its repeat count goes. A game that spawns an
   * effect for one play uses it to schedule the removal. A `frame` out of range selects the first, as the renderer does.
   * @param frame The entity's `frame`.
   * @returns Seconds, `Infinity` for a sequence that repeats forever, 0 for a single picture (it has nothing to play).
   */
  sequenceDuration(frame: number): number {
    const entry = this.frames[frame >= 0 && frame < this.frames.length ? frame : 0];

    return entry !== undefined && 'images' in entry ? SpriteAnimator.duration(entry) : 0;
  }

  /**
   * Finds a named sequence (a sequence of the sidecar, later a tag of an Aseprite file).
   * @param name The name the sidecar gave it.
   * @returns The `frame` that selects it, -1 when there is none of that name.
   */
  sequenceIndex(name: string): number {
    return name === '' ? -1 : this.frames.findIndex((entry) => 'images' in entry && entry.name === name);
  }

  override reset(): void {
    super.reset();
    this.asset = null;
    this.orientation = SpriteOrientation.parallel;
    this.phase = SpritePhase.global;
    this.lit = false;
    this.boundingradius = 0;
    this.width = 0;
    this.height = 0;
  }
}
