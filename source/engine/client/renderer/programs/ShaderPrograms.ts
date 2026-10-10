import { eventBus } from '../../../common/EventBus.ts';
import GL from '../../GL.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * The table of shader programs the renderer draws with: each entry names the program, the uniforms and attributes
 * it declares and the samplers it reads, and `GL.CreateProgram` compiles and links it from the shader library.
 */
class ShaderPrograms {
  /**
   * Compiles and links every program and announces them with `renderer.shaders.initialized`.
   */
  static async Init(): Promise<void> {
    // rendering alias models
    await Promise.all([
      Promise.resolve(GL.CreateProgram('alias',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPositionA', gl.FLOAT, 3],
          ['aPositionB', gl.FLOAT, 3],
          ['aNormal', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
        ],
        ['tTexture', 'tLuminance', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering mesh models (OBJ, IQM, GLTF)
      Promise.resolve(GL.CreateProgram('mesh',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPosition', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
          ['aNormal', gl.FLOAT, 3],
        ],
        ['tTexture', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering brush models (water is down below)
      Promise.resolve(GL.CreateProgram('brush',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uLightstyleInterpolation', 'uAlpha', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uHaveDeluxemap', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMapSize', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightColor0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightColor1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointLightColor2', 'uPointShadowEnabled', 'uBloomEmissiveScale', 'uBloomDlightScale', 'uBloomSpecularScale'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            ['aTangent', gl.FLOAT, 3],
            ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTextureA', 'tTextureB', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tLuminance', 'tSpecular', 'tNormal', 'tDeluxemap', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering dynamic lights
      Promise.resolve(GL.CreateProgram('dlight',
          ['uOrigin', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uRadius', 'uGamma'],
          [['aPosition', gl.FLOAT, 3]],
          [])),

      // rendering the player model (similar to alias model but with custom colors)
      Promise.resolve(GL.CreateProgram('player',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uTop', 'uBottom', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
          [
            ['aPositionA', gl.FLOAT, 3],
            ['aPositionB', gl.FLOAT, 3],
            ['aNormal', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 2],
          ],
          ['tTexture', 'tLuminance', 'tPlayer', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // for rendering sprites (usually effects)
      Promise.resolve(GL.CreateProgram('sprite',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams', 'uInterpolation', 'uAlpha', 'uBloomEmissiveScale'],
          [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2]],
          ['tTexture'])),

      // for rendering decals
      Promise.resolve(GL.CreateProgram('decal',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
          [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
          ['tTexture'])),

      // for rendering particles (colored round dots)
      Promise.resolve(GL.CreateProgram('particle',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
          [['aOrigin', gl.FLOAT, 3], ['aCoord', gl.FLOAT, 2], ['aScale', gl.FLOAT, 1], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
          [])),

      // rendering water brushes
      Promise.resolve(GL.CreateProgram('turbulent',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uTime', 'uInterpolation', 'uLightstyleInterpolation', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uAlpha', 'uBloomEmissiveScale', 'uBloomDlightScale', 'uScreenSize', 'uWaterFogDensity', 'uCameraInside'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            // ['aTangent', gl.FLOAT, 3],
            // ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTexture', 'tLuminance', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tDeluxemap', 'tDepth'])),

      // depth-only pre-pass for turbulent surface boundary (underwater fog)
      Promise.resolve(GL.CreateProgram('turbulent-depth',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uTime'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // underwater fog post-process effect
      Promise.resolve(GL.CreateProgram('underwater-fog',
        ['uOrtho', 'uFogColor', 'uFogDensity', 'uPerspective'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tScene', 'tDepth', 'tBoundaryDepth'])),

      // warp overlay effect
      Promise.resolve(GL.CreateProgram('warp',
          ['uOrtho', 'uTime'],
          [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
          ['tTexture'])),

      Promise.resolve(GL.CreateProgram('color-grade',
        ['uOrtho', 'uTime', 'uSaturation', 'uContrast', 'uExposure', 'uTintColor', 'uTintStrength', 'uPulseStrength', 'uPulsePeriod'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('blur',
        ['uOrtho', 'uDirection', 'uRadius'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-extract',
        ['uOrtho', 'uTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-blur',
        ['uOrtho', 'uTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-metric',
        ['uOrtho', 'uCoverageThreshold'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-adapt',
        ['uOrtho', 'uFrameTime', 'uSettleRate', 'uRecoverRate', 'uFirstFrame', 'uMinMultiplier', 'uBrightnessStart', 'uBrightnessEnd', 'uCoverageStart', 'uCoverageEnd'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tMetric', 'tPrevious'])),

      Promise.resolve(GL.CreateProgram('bloom-composite',
        ['uOrtho', 'uStrength', 'uBloomTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tScene', 'tBloom', 'tAdaptation'])),

      Promise.resolve(GL.CreateProgram('sky',
        ['uViewAngles', 'uPerspective', 'uScale', 'uGamma', 'uTime', 'uFogColor', 'uFogParams', 'uBloomEmissiveScale'],
        [['aPosition', gl.FLOAT, 3]],
        ['tSolid', 'tAlpha'])),

      Promise.resolve(GL.CreateProgram('sky-chain',
        ['uViewOrigin', 'uViewAngles', 'uPerspective'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // rendering volumetric fog brush volumes
      Promise.resolve(GL.CreateProgram('fog-volume',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma',
         'uFogVolumeColor', 'uFogVolumeDensity', 'uFogVolumeMaxOpacity',
         'uFogVolumeMins', 'uFogVolumeMaxs', 'uScreenSize',
         'uDlightCount',
         'uDlightPos[0]', 'uDlightPos[1]', 'uDlightPos[2]', 'uDlightPos[3]',
         'uDlightPos[4]', 'uDlightPos[5]', 'uDlightPos[6]', 'uDlightPos[7]',
         'uDlightColor[0]', 'uDlightColor[1]', 'uDlightColor[2]', 'uDlightColor[3]',
         'uDlightColor[4]', 'uDlightColor[5]', 'uDlightColor[6]', 'uDlightColor[7]'],
        [['aPosition', gl.FLOAT, 3]],
        ['tDepth', 'tLightProbe'])),

      // shadow depth pass for the top-down directional shadow
      Promise.resolve(GL.CreateProgram('shadow-brush',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uCasterFade'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for point light cube shadow mapping
      Promise.resolve(GL.CreateProgram('shadow-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uLightPos', 'uLightRadius', 'uNormalBias', 'uCasterFade'],
        [['aPosition', gl.FLOAT, 3], ['aNormal', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation', 'uCasterFade'],
        [['aPositionA', gl.FLOAT, 3], ['aPositionB', gl.FLOAT, 3]],
        [])),

      // point shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation', 'uLightPos', 'uLightRadius', 'uNormalBias', 'uCasterFade'],
        [['aPositionA', gl.FLOAT, 3], ['aPositionB', gl.FLOAT, 3], ['aNormalA', gl.FLOAT, 3], ['aNormalB', gl.FLOAT, 3]],
        [])),
    ]);

    eventBus.publish('renderer.shaders.initialized');
  }
}

export default ShaderPrograms;
