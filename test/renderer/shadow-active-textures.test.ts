import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import ShadowMap from '../../source/engine/client/renderer/lighting/ShadowMap.ts';
import type { GLCubeTexture, GLRenderTexture } from '../../source/engine/client/GL.ts';
import { createCvarStub } from '../support/cvarStub.ts';

const depth = { name: 'depth' } as unknown as GLRenderTexture;
const blockers = { name: 'blockers' } as unknown as GLRenderTexture;
const dummy = { name: 'dummy' } as unknown as GLRenderTexture;
const cubes = [{ name: 'cube0' }, { name: 'cube1' }, { name: 'cube2' }] as unknown as GLCubeTexture[];
const dummyCube = { name: 'dummy cube' } as unknown as GLCubeTexture;

void describe('ShadowMap active textures', () => {
  const previous = {
    enabled: ShadowMap.enabled,
    depth: ShadowMap.topdownDepthTexture,
    blockers: ShadowMap.topdownBlockerTexture,
    dummy: ShadowMap.topdownDummyTexture,
    cubes: ShadowMap.pointDepthCubes,
    dummyCube: ShadowMap.pointDummyCube,
    count: ShadowMap.pointLightActiveCount,
  };

  beforeEach(() => {
    ShadowMap.enabled = createCvarStub(1);
    ShadowMap.topdownDepthTexture = depth;
    ShadowMap.topdownBlockerTexture = blockers;
    ShadowMap.topdownDummyTexture = dummy;
    ShadowMap.pointDepthCubes = cubes;
    ShadowMap.pointDummyCube = dummyCube;
    ShadowMap.pointLightActiveCount = 0;
  });

  afterEach(() => {
    ShadowMap.enabled = previous.enabled;
    ShadowMap.topdownDepthTexture = previous.depth;
    ShadowMap.topdownBlockerTexture = previous.blockers;
    ShadowMap.topdownDummyTexture = previous.dummy;
    ShadowMap.pointDepthCubes = previous.cubes;
    ShadowMap.pointDummyCube = previous.dummyCube;
    ShadowMap.pointLightActiveCount = previous.count;
  });

  void describe('getActiveTopDownTexture', () => {
    void test('is the depth texture while shadows are on', () => {
      assert.equal(ShadowMap.getActiveTopDownTexture(), depth);
    });

    void test('is the dummy while shadows are off', () => {
      ShadowMap.enabled = createCvarStub(0);

      assert.equal(ShadowMap.getActiveTopDownTexture(), dummy);
    });

    void test('is the dummy, or nothing, before the shadow map is initialized', () => {
      ShadowMap.enabled = null;
      ShadowMap.topdownDummyTexture = null;

      assert.equal(ShadowMap.getActiveTopDownTexture(), null);
    });
  });

  void describe('getActiveTopDownBlockerTexture', () => {
    void test('is the blocker map while shadows are on', () => {
      assert.equal(ShadowMap.getActiveTopDownBlockerTexture(), blockers);
    });

    // the blocker map is not drawn while shadows are off, so it would end the shadow at stale surfaces
    void test('is the dummy, which blocks nothing, while shadows are off', () => {
      ShadowMap.enabled = createCvarStub(0);

      assert.equal(ShadowMap.getActiveTopDownBlockerTexture(), dummy);
    });
  });

  void describe('getActivePointTextures', () => {
    void test('uses the dummy cube for every slot while no light casts a shadow', () => {
      assert.deepEqual([...ShadowMap.getActivePointTextures()], [dummyCube, dummyCube, dummyCube]);
    });

    void test('uses the depth cube for the slots that have a light, the dummy for the rest', () => {
      ShadowMap.pointLightActiveCount = 2;

      assert.deepEqual([...ShadowMap.getActivePointTextures()], [cubes[0], cubes[1], dummyCube]);
    });

    void test('follows the active count without a new array per call', () => {
      const first = ShadowMap.getActivePointTextures();

      ShadowMap.pointLightActiveCount = 3;

      const second = ShadowMap.getActivePointTextures();

      assert.equal(first, second);
      assert.deepEqual([...second], cubes);
    });
  });
});
