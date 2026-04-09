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

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Apply the effect by drawing a fullscreen quad with the appropriate shader.
   * The caller has already bound the correct output framebuffer and viewport.
   */

  apply(_inputTexture: WebGLTexture, _x: number, _y: number, _width: number, _height: number): void {
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
