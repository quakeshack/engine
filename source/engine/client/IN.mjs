import Cvar from '../common/Cvar.mjs';
import { eventBus, registry } from '../registry.mjs';
import { kbutton, kbuttons } from './ClientInput.mjs';
import VID from './VID.mjs';

let { CL, COM, Con, Host, Key, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Key = registry.Key;
  V = registry.V;
});

const IN = {};

export default IN;

IN.mouse_x = 0.0;
IN.mouse_y = 0.0;
IN.old_mouse_x = 0.0;
IN.old_mouse_y = 0.0;

IN.StartupMouse = function() {
  IN.m_filter = new Cvar('m_filter', '1', Cvar.FLAG.ARCHIVE);
  if (COM.CheckParm('-nomouse')) {
    return;
  }
  if (VID.mainwindow.requestPointerLock != null) {
    IN.movementX = 'movementX';
    IN.movementY = 'movementY';
    IN.pointerLockElement = 'pointerLockElement';
    IN.requestPointerLock = 'requestPointerLock';
    IN.pointerlockchange = 'onpointerlockchange';
  } else if (VID.mainwindow.webkitRequestPointerLock != null) {
    IN.movementX = 'webkitMovementX';
    IN.movementY = 'webkitMovementY';
    IN.pointerLockElement = 'webkitPointerLockElement';
    IN.requestPointerLock = 'webkitRequestPointerLock';
    IN.pointerlockchange = 'onwebkitpointerlockchange';
  } else if (VID.mainwindow.mozRequestPointerLock != null) {
    IN.movementX = 'mozMovementX';
    IN.movementY = 'mozMovementY';
    IN.pointerLockElement = 'mozPointerLockElement';
    IN.requestPointerLock = 'mozRequestPointerLock';
    IN.pointerlockchange = 'onmozpointerlockchange';
  } else {
    return;
  }
  VID.mainwindow.onclick = IN.onclick;
  document.onmousemove = IN.onmousemove;
  document[IN.pointerlockchange] = IN.onpointerlockchange;
  IN.mouse_avail = true;
};

IN.StartupTouchpad = function() {
  const $leftZone = document.getElementById('left-zone');
  const $rightZone = document.getElementById('right-zone');

  if (!$leftZone || !$rightZone) {
    Con.Print('IN.StartupTouchpad: virtual joystick zones missing\n');
    return;
  }

  // disabled for now, we need proper feature selection for this
  return;

  // if (!window.matchMedia("(pointer: coarse)").matches) {
  //   return;
  // }

  // Con.Print(`IN.StartupTouchpad: detected coarse input, setting up virtual joysticks\n`);

  // // Create a semi-joystick in the left zone
  // const moveJoystick = nipplejs.create({
  //   zone: $leftZone,
  //   mode: 'semi',          // 'semi' means the joystick follows your finger in that zone
  //   size: 100,             // Diameter of the joystick
  //   threshold: 0.5,        // Before triggering movement events
  //   color: 'white',
  //   fadeTime: 250,         // How quickly the joystick fades out after release
  //   reset: true,
  // });

  // // Create a semi-joystick in the right zone
  // const lookJoystick = nipplejs.create({
  //   zone: document.getElementById('right-zone'),
  //   mode: 'semi',
  //   size: 100,
  //   threshold: 0.5,
  //   color: 'white',
  //   fadeTime: 250,
  //   reset: true,
  // });

  // const touchpadData = {
  //   move: {
  //     vector: [0.0, 0.0],
  //     force: 0.0,
  //   },
  //   look: {
  //     vector: [0.0, 0.0],
  //     force: 0.0,
  //   },
  // };

  // moveJoystick.on('move', (evt, data) => {
  //   const d = touchpadData.move;

  //   d.vector[0] = data.vector.x * data.distance;
  //   d.vector[1] = data.vector.y * data.distance;

  //   IN.moveJoystick = data;
  // });

  // moveJoystick.on('end', () => {
  //   const d = touchpadData.move;

  //   d.vector[0] = 0.0;
  //   d.vector[1] = 0.0;
  //   d.force = 0.0;
  // });

  // lookJoystick.on('move', (evt, data) => {
  //   const d = touchpadData.look;

  //   d.vector[0] = data.vector.x * data.distance;
  //   d.vector[1] = data.vector.y * data.distance;

  //   IN.lookJoystick = data;
  // });

  // lookJoystick.on('end', () => {
  //   const d = touchpadData.look;
  //   d.vector[0] = 0.0;
  //   d.vector[1] = 0.0;
  //   d.force = 0.0;
  // });

  // IN._touchpadData = touchpadData;

  // $leftZone.style.display = 'block';
  // $rightZone.style.display = 'block';
};

