import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClientEngineApi } from '../support/clientEngineApi.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import { MenuStack } from '../../source/engine/client/menu/MenuStack.ts';
import { useMenuOf } from '../support/menu.ts';
import { engineMocks } from '../support/engineMocks.ts';

const engineApi = createClientEngineApi();

/**
 * Installs a fake `M` (Menu.ts) registry entry backed by a real MenuStack, so
 * engineApi.Menu's delegation can be verified without a full client bootstrap.
 * @param {(context: { menuStack: MenuStack, getCloseMenuCalls: () => number, getPopMenuCalls: () => number }) => void} callback test callback
 */
function withMockClientEngineMenu(callback) {
  const previousM = engineMocks.M;
  const previousIN = engineMocks.IN;
  const previousDestination = Key.destination;

  const menuStack = new MenuStack();
  let closeMenuCalls = 0;
  let popMenuCalls = 0;

  engineMocks.M = {
    entersound: false,
    menuStack,
    CloseMenu() {
      closeMenuCalls += 1;
      menuStack.clear();
    },
    PopMenu() {
      popMenuCalls += 1;
      menuStack.pop();
    },
  };

  const restoreMenu = useMenuOf(engineMocks.M);
  // MenuStack.push() releases pointer lock on every open — a no-op spy here.
  engineMocks.IN = { ReleasePointerLock() {} };

  try {
    callback({
      menuStack,
      getCloseMenuCalls: () => closeMenuCalls,
      getPopMenuCalls: () => popMenuCalls,
    });
  } finally {
    engineMocks.M = previousM;
    restoreMenu();
    engineMocks.IN = previousIN;
    Key.destination = previousDestination;
  }
}

