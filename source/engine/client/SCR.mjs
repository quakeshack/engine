/* global  */

import { gameCapabilities } from '../../shared/Defs.mjs';
import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { eventBus, registry } from '../registry.mjs';
import GL from './GL.mjs';
import VID from './VID.mjs';

let { CL, Con, Draw, Host, Key, M, R, S, Sbar, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  Draw = registry.Draw;
  Host = registry.Host;
  Key = registry.Key;
  M = registry.M;
  R = registry.R;
  S = registry.S;
  Sbar = registry.Sbar;
  V = registry.V;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

const SCR = {};

export default SCR;

eventBus.subscribe('vid.resize', () => {
  SCR.recalc_refdef = true;
});

eventBus.subscribe('server.spawning', () => {
  SCR.centertime_off = 0.0;
});

SCR.con_current = 0;

SCR.centerstring = [];
SCR.centertime_off = 0.0;

SCR._requestedAnimationFrames = 0;

SCR.CenterPrint = function(str) {
  SCR.centerstring = [];
  let i; let start = 0; let next;
  for (i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) {
      next = i + 1;
    } else if ((i - start) >= 40) {
      next = i;
    } else {
      continue;
    }
    SCR.centerstring[SCR.centerstring.length] = str.substring(start, i);
    start = next;
  }
  SCR.centerstring[SCR.centerstring.length] = str.substring(start, i);
  SCR.centertime_off = SCR.centertime.value;
  SCR.centertime_start = CL.state.time;
};

SCR.DrawCenterString = function() {
  SCR.centertime_off -= Host.frametime;
  if (((SCR.centertime_off <= 0.0) && (CL.state.intermission === 0)) || (Key.dest.value !== Key.dest.game)) {
    return;
  }

  let y;
  if (SCR.centerstring.length <= 4) {
    y = Math.floor(VID.height * 0.35);
  } else {
    y = 48;
  }

  let i;
  if (CL.state.intermission) {
    let remaining = Math.floor(SCR.printspeed.value * (CL.state.time - SCR.centertime_start));
    let str; let x; let j;
    for (i = 0; i < SCR.centerstring.length; i++) {
      str = SCR.centerstring[i];
      x = (VID.width - (str.length * 8)) / 2;
      for (j = 0; j < str.length; j++) {
        Draw.Character(x, y, str.charCodeAt(j));
        if ((remaining--) === 0) {
          return;
        }
        x += 8;
      }
      y += 8;
    }
    return;
  }

  for (i = 0; i < SCR.centerstring.length; i++) {
    Draw.String((VID.width - (SCR.centerstring[i].length * 8)) / 2, y, SCR.centerstring[i]);
    y += 8;
  }
};

SCR.CalcRefdef = function() {
  // TODO: we need to emit an event here and the others have to observe (Sbar, R, GL)
  SCR.recalc_refdef = false;

  if (SCR.viewsize.value < 30) {
    Cvar.Set('viewsize', '30');
  } else if (SCR.viewsize.value > 120) {
    Cvar.Set('viewsize', '120');
  }

  let size; let full;
  if (CL.state.intermission !== 0) {
    full = true;
    size = 1.0;
    Sbar.lines = 0;
  } else {
    size = SCR.viewsize.value;
    if (size >= 120.0) {
      Sbar.lines = 0;
    } else if (size >= 110.0) {
      Sbar.lines = 24;
    } else {
      Sbar.lines = 48;
    }
    if (size >= 100.0) {
      full = true;
      size = 100.0;
    }
    size *= 0.01;
  }

  const vrect = R.refdef.vrect;
  vrect.width = Math.floor(VID.width * size);
  if (vrect.width < 96) {
    size = 96.0 / vrect.width;
    vrect.width = 96;
  }
  vrect.height = Math.floor(VID.height * size);
  if (vrect.height > (VID.height - Sbar.lines)) {
    vrect.height = VID.height - Sbar.lines;
  }
  vrect.x = (VID.width - vrect.width) / 2;
  if (full === true) {
    vrect.y = 0;
  } else {
    vrect.y = (VID.height - Sbar.lines - vrect.height) / 2;
  }

  if (SCR.fov.value < 10) {
    Cvar.Set('fov', '10');
  } else if (SCR.fov.value > 170) {
    Cvar.Set('fov', '170');
  }
  if ((vrect.width * 0.75) <= vrect.height) {
    R.refdef.fov_x = SCR.fov.value;
    R.refdef.fov_y = Math.atan(vrect.height / (vrect.width / Math.tan(SCR.fov.value * Math.PI / 360.0))) * 360.0 / Math.PI;
  } else {
    R.refdef.fov_x = Math.atan(vrect.width / (vrect.height / Math.tan(SCR.fov.value * 0.82 * Math.PI / 360.0))) * 360.0 / Math.PI;
    R.refdef.fov_y = SCR.fov.value * 0.82;
  }

  const ymax = 4.0 * Math.tan(R.refdef.fov_y * Math.PI / 360.0);
  R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
  R.perspective[5] = 4.0 / ymax;

  R.warpwidth = (vrect.width * VID.pixelRatio) >> 0;
  R.warpheight = (vrect.height * VID.pixelRatio) >> 0;
  if (R.warpwidth > 2048) {
    R.warpwidth = 2048;
  }
  if (R.warpheight > 2048) {
    R.warpheight = 2048;
  }
  if ((R.oldwarpwidth !== R.warpwidth) || (R.oldwarpheight !== R.warpheight)) {
    R.oldwarpwidth = R.warpwidth;
    R.oldwarpheight = R.warpheight;
    GL.Bind(0, R.warptexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, R.warpwidth, R.warpheight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, R.warprenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, R.warpwidth, R.warpheight);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }
};

