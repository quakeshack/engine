import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { Console } from '../../source/engine/common/Console.ts';
import type { ConsoleCapture, ConsoleOutput } from '../../source/engine/common/Services.ts';

/**
 * Builds a console of its own with a clock and developer switch the test controls.
 * @param options What to replace.
 * @param options.realtime The time lines are stamped with.
 * @param options.developer Whether `developer` is on.
 * @returns The console.
 */
function createConsole({ realtime = 0, developer = false } = {}): Console {
  const con = new Console();

  con.Init({ clock: () => realtime, developer: () => developer });
  con.Clear();

  return con;
}

void describe('Console', () => {
  void describe('Print', () => {
    void test('appends text to the current line and advances on newline', () => {
      const con = createConsole({ realtime: 1.5 });

      con.Print('hello\n');

      assert.equal(con.text.length, 1);
      assert.equal(con.text[0].text, 'hello');
      assert.equal(con.text[0].time, 1.5);
      assert.equal(con.current, 1);
    });

    void test('handles multiple lines in a single Print call', () => {
      const con = createConsole();

      con.Print('line1\nline2\nline3\n');

      assert.deepEqual(con.text.map((line) => line.text), ['line1', 'line2', 'line3']);
      assert.equal(con.current, 3);
    });

    void test('trims buffer when it exceeds 1024 lines', () => {
      const con = createConsole();

      for (let i = 0; i < 1024; i++) {
        con.Print(`line${i}\n`);
      }

      // after crossing 1024, the buffer is sliced to the last 512
      assert.ok(con.text.length <= 512 + 1, `expected <= 513, got ${con.text.length}`);
    });

    void test('legacy color code 3 sets doNotNotify', () => {
      const con = createConsole();

      con.Print('\x03silent\n');

      assert.equal(con.text[0].doNotNotify, true);
      assert.equal(con.text[0].text, 'silent');
    });

    void test('works before it was initialized, stamping lines with time 0', () => {
      const con = new Console();

      con.Print('early\n');

      assert.equal(con.text[0].time, 0);
    });

    void test('resets the scroll position', () => {
      const con = createConsole();

      con.backscroll = 5;
      con.Print('new line\n');

      assert.equal(con.backscroll, 0);
    });
  });

  void describe('DPrint', () => {
    void test('suppresses output when developer is off', () => {
      const con = createConsole({ developer: false });

      con.DPrint('debug only\n');

      assert.equal(con.text.length, 0);
    });

    void test('prints when developer is on', () => {
      const con = createConsole({ developer: true });

      con.DPrint('debug msg\n');

      assert.equal(con.text.length, 1);
      assert.equal(con.text[0].text, 'debug msg');
    });
  });

  void describe('capture', () => {
    void test('captures printed lines between start and stop', () => {
      const con = createConsole();

      con.StartCapturing();
      con.Print('captured1\n');
      con.Print('captured2\n');

      assert.equal(con.StopCapturing(), 'captured1\ncaptured2\n');
      assert.equal(con.captureBuffer, null);
    });
  });

  void describe('Clear', () => {
    void test('resets text buffer and scroll position', () => {
      const con = createConsole();

      con.Print('something\n');
      con.backscroll = 5;
      con.Clear();

      assert.equal(con.text.length, 0);
      assert.equal(con.current, 0);
      assert.equal(con.backscroll, 0);
    });
  });

  void describe('ClearNotify', () => {
    void test('zeroes time on the last 4 lines', () => {
      const con = createConsole({ realtime: 10 });

      for (let i = 0; i < 6; i++) {
        con.Print(`line${i}\n`);
      }

      con.ClearNotify();

      // first two lines should keep their time, the last four are old
      assert.deepEqual(con.text.map((line) => line.time), [10, 10, 0, 0, 0, 0]);
    });
  });

  void describe('delegate', () => {
    interface Call { readonly method: string; readonly text?: string; readonly color?: unknown }

    /**
     * Builds a console that records what it is asked to print.
     * @returns The console and the recorded calls.
     */
    function createRecordingDelegate(): { delegate: ConsoleOutput & ConsoleCapture; calls: Call[] } {
      const calls: Call[] = [];
      const record = (method: string) => (text: string, color?: unknown) => { calls.push({ method, text, color }); };

      return {
        calls,
        delegate: {
          Print: record('Print'),
          DPrint: record('DPrint'),
          PrintWarning: record('PrintWarning'),
          PrintError: record('PrintError'),
          PrintSuccess: record('PrintSuccess'),
          StartCapturing: () => { calls.push({ method: 'StartCapturing' }); },
          StopCapturing: () => { calls.push({ method: 'StopCapturing' }); return 'captured'; },
        },
      };
    }

    void test('hands every kind of output over and keeps the text buffer empty', () => {
      const con = createConsole({ developer: true });
      const { delegate, calls } = createRecordingDelegate();

      con.useDelegate(delegate);
      con.Print('a');
      con.PrintSuccess('b');
      con.PrintWarning('c');
      con.PrintError('d');
      con.DPrint('e');

      assert.deepEqual(calls, [
        { method: 'Print', text: 'a', color: undefined },
        { method: 'PrintSuccess', text: 'b', color: undefined },
        { method: 'PrintWarning', text: 'c', color: undefined },
        { method: 'PrintError', text: 'd', color: undefined },
        { method: 'DPrint', text: 'e', color: undefined },
      ]);
      assert.equal(con.text.length, 0);
    });

    void test('hands the color of a line along, and none when there is none', () => {
      const con = createConsole();
      const { delegate, calls } = createRecordingDelegate();
      const red = new Vector(1, 0, 0);

      con.useDelegate(delegate);
      con.Print('plain');
      con.Print('red', red);

      assert.equal(calls[0].color, undefined);
      assert.equal(calls[1].color, red);
    });

    void test('lets the delegate capture', () => {
      const con = createConsole();
      const { delegate, calls } = createRecordingDelegate();

      con.useDelegate(delegate);
      con.StartCapturing();

      assert.equal(con.StopCapturing(), 'captured');
      assert.deepEqual(calls.map((call) => call.method), ['StartCapturing', 'StopCapturing']);
    });

    void test('prints to the text buffer again once the delegate is removed', () => {
      const con = createConsole();
      const { delegate } = createRecordingDelegate();

      con.useDelegate(delegate);
      con.useDelegate(null);
      con.Print('back\n');

      assert.equal(con.text[0].text, 'back');
    });
  });
});
