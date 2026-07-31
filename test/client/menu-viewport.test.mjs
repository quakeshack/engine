import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MenuViewport } from '../../source/engine/client/menu/MenuViewport.ts';

void describe('MenuViewport.classic.resolve', () => {
  void test('matches the historical hardcoded "cx * 2 + Math.floor(VID.width / 2) - 320" formula', () => {
    // Regression test protecting id1's pixel-perfectness through the MenuViewport refactor --
    // M's drawing primitives used to inline this formula directly; MenuViewport.classic must
    // reproduce it exactly for every page that doesn't opt into its own viewport.
    for (const [vidWidth, vidHeight] of [[0, 0], [640, 480], [1920, 1080], [1281, 721]]) {
      const resolved = MenuViewport.classic.resolve(vidWidth, vidHeight);

      assert.equal(resolved.scale, 2);
      assert.equal(resolved.originX, Math.floor(vidWidth / 2) - 320);
      assert.equal(resolved.originY, Math.floor(vidHeight / 2) - 200);
    }
  });
});

void describe('MenuViewport.resolve', () => {
  void test('fit "fixed" always uses the configured scale, regardless of canvas size', () => {
    const viewport = new MenuViewport({ width: 320, height: 200, fit: 'fixed', scale: 3 });

    assert.equal(viewport.resolve(100, 100).scale, 3);
    assert.equal(viewport.resolve(5000, 5000).scale, 3);
  });

  void test('fit "contain" scales to fill the canvas while preserving aspect ratio', () => {
    const viewport = new MenuViewport({ width: 1280, height: 720, fit: 'contain' });

    // Real canvas is exactly 16:9, same as the viewport -- fills it exactly, no letterboxing.
    const exact = viewport.resolve(1920, 1080);
    assert.equal(exact.scale, 1.5);
    assert.equal(exact.originX, 0);
    assert.equal(exact.originY, 0);

    // A narrower-than-16:9 canvas is width-bound -- letterboxed top/bottom.
    const letterboxed = viewport.resolve(1000, 1000);
    assert.equal(letterboxed.scale, 1000 / 1280);
    assert.equal(letterboxed.originX, 0);
    assert.equal(letterboxed.originY, 500 - (720 * (1000 / 1280)) / 2);
  });

  void test('fit "contain" with integerScale floors to whole pixels and never drops below 1', () => {
    const viewport = new MenuViewport({ width: 320, height: 200, fit: 'contain', integerScale: true });

    assert.equal(viewport.resolve(1000, 700).scale, 3); // raw min(3.125, 3.5) -> floor 3
    assert.equal(viewport.resolve(100, 50).scale, 1); // raw 0.25 -> floored to 0, clamped to 1
  });
});

void describe('MenuViewport.toScreen / fromScreen', () => {
  void test('fromScreen inverts toScreen for an arbitrary viewport and canvas size', () => {
    const viewport = new MenuViewport({ width: 1280, height: 720, fit: 'contain' });
    const resolved = viewport.resolve(1366, 768);

    const virtualPoint = { x: 42, y: 613 };
    const screenPoint = viewport.toScreen(resolved, virtualPoint.x, virtualPoint.y);
    const roundTripped = viewport.fromScreen(resolved, screenPoint.x, screenPoint.y);

    assert.equal(roundTripped.x, virtualPoint.x);
    assert.equal(roundTripped.y, virtualPoint.y);
  });

  void test('toScreen matches the classic formula at a known point', () => {
    const resolved = MenuViewport.classic.resolve(640, 480);

    assert.deepEqual(MenuViewport.classic.toScreen(resolved, 160, 100), {
      x: 160 * 2 + Math.floor(640 / 2) - 320,
      y: 100 * 2 + Math.floor(480 / 2) - 200,
    });
  });
});

void describe('MenuViewport.anchor', () => {
  void test('places content flush against each corner, inset by the margin', () => {
    const viewport = new MenuViewport({ width: 1280, height: 720, fit: 'contain' });

    assert.deepEqual(viewport.anchor('top-left', 100, 20), { x: 16, y: 16 });
    assert.deepEqual(viewport.anchor('top-right', 100, 20), { x: 1280 - 16 - 100, y: 16 });
    assert.deepEqual(viewport.anchor('bottom-left', 100, 20), { x: 16, y: 720 - 16 - 20 });
    assert.deepEqual(viewport.anchor('bottom-right', 100, 20), { x: 1280 - 16 - 100, y: 720 - 16 - 20 });
  });

  void test('accepts a custom margin', () => {
    const viewport = new MenuViewport({ width: 1280, height: 720, fit: 'contain' });

    assert.deepEqual(viewport.anchor('bottom-right', 50, 10, 24, 8), { x: 1280 - 24 - 50, y: 720 - 8 - 10 });
  });
});
