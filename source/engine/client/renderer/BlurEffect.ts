import GL from '../GL.ts';
import VID from '../VID.ts';
import PostProcess from './PostProcess.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import { eventBus } from '../../registry.ts';
import type { PostProcessBlurDescriptor } from '../../../shared/GameInterfaces.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

export default class BlurEffect extends PostProcessEffect {
  /** Intermediate FBO for the horizontal pass. */
  static intermediateFBO: WebGLFramebuffer | null = null;

  /** Color texture for the horizontal-pass result. */
  static intermediateTexture: WebGLTexture | null = null;

  constructor() {
    super('blur');
    this.stackable = true;
  }

  static resolveSettings(settings: PostProcessBlurDescriptor): PostProcessBlurDescriptor {
    return {
      radius: Number.isFinite(settings.radius ?? NaN) ? settings.radius : 4.0,
    };
  }

  override init(): void {
    BlurEffect.intermediateTexture = gl.createTexture();
    GL.Bind(0, BlurEffect.intermediateTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    BlurEffect.intermediateFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, BlurEffect.intermediateFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, BlurEffect.intermediateTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  override resize(width: number, height: number): void {
    if (!BlurEffect.intermediateTexture) { return; }
    GL.Bind(0, BlurEffect.intermediateTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  override shutdown(): void {
    if (BlurEffect.intermediateFBO) {
      gl.deleteFramebuffer(BlurEffect.intermediateFBO);
      BlurEffect.intermediateFBO = null;
    }
    if (BlurEffect.intermediateTexture) {
      gl.deleteTexture(BlurEffect.intermediateTexture);
      BlurEffect.intermediateTexture = null;
    }
  }

  #blurPass(inputTexture: WebGLTexture, dirX: number, dirY: number, radius: number, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('blur');
    if (!program) { return; }
    GL.Bind(program.tTexture!, inputTexture);
    gl.uniform2f(program.uDirection!, dirX, dirY);
    gl.uniform1f(program.uRadius!, radius);
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  override apply(inputTexture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    if (!BlurEffect.intermediateFBO || !BlurEffect.intermediateTexture) { return; }

    const s = BlurEffect.resolveSettings(PostProcess.getStackEntry('blur') ?? {});
    const radius = s.radius!;

    // Remember the output binding the caller set up.
    const outputFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const outputViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    const pw = (width * VID.pixelRatio) >> 0;
    const ph = (height * VID.pixelRatio) >> 0;

    // Horizontal pass → intermediate FBO.
    gl.bindFramebuffer(gl.FRAMEBUFFER, BlurEffect.intermediateFBO);
    gl.viewport(0, 0, pw, ph);
    this.#blurPass(inputTexture, 1.0, 0.0, radius, 0, 0, VID.width, VID.height);

    // Vertical pass → original output FBO.
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
    gl.viewport(outputViewport[0], outputViewport[1], outputViewport[2], outputViewport[3]);
    this.#blurPass(BlurEffect.intermediateTexture, 0.0, 1.0, radius, x, y, width, height);
  }
}
