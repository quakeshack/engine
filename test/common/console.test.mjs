import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Con from '../../source/engine/common/Console.ts';
import { eventBus, registry } from '../../source/engine/registry.mjs';

/**
 * Install minimal registry stubs for Console and fire registry.frozen so
 * the module picks up Host (the only registry member Con needs at print time).
 * @param {{ realtime?: number, developer?: { value: number } }} [hostOverrides]
 * @param {() => void} callback
 */
function withMinimalRegistry(hostOverrides = {}, callback) {
  const previousHost = registry.Host;
  registry.Host = /** @type {any} */ ({
    realtime: 0,
    developer: { value: 0 },
    ...hostOverrides,
  });
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    registry.Host = previousHost;
    eventBus.publish('registry.frozen');
  }
}

/** Reset Con state between tests. */
function resetConState() {
  Con.backscroll = 0;
  Con.current = 0;
  Con.text = [];
  Con.captureBuffer = null;
  Con.forcedup = false;
  Con.vislines = 0;
}

void describe('Con', () => {
  void describe('Print', () => {
    void test('appends text to the current line and advances on newline', () => {
      withMinimalRegistry({ realtime: 1.5 }, () => {
        resetConState();
        try {
          Con.Print('hello\n');
          assert.equal(Con.text.length, 1);
          assert.equal(Con.text[0].text, 'hello');
          assert.equal(Con.text[0].time, 1.5);
          assert.equal(Con.current, 1);
        } finally {
          resetConState();
        }
      });
    });

    void test('handles multiple lines in a single Print call', () => {
      withMinimalRegistry({}, () => {
        resetConState();
        try {
          Con.Print('line1\nline2\nline3\n');
          assert.equal(Con.text.length, 3);
          assert.equal(Con.text[0].text, 'line1');
          assert.equal(Con.text[1].text, 'line2');
          assert.equal(Con.text[2].text, 'line3');
          assert.equal(Con.current, 3);
        } finally {
          resetConState();
        }
      });
    });

    void test('trims buffer when it exceeds 1024 lines', () => {
      withMinimalRegistry({}, () => {
        resetConState();
        try {
          // fill up 1023 lines then add one more to trigger the trim
          for (let i = 0; i < 1024; i++) {
            Con.Print(`line${i}\n`);
          }
          // after crossing 1024, the buffer is sliced to the last 512
          assert.ok(Con.text.length <= 512 + 1, `expected <= 513, got ${Con.text.length}`);
        } finally {
          resetConState();
        }
      });
    });

    void test('legacy color code 3 sets doNotNotify', () => {
      withMinimalRegistry({}, () => {
        resetConState();
        try {
          Con.Print('\x03silent\n');
          assert.equal(Con.text[0].doNotNotify, true);
          assert.equal(Con.text[0].text, 'silent');
        } finally {
          resetConState();
        }
      });
    });
  });

  void describe('DPrint', () => {
    void test('suppresses output when developer is 0', () => {
      withMinimalRegistry({ developer: { value: 0 } }, () => {
        resetConState();
        try {
          Con.DPrint('debug only\n');
          assert.equal(Con.text.length, 0);
        } finally {
          resetConState();
        }
      });
    });

    void test('prints when developer is non-zero', () => {
      withMinimalRegistry({ developer: { value: 1 } }, () => {
        resetConState();
        try {
          Con.DPrint('debug msg\n');
          assert.equal(Con.text.length, 1);
          assert.equal(Con.text[0].text, 'debug msg');
        } finally {
          resetConState();
        }
      });
    });
  });

  void describe('capture', () => {
    void test('captures printed lines between start and stop', () => {
      withMinimalRegistry({}, () => {
        resetConState();
        try {
          Con.StartCapturing();
          Con.Print('captured1\n');
          Con.Print('captured2\n');
          const result = Con.StopCapturing();
          assert.equal(result, 'captured1\ncaptured2\n');
          assert.equal(Con.captureBuffer, null);
        } finally {
          resetConState();
        }
      });
    });
  });

  void describe('Clear_f', () => {
    void test('resets text buffer and scroll position', () => {
      withMinimalRegistry({}, () => {
        resetConState();
        try {
          Con.Print('something\n');
          Con.backscroll = 5;
          Con.Clear_f();
          assert.equal(Con.text.length, 0);
          assert.equal(Con.current, 0);
          assert.equal(Con.backscroll, 0);
        } finally {
          resetConState();
        }
      });
    });
  });

  void describe('ClearNotify', () => {
    void test('zeroes time on the last 4 lines', () => {
      withMinimalRegistry({ realtime: 10 }, () => {
        resetConState();
        try {
          for (let i = 0; i < 6; i++) {
            Con.Print(`line${i}\n`);
          }
          Con.ClearNotify();
          // first two lines should keep their time
          assert.equal(Con.text[0].time, 10);
          assert.equal(Con.text[1].time, 10);
          // last four lines should have time = 0
          assert.equal(Con.text[2].time, 0);
          assert.equal(Con.text[3].time, 0);
          assert.equal(Con.text[4].time, 0);
          assert.equal(Con.text[5].time, 0);
        } finally {
          resetConState();
        }
      });
    });
  });
});
