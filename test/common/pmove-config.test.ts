import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PmoveConfiguration, PmoveQuake2Configuration, PmoveQuake2MoveVars } from '../../source/shared/Pmove.ts';
import { MOVEVAR_CVARS, MoveVars } from '../../source/engine/common/Pmove.ts';

void describe('PmoveConfiguration', () => {
  void test('keeps the QuakeWorld-style defaults', () => {
    const config = new PmoveConfiguration();

    assert.equal(config.forwardProbe, 24);
    assert.equal(config.overbounce, 1.0);
    assert.equal(config.pitchDivisor, 0);
    assert.equal(config.edgeFriction, true);
  });

  void test('applies the Quake 2 overrides in the subclass', () => {
    const config = new PmoveQuake2Configuration();

    assert.equal(config.forwardProbe, 30);
    assert.equal(config.overbounce, 1.01);
    assert.equal(config.pitchDivisor, 3);
    assert.equal(config.edgeFriction, false);
    assert.equal(config.landingCooldown, true);
  });
});

void describe('PmoveQuake2MoveVars', () => {
  void test('only names cvars that set a movement variable', () => {
    const movementCvars = new Set(Object.values(MOVEVAR_CVARS));

    for (const name of Object.keys(PmoveQuake2MoveVars)) {
      assert.ok(movementCvars.has(name), `${name} is not a movement cvar`);
    }
  });

  void test('gives movement variables the values of Quake 2', () => {
    const vars = new MoveVars();

    for (const [name, value] of Object.entries(PmoveQuake2MoveVars)) {
      assert.equal(vars.setFromCvar(name, value), true, name);
    }

    // qcommon/pmove.c: pm_friction 6, pm_waterfriction 1, pm_maxspeed 300, pm_airaccelerate 0
    assert.equal(vars.friction, 6);
    assert.equal(vars.waterfriction, 1);
    assert.equal(vars.maxspeed, 300);
    assert.equal(vars.airaccelerate, 0);
    assert.equal(vars.stopspeed, 100);
    assert.equal(vars.accelerate, 10);
    assert.equal(vars.wateraccelerate, 10);
  });

  void test('leaves the variables that Quake 2 has no counterpart for alone', () => {
    const vars = new MoveVars();
    const before = { spectatormaxspeed: vars.spectatormaxspeed, edgefriction: vars.edgefriction };

    for (const [name, value] of Object.entries(PmoveQuake2MoveVars)) {
      vars.setFromCvar(name, value);
    }

    assert.equal(vars.spectatormaxspeed, before.spectatormaxspeed);
    assert.equal(vars.edgefriction, before.edgefriction);
  });

  void test('cannot be changed by a game that imports it', () => {
    assert.equal(Object.isFrozen(PmoveQuake2MoveVars), true);
  });
});