SCR.SizeUp_f = function() {
  Cvar.SetValue('viewsize', SCR.viewsize.value + 10);
  SCR.recalc_refdef = true;
};

SCR.SizeDown_f = function() {
  Cvar.SetValue('viewsize', SCR.viewsize.value - 10);
  SCR.recalc_refdef = true;
};

SCR.disableCrosshair = false;

SCR.Init = async function() {
  SCR.fov = new Cvar('fov', '90', Cvar.FLAG.CHEAT); // TODO: move to R?
  SCR.viewsize = new Cvar('viewsize', '100', Cvar.FLAG.ARCHIVE);
  SCR.conspeed = new Cvar('scr_conspeed', '300');
  SCR.showturtle = new Cvar('showturtle', '0');
  SCR.showpause = new Cvar('showpause', '1');
  SCR.centertime = new Cvar('scr_centertime', '2');
  SCR.printspeed = new Cvar('scr_printspeed', '8');
  Cmd.AddCommand('screenshot', SCR.ScreenShot_f);
  Cmd.AddCommand('sizeup', SCR.SizeUp_f);
  Cmd.AddCommand('sizedown', SCR.SizeDown_f);
  SCR.net = Draw.LoadPicFromWad('NET');
  SCR.turtle = Draw.LoadPicFromWad('TURTLE');
  SCR.pause = Draw.LoadPicFromLumpDeferred('pause');
  SCR.crosshair = new Cvar('crosshair', '0', Cvar.FLAG.ARCHIVE);
  SCR.crossx = new Cvar('cl_crossx', '0', Cvar.FLAG.ARCHIVE);
  SCR.crossy = new Cvar('cl_crossy', '0', Cvar.FLAG.ARCHIVE);
  SCR.disableCrosshair = CL.gameCapabilities.includes(gameCapabilities.CAP_HUD_INCLUDES_CROSSHAIR);
};

SCR.count = 0;
SCR.DrawTurtle = function() {
  if (SCR.showturtle.value === 0) {
    return;
  }
  if (Host.frametime < 0.1) {
    SCR.count = 0;
    return;
  }
  if (++SCR.count >= 3) {
    Draw.Pic(R.refdef.vrect.x, R.refdef.vrect.y, SCR.turtle);
  }
};

SCR.DrawNet = function() {
  if (((Host.realtime - CL.state.last_received_message) >= 0.3) && (CL.cls.demoplayback !== true)) {
    Draw.Pic(R.refdef.vrect.x, R.refdef.vrect.y, SCR.net);
  }
};

SCR.DrawPause = function() {
  if ((SCR.showpause.value !== 0) && (CL.state.paused === true)) {
    Draw.Pic((VID.width - SCR.pause.width) / 2, (VID.height - 48 - SCR.pause.height) / 2, SCR.pause);
  }
};

