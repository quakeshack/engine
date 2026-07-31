import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import Key from '../../source/engine/client/Key.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import {
  Action, KeyBindItem, Label, Slider, Textbox,
} from '../../source/engine/client/menu/MenuItem.ts';
import {
  DialogPage, GridLayout, ImageBasedLayout, ListLayout, ListPage, MenuPage, VerticalLayout,
} from '../../source/engine/client/menu/MenuPage.ts';

/**
 * Temporarily installs a minimal `Host`/`M`/`S` registry stub so page draw/navigation can run
 * without a full client bootstrap. Draw calls are recorded rather than rendered.
 * @param {() => void} callback test callback
 */
function withMockPageRegistry(callback) {
  const previousHost = registry.Host;
  const previousKey = registry.Key;
  const previousM = registry.M;
  const previousS = registry.S;

  const drawnPics = [];
  const printed = [];
  const printedWhite = [];
  const slidersDrawn = [];
  const renderingPages = [];

  registry.Host = { realtime: 0 };
  registry.Key = Key;
  registry.M = {
    sfx_menu1: 'menu1',
    sfx_menu2: 'menu2',
    sfx_menu3: 'menu3',
    mouseX: 0,
    mouseY: 0,
    Print(_x, _y, str) { printed.push(str); },
    PrintWhite(x, _y, str) { printedWhite.push({ x, str }); },
    DrawPic(_x, _y, pic) { drawnPics.push(pic); },
    DrawCharacter() {},
    DrawSlider(x) { slidersDrawn.push(x); },
    withRenderingPage(page, draw) { renderingPages.push(page); draw(); },
  };
  registry.S = { LocalSound() {} };
  eventBus.publish('registry.frozen');

  try {
    callback({
      drawnPics, printed, printedWhite, slidersDrawn, renderingPages,
    });
  } finally {
    registry.Host = previousHost;
    registry.Key = previousKey;
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

  void test('pausesGame defaults to true, matching classic pause-on-menu behavior', () => {
    withMockPageRegistry(() => {
      const page = new MenuPage();

      assert.equal(page.pausesGame, true);
    });
  });

  void test('pausesGame can be opted out of for a page over a world that must keep running', () => {
    withMockPageRegistry(() => {
      const page = new MenuPage({ pausesGame: false });

      assert.equal(page.pausesGame, false);
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

  // Regression test: a mod's backdrop page can declare its own viewport (e.g. hellwave's
  // screen-filling main menu) that differs from the dialog's own (e.g. the classic 320x200
  // quit-confirmation box). M resolves its drawing primitives against whichever page is
  // *currently rendering*, which must be the backdrop while the backdrop draws -- not the
  // dialog, even though the dialog stays on top of menuStack the whole time.
  void test('renders the backdrop against its own viewport, not the dialog\'s', () => {
    withMockPageRegistry(({ renderingPages }) => {
      const backdropViewport = { width: 640 };
      const dialogViewport = { width: 320 };
      const backdrop = new MenuPage({ viewport: backdropViewport, layout: { draw() {} } });
      const dialog = new DialogPage({
        viewport: dialogViewport,
        getBackdrop: () => backdrop,
        layout: { draw() {} },
      });

      dialog.draw();

      assert.deepEqual(renderingPages, [backdrop, dialog]);
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

void describe('MenuLayout.hitTest', () => {
  void test('VerticalLayout resolves the row under the point, spanning the full row width', () => {
    withMockPageRegistry(() => {
      const layout = new VerticalLayout({ startY: 32, spacing: 4 });
      const items = [new Action({ label: 'a' }), new Action({ label: 'b' })];

      // Row 0 spans y=[32,40), row 1 spans y=[44,52) (8px item height + 4px spacing).
      assert.equal(layout.hitTest(items, 300, 33), 0);
      assert.equal(layout.hitTest(items, 0, 45), 1);
      assert.equal(layout.hitTest(items, 10, 41), null); // in the gap between rows
    });
  });

  void test('VerticalLayout skips non-focusable and hidden items', () => {
    withMockPageRegistry(() => {
      const layout = new VerticalLayout({ startY: 32, spacing: 0 });
      const items = [new Label({ label: 'heading' }), new Action({ label: 'go', visible: false })];

      assert.equal(layout.hitTest(items, 10, 32), null);
      assert.equal(layout.hitTest(items, 10, 40), null);
    });
  });

  void test('ImageBasedLayout resolves the fixed-height row band for each item index', () => {
    withMockPageRegistry(() => {
      const layout = new ImageBasedLayout({ backgroundPic: null, cursorYBase: 32, cursorYSpacing: 20 });
      const items = [new Action({ label: 'a' }), new Action({ label: 'b' })];

      assert.equal(layout.hitTest(items, 0, 32), 0);
      assert.equal(layout.hitTest(items, 0, 52), 1);
      assert.equal(layout.hitTest(items, 0, 200), null);
    });
  });

  void test('ListLayout resolves rows using its own spacing', () => {
    withMockPageRegistry(() => {
      const layout = new ListLayout({ startY: 32, spacing: 8 });
      const items = [new Action({ label: 'a' }), new Action({ label: 'b' })];

      assert.equal(layout.hitTest(items, 16, 32), 0);
      assert.equal(layout.hitTest(items, 16, 40), 1);
    });
  });

  void test('GridLayout resolves the cell under the point, bounded by column/row spacing', () => {
    withMockPageRegistry(() => {
      const layout = new GridLayout({
        columns: 2, startX: 16, startY: 32, columnSpacing: 160, rowSpacing: 8,
      });
      const items = [
        new Action({ label: 'a' }), new Action({ label: 'b' }),
        new Action({ label: 'c' }), new Action({ label: 'd' }),
      ];

      assert.equal(layout.hitTest(items, 20, 32), 0);
      assert.equal(layout.hitTest(items, 180, 32), 1);
      assert.equal(layout.hitTest(items, 20, 40), 2);
      assert.equal(layout.hitTest(items, 180, 40), 3);
      assert.equal(layout.hitTest(items, 20, 100), null);
    });
  });
});

void describe('MenuPage.updateHover', () => {
  void test('moves the cursor to the item under the point, silently', () => {
    withMockPageRegistry(({ printed }) => {
      const page = new MenuPage({
        layout: new VerticalLayout({ startY: 32, spacing: 0 }),
        items: [new Action({ label: 'a' }), new Action({ label: 'b' })],
      });

      page.updateHover(0, 40);

      assert.equal(page.cursor, 1);
      // No sfx_menu1 sound and no draw side effects from merely hovering.
      assert.deepEqual(printed, []);
    });
  });

  void test('is a no-op when the point is not over any item', () => {
    withMockPageRegistry(() => {
      const page = new MenuPage({
        layout: new VerticalLayout({ startY: 32, spacing: 0 }),
        items: [new Action({ label: 'a' })],
      });

      page.updateHover(0, 999);

      assert.equal(page.cursor, 0);
    });
  });
});

void describe('MenuPage MOUSE1 handling', () => {
  void test('clicking an item focuses and activates it like Enter would', () => {
    withMockPageRegistry(() => {
      let clicked = 0;
      const page = new MenuPage({
        layout: new VerticalLayout({ startY: 32, spacing: 0 }),
        items: [
          new Action({ label: 'a' }),
          new Action({ label: 'b', action: () => { clicked += 1; } }),
        ],
      });

      registry.M.mouseX = 0;
      registry.M.mouseY = 40; // second row

      assert.equal(page.handleInput(K.MOUSE1), true);
      assert.equal(page.cursor, 1);
      assert.equal(clicked, 1);
    });
  });

  void test('clicking empty space is a no-op', () => {
    withMockPageRegistry(() => {
      const page = new MenuPage({
        layout: new VerticalLayout({ startY: 32, spacing: 0 }),
        items: [new Action({ label: 'a' })],
      });

      registry.M.mouseX = 0;
      registry.M.mouseY = 999;

      assert.equal(page.handleInput(K.MOUSE1), false);
      assert.equal(page.cursor, 0);
    });
  });

  void test('a focused item mid key-capture still gets first refusal over a click elsewhere', () => {
    withMockPageRegistry(() => {
      const previousBindings = [...Key.bindings];
      const previousCmdText = Cmd.text;

      try {
        Key.bindings = [];
        Cmd.text = '';

        const captureItem = new KeyBindItem({ label: 'jump', command: '+jump' });
        captureItem.capturing = true;

        const page = new MenuPage({
          layout: new VerticalLayout({ startY: 32, spacing: 0 }),
          items: [captureItem, new Action({ label: 'b' })],
        });

        // Click lands on the second row (y=[40,48)), but the focused (capturing) item consumes
        // the click first, binding MOUSE1 to its command instead of moving focus/activating row 2.
        registry.M.mouseX = 0;
        registry.M.mouseY = 44;

        assert.equal(page.handleInput(K.MOUSE1), true);
        assert.equal(captureItem.capturing, false);
        assert.equal(page.cursor, 0);
        assert.match(Cmd.text, /^bind "MOUSE1" "\+jump"\n/);
      } finally {
        Key.bindings = previousBindings;
        Cmd.text = previousCmdText;
      }
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
