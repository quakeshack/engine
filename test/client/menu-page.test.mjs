import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import {
  Action, Label, Slider, Textbox,
} from '../../source/engine/client/menu/MenuItem.ts';
import { DialogPage, ListPage, MenuPage, VerticalLayout } from '../../source/engine/client/menu/MenuPage.ts';

/**
 * Temporarily installs a minimal `Host`/`M`/`S` registry stub so page draw/navigation can run
 * without a full client bootstrap. Draw calls are recorded rather than rendered.
 * @param {() => void} callback test callback
 */
function withMockPageRegistry(callback) {
  const previousHost = registry.Host;
  const previousM = registry.M;
  const previousS = registry.S;

  const drawnPics = [];
  const printed = [];
  const printedWhite = [];
  const slidersDrawn = [];

  registry.Host = { realtime: 0 };
  registry.M = {
    sfx_menu1: 'menu1',
    sfx_menu2: 'menu2',
    sfx_menu3: 'menu3',
    Print(_x, _y, str) { printed.push(str); },
    PrintWhite(x, _y, str) { printedWhite.push({ x, str }); },
    DrawPic(_x, _y, pic) { drawnPics.push(pic); },
    DrawCharacter() {},
    DrawSlider(x) { slidersDrawn.push(x); },
  };
  registry.S = { LocalSound() {} };
  eventBus.publish('registry.frozen');

  try {
    callback({
      drawnPics, printed, printedWhite, slidersDrawn,
    });
  } finally {
    registry.Host = previousHost;
    registry.M = previousM;
    registry.S = previousS;
    eventBus.publish('registry.frozen');
  }
}

void describe('MenuPage', () => {
  void test('draws the corner logo and title picture together', () => {
    withMockPageRegistry(({ drawnPics }) => {
      const page = new MenuPage({ logoPic: { width: 32 }, titlePic: { width: 64 } });

      page.draw();

      assert.deepEqual(drawnPics, [{ width: 32 }, { width: 64 }]);
    });
  });

  void test('onEscape is invoked on Escape only when no focused item handles it first', () => {
    withMockPageRegistry(() => {
      let escaped = 0;
      const page = new MenuPage({ onEscape: () => { escaped += 1; } });

      assert.equal(page.handleInput(K.ESCAPE), true);
      assert.equal(escaped, 1);
    });
  });

  void test('onConfirm fires on Enter only when nothing else consumes it (e.g. an empty item list)', () => {
    withMockPageRegistry(() => {
      let confirmed = 0;
      const page = new MenuPage({ onConfirm: () => { confirmed += 1; } });

      assert.equal(page.handleInput(K.ENTER), true);
      assert.equal(confirmed, 1);
    });
  });

  void test('a focused item still gets first refusal over onConfirm', () => {
    withMockPageRegistry(() => {
      let confirmed = 0;
      let actioned = 0;
      const page = new MenuPage({
        items: [new Action({ label: 'Go', action: () => { actioned += 1; } })],
        onConfirm: () => { confirmed += 1; },
      });

      page.handleInput(K.ENTER);

      assert.equal(actioned, 1);
      assert.equal(confirmed, 0);
    });
  });

  void test('without onEscape/onConfirm configured, Escape/Enter fall through unhandled', () => {
    withMockPageRegistry(() => {
      const page = new MenuPage();

      assert.equal(page.handleInput(K.ESCAPE), false);
      assert.equal(page.handleInput(K.ENTER), false);
    });
  });

  void describe('handlePaste', () => {
    void test('forwards pasted text to the focused item', () => {
      withMockPageRegistry(() => {
        const textbox = new Textbox({ value: 'ab' });
        const page = new MenuPage({ items: [textbox] });

        assert.equal(page.handlePaste('cd'), true);
        assert.equal(textbox.getValue(), 'abcd');
      });
    });

    void test('is a no-op when the focused item does not support pasting', () => {
      withMockPageRegistry(() => {
        const page = new MenuPage({ items: [new Action({ label: 'Go' })] });

        assert.equal(page.handlePaste('cd'), false);
      });
    });

    void test('is a no-op when there is no focusable item', () => {
      withMockPageRegistry(() => {
        const page = new MenuPage();

        assert.equal(page.handlePaste('cd'), false);
      });
    });
  });
});

