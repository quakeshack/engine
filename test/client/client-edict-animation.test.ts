import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';

void describe('ClientEdict animation clock', () => {
  let previousTime = 0;

  beforeEach(() => {
    previousTime = clientRuntimeState.time;
    clientRuntimeState.time = 10;
  });

  afterEach(() => {
    clientRuntimeState.time = previousTime;
  });

  void test('stamps the time when the model changes', () => {
    const entity = new ClientEdict(-1);
    const model = new BaseModel('sprites/a.spr');

    entity.model = model;

    assert.equal(entity.model, model);
    assert.equal(entity.animationStartTime, 10);
  });

  void test('keeps the start time when the same model is set again', () => {
    const entity = new ClientEdict(-1);
    const model = new BaseModel('sprites/a.spr');
    entity.model = model;

    clientRuntimeState.time = 12;
    entity.model = model;

    assert.equal(entity.animationStartTime, 10);
  });

  void test('stamps the time when the frame changes', () => {
    const entity = new ClientEdict(-1);

    entity.frame = 3;

    assert.equal(entity.frame, 3);
    assert.equal(entity.animationStartTime, 10);
  });

  void test('keeps a running sequence going when the server repeats the frame', () => {
    const entity = new ClientEdict(-1);
    entity.frame = 3;

    clientRuntimeState.time = 15;
    entity.frame = 3;

    assert.equal(entity.animationStartTime, 10);
  });

  void test('a new entity has not started anything', () => {
    const entity = new ClientEdict(-1);

    assert.equal(entity.model, null);
    assert.equal(entity.frame, 0);
    assert.equal(entity.animationStartTime, 0);
  });

  void test('freeing the edict restarts the clock for what it shows next', () => {
    const entity = new ClientEdict(-1);
    entity.model = new BaseModel('sprites/a.spr');
    entity.frame = 2;

    clientRuntimeState.time = 20;
    entity.freeEdict();

    assert.equal(entity.model, null);
    assert.equal(entity.frame, 0);
    assert.equal(entity.animationStartTime, 20);
  });
});
