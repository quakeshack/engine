import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Cmd from '../../source/engine/common/Cmd.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import Key from '../../source/engine/client/Key.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import {
  ColorPicker, KeyBindItem, MenuItem, SaveSlotItem, Slider, Textbox, Toggle,
} from '../../source/engine/client/menu/MenuItem.ts';

/**
 * Temporarily installs minimal `Host`/`Key`/`M`/`S` registry stubs so widget draw/input
 * handlers (sound cues, blink timing, key names) can run without a full client bootstrap.
 * @param {() => void} callback test callback
 */
function withMockWidgetRegistry(callback) {
  const previousHost = registry.Host;
  const previousKey = registry.Key;
  const previousM = registry.M;
  const previousS = registry.S;

  const printed = [];
  const sounds = [];

  registry.Host = { realtime: 0 };
  registry.Key = Key;
  registry.M = {
    sfx_menu1: 'menu1',
    sfx_menu2: 'menu2',
    sfx_menu3: 'menu3',
    Print(_x, _y, str) { printed.push(str); },
    PrintWhite(_x, _y, str) { printed.push(str); },
    DrawCharacter() {},
    DrawSlider() {},
  };
  registry.S = { LocalSound(sfx) { sounds.push(sfx); } };
  eventBus.publish('registry.frozen');

  try {
    callback({ printed, sounds });
  } finally {
    registry.Host = previousHost;
    registry.Key = previousKey;
    registry.M = previousM;
    registry.S = previousS;
    eventBus.publish('registry.frozen');
  }
}

/**
 * Registers a scratch cvar for the duration of a callback, freeing it afterward.
 * @param {string} name cvar name
 * @param {string} value initial value
 * @param {(cvar: Cvar) => void} callback test callback
 */
function withScratchCvar(name, value, callback) {
  const cvar = new Cvar(name, value);

  try {
    callback(cvar);
  } finally {
    cvar.free();
  }
}

void describe('MenuItem.getHeight', () => {
  void test('defaults to 8 pixels', () => {
    const item = new MenuItem();
    assert.equal(item.getHeight(), 8);
  });

  void test('respects heightOverride when provided', () => {
    const item = new MenuItem({ heightOverride: 24 });
    assert.equal(item.getHeight(), 24);
  });
});

