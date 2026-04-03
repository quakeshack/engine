import test from 'node:test';
import assert from 'node:assert/strict';

import BaseCom from '../../source/engine/common/Com.ts';
import BaseSys from '../../source/engine/common/Sys.ts';
import ComMjs from '../../source/engine/server/Com.mjs';
import ComTs from '../../source/engine/server/Com.ts';
import SysMjs from '../../source/engine/server/Sys.mjs';
import SysTs from '../../source/engine/server/Sys.ts';

void test('server Com shim re-exports the TypeScript implementation', () => {
  assert.strictEqual(ComMjs, ComTs);
});

void test('server Sys shim re-exports the TypeScript implementation', () => {
  assert.strictEqual(SysMjs, SysTs);
});

void test('server Com inherits the common COM base class', () => {
  assert.strictEqual(Object.getPrototypeOf(ComTs), BaseCom);
});

void test('server Sys inherits the common Sys base class', () => {
  assert.strictEqual(Object.getPrototypeOf(SysTs), BaseSys);
});
