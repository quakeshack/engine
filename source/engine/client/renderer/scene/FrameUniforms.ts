import { eventBus } from '../../../common/EventBus.ts';
import GL from '../../GL.ts';
import V from '../../V.ts';
import ShadowMap from '../lighting/ShadowMap.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import Camera from './Camera.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

const DEFAULT_FOG_COLOR = '128 128 128';

/**
 * The uniforms that have one value per frame and are the same for every draw: the view, the gamma, the global
 * fog and the shadow and point-light state. They are written to every program that declares them, so a draw only
 * has to set what is specific to itself.
 */
class FrameUniforms {
  /**
   * Writes the frame's uniforms to every program that declares them. Run after `Camera.UpdateMatrices()` and after
   * the shadow passes of the frame have chosen their lights.
   */
  static Upload(): void {
    if (V.gamma.value < 0.5) {
      V.gamma.set(0.5);
    } else if (V.gamma.value > 1.0) {
      V.gamma.set(1.0);
    }

    const fogColorParts = (rendererCvars.fog_color.string || DEFAULT_FOG_COLOR).split(/\s+/).map(Number);
    const fogColor = [(fogColorParts[0] || 128) / 255.0, (fogColorParts[1] || 128) / 255.0, (fogColorParts[2] || 128) / 255.0];

    GL.UnbindProgram();
    for (let i = 0; i < GL.programs.length; i++) {
      const program = GL.programs[i];
      gl.useProgram(program.program);
      if (program.uViewOrigin !== undefined) {
        gl.uniform3fv(program.uViewOrigin, Camera.refdef.vieworg);
      }
      if (program.uViewAngles !== undefined) {
        gl.uniformMatrix3fv(program.uViewAngles, false, Camera.rotation);
      }
      if (program.uPerspective !== undefined) {
        gl.uniformMatrix4fv(program.uPerspective, false, Camera.perspective);
      }
      if (program.uGamma !== undefined) {
        gl.uniform1f(program.uGamma, V.gamma.value);
      }
      // global fog uniforms (only set when shader declares them)
      if (program.uFogColor !== undefined) {
        gl.uniform3fv(program.uFogColor, fogColor);
      }
      if (program.uFogParams !== undefined) {
        // uFogParams = vec4(start, end, density, mode)
        gl.uniform4f(program.uFogParams, rendererCvars.fog_start.value, rendererCvars.fog_end.value, rendererCvars.fog_density.value, rendererCvars.fog_mode.value);
      }
      // shadow mapping uniforms (set on all programs that declare them)
      if (program.uLightSpaceMatrix !== undefined) {
        gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, ShadowMap.topdownMatrix);
      }
      if (program.uShadowEnabled !== undefined) {
        gl.uniform1f(program.uShadowEnabled, ShadowMap.enabled!.value ? 1.0 : 0.0);
      }
      if (program.uShadowDarkness !== undefined) {
        gl.uniform1f(program.uShadowDarkness, ShadowMap.darkness!.value);
      }
      if (program.uShadowMapSize !== undefined) {
        gl.uniform1f(program.uShadowMapSize, ShadowMap.size);
      }
      if (program.uShadowMaxDepthNDC !== undefined) {
        // Convert the world-unit max-depth cvar into the top-down shadow
        // map's normalized [0,1] depth space (which spans 2 * range world
        // units — see ShadowMap.updateTopDownMatrix's near/far planes).
        gl.uniform1f(program.uShadowMaxDepthNDC, ShadowMap.maxDepth!.value / (2.0 * ShadowMap.range!.value));
      }
      if (program.uShadowLightDir !== undefined) {
        gl.uniform3fv(program.uShadowLightDir, ShadowMap.lightDir);
      }
      // Point light shadow uniforms
      if (program.uPointShadowEnabled !== undefined) {
        gl.uniform1f(program.uPointShadowEnabled, ShadowMap.pointLightActiveCount > 0 ? 1.0 : 0.0);
      }
      if (program.uPointLightPos0 !== undefined) {
        gl.uniform3fv(program.uPointLightPos0, ShadowMap.pointLightOrigins[0]);
      }
      if (program.uPointLightRadius0 !== undefined) {
        gl.uniform1f(program.uPointLightRadius0, ShadowMap.pointLightRadii[0]);
      }
      if (program.uPointLightColor0 !== undefined) {
        gl.uniform3fv(program.uPointLightColor0, ShadowMap.pointLightColors[0]);
      }
      if (program.uPointLightPos1 !== undefined) {
        gl.uniform3fv(program.uPointLightPos1, ShadowMap.pointLightOrigins[1]);
      }
      if (program.uPointLightRadius1 !== undefined) {
        gl.uniform1f(program.uPointLightRadius1, ShadowMap.pointLightRadii[1]);
      }
      if (program.uPointLightColor1 !== undefined) {
        gl.uniform3fv(program.uPointLightColor1, ShadowMap.pointLightColors[1]);
      }
      if (program.uPointLightPos2 !== undefined) {
        gl.uniform3fv(program.uPointLightPos2, ShadowMap.pointLightOrigins[2]);
      }
      if (program.uPointLightRadius2 !== undefined) {
        gl.uniform1f(program.uPointLightRadius2, ShadowMap.pointLightRadii[2]);
      }
      if (program.uPointLightColor2 !== undefined) {
        gl.uniform3fv(program.uPointLightColor2, ShadowMap.pointLightColors[2]);
      }
      if (program.uPointShadowBias !== undefined) {
        gl.uniform1f(program.uPointShadowBias, ShadowMap.pointBias!.value);
      }
    }
  }
}

export default FrameUniforms;
