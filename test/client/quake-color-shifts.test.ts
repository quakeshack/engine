import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import * as Def from '../../source/engine/common/Def.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import Host from '../../source/engine/common/Host.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import FirstPersonView from '../../source/engine/client/view/FirstPersonView.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import ColorShiftEffect from '../../source/engine/client/renderer/postprocess/ColorShiftEffect.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import QuakeColorShifts from '../../source/engine/client/view/QuakeColorShifts.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

/** The slots of the client's color shifts, by the names the engine gives them. */
const { contents: CONTENTS, damage: DAMAGE, bonus: BONUS, powerup: POWERUP, user1: USER1, user2: USER2 } = Def.contentShift;

/**
 * Sets the four numbers of one color shift slot.
 * @param slot The slot.
 * @param r Red, 0 to 255.
 * @param g Green, 0 to 255.
 * @param b Blue, 0 to 255.
 * @param a Alpha, 0 to 255.
 */
function setShift(slot: number, r: number, g: number, b: number, a: number): void {
  const shift = clientRuntimeState.cshifts[slot];

  shift[0] = r;
  shift[1] = g;
  shift[2] = b;
  shift[3] = a;
}

/**
 * Runs a frame of the engine's shifts and reads what the post-process stack would draw.
 * @returns The tint in Quake's units, red, green and blue 0 to 255 and alpha 0 to 1, all zero when nothing is drawn.
 */
function frameTint(): { r: number; g: number; b: number; a: number } {
  QuakeColorShifts.Update();

  const [entry] = PostProcess.entries.collect('final');

  if (entry === undefined) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const { color, alpha } = entry.settings as { color: number[]; alpha: number };

  return { r: color[0] * 255, g: color[1] * 255, b: color[2] * 255, a: alpha };
}

