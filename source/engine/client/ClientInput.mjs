import Vector from '../../shared/Vector.mjs';
import * as Protocol from '../network/Protocol.mjs';
import Q from '../common/Q.mjs';
import MSG, { SzBuffer } from '../network/MSG.mjs';
import Cmd from '../common/Cmd.mjs';
import { eventBus, registry } from '../registry.mjs';

let { Con, CL, Host, NET, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  CL = registry.CL;
  Host = registry.Host;
  NET = registry.NET;
  V = registry.V;
});

/**
 * @enum {number}
 * @readonly
 */
export const kbutton = Object.freeze({
    mlook: 0,
    klook: 1,
    left: 2,
    right: 3,
    forward: 4,
    back: 5,
    lookup: 6,
    lookdown: 7,
    moveleft: 8,
    moveright: 9,
    strafe: 10,
    speed: 11,
    use: 12,
    jump: 13,
    attack: 14,
    moveup: 15,
    movedown: 16,
});

/** @type {{down: number[], state: number}[]} */
export const kbuttons = new Array(Object.keys(kbutton).length);

export default class ClientInput {
  static impulse = 0;

  static KeyDown_f(cmd) { // private
    let b = kbutton[this.command.substring(1)];
    if (b === undefined) {
      return;
    }
    b = kbuttons[b];

    let k;
    if (cmd !== undefined) {
      k = Q.atoi(cmd);
    } else {
      k = -1;
    }

    if ((k === b.down[0]) || (k === b.down[1])) {
      return;
    }

    if (b.down[0] === 0) {
      b.down[0] = k;
    } else if (b.down[1] === 0) {
      b.down[1] = k;
    } else {
      Con.Print('Three keys down for a button!\n');
      return;
    }

    if ((b.state & 1) === 0) {
      b.state |= 3;
    }
  }

  static KeyUp_f(cmd) { // private
    let b = kbutton[this.command.substring(1)];

    if (b === undefined) {
      return;
    }

    b = kbuttons[b];

    let k;
    if (cmd !== undefined) {
      k = Q.atoi(cmd);
    } else {
      b.down[0] = b.down[1] = 0;
      b.state = 4;
      return;
    }

    if (b.down[0] === k) {
      b.down[0] = 0;
    } else if (b.down[1] === k) {
      b.down[1] = 0;
    } else {
      return;
    }
    if ((b.down[0] !== 0) || (b.down[1] !== 0)) {
      return;
    }

    if ((b.state & 1) !== 0) {
      b.state = (b.state - 1) | 4;
    }
  }

  static MLookUp_f(cmd) { // private
    ClientInput.KeyUp_f.call(this, cmd);

    if (((kbuttons[kbutton.mlook].state & 1) === 0) && (CL.lookspring.value !== 0)) {
      V.StartPitchDrift();
    }
  }

  static Impulse_f(code) { // private
    if (code === undefined) {
      Con.Print('Usage: impulse <code>\n');
      return;
    }

    ClientInput.impulse = Q.atoi(code);
  }

  static KeyState(key) { // private
    key = kbuttons[key];
    const down = key.state & 1;
    key.state &= 1;
    if ((key.state & 2) !== 0) {
      if ((key.state & 4) !== 0) {
        return (down !== 0) ? 0.75 : 0.25;
      }
      return (down !== 0) ? 0.5 : 0.0;
    }
    if ((key.state & 4) !== 0) {
      return 0.0;
    }
    return (down !== 0) ? 1.0 : 0.0;
  }

  static AdjustAngles() { // private
    let speed = Host.frametime;
    if ((kbuttons[kbutton.speed].state & 1) !== 0) {
      speed *= CL.anglespeedkey.value;
    }

    const angles = CL.state.viewangles;

    if ((kbuttons[kbutton.strafe].state & 1) === 0) {
      angles[1] += speed * CL.yawspeed.value * (ClientInput.KeyState(kbutton.left) - ClientInput.KeyState(kbutton.right));
      angles[1] = Vector.anglemod(angles[1]);
    }
    if ((kbuttons[kbutton.klook].state & 1) !== 0) {
      V.StopPitchDrift();
      angles[0] += speed * CL.pitchspeed.value * (ClientInput.KeyState(kbutton.back) - ClientInput.KeyState(kbutton.forward));
    }

    const up = ClientInput.KeyState(kbutton.lookup); const down = ClientInput.KeyState(kbutton.lookdown);
    if ((up !== 0.0) || (down !== 0.0)) {
      angles[0] += speed * CL.pitchspeed.value * (down - up);
      V.StopPitchDrift();
    }

    if (angles[0] > 80.0) {
      angles[0] = 80.0;
    } else if (angles[0] < -70.0) {
      angles[0] = -70.0;
    }

    if (angles[2] > 50.0) {
      angles[2] = 50.0;
    } else if (angles[2] < -50.0) {
      angles[2] = -50.0;
    }
  }

