import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { content } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
import type { BrushModel, Node } from '../../source/engine/common/model/BSP.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Fog from '../../source/engine/client/renderer/scene/Fog.ts';
import { patchMembers } from '../support/clientState.ts';
import { assertNear } from '../support/assertions.ts';

/** What a console variable does for the fog code: it keeps the last value that was set. */
interface FakeCvar {
  value: number | string;
  readonly set: (value: number | string) => void;
}

/**
 * Creates a console variable stand-in.
 * @param initial The value it starts with.
 * @returns The stand-in.
 */
function createCvar(initial: number | string): FakeCvar {
  const cvar: FakeCvar = {
    value: initial,
    set(value) {
      cvar.value = value;
    },
  };

  return cvar;
}

/**
 * Builds a leaf with only what the underwater tint selection looks at.
 * @param contents The leaf contents, a liquid for an underwater camera.
 * @param chainTexture Index of the texture of the first turbulent chain, `null` for none in view.
 * @returns The leaf.
 */
function createLeaf(contents: content, chainTexture: number | null): Node {
  return {
    contents,
    turbulentChains: chainTexture === null ? [] : [{ texture: chainTexture }],
  } as unknown as Node;
}

/**
 * Builds a map with only what the fog code reads.
 * @param members Worldspawn keys, textures with fog tints and liquid anchors.
 * @returns The map.
 */
function createWorld(members: {
  readonly worldspawnInfo?: Record<string, string>;
  readonly textures?: Array<{ fogTint: [number, number, number] | null }>;
  readonly liquidFogAnchors?: Array<{ center: Vector; fogTint: [number, number, number] }>;
}): BrushModel {
  return {
    worldspawnInfo: members.worldspawnInfo ?? {},
    textures: members.textures ?? [],
    liquidFogAnchors: members.liquidFogAnchors ?? [],
  } as unknown as BrushModel;
}

void describe('Fog', () => {
  let restores: Array<() => void> = [];
  const fogMode = createCvar(0);
  const fogDensity = createCvar(0);
  const fogColor = createCvar('');
  const underwaterDensity = createCvar(0.01);

  beforeEach(() => {
    fogMode.value = 0;
    fogDensity.value = 0;
    fogColor.value = '';
    underwaterDensity.value = 0.01;

    restores = [
      patchMembers(rendererCvars, {
        fog_mode: fogMode as unknown as Cvar,
        fog_density: fogDensity as unknown as Cvar,
        fog_color: fogColor as unknown as Cvar,
        underwater_fog_density: underwaterDensity as unknown as Cvar,
      }),
    ];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }
  });

  void describe('NewMap', () => {
    void test('turns the global fog off for a map without a fog key', () => {
      fogMode.value = 1;
      restores.push(patchMembers(clientRuntimeState, { worldmodel: createWorld({}) }));

      Fog.NewMap();

      assert.equal(fogMode.value, -1);
    });

    void test('turns exponential fog on from the density and the 0-1 color of the fog key', () => {
      restores.push(patchMembers(clientRuntimeState, {
        worldmodel: createWorld({ worldspawnInfo: { fog: '0.5 1 0.5 0' } }),
      }));

      Fog.NewMap();

      // the key's first number is the density of Quake's own fog, scaled to the shader's by the Ironwail
      // factor sqrt(log2(e)) * 0.85 / 64
      const densityScale = 1.20112241 * 0.85 / 64.0;

      assert.equal(fogMode.value, 1);
      assertNear(fogDensity.value as number, 0.5 / densityScale, 1e-9);
      assert.equal(fogColor.value, '255 127.5 0');
    });
  });

  void describe('SelectUnderwaterTint', () => {
    const vieworg = new Vector(0, 0, 0);

    void test('uses the fog tint of the first liquid surface in view', () => {
      const world = createWorld({
        textures: [{ fogTint: [0.9, 0.1, 0.2] }],
        liquidFogAnchors: [{ center: new Vector(1, 0, 0), fogTint: [0.3, 0.3, 0.3] }],
      });

      Fog.SelectUnderwaterTint(world, createLeaf(content.CONTENT_WATER, 0), vieworg);

      assert.deepEqual(Fog.underwaterFogColor, [0.9, 0.1, 0.2]);
    });

    void test('falls back to the nearest liquid anchor when no surface is in view', () => {
      const world = createWorld({
        liquidFogAnchors: [
          { center: new Vector(500, 0, 0), fogTint: [0.1, 0.1, 0.1] },
          { center: new Vector(40, 0, 0), fogTint: [0.4, 0.5, 0.6] },
          { center: new Vector(-200, 0, 0), fogTint: [0.7, 0.7, 0.7] },
        ],
      });

      Fog.SelectUnderwaterTint(world, createLeaf(content.CONTENT_WATER, null), vieworg);

      assert.deepEqual(Fog.underwaterFogColor, [0.4, 0.5, 0.6]);
    });

    void test('asks the anchors when the surface in view has a material without a tint', () => {
      const world = createWorld({
        textures: [{ fogTint: null }],
        liquidFogAnchors: [{ center: new Vector(10, 0, 0), fogTint: [0.2, 0.4, 0.8] }],
      });

      Fog.SelectUnderwaterTint(world, createLeaf(content.CONTENT_WATER, 0), vieworg);

      assert.deepEqual(Fog.underwaterFogColor, [0.2, 0.4, 0.8]);
    });

    void test('defaults to a color per liquid when the map has no tint at all', () => {
      const world = createWorld({});

      Fog.SelectUnderwaterTint(world, createLeaf(content.CONTENT_LAVA, null), vieworg);
      assert.deepEqual(Fog.underwaterFogColor, [0.25, 0.05, 0.0]);

      Fog.SelectUnderwaterTint(world, createLeaf(content.CONTENT_SLIME, null), vieworg);
      assert.deepEqual(Fog.underwaterFogColor, [0.02, 0.12, 0.0]);

      Fog.SelectUnderwaterTint(world, createLeaf(content.CONTENT_WATER, null), vieworg);
      assert.deepEqual(Fog.underwaterFogColor, [0.05, 0.15, 0.2]);
    });

    void test('takes the density from r_underwater_fog_density', () => {
      underwaterDensity.value = 0.037;

      Fog.SelectUnderwaterTint(createWorld({}), createLeaf(content.CONTENT_WATER, null), vieworg);

      assert.equal(Fog.underwaterFogDensity, 0.037);
    });
  });
});
