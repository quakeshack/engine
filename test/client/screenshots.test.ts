import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import GL from '../../source/engine/client/GL.ts';
import VID from '../../source/engine/client/VID.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Screenshots from '../../source/engine/client/screen/Screenshots.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('Screenshots', () => {
  const previousContext = GL.gl;
  let restores: Array<() => void> = [];
  let downloads: string[] = [];
  let finished = 0;

  beforeEach(() => {
    downloads = [];
    finished = 0;
    Screenshots.requested = false;
    Screenshots.cleanRequested = false;

    GL.gl = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'finish') {
          return () => { finished++; };
        }

        return typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({});
      },
    }) as unknown as WebGL2RenderingContext;
    publishGlReady();

    restores = [
      patchMembers(rendererCvars, {
        drawviewmodel: {
          value: 1,
          set(this: { value: number }, value: number) {
            this.value = value;
          },
        } as unknown as Cvar,
      }),
    ];
    mock.method(VID, 'DownloadScreenshot', (filename?: string) => { downloads.push(filename ?? 'screenshot.jpg'); });
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void test('arms a regular capture for the next frame', () => {
    Screenshots.Screenshot_f();

    assert.equal(Screenshots.requested, true);
  });

  void test('arms a clean (view model/UI suppressed) capture for the next frame', () => {
    Screenshots.ScreenshotClean_f();

    assert.equal(Screenshots.cleanRequested, true);
  });

  void describe('TakeRequested', () => {
    void test('downloads the screen once, after the GPU has finished', () => {
      Screenshots.requested = true;

      Screenshots.TakeRequested();
      Screenshots.TakeRequested();

      assert.deepEqual(downloads, ['screenshot.jpg']);
      assert.equal(finished, 1);
      assert.equal(Screenshots.requested, false);
    });
  });

  void describe('BeginClean and EndClean', () => {
    void test('leave a frame alone that is not a clean capture', () => {
      assert.equal(Screenshots.BeginClean(), false);
      assert.equal(rendererCvars.drawviewmodel.value, 1);
    });

    void test('switch the weapon off for the frame, then put it back, save the picture and disarm', () => {
      Screenshots.cleanRequested = true;

      assert.equal(Screenshots.BeginClean(), true);
      assert.equal(rendererCvars.drawviewmodel.value, 0);

      Screenshots.EndClean();

      assert.equal(rendererCvars.drawviewmodel.value, 1);
      assert.deepEqual(downloads, ['screenshot-clean.jpg']);
      assert.equal(Screenshots.cleanRequested, false);
    });

    void test('put back a weapon that was off to begin with as it was', () => {
      rendererCvars.drawviewmodel.set(0);
      Screenshots.cleanRequested = true;

      Screenshots.BeginClean();
      Screenshots.EndClean();

      assert.equal(rendererCvars.drawviewmodel.value, 0);
    });
  });
});
