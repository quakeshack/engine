import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import { LineEditor } from '../../source/shared/LineEditor.ts';

void describe('LineEditor', () => {
  void test('starts with the cursor at the end of the initial text', () => {
    const editor = new LineEditor('abc');

    assert.equal(editor.text, 'abc');
    assert.equal(editor.cursorPos, 3);
  });

  void test('assigning text directly moves the cursor to the end', () => {
    const editor = new LineEditor('abc');

    editor.cursorPos = 0;
    editor.text = 'replaced';

    assert.equal(editor.cursorPos, 'replaced'.length);
  });

  void test('cursorPos is clamped to [0, text.length]', () => {
    const editor = new LineEditor('ab');

    editor.cursorPos = 99;
    assert.equal(editor.cursorPos, 2);

    editor.cursorPos = -99;
    assert.equal(editor.cursorPos, 0);
  });

  void describe('insertChar', () => {
    void test('inserts at the cursor position, not always at the end', () => {
      const editor = new LineEditor('ac');

      editor.cursorPos = 1;
      editor.insertChar('b');

      assert.equal(editor.text, 'abc');
      assert.equal(editor.cursorPos, 2);
    });

    void test('is a no-op once the text reaches maxLength', () => {
      const editor = new LineEditor('ab', { maxLength: 2 });

      editor.insertChar('c');

      assert.equal(editor.text, 'ab');
      assert.equal(editor.cursorPos, 2);
    });
  });

  void describe('backspace/deleteForward', () => {
    void test('backspace deletes the character before the cursor', () => {
      const editor = new LineEditor('abc');

      editor.cursorPos = 2;
      editor.backspace();

      assert.equal(editor.text, 'ac');
      assert.equal(editor.cursorPos, 1);
    });

    void test('backspace at the start of the text is a no-op', () => {
      const editor = new LineEditor('abc');

      editor.cursorPos = 0;
      editor.backspace();

      assert.equal(editor.text, 'abc');
      assert.equal(editor.cursorPos, 0);
    });

    void test('deleteForward deletes the character after the cursor and leaves the cursor in place', () => {
      const editor = new LineEditor('abc');

      editor.cursorPos = 1;
      editor.deleteForward();

      assert.equal(editor.text, 'ac');
      assert.equal(editor.cursorPos, 1);
    });

    void test('deleteForward at the end of the text is a no-op', () => {
      const editor = new LineEditor('abc');

      editor.deleteForward();

      assert.equal(editor.text, 'abc');
    });
  });

  void test('a validator rejecting the result leaves the text and cursor untouched', () => {
    const editor = new LineEditor('a', { validator: (value) => value.length > 0 });

    editor.backspace();

    assert.equal(editor.text, 'a');
    assert.equal(editor.cursorPos, 1);
  });

  void describe('paste', () => {
    void test('inserts text at the cursor position', () => {
      const editor = new LineEditor('ac');

      editor.cursorPos = 1;
      editor.paste('b');

      assert.equal(editor.text, 'abc');
      assert.equal(editor.cursorPos, 2);
    });

    void test('collapses newlines/tabs to spaces', () => {
      const editor = new LineEditor('');

      editor.paste('one\r\ntwo\tthree');

      assert.equal(editor.text, 'one two three');
    });

    void test('truncates to the remaining room under maxLength', () => {
      const editor = new LineEditor('ab', { maxLength: 5 });

      editor.paste('xyz123');

      assert.equal(editor.text, 'abxyz');
      assert.equal(editor.cursorPos, 5);
    });

    void test('is a no-op when there is no room left', () => {
      const editor = new LineEditor('abc', { maxLength: 3 });

      editor.paste('xyz');

      assert.equal(editor.text, 'abc');
    });
  });

  void describe('handleKey', () => {
    void test('Left/Right move the cursor and clamp at the start/end', () => {
      const editor = new LineEditor('ab');

      assert.equal(editor.handleKey(K.RIGHTARROW), true);
      assert.equal(editor.cursorPos, 2, 'cannot move past the end');

      editor.handleKey(K.LEFTARROW);
      editor.handleKey(K.LEFTARROW);
      editor.handleKey(K.LEFTARROW);
      assert.equal(editor.cursorPos, 0, 'cannot move before the start');
    });

    void test('Home/End jump the cursor to the start/end', () => {
      const editor = new LineEditor('hello');

      editor.handleKey(K.HOME);
      assert.equal(editor.cursorPos, 0);

      editor.handleKey(K.END);
      assert.equal(editor.cursorPos, 5);
    });

    void test('Backspace/Del route to the matching methods', () => {
      const editor = new LineEditor('abc');

      editor.cursorPos = 1;
      editor.handleKey(K.DEL);
      assert.equal(editor.text, 'ac');

      editor.handleKey(K.BACKSPACE);
      assert.equal(editor.text, 'c');
    });

    void test('printable characters are inserted', () => {
      const editor = new LineEditor('');

      editor.handleKey('x'.charCodeAt(0));

      assert.equal(editor.text, 'x');
    });

    void test('returns false for keys it does not recognize', () => {
      const editor = new LineEditor('');

      assert.equal(editor.handleKey(K.F1), false);
    });
  });

  void describe('cursorGlyph', () => {
    void test('at the end of the text, alternates between the two end glyphs', () => {
      const editor = new LineEditor('ab');

      assert.equal(editor.cursorGlyph(0, [10, 11], 127), 10);
      assert.equal(editor.cursorGlyph(1, [10, 11], 127), 11);
      assert.equal(editor.cursorGlyph(2, [10, 11], 127), 10, 'phase parity wraps around');
    });

    void test('mid-line, alternates between the insert glyph and null (reveal the character)', () => {
      const editor = new LineEditor('abc');
      editor.cursorPos = 1;

      assert.equal(editor.cursorGlyph(0, [10, 11], 127), 127);
      assert.equal(editor.cursorGlyph(1, [10, 11], 127), null);
    });
  });

  void describe('withCursorGlyph', () => {
    void test('at the end of the text, appends the end glyph for the current phase', () => {
      const editor = new LineEditor('ab');

      assert.equal(editor.withCursorGlyph(0, [10, 11], 127), `ab${String.fromCharCode(10)}`);
      assert.equal(editor.withCursorGlyph(1, [10, 11], 127), `ab${String.fromCharCode(11)}`);
    });

    void test('mid-line, replaces the character under the cursor on the "on" phase', () => {
      const editor = new LineEditor('abc');
      editor.cursorPos = 1;

      assert.equal(editor.withCursorGlyph(0, [10, 11], 127), `a${String.fromCharCode(127)}c`);
    });

    void test('mid-line, reveals the unmodified text on the "off" phase', () => {
      const editor = new LineEditor('abc');
      editor.cursorPos = 1;

      assert.equal(editor.withCursorGlyph(1, [10, 11], 127), 'abc');
    });
  });
});
