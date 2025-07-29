import Vector from '../../shared/Vector.mjs';
import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import * as Def from '../common/Def.mjs';
import Q from '../common/Q.mjs';
import { eventBus, registry } from '../registry.mjs';
import MSG from '../network/MSG.mjs';
import Chase from './Chase.mjs';
import { gameCapabilities } from '../../shared/Defs.mjs';

const V = {};

export default V;

let { CL, Con, Host, Mod, R, SCR } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
  R = registry.R;
  SCR = registry.SCR;
});

V.dmg_time = 0.0;

V.CalcRoll = function (angles, velocity) { // FIXME: this is required for dedicated as well
  const { right } = angles.angleVectors();
  let side = velocity[0] * right[0] + velocity[1] * right[1] + velocity[2] * right[2];
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);
  if (side < V.rollspeed.value) {
    return side * sign * V.rollangle.value / V.rollspeed.value;
  }
  return V.rollangle.value * sign;
};

V.CalcBob = function () {
  if ((V.bobcycle.value <= 0.0) ||
    (V.bobcycle.value >= 1.0) ||
    (V.bobup.value <= 0.0) ||
    (V.bobup.value >= 1.0) ||
    (V.bob.value === 0.0)) {
    return 0.0;
  }

  let cycle = (CL.state.time - Math.floor(CL.state.time / V.bobcycle.value) * V.bobcycle.value) / V.bobcycle.value;
  if (cycle < V.bobup.value) {
    cycle = Math.PI * cycle / V.bobup.value;
  } else {
    cycle = Math.PI + Math.PI * (cycle - V.bobup.value) / (1.0 - V.bobup.value);
  }
  let bob = Math.sqrt(CL.state.velocity[0] * CL.state.velocity[0] + CL.state.velocity[1] * CL.state.velocity[1]) * V.bob.value;
  bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
  if (bob > 4.0) {
    bob = 4.0;
  } else if (bob < -7.0) {
    bob = -7.0;
  }
  return bob;
};

V.StartPitchDrift = function () {
  if (CL.state.laststop === CL.state.time) {
    return;
  }
  if ((CL.state.nodrift === true) || (CL.state.pitchvel === 0.0)) {
    CL.state.pitchvel = V.centerspeed.value;
    CL.state.nodrift = false;
    CL.state.driftmove = 0.0;
  }
};

V.StopPitchDrift = function () {
  CL.state.laststop = CL.state.time;
  CL.state.nodrift = true;
  CL.state.pitchvel = 0.0;
};

V.DriftPitch = function () {
  if ((Host.noclip_anglehack === true) || (CL.state.onground !== true) || (CL.cls.demoplayback === true)) {
    CL.state.driftmove = 0.0;
    CL.state.pitchvel = 0.0;
    return;
  }

  if (CL.state.nodrift === true) {
    if (Math.abs(CL.state.cmd.forwardmove) < CL.forwardspeed.value) {
      CL.state.driftmove = 0.0;
    } else {
      CL.state.driftmove += Host.frametime;
    }
    if (CL.state.driftmove > V.centermove.value) {
      V.StartPitchDrift();
    }
    return;
  }

  const delta = CL.state.idealpitch - CL.state.viewangles[0];
  if (delta === 0.0) {
    CL.state.pitchvel = 0.0;
    return;
  }

  let move = Host.frametime * CL.state.pitchvel;
  CL.state.pitchvel += Host.frametime * V.centerspeed.value;

  if (delta > 0) {
    if (move > delta) {
      CL.state.pitchvel = 0.0;
      move = delta;
    }
    CL.state.viewangles[0] += move;
  } else if (delta < 0) {
    if (move > -delta) {
      CL.state.pitchvel = 0.0;
      move = -delta;
    }
    CL.state.viewangles[0] -= move;
  }
};