IN._TouchpadHandleLook = function() {
  const pitch = CL.m_pitch.value;
  const yaw = CL.m_yaw.value;

  const sensitivity = 1.5; // IN._touchpadData.look.force;
  const vector = IN._touchpadData.look.vector;
  const angles = CL.state.viewangles;

  angles[0] -= vector[1] * sensitivity * pitch;
  angles[1] -= vector[0] * sensitivity * 2 * yaw;

  if (angles[0] > 80.0) {
    angles[0] = 80.0;
  } else if (angles[0] < -70.0) {
    angles[0] = -70.0;
  }
};

IN._TouchpadHandleMove = function() {
  const forward = CL.m_forward.value;
  const side = CL.m_side.value;
  const sensitivity = 10; // IN._touchpadData.look.force;
  const vector = IN._touchpadData.move.vector;

  CL.state.cmd.sidemove = side * vector[0] * sensitivity;
  CL.state.cmd.forwardmove = forward * vector[1] * sensitivity;
};

IN.TouchpadMove = function() {
  if (IN._touchpadData) {
    IN._TouchpadHandleLook();
    IN._TouchpadHandleMove();
  }
};

IN.Init = function() {
  IN.StartupMouse();
  IN.StartupTouchpad();
};

IN.Shutdown = function() {
  if (IN.mouse_avail === true) {
    VID.mainwindow.onclick = null;
    document.onmousemove = null;
    document[IN.pointerlockchange] = null;
  }
};

IN.MouseMove = function() {
  if (IN.mouse_avail !== true) {
    return;
  }

  let mouse_x; let mouse_y;
  if (IN.m_filter.value !== 0) {
    mouse_x = (IN.mouse_x + IN.old_mouse_x) * 0.5;
    mouse_y = (IN.mouse_y + IN.old_mouse_y) * 0.5;
  } else {
    mouse_x = IN.mouse_x;
    mouse_y = IN.mouse_y;
  }
  IN.old_mouse_x = IN.mouse_x;
  IN.old_mouse_y = IN.mouse_y;
  mouse_x *= CL.sensitivity.value;
  mouse_y *= CL.sensitivity.value;

  const strafe = kbuttons[kbutton.strafe].state & 1;
  const mlook = kbuttons[kbutton.mlook].state & 1;
  const angles = CL.state.viewangles;

  if ((strafe !== 0) || ((CL.lookstrafe.value !== 0) && (mlook !== 0))) {
    CL.state.cmd.sidemove += CL.m_side.value * mouse_x;
  } else {
    angles[1] -= CL.m_yaw.value * mouse_x;
  }

  if (mlook !== 0) {
    V.StopPitchDrift();
  }

  if ((mlook !== 0) && (strafe === 0)) {
    angles[0] += CL.m_pitch.value * mouse_y;
    if (angles[0] > 80.0) {
      angles[0] = 80.0;
    } else if (angles[0] < -70.0) {
      angles[0] = -70.0;
    }
  } else {
    if ((strafe !== 0) && (Host.noclip_anglehack === true)) {
      CL.state.cmd.upmove -= CL.m_forward.value * mouse_y;
    } else {
      CL.state.cmd.forwardmove -= CL.m_forward.value * mouse_y;
    }
  }

  IN.mouse_x = IN.mouse_y = 0;
};

IN.Move = function() {
  IN.MouseMove();
  IN.TouchpadMove();
};

IN.onclick = function() {
  if (document[IN.pointerLockElement] !== this) {
    this[IN.requestPointerLock]();
  }
};

IN.onmousemove = function(e) {
  if (document[IN.pointerLockElement] !== VID.mainwindow) {
    return;
  }
  IN.mouse_x += e[IN.movementX];
  IN.mouse_y += e[IN.movementY];
};

IN.onpointerlockchange = function() {
  if (document[IN.pointerLockElement] === VID.mainwindow) {
    return;
  }
  Key.Event(Key.k.escape, true);
  Key.Event(Key.k.escape);
};
