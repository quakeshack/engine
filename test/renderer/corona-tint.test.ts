import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import * as Def from '../../source/engine/common/Def.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import GL from '../../source/engine/client/GL.ts';
import DynamicLights from '../../source/engine/client/renderer/lighting/DynamicLights.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

/** What the coronas ask of a light. */
interface Light {
  radius: number;
  die: number;
  origin: Vector;
}

/**
 * A stand-in for a WebGL context that creates objects for anything asked of it.
 * @returns The stand-in.
 */
function createFakeContext(): WebGL2RenderingContext {
  return new Proxy({}, {
    get: (_target, property) => (typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

void describe('DynamicLights.RenderCoronas', () => {
  const previousContext = GL.gl;
  let restores: Array<() => void> = [];
  let tints: number[] = [];
  let drawn = 0;
  let lights: Light[] = [];

  beforeEach(() => {
    tints = [];
    drawn = 0;
    lights = Array.from({ length: Def.limits.dlights }, () => ({ radius: 0, die: 0, origin: new Vector() }));

    GL.gl = createFakeContext();
    publishGlReady();

    restores = [
      patchMembers(rendererCvars, { flashblend: { value: 1 } as unknown as Cvar }),
      patchMembers(clientRuntimeState, {
        time: 10,
        clientEntities: { dlights: lights },
      }),
      patchMembers(PostProcess, { active: true }),
    ];
    Camera.refdef.vieworg.setTo(0, 0, 0);

    mock.method(GL, 'UseProgram', () => ({ uOrigin: 1, uRadius: 2 }) as never);
    mock.method(GL, 'BindVAO', () => {});
    mock.method(GL, 'UnbindVAO', () => {});
    mock.method(PostProcess, 'pulse', (descriptor: { settings: { alpha: number; color: number[] } }, options: { channel: string }) => {
      assert.equal(options.channel, 'engine.corona');
      assert.deepEqual(descriptor.settings.color, [1, 0.5, 0]);
      tints.push(descriptor.settings.alpha);
    });
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  /**
   * Counts the corona draws through a context that records `drawArrays`.
   */
  function countDraws(): void {
    GL.gl = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'drawArrays') {
          return () => { drawn++; };
        }

        return typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({});
      },
    }) as unknown as WebGL2RenderingContext;
    publishGlReady();
  }

  void test('tints the view when the eye is inside the glare of a light, by the radius of the light', () => {
    lights[0] = { radius: 200, die: 100, origin: new Vector(10, 0, 0) };

    DynamicLights.RenderCoronas();

    // 10 units away is inside 0.35 * 200 = 70
    assert.equal(tints.length, 1);
    assertNear(tints[0], 200 * 0.0003, 1e-12);
  });

  void test('draws the corona of a light the eye is outside of, and does not tint', () => {
    countDraws();
    lights[0] = { radius: 200, die: 100, origin: new Vector(150, 0, 0) };

    DynamicLights.RenderCoronas();

    assert.deepEqual(tints, []);
    assert.equal(drawn, 1);
  });

  void test('does not tint while the frame is not captured, there is no scene to put it over', () => {
    PostProcess.active = false;
    lights[0] = { radius: 200, die: 100, origin: new Vector(10, 0, 0) };

    DynamicLights.RenderCoronas();

    assert.deepEqual(tints, []);
  });

  void test('skips lights that are gone or have no radius', () => {
    lights[0] = { radius: 200, die: 5, origin: new Vector(10, 0, 0) };
    lights[1] = { radius: 0, die: 100, origin: new Vector(10, 0, 0) };

    DynamicLights.RenderCoronas();

    assert.deepEqual(tints, []);
  });

  void test('draws and tints nothing with flashblend off', () => {
    rendererCvars.flashblend = { value: 0 } as unknown as Cvar;
    lights[0] = { radius: 200, die: 100, origin: new Vector(10, 0, 0) };

    DynamicLights.RenderCoronas();

    assert.deepEqual(tints, []);
  });
});
