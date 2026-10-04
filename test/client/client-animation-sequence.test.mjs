import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { ClientAnimationSequence } from '../../source/shared/ClientAnimationSequence.ts';
import { assertNear } from '../physics/fixtures.mjs';

void describe('ClientAnimationSequence', () => {
  void describe('tick', () => {
    void test('enters the initial state on the first tick, firing onEnter and assigning its keyframe', () => {
      const clientEdict = new ClientEdict(-1);
      let onEnterCalls = 0;
      const sequence = new ClientAnimationSequence(clientEdict, {
        flash: { keyframe: 1, duration: 0.1, next: 'smoke', onEnter: () => { onEnterCalls++; } },
        smoke: { keyframe: 2, duration: 0.4, next: null },
      }, 'flash');

      sequence.tick(10.0);

      assert.equal(sequence.current, 'flash');
      assert.equal(clientEdict.frame, 1);
      assert.equal(onEnterCalls, 1);
    });

    void test('does not advance before duration has elapsed', () => {
      const clientEdict = new ClientEdict(-1);
      const sequence = new ClientAnimationSequence(clientEdict, {
        flash: { keyframe: 1, duration: 0.1, next: 'smoke' },
        smoke: { keyframe: 2, duration: 0.4, next: null },
      }, 'flash');

      sequence.tick(10.0);
      sequence.tick(10.05);

      assert.equal(sequence.current, 'flash');
      assert.equal(clientEdict.frame, 1);
    });

    void test('advances to next once duration has elapsed since entering the current state', () => {
      const clientEdict = new ClientEdict(-1);
      let smokeEntered = false;
      const sequence = new ClientAnimationSequence(clientEdict, {
        flash: { keyframe: 1, duration: 0.1, next: 'smoke' },
        smoke: { keyframe: 2, duration: 0.4, next: null, onEnter: () => { smokeEntered = true; } },
      }, 'flash');

      sequence.tick(10.0);
      sequence.tick(10.15); // comfortably past the 0.1s duration, clear of float boundary noise

      assert.equal(sequence.current, 'smoke');
      assert.equal(clientEdict.frame, 2);
      assert.equal(smokeEntered, true);
    });

    void test('a terminal state (next: null) never advances on its own', () => {
      const clientEdict = new ClientEdict(-1);
      const sequence = new ClientAnimationSequence(clientEdict, {
        fade: { keyframe: 3, duration: 0.3, next: null },
      }, 'fade');

      sequence.tick(0.0);
      sequence.tick(100.0);
      sequence.tick(1000.0);

      assert.equal(sequence.current, 'fade');
      assert.equal(clientEdict.frame, 3);
    });
  });

  void describe('setState', () => {
    void test('resumes at an arbitrary point without re-firing onEnter', () => {
      const clientEdict = new ClientEdict(-1);
      let onEnterCalls = 0;
      const sequence = new ClientAnimationSequence(clientEdict, {
        flash: { keyframe: 1, duration: 0.1, next: 'smoke' },
        smoke: { keyframe: 2, duration: 0.4, next: 'fade', onEnter: () => { onEnterCalls++; } },
        fade: { keyframe: 3, duration: 0.3, next: null },
      }, 'flash');

      sequence.setState('smoke', 5.0);

      assert.equal(sequence.current, 'smoke');
      assert.equal(clientEdict.frame, 2);
      assert.equal(onEnterCalls, 0, 'onEnter must not replay a one-shot side effect on resume');
    });

    void test('resumed sequence still advances normally on subsequent ticks', () => {
      const clientEdict = new ClientEdict(-1);
      const sequence = new ClientAnimationSequence(clientEdict, {
        flash: { keyframe: 1, duration: 0.1, next: 'smoke' },
        smoke: { keyframe: 2, duration: 0.4, next: 'fade' },
        fade: { keyframe: 3, duration: 0.3, next: null },
      }, 'flash');

      sequence.setState('smoke', 5.0);
      sequence.tick(5.4);

      assert.equal(sequence.current, 'fade');
      assert.equal(clientEdict.frame, 3);
    });
  });

  void describe('serialize', () => {
    void test('returns enteredAt relative to currentTime', () => {
      const clientEdict = new ClientEdict(-1);
      const sequence = new ClientAnimationSequence(clientEdict, {
        smoke: { keyframe: 2, duration: 0.4, next: null },
      }, 'smoke');

      sequence.setState('smoke', 5.0);

      const saved = sequence.serialize(5.3);
      assert.equal(saved.state, 'smoke');
      assertNear(saved.enteredAt, -0.3, 1e-9);
    });

    void test('round-trips through setState() re-anchored to a new currentTime', () => {
      const clientEdict = new ClientEdict(-1);
      const original = new ClientAnimationSequence(clientEdict, {
        flash: { keyframe: 1, duration: 0.1, next: 'smoke' },
        smoke: { keyframe: 2, duration: 0.4, next: 'fade' },
        fade: { keyframe: 3, duration: 0.3, next: null },
      }, 'flash');
      original.setState('smoke', 5.0);

      const saved = original.serialize(5.3); // { state: 'smoke', enteredAt: -0.3 }

      const restoredEdict = new ClientEdict(-1);
      let smokeReentered = false;
      const restored = new ClientAnimationSequence(restoredEdict, {
        flash: { keyframe: 1, duration: 0.1, next: 'smoke' },
        smoke: { keyframe: 2, duration: 0.4, next: 'fade', onEnter: () => { smokeReentered = true; } },
        fade: { keyframe: 3, duration: 0.3, next: null },
      }, 'flash');

      const newCurrentTime = 50.0;
      restored.setState(saved.state, newCurrentTime + saved.enteredAt);

      assert.equal(restored.current, 'smoke');
      assert.equal(restoredEdict.frame, 2);
      assert.equal(smokeReentered, false, 'restoring must not replay onEnter');

      // 0.3s already elapsed relative to newCurrentTime (matching the -0.3 saved above) -- ticking
      // comfortably past 0.1s further should cross smoke's 0.4s duration and advance to fade.
      restored.tick(newCurrentTime + 0.15);

      assert.equal(restored.current, 'fade');
      assert.equal(restoredEdict.frame, 3);
    });
  });
});