  static BaseMove() { // private
    if (CL.cls.signon !== 4) {
      return;
    }

    ClientInput.AdjustAngles();

    const cmd = CL.state.cmd;

    cmd.sidemove = CL.sidespeed.value * (ClientInput.KeyState(kbutton.moveright) - ClientInput.KeyState(kbutton.moveleft));
    if ((kbuttons[kbutton.strafe].state & 1) !== 0) {
      cmd.sidemove += CL.sidespeed.value * (ClientInput.KeyState(kbutton.right) - ClientInput.KeyState(kbutton.left));
    }

    cmd.upmove = CL.upspeed.value * (ClientInput.KeyState(kbutton.moveup) - ClientInput.KeyState(kbutton.movedown));

    if ((kbuttons[kbutton.klook].state & 1) === 0) {
      cmd.forwardmove = CL.forwardspeed.value * ClientInput.KeyState(kbutton.forward) - CL.backspeed.value * ClientInput.KeyState(kbutton.back);
    } else {
      cmd.forwardmove = 0.0;
    }

    if ((kbuttons[kbutton.speed].state & 1) !== 0) {
      cmd.forwardmove *= CL.movespeedkey.value;
      cmd.sidemove *= CL.movespeedkey.value;
      cmd.upmove *= CL.movespeedkey.value;
    }

    cmd.impulse = ClientInput.impulse;
    cmd.angles.set(CL.state.viewangles);
    // TODO: cmd.msec =

    ClientInput.impulse = 0;
  }

  static SendMove() { // private
    CL.state.cmd.buttons = 0;

    if ((kbuttons[kbutton.attack].state & 3) !== 0) {
      CL.state.cmd.buttons |= Protocol.button.attack;
    }
    kbuttons[kbutton.attack].state &= 5;

    if ((kbuttons[kbutton.jump].state & 3) !== 0) {
      CL.state.cmd.buttons |= Protocol.button.jump;
    }
    kbuttons[kbutton.jump].state &= 5;

    if ((kbuttons[kbutton.use].state & 3) !== 0) {
      CL.state.cmd.buttons |= Protocol.button.use;
    }
    kbuttons[kbutton.use].state &= 5;

    if (CL.state.cmd.equals(CL.state.lastcmd)) {
      return; // nothing new happened
    }

    const buf = new SzBuffer(16);
    MSG.WriteByte(buf, Protocol.clc.move);
    MSG.WriteFloat(buf, CL.state.mtime[0]);
    MSG.WriteAngleVector(buf, CL.state.cmd.angles);
    MSG.WriteShort(buf, CL.state.cmd.forwardmove);
    MSG.WriteShort(buf, CL.state.cmd.sidemove);
    MSG.WriteShort(buf, CL.state.cmd.upmove);
    MSG.WriteByte(buf, CL.state.cmd.buttons);
    MSG.WriteByte(buf, CL.state.cmd.impulse);

    if (CL.cls.demoplayback === true) {
      return;
    }
    if (++CL.state.movemessages <= 2) {
      return;
    }
    CL.state.lastcmd.set(CL.state.cmd);
    if (NET.SendUnreliableMessage(CL.cls.netcon, buf) === -1) {
      Con.Print('CL.SendMove: lost server connection\n');
      Host.Error('lost server connection');
    }
  }

  static Init() {
    const commands = ['moveup', 'movedown', 'left', 'right',
      'forward', 'back', 'lookup', 'lookdown',
      'strafe', 'moveleft', 'moveright', 'speed',
      'attack', 'use', 'jump', 'klook',
    ];

    for (let i = 0; i < commands.length; i++) {
      Cmd.AddCommand('+' + commands[i], ClientInput.KeyDown_f);
      Cmd.AddCommand('-' + commands[i], ClientInput.KeyUp_f);
    }

    Cmd.AddCommand('impulse', ClientInput.Impulse_f);
    Cmd.AddCommand('+mlook', ClientInput.KeyDown_f);
    Cmd.AddCommand('-mlook', ClientInput.MLookUp_f);

    for (let i = 0; i < Object.keys(kbutton).length; i++) {
      kbuttons[i] = {
        down: [0, 0],
        state: 0,
      };
    }
  }
};
