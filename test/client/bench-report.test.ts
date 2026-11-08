import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import BenchReport, { type BenchResult } from '../../source/engine/client/BenchReport.ts';

/**
 * A result with what the tests look at; the rest is zero.
 * @param label The variant.
 * @param overrides The numbers that matter to the test.
 * @returns The result.
 */
function result(label: string, overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    label,
    frameMs: 0,
    maxFrameMs: 0,
    cpuMs: 0,
    gpuMs: 0,
    hasGpu: true,
    sectionGpuMs: [],
    ownGpuMs: new Map(),
    gpuSpreadMs: 0,
    ...overrides,
  };
}

void describe('BenchReport', () => {
  void describe('combine', () => {
    void test('merges the rounds of a variant into the mean, the worst frame of all and the spread', () => {
      const round = (label: string, gpuMs: number, maxFrameMs: number, world: number): BenchResult => result(label, {
        gpuMs, maxFrameMs, sectionGpuMs: [world], ownGpuMs: new Map([['scene > world', world]]),
      });

      const [merged, other] = BenchReport.combine([round('as set', 12, 20, 5), round('off', 10, 15, 4), round('as set', 14, 40, 7)]);

      assert.equal(merged.label, 'as set');
      assert.equal(merged.gpuMs, 13);
      assert.equal(merged.gpuSpreadMs, 2);
      assert.equal(merged.maxFrameMs, 40);
      assert.deepEqual(merged.sectionGpuMs, [6]);
      assert.equal(merged.ownGpuMs.get('scene > world'), 6);
      assert.equal(other.label, 'off');
      assert.equal(other.gpuSpreadMs, 0);
    });

    void test('counts a section that ran in only one round as 0 in the others', () => {
      const [merged] = BenchReport.combine([
        result('as set', { ownGpuMs: new Map([['transparent > particles', 0.6]]) }),
        result('as set'),
      ]);

      assert.equal(merged.ownGpuMs.get('transparent > particles'), 0.3);
    });
  });

  void describe('biggestChanges', () => {
    void test('lists the largest differences either way, including a section only one side ran', () => {
      const base = result('as set', { ownGpuMs: new Map(Object.entries({ 'scene > world': 5, 'transparent > refracting surfaces': 0.8, 'scene > sky': 1.3 })) });
      const off = result('r_refraction 0', { ownGpuMs: new Map(Object.entries({ 'scene > world': 5.05, 'transparent > world surfaces': 2.2, 'scene > sky': 1.3 })) });

      assert.deepEqual(BenchReport.biggestChanges(base, off), [
        'transparent > world surfaces +2.20',
        'transparent > refracting surfaces -0.80',
        'scene > world +0.05',
      ]);
    });
  });

  void describe('lines', () => {
    void test('says that only frame times were measured when the browser has no GPU timer', () => {
      const lines = BenchReport.lines([result('as set', { hasGpu: false }), result('r_bloom 0', { hasGpu: false })]);

      assert.equal(lines.at(-1), 'r_bench: this browser has no GPU timer queries, only the frame times are measured');
      assert.ok(!lines.some((line) => line.includes('changed most')));
    });
  });
});