void describe('DialogPage', () => {
  void test('draws the backdrop page before its own content', () => {
    withMockPageRegistry(({ printed }) => {
      const backdrop = new MenuPage({ items: [new Label({ label: 'backdrop' })], layout: { draw(items) { items[0].draw(0, 0, false); } } });
      const dialog = new DialogPage({
        getBackdrop: () => backdrop,
        items: [new Label({ label: 'dialog' })],
        layout: { draw(items) { items[0].draw(0, 0, false); } },
      });

      dialog.draw();

      assert.deepEqual(printed, ['backdrop', 'dialog']);
    });
  });

  void test('draws nothing extra when there is no backdrop', () => {
    withMockPageRegistry(({ printed }) => {
      const dialog = new DialogPage({
        items: [new Label({ label: 'dialog' })],
        layout: { draw(items) { items[0].draw(0, 0, false); } },
      });

      dialog.draw();

      assert.deepEqual(printed, ['dialog']);
    });
  });
});

void describe('ListPage', () => {
  void test('remaps Left/Right to Up/Down navigation', () => {
    withMockPageRegistry(() => {
      const page = new ListPage({
        items: [
          new Action({ label: 'a' }),
          new Action({ label: 'b' }),
          new Action({ label: 'c' }),
        ],
      });

      assert.equal(page.cursor, 0);

      page.handleInput(K.RIGHTARROW);
      assert.equal(page.cursor, 1);

      page.handleInput(K.RIGHTARROW);
      assert.equal(page.cursor, 2);

      page.handleInput(K.LEFTARROW);
      assert.equal(page.cursor, 1);
    });
  });

  void test('still lets a focused item handle Left/Right itself first', () => {
    withMockPageRegistry(() => {
      let leftSeen = null;
      const capturingItem = new Action({ label: 'a' });
      capturingItem.handleInput = (key) => {
        leftSeen = key;
        return true;
      };

      const page = new ListPage({ items: [capturingItem] });
      page.handleInput(K.LEFTARROW);

      assert.equal(leftSeen, K.LEFTARROW);
      assert.equal(page.cursor, 0);
    });
  });
});

void describe('VerticalLayout with valueX', () => {
  void test('right-justifies labels of different lengths against the same value column', () => {
    withMockPageRegistry(({ printed, slidersDrawn }) => {
      withScratchCvars(['test_layout_a', 'test_layout_b'], () => {
        const layout = new VerticalLayout({ startY: 32, spacing: 0, valueX: 220 });
        const shortLabelSlider = new Slider({ label: 'Sound Volume', cvar: 'test_layout_a', min: 0, max: 1 });
        const longLabelSlider = new Slider({ label: 'CD Music Volume', cvar: 'test_layout_b', min: 0, max: 1 });

        layout.draw([shortLabelSlider, longLabelSlider], -1);

        // Regression test: labels used to share a single fixed left column, so longer labels
        // (e.g. "CD Music Volume") visually collided with the slider bar. Both must now
        // right-justify to the same edge, independent of their own length.
        assert.deepEqual(printed, ['Sound Volume', 'CD Music Volume']);
        assert.equal(slidersDrawn.length, 2);
        assert.equal(slidersDrawn[0], 220);
        assert.equal(slidersDrawn[1], 220);
      });
    });
  });

  void test('falls back to the fixed labelX column when valueX is not set', () => {
    withMockPageRegistry(({ slidersDrawn }) => {
      withScratchCvars(['test_layout_c'], () => {
        const layout = new VerticalLayout({ startY: 32, spacing: 0, labelX: 48 });
        const slider = new Slider({ label: 'Screen size', cvar: 'test_layout_c', min: 0, max: 1 });

        layout.draw([slider], -1);

        assert.equal(slidersDrawn[0], 48 + 116);
      });
    });
  });
});

/**
 * Registers scratch cvars for the duration of a callback, freeing them afterward.
 * @param {string[]} names cvar names
 * @param {() => void} callback test callback
 */
function withScratchCvars(names, callback) {
  const cvars = names.map((name) => new Cvar(name, '0'));

  try {
    callback();
  } finally {
    for (const cvar of cvars) {
      cvar.free();
    }
  }
}
