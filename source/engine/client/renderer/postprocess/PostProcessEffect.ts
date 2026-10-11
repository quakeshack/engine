import type { PostProcessStage } from '../../../../shared/GameInterfaces.ts';
import type { GLRenderTexture } from '../../GL.ts';

/**
 * Base class for post-process effects.
 *
 * Each effect receives an input color texture and renders its output into
 * either another FBO (when chaining) or the default framebuffer (when it is
 * the last effect in the pipeline). Subclasses override `apply` to
 * bind their shader, set uniforms, and draw a fullscreen quad.
 *
 * Effects that require the depth texture (e.g. volumetric fog) are handled
 * separately by PostProcess during scene rendering and are not part of
 * this pipeline.
 */
export default class PostProcessEffect {
  /** Unique name identifying this effect. */
  readonly name: string;

  /** Whether this effect is currently enabled. */
  active = false;

  /** Whether this effect is managed by the gameplay-driven stack. */
  stackable = false;

  /**
   * Settings with which the effect changes nothing. A stack entry fades in from them and out to them, so they
   * list the numbers that carry an entry's intensity; settings that are not listed (a tint color, a period)
   * are not interpolated.
   */
  readonly neutral: object = {};

  /**
   * The stage the effect is applied in when an entry does not name one: `scene` before the renderer's own
   * effects, `final` after them.
   */
  readonly defaultStage: PostProcessStage = 'scene';

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Completes the settings of a stack entry: what the game left out becomes the effect's default and what is not
   * a finite number is repaired.
   * @param settings The settings as the game gave them.
   * @returns The settings the effect applies, which it can be asked to apply again unchanged.
   */
  resolveSettings(settings: object): object {
    return settings;
  }

  /**
   * Mixes entries of this effect that follow each other into one, for an effect whose entries are layers of a
   * single thing, like a tint. Leave it out for an effect whose every entry is a pass of its own.
   * @param settings The resolved settings of the run, in the order they are applied.
   * @returns The settings of the one pass to apply, or `null` when nothing is to be drawn.
   */
  combineSettings?(settings: readonly object[]): object | null;

  /**
   * Apply the effect by drawing a fullscreen quad with the appropriate shader.
   * The caller has already bound the correct output framebuffer and viewport.
   * @param settings The settings of the stack entry that is applied, as the effect's `resolveSettings` returned
   * them (faded, for an entry that is fading or pulsing). `null` for the renderer's own effects, which have none.
   */

  apply(_inputTexture: GLRenderTexture, _x: number, _y: number, _width: number, _height: number, _settings: object | null = null): void {
    throw new Error(`PostProcessEffect.apply() not implemented for '${this.name}'`);
  }

  /**
   * Called when the effect's FBO textures need resizing.
   * Override if the effect maintains its own GPU resources that depend on
   * viewport dimensions.
   */

  resize(_width: number, _height: number): void {
    // Default: no-op. Override if needed.
  }

  /**
   * Initialize GPU resources. Called once during PostProcess.addEffect().
   */
  init(): void {
    // Default: no-op.
  }

  /**
   * Clean up GPU resources on shutdown.
   */
  shutdown(): void {
    // Default: no-op.
  }

  /**
   * Draw a debug preview overlay for this effect.
   * Override in subclasses that support debug visualizations (e.g. BloomEffect).
   */
  drawDebugPreview(): void {
    // Default: no-op.
  }
}
