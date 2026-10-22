import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CorruptedResourceError, HostError, MissingResourceError, NotImplementedError, SysError } from '../../source/engine/common/Errors.ts';

void describe('common errors', () => {
  void test('MissingResourceError stores the resource and optional cause', () => {
    const cause = new Error('network failed');
    const error = new MissingResourceError('gfx/palette.lmp', cause);

    assert.equal(error.name, 'MissingResourceError');
    assert.equal(error.message, "Couldn't load gfx/palette.lmp");
    assert.equal(error.resource, 'gfx/palette.lmp');
    assert.equal(error.error, cause);
  });

  void test('CorruptedResourceError includes the corruption reason', () => {
    const error = new CorruptedResourceError('maps/start.bsp', 'invalid binary magic');

    assert.equal(error.name, 'CorruptedResourceError');
    assert.equal(error.resource, 'maps/start.bsp');
    assert.equal(error.reason, 'invalid binary magic');
    assert.equal(error.message, 'maps/start.bsp is corrupted: invalid binary magic');
  });

  void test('HostError and NotImplementedError preserve their class hierarchy', () => {
    const hostError = new HostError('host failure');
    const notImplementedError = new NotImplementedError('missing override');

    assert.equal(hostError.name, 'HostError');
    assert.equal(notImplementedError.name, 'NotImplementedError');
    assert.equal(notImplementedError instanceof SysError, true);
  });
});
