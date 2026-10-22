import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import FirstPersonView from '../../source/engine/client/view/FirstPersonView.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('FirstPersonView.ApplyDamage', () => {
  let restores: Array<() => void> = [];
  let published: unknown[] = [];
  let player: ClientEdict = new ClientEdict(1);

  beforeEach(() => {
    if (Cvar._vars.v_kicktime === undefined) {
      FirstPersonView.Init();
    }

    published = [];
    player = new ClientEdict(1);
    player.origin.setTo(0, 0, 0);
    player.angles.setTo(0, 0, 0);
    Cvar._vars.v_kicktime.set(0.5);
    Cvar._vars.v_kickroll.set(0.6);
    Cvar._vars.v_kickpitch.set(0.6);
    FirstPersonView.dmg_time = 0;
    FirstPersonView.dmg_roll = 0;
    FirstPersonView.dmg_pitch = 0;

    restores = [patchMembers(clientRuntimeState, { playerentity: player, time: 50, faceanimtime: 0 })];
    mock.method(eventBus, 'publish', (name: string, ...args: unknown[]) => {
      published.push([name, ...args]);
    });
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }
  });

  void test('kicks the view away from the direction the damage came from', () => {
    // from the front: along the player's forward axis, none sideways
    FirstPersonView.ApplyDamage(0, 20, new Vector(100, 0, 0));

    // count 10 * dot(from, forward) 1 * kickpitch 0.6
    assertNear(FirstPersonView.dmg_pitch, 6, 1e-4);
    assertNear(FirstPersonView.dmg_roll, 0, 1e-4);
    assert.equal(FirstPersonView.dmg_time, 0.5);
  });

  void test('kicks sideways for a hit from the side, in proportion to the damage', () => {
    FirstPersonView.ApplyDamage(0, 60, new Vector(0, -100, 0));

    // count 30 along the right vector (-y at zero angles) times kickroll 0.6
    assertNear(FirstPersonView.dmg_roll, 30 * 0.6, 1e-4);
    assertNear(FirstPersonView.dmg_pitch, 0, 1e-4);
  });

  void test('counts at least 10 for a small hit', () => {
    FirstPersonView.ApplyDamage(0, 2, new Vector(100, 0, 0));

    assertNear(FirstPersonView.dmg_pitch, 10 * 0.6, 1e-4);
  });

  void test('starts the face animation for 0.2 s and tells the game, which is who tints the view', () => {
    FirstPersonView.ApplyDamage(5, 15, new Vector(0, 100, 0));

    assertNear(clientRuntimeState.faceanimtime, 50.2);

    const [event] = published as Array<[string, { damageReceived: number; armorLost: number }]>;
    assert.equal(event[0], 'client.damage');
    assert.equal(event[1].damageReceived, 15);
    assert.equal(event[1].armorLost, 5);
  });
});
