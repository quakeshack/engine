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

  /** Whether the light of the map at the sprite's origin shades it. */
  lit = false;

  /** Whether the sprite casts a shadow; light passes through its transparent pixels. */
  castsShadow = false;

  /**
   * Which entity member selects one of the frames: an image sprite is played by `sequence` (and `animtime`), a Quake
   * or Half-Life `.spr` keeps `frame`, which there is the number of an image or group, as it always was.
   */
  selectsBySequence = false;

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
   * The frame an entity shows, whichever of its members this model is played by.
   * @param frame The entity's `frame`.
   * @param sequence The entity's `sequence`, -1 for none, which selects the first.
   * @returns An index into {@link SpriteModel.frames}, 0 when the entity selects none that exists.
   */
  selectedFrame(frame: number, sequence: number): number {
    const selected = this.selectsBySequence ? sequence : frame;

    return selected >= 0 && selected < this.frames.length ? selected : 0;
  }

  /**
   * @returns The number of frames an entity's `frame` can select.
   */
  get numframes(): number {
    return this.frames.length;
  }

  /**
   * How long the sequence plays, as far as its repeat count goes. A game that spawns an effect for one play uses it to
   * schedule the removal. A number out of range selects the first, as the renderer does.
   * @param sequence The entity's `sequence` for an image sprite, its `frame` for a `.spr`.
   * @returns Seconds, `Infinity` for a sequence that repeats forever, 0 for a single picture (it has nothing to play).
   */
  override sequenceDuration(sequence: number): number {
    return this.asset?.sequenceDuration(sequence) ?? 0;
  }

  /**
   * Finds a named sequence (a sequence of the sidecar, a tag of an Aseprite file). A `.spr` has no names.
   * @param name The name the sidecar gave it.
   * @returns The `sequence` that selects it, -1 when there is none of that name.
   */
  override sequenceIndex(name: string): number {
    return this.asset?.sequenceIndex(name) ?? -1;
  }

  override reset(): void {
    super.reset();
    this.asset = null;
    this.orientation = SpriteOrientation.parallel;
    this.phase = SpritePhase.global;
    this.lit = false;
    this.castsShadow = false;
    this.selectsBySequence = false;
    this.boundingradius = 0;
    this.width = 0;
    this.height = 0;
  }
}