V.cshift_empty = [130.0, 80.0, 50.0, 0.0];
V.cshift_water = [130.0, 80.0, 50.0, 128.0];
V.cshift_slime = [0.0, 25.0, 5.0, 150.0];
V.cshift_lava = [255.0, 80.0, 0.0, 150.0];

V.blend = [0.0, 0.0, 0.0, 0.0];

V.ParseDamage = function () {
  const armor = MSG.ReadByte();
  const blood = MSG.ReadByte();
  const ent = CL.state.playerentity;
  const from = MSG.ReadCoordVector().subtract(ent.origin);
  from.normalize();
  let count = (blood + armor) * 0.5;
  if (count < 10.0) {
    count = 10.0;
  }
  CL.state.faceanimtime = CL.state.time + 0.2;

  const cshift = CL.state.cshifts[CL.cshift.damage];
  cshift[3] += 3.0 * count;
  if (cshift[3] < 0.0) {
    cshift[3] = 0.0;
  } else if (cshift[3] > 150.0) {
    cshift[3] = 150.0;
  }

  if (armor > blood) {
    cshift[0] = 200.0;
    cshift[1] = cshift[2] = 100.0;
  } else if (armor !== 0) {
    cshift[0] = 220.0;
    cshift[1] = cshift[2] = 50.0;
  } else {
    cshift[0] = 255.0;
    cshift[1] = cshift[2] = 0.0;
  }

  const { forward, right } = ent.angles.angleVectors();
  V.dmg_roll = count * (from[0] * right[0] + from[1] * right[1] + from[2] * right[2]) * V.kickroll.value;
  V.dmg_pitch = count * (from[0] * forward[0] + from[1] * forward[1] + from[2] * forward[2]) * V.kickpitch.value;
  V.dmg_time = V.kicktime.value;
};

V.cshift_f = function (...args) {
  const cshift = V.cshift_empty;
  for (let i = 0; i < Math.min(args.length, cshift.length); i++) {
    cshift[i] = Q.atoi(args[i]);
  }
};

V.BonusFlash_f = function () {
  const cshift = CL.state.cshifts[CL.cshift.bonus];
  cshift[0] = 215.0;
  cshift[1] = 186.0;
  cshift[2] = 69.0;
  cshift[3] = 50.0;
};

V.SetContentsColor = function (contents) {
  switch (contents) {
    case Mod.contents.empty:
    case Mod.contents.solid:
      CL.state.cshifts[CL.cshift.contents] = V.cshift_empty;
      return;
    case Mod.contents.lava:
      CL.state.cshifts[CL.cshift.contents] = V.cshift_lava;
      return;
    case Mod.contents.slime:
      CL.state.cshifts[CL.cshift.contents] = V.cshift_slime;
      return;
  }
  CL.state.cshifts[CL.cshift.contents] = V.cshift_water;
};

