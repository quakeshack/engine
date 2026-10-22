import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as services from '../../source/engine/client/PageServices.ts';
import type COM from '../../source/engine/common/Com.ts';
import type NET from '../../source/engine/network/Network.ts';
import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { GameFlavors } from '../../source/engine/common/GameApiSupport.ts';
import W from '../../source/engine/common/W.ts';

void describe('PageServices', () => {
  void test('is empty until the composition root installs something', () => {
    assert.equal(services.urls, null);
    assert.equal(services.buildConfig, null);
  });

  void test('installs only what it is given and keeps the rest', () => {
    const com = { name: 'com' } as unknown as COM;
    const net = { name: 'net' } as unknown as NET;
    const restore = services.installPageServices({ com });

    try {
      assert.equal(services.com, com);
      assert.equal(services.net, null);

      const restoreNet = services.installPageServices({ net });

      assert.equal(services.com, com, 'installing the network does not drop the file system');
      assert.equal(services.net, net);
      restoreNet();
      assert.equal(services.net, null);
    } finally {
      restore();
    }

    assert.equal(services.com, null);
  });

  void test('puts back what was installed before when restored', () => {
    const first = { name: 'first' } as unknown as COM;
    const second = { name: 'second' } as unknown as COM;
    const restoreFirst = services.installPageServices({ com: first });
    const restoreSecond = services.installPageServices({ com: second });

    assert.equal(services.com, second);
    restoreSecond();
    assert.equal(services.com, first);
    restoreFirst();
  });

  void test('lets a test install an explicit null for the urls', () => {
    const restore = services.installPageServices({ urls: { signalingURL: 'wss://example.test', cdnURL: '' } });

    assert.equal(services.urls?.signalingURL, 'wss://example.test');
    services.installPageServices({ urls: null });
    assert.equal(services.urls, null);
    restore();
  });
});

void describe('CommonEngineAPI editions', () => {
  void test('a registered game has no flavors', () => {
    assert.equal(createClientEngineApi({ registered: true, hipnotic: false, rogue: false }).registered, true);
    assert.deepEqual(createClientEngineApi({ registered: true, hipnotic: false, rogue: false }).gameFlavors, []);
  });

  void test('shareware and the mission packs are reported as flavors', () => {
    const engineApi = createClientEngineApi({ registered: false, hipnotic: true, rogue: true });

    assert.equal(engineApi.registered, false);
    assert.deepEqual(engineApi.gameFlavors, [GameFlavors.shareware, GameFlavors.hipnotic, GameFlavors.rogue]);
  });

  void test('follows the edition as it is detected, it is read on use', () => {
    const edition = { registered: false, hipnotic: false, rogue: false };
    const engineApi = createClientEngineApi(edition);

    assert.deepEqual(engineApi.gameFlavors, [GameFlavors.shareware]);
    edition.registered = true;
    assert.deepEqual(engineApi.gameFlavors, []);
  });
});

void describe('W.IndexToRGB', () => {
  void test('scales the palette entry into [0, 1)', () => {
    const previous = W.d_8to24table_u8;

    try {
      W.d_8to24table_u8 = new Uint8Array(768);
      W.d_8to24table_u8.set([0, 128, 255], 5 * 3);

      assert.deepEqual(W.IndexToRGB(5), [0, 0.5, 255 / 256]);
    } finally {
      W.d_8to24table_u8 = previous;
    }
  });
});