void describe('Slider', () => {
  void test('reads and writes the bound cvar, clamped to [min, max]', () => {
    withMockWidgetRegistry(() => {
      withScratchCvar('test_menu_slider', '50', () => {
        const slider = new Slider({ cvar: 'test_menu_slider', min: 30, max: 120, step: 10 });

        assert.equal(slider.getValue(), 50);

        slider.setValue(200);
        assert.equal(slider.getValue(), 120);

        slider.setValue(-10);
        assert.equal(slider.getValue(), 30);
      });
    });
  });

  void test('Right/Enter increase and Left decreases when not inverted', () => {
    withMockWidgetRegistry(({ sounds }) => {
      withScratchCvar('test_menu_slider_dir', '50', () => {
        const slider = new Slider({ cvar: 'test_menu_slider_dir', min: 0, max: 100, step: 10 });

        slider.handleInput(K.RIGHTARROW);
        assert.equal(slider.getValue(), 60);

        slider.handleInput(K.LEFTARROW);
        assert.equal(slider.getValue(), 50);

        slider.handleInput(K.ENTER);
        assert.equal(slider.getValue(), 60);

        assert.deepEqual(sounds, ['menu3', 'menu3', 'menu3']);
      });
    });
  });

  void test('inverted sliders flip the raw-value direction so the bar still moves left/right intuitively', () => {
    withMockWidgetRegistry(() => {
      withScratchCvar('test_menu_slider_gamma', '0.75', () => {
        const slider = new Slider({
          cvar: 'test_menu_slider_gamma', min: 0.5, max: 1.0, step: 0.05, invert: true,
        });

        const normalizedBefore = slider.getNormalizedValue();

        // Left should visually decrease the bar for an inverted slider, meaning the raw
        // gamma value must increase (see MenuItem.ts Slider.handleInput).
        slider.handleInput(K.LEFTARROW);
        assert.ok(slider.getValue() > 0.75);
        assert.ok(slider.getNormalizedValue() < normalizedBefore);

        slider.setValue(0.75);
        slider.handleInput(K.RIGHTARROW);
        assert.ok(slider.getValue() < 0.75);
        assert.ok(slider.getNormalizedValue() > normalizedBefore);
      });
    });
  });

  void test('does nothing when disabled', () => {
    withMockWidgetRegistry(() => {
      withScratchCvar('test_menu_slider_disabled', '50', () => {
        const slider = new Slider({ cvar: 'test_menu_slider_disabled', min: 0, max: 100, enabled: false });

        assert.equal(slider.handleInput(K.RIGHTARROW), false);
        assert.equal(slider.getValue(), 50);
      });
    });
  });

  void describe('handleClick', () => {
    void test('sets the value from the click position instead of just nudging it', () => {
      withMockWidgetRegistry(({ sounds }) => {
        withScratchCvar('test_menu_slider_click', '0', () => {
          const slider = new Slider({ cvar: 'test_menu_slider_click', min: 0, max: 100 });

          slider.draw(16, 32, false); // bar drawn at the default x + 116 = 132.

          assert.equal(slider.handleClick(132), true); // start of the bar -> min.
          assert.equal(slider.getValue(), 0);

          assert.equal(slider.handleClick(132 + 72), true); // end of the bar -> max.
          assert.equal(slider.getValue(), 100);

          assert.equal(slider.handleClick(132 + 36), true); // midpoint.
          assert.equal(slider.getValue(), 50);

          assert.deepEqual(sounds, ['menu3', 'menu3', 'menu3']);
        });
      });
    });

    void test('clamps clicks outside the bar to min/max instead of the label falling through to a full row click', () => {
      withMockWidgetRegistry(() => {
        withScratchCvar('test_menu_slider_click_clamp', '50', () => {
          const slider = new Slider({ cvar: 'test_menu_slider_click_clamp', min: 0, max: 100 });

          slider.draw(16, 32, false);

          slider.handleClick(0); // well left of the bar, e.g. over the label.
          assert.equal(slider.getValue(), 0);

          slider.handleClick(9999); // well right of the bar.
          assert.equal(slider.getValue(), 100);
        });
      });
    });

    void test('respects valueX from the layout instead of the default offset', () => {
      withMockWidgetRegistry(() => {
        withScratchCvar('test_menu_slider_click_valuex', '0', () => {
          const slider = new Slider({ cvar: 'test_menu_slider_click_valuex', min: 0, max: 100 });

          slider.draw(16, 32, false, 220);

          slider.handleClick(220 + 36);
          assert.equal(slider.getValue(), 50);
        });
      });
    });

    void test('inverts the click-to-value mapping for inverted sliders', () => {
      withMockWidgetRegistry(() => {
        withScratchCvar('test_menu_slider_click_invert', '0.75', () => {
          const slider = new Slider({
            cvar: 'test_menu_slider_click_invert', min: 0.5, max: 1.0, invert: true,
          });

          slider.draw(16, 32, false);

          slider.handleClick(132); // start of the bar -> max for an inverted slider.
          assert.equal(slider.getValue(), 1.0);

          slider.handleClick(132 + 72); // end of the bar -> min.
          assert.equal(slider.getValue(), 0.5);
        });
      });
    });

    void test('does nothing when disabled', () => {
      withMockWidgetRegistry(() => {
        withScratchCvar('test_menu_slider_click_disabled', '50', () => {
          const slider = new Slider({ cvar: 'test_menu_slider_click_disabled', min: 0, max: 100, enabled: false });

          slider.draw(16, 32, false);

          assert.equal(slider.handleClick(132 + 72), false);
          assert.equal(slider.getValue(), 50);
        });
      });
    });
  });
});

