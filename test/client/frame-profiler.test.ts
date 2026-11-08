import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Sys from '../../source/engine/client/Sys.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import FrameProfiler, { type ProfileSection } from '../../source/engine/client/FrameProfiler.ts';
import { assertNear } from '../support/assertions.ts';
import { createMutableCvarStub } from '../support/cvarStub.ts';
import { patchMembers } from '../support/clientState.ts';

/** A timer query of the fake context, with the result a test gives it. */
interface FakeQuery {
  readonly id: number;
  available: boolean;
  nanoseconds: number;
}

/**
 * Just the timer query part of a WebGL2 context: it records the queries in the order they began and fails a test
 * that begins one while another is running, which a real context rejects with INVALID_OPERATION.
 */
class FakeTimerContext {
  readonly QUERY_RESULT = 0x8866;
  readonly QUERY_RESULT_AVAILABLE = 0x8867;
  readonly issued: FakeQuery[] = [];
  readonly deleted = new Set<number>();
  open: FakeQuery | null = null;
  disjoint = false;
  finishes = 0;
  #nextId = 0;

  /** Queries that began and have no result yet, in the order they began; a recycled query is in it once per use. */
  #waiting: FakeQuery[] = [];

  getExtension(_name: string): { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } {
    return { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  }

  createQuery(): FakeQuery {
    return { id: this.#nextId++, available: false, nanoseconds: 0 };
  }

  beginQuery(_target: number, query: FakeQuery): void {
    assert.equal(this.open, null, 'a timer query began while another one was running');
    query.available = false;
    this.open = query;
    this.issued.push(query);
    this.#waiting.push(query);
  }

  endQuery(_target: number): void {
    assert.notEqual(this.open, null, 'a timer query ended without one running');
    this.open = null;
  }

  getQueryParameter(query: FakeQuery, parameter: number): boolean | number {
    return parameter === this.QUERY_RESULT_AVAILABLE ? query.available : query.nanoseconds;
  }

  getParameter(_parameter: number): boolean {
    return this.disjoint;
  }

  deleteQuery(query: FakeQuery): void {
    this.deleted.add(query.id);
  }

  finish(): void {
    this.finishes++;
  }

  /**
   * Makes the results of queries that ended available.
   * @param milliseconds GPU time of each waiting query, in the order the queries began; `null` leaves one waiting.
   */
  answer(...milliseconds: Array<number | null>): void {
    const ended = this.#waiting.filter((query) => query !== this.open);

    for (let i = 0; i < milliseconds.length; i++) {
      const value = milliseconds[i];

      if (value !== null) {
        ended[i].available = true;
        ended[i].nanoseconds = value * 1e6;
      }
    }

    this.#waiting = this.#waiting.filter((query) => !query.available);
  }
}

/**
 * The section of that path below the root.
 * @param names The names from the outermost section in.
 * @returns The section, failing the test when it was never opened.
 */
function sectionAt(...names: string[]): ProfileSection {
  let section = FrameProfiler.root;

  for (const name of names) {
    const child = section.children.get(name);
    assert.ok(child !== undefined, `no section ${names.join(' > ')}`);
    section = child;
  }

  return section;
}

void describe('FrameProfiler', () => {
  let context: FakeTimerContext = null!;
  let now = 0;
  let restoreCvars: () => void = null!;

  /**
   * Moves the clock on.
   * @param milliseconds How far.
   */
  function advance(milliseconds: number): void {
    now += milliseconds;
  }

  /** Ends the half second window: the next beginFrame summarizes it. */
  function closeWindow(): void {
    now = Math.max(now, 500);
    FrameProfiler.beginFrame();
    FrameProfiler.endFrame();
  }

  beforeEach(() => {
    now = 0;
    context = new FakeTimerContext();
    restoreCvars = patchMembers(rendererCvars, { speeds: createMutableCvarStub(1) });
    mock.method(Sys, 'FloatMilliTime', () => now);
    FrameProfiler.attach(context as unknown as WebGL2RenderingContext);
  });

  afterEach(() => {
    rendererCvars.speeds.set(0);
    FrameProfiler.beginFrame();
    FrameProfiler.detach();
    mock.restoreAll();
    restoreCvars();
  });

  void describe('CPU time', () => {
    void test('charges a section its own time, the time of the sections inside it left out', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();

      // host 0..5 with sound 1..4: the host itself took 2 ms, the sound 3 ms
      FrameProfiler.begin('host');
      advance(1);
      FrameProfiler.begin('sound');
      advance(3);
      FrameProfiler.end();
      advance(1);
      FrameProfiler.end();

      closeWindow();

      assertNear(sectionAt('host').shownCpuMs, 2);
      assertNear(sectionAt('host', 'sound').shownCpuMs, 3);
    });

    void test('averages per drawn frame, so host frames between two draws add up', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();

      // two host frames of 3 ms, then a second drawn frame: 6 ms over 2 drawn frames
      for (let i = 0; i < 2; i++) {
        FrameProfiler.begin('host');
        advance(3);
        FrameProfiler.end();
      }

      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();
      closeWindow();

      assertNear(sectionAt('host').shownCpuMs, 3);
      assertNear(sectionAt('host').shownCalls, 1);
    });

    void test('keeps the worst frame of the window apart from the average, so a hitch shows as one', () => {
      // four drawn frames, the sound takes 1 ms in three of them and 37 ms in one: 10 ms on average
      for (const milliseconds of [1, 37, 1, 1]) {
        FrameProfiler.beginFrame();
        FrameProfiler.endFrame();
        FrameProfiler.begin('sound');
        advance(milliseconds);
        FrameProfiler.end();
      }

      closeWindow();

      assertNear(sectionAt('sound').shownCpuMs, 10);
      assertNear(sectionAt('sound').shownMaxCpuMs, 37);

      // the next window starts over
      now += 500;
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();

      assertNear(sectionAt('sound').shownMaxCpuMs, 0);
    });

    void test('leaves a section that did not run in the window out of the lines', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.begin('bloom');
      FrameProfiler.end();
      FrameProfiler.endFrame();
      closeWindow();

      assert.ok(FrameProfiler.lines.some((line) => line.trim().startsWith('bloom')));

      now = 1000;
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();

      assert.ok(!FrameProfiler.lines.some((line) => line.trim().startsWith('bloom')));
    });
  });