SCR.SetUpToDrawConsole = function() {
  Con.forcedup = (!CL.state.worldmodel) || (CL.cls.signon !== 4);

  if (Con.forcedup === true) {
    SCR.con_current = 200;
    return;
  }

  let conlines;
  if (Key.dest.value === Key.dest.console) {
    conlines = 100;
  } else {
    conlines = 0;
  }

  if (conlines < SCR.con_current) {
    SCR.con_current -= SCR.conspeed.value * Host.frametime;
    if (conlines > SCR.con_current) {
      SCR.con_current = conlines;
    }
  } else if (conlines > SCR.con_current) {
    SCR.con_current += SCR.conspeed.value * Host.frametime;
    if (conlines < SCR.con_current) {
      SCR.con_current = conlines;
    }
  }
};

SCR.DrawConsole = function() {
  if (SCR.con_current > 0) {
    Con.DrawConsole(SCR.con_current);
    return;
  }
  if ((Key.dest.value === Key.dest.game) || (Key.dest.value === Key.dest.message)) {
    Con.DrawNotify();
  }
};

SCR.ScreenShot_f = function() {
  SCR.screenshot = true;
};

SCR.BeginLoadingPlaque = function() {
  S.StopAllSounds();
  if ((CL.cls.state !== CL.active.connected) || (CL.cls.signon !== 4)) {
    return;
  }
  SCR.centertime_off = 0.0;
  SCR.con_current = 0;
  SCR.disabled_for_loading = true;
  SCR.disabled_time = Host.realtime + 60.0;
};

SCR.EndLoadingPlaque = function() {
  Draw.EndDisc();
  SCR.disabled_for_loading = false;
  Con.ClearNotify();
};

SCR.UpdateScreen = function() {
  // if (SCR.disabled_for_loading === true) {
  //   if (Host.realtime <= SCR.disabled_time) {
  //     return;
  //   }
  //   SCR.disabled_for_loading = false;
  //   Con.Print('load failed.\n');
  // }

  if (SCR.oldfov !== SCR.fov.value) {
    SCR.oldfov = SCR.fov.value;
    SCR.recalc_refdef = true;
  }
  if (SCR.oldscreensize !== SCR.viewsize.value) {
    SCR.oldscreensize = SCR.viewsize.value;
    SCR.recalc_refdef = true;
  }
  if (SCR.recalc_refdef === true) {
    SCR.CalcRefdef();
  }

  SCR.SetUpToDrawConsole();

  if (SCR._requestedAnimationFrames > 0) {
    console.assert(SCR._requestedAnimationFrames === 1, 'SCR.UpdateScreen: too many rendering requests active');
    return;
  }

  requestAnimationFrame(() => {
    // we are already shutting down
    if (!gl) {
      return;
    }

    V.RenderView();
    GL.Set2D();
    if (R.dowarp === true) {
      R.WarpScreen();
    }
    if (Con.forcedup !== true) {
      R.PolyBlend();
    }

    if (CL.cls.state === CL.active.connecting) {
      SCR.DrawConsole();
    } else if ((CL.state.intermission === 1) && (Key.dest.value === Key.dest.game)) {
      Sbar.IntermissionOverlay();
    } else if ((CL.state.intermission === 2) && (Key.dest.value === Key.dest.game)) {
      Sbar.FinaleOverlay();
      SCR.DrawCenterString();
    } else if ((CL.state.intermission === 3) && (Key.dest.value === Key.dest.game)) {
      SCR.DrawCenterString();
    } else {
      if (!SCR.disableCrosshair && SCR.crosshair.value !== 0) {
        Draw.Character(R.refdef.vrect.x + (R.refdef.vrect.width / 2) + SCR.crossx.value,
            R.refdef.vrect.y + (R.refdef.vrect.height / 2) + SCR.crossy.value, 43);
      }
      SCR.DrawNet();
      SCR.DrawTurtle();
      SCR.DrawPause();
      SCR.DrawCenterString();
      CL.DrawHUD();
      SCR.DrawConsole();
      CL.Draw();
      M.Draw();
    }

    GL.StreamFlush();

    gl.disable(gl.BLEND);

    SCR._requestedAnimationFrames--;
  });

  SCR._requestedAnimationFrames++;

  if (SCR.screenshot === true) {
    SCR.screenshot = false;
    gl.finish();

    VID.DownloadScreenshot();
  }
};
