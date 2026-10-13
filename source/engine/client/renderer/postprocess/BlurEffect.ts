import GL, { type GLRenderTexture } from '../../GL.ts';
import VID from '../../VID.ts';
import PostProcessEffect, { type PostProcessOutput } from './PostProcessEffect.ts';
import RenderTarget from '../frame/RenderTarget.ts';
import { eventBus } from '../../../common/EventBus.ts';
import type { PostProcessBlurDescriptor } from '../../../../shared/GameInterfaces.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

export default class BlurEffect extends PostProcessEffect {
  /** Target of the horizontal pass, whose texture the vertical pass reads. */
  static intermediateTarget: RenderTarget | null = null;

  /** Nothing is blurred at a radius of 0. */
  override readonly neutral: PostProcessBlurDescriptor = { radius: 0.0 };

  constructor() {
    super('blur');
    this.stackable = true;
  }

  static resolveSettings(settings: PostProcessBlurDescriptor): PostProcessBlurDescriptor {
    return {
      radius: Number.isFinite(settings.radius ?? NaN) ? settings.radius : 4.0,
    };
  }

  override resolveSettings(settings: PostProcessBlurDescriptor): PostProcessBlurDescriptor {
    return BlurEffect.resolveSettings(settings);
  }

  override init(): void {
    BlurEffect.intermediateTarget = new RenderTarget({ name: 'blur-intermediate', color: [{ storage: 'texture', filter: 'linear' }], depth: null });
  }

  override resize(width: number, height: number): void {
    BlurEffect.intermediateTarget?.resize(width, height);
  }

  override shutdown(): void {
    BlurEffect.intermediateTarget?.free();
    BlurEffect.intermediateTarget = null;
  }

  #blurPass(inputTexture: GLRenderTexture, dirX: number, dirY: number, radius: number, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('blur');
    if (!program) {
      return;
    }
    inputTexture.bind(program.tTexture!);
    gl.uniform2f(program.uDirection!, dirX, dirY);
    gl.uniform1f(program.uRadius!, radius);
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  override apply(inputTexture: GLRenderTexture, x: number, y: number, width: number, height: number, settings: PostProcessBlurDescriptor | null | undefined, output: PostProcessOutput): void {
    const intermediate = BlurEffect.intermediateTarget;

    if (!intermediate) {
      return;
    }

    const s = BlurEffect.resolveSettings(settings ?? {});
    const radius = s.radius!;

    const pw = (width * VID.pixelRatio) >> 0;
    const ph = (height * VID.pixelRatio) >> 0;

    // Horizontal pass → intermediate FBO.
    intermediate.bind();
    gl.viewport(0, 0, pw, ph);
    this.#blurPass(inputTexture, 1.0, 0.0, radius, 0, 0, VID.width, VID.height);

    // Vertical pass → the output the chain handed in.
    RenderTarget.bindOutput(output.target);
    gl.viewport(output.viewport[0], output.viewport[1], output.viewport[2], output.viewport[3]);
    this.#blurPass(intermediate.colorTexture(0), 0.0, 1.0, radius, x, y, width, height);
  }
}
