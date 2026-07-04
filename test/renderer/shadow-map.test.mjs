import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import ShadowMap from '../../source/engine/client/renderer/ShadowMap.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../physics/fixtures.mjs';

void describe('ShadowMap.renderPointLightShadow', () => {
  void test('limits entity casters to the active point light radius', () => {
    const previousCL = registry.CL;
    const previousGL = GL.gl;
    const previousBindVAO = GL.BindVAO;
    const previousUnbindVAO = GL.UnbindVAO;
    const previousUseProgram = GL.UseProgram;
    const previousRenderEntitiesShadow = ShadowMap.renderEntitiesShadow;
    const previousPointDepthCubes = ShadowMap.pointDepthCubes;
    const previousPointLightOrigins = ShadowMap.pointLightOrigins;
    const previousPointLightRadii = ShadowMap.pointLightRadii;
    const previousPointLightActiveCount = ShadowMap.pointLightActiveCount;

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
    ShadowMap.pointDepthCubes = [{}];
    ShadowMap.pointNormalBias = { value: 1.5 };
    ShadowMap.pointLightOrigins = [pointLightOrigin];
    ShadowMap.pointLightRadii = [pointLightRadius];
    ShadowMap.pointLightActiveCount = 1;

    try {
      ShadowMap.renderPointLightShadow();
    } finally {
      ShadowMap.renderEntitiesShadow = previousRenderEntitiesShadow;
      GL.UseProgram = previousUseProgram;
      GL.UnbindVAO = previousUnbindVAO;
      GL.BindVAO = previousBindVAO;
      ShadowMap.pointDepthCubes = previousPointDepthCubes;
      ShadowMap.pointLightOrigins = previousPointLightOrigins;
      ShadowMap.pointLightRadii = previousPointLightRadii;
      ShadowMap.pointLightActiveCount = previousPointLightActiveCount;

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

  void test('renders one cube per active point-light slot', () => {
    const previousCL = registry.CL;
    const previousGL = GL.gl;
    const previousBindVAO = GL.BindVAO;
    const previousUnbindVAO = GL.UnbindVAO;
    const previousUseProgram = GL.UseProgram;
    const previousRenderEntitiesShadow = ShadowMap.renderEntitiesShadow;
    const previousPointDepthCubes = ShadowMap.pointDepthCubes;
    const previousPointLightOrigins = ShadowMap.pointLightOrigins;
    const previousPointLightRadii = ShadowMap.pointLightRadii;
    const previousPointLightActiveCount = ShadowMap.pointLightActiveCount;

    const renderEntitiesCalls = [];
    const origins = [
      new Float64Array([0, 0, 0]),
      new Float64Array([64, 0, 0]),
      new Float64Array([128, 0, 0]),
    ];
    const radii = [100, 150, 200];
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
    ShadowMap.pointDepthCubes = [{}, {}, {}];
    ShadowMap.pointNormalBias = { value: 1.5 };
    ShadowMap.pointLightOrigins = origins;
    ShadowMap.pointLightRadii = radii;
    ShadowMap.pointLightActiveCount = 3;

    try {
      ShadowMap.renderPointLightShadow();
    } finally {
      ShadowMap.renderEntitiesShadow = previousRenderEntitiesShadow;
      GL.UseProgram = previousUseProgram;
      GL.UnbindVAO = previousUnbindVAO;
      GL.BindVAO = previousBindVAO;
      ShadowMap.pointDepthCubes = previousPointDepthCubes;
      ShadowMap.pointLightOrigins = previousPointLightOrigins;
      ShadowMap.pointLightRadii = previousPointLightRadii;
      ShadowMap.pointLightActiveCount = previousPointLightActiveCount;

      GL.gl = previousGL;
      if (previousGL) {
        eventBus.publish('gl.ready');
      } else {
        eventBus.publish('gl.shutdown');
      }

      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
    }

    // 3 active slots × 6 faces each — each dlight gets its own independent
    // cube depth map instead of only the single strongest one casting a shadow.
    assert.equal(renderEntitiesCalls.length, 18);

    for (let slot = 0; slot < 3; slot++) {
      const slotCalls = renderEntitiesCalls.slice(slot * 6, slot * 6 + 6);
      for (const call of slotCalls) {
        assert.equal(call[1], true);
        assert.equal(call[2], origins[slot]);
        assert.equal(call[3], radii[slot] * radii[slot]);
      }
    }
  });

  void test('skips world leaves that reference inline submodel faces', () => {
    const previousCL = registry.CL;
    const previousGL = GL.gl;
    const previousBindVAO = GL.BindVAO;
    const previousUnbindVAO = GL.UnbindVAO;
    const previousUseProgram = GL.UseProgram;
    const previousRenderEntitiesShadow = ShadowMap.renderEntitiesShadow;
    const previousPointDepthCubes = ShadowMap.pointDepthCubes;
    const previousPointLightOrigins = ShadowMap.pointLightOrigins;
    const previousPointLightRadii = ShadowMap.pointLightRadii;
    const previousPointLightActiveCount = ShadowMap.pointLightActiveCount;

    const drawCalls = [];
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
      drawArrays(_mode, first, count) {
        drawCalls.push([first, count]);
      },
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

    // Two leaves drawing from the shared world display list: the first only
    // references a world face, the second references an inline submodel face
    // baked at map-compile position and must be skipped.
    const worldLeaf = { skychain: 1, cmds: [[0, 0, 12]], firstmarksurface: 0, nummarksurfaces: 1 };
    const submodelLeaf = { skychain: 1, cmds: [[0, 12, 6]], firstmarksurface: 1, nummarksurfaces: 1 };

    registry.CL = {
      state: {
        worldmodel: {
          opaqueVAO: {},
          leafs: [worldLeaf, submodelLeaf],
          faces: [{ submodel: false }, { submodel: true }],
          marksurfaces: [0, 1],
          textures: [{ flags: 0 }],
        },
      },
    };
    eventBus.publish('registry.frozen');

    GL.gl = mockGl;
    eventBus.publish('gl.ready');

    GL.BindVAO = () => {};
    GL.UnbindVAO = () => {};
    GL.UseProgram = () => program;
    ShadowMap.renderEntitiesShadow = () => {};

    ShadowMap.pointFBO = {};
    ShadowMap.pointDepthCubes = [{}];
    ShadowMap.pointNormalBias = { value: 1.5 };
    ShadowMap.pointLightOrigins = [new Float64Array([0, 0, 0])];
    ShadowMap.pointLightRadii = [128];
    ShadowMap.pointLightActiveCount = 1;

    try {
      ShadowMap.renderPointLightShadow();
    } finally {
      ShadowMap._submodelLeafFlags = null;
      ShadowMap._submodelLeafFlagsModel = null;
      ShadowMap.renderEntitiesShadow = previousRenderEntitiesShadow;
      GL.UseProgram = previousUseProgram;
      GL.UnbindVAO = previousUnbindVAO;
      GL.BindVAO = previousBindVAO;
      ShadowMap.pointDepthCubes = previousPointDepthCubes;
      ShadowMap.pointLightOrigins = previousPointLightOrigins;
      ShadowMap.pointLightRadii = previousPointLightRadii;
      ShadowMap.pointLightActiveCount = previousPointLightActiveCount;

      GL.gl = previousGL;
      if (previousGL) {
        eventBus.publish('gl.ready');
      } else {
        eventBus.publish('gl.shutdown');
      }

      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
    }

    // The world leaf is drawn once per cube face; the submodel leaf never.
    assert.equal(drawCalls.length, 6);
    for (const [first, count] of drawCalls) {
      assert.equal(first, 0);
      assert.equal(count, 12);
    }
  });
});

void describe('ShadowMap.buildPointFaceMatrix', () => {
  /**
   * Transforms a world-space point through the face matrix into NDC depth.
   * @param {Float64Array} matrix column-major face view-projection matrix
   * @param {number} x world-space x
   * @param {number} y world-space y
   * @param {number} z world-space z
   * @returns {number} NDC depth in the [-1, 1] range
   */
  function ndcDepthAt(matrix, x, y, z) {
    const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    return clipZ / clipW;
  }

  void test('maps the near plane and light radius to the full NDC depth range', () => {
    const previousOrigins = ShadowMap.pointLightOrigins;
    const previousRadii = ShadowMap.pointLightRadii;

    try {
      ShadowMap.pointLightOrigins = [new Float64Array([10, -20, 30])];
      ShadowMap.pointLightRadii = [300];
      ShadowMap.buildPointFaceMatrix(0, 0); // +X face, slot 0

      const m = ShadowMap.pointFaceMatrix;
      // POINT_NEAR = 1.0 in front of the light along +X → NDC z = -1
      assert.ok(Math.abs(ndcDepthAt(m, 10 + 1, -20, 30) - (-1.0)) < 1e-9);
      // light radius → NDC z = +1
      assert.ok(Math.abs(ndcDepthAt(m, 10 + 300, -20, 30) - 1.0) < 1e-9);
    } finally {
      ShadowMap.pointLightOrigins = previousOrigins;
      ShadowMap.pointLightRadii = previousRadii;
    }
  });

  void test('stored depth matches the analytic reconstruction used by the scene shaders', () => {
    const previousOrigins = ShadowMap.pointLightOrigins;
    const previousRadii = ShadowMap.pointLightRadii;

    try {
      ShadowMap.pointLightOrigins = [new Float64Array([0, 0, 0])];
      ShadowMap.pointLightRadii = [200];
      ShadowMap.buildPointFaceMatrix(0, 0); // +X face, slot 0

      const m = ShadowMap.pointFaceMatrix;
      const n = 1.0;
      const f = 200;

      for (const dist of [2, 25, 100, 199]) {
        // window-space depth as stored by the rasterizer (0.5 * ndc + 0.5)
        const stored = ndcDepthAt(m, dist, 0, 0) * 0.5 + 0.5;
        // shader-side reconstruction (zero receiver bias)
        const reconstructed = (f * (dist - n)) / ((f - n) * dist);
        assert.ok(Math.abs(stored - reconstructed) < 1e-9, `depth mismatch at distance ${dist}`);
      }
    } finally {
      ShadowMap.pointLightOrigins = previousOrigins;
      ShadowMap.pointLightRadii = previousRadii;
    }
  });

  void test('selects the correct slot origin/radius when building a non-zero slot', () => {
    const previousOrigins = ShadowMap.pointLightOrigins;
    const previousRadii = ShadowMap.pointLightRadii;

    try {
      ShadowMap.pointLightOrigins = [
        new Float64Array([0, 0, 0]),
        new Float64Array([50, 0, 0]),
      ];
      ShadowMap.pointLightRadii = [300, 120];
      ShadowMap.buildPointFaceMatrix(0, 1); // +X face, slot 1

      const m = ShadowMap.pointFaceMatrix;
      assert.ok(Math.abs(ndcDepthAt(m, 50 + 1, 0, 0) - (-1.0)) < 1e-9);
      assert.ok(Math.abs(ndcDepthAt(m, 50 + 120, 0, 0) - 1.0) < 1e-9);
    } finally {
      ShadowMap.pointLightOrigins = previousOrigins;
      ShadowMap.pointLightRadii = previousRadii;
    }
  });
});

void describe('ShadowMap.selectPointLights', () => {
  /**
   * Minimal duck-typed ClientDlight-like mock: only the fields read by
   * selectPointLights() are populated.
   * @param {Vector} origin
   * @param {number} radius
   * @param {Vector} color
   * @returns {object} A mock ClientDlight-like light.
   */
  function createMockDlight(origin, radius, color = new Vector(1, 1, 1)) {
    return {
      origin,
      radius,
      color,
      isFree: () => radius <= 0,
    };
  }

  /**
   * Runs a callback with a minimal CL registry fixture exposing exactly
   * `dlights.length` dlight slots (padded with free/inactive lights beyond
   * that to match Def.limits.dlights).
   * @param {object[]} dlights
   * @param {() => void} callback
   */
  function withMockDlightRegistry(dlights, callback) {
    const previousCL = registry.CL;
    const previousPointEnabled = ShadowMap.pointEnabled;

    const padded = dlights.slice();
    while (padded.length < 32) {
      padded.push(createMockDlight(new Vector(), 0));
    }

    registry.CL = {
      state: {
        clientEntities: { dlights: padded },
      },
    };
    ShadowMap.pointEnabled = { value: 1 };
    eventBus.publish('registry.frozen');

    try {
      callback();
    } finally {
      registry.CL = previousCL;
      ShadowMap.pointEnabled = previousPointEnabled;
      eventBus.publish('registry.frozen');
    }
  }

  void test('selects up to 3 strongest dlights, strongest first', () => {
    const previousActiveCount = ShadowMap.pointLightActiveCount;
    const previousIndices = Int32Array.from(ShadowMap.pointLightDlightIndices);

    const dlights = [
      createMockDlight(new Vector(0, 0, 100), 300),  // score 3.0
      createMockDlight(new Vector(0, 0, 50), 300),   // score 6.0 (strongest)
      createMockDlight(new Vector(0, 0, 200), 300),  // score 1.5
      createMockDlight(new Vector(0, 0, 150), 300),  // score 2.0
    ];

    try {
      withMockDlightRegistry(dlights, () => {
        const count = ShadowMap.selectPointLights(new Vector(0, 0, 0));

        assert.equal(count, 3);
        assert.equal(ShadowMap.pointLightActiveCount, 3);
        assert.equal(ShadowMap.pointLightDlightIndices[0], 1); // strongest
        assert.equal(ShadowMap.pointLightDlightIndices[1], 0);
        assert.equal(ShadowMap.pointLightDlightIndices[2], 3);
        assert.equal(ShadowMap.pointLightOrigins[0][2], 50);
        assert.equal(ShadowMap.pointLightRadii[0], 300);
      });
    } finally {
      ShadowMap.pointLightActiveCount = previousActiveCount;
      ShadowMap.pointLightDlightIndices.set(previousIndices);
    }
  });

  void test('skips free (inactive) dlights', () => {
    const previousActiveCount = ShadowMap.pointLightActiveCount;
    const previousIndices = Int32Array.from(ShadowMap.pointLightDlightIndices);

    const dlights = [
      createMockDlight(new Vector(0, 0, 50), 0), // free — radius 0
      createMockDlight(new Vector(0, 0, 60), 300),
    ];

    try {
      withMockDlightRegistry(dlights, () => {
        const count = ShadowMap.selectPointLights(new Vector(0, 0, 0));

        assert.equal(count, 1);
        assert.equal(ShadowMap.pointLightDlightIndices[0], 1);
        assert.equal(ShadowMap.pointLightDlightIndices[1], -1);
      });
    } finally {
      ShadowMap.pointLightActiveCount = previousActiveCount;
      ShadowMap.pointLightDlightIndices.set(previousIndices);
    }
  });

  void test('returns 0 and clears indices when point shadows are disabled', () => {
    const previousActiveCount = ShadowMap.pointLightActiveCount;
    const previousIndices = Int32Array.from(ShadowMap.pointLightDlightIndices);
    const previousPointEnabled = ShadowMap.pointEnabled;

    const dlights = [createMockDlight(new Vector(0, 0, 50), 300)];

    try {
      withMockDlightRegistry(dlights, () => {
        ShadowMap.pointEnabled = { value: 0 };
        const count = ShadowMap.selectPointLights(new Vector(0, 0, 0));

        assert.equal(count, 0);
        assert.equal(ShadowMap.pointLightActiveCount, 0);
        assert.equal(ShadowMap.pointLightDlightIndices[0], -1);
        assert.equal(ShadowMap.pointLightDlightIndices[1], -1);
        assert.equal(ShadowMap.pointLightDlightIndices[2], -1);
      });
    } finally {
      ShadowMap.pointLightActiveCount = previousActiveCount;
      ShadowMap.pointLightDlightIndices.set(previousIndices);
      ShadowMap.pointEnabled = previousPointEnabled;
    }
  });

  void test('propagates each selected light color into pointLightColors', () => {
    const previousActiveCount = ShadowMap.pointLightActiveCount;
    const previousIndices = Int32Array.from(ShadowMap.pointLightDlightIndices);

    const lightColor = new Vector(0.2, 0.8, 0.4);
    const dlights = [createMockDlight(new Vector(0, 0, 50), 300, lightColor)];

    try {
      withMockDlightRegistry(dlights, () => {
        ShadowMap.selectPointLights(new Vector(0, 0, 0));

        assert.equal(ShadowMap.pointLightColors[0][0], lightColor[0]);
        assert.equal(ShadowMap.pointLightColors[0][1], lightColor[1]);
        assert.equal(ShadowMap.pointLightColors[0][2], lightColor[2]);
      });
    } finally {
      ShadowMap.pointLightActiveCount = previousActiveCount;
      ShadowMap.pointLightDlightIndices.set(previousIndices);
    }
  });

  void test('clears stale radii from slots that held a light last frame but are unused this frame', () => {
    // Regression test: an explosion dlight occupying slot 2 (because two
    // stronger lights held slots 0/1) must not leave a permanent unshadowed
    // glow behind once it expires and the active count drops, even though
    // the scene shaders derive their glow purely from radius (no separate
    // active-count uniform) — see selectPointLights()'s slot-clearing loop.
    const previousActiveCount = ShadowMap.pointLightActiveCount;
    const previousIndices = Int32Array.from(ShadowMap.pointLightDlightIndices);
    const previousRadii = ShadowMap.pointLightRadii.slice();

    try {
      const threeLights = [
        createMockDlight(new Vector(0, 0, 10), 400), // strongest -> slot 0
        createMockDlight(new Vector(0, 0, 20), 300), // slot 1
        createMockDlight(new Vector(0, 0, 30), 200), // weakest, e.g. the explosion -> slot 2
      ];

      withMockDlightRegistry(threeLights, () => {
        const count = ShadowMap.selectPointLights(new Vector(0, 0, 0));
        assert.equal(count, 3);
        assert.ok(ShadowMap.pointLightRadii[2] > 0, 'slot 2 should hold the explosion light');
      });

      // Next frame: only the strongest light remains (the other two, including
      // the explosion in slot 2, have died and are no longer candidates).
      const oneLight = [
        createMockDlight(new Vector(0, 0, 10), 400),
      ];

      withMockDlightRegistry(oneLight, () => {
        const count = ShadowMap.selectPointLights(new Vector(0, 0, 0));

        assert.equal(count, 1);
        assert.equal(ShadowMap.pointLightRadii[1], 0, 'stale slot 1 radius must be cleared');
        assert.equal(ShadowMap.pointLightRadii[2], 0, 'stale slot 2 radius (the expired explosion) must be cleared');
      });
    } finally {
      ShadowMap.pointLightActiveCount = previousActiveCount;
      ShadowMap.pointLightDlightIndices.set(previousIndices);
      ShadowMap.pointLightRadii.splice(0, ShadowMap.pointLightRadii.length, ...previousRadii);
    }
  });
});

void describe('ShadowMap.updateTopDownMatrix', () => {
  /**
   * Transforms a world-space point through the light-space matrix into NDC.
   * @param {Float64Array} matrix column-major light-space view-projection matrix
   * @param {number} x world-space x
   * @param {number} y world-space y
   * @param {number} z world-space z
   * @returns {{x: number, y: number, z: number, w: number}} Clip-space coordinates.
   */
  function transform(matrix, x, y, z) {
    return {
      x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
      w: matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
    };
  }

  void test('centers the frustum on the camera, independent of any entity or light', () => {
    const previousRange = ShadowMap.range;
    const previousYaw = ShadowMap.yaw;
    const previousPitch = ShadowMap.pitch;

    try {
      ShadowMap.range = { value: 512 };
      ShadowMap.yaw = { value: 0 };
      ShadowMap.pitch = { value: -90 }; // straight down

      ShadowMap.updateTopDownMatrix(new Vector(100, 200, 300));

      const m = ShadowMap.topdownMatrix;
      // The camera position itself must land at the center of the ortho
      // frustum (NDC x/y ≈ 0), regardless of range. Tolerance accounts for
      // the deliberate texel-snap on the frustum's translation (up to one
      // texel width, 2/TOPDOWN_SHADOW_SIZE in NDC, to stop the shadow from
      // shimmering as the camera moves continuously).
      const clip = transform(m, 100, 200, 300);
      const texelToleranceNdc = 2.0 / 2048 + 1e-6;
      assert.ok(Math.abs(clip.x / clip.w) < texelToleranceNdc, `expected NDC x≈0, got ${clip.x / clip.w}`);
      assert.ok(Math.abs(clip.y / clip.w) < texelToleranceNdc, `expected NDC y≈0, got ${clip.y / clip.w}`);
    } finally {
      ShadowMap.range = previousRange;
      ShadowMap.yaw = previousYaw;
      ShadowMap.pitch = previousPitch;
    }
  });

  void test('a point straight down from the camera stays centered horizontally with a straight-down pitch', () => {
    const previousRange = ShadowMap.range;
    const previousYaw = ShadowMap.yaw;
    const previousPitch = ShadowMap.pitch;

    try {
      ShadowMap.range = { value: 512 };
      ShadowMap.yaw = { value: 0 };
      ShadowMap.pitch = { value: -90 };

      ShadowMap.updateTopDownMatrix(new Vector(0, 0, 0));

      const m = ShadowMap.topdownMatrix;
      const clip = transform(m, 0, 0, -200); // straight down from the camera
      assert.ok(Math.abs(clip.x / clip.w) < 1e-6, `expected NDC x≈0, got ${clip.x / clip.w}`);
      assert.ok(Math.abs(clip.y / clip.w) < 1e-6, `expected NDC y≈0, got ${clip.y / clip.w}`);
    } finally {
      ShadowMap.range = previousRange;
      ShadowMap.yaw = previousYaw;
      ShadowMap.pitch = previousPitch;
    }
  });

  void test('a point at the edge of the range maps close to the NDC boundary', () => {
    const previousRange = ShadowMap.range;
    const previousYaw = ShadowMap.yaw;
    const previousPitch = ShadowMap.pitch;

    try {
      ShadowMap.range = { value: 256 };
      ShadowMap.yaw = { value: 0 };
      ShadowMap.pitch = { value: -90 };

      ShadowMap.updateTopDownMatrix(new Vector(0, 0, 0));

      const m = ShadowMap.topdownMatrix;
      // Looking straight down is a degenerate case for the "which world axis
      // is the frustum's right axis" question (see updateTopDownMatrix's
      // near-vertical fallback), so probe both horizontal world axes and
      // require at least one of them to hit the NDC boundary — whichever one
      // the fallback picked as "right" this time.
      const clipX = transform(m, 256, 0, -50);
      const clipY = transform(m, 0, 256, -50);
      const ndcMagnitudeX = Math.abs(clipX.x / clipX.w);
      const ndcMagnitudeY = Math.abs(clipY.x / clipY.w);
      const hitsBoundary = Math.abs(ndcMagnitudeX - 1.0) < 0.02 || Math.abs(ndcMagnitudeY - 1.0) < 0.02;
      assert.ok(hitsBoundary, `expected an offset of range along one horizontal axis to reach NDC x≈1, got x-offset→${ndcMagnitudeX}, y-offset→${ndcMagnitudeY}`);
    } finally {
      ShadowMap.range = previousRange;
      ShadowMap.yaw = previousYaw;
      ShadowMap.pitch = previousPitch;
    }
  });

  void test('stores the light travel direction for the shader-side surface-facing mask', () => {
    const previousRange = ShadowMap.range;
    const previousYaw = ShadowMap.yaw;
    const previousPitch = ShadowMap.pitch;

    try {
      ShadowMap.range = { value: 512 };
      ShadowMap.yaw = { value: 0 };
      ShadowMap.pitch = { value: -90 }; // straight down

      ShadowMap.updateTopDownMatrix(new Vector(0, 0, 0));

      // Straight down means the light travels along -Z.
      assertNear(ShadowMap.lightDir[0], 0, 1e-6);
      assertNear(ShadowMap.lightDir[1], 0, 1e-6);
      assertNear(ShadowMap.lightDir[2], -1, 1e-6);
    } finally {
      ShadowMap.range = previousRange;
      ShadowMap.yaw = previousYaw;
      ShadowMap.pitch = previousPitch;
    }
  });
});

void describe('ShadowMap.renderTopDownShadow', () => {
  /**
   * Builds a minimal mock gl/program pair sufficient for renderTopDownShadow
   * and returns the recorded draw/renderEntitiesShadow calls.
   * @param {(mode: number, first: number, count: number) => void} onDrawArrays
   * @returns {{mockGl: object, program: object}} The mock GL context and shadow-brush program stub.
   */
  function createMockGl(onDrawArrays) {
    const mockGl = {
      FRAMEBUFFER: 0,
      DEPTH_ATTACHMENT: 1,
      TEXTURE_2D: 2,
      DEPTH_BUFFER_BIT: 3,
      DEPTH_TEST: 4,
      CULL_FACE: 5,
      POLYGON_OFFSET_FILL: 6,
      FRONT: 7,
      bindFramebuffer() {},
      viewport() {},
      enable() {},
      disable() {},
      clear() {},
      colorMask() {},
      polygonOffset() {},
      cullFace() {},
      uniform3f() {},
      uniformMatrix3fv() {},
      uniformMatrix4fv() {},
      uniform1f() {},
      drawArrays: onDrawArrays,
    };
    const program = {
      uOrigin: null,
      uAngles: null,
      uLightSpaceMatrix: null,
      uCasterFade: null,
    };
    return { mockGl, program };
  }

  void test('renders only entities, never world geometry, centered on the camera', () => {
    const previousCL = registry.CL;
    const previousGL = GL.gl;
    const previousRenderEntitiesShadow = ShadowMap.renderEntitiesShadow;
    const previousRange = ShadowMap.range;
    const previousYaw = ShadowMap.yaw;
    const previousPitch = ShadowMap.pitch;
    const previousTopdownFBO = ShadowMap.topdownFBO;

    const drawCalls = [];
    const renderEntitiesCalls = [];
    const { mockGl } = createMockGl((_mode, first, count) => {
      drawCalls.push([first, count]);
    });

    // A worldmodel is present (shadows require an active map) but its leafs
    // must never be walked or drawn by this pass — a literal top-down ray
    // would be blocked by whatever roof is overhead, which would mark
    // virtually every indoor room "in shadow" all the time instead of just
    // the spots actually shadowed by something.
    const worldLeaf = { skychain: 1, cmds: [[0, 0, 12]], firstmarksurface: 0, nummarksurfaces: 1 };

    registry.CL = {
      state: {
        worldmodel: {
          opaqueVAO: {},
          leafs: [worldLeaf],
          faces: [{ submodel: false }],
          marksurfaces: [0],
          textures: [{ flags: 0 }],
        },
      },
    };
    eventBus.publish('registry.frozen');

    GL.gl = mockGl;
    eventBus.publish('gl.ready');
    ShadowMap.renderEntitiesShadow = (...args) => {
      renderEntitiesCalls.push(args);
    };

    ShadowMap.topdownFBO = {};
    ShadowMap.range = { value: 512 };
    ShadowMap.yaw = { value: 0 };
    ShadowMap.pitch = { value: -90 };

    const viewOrigin = new Vector(10, 20, 30);

    try {
      ShadowMap.renderTopDownShadow(viewOrigin);
    } finally {
      ShadowMap.renderEntitiesShadow = previousRenderEntitiesShadow;
      ShadowMap.range = previousRange;
      ShadowMap.yaw = previousYaw;
      ShadowMap.pitch = previousPitch;
      ShadowMap.topdownFBO = previousTopdownFBO;

      GL.gl = previousGL;
      if (previousGL) {
        eventBus.publish('gl.ready');
      } else {
        eventBus.publish('gl.shutdown');
      }

      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
    }

    // No world geometry is drawn into the depth map.
    assert.equal(drawCalls.length, 0);

    // Entities are rendered once, centered on the camera with a
    // range²-based cutoff, and not flagged as a point-light pass.
    assert.equal(renderEntitiesCalls.length, 1);
    const [, isPointLight, cutoffOrigin, cutoffDistSq] = renderEntitiesCalls[0];
    assert.equal(isPointLight, false);
    assert.equal(cutoffOrigin, viewOrigin);
    assert.equal(cutoffDistSq, 512 * 512);
  });

  void test('does nothing when there is no worldmodel', () => {
    const previousCL = registry.CL;
    let bindFramebufferCalls = 0;

    registry.CL = { state: { worldmodel: null } };
    eventBus.publish('registry.frozen');

    const previousGL = GL.gl;
    GL.gl = { bindFramebuffer() { bindFramebufferCalls++; } };
    eventBus.publish('gl.ready');

    try {
      ShadowMap.renderTopDownShadow(new Vector(0, 0, 0));
    } finally {
      GL.gl = previousGL;
      if (previousGL) {
        eventBus.publish('gl.ready');
      } else {
        eventBus.publish('gl.shutdown');
      }
      registry.CL = previousCL;
      eventBus.publish('registry.frozen');
    }

    assert.equal(bindFramebufferCalls, 0);
  });
});
