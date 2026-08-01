import GL, { type GLRenderTexture } from '../GL.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';

let { Host } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Host } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
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
   * @param inputTexture Scene color texture to distort.
   * @param x Viewport x position.
   * @param y Viewport y position.
   * @param width Viewport width.
   * @param height Viewport height.
   */
  override apply(inputTexture: GLRenderTexture, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('warp');
    inputTexture.bind(program!.tTexture!);
    gl.uniform1f(program!.uTime!, Host.realtime % (Math.PI * 2.0));
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /** Mark the effect inactive on shutdown. */
  override shutdown(): void {
    this.active = false;
  }
}