void describe('Toggle', () => {
  void test('toggles a bound cvar between onValue/offValue', () => {
    withMockWidgetRegistry(() => {
      withScratchCvar('test_menu_toggle', '0', () => {
        const toggle = new Toggle({ cvar: 'test_menu_toggle' });

        assert.equal(toggle.isOn(), false);
        toggle.handleInput(K.ENTER);
        assert.equal(toggle.isOn(), true);
        assert.equal(Cvar.FindVar('test_menu_toggle').value, 1);

        toggle.handleInput(K.ENTER);
        assert.equal(toggle.isOn(), false);
      });
    });
  });

  void test('supports a custom getValue/setValue pair for non-cvar state (e.g. always-run)', () => {
    withMockWidgetRegistry(() => {
      let forwardspeed = 200;

      const toggle = new Toggle({
        label: 'Always Run',
        getValue: () => (forwardspeed > 200 ? 1 : 0),
        setValue: (value) => { forwardspeed = value ? 400 : 200; },
      });

      assert.equal(toggle.isOn(), false);
      toggle.toggle();
      assert.equal(forwardspeed, 400);
      assert.equal(toggle.isOn(), true);
      toggle.toggle();
      assert.equal(forwardspeed, 200);
    });
  });

  void test('LEFTARROW and RIGHTARROW also toggle (direction is irrelevant for a binary state)', () => {
    withMockWidgetRegistry(() => {
      withScratchCvar('test_menu_toggle_arrows', '0', () => {
        const toggle = new Toggle({ cvar: 'test_menu_toggle_arrows' });

        toggle.handleInput(K.LEFTARROW);
        assert.equal(toggle.isOn(), true);
        toggle.handleInput(K.RIGHTARROW);
        assert.equal(toggle.isOn(), false);
      });
    });
  });
});

