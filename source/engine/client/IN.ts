import { K } from '../../shared/Keys.ts';
import Cvar from '../common/Cvar.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import { kbutton, kbuttons } from './ClientInput.ts';
import VID from './VID.ts';

let { CL, COM, Con, Host, Key, V } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, Host, Key, V } = getClientRegistry());
});

export default class IN {
  static mouse_x = 0.0;
  static mouse_y = 0.0;
  static old_mouse_x = 0.0;
  static old_mouse_y = 0.0;
  static m_filter: Cvar;
  static mouse_avail = false;

  static StartupMouse(): void {
    IN.m_filter = new Cvar('m_filter', '1', Cvar.FLAG.ARCHIVE);
    if (COM.CheckParm('-nomouse')) {
      return;
    }
    if (!VID.mainwindow.requestPointerLock) {
      Con.PrintWarning('IN.StartupMouse: Pointer Lock API (requestPointerLock) not available, cannot make use of mouse movement\n');
      return;
    }

    VID.mainwindow.addEventListener('click', IN.onclick);
    document.addEventListener('mousemove', IN.onmousemove);
    document.addEventListener('pointerlockchange', IN.onpointerlockchange);
    IN.mouse_avail = true;
  }

  static Init(): void {
    IN.StartupMouse();
  }

  static Shutdown(): void {
    if (!IN.mouse_avail) {
      return;
    }

    VID.mainwindow.removeEventListener('click', IN.onclick);
    document.removeEventListener('mousemove', IN.onmousemove);
    document.removeEventListener('pointerlockchange', IN.onpointerlockchange);
  }

  static MouseMove(): void {
    if (!IN.mouse_avail) {
      return;
    }

    let mouseX: number;
    let mouseY: number;
    if (IN.m_filter.value !== 0) {
      mouseX = (IN.mouse_x + IN.old_mouse_x) * 0.5;
      mouseY = (IN.mouse_y + IN.old_mouse_y) * 0.5;
    } else {
      mouseX = IN.mouse_x;
      mouseY = IN.mouse_y;
    }
    IN.old_mouse_x = IN.mouse_x;
    IN.old_mouse_y = IN.mouse_y;
    mouseX *= CL.sensitivity.value;
    mouseY *= CL.sensitivity.value;

    const strafe = kbuttons[kbutton.strafe].state & 1;
    const mlook = kbuttons[kbutton.mlook].state & 1;
    const angles = CL.state.viewangles;

    if (strafe !== 0 || (CL.lookstrafe.value !== 0 && mlook !== 0)) {
      CL.state.cmd.sidemove += CL.m_side.value * mouseX;
    } else {
      angles[1] -= CL.m_yaw.value * mouseX;
    }

    if (mlook !== 0) {
      V.StopPitchDrift();
    }

    if (mlook !== 0 && strafe === 0) {
      angles[0] += CL.m_pitch.value * mouseY;
      if (angles[0] > 80.0) {
        angles[0] = 80.0;
      } else if (angles[0] < -70.0) {
        angles[0] = -70.0;
      }
    } else if (strafe !== 0 && Host.noclip_anglehack === true) {
      CL.state.cmd.upmove -= CL.m_forward.value * mouseY;
    } else {
      CL.state.cmd.forwardmove -= CL.m_forward.value * mouseY;
    }

    IN.mouse_x = 0;
    IN.mouse_y = 0;
  }

  static Move(): void {
    // do not interpret input during demo playback
    if (CL.cls.demoplayback) {
      return;
    }

    IN.MouseMove();
  }

  static onclick(): void {
    if (document.pointerLockElement !== VID.mainwindow) {
      void VID.mainwindow.requestPointerLock();
    }
  }

  static onmousemove(event: MouseEvent): void {
    if (document.pointerLockElement !== VID.mainwindow) {
      return;
    }

    IN.mouse_x += event.movementX;
    IN.mouse_y += event.movementY;
  }

  static onpointerlockchange(): void {
    if (document.pointerLockElement === VID.mainwindow) {
      return;
    }

    Key.Event(K.ESCAPE, true);
    Key.Event(K.ESCAPE);
  }
}
