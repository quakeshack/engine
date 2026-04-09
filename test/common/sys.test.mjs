import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Sys, { BaseWorker } from '../../source/engine/common/Sys.ts';

void describe('Sys (base class)', () => {
  void test('all static methods throw NotImplementedError', () => {
    assert.throws(() => Sys.Print('test'), { name: 'NotImplementedError' });
    assert.throws(() => Sys.Quit(), { name: 'NotImplementedError' });
    assert.throws(() => Sys.FloatTime(), { name: 'NotImplementedError' });
    assert.throws(() => Sys.FloatMilliTime(), { name: 'NotImplementedError' });
  });

  void test('Init rejects with NotImplementedError', async () => {
    await assert.rejects(() => Sys.Init(), { name: 'NotImplementedError' });
  });
});

void describe('BaseWorker', () => {
  void test('abstract methods throw NotImplementedError', () => {
    const worker = new BaseWorker('test-worker');
    assert.equal(worker.name, 'test-worker');
    assert.throws(() => worker.addOnMessageListener(() => {}), { name: 'NotImplementedError' });
    assert.throws(() => worker.postMessage({}), { name: 'NotImplementedError' });
  });

  void test('shutdown rejects with NotImplementedError', async () => {
    const worker = new BaseWorker('test-worker');
    await assert.rejects(() => worker.shutdown(), { name: 'NotImplementedError' });
  });

  void test('addOnShutdownListener accumulates listeners', () => {
    const worker = new BaseWorker('test-worker');
    const fn1 = () => {};
    const fn2 = () => {};
    worker.addOnShutdownListener(fn1);
    worker.addOnShutdownListener(fn2);
    assert.equal(worker._shutdownListeners.length, 2);
  });
});
