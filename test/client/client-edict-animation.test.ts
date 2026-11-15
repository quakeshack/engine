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
    assert.equal(entity.animtime, 10);
  });

  void test('keeps the start time when the same model is set again', () => {
    const entity = new ClientEdict(-1);
    const model = new BaseModel('sprites/a.spr');
    entity.model = model;

    clientRuntimeState.time = 12;
    entity.model = model;

    assert.equal(entity.animtime, 10);
  });

  void test('stamps the time when another sequence is selected', () => {
    const entity = new ClientEdict(-1);

    entity.sequence = 3;

    assert.equal(entity.sequence, 3);
    assert.equal(entity.animtime, 10);
  });

  void test('keeps a running sequence going when the same one is selected again, as the server does with every update', () => {
    const entity = new ClientEdict(-1);
    entity.sequence = 3;

    clientRuntimeState.time = 15;
    entity.sequence = 3;

    assert.equal(entity.animtime, 10);
  });

  void test('a new frame restarts nothing, it is no longer what picks a sequence', () => {
    // Before the sequence state, `frame` selected an image sprite's sequence and restarted it.
    const entity = new ClientEdict(-1);

    entity.frame = 3;

    assert.equal(entity.frame, 3);
    assert.equal(entity.animtime, 0);
  });

  void test('an entity of the server stamps as well, which is all a game needs that never sets an animtime', () => {
    // A sprite that plays once from the moment the game gives it a model, in a game that knows nothing of animtime:
    // the server sends no start time for it, and the client's stamp is what the sprite starts from.
    const entity = new ClientEdict(5);

    entity.model = new BaseModel('sprites/a.spr');
    entity.sequence = 2;

    assert.equal(entity.animtime, 10);
  });

  void test('the start time of a game that sets one replaces the stamp, when the server\'s update brings it after the change', () => {
    const entity = new ClientEdict(5);

    entity.sequence = 2;
    entity.animtime = 4.25;

    assert.equal(entity.animtime, 4.25);
  });

  void test('a new entity plays nothing: no sequence, started at 0, at the speed the model gives it', () => {
    const entity = new ClientEdict(-1);

    assert.equal(entity.model, null);
    assert.equal(entity.frame, 0);
    assert.equal(entity.sequence, -1);
    assert.equal(entity.animtime, 0);
    assert.equal(entity.framerate, 1);
  });

  void test('freeing the edict leaves nothing of the sequence for what it shows next', () => {
    const entity = new ClientEdict(-1);
    entity.model = new BaseModel('sprites/a.spr');
    entity.frame = 2;
    entity.sequence = 4;
    entity.framerate = 2.5;

    clientRuntimeState.time = 20;
    entity.freeEdict();

    assert.equal(entity.model, null);
    assert.equal(entity.frame, 0);
    assert.equal(entity.sequence, -1);
    assert.equal(entity.animtime, 0);
    assert.equal(entity.framerate, 1);
  });
});