V.CalcBlend = function () {
  let cshift = CL.state.cshifts[CL.cshift.powerup];
  if ((CL.state.items & Def.it.quad) !== 0) {
    cshift[0] = 0.0;
    cshift[1] = 0.0;
    cshift[2] = 255.0;
    cshift[3] = 30.0;
  } else if ((CL.state.items & Def.it.suit) !== 0) {
    cshift[0] = 0.0;
    cshift[1] = 255.0;
    cshift[2] = 0.0;
    cshift[3] = 20.0;
  } else if ((CL.state.items & Def.it.invisibility) !== 0) {
    cshift[0] = 100.0;
    cshift[1] = 100.0;
    cshift[2] = 100.0;
    cshift[3] = 100.0;
  } else if ((CL.state.items & Def.it.invulnerability) !== 0) {
    cshift[0] = 255.0;
    cshift[1] = 255.0;
    cshift[2] = 0.0;
    cshift[3] = 30.0;
  } else {
    cshift[3] = 0.0;
  }

  CL.state.cshifts[CL.cshift.damage][3] -= Host.frametime * 150.0;
  if (CL.state.cshifts[CL.cshift.damage][3] < 0.0) {
    CL.state.cshifts[CL.cshift.damage][3] = 0.0;
  }
  CL.state.cshifts[CL.cshift.bonus][3] -= Host.frametime * 100.0;
  if (CL.state.cshifts[CL.cshift.bonus][3] < 0.0) {
    CL.state.cshifts[CL.cshift.bonus][3] = 0.0;
  }

  if (V.cshiftpercent.value === 0) {
    V.blend[0] = V.blend[1] = V.blend[2] = V.blend[3] = 0.0;
    return;
  }

  let r = 0.0; let g = 0.0; let b = 0.0; let a = 0.0; let a2; let i;
  for (i = 0; i <= 3; i++) {
    cshift = CL.state.cshifts[i];
    a2 = cshift[3] * V.cshiftpercent.value / 25500.0;
    if (a2 === 0.0) {
      continue;
    }
    a = a + a2 * (1.0 - a);
    a2 = a2 / a;
    r = r * (1.0 - a2) + cshift[0] * a2;
    g = g * (1.0 - a2) + cshift[1] * a2;
    b = b * (1.0 - a2) + cshift[2] * a2;
  }
  if (a > 1.0) {
    a = 1.0;
  } else if (a < 0.0) {
    a = 0.0;
  }
  V.blend[0] = r;
  V.blend[1] = g;
  V.blend[2] = b;
  V.blend[3] = a;
  if (V.blend[3] > 1.0) {
    V.blend[3] = 1.0;
  } else if (V.blend[3] < 0.0) {
    V.blend[3] = 0.0;
  }
};

/**
 *
 * @param value
 */
function finiteOrZero(value) {
  return isFinite(value) ? value : 0.0;
}

V.CalcIntermissionRefdef = function () {
  const ent = CL.state.playerentity;
  R.refdef.vieworg[0] = finiteOrZero(ent.origin[0]);
  R.refdef.vieworg[1] = finiteOrZero(ent.origin[1]);
  R.refdef.vieworg[2] = finiteOrZero(ent.origin[2]);
  R.refdef.viewangles[0] = finiteOrZero(ent.angles[0]) + Math.sin(CL.state.time * V.ipitch_cycle.value) * V.ipitch_level.value;
  R.refdef.viewangles[1] = finiteOrZero(ent.angles[1]) + Math.sin(CL.state.time * V.iyaw_cycle.value) * V.iyaw_level.value;
  R.refdef.viewangles[2] = finiteOrZero(ent.angles[2]) + Math.sin(CL.state.time * V.iroll_cycle.value) * V.iroll_level.value;
  CL.state.viewent.model = null;
};