void describe('ClientEngineAPI.Menu', () => {
  void test('RegisterPage/Open registers and opens a page, switching Key.destination to menu', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const page = new engineApi.Menu.MenuPage({ title: 'Custom Page' });
      Key.destination = KeyDestination.game;

      engineApi.Menu.RegisterPage('custom', page);
      engineApi.Menu.Open('custom');

      assert.equal(menuStack.current(), page);
      assert.equal(Key.destination, KeyDestination.menu);
      assert.equal(engineApi.Menu.IsOpen(), true);
      assert.equal(engineApi.Menu.IsOpen('custom'), true);
      assert.equal(engineApi.Menu.IsOpen('other'), false);
    });
  });

  void test('UnregisterPage removes a page from the registry', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const page = new engineApi.Menu.MenuPage({ title: 'Custom Page' });
      engineApi.Menu.RegisterPage('custom', page);

      engineApi.Menu.UnregisterPage('custom');

      assert.equal(menuStack.pages.has('custom'), false);
    });
  });

  void test('Push stacks a page on top without touching Key.destination', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      const options = new engineApi.Menu.MenuPage({ title: 'Options' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.RegisterPage('options', options);

      Key.destination = KeyDestination.menu;
      engineApi.Menu.Push('main');
      engineApi.Menu.Push('options');

      assert.equal(menuStack.current(), options);
      assert.equal(menuStack.depth(), 2);
    });
  });

  void test('Pop delegates to M.PopMenu (revealing the page beneath, or closing when empty)', () => {
    withMockClientEngineMenu(({ menuStack, getPopMenuCalls }) => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      const options = new engineApi.Menu.MenuPage({ title: 'Options' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.RegisterPage('options', options);

      engineApi.Menu.Push('main');
      engineApi.Menu.Push('options');
      engineApi.Menu.Pop();

      assert.equal(getPopMenuCalls(), 1);
      assert.equal(menuStack.current(), main);
    });
  });

  void test('Replace swaps the current page without growing the stack', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      const options = new engineApi.Menu.MenuPage({ title: 'Options' });
      const keys = new engineApi.Menu.MenuPage({ title: 'Keys' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.RegisterPage('options', options);
      engineApi.Menu.RegisterPage('keys', keys);

      engineApi.Menu.Push('main');
      engineApi.Menu.Push('options');
      engineApi.Menu.Replace('keys');

      assert.equal(menuStack.current(), keys);
      assert.equal(menuStack.depth(), 2);
    });
  });

  void test('Close delegates to M.CloseMenu, clearing the whole stack', () => {
    withMockClientEngineMenu(({ menuStack, getCloseMenuCalls }) => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.Push('main');

      engineApi.Menu.Close();

      assert.equal(getCloseMenuCalls(), 1);
      assert.equal(menuStack.isEmpty(), true);
    });
  });

  void test('AddItem appends to a page, or inserts at a given index', () => {
    withMockClientEngineMenu(() => {
      const page = new engineApi.Menu.MenuPage({
        items: [new engineApi.Menu.Label({ label: 'first' })],
      });
      engineApi.Menu.RegisterPage('options', page);

      const appended = new engineApi.Menu.Label({ label: 'appended' });
      engineApi.Menu.AddItem('options', appended);
      assert.equal(page.items[page.items.length - 1], appended);

      const inserted = new engineApi.Menu.Label({ label: 'inserted' });
      engineApi.Menu.AddItem('options', inserted, 0);
      assert.equal(page.items[0], inserted);
      assert.equal(page.items.length, 3);
    });
  });

  void test('AddItem on an unknown page is a safe no-op', () => {
    withMockClientEngineMenu(() => {
      const item = new engineApi.Menu.Label({ label: 'x' });
      assert.doesNotThrow(() => engineApi.Menu.AddItem('does-not-exist', item));
    });
  });

  void test('RemoveItem removes a previously added item', () => {
    withMockClientEngineMenu(() => {
      const item = new engineApi.Menu.Label({ label: 'removable' });
      const page = new engineApi.Menu.MenuPage({ items: [item] });
      engineApi.Menu.RegisterPage('options', page);

      engineApi.Menu.RemoveItem('options', item);

      assert.equal(page.items.includes(item), false);
    });
  });

  void test('SetRootPage declares which registered page IsOpen()/root-dependent behavior resolves to', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      engineApi.Menu.RegisterPage('main', main);

      engineApi.Menu.SetRootPage('main');

      assert.equal(menuStack.isShowingRoot(), false);
      engineApi.Menu.Push('main');
      assert.equal(menuStack.isShowingRoot(), true);
    });
  });

  void test('Depth/IsEmpty reflect the navigation stack', () => {
    withMockClientEngineMenu(() => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      const options = new engineApi.Menu.MenuPage({ title: 'Options' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.RegisterPage('options', options);

      assert.equal(engineApi.Menu.IsEmpty(), true);
      assert.equal(engineApi.Menu.Depth(), 0);

      engineApi.Menu.Push('main');
      engineApi.Menu.Push('options');

      assert.equal(engineApi.Menu.IsEmpty(), false);
      assert.equal(engineApi.Menu.Depth(), 2);
    });
  });

  void test('PopTo pops down to the given depth', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      const options = new engineApi.Menu.MenuPage({ title: 'Options' });
      const keys = new engineApi.Menu.MenuPage({ title: 'Keys' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.RegisterPage('options', options);
      engineApi.Menu.RegisterPage('keys', keys);

      engineApi.Menu.Push('main');
      engineApi.Menu.Push('options');
      engineApi.Menu.Push('keys');
      engineApi.Menu.PopTo(1);

      assert.equal(menuStack.current(), main);
      assert.equal(engineApi.Menu.Depth(), 1);
    });
  });

  void test('PopToRoot pops down to a single page', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      const options = new engineApi.Menu.MenuPage({ title: 'Options' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.RegisterPage('options', options);

      engineApi.Menu.Push('main');
      engineApi.Menu.Push('options');
      engineApi.Menu.PopToRoot();

      assert.equal(menuStack.current(), main);
      assert.equal(engineApi.Menu.Depth(), 1);
    });
  });

  void test('Clear empties the stack without touching Key.destination', () => {
    withMockClientEngineMenu(() => {
      const main = new engineApi.Menu.MenuPage({ title: 'Main' });
      engineApi.Menu.RegisterPage('main', main);
      engineApi.Menu.Open('main');

      assert.equal(Key.destination, KeyDestination.menu);

      engineApi.Menu.Clear();

      assert.equal(engineApi.Menu.IsEmpty(), true);
      assert.equal(Key.destination, KeyDestination.menu);
    });
  });
});
