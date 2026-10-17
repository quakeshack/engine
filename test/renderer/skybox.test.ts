import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { createCvarStub } from '../support/cvarStub.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import SkyBox from '../../source/engine/client/renderer/scene/SkyBox.ts';
import type { SkyDrawContext, SkyRenderer } from '../../source/engine/client/renderer/scene/Sky.ts';
import Visibility from '../../source/engine/client/renderer/scene/Visibility.ts';
import { patchMembers } from '../support/clientState.ts';

/** A sky renderer that records what the box did with it. */
class RecordingSkyRenderer {
  readonly calls: string[] = [];
  readonly contexts: SkyDrawContext[] = [];

  init(): void {
    this.calls.push('init');
  }

  shutdown(): void {
    this.calls.push('shutdown');
  }

  render(context: SkyDrawContext): void {
    this.calls.push('render');
    this.contexts.push(context);
  }
}

/**
 * Builds a map that asks for the given sky renderer, one per map load.
 * @param renderers The renderers it hands out, in order.
 * @returns The map.
 */
function createWorld(...renderers: Array<RecordingSkyRenderer | null>): BrushModel {
  let next = 0;

  return {
    newSkyRenderer: () => (renderers[next++] ?? null) as unknown as SkyRenderer | null,
  } as unknown as BrushModel;
}

void describe('SkyBox', () => {
  let restores: Array<() => void> = [];

  beforeEach(() => {
    restores = [
      patchMembers(rendererCvars, { bloomSkyStrength: createCvarStub(0.33) }),
    ];
  });

  afterEach(() => {
    SkyBox.Clear();

    for (const restore of restores.reverse()) {
      restore();
    }
  });

  void describe('Make and Clear', () => {
    void test('initializes the renderer the map asks for', () => {
      const renderer = new RecordingSkyRenderer();
      restores.push(patchMembers(clientRuntimeState, { worldmodel: createWorld(renderer) }));

      SkyBox.Make();

      assert.deepEqual(renderer.calls, ['init']);
    });

    void test('shuts the previous renderer down when the next map is made', () => {
      const first = new RecordingSkyRenderer();
      const second = new RecordingSkyRenderer();
      restores.push(patchMembers(clientRuntimeState, { worldmodel: createWorld(first, second) }));

      SkyBox.Make();
      SkyBox.Make();

      assert.deepEqual(first.calls, ['init', 'shutdown']);
      assert.deepEqual(second.calls, ['init']);
    });

    void test('lets a map without a sky renderer leave the box empty', () => {
      const first = new RecordingSkyRenderer();
      restores.push(patchMembers(clientRuntimeState, { worldmodel: createWorld(first, null) }));

      SkyBox.Make();
      SkyBox.Make();

      assert.deepEqual(first.calls, ['init', 'shutdown']);
      assert.doesNotThrow(() => { SkyBox.Draw(); });
    });

    void test('shuts the renderer down once on Clear', () => {
      const renderer = new RecordingSkyRenderer();
      restores.push(patchMembers(clientRuntimeState, { worldmodel: createWorld(renderer) }));

      SkyBox.Make();
      SkyBox.Clear();
      SkyBox.Clear();

      assert.deepEqual(renderer.calls, ['init', 'shutdown']);
    });
  });

  void describe('Draw', () => {
    void test('draws nothing while no revealed leaf has sky', () => {
      const renderer = new RecordingSkyRenderer();
      restores.push(
        patchMembers(clientRuntimeState, { worldmodel: createWorld(renderer) }),
        patchMembers(Visibility, { skyVisible: false }),
      );

      SkyBox.Make();
      SkyBox.Draw();

      assert.deepEqual(renderer.calls, ['init']);
    });

    void test('hands the renderer the frame state it draws with', () => {
      const renderer = new RecordingSkyRenderer();
      const vieworg = new Vector(10, 20, 30);
      restores.push(
        patchMembers(clientRuntimeState, { worldmodel: createWorld(renderer) }),
        patchMembers(Visibility, { skyVisible: true, visframecount: 42 }),
        patchMembers(Camera.refdef, { vieworg }),
      );

      SkyBox.Make();
      SkyBox.Draw();

      assert.deepEqual(renderer.calls, ['init', 'render']);

      const context = renderer.contexts[0];
      assert.equal(context.visframecount, 42);
      assert.equal(context.vieworg, vieworg);
      assert.equal(context.bloomSkyStrength, 0.33);
    });

    void test('lets the renderer cull against the camera frustum', () => {
      const renderer = new RecordingSkyRenderer();
      const seen: Array<[Vector, Vector]> = [];
      restores.push(
        patchMembers(clientRuntimeState, { worldmodel: createWorld(renderer) }),
        patchMembers(Visibility, { skyVisible: true }),
        patchMembers(Camera, {
          CullBox(mins: Vector, maxs: Vector) {
            seen.push([mins, maxs]);

            return true;
          },
        }),
      );

      SkyBox.Make();
      SkyBox.Draw();

      const mins = new Vector(-1, -1, -1);
      const maxs = new Vector(1, 1, 1);

      assert.equal(renderer.contexts[0].cullBox(mins, maxs), true);
      assert.deepEqual(seen, [[mins, maxs]]);
    });
  });
});