  void describe('GPU time', () => {
    void test('ends the outer query while an inner section runs and resumes it after, charging each its own work', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.begin('scene');
      FrameProfiler.end();
      FrameProfiler.endFrame();

      // draw, scene, draw again
      assert.equal(context.issued.length, 3);
      assert.equal(context.open, null);

      context.answer(1, 4, 2);
      closeWindow();

      assertNear(sectionAt('draw').shownGpuMs, 3);
      assertNear(sectionAt('draw', 'scene').shownGpuMs, 4);
    });

    void test('issues no queries for sections outside the drawn frame', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();
      const issued = context.issued.length;

      FrameProfiler.begin('host');
      FrameProfiler.end();

      assert.equal(context.issued.length, issued);
    });

    void test('keeps a result that is not ready and the ones after it for a later window, in order', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.begin('scene');
      FrameProfiler.end();
      FrameProfiler.endFrame();

      // the scene's query is late; the draw's second one is ready but must not be read out of order
      context.answer(1, null, 2);
      closeWindow();

      assertNear(sectionAt('draw').shownGpuMs, 1);
      assertNear(sectionAt('draw', 'scene').shownGpuMs, 0);

      // the late scene query, then the one of the frame that closed the first window
      context.answer(4, 2);
      now = 1000;
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();

      // one drawn frame in the second window: the draw gets the 2 ms that waited behind the scene and 2 ms of its own
      assertNear(sectionAt('draw', 'scene').shownGpuMs, 4);
      assertNear(sectionAt('draw').shownGpuMs, 4);
    });

    void test('throws results away when the GPU reports a disjoint operation', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();

      context.answer(5);
      context.disjoint = true;
      closeWindow();

      assertNear(sectionAt('draw').shownGpuMs, 0);
    });
  });

  void describe('r_speeds', () => {
    void test('measures nothing while it is 0', () => {
      rendererCvars.speeds.set(0);
      FrameProfiler.beginFrame();
      FrameProfiler.begin('scene');
      FrameProfiler.end();
      FrameProfiler.endFrame();

      assert.equal(context.issued.length, 0);
      // sections of earlier tests stay until measuring starts again; none was added
      assert.equal(FrameProfiler.root.children.has('scene'), false);
    });

    void test('deletes every query, pending or answered, when it is switched off', () => {
      FrameProfiler.beginFrame();
      FrameProfiler.begin('scene');
      FrameProfiler.end();
      FrameProfiler.endFrame();
      context.answer(1);
      FrameProfiler.beginFrame();
      FrameProfiler.endFrame();

      rendererCvars.speeds.set(0);
      FrameProfiler.beginFrame();

      assert.equal(context.open, null);
      assert.deepEqual([...context.deleted].sort(), [...new Set(context.issued.map((query) => query.id))].sort());
    });

    void test('2 waits for the GPU at the borders of drawn sections only', () => {
      rendererCvars.speeds.set(2);
      FrameProfiler.beginFrame();
      FrameProfiler.begin('scene');
      FrameProfiler.end();
      FrameProfiler.endFrame();

      // draw and scene, each at begin and end
      assert.equal(context.finishes, 4);

      FrameProfiler.begin('host');
      FrameProfiler.end();

      assert.equal(context.finishes, 4);
    });
  });
});
