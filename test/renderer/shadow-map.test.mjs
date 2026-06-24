import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import ShadowMap from '../../source/engine/client/renderer/ShadowMap.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

void describe('ShadowMap.renderPointLightShadow', () => {
  void test('limits entity casters to the active point light radius', () => {
    const previousCL = registry.CL;
    const previousGL = GL.gl;
    const previousBindVAO = GL.BindVAO;
    const previousUnbindVAO = GL.UnbindVAO;
    const previousUseProgram = GL.UseProgram;
    const previousRenderEntitiesShadow = ShadowMap.renderEntitiesShadow;

    const renderEntitiesCalls = [];
    const pointLightOrigin = new Float64Array([128, -64, 32]);
    const pointLightRadius = 192;
    const mockGl = {
      FRAMEBUFFER: 0,
      DEPTH_ATTACHMENT: 1,
      TEXTURE_CUBE_MAP_POSITIVE_X: 2,
      DEPTH_BUFFER_BIT: 3,
      DEPTH_TEST: 4,
      CULL_FACE: 5,
      bindFramebuffer() {},
      viewport() {},
      enable() {},
      colorMask() {},
      disable() {},
      uniform3f() {},
      uniformMatrix3fv() {},
      uniform3fv() {},
      uniform1f() {},
      framebufferTexture2D() {},
      clear() {},
      uniformMatrix4fv() {},
      drawArrays() {},
      cullFace() {},
    };
    const program = {
      uOrigin: null,
      uAngles: null,
      uLightPos: null,
      uLightRadius: null,
      uNormalBias: null,
      uLightSpaceMatrix: null,
    };

    registry.CL = {
      state: {
        worldmodel: {
          opaqueVAO: {},
          leafs: [],
        },
      },
    };
    eventBus.publish('registry.frozen');

    GL.gl = mockGl;
    eventBus.publish('gl.ready');

    GL.BindVAO = () => {};
    GL.UnbindVAO = () => {};
    GL.UseProgram = () => program;
    ShadowMap.renderEntitiesShadow = (...args) => {
      renderEntitiesCalls.push(args);
    };

    ShadowMap.pointFBO = {};
    ShadowMap.pointDepthCube = {};
    ShadowMap.pointNormalBias = { value: 1.5 };
    ShadowMap.pointLightOrigin = pointLightOrigin;
    ShadowMap.pointLightRadius = pointLightRadius;

    try {
      ShadowMap.renderPointLightShadow();
    } finally {
      ShadowMap.renderEntitiesShadow = previousRenderEntitiesShadow;
      GL.UseProgram = previousUseProgram;
      GL.UnbindVAO = previousUnbindVAO;
      GL.BindVAO = previousBindVAO;

      GL.gl = previousGL;
      if (previousGL) {
        eventBus.publish('gl.ready');
      } else {
        eventBus.publish('gl.shutdown');
      }

      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
    }

    assert.equal(renderEntitiesCalls.length, 6);

    for (const call of renderEntitiesCalls) {
      assert.equal(call[1], true);
      assert.equal(call[2], pointLightOrigin);
      assert.equal(call[3], pointLightRadius * pointLightRadius);
    }
  });
});