void describe('Textbox', () => {
  void test('typing inserts characters at the cursor position, not always at the end', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'ac' });

      textbox.cursorPos = 1;
      textbox.handleInput('b'.charCodeAt(0));

      assert.equal(textbox.getValue(), 'abc');
      assert.equal(textbox.cursorPos, 2);
    });
  });

  void test('Left/Right move the cursor and clamp at the start/end', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'ab' });

      assert.equal(textbox.cursorPos, 2);
      textbox.handleInput(K.RIGHTARROW);
      assert.equal(textbox.cursorPos, 2, 'cannot move past the end');

      textbox.handleInput(K.LEFTARROW);
      textbox.handleInput(K.LEFTARROW);
      textbox.handleInput(K.LEFTARROW);
      assert.equal(textbox.cursorPos, 0, 'cannot move before the start');
    });
  });

  void test('Home/End jump the cursor to the start/end', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'hello' });

      textbox.handleInput(K.HOME);
      assert.equal(textbox.cursorPos, 0);

      textbox.handleInput(K.END);
      assert.equal(textbox.cursorPos, 5);
    });
  });

  void test('Backspace deletes the character before the cursor', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'abc' });

      textbox.cursorPos = 2; // between 'b' and 'c'
      textbox.handleInput(K.BACKSPACE);

      assert.equal(textbox.getValue(), 'ac');
      assert.equal(textbox.cursorPos, 1);
    });
  });

  void test('Backspace at the start of the text is a no-op but still consumes the key', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'abc' });

      textbox.cursorPos = 0;
      const handled = textbox.handleInput(K.BACKSPACE);

      assert.equal(handled, true);
      assert.equal(textbox.getValue(), 'abc');
      assert.equal(textbox.cursorPos, 0);
    });
  });

  void test('Del deletes the character after the cursor and leaves the cursor in place', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'abc' });

      textbox.cursorPos = 1; // between 'a' and 'b'
      textbox.handleInput(K.DEL);

      assert.equal(textbox.getValue(), 'ac');
      assert.equal(textbox.cursorPos, 1);
    });
  });

  void test('Del at the end of the text is a no-op but still consumes the key', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'abc' });

      const handled = textbox.handleInput(K.DEL);

      assert.equal(handled, true);
      assert.equal(textbox.getValue(), 'abc');
    });
  });

  void test('assigning value directly moves the cursor to the end, like a native input', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'ab' });

      textbox.cursorPos = 0;
      textbox.value = 'replaced';

      assert.equal(textbox.cursorPos, 'replaced'.length);
    });
  });

  void test('a validator rejecting the result leaves the value and cursor untouched', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'a', validator: (value) => value.length > 0 });

      textbox.cursorPos = 1;
      const handled = textbox.handleInput(K.BACKSPACE);

      assert.equal(handled, true);
      assert.equal(textbox.getValue(), 'a');
      assert.equal(textbox.cursorPos, 1);
    });
  });

  void test('does not accept input when disabled', () => {
    withMockWidgetRegistry(() => {
      const textbox = new Textbox({ value: 'ab', enabled: false });

      assert.equal(textbox.handleInput('c'.charCodeAt(0)), false);
      assert.equal(textbox.getValue(), 'ab');
    });
  });

  void describe('handlePaste', () => {
    void test('inserts the pasted text at the cursor position', () => {
      withMockWidgetRegistry(() => {
        const textbox = new Textbox({ value: 'ac' });

        textbox.cursorPos = 1;
        const handled = textbox.handlePaste('b');

        assert.equal(handled, true);
        assert.equal(textbox.getValue(), 'abc');
        assert.equal(textbox.cursorPos, 2);
      });
    });

    void test('collapses newlines/tabs to spaces', () => {
      withMockWidgetRegistry(() => {
        const textbox = new Textbox({ value: '', maxLength: 32 });

        textbox.handlePaste('one\r\ntwo\tthree');

        assert.equal(textbox.getValue(), 'one two three');
      });
    });

    void test('truncates pasted text to the remaining room under maxLength', () => {
      withMockWidgetRegistry(() => {
        const textbox = new Textbox({ value: 'ab', maxLength: 5 });

        textbox.handlePaste('xyz123');

        assert.equal(textbox.getValue(), 'abxyz');
        assert.equal(textbox.cursorPos, 5);
      });
    });

    void test('is a no-op when disabled', () => {
      withMockWidgetRegistry(() => {
        const textbox = new Textbox({ value: 'ab', enabled: false });

        assert.equal(textbox.handlePaste('xyz'), false);
        assert.equal(textbox.getValue(), 'ab');
      });
    });
  });
});

void describe('ColorPicker', () => {
  void test('wraps forward past max back to 0', () => {
    withMockWidgetRegistry(() => {
      let value = 13;
      const picker = new ColorPicker({ getValue: () => value, setValue: (v) => { value = v; }, max: 13 });

      picker.handleInput(K.RIGHTARROW);
      assert.equal(value, 0);
    });
  });

  void test('wraps backward past 0 to max', () => {
    withMockWidgetRegistry(() => {
      let value = 0;
      const picker = new ColorPicker({ getValue: () => value, setValue: (v) => { value = v; }, max: 13 });

      picker.handleInput(K.LEFTARROW);
      assert.equal(value, 13);
    });
  });

  void test('ENTER behaves like RIGHTARROW', () => {
    withMockWidgetRegistry(() => {
      let value = 5;
      const picker = new ColorPicker({ getValue: () => value, setValue: (v) => { value = v; }, max: 13 });

      picker.handleInput(K.ENTER);
      assert.equal(value, 6);
    });
  });
});

