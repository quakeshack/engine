import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientEngineAPI } from '../../source/engine/common/GameAPIs.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import { MenuStack } from '../../source/engine/client/menu/MenuStack.ts';

/**
 * Installs a fake `M` (Menu.ts) registry entry backed by a real MenuStack, so
 * ClientEngineAPI.Menu's delegation can be verified without a full client bootstrap.
 * @param {(context: { menuStack: MenuStack, getCloseMenuCalls: () => number, getPopMenuCalls: () => number }) => void} callback test callback
 */
function withMockClientEngineMenu(callback) {
  const previousM = registry.M;
  const previousDestination = Key.destination;

  const menuStack = new MenuStack();
  let closeMenuCalls = 0;
  let popMenuCalls = 0;

  registry.M = {
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
  eventBus.publish('registry.frozen');

  try {
    callback({
      menuStack,
      getCloseMenuCalls: () => closeMenuCalls,
      getPopMenuCalls: () => popMenuCalls,
    });
  } finally {
    registry.M = previousM;
    Key.destination = previousDestination;
    eventBus.publish('registry.frozen');
  }
}

void describe('ClientEngineAPI.Menu', () => {
  void test('RegisterPage/Open registers and opens a page, switching Key.destination to menu', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const page = new ClientEngineAPI.Menu.MenuPage({ title: 'Custom Page' });
      Key.destination = KeyDestination.game;

      ClientEngineAPI.Menu.RegisterPage('custom', page);
      ClientEngineAPI.Menu.Open('custom');

      assert.equal(menuStack.current(), page);
      assert.equal(Key.destination, KeyDestination.menu);
      assert.equal(ClientEngineAPI.Menu.IsOpen(), true);
      assert.equal(ClientEngineAPI.Menu.IsOpen('custom'), true);
      assert.equal(ClientEngineAPI.Menu.IsOpen('other'), false);
    });
  });

  void test('UnregisterPage removes a page from the registry', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const page = new ClientEngineAPI.Menu.MenuPage({ title: 'Custom Page' });
      ClientEngineAPI.Menu.RegisterPage('custom', page);

      ClientEngineAPI.Menu.UnregisterPage('custom');

      assert.equal(menuStack.pages.has('custom'), false);
    });
  });

  void test('Push stacks a page on top without touching Key.destination', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const main = new ClientEngineAPI.Menu.MenuPage({ title: 'Main' });
      const options = new ClientEngineAPI.Menu.MenuPage({ title: 'Options' });
      ClientEngineAPI.Menu.RegisterPage('main', main);
      ClientEngineAPI.Menu.RegisterPage('options', options);

      Key.destination = KeyDestination.menu;
      ClientEngineAPI.Menu.Push('main');
      ClientEngineAPI.Menu.Push('options');

      assert.equal(menuStack.current(), options);
      assert.equal(menuStack.depth(), 2);
    });
  });

  void test('Pop delegates to M.PopMenu (revealing the page beneath, or closing when empty)', () => {
    withMockClientEngineMenu(({ menuStack, getPopMenuCalls }) => {
      const main = new ClientEngineAPI.Menu.MenuPage({ title: 'Main' });
      const options = new ClientEngineAPI.Menu.MenuPage({ title: 'Options' });
      ClientEngineAPI.Menu.RegisterPage('main', main);
      ClientEngineAPI.Menu.RegisterPage('options', options);

      ClientEngineAPI.Menu.Push('main');
      ClientEngineAPI.Menu.Push('options');
      ClientEngineAPI.Menu.Pop();

      assert.equal(getPopMenuCalls(), 1);
      assert.equal(menuStack.current(), main);
    });
  });

  void test('Replace swaps the current page without growing the stack', () => {
    withMockClientEngineMenu(({ menuStack }) => {
      const main = new ClientEngineAPI.Menu.MenuPage({ title: 'Main' });
      const options = new ClientEngineAPI.Menu.MenuPage({ title: 'Options' });
      const keys = new ClientEngineAPI.Menu.MenuPage({ title: 'Keys' });
      ClientEngineAPI.Menu.RegisterPage('main', main);
      ClientEngineAPI.Menu.RegisterPage('options', options);
      ClientEngineAPI.Menu.RegisterPage('keys', keys);

      ClientEngineAPI.Menu.Push('main');
      ClientEngineAPI.Menu.Push('options');
      ClientEngineAPI.Menu.Replace('keys');

      assert.equal(menuStack.current(), keys);
      assert.equal(menuStack.depth(), 2);
    });
  });

  void test('Close delegates to M.CloseMenu, clearing the whole stack', () => {
    withMockClientEngineMenu(({ menuStack, getCloseMenuCalls }) => {
      const main = new ClientEngineAPI.Menu.MenuPage({ title: 'Main' });
      ClientEngineAPI.Menu.RegisterPage('main', main);
      ClientEngineAPI.Menu.Push('main');

      ClientEngineAPI.Menu.Close();

      assert.equal(getCloseMenuCalls(), 1);
      assert.equal(menuStack.isEmpty(), true);
    });
  });

  void test('AddItem appends to a page, or inserts at a given index', () => {
    withMockClientEngineMenu(() => {
      const page = new ClientEngineAPI.Menu.MenuPage({
        items: [new ClientEngineAPI.Menu.Label({ label: 'first' })],
      });
      ClientEngineAPI.Menu.RegisterPage('options', page);

      const appended = new ClientEngineAPI.Menu.Label({ label: 'appended' });
      ClientEngineAPI.Menu.AddItem('options', appended);
      assert.equal(page.items[page.items.length - 1], appended);

      const inserted = new ClientEngineAPI.Menu.Label({ label: 'inserted' });
      ClientEngineAPI.Menu.AddItem('options', inserted, 0);
      assert.equal(page.items[0], inserted);
      assert.equal(page.items.length, 3);
    });
  });

  void test('AddItem on an unknown page is a safe no-op', () => {
    withMockClientEngineMenu(() => {
      const item = new ClientEngineAPI.Menu.Label({ label: 'x' });
      assert.doesNotThrow(() => ClientEngineAPI.Menu.AddItem('does-not-exist', item));
    });
  });

  void test('RemoveItem removes a previously added item', () => {
    withMockClientEngineMenu(() => {
      const item = new ClientEngineAPI.Menu.Label({ label: 'removable' });
      const page = new ClientEngineAPI.Menu.MenuPage({ items: [item] });
      ClientEngineAPI.Menu.RegisterPage('options', page);

      ClientEngineAPI.Menu.RemoveItem('options', item);

      assert.equal(page.items.includes(item), false);
    });
  });
});
