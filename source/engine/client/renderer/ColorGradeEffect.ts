import GL from '../GL.ts';
import Host from '../../common/Host.ts';
import PostProcess from './PostProcess.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import { eventBus } from '../../registry.ts';
import type { PostProcessColorGradeDescriptor } from '../../../shared/GameInterfaces.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

export default class ColorGradeEffect extends PostProcessEffect {
  constructor() {
    super('color-grade');
    this.stackable = true;
  }

  static resolveSettings(settings: PostProcessColorGradeDescriptor): PostProcessColorGradeDescriptor {
    return {
      saturation: Number.isFinite(settings.saturation ?? NaN) ? settings.saturation : 1.0,
      contrast: Number.isFinite(settings.contrast ?? NaN) ? settings.contrast : 1.0,
      exposure: Number.isFinite(settings.exposure ?? NaN) ? settings.exposure : 0.0,
      tintColor: settings.tintColor,
      tintStrength: Number.isFinite(settings.tintStrength ?? NaN) ? settings.tintStrength : 0.0,
      pulseStrength: Number.isFinite(settings.pulseStrength ?? NaN) ? settings.pulseStrength : 0.0,
      pulsePeriod: Number.isFinite(settings.pulsePeriod ?? NaN) ? settings.pulsePeriod : 0.0,
    };
  }

  override apply(inputTexture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('color-grade')!;
    console.assert(program !== null, 'ColorGradeEffect: shader program not found');
    GL.Bind(program.tTexture!, inputTexture);
    const s = ColorGradeEffect.resolveSettings(PostProcess.getStackEntry('color-grade') ?? {});
    const tint = s.tintColor;
    gl.uniform1f(program.uTime!, Host.realtime);
    gl.uniform1f(program.uSaturation!, s.saturation!);
    gl.uniform1f(program.uContrast!, s.contrast!);
    gl.uniform1f(program.uExposure!, s.exposure!);
    gl.uniform3f(program.uTintColor!, tint ? tint[0] : 1.0, tint ? tint[1] : 1.0, tint ? tint[2] : 1.0);
    gl.uniform1f(program.uTintStrength!, s.tintStrength!);
    gl.uniform1f(program.uPulseStrength!, s.pulseStrength!);
    gl.uniform1f(program.uPulsePeriod!, s.pulsePeriod!);
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }
}
