import Vector from '../../shared/Vector.ts';
import * as Protocol from '../network/Protocol.ts';
import Q from '../../shared/Q.ts';
import { SzBuffer } from '../network/MSG.ts';
import Cmd, { type ConsoleCommand } from '../common/Cmd.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import { HostError } from '../common/Errors.ts';

interface KButtonState {
  down: [number, number];
  state: number;
}

/**
 * Legacy key button indices.
 */
export enum kbutton {
  mlook = 0,
  klook = 1,
  left = 2,
  right = 3,
  forward = 4,
  back = 5,
  lookup = 6,
  lookdown = 7,
  moveleft = 8,
  moveright = 9,
  strafe = 10,
  speed = 11,
  use = 12,
  jump = 13,
  attack = 14,
  moveup = 15,
  movedown = 16,
}

const kbuttonByName = Object.freeze({
  mlook: kbutton.mlook,
  klook: kbutton.klook,
  left: kbutton.left,
  right: kbutton.right,
  forward: kbutton.forward,
  back: kbutton.back,
  lookup: kbutton.lookup,
  lookdown: kbutton.lookdown,
  moveleft: kbutton.moveleft,
  moveright: kbutton.moveright,
  strafe: kbutton.strafe,
  speed: kbutton.speed,
  use: kbutton.use,
  jump: kbutton.jump,
  attack: kbutton.attack,
  moveup: kbutton.moveup,
  movedown: kbutton.movedown,
});

const KBUTTON_COUNT = Object.keys(kbuttonByName).length;

let { CL, Con, Host, NET, V } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, Host, NET, V } = getClientRegistry());
});

/**
 * Resolves a console command suffix to a legacy button index.
 * @returns Button index or null when the name is unknown.
 */
function getButtonIndex(name: string): kbutton | null {
  return kbuttonByName[name as keyof typeof kbuttonByName] ?? null;
}

export const kbuttons: KButtonState[] = new Array(KBUTTON_COUNT);

export default class ClientInput {
  static impulse = 0;

  private static KeyDown_f(this: ConsoleCommand, cmd?: string): void {
    const command = this.command;
    if (command === null) {
      return;
    }

    const buttonIndex = getButtonIndex(command.substring(1));
    if (buttonIndex === null) {
      return;
    }

    const button = kbuttons[buttonIndex];

    const key = cmd !== undefined ? Q.atoi(cmd) : -1;

    if (key === button.down[0] || key === button.down[1]) {
      return;
    }

    if (button.down[0] === 0) {
      button.down[0] = key;
    } else if (button.down[1] === 0) {
      button.down[1] = key;
    } else {
      Con.DPrint('Three keys down for a button!\n');
      return;
    }

    if ((button.state & 1) === 0) {
      button.state |= 3;
    }
  }

  private static KeyUp_f(this: ConsoleCommand, cmd?: string): void {
    const command = this.command;
    if (command === null) {
      return;
    }

    const buttonIndex = getButtonIndex(command.substring(1));
    if (buttonIndex === null) {
      return;
    }

    const button = kbuttons[buttonIndex];

    if (cmd === undefined) {
      button.down[0] = 0;
      button.down[1] = 0;
      button.state = 4;
      return;
    }

    const key = Q.atoi(cmd);

    if (button.down[0] === key) {
      button.down[0] = 0;
    } else if (button.down[1] === key) {
      button.down[1] = 0;
    } else {
      return;
    }

    if (button.down[0] !== 0 || button.down[1] !== 0) {
      return;
    }

    if ((button.state & 1) !== 0) {
      button.state = (button.state - 1) | 4;
    }
  }

  private static MLookUp_f(this: ConsoleCommand, cmd?: string): void {
    ClientInput.KeyUp_f.call(this, cmd);

    if (((kbuttons[kbutton.mlook].state & 1) === 0) && (CL.lookspring.value !== 0)) {
      V.StartPitchDrift();
    }
  }

  private static Impulse_f(code?: string): void {
    if (code === undefined) {
      Con.Print('Usage: impulse <code>\n');
      return;
    }

    ClientInput.impulse = Q.atoi(code);
  }

  private static KeyState(key: kbutton): number {
    const button = kbuttons[key];
    const down = button.state & 1;
    button.state &= 1;
    if ((button.state & 2) !== 0) {
      if ((button.state & 4) !== 0) {
        return down !== 0 ? 0.75 : 0.25;
      }
      return down !== 0 ? 0.5 : 0.0;
    }
    if ((button.state & 4) !== 0) {
      return 0.0;
    }
    return down !== 0 ? 1.0 : 0.0;
  }

  private static AdjustAngles(): void {
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

    const up = ClientInput.KeyState(kbutton.lookup);
    const down = ClientInput.KeyState(kbutton.lookdown);
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

  static BaseMove(): void {
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
    cmd.msec = CL.state.time;

    ClientInput.impulse = 0;
  }

  static SendMove(): void {
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

    // --- prediction: always buffer the current command ---
    const msec = Math.min(255, Math.max(1, Math.round(Host.frametime * 1000.0)));
    CL.state.cmd.msec = msec;
    CL.state.moveSequence = (CL.state.moveSequence + 1) & 0xFF;
    const slot = CL.state.cmdBuffer[CL.state.moveSequence & Protocol.CMD_BUFFER_MASK];
    slot.cmd.set(CL.state.cmd);
    slot.msec = msec;

    const buf = new SzBuffer(20);
    buf.writeByte(Protocol.clc.move);
    buf.writeByte(msec);
    buf.writeAngleVector(CL.state.cmd.angles);
    buf.writeShort(CL.state.cmd.forwardmove);
    buf.writeShort(CL.state.cmd.sidemove);
    buf.writeShort(CL.state.cmd.upmove);
    buf.writeByte(CL.state.cmd.buttons);
    buf.writeByte(CL.state.cmd.impulse);
    buf.writeByte(CL.state.moveSequence);

    if (CL.cls.demoplayback === true) {
      return;
    }
    if (++CL.state.movemessages <= 2) {
      return;
    }
    CL.state.lastcmd.set(CL.state.cmd);
    if (NET.SendUnreliableMessage(CL.cls.netcon, buf) === -1) {
      Con.DPrint('CL.SendMove: lost server connection\n');
      throw new HostError('lost server connection');
    }
  }

  static Init(): void {
    const commands = [
      'moveup', 'movedown', 'left', 'right',
      'forward', 'back', 'lookup', 'lookdown',
      'strafe', 'moveleft', 'moveright', 'speed',
      'attack', 'use', 'jump', 'klook',
    ];

    for (let index = 0; index < commands.length; index++) {
      Cmd.AddCommand(`+${commands[index]}`, ClientInput.KeyDown_f);
      Cmd.AddCommand(`-${commands[index]}`, ClientInput.KeyUp_f);
    }

    Cmd.AddCommand('impulse', ClientInput.Impulse_f);
    Cmd.AddCommand('+mlook', ClientInput.KeyDown_f);
    Cmd.AddCommand('-mlook', ClientInput.MLookUp_f);

    for (let index = 0; index < KBUTTON_COUNT; index++) {
      kbuttons[index] = {
        down: [0, 0],
        state: 0,
      };
    }
  }
}