void describe('SaveSlotItem', () => {
  void test('Enter always invokes onActivate, regardless of slot state', () => {
    withMockWidgetRegistry(() => {
      let activated = 0;
      const item = new SaveSlotItem({ label: 'Empty slot', onActivate: () => { activated += 1; } });

      item.handleInput(K.ENTER);
      assert.equal(activated, 1);
    });
  });

  void test('Del is a no-op unless canDelete is set', () => {
    withMockWidgetRegistry(() => {
      let deleted = 0;
      const item = new SaveSlotItem({ label: 'Empty slot', onDelete: () => { deleted += 1; } });

      item.handleInput(K.DEL);
      assert.equal(deleted, 0);

      item.canDelete = true;
      item.handleInput(K.DEL);
      assert.equal(deleted, 1);
    });
  });

  void test('does nothing when disabled', () => {
    withMockWidgetRegistry(() => {
      let activated = 0;
      const item = new SaveSlotItem({ enabled: false, onActivate: () => { activated += 1; } });

      assert.equal(item.handleInput(K.ENTER), false);
      assert.equal(activated, 0);
    });
  });
});

void describe('KeyBindItem', () => {
  void test('Enter arms capture, and unbinds an existing double-binding first', () => {
    withMockWidgetRegistry(() => {
      const previousBindings = [...Key.bindings];

      try {
        Key.bindings = [];
        Key.bindings[10] = '+jump';
        Key.bindings[11] = '+jump';

        const item = new KeyBindItem({ label: 'jump', command: '+jump' });
        item.handleInput(K.ENTER);

        assert.equal(item.capturing, true);
        assert.equal(Key.bindings[10], undefined);
        assert.equal(Key.bindings[11], undefined);
      } finally {
        Key.bindings = previousBindings;
      }
    });
  });

  void test('the next keypress while capturing binds the command via Cmd.text', () => {
    withMockWidgetRegistry(() => {
      const previousBindings = [...Key.bindings];
      const previousCmdText = Cmd.text;

      try {
        Key.bindings = [];
        Cmd.text = '';

        const item = new KeyBindItem({ label: 'jump', command: '+jump' });
        item.capturing = true;
        item.handleInput(K.SPACE);

        assert.equal(item.capturing, false);
        assert.match(Cmd.text, /^bind "SPACE" "\+jump"\n/);
      } finally {
        Key.bindings = previousBindings;
        Cmd.text = previousCmdText;
      }
    });
  });

  void test('Escape while capturing cancels without binding', () => {
    withMockWidgetRegistry(() => {
      const previousCmdText = Cmd.text;

      try {
        Cmd.text = '';

        const item = new KeyBindItem({ label: 'jump', command: '+jump' });
        item.capturing = true;
        item.handleInput(K.ESCAPE);

        assert.equal(item.capturing, false);
        assert.equal(Cmd.text, '');
      } finally {
        Cmd.text = previousCmdText;
      }
    });
  });

  void test('Backspace/Del clears every binding for the command', () => {
    withMockWidgetRegistry(() => {
      const previousBindings = [...Key.bindings];

      try {
        Key.bindings = [];
        Key.bindings[10] = '+jump';
        Key.bindings[20] = '+jump';
        Key.bindings[30] = '+attack';

        const item = new KeyBindItem({ label: 'jump', command: '+jump' });
        item.handleInput(K.BACKSPACE);

        assert.equal(Key.bindings[10], undefined);
        assert.equal(Key.bindings[20], undefined);
        assert.equal(Key.bindings[30], '+attack');
      } finally {
        Key.bindings = previousBindings;
      }
    });
  });

  void test('draw shows ??? when unbound and the bound key name(s) otherwise', () => {
    withMockWidgetRegistry(({ printed }) => {
      const previousBindings = [...Key.bindings];

      try {
        Key.bindings = [];

        const unbound = new KeyBindItem({ label: 'jump', command: '+jump' });
        unbound.draw(16, 48, false);
        assert.ok(printed.includes('???'));

        printed.length = 0;
        Key.bindings[K.SPACE] = '+jump';
        const bound = new KeyBindItem({ label: 'jump', command: '+jump' });
        bound.draw(16, 48, false);
        assert.ok(printed.some((line) => line.includes('SPACE')));
      } finally {
        Key.bindings = previousBindings;
      }
    });
  });
});
