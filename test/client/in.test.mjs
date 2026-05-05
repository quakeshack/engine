import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createMobileInputSupportState,
  markKeyboardActivity,
  markMouseActivity,
  refreshMobileInputSupportState,
  shouldShowMobileExternalInputWarning,
} from '../../source/engine/client/IN.ts';

/**
 * Create a minimal matchMedia mock from explicit query results.
 * @param {Record<string, boolean>} matchesByQuery
 * @returns {(query: string) => { matches: boolean }} Mock matchMedia function.
 */
function createMatchMedia(matchesByQuery) {
  return function matchMedia(query) {
    return {
      matches: matchesByQuery[query] ?? false,
    };
  };
}

void describe('IN mobile external input warning', () => {
  void test('shows the warning on touch-only mobile devices', () => {
    const state = createMobileInputSupportState({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      userAgentDataMobile: true,
      maxTouchPoints: 5,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    });

    assert.equal(shouldShowMobileExternalInputWarning(state), true);
  });

  void test('keeps the warning hidden on touch-enabled non-mobile devices', () => {
    const state = createMobileInputSupportState({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      userAgentDataMobile: false,
      maxTouchPoints: 10,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    });

    assert.equal(shouldShowMobileExternalInputWarning(state), false);
  });

  void test('requires both keyboard activity and mouse support before hiding the warning', () => {
    const touchOnlyEnvironment = {
      userAgent: 'Mozilla/5.0 (Android 15; Mobile)',
      userAgentDataMobile: true,
      maxTouchPoints: 5,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    };
    const mouseAttachedEnvironment = {
      ...touchOnlyEnvironment,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
        '(any-pointer: fine)': true,
      }),
    };

    let state = createMobileInputSupportState(touchOnlyEnvironment);

    assert.equal(shouldShowMobileExternalInputWarning(state), true);

    state = markKeyboardActivity(state);

    assert.equal(shouldShowMobileExternalInputWarning(state), true);

    state = refreshMobileInputSupportState(state, mouseAttachedEnvironment);

    assert.equal(shouldShowMobileExternalInputWarning(state), false);
  });

  void test('falls back to actual mouse activity when pointer capabilities do not update yet', () => {
    let state = createMobileInputSupportState({
      userAgent: 'Mozilla/5.0 (Android 15; Mobile)',
      userAgentDataMobile: true,
      maxTouchPoints: 5,
      matchMedia: createMatchMedia({
        '(any-pointer: coarse)': true,
        '(pointer: coarse)': true,
      }),
    });

    state = markKeyboardActivity(state);

    assert.equal(shouldShowMobileExternalInputWarning(state), true);

    state = markMouseActivity(state);

    assert.equal(shouldShowMobileExternalInputWarning(state), false);
  });
});