V.oldz = 0.0;
V.CalcRefdef = function () { // TODO: Client
  if (V.pitchdrift.value) {
    V.DriftPitch();
  }

  const ent = CL.state.playerentity;
  ent.angles[1] = CL.state.viewangles[1];
  ent.angles[0] = -CL.state.viewangles[0];
  const bob = V.CalcBob();

  R.refdef.vieworg[0] = finiteOrZero(ent/*lerp*/.origin[0]) + 0.03125;
  R.refdef.vieworg[1] = finiteOrZero(ent/*lerp*/.origin[1]) + 0.03125;
  R.refdef.vieworg[2] = finiteOrZero(ent/*lerp*/.origin[2]) + CL.state.viewheight + bob + 0.03125;

  R.refdef.viewangles[0] = CL.state.viewangles[0];
  R.refdef.viewangles[1] = CL.state.viewangles[1];
  R.refdef.viewangles[2] = CL.state.viewangles[2] + V.CalcRoll(CL.state.playerentity/*lerp*/.angles, CL.state.velocity);

  if (V.dmg_time > 0.0) {
    if (V.kicktime.value) {
      R.refdef.viewangles[2] += (V.dmg_time / V.kicktime.value) * V.dmg_roll;
      R.refdef.viewangles[0] -= (V.dmg_time / V.kicktime.value) * V.dmg_pitch;
    }
    V.dmg_time -= Host.frametime;
  }
  if (CL.state.stats[Def.stat.health] <= 0) { // Legacy
    R.refdef.viewangles[2] = 80.0;
  }

  const ipitch = V.idlescale.value * Math.sin(CL.state.time * V.ipitch_cycle.value) * V.ipitch_level.value;
  const iyaw = V.idlescale.value * Math.sin(CL.state.time * V.iyaw_cycle.value) * V.iyaw_level.value;
  const iroll = V.idlescale.value * Math.sin(CL.state.time * V.iroll_cycle.value) * V.iroll_level.value;
  R.refdef.viewangles[0] += ipitch;
  R.refdef.viewangles[1] += iyaw;
  R.refdef.viewangles[2] += iroll;

  const { forward, right, up } = (new Vector(finiteOrZero(-ent/*lerp*/.angles[0]), finiteOrZero(ent/*lerp*/.angles[1]), finiteOrZero(ent/*lerp*/.angles[2]))).angleVectors();
  R.refdef.vieworg[0] += V.ofsx.value * forward[0] + V.ofsy.value * right[0] + V.ofsz.value * up[0];
  R.refdef.vieworg[1] += V.ofsx.value * forward[1] + V.ofsy.value * right[1] + V.ofsz.value * up[1];
  R.refdef.vieworg[2] += V.ofsx.value * forward[2] + V.ofsy.value * right[2] + V.ofsz.value * up[2];

  if (R.refdef.vieworg[0] < (ent/*lerp*/.origin[0] - 14.0)) {
    R.refdef.vieworg[0] = finiteOrZero(ent/*lerp*/.origin[0]) - 14.0;
  } else if (R.refdef.vieworg[0] > (ent/*lerp*/.origin[0] + 14.0)) {
    R.refdef.vieworg[0] = finiteOrZero(ent/*lerp*/.origin[0]) + 14.0;
  }
  if (R.refdef.vieworg[1] < (ent/*lerp*/.origin[1] - 14.0)) {
    R.refdef.vieworg[1] = finiteOrZero(ent/*lerp*/.origin[1]) - 14.0;
  } else if (R.refdef.vieworg[1] > (ent/*lerp*/.origin[1] + 14.0)) {
    R.refdef.vieworg[1] = finiteOrZero(ent/*lerp*/.origin[1]) + 14.0;
  }
  if (R.refdef.vieworg[2] < (ent/*lerp*/.origin[2] - 22.0)) {
    R.refdef.vieworg[2] = finiteOrZero(ent/*lerp*/.origin[2]) - 22.0;
  } else if (R.refdef.vieworg[2] > (ent/*lerp*/.origin[2] + 30.0)) {
    R.refdef.vieworg[2] = finiteOrZero(ent/*lerp*/.origin[2]) + 30.0;
  }

  const view = CL.state.viewent;
  view.angles[0] = -R.refdef.viewangles[0] - ipitch;
  view.angles[1] = R.refdef.viewangles[1] - iyaw;
  view.angles[2] = CL.state.viewangles[2] - iroll;
  view.origin[0] = finiteOrZero(ent/*lerp*/.origin[0]) + forward[0] * bob * 0.4;
  view.origin[1] = finiteOrZero(ent/*lerp*/.origin[1]) + forward[1] * bob * 0.4;
  view.origin[2] = finiteOrZero(ent/*lerp*/.origin[2]) + CL.state.viewheight + forward[2] * bob * 0.4 + bob;
  switch (SCR.viewsize.value) {
    case 110:
    case 90:
      view.origin[2] += 1.0;
      break;
    case 100:
      view.origin[2] += 2.0;
      break;
    case 80:
      view.origin[2] += 0.5;
  }

  if (CL.gameCapabilities.includes(gameCapabilities.CAP_VIEWMODEL_MANAGED) && CL.state.gameAPI) {
    const viewmodel = CL.state.gameAPI.viewmodel;
    view.model = viewmodel.model;
    view.frame = viewmodel.frame;
    // visibility is considered by R.DrawViewModel
  } else {
    view.model = CL.state.model_precache[CL.state.stats[Def.stat.weapon]];
    view.frame = CL.state.stats[Def.stat.weaponframe];
  }

  R.refdef.viewangles.add(CL.state.punchangle);

  if ((CL.state.onground === true) && ((ent/*lerp*/.origin[2] - V.oldz) > 0.0)) {
    let steptime = Host.frametime;
    if (steptime < 0.0) {
      steptime = 0.0;
    }
    V.oldz += steptime * 80.0;
    if (V.oldz > ent/*lerp*/.origin[2]) {
      V.oldz = finiteOrZero(ent/*lerp*/.origin[2]);
    } else if ((ent/*lerp*/.origin[2] - V.oldz) > 12.0) {
      V.oldz = finiteOrZero(ent/*lerp*/.origin[2]) - 12.0;
    }
    R.refdef.vieworg[2] += V.oldz - finiteOrZero(ent/*lerp*/.origin[2]);
    view.origin[2] += V.oldz - finiteOrZero(ent/*lerp*/.origin[2]);
  } else {
    V.oldz = finiteOrZero(ent/*lerp*/.origin[2]);
  }
  if (Chase.active.value) {
    Chase.Update();
  }
};