void describe('the engine\'s color shifts', () => {
  const previousEffects = PostProcess.effects;
  let restores: Array<() => void> = [];
  let cshiftpercent = { value: 100 };
  let polyblend = { value: 1 };

  beforeEach(() => {
    if (Cvar._vars.v_kicktime === undefined) {
      FirstPersonView.Init();
    }

    for (let slot = 0; slot < clientRuntimeState.cshifts.length; slot++) {
      setShift(slot, 0, 0, 0, 0);
    }

    cshiftpercent = { value: 100 };
    polyblend = { value: 1 };
    PostProcess.effects = [new ColorShiftEffect()];
    PostProcess.entries.reset();

    restores = [
      patchMembers(Host, { frametime: 0.1 }),
      patchMembers(clientRuntimeState, { items: 0 }),
      patchMembers(rendererCvars, { cshiftpercent: cshiftpercent as unknown as Cvar, polyblend: polyblend as unknown as Cvar }),
    ];
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    PostProcess.entries.reset();
    PostProcess.effects = previousEffects;
  });

  void describe('Update', () => {
    void test('has no tint at all while every shift is at zero alpha, and leaves nothing for the frame to capture', () => {
      assert.deepEqual(frameTint(), { r: 0, g: 0, b: 0, a: 0 });
      assert.equal(PostProcess.hasGameplayStack(), false);
    });

    void test('mixes one shift to its color at alpha / 255 scaled by the percentage', () => {
      setShift(CONTENTS, 130, 80, 50, 128);

      const tint = frameTint();

      assertNear(tint.r, 130, 1e-3);
      assertNear(tint.g, 80, 1e-3);
      assertNear(tint.b, 50, 1e-3);
      assertNear(tint.a, 128 / 255, 1e-6);
    });

    void test('scales every shift by gl_cshiftpercent', () => {
      setShift(CONTENTS, 130, 80, 50, 128);
      cshiftpercent.value = 50;

      assertNear(frameTint().a, 64 / 255, 1e-6);
    });

    void test('draws no tint at all with gl_cshiftpercent at zero', () => {
      setShift(CONTENTS, 130, 80, 50, 128);
      cshiftpercent.value = 0;

      assert.deepEqual(frameTint(), { r: 0, g: 0, b: 0, a: 0 });
    });

    void test('draws no tint at all with gl_polyblend at zero', () => {
      setShift(CONTENTS, 130, 80, 50, 128);
      polyblend.value = 0;

      assert.deepEqual(frameTint(), { r: 0, g: 0, b: 0, a: 0 });
    });

    void test('hands the shifts over on a channel of its own, one entry per slot that covers something', () => {
      setShift(CONTENTS, 130, 80, 50, 128);
      setShift(USER2, 1, 2, 3, 40);
      QuakeColorShifts.Update();

      // the effect mixes the entries that follow each other, so what is observed is the stack
      assert.equal(PostProcess.hasStack('engine.color-shifts'), true);
      assert.equal(PostProcess.hasStack('default'), false);

      QuakeColorShifts.Clear();

      assert.equal(PostProcess.hasStack('engine.color-shifts'), false);
    });

    void test('mixes shifts in slot order, each over the result of the ones before', () => {
      // a = a + a2 * (1 - a); the color of the later shift is weighted by its share of the new alpha
      setShift(CONTENTS, 100, 0, 0, 127.5);
      setShift(DAMAGE, 0, 100, 0, 127.5);

      // damage decays by 15 first (0.1 s at 150 per second): 112.5 / 255
      const first = 127.5 / 255;
      const second = 112.5 / 255;
      const alpha = first + second * (1 - first);
      const tint = frameTint();

      assertNear(tint.a, alpha, 1e-6);
      assertNear(tint.r, 100 * (1 - second / alpha), 1e-3);
      assertNear(tint.g, 100 * (second / alpha), 1e-3);
    });

    void test('never goes above full alpha', () => {
      setShift(CONTENTS, 255, 255, 255, 255);
      setShift(POWERUP, 255, 255, 255, 255);
      clientRuntimeState.items = Def.it.quad;

      assert.ok(frameTint().a <= 1);
    });

    void describe('powerup tint from the items', () => {
      void test('tints blue for the quad', () => {
        clientRuntimeState.items = Def.it.quad;

        QuakeColorShifts.Update();

        assert.deepEqual(Array.from(clientRuntimeState.cshifts[POWERUP]), [0, 0, 255, 30]);
      });

      void test('tints green for the suit', () => {
        clientRuntimeState.items = Def.it.suit;

        QuakeColorShifts.Update();

        assert.deepEqual(Array.from(clientRuntimeState.cshifts[POWERUP]), [0, 255, 0, 20]);
      });

      void test('tints grey for invisibility and yellow for invulnerability', () => {
        clientRuntimeState.items = Def.it.invisibility;
        QuakeColorShifts.Update();
        assert.deepEqual(Array.from(clientRuntimeState.cshifts[POWERUP]), [100, 100, 100, 100]);

        clientRuntimeState.items = Def.it.invulnerability;
        QuakeColorShifts.Update();
        assert.deepEqual(Array.from(clientRuntimeState.cshifts[POWERUP]), [255, 255, 0, 30]);
      });

      void test('lets the quad win over the suit and the suit over invisibility', () => {
        clientRuntimeState.items = Def.it.quad | Def.it.suit | Def.it.invisibility;
        QuakeColorShifts.Update();
        assert.deepEqual(Array.from(clientRuntimeState.cshifts[POWERUP]), [0, 0, 255, 30]);

        clientRuntimeState.items = Def.it.suit | Def.it.invisibility;
        QuakeColorShifts.Update();
        assert.deepEqual(Array.from(clientRuntimeState.cshifts[POWERUP]), [0, 255, 0, 20]);
      });

      void test('clears the tint when the powerup runs out', () => {
        clientRuntimeState.items = Def.it.quad;
        QuakeColorShifts.Update();

        clientRuntimeState.items = 0;
        QuakeColorShifts.Update();

        assert.equal(clientRuntimeState.cshifts[POWERUP][3], 0);
      });
    });

    void describe('decay', () => {
      void test('fades damage at 150 and bonus and user shifts at 100 alpha units per second', () => {
        setShift(DAMAGE, 255, 0, 0, 100);
        setShift(BONUS, 215, 186, 69, 100);
        setShift(USER1, 1, 2, 3, 100);
        setShift(USER2, 4, 5, 6, 100);

        QuakeColorShifts.Update();

        assertNear(clientRuntimeState.cshifts[DAMAGE][3], 85);
        assertNear(clientRuntimeState.cshifts[BONUS][3], 90);
        assertNear(clientRuntimeState.cshifts[USER1][3], 90);
        assertNear(clientRuntimeState.cshifts[USER2][3], 90);
      });

      void test('does not fade the liquid tint, which is replaced by the contents instead', () => {
        setShift(CONTENTS, 130, 80, 50, 128);

        QuakeColorShifts.Update();

        assert.equal(clientRuntimeState.cshifts[CONTENTS][3], 128);
      });

      void test('stops at zero', () => {
        setShift(DAMAGE, 255, 0, 0, 5);

        QuakeColorShifts.Update();

        assert.equal(clientRuntimeState.cshifts[DAMAGE][3], 0);
      });
    });
  });

  void describe('SetContentsColor', () => {
    void test('picks the tint of the liquid the eye is in', () => {
      QuakeColorShifts.SetContentsColor(content.CONTENT_WATER);
      assert.equal(clientRuntimeState.cshifts[CONTENTS], QuakeColorShifts.cshift_water);

      QuakeColorShifts.SetContentsColor(content.CONTENT_SLIME);
      assert.equal(clientRuntimeState.cshifts[CONTENTS], QuakeColorShifts.cshift_slime);

      QuakeColorShifts.SetContentsColor(content.CONTENT_LAVA);
      assert.equal(clientRuntimeState.cshifts[CONTENTS], QuakeColorShifts.cshift_lava);

      QuakeColorShifts.SetContentsColor(content.CONTENT_EMPTY);
      assert.equal(clientRuntimeState.cshifts[CONTENTS], QuakeColorShifts.cshift_empty);
    });

    void test('keeps the previous tint for contents it has no color for', () => {
      QuakeColorShifts.SetContentsColor(content.CONTENT_WATER);

      QuakeColorShifts.SetContentsColor(content.CONTENT_SOLID);

      assert.equal(clientRuntimeState.cshifts[CONTENTS], QuakeColorShifts.cshift_water);
    });
  });

  void describe('Corona', () => {
    void test('tints one frame orange, over the engine\'s shifts, and is gone with the next frame', () => {
      setShift(CONTENTS, 0, 0, 255, 255);
      QuakeColorShifts.Update();

      QuakeColorShifts.Corona(0.5);

      const [entry] = PostProcess.entries.collect('final');
      const { color, alpha } = entry.settings as { color: number[]; alpha: number };

      // 0.5 of orange over a solid blue
      assertNear(alpha, 1, 1e-9);
      assertNear(color[0], 0.5 * 1, 1e-6);
      assertNear(color[1], 0.5 * 0.5, 1e-6);
      assertNear(color[2], 0.5, 1e-6);

      PostProcess.entries.advance(0.016);

      const [remaining] = PostProcess.entries.collect('final');
      const blue = remaining.settings as { color: number[]; alpha: number };
      assert.deepEqual([blue.color[0], blue.color[1], blue.color[2]], [0, 0, 1]);
      assertNear(blue.alpha, 1, 1e-9);
    });

    void test('is not applied when gl_polyblend is off', () => {
      polyblend.value = 0;

      QuakeColorShifts.Corona(0.5);

      assert.deepEqual(PostProcess.entries.collect('final'), []);
    });
  });

  void describe('ContentShift, BonusFlash_f, cshift_f', () => {
    void test('sets a user slot from a 0 to 1 color and alpha', () => {
      QuakeColorShifts.ContentShift(USER1, new Vector(1, 0.5, 0), 0.2);

      assert.deepEqual(Array.from(clientRuntimeState.cshifts[USER1]), [255, 127.5, 0, 51]);
    });

    void test('flashes gold for a pickup', () => {
      QuakeColorShifts.BonusFlash_f();

      assert.deepEqual(Array.from(clientRuntimeState.cshifts[BONUS]), [215, 186, 69, 50]);
    });

    void test('lets v_cshift edit the clear-air tint, with missing arguments left alone', () => {
      const before = Array.from(QuakeColorShifts.cshift_empty);

      QuakeColorShifts.cshift_f('10', '20');

      assert.deepEqual(Array.from(QuakeColorShifts.cshift_empty), [10, 20, before[2], before[3]]);

      QuakeColorShifts.cshift_f(...before.map(String));
    });
  });

  void describe('FirstPersonView.ApplyDamage', () => {
    let published: unknown[] = [];
    let player: ClientEdict = new ClientEdict(1);

    beforeEach(() => {
      published = [];
      player = new ClientEdict(1);
      player.origin.setTo(0, 0, 0);
      player.angles.setTo(0, 0, 0);
      Cvar._vars.v_kicktime.set(0.5);
      Cvar._vars.v_kickroll.set(0.6);
      Cvar._vars.v_kickpitch.set(0.6);
      restores.push(patchMembers(clientRuntimeState, { playerentity: player, time: 50, faceanimtime: 0 }));
      mock.method(eventBus, 'publish', (name: string, ...args: unknown[]) => {
        published.push([name, ...args]);
      });
    });

    void test('flashes red for flesh damage, 3 alpha per point of half the damage, at least 10', () => {
      FirstPersonView.ApplyDamage(0, 20, new Vector(100, 0, 0));

      // count = max(10, (20 + 0) / 2) = 10
      assert.deepEqual(Array.from(clientRuntimeState.cshifts[DAMAGE]), [255, 0, 0, 30]);
    });

    void test('flashes pinkish when armor took most of it, and between when armor took some', () => {
      FirstPersonView.ApplyDamage(30, 10, new Vector(100, 0, 0));
      assert.deepEqual(Array.from(clientRuntimeState.cshifts[DAMAGE]).slice(0, 3), [200, 100, 100]);

      FirstPersonView.ApplyDamage(10, 30, new Vector(100, 0, 0));
      assert.deepEqual(Array.from(clientRuntimeState.cshifts[DAMAGE]).slice(0, 3), [220, 50, 50]);
    });

    void test('adds up to at most 150 alpha', () => {
      FirstPersonView.ApplyDamage(0, 200, new Vector(100, 0, 0));
      FirstPersonView.ApplyDamage(0, 200, new Vector(100, 0, 0));

      assert.equal(clientRuntimeState.cshifts[DAMAGE][3], 150);
    });

    void test('kicks the view away from the direction the damage came from', () => {
      // from the front: along the player's forward axis, none sideways
      FirstPersonView.ApplyDamage(0, 20, new Vector(100, 0, 0));

      // count 10 * dot(from, forward) 1 * kickpitch 0.6
      assertNear(FirstPersonView.dmg_pitch, 6, 1e-4);
      assertNear(FirstPersonView.dmg_roll, 0, 1e-4);
      assert.equal(FirstPersonView.dmg_time, 0.5);
    });

    void test('starts the face animation for 0.2 s and tells the game', () => {
      FirstPersonView.ApplyDamage(5, 15, new Vector(0, 100, 0));

      assertNear(clientRuntimeState.faceanimtime, 50.2);

      const [event] = published as Array<[string, { damageReceived: number; armorLost: number }]>;
      assert.equal(event[0], 'client.damage');
      assert.equal(event[1].damageReceived, 15);
      assert.equal(event[1].armorLost, 5);
    });
  });
});
