import GL from '../GL.mjs';
import PostProcessEffect from './PostProcessEffect.mjs';
import { eventBus, registry } from '../../registry.mjs';

let { Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ Host } = registry);
});

/** @type {WebGL2RenderingContext} */
let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/**
 * Underwater warp distortion post-process effect.
 *
 * Applies a sinusoidal coordinate warp with a 3x3 Gaussian blur,
 * simulating the visual distortion seen when the camera is submerged
 * in water, slime, or lava.
 *
 * This replaces the previous R.WarpScreen / R.warpbuffer implementation.
 * Scene capture is handled by the shared PostProcess framebuffer.
 */
export default class WarpEffect extends PostProcessEffect {
  constructor() {
    super('warp');
  }

  /**
   * Apply the warp distortion effect by drawing a fullscreen quad with
   * the 'warp' shader.
   * @param {WebGLTexture} inputTexture - Scene color texture to distort
   * @param {number} x - Viewport x position
   * @param {number} y - Viewport y position
   * @param {number} width - Viewport width
   * @param {number} height - Viewport height
   */
  apply(inputTexture, x, y, width, height) {
    const program = GL.UseProgram('warp');
    GL.Bind(program.tTexture, inputTexture);
    gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * Mark the effect inactive on shutdown.
   */
  shutdown() {
    this.active = false;
  }
};
