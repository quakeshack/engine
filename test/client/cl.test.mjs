import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import CL from '../../source/engine/client/CL.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import * as Def from '../../source/engine/common/Def.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { PM_TYPE, Pmove } from '../../source/engine/common/Pmove.ts';
import { ClientPlayerState } from '../../source/engine/client/ClientMessages.ts';
import { createBrushWorldModel } from '../physics/fixtures.mjs';

void describe('CL.AppendChatMessage', () => {
  void test('publishes chat messages without a legacy engine HUD fallback', () => {
    const publishedMessages = [];

    const unsubscribe = eventBus.subscribe('client.chat.message', (name, message, direct) => {
      publishedMessages.push([name, message, direct]);
    });

    try {
      CL.AppendChatMessage('Ranger', 'Ready?', false);
      CL.AppendChatMessage('Ranger', 'Go.', true);

      assert.deepEqual(publishedMessages, [
        ['Ranger', 'Ready?', false],
        ['Ranger', 'Go.', true],
      ]);
    } finally {
      unsubscribe();
    }
  });
});

void describe('CL.PredictMove', () => {
  void test('skips prediction during intermission instead of replaying gravity/collision from the frozen server origin', () => {
    // Regression test: the server freezes the player entity on intermission
    // (movetype none, fixed origin) and stops sending origin updates for it.
    // Nothing previously stopped the client from continuing to queue move
    // commands and replay them through Pmove, which has no notion of
    // intermission and would keep applying gravity/collision from the fixed
    // base every frame — producing visible camera jitter.
    const previousHost = registry.Host;
    const previousNopred = CL.nopred;
    const previousIntermission = CL.state.intermission;
    const previousViewentity = CL.state.viewentity;
    const previousMoveSequence = CL.state.moveSequence;
    const previousAckedMoveSequence = CL.state.acknowledgedMoveSequence;
    const previousPredicted = CL.state.predicted;

    registry.Host = { realtime: 42.0 };
    eventBus.publish('registry.frozen');

    CL.nopred = { value: 0 };
    CL.state.intermission = 1;
    CL.state.viewentity = 1;
    // 3 unacknowledged commands pending — prediction would normally replay them.
    CL.state.moveSequence = 5;
    CL.state.acknowledgedMoveSequence = 2;

    const playerEntity = CL.state.playerentity;
    playerEntity.origin.setTo(100.0, 200.0, 300.0);

    try {
      CL.PredictMove();

      assert.equal(CL.state.predicted, false);
      assert.deepEqual([...playerEntity.origin], [100.0, 200.0, 300.0]);
    } finally {
      registry.Host = previousHost;
      eventBus.publish('registry.frozen');
      CL.nopred = previousNopred;
      CL.state.intermission = previousIntermission;
      CL.state.viewentity = previousViewentity;
      CL.state.moveSequence = previousMoveSequence;
      CL.state.acknowledgedMoveSequence = previousAckedMoveSequence;
      CL.state.predicted = previousPredicted;
      CL.state.clientEntities.clear();
    }
  });
});

