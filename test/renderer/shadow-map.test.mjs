import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import ShadowMap from '../../source/engine/client/renderer/ShadowMap.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import Vector from '../../source/shared/Vector.ts';

/**
 * Runs a callback with a minimal CL/SV registry fixture for local-light
 * selection tests: an empty visible-entity list (so the shadow focus point
 * falls back to the supplied view origin) and a line-of-sight trace that
 * always reports visible unless overridden.
 * @param {(start: Vector, end: Vector) => { fraction: number, allsolid: boolean, startsolid: boolean }} traceStaticWorldLine
 * @param {() => void} callback
 */
function withMockLocalLightRegistry(traceStaticWorldLine, callback) {
  const previousCL = registry.CL;
  const previousSV = registry.SV;
  const previousMinElevation = ShadowMap.minElevation;

  registry.CL = {
    state: {
      clientEntities: { getVisibleEntities: () => [] },
    },
  };
  registry.SV = { collision: { traceStaticWorldLine } };
  eventBus.publish('registry.frozen');

  // Matches the r_shadow_min_elevation cvar's default (init() isn't run in
  // these tests, so the cvar itself is never constructed).
  ShadowMap.minElevation = { value: 20 };

  const restore = () => {
    registry.CL = previousCL;
    registry.SV = previousSV;
    ShadowMap.minElevation = previousMinElevation;
    eventBus.publish('registry.frozen');
  };

  try {
    callback();
  } finally {
    restore();
  }
}

/** Int32Array with no previously-selected local shadow slots (matches ShadowMap's slot count). */
const NO_PREVIOUS_SELECTION = new Int32Array([-1, -1, -1]);

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

void describe('ShadowMap._applyFallbackDirection', () => {
  void test('derives (0, 0, -1) from the default straight-down pitch, ignoring yaw', () => {
    const previousYaw = ShadowMap.sunYaw;
    const previousPitch = ShadowMap.sunPitch;

    try {
      ShadowMap.sunYaw = { value: 225 };
      ShadowMap.sunPitch = { value: -90 };
      ShadowMap._applyFallbackDirection(0);

      const dir = ShadowMap.localLightDirs[0];
      assert.ok(Math.abs(dir[0]) < 1e-9, `expected x≈0, got ${dir[0]}`);
      assert.ok(Math.abs(dir[1]) < 1e-9, `expected y≈0, got ${dir[1]}`);
      assert.ok(Math.abs(dir[2] - (-1.0)) < 1e-9, `expected z≈-1, got ${dir[2]}`);
    } finally {
      ShadowMap.sunYaw = previousYaw;
      ShadowMap.sunPitch = previousPitch;
    }
  });

  void test('honors a horizontal fallback direction (pitch 0)', () => {
    const previousYaw = ShadowMap.sunYaw;
    const previousPitch = ShadowMap.sunPitch;

    try {
      ShadowMap.sunYaw = { value: 90 };
      ShadowMap.sunPitch = { value: 0 };
      ShadowMap._applyFallbackDirection(1);

      const dir = ShadowMap.localLightDirs[1];
      assert.ok(Math.abs(dir[0]) < 1e-9, `expected x≈0, got ${dir[0]}`);
      assert.ok(Math.abs(dir[1] - 1.0) < 1e-9, `expected y≈1, got ${dir[1]}`);
      assert.ok(Math.abs(dir[2]) < 1e-9, `expected z≈0, got ${dir[2]}`);
    } finally {
      ShadowMap.sunYaw = previousYaw;
      ShadowMap.sunPitch = previousPitch;
    }
  });

  void test('clears the slot as map-light-driven and resets falloff', () => {
    const previousYaw = ShadowMap.sunYaw;
    const previousPitch = ShadowMap.sunPitch;
    const previousIndex = ShadowMap._currentLocalLightIndices[0];
    const previousFalloff = ShadowMap.localLightFalloff;

    try {
      ShadowMap.sunYaw = { value: 0 };
      ShadowMap.sunPitch = { value: -90 };
      ShadowMap._currentLocalLightIndices[0] = 3;
      ShadowMap.localLightFalloff = 0.2;

      ShadowMap._applyFallbackDirection(0);

      assert.equal(ShadowMap._currentLocalLightIndices[0], -1);
      assert.equal(ShadowMap.localLightFalloff, 1.0);
    } finally {
      ShadowMap.sunYaw = previousYaw;
      ShadowMap.sunPitch = previousPitch;
      ShadowMap._currentLocalLightIndices[0] = previousIndex;
      ShadowMap.localLightFalloff = previousFalloff;
    }
  });
});

