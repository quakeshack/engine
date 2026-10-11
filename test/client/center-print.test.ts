import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import Host from '../../source/engine/common/Host.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import Draw from '../../source/engine/client/Draw.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import CenterPrint from '../../source/engine/client/screen/CenterPrint.ts';
import VID from '../../source/engine/client/VID.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('CenterPrint', () => {
  let restores: Array<() => void> = [];
  const previousCvars = { centertime: CenterPrint.centertime, printspeed: CenterPrint.printspeed };

  beforeEach(() => {
    CenterPrint.centertime = { value: 2 } as Cvar;
    CenterPrint.printspeed = { value: 8 } as Cvar;
    CenterPrint.lines = [];
    CenterPrint.timeLeft = 0;

    restores = [
      patchMembers(Host, { frametime: 0.1 }),
      patchMembers(VID, { width: 640, height: 480 }),
      patchMembers(clientRuntimeState, { time: 10, intermission: 0 }),
      patchMembers(Key, { destination: KeyDestination.game }),
    ];
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    CenterPrint.centertime = previousCvars.centertime;
    CenterPrint.printspeed = previousCvars.printspeed;
  });

  void describe('Print', () => {
    void test('splits at newlines', () => {
      CenterPrint.Print('first\nsecond');

      assert.deepEqual(CenterPrint.lines, ['first', 'second']);
    });

    void test('wraps a line that is longer than 40 characters at the 40th', () => {
      CenterPrint.Print('a'.repeat(45));

      assert.deepEqual(CenterPrint.lines, ['a'.repeat(40), 'a'.repeat(5)]);
    });

    void test('does not add an empty line when a newline follows exactly 40 characters', () => {
      CenterPrint.Print(`${'a'.repeat(40)}\nb`);

      assert.deepEqual(CenterPrint.lines, ['a'.repeat(40), 'b']);
    });

    void test('keeps the empty line of a trailing newline', () => {
      CenterPrint.Print('abc\n');

      assert.deepEqual(CenterPrint.lines, ['abc', '']);
    });

    void test('starts the display timer and announces the text', () => {
      const published: unknown[][] = [];
      mock.method(eventBus, 'publish', (...args: unknown[]) => { published.push(args); });

      CenterPrint.Print('hello');

      assert.equal(CenterPrint.timeLeft, 2);
      assert.equal(CenterPrint.startTime, 10);
      assert.deepEqual(published, [['client.center-print', 'hello']]);
    });
  });

  void describe('Draw', () => {
    let strings: Array<[number, number, string]> = [];
    let characters: Array<[number, number, number]> = [];

    beforeEach(() => {
      strings = [];
      characters = [];
      mock.method(Draw, 'String', (x: number, y: number, text: string) => { strings.push([x, y, text]); return 0; });
      mock.method(Draw, 'Character', (x: number, y: number, code: number) => { characters.push([x, y, code]); });
    });

    void test('centers each line, 16 pixels per character, at 35 percent of the height for up to 4 lines', () => {
      CenterPrint.Print('hello\nworld!');

      CenterPrint.Draw();

      assert.deepEqual(strings, [
        [(640 - 5 * 16) / 2, Math.floor(480 * 0.35), 'hello'],
        [(640 - 6 * 16) / 2, Math.floor(480 * 0.35) + 16, 'world!'],
      ]);
    });

    void test('starts at the top for more than 4 lines', () => {
      CenterPrint.Print('1\n2\n3\n4\n5');

      CenterPrint.Draw();

      assert.equal(strings[0][1], 48);
    });

    void test('counts the display time down by the frame time and stops at zero', () => {
      CenterPrint.Print('hello');
      CenterPrint.timeLeft = 0.15;

      CenterPrint.Draw();
      assert.equal(strings.length, 1);

      strings.length = 0;
      CenterPrint.Draw();
      assert.equal(strings.length, 0);
    });

    void test('draws nothing while a menu has the keyboard', () => {
      CenterPrint.Print('hello');
      Key.destination = KeyDestination.menu;

      CenterPrint.Draw();

      assert.equal(strings.length, 0);
    });

    void test('types the text out at scr_printspeed characters per second in an intermission', () => {
      clientRuntimeState.intermission = 1;
      CenterPrint.Print('hello');
      // 8 characters per second for 0.25 s: a count of 2. The check that ends the typing comes after a character
      // is drawn, so the count is reached one character late.
      clientRuntimeState.time = 10.25;

      CenterPrint.Draw();

      assert.equal(strings.length, 0);
      assert.equal(characters.map(([, , code]) => String.fromCharCode(code)).join(''), 'hel');
    });

    void test('keeps the intermission text up regardless of the display timer', () => {
      clientRuntimeState.intermission = 1;
      CenterPrint.Print('hello');
      CenterPrint.timeLeft = -5;
      clientRuntimeState.time = 20;

      CenterPrint.Draw();

      assert.equal(characters.length, 5);
    });
  });
});