void describe('CL.PredictUsercmd', () => {
  void test('seeded with a SPECTATOR pmType flies freely instead of falling like a grounded player', () => {
    // Regression test: pmType used to never be set on the client (only
    // pmFlags/pmTime/oldbuttons were synced from the server), so client
    // prediction always ran ordinary gravity/collision movement even for a
    // noclip/spectating player, causing heavy jitter against the server's
    // correct free-fly simulation. pmType is now seeded from
    // CL.state.ackedPmType via `from.pmType` (see CL.PredictMove).
    //
    // A second bug then masked the fix: PredictUsercmd used to also set
    // `pmove.dead = CL.state.stats[Def.stat.health] <= 0`, but nothing in
    // the current protocol ever populates CL.state.stats (it's legacy/dead
    // state — see the grep audit that removed it), so this was always true
    // and silently forced pmType back to DEAD inside move(), overriding the
    // seeded SPECTATOR value. Leaving CL.state.stats untouched at its
    // all-zero default here reproduces exactly that failure condition.
    assert.equal(CL.state.stats[Def.stat.health], 0, 'CL.state.stats must stay unpopulated to reproduce the old bug condition');

    const pmove = new Pmove().newPlayerMove();

    const from = new ClientPlayerState(pmove);
    from.origin.setTo(0.0, 0.0, 100.0);
    from.velocity.clear();
    from.pmType = PM_TYPE.SPECTATOR;

    const to = new ClientPlayerState(pmove);

    const cmd = new Protocol.UserCmd();
    cmd.msec = 50; // stay under the 50ms split threshold for a single direct move()
    cmd.upmove = 200; // fly straight up

    CL.PredictUsercmd(pmove, from, to, cmd);

    assert.equal(pmove.dead, false);
    assert.equal(to.pmType, PM_TYPE.SPECTATOR);
    assert.ok(to.origin[2] > from.origin[2], `expected the spectator to fly upward, got z=${to.origin[2]}`);
  });
});

void describe('CL.SetUpPlayerPrediction', () => {
  /**
   * @param {() => void} callback test body run with a save/restore of the pmove and worldmodel state.
   */
  function withRestoredPmoveState(callback) {
    const previousNopred = CL.nopred;
    const previousWorldmodel = CL.state.worldmodel;
    const previousPhysents = [...CL.pmove.physents];
    const clientDemos = CL.connection.clientDemos;
    const previousDemoplayback = clientDemos.demoplayback;

    try {
      callback();
    } finally {
      CL.nopred = previousNopred;
      CL.state.worldmodel = previousWorldmodel;
      clientDemos.demoplayback = previousDemoplayback;
      CL.pmove.physents.length = 0;
      CL.pmove.physents.push(...previousPhysents);
      CL.state.clientEntities.clear();
    }
  }

  void test('clears pmove entities and skips setup when nopred is enabled', () => {
    withRestoredPmoveState(() => {
      CL.nopred = { value: 1 };
      CL.pmove.physents.length = 0;
      CL.pmove.physents.push({}, {}, {}); // pretend a previous setup left entities behind

      CL.SetUpPlayerPrediction();

      assert.equal(CL.pmove.physents.length, 1, 'clearEntities() should truncate back down to just the world slot');
    });
  });

  void test('clears pmove entities and skips setup during demo playback', () => {
    withRestoredPmoveState(() => {
      CL.nopred = { value: 0 };
      CL.connection.clientDemos.demoplayback = true;
      CL.pmove.physents.length = 0;
      CL.pmove.physents.push({}, {}, {});

      CL.SetUpPlayerPrediction();

      assert.equal(CL.pmove.physents.length, 1, 'clearEntities() should truncate back down to just the world slot');
    });
  });

  void test('does nothing further when physents are empty and no worldmodel is available yet', () => {
    withRestoredPmoveState(() => {
      CL.nopred = { value: 0 };
      CL.connection.clientDemos.demoplayback = false;
      CL.state.worldmodel = null;
      CL.pmove.physents.length = 0;

      CL.SetUpPlayerPrediction();

      assert.equal(CL.pmove.physents.length, 0, 'no worldmodel to seed physents with, so setup should stay skipped');
    });
  });

  void test('lazily applies the pending worldmodel and sets up physents once one becomes available', () => {
    withRestoredPmoveState(() => {
      CL.nopred = { value: 0 };
      CL.connection.clientDemos.demoplayback = false;
      CL.state.clientEntities.clear();
      CL.state.worldmodel = createBrushWorldModel({ halfExtents: [32, 32, 32] });
      CL.pmove.physents.length = 0;

      CL.SetUpPlayerPrediction();

      assert.equal(CL.pmove.physents.length, 1, 'setWorldmodel() should populate physent[0] for the world, with no other entities to add');
    });
  });
});