V.RenderView = function () {
  if (Con.forcedup === true) {
    return;
  }
  if (CL.state.maxclients >= 2) {
    Cvar.Set('scr_ofsx', '0');
    Cvar.Set('scr_ofsy', '0');
    Cvar.Set('scr_ofsz', '0');
  }
  if (CL.state.intermission) {
    V.CalcIntermissionRefdef();
  } else if (!CL.state.paused) {
    V.CalcRefdef();
  }
  R.PushDlights();
  R.RenderView();
};

V.Init = function () {
  Cmd.AddCommand('v_cshift', V.cshift_f);
  Cmd.AddCommand('bf', V.BonusFlash_f);
  Cmd.AddCommand('centerview', V.StartPitchDrift);
  V.centermove = new Cvar('v_centermove', '0.15');
  V.centerspeed = new Cvar('v_centerspeed', '500');
  V.iyaw_cycle = new Cvar('v_iyaw_cycle', '2');
  V.iroll_cycle = new Cvar('v_iroll_cycle', '0.5');
  V.ipitch_cycle = new Cvar('v_ipitch_cycle', '1');
  V.iyaw_level = new Cvar('v_iyaw_level', '0.3');
  V.iroll_level = new Cvar('v_iroll_level', '0.1');
  V.ipitch_level = new Cvar('v_ipitch_level', '0.3');
  V.idlescale = new Cvar('v_idlescale', '0');
  V.cshiftpercent = new Cvar('gl_cshiftpercent', '100');
  V.ofsx = new Cvar('scr_ofsx', '0');
  V.ofsy = new Cvar('scr_ofsy', '0');
  V.ofsz = new Cvar('scr_ofsz', '0');
  V.rollspeed = new Cvar('cl_rollspeed', '200');
  V.rollangle = new Cvar('cl_rollangle', '2.0');
  V.bob = new Cvar('cl_bob', '0.02');
  V.bobcycle = new Cvar('cl_bobcycle', '0.6');
  V.bobup = new Cvar('cl_bobup', '0.5');
  V.kicktime = new Cvar('v_kicktime', '0.5');
  V.kickroll = new Cvar('v_kickroll', '0.6');
  V.kickpitch = new Cvar('v_kickpitch', '0.6');
  V.gamma = new Cvar('gamma', '0.8', Cvar.FLAG.ARCHIVE | Cvar.FLAG.CHEAT); // CR: 1 is too dark
  V.pitchdrift = new Cvar('v_pitchdrift', '1', Cvar.FLAG.ARCHIVE, 'Vanilla Quake drift pitch when moving forward.');
};
