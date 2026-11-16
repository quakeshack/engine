import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Draw from '../../source/engine/client/Draw.ts';
import FrameProfiler from '../../source/engine/client/FrameProfiler.ts';
import RenderStats from '../../source/engine/client/renderer/scene/RenderStats.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { createMutableCvarStub } from '../support/cvarStub.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('RenderStats.Print', () => {
  let restoreCvars: () => void;
  let drawn: string[];

  beforeEach(() => {
    drawn = [];
    restoreCvars = patchMembers(rendererCvars, { speeds: createMutableCvarStub(0) });
    mock.method(Draw, 'String', (_x: number, _y: number, text: string) => {
      drawn.push(text);
      return 0;
    });
    RenderStats.lines.length = 0;
    RenderStats.lines.push('counter line');
    FrameProfiler.lines.length = 0;
    FrameProfiler.lines.push('section line');
  });

  afterEach(() => {
    mock.restoreAll();
    restoreCvars();
    RenderStats.lines.length = 0;
    FrameProfiler.lines.length = 0;
  });

  void test('draws nothing while r_speeds is 0', () => {
    RenderStats.Print(60);

    assert.deepEqual(drawn, []);
  });

  void test('draws only the frame rate for r_speeds 1', () => {
    rendererCvars.speeds.set(1);

    RenderStats.Print(60);

    assert.deepEqual(drawn, ['60.0 FPS']);
  });

  void test('draws the counters and the sections as well for r_speeds 2', () => {
    rendererCvars.speeds.set(2);

    RenderStats.Print(60);

    assert.deepEqual(drawn, ['60.0 FPS', 'counter line', 'section line']);
  });

  void test('keeps drawing the details for r_speeds 3', () => {
    rendererCvars.speeds.set(3);

    RenderStats.Print(60);

    assert.deepEqual(drawn, ['60.0 FPS', 'counter line', 'section line']);
  });
});