void describe('ShadowMap._selectNearbyMapLights', () => {
  void test('returns the strongest lights in score order, skipping ones the focus point is out of range of', () => {
    const previousEntities = ShadowMap.lightEntities;
    const previousTraceScratch = ShadowMap._lightTraceScratch;

    try {
      // All lights placed directly overhead/underneath (elevation 90°) so
      // only range and score are under test here.
      ShadowMap.lightEntities = [
        { origin: new Vector(0, 0, 1000), radius: 100 }, // out of range: dist (1000) >= radius (100)
        { origin: new Vector(0, 0, 100), radius: 300 },  // score 3.0
        { origin: new Vector(0, 0, 50), radius: 300 },   // score 6.0 (strongest)
      ];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        const selected = ShadowMap._selectNearbyMapLights(new Vector(0, 0, 0), NO_PREVIOUS_SELECTION);

        assert.equal(selected.length, 2);
        assert.equal(selected[0].index, 2); // strongest first
        assert.equal(selected[1].index, 1);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
      ShadowMap._lightTraceScratch = previousTraceScratch;
    }
  });

  void test('rejects grazing-angle lights below r_shadow_min_elevation', () => {
    const previousEntities = ShadowMap.lightEntities;

    try {
      ShadowMap.lightEntities = [
        { origin: new Vector(100, 0, 0), radius: 300 },  // perfectly horizontal (elevation 0°)
        { origin: new Vector(0, 0, 100), radius: 300 },  // directly overhead (elevation 90°)
      ];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        const selected = ShadowMap._selectNearbyMapLights(new Vector(0, 0, 0), NO_PREVIOUS_SELECTION);

        assert.equal(selected.length, 1);
        assert.equal(selected[0].index, 1);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
    }
  });

  void test('skips lights that fail the line-of-sight trace and falls through to the next candidate', () => {
    const previousEntities = ShadowMap.lightEntities;

    try {
      ShadowMap.lightEntities = [
        { origin: new Vector(0, 0, 50), radius: 300 },  // strongest, but occluded
        { origin: new Vector(0, 0, 100), radius: 300 }, // weaker, but visible
      ];

      withMockLocalLightRegistry((start) => {
        // Blocks both the direct trace from the light origin (50) and the
        // nudged retry _traceLightVisible falls back to (~34, biased toward
        // the focus point), so this light is occluded regardless of nudging.
        const occluded = Math.abs(start[2] - 50) < 20;
        return { fraction: occluded ? 0.5 : 1.0, allsolid: false, startsolid: false };
      }, () => {
        const selected = ShadowMap._selectNearbyMapLights(new Vector(0, 0, 0), NO_PREVIOUS_SELECTION);

        assert.equal(selected.length, 1);
        assert.equal(selected[0].index, 1);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
    }
  });

  void test('caps selections at LOCAL_SHADOW_COUNT even with more visible candidates', () => {
    const previousEntities = ShadowMap.lightEntities;

    try {
      ShadowMap.lightEntities = [
        { origin: new Vector(0, 0, 50), radius: 300 },
        { origin: new Vector(0, 0, 60), radius: 300 },
        { origin: new Vector(0, 0, 70), radius: 300 },
        { origin: new Vector(0, 0, 80), radius: 300 },
      ];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        const selected = ShadowMap._selectNearbyMapLights(new Vector(0, 0, 0), NO_PREVIOUS_SELECTION);

        assert.equal(selected.length, ShadowMap.localLightDirs.length);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
    }
  });

  void test('returns no selections when no light entities are parsed', () => {
    const previousEntities = ShadowMap.lightEntities;

    try {
      ShadowMap.lightEntities = [];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        const selected = ShadowMap._selectNearbyMapLights(new Vector(0, 0, 0), NO_PREVIOUS_SELECTION);

        assert.equal(selected.length, 0);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
    }
  });

  void test('keeps a previously-selected light over a slightly stronger new candidate (selection hysteresis)', () => {
    const previousEntities = ShadowMap.lightEntities;

    try {
      // Candidate 1 was in a slot last frame (score 5.0); candidate 0 is a
      // new, only slightly stronger option (score 5.5) that shouldn't be
      // able to displace it — a difference this small is the kind of noise
      // that would otherwise flip the selection (and its direction) every
      // frame as the player takes a single step.
      ShadowMap.lightEntities = [
        { origin: new Vector(0, 0, 55), radius: 300 }, // score 300/55 ≈ 5.45
        { origin: new Vector(0, 0, 60), radius: 300 }, // score 300/60 = 5.0
      ];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        const previousIndices = Int32Array.from([1, -1, -1]);
        const selected = ShadowMap._selectNearbyMapLights(new Vector(0, 0, 0), previousIndices);

        assert.equal(selected.length, 2);
        assert.equal(selected[0].index, 1); // incumbent stays on top despite the weaker raw score
        assert.equal(selected[1].index, 0);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
    }
  });

  void test('a clearly stronger new candidate still displaces the incumbent', () => {
    const previousEntities = ShadowMap.lightEntities;

    try {
      ShadowMap.lightEntities = [
        { origin: new Vector(0, 0, 20), radius: 300 }, // score 15.0, far stronger than stickiness can protect against
        { origin: new Vector(0, 0, 60), radius: 300 }, // score 5.0, incumbent
      ];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        const previousIndices = Int32Array.from([1, -1, -1]);
        const selected = ShadowMap._selectNearbyMapLights(new Vector(0, 0, 0), previousIndices);

        assert.equal(selected[0].index, 0);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
    }
  });
});

void describe('ShadowMap.selectLocalLights', () => {
  void test('drives local shadow directions from nearby visible map lights instead of a fixed top-down direction', () => {
    const previousEntities = ShadowMap.lightEntities;
    const previousCount = ShadowMap.localLightCount;
    const previousIndicesState = Int32Array.from(ShadowMap._currentLocalLightIndices);

    try {
      // One light below the focus point, one above — directions should point
      // away from each light towards the focus point (light → scene), not
      // both be forced to the old fixed (0, 0, -1) top-down vector.
      ShadowMap.lightEntities = [
        { origin: new Vector(0, 0, -100), radius: 300 }, // below
        { origin: new Vector(0, 0, 100), radius: 300 },  // above
      ];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        ShadowMap.selectLocalLights(new Vector(0, 0, 0));

        assert.equal(ShadowMap.localLightCount, 2);

        const dirFromBelow = ShadowMap.localLightDirs[0];
        assert.ok(Math.abs(dirFromBelow[2] - 1.0) < 1e-9, `expected z≈1, got ${dirFromBelow[2]}`);

        const dirFromAbove = ShadowMap.localLightDirs[1];
        assert.ok(Math.abs(dirFromAbove[2] - (-1.0)) < 1e-9, `expected z≈-1, got ${dirFromAbove[2]}`);

        assert.equal(ShadowMap._currentLocalLightIndices[0], 0);
        assert.equal(ShadowMap._currentLocalLightIndices[1], 1);
        assert.equal(ShadowMap._currentLocalLightIndices[2], -1);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
      ShadowMap.localLightCount = previousCount;
      ShadowMap._currentLocalLightIndices.set(previousIndicesState);
    }
  });

  void test('falls back to a single configured direction when no map light is in range', () => {
    const previousEntities = ShadowMap.lightEntities;
    const previousCount = ShadowMap.localLightCount;
    const previousYaw = ShadowMap.sunYaw;
    const previousPitch = ShadowMap.sunPitch;

    try {
      ShadowMap.lightEntities = [];
      ShadowMap.sunYaw = { value: 0 };
      ShadowMap.sunPitch = { value: -90 };

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        ShadowMap.selectLocalLights(new Vector(0, 0, 0));

        assert.equal(ShadowMap.localLightCount, 1);
        const dir = ShadowMap.localLightDirs[0];
        assert.ok(Math.abs(dir[2] - (-1.0)) < 1e-9, `expected z≈-1, got ${dir[2]}`);
        assert.equal(ShadowMap._currentLocalLightIndices[0], -1);
        assert.equal(ShadowMap._currentLocalLightIndices[1], -1);
        assert.equal(ShadowMap._currentLocalLightIndices[2], -1);
        assert.equal(ShadowMap.localLightFalloff, 1.0);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
      ShadowMap.localLightCount = previousCount;
      ShadowMap.sunYaw = previousYaw;
      ShadowMap.sunPitch = previousPitch;
    }
  });

  void test('fades localLightFalloff towards 0 as the closest active light nears the edge of its radius', () => {
    const previousEntities = ShadowMap.lightEntities;
    const previousCount = ShadowMap.localLightCount;
    const previousFalloff = ShadowMap.localLightFalloff;

    try {
      // A single light 270 units below a 300-unit-radius focus point: 90% of
      // the way to the edge of its influence, so the shadow should be mostly
      // faded rather than at full configured darkness.
      ShadowMap.lightEntities = [
        { origin: new Vector(0, 0, -270), radius: 300 },
      ];

      withMockLocalLightRegistry(() => ({ fraction: 1.0, allsolid: false, startsolid: false }), () => {
        ShadowMap.selectLocalLights(new Vector(0, 0, 0));

        assert.equal(ShadowMap.localLightCount, 1);
        assert.ok(Math.abs(ShadowMap.localLightFalloff - 0.1) < 1e-9, `expected falloff≈0.1, got ${ShadowMap.localLightFalloff}`);
      });
    } finally {
      ShadowMap.lightEntities = previousEntities;
      ShadowMap.localLightCount = previousCount;
      ShadowMap.localLightFalloff = previousFalloff;
    }
  });
});

void describe('ShadowMap.selectLocalLights anchor hysteresis', () => {
  /**
   * Minimal duck-typed local-shadow-caster entity: only the fields read by
   * _isLocalShadowCasterEntity() and selectLocalLights() are populated.
   * @param {number} num
   * @param {Vector} origin
   * @returns {object} A mock ClientEdict-like entity.
   */
  function createCasterEntity(num, origin) {
    return {
      num,
      model: { name: 'progs/soldier.mdl' },
      alpha: 1.0,
      effects: 0,
      isStatic: () => false,
      lerp: { origin },
    };
  }

  void test('keeps the previous anchor entity when a new candidate is not meaningfully closer', () => {
    const previousCount = ShadowMap.localLightCount;
    const previousAnchorNum = ShadowMap._previousAnchorNum;
    const previousEntities = ShadowMap.lightEntities;
    const previousYaw = ShadowMap.sunYaw;
    const previousPitch = ShadowMap.sunPitch;
    const previousMinElevation = ShadowMap.minElevation;

    try {
      ShadowMap.lightEntities = [];
      const entityA = createCasterEntity(1, new Vector(100, 0, 0));
      const entityB = createCasterEntity(2, new Vector(90, 0, 0)); // marginally closer

      const previousCL = registry.CL;
      const previousSV = registry.SV;
      registry.CL = { state: { clientEntities: { getVisibleEntities: () => [entityA] } } };
      registry.SV = { collision: { traceStaticWorldLine: () => ({ fraction: 1.0, allsolid: false, startsolid: false }) } };
      eventBus.publish('registry.frozen');
      ShadowMap.minElevation = { value: 20 };
      ShadowMap.sunYaw = { value: 0 };
      ShadowMap.sunPitch = { value: -90 };

      try {
        // First frame: entityA is the only visible caster.
        ShadowMap._previousAnchorNum = -1;
        ShadowMap.selectLocalLights(new Vector(0, 0, 0));
        assert.equal(ShadowMap._shadowFocusPoint[0], 100);

        // Second frame: entityB appears and is now nearest, but only
        // marginally (90 vs 100, within the hysteresis margin) — the focus
        // point should not jump to it.
        registry.CL = { state: { clientEntities: { getVisibleEntities: () => [entityA, entityB] } } };
        eventBus.publish('registry.frozen');
        ShadowMap.selectLocalLights(new Vector(0, 0, 0));
        assert.equal(ShadowMap._shadowFocusPoint[0], 100, 'focus point should stay on the previous anchor');
      } finally {
        registry.CL = previousCL;
        registry.SV = previousSV;
        eventBus.publish('registry.frozen');
      }
    } finally {
      ShadowMap.lightEntities = previousEntities;
      ShadowMap.localLightCount = previousCount;
      ShadowMap._previousAnchorNum = previousAnchorNum;
      ShadowMap.sunYaw = previousYaw;
      ShadowMap.sunPitch = previousPitch;
      ShadowMap.minElevation = previousMinElevation;
    }
  });

  void test('switches anchor when a new candidate is meaningfully closer', () => {
    const previousCount = ShadowMap.localLightCount;
    const previousAnchorNum = ShadowMap._previousAnchorNum;
    const previousEntities = ShadowMap.lightEntities;
    const previousYaw = ShadowMap.sunYaw;
    const previousPitch = ShadowMap.sunPitch;
    const previousMinElevation = ShadowMap.minElevation;

    try {
      ShadowMap.lightEntities = [];
      const entityA = createCasterEntity(1, new Vector(100, 0, 0));

      const previousCL = registry.CL;
      const previousSV = registry.SV;
      registry.CL = { state: { clientEntities: { getVisibleEntities: () => [entityA] } } };
      registry.SV = { collision: { traceStaticWorldLine: () => ({ fraction: 1.0, allsolid: false, startsolid: false }) } };
      eventBus.publish('registry.frozen');
      ShadowMap.minElevation = { value: 20 };
      ShadowMap.sunYaw = { value: 0 };
      ShadowMap.sunPitch = { value: -90 };

      try {
        ShadowMap._previousAnchorNum = -1;
        ShadowMap.selectLocalLights(new Vector(0, 0, 0));
        assert.equal(ShadowMap._shadowFocusPoint[0], 100);

        const entityC = createCasterEntity(3, new Vector(10, 0, 0)); // much closer
        registry.CL = { state: { clientEntities: { getVisibleEntities: () => [entityA, entityC] } } };
        eventBus.publish('registry.frozen');

        ShadowMap.selectLocalLights(new Vector(0, 0, 0));
        assert.equal(ShadowMap._shadowFocusPoint[0], 10, 'focus point should follow the clearly closer caster');
      } finally {
        registry.CL = previousCL;
        registry.SV = previousSV;
        eventBus.publish('registry.frozen');
      }
    } finally {
      ShadowMap.lightEntities = previousEntities;
      ShadowMap.localLightCount = previousCount;
      ShadowMap._previousAnchorNum = previousAnchorNum;
      ShadowMap.sunYaw = previousYaw;
      ShadowMap.sunPitch = previousPitch;
      ShadowMap.minElevation = previousMinElevation;
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
