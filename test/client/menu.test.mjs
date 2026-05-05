import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * Temporarily install a global value for the duration of a callback.
 * @param {string} name
 * @param {unknown} value
 * @param {() => Promise<unknown>} callback
 * @returns {Promise<unknown>} Result of the callback.
 */
function withGlobalValue(name, value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });

  try {
    return Promise.resolve(callback()).finally(() => {
      if (descriptor === undefined) {
        delete globalThis[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    });
  } catch (error) {
    if (descriptor === undefined) {
      delete globalThis[name];
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }

    throw error;
  }
}

const { default: M } = await withGlobalValue('location', new URL('https://quake.test/play'), async () => import('../../source/engine/client/Menu.ts'));

void describe('Menu overlay notices', () => {
  void test('stores lines and clears by matching id', () => {
    const previousNoticeId = M.overlayNoticeId;
    const previousNoticeLines = M.overlayNoticeLines;

    try {
      M.SetOverlayNotice('mobile-input', 'Line one\nLine two');

      assert.equal(M.overlayNoticeId, 'mobile-input');
      assert.deepEqual(M.overlayNoticeLines, ['Line one', 'Line two']);

      M.ClearOverlayNotice('some-other-notice');

      assert.equal(M.overlayNoticeId, 'mobile-input');
      assert.deepEqual(M.overlayNoticeLines, ['Line one', 'Line two']);

      M.ClearOverlayNotice('mobile-input');

      assert.equal(M.overlayNoticeId, null);
      assert.deepEqual(M.overlayNoticeLines, []);
    } finally {
      M.overlayNoticeId = previousNoticeId;
      M.overlayNoticeLines = previousNoticeLines;
    }
  });
});
