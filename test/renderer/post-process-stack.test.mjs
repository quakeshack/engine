import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import PostProcess from '../../source/engine/client/renderer/PostProcess.ts';
import PostProcessEffect from '../../source/engine/client/renderer/PostProcessEffect.ts';
import ColorGradeEffect from '../../source/engine/client/renderer/ColorGradeEffect.ts';
import BlurEffect from '../../source/engine/client/renderer/BlurEffect.ts';

class MockEffect extends PostProcessEffect {
  constructor(name, calls) {
    super(name);
    this.calls = calls;
    this.stackable = true;
  }

  apply(inputTexture) {
    this.calls.push([this.name, inputTexture]);
  }
}

describe('PostProcess gameplay stack', () => {
  test('keeps the stack entries in explicit game order', () => {
    const originalEffects = PostProcess.effects;
    const originalStack = PostProcess.stack;

    PostProcess.effects = [new MockEffect('color-grade', []), new MockEffect('blur', [])];
    PostProcess.setStack([
      { id: 'blur', settings: { radius: 4 } },
      { id: 'color-grade', settings: { saturation: 1.25 } },
    ]);

    try {
      assert.equal(PostProcess.hasGameplayStack(), true);
      assert.equal(PostProcess.stack[0].id, 'blur');
      assert.equal(PostProcess.stack[1].id, 'color-grade');
    } finally {
      PostProcess.effects = originalEffects;
      PostProcess.stack = originalStack;
    }
  });

  test('clears the gameplay stack on request', () => {
    const originalStack = PostProcess.stack;

    PostProcess.setStack([{ id: 'color-grade', settings: { saturation: 0.5 } }]);
    PostProcess.clearStack();

    try {
      assert.equal(PostProcess.hasGameplayStack(), false);
      assert.deepEqual(PostProcess.stack, []);
    } finally {
      PostProcess.stack = originalStack;
    }
  });

  test('ignores unknown effect ids when resolving the gameplay stack', () => {
    const originalEffects = PostProcess.effects;
    const originalStack = PostProcess.stack;

    PostProcess.effects = [new MockEffect('color-grade', [])];
    PostProcess.setStack([
      { id: 'color-grade', settings: { saturation: 1.1 } },
      { id: 'blur', settings: { radius: 4 } },
    ]);

    try {
      assert.equal(PostProcess.hasGameplayStack(), true);
      assert.equal(PostProcess.stack.length, 2);
    } finally {
      PostProcess.effects = originalEffects;
      PostProcess.stack = originalStack;
    }
  });

  test('exposes the public stack query helpers', () => {
    PostProcess.clearStack();

    assert.equal(PostProcess.hasGameplayStack(), false);
    PostProcess.setStack([{ id: 'color-grade', settings: { saturation: 0.8 } }]);
    assert.equal(PostProcess.hasGameplayStack(), true);
    assert.ok(PostProcess.getStackEntry('color-grade'));
    assert.equal(PostProcess.getStackEntry('blur'), undefined);
    PostProcess.clearStack();
  });

  test('normalizes color-grade and blur settings to safe defaults', () => {
    assert.deepEqual(ColorGradeEffect.resolveSettings({ saturation: Number.NaN, tintStrength: Number.NaN }), {
      saturation: 1.0,
      contrast: 1.0,
      exposure: 0.0,
      tintColor: undefined,
      tintStrength: 0.0,
      pulseStrength: 0.0,
      pulsePeriod: 0.0,
    });

    assert.deepEqual(BlurEffect.resolveSettings({ radius: Number.NaN }), {
      radius: 4.0,
    });
  });
});
