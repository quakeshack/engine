import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { eventBus, registry } from '../../source/engine/registry.ts';
import { MenuPage } from '../../source/engine/client/menu/MenuPage.ts';
import { MenuStack } from '../../source/engine/client/menu/MenuStack.ts';

/**
 * Temporarily installs minimal `M`/`IN` registry stubs (MenuStack only needs `M.entersound`
 * and `IN.ReleasePointerLock`, called on every push).
 * @param {() => void} callback test callback
 */
function withMockMenuRegistry(callback) {
  const previousM = registry.M;
  const previousIN = registry.IN;

  registry.M = { entersound: false };
  registry.IN = { ReleasePointerLock() {} };
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    registry.M = previousM;
    registry.IN = previousIN;
    eventBus.publish('registry.frozen');
  }
}

/**
 * @param {string} label
 * @returns {MenuPage} a page with activate/deactivate call tracking
 */
function createTrackedPage(label) {
  const page = new MenuPage({ title: label });
  page.enterCount = 0;
  page.exitCount = 0;
  page.onEnter = () => { page.enterCount += 1; };
  page.onExit = () => { page.exitCount += 1; };
  return page;
}

void describe('MenuStack', () => {
  void test('register makes a page resolvable by name and publishes menu.page-registered', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const page = createTrackedPage('main');
      const registered = [];
      const unsubscribe = eventBus.subscribe('menu.page-registered', (name) => registered.push(name));

      try {
        stack.register('main', page);

        assert.equal(stack.pages.get('main'), page);
        assert.deepEqual(registered, ['main']);
      } finally {
        unsubscribe();
      }
    });
  });

  void test('push activates the new page and deactivates the previous one', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      const options = createTrackedPage('options');
      stack.register('main', main);
      stack.register('options', options);

      stack.push('main');
      assert.equal(main.enterCount, 1);
      assert.equal(stack.current(), main);

      stack.push('options');
      assert.equal(main.exitCount, 1);
      assert.equal(options.enterCount, 1);
      assert.equal(stack.current(), options);
      assert.equal(stack.depth(), 2);
    });
  });

  void test('push sets entersound and publishes menu.opened/menu.closed', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      const options = createTrackedPage('options');
      stack.register('main', main);
      stack.register('options', options);

      const opened = [];
      const closed = [];
      const unsubOpen = eventBus.subscribe('menu.opened', (name) => opened.push(name));
      const unsubClose = eventBus.subscribe('menu.closed', (name) => closed.push(name));

      try {
        stack.push('main');
        assert.equal(registry.M.entersound, true);
        registry.M.entersound = false;

        stack.push('options');
        assert.equal(registry.M.entersound, true);

        assert.deepEqual(opened, ['main', 'options']);
        assert.deepEqual(closed, ['main']);
      } finally {
        unsubOpen();
        unsubClose();
      }
    });
  });

  void test('push logs an error and leaves the stack untouched for an unknown name', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      stack.register('main', main);
      stack.push('main');

      const previousError = console.error;
      let errorCalled = false;
      console.error = () => { errorCalled = true; };

      try {
        stack.push('does-not-exist');

        assert.equal(errorCalled, true);
        assert.equal(stack.current(), main);
        assert.equal(stack.depth(), 1);
      } finally {
        console.error = previousError;
      }
    });
  });

  void test('pop reveals the previous page and returns the popped one', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      const options = createTrackedPage('options');
      stack.register('main', main);
      stack.register('options', options);

      stack.push('main');
      stack.push('options');

      const popped = stack.pop();

      assert.equal(popped, options);
      assert.equal(options.exitCount, 1);
      assert.equal(main.enterCount, 2); // re-activated on reveal
      assert.equal(stack.current(), main);
      assert.equal(stack.depth(), 1);
    });
  });

  void test('pop on an empty stack returns null and does not throw', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();

      assert.equal(stack.pop(), null);
      assert.equal(stack.isEmpty(), true);
    });
  });

  void test('clear deactivates every page and empties the stack', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      const options = createTrackedPage('options');
      const keys = createTrackedPage('keys');
      stack.register('main', main);
      stack.register('options', options);
      stack.register('keys', keys);

      stack.push('main');
      stack.push('options');
      stack.push('keys');

      stack.clear();

      // main/options were each deactivated once already when covered by the next push,
      // then again by clear() itself; keys was only ever deactivated by clear().
      assert.equal(main.exitCount, 2);
      assert.equal(options.exitCount, 2);
      assert.equal(keys.exitCount, 1);
      assert.equal(stack.isEmpty(), true);
      assert.equal(stack.depth(), 0);
    });
  });

  void test('replace swaps the top page without growing the stack', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      const options = createTrackedPage('options');
      const keys = createTrackedPage('keys');
      stack.register('main', main);
      stack.register('options', options);
      stack.register('keys', keys);

      stack.push('main');
      stack.push('options');
      stack.replace('keys');

      assert.equal(stack.current(), keys);
      assert.equal(stack.depth(), 2);
      assert.equal(options.exitCount, 1);
    });
  });

  void test('popTo pops down to the given depth', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      const options = createTrackedPage('options');
      const keys = createTrackedPage('keys');
      stack.register('main', main);
      stack.register('options', options);
      stack.register('keys', keys);

      stack.push('main');
      stack.push('options');
      stack.push('keys');
      stack.popTo(1);

      assert.equal(stack.depth(), 1);
      assert.equal(stack.current(), main);
    });
  });

  void test('popToRoot pops down to a single page', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const main = createTrackedPage('main');
      const options = createTrackedPage('options');
      stack.register('main', main);
      stack.register('options', options);

      stack.push('main');
      stack.push('options');
      stack.popToRoot();

      assert.equal(stack.depth(), 1);
      assert.equal(stack.current(), main);
    });
  });

  void test('push can accept a raw unregistered page instance', () => {
    withMockMenuRegistry(() => {
      const stack = new MenuStack();
      const page = createTrackedPage('adhoc');

      stack.push(page);

      assert.equal(stack.current(), page);
      assert.equal(page.enterCount, 1);
    });
  });
});
