import GL from '../GL.ts';
import PostProcess from './PostProcess.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';

let { R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ R } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * Underwater fog post-process effect.
 *
 * When the camera is submerged in water, slime, or lava, applies exponential
 * depth fog using a dedicated turbulent-boundary depth texture. The boundary
 * texture captures the nearest water surface depth per pixel; fog is computed
 * from the camera to whichever is closer — the scene geometry or the surface.
 * This ensures pixels looking back out through the surface receive no fog past
 * the water boundary.
 */
export default class UnderwaterFogEffect extends PostProcessEffect {
  constructor() {
    super('underwater-fog');
  }

  /**
   * Apply underwater fog by drawing a fullscreen quad with the 'underwater-fog'
   * shader, sampling scene color, scene depth, and boundary depth.
   */
  override apply(inputTexture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('underwater-fog')!;

    GL.Bind(program.tScene!, inputTexture);
    GL.Bind(program.tDepth!, PostProcess.depthTexture);
    GL.Bind(program.tBoundaryDepth!, PostProcess.turbulentBoundaryDepthTexture);

    const [fr, fg, fb] = R.underwaterFogColor;
    gl.uniform3f(program.uFogColor!, fr, fg, fb);
    gl.uniform1f(program.uFogDensity!, R.underwaterFogDensity);
    gl.uniformMatrix4fv(program.uPerspective!, false, R.perspective);

    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /** Mark the effect inactive on shutdown. */
  override shutdown(): void {
    this.active = false;
  }
}
