import { gameCapabilities } from '../../shared/Defs.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import { KeyDestination } from './Key.ts';
import GL from './GL.ts';
import VID from './VID.ts';
import PostProcess from './renderer/PostProcess.ts';

let { CL, Con, Draw, Host, Key, M, R, S, Sbar, V } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, Draw, Host, Key, M, R, S, Sbar, V } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

eventBus.subscribe('vid.resize', () => {
  SCR.recalc_refdef = true;
});

eventBus.subscribe('server.spawning', () => {
  SCR.centertime_off = 0.0;
});

export default class SCR {
  static con_current = 0;
  static centerstring: string[] = [];
  static centertime_off = 0.0;
  static centertime_start = 0;

  static _requestedAnimationFrames = 0;

  static recalc_refdef = false;
  static disabled_for_loading = false;
  static disabled_time = 0;
  static screenshot = false;

  /** True when the crosshair should be suppressed (e.g. HUD includes its own crosshair). */
  static disableCrosshair = false;

  static count = 0;
  static FPS = 0;

  static _lastAnimationTime = 0;
  static _frameTimes: (number | null)[] = new Array(30).fill(null);
  static _frameTimeIndex = 0;

  // Tracked to detect changes and trigger refdef recalculation
  static oldfov = 0;
  static oldscreensize = 0;

  // Cvars — initialized in Init()
  static fov: Cvar = null!;
  static viewsize: Cvar = null!;
  static conspeed: Cvar = null!;
  static showturtle: Cvar = null!;
  static showpause: Cvar = null!;
  static centertime: Cvar = null!;
  static printspeed: Cvar = null!;
  static crosshair: Cvar = null!;
  static crossx: Cvar = null!;
  static crossy: Cvar = null!;

  // Textures — initialized in Init()
  static net: ReturnType<typeof Draw.LoadPicFromWad> = null!;
  static turtle: ReturnType<typeof Draw.LoadPicFromWad> = null!;
  static pause: ReturnType<typeof Draw.LoadPicFromLumpDeferred> = null!;

  /**
   * Formats a center-print string into wrapped lines and starts the display timer.
   */
  static CenterPrint(str: string): void {
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
      start = next!;
    }
    SCR.centerstring[SCR.centerstring.length] = str.substring(start, i);
    SCR.centertime_off = SCR.centertime.value;
    SCR.centertime_start = CL.state.time;
  }

  /**
   * Draws the center-print string to the screen, advancing the typewriter for intermissions.
   */
  static DrawCenterString(): void {
    SCR.centertime_off -= Host.frametime;
    if (((SCR.centertime_off <= 0.0) && (CL.state.intermission === 0)) || (Key.destination !== KeyDestination.game)) {
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
        x = (VID.width - (str.length * 16)) / 2;
        for (j = 0; j < str.length; j++) {
          Draw.Character(x, y, str.charCodeAt(j), 2.0);
          if ((remaining--) === 0) {
            return;
          }
          x += 16;
        }
        y += 16;
      }
      return;
    }

    for (i = 0; i < SCR.centerstring.length; i++) {
      Draw.String((VID.width - (SCR.centerstring[i].length * 16)) / 2, y, SCR.centerstring[i], 2.0);
      y += 16;
    }
  }

  /**
   * Recalculates the 3D viewport rectangle and FOV from the current cvars.
   */
  static CalcRefdef(): void {
    SCR.recalc_refdef = false;

    if (SCR.viewsize.value < 30) {
      Cvar.Set('viewsize', '30');
    } else if (SCR.viewsize.value > 120) {
      Cvar.Set('viewsize', '120');
    }

    let size = 0.0, full = false;
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
    if (full) {
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
  }

  /** Console command: increases the view size. */
  static SizeUp_f(): void {
    Cvar.Set('viewsize', SCR.viewsize.value + 10);
    SCR.recalc_refdef = true;
  }

  /** Console command: decreases the view size. */
  static SizeDown_f(): void {
    Cvar.Set('viewsize', SCR.viewsize.value - 10);
    SCR.recalc_refdef = true;
  }

  /**
   * Initializes the SCR system: registers cvars, commands, and loads textures.
   */
  static Init(): void {
    SCR.fov = new Cvar('fov', '90', Cvar.FLAG.CHEAT); // TODO: move to R?
    SCR.viewsize = new Cvar('viewsize', '120', Cvar.FLAG.ARCHIVE);
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
  }

  /** Draws the low-frame-rate turtle indicator. */
  static DrawTurtle(): void {
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
  }

  /** Draws the network-lag indicator when packets are delayed. */
  static DrawNet(): void {
    if ((Host.realtime - CL.state.last_received_message >= 0.3) && !CL.cls.demoplayback) {
      Draw.Pic(R.refdef.vrect.x, R.refdef.vrect.y, SCR.net);
    }
  }

  /** Draws the pause indicator when the game is paused. */
  static DrawPause(): void {
    if (SCR.showpause.value !== 0 && CL.state.paused) {
      Draw.Pic((VID.width - SCR.pause.width * 2) / 2, (VID.height - 48 - SCR.pause.height * 2) / 2, SCR.pause, 2);
    }
  }

  /**
   * Determines whether the console should be drawn full-screen (forcedup) or at the configured slide height.
   */
  static SetUpToDrawConsole(): void {
    Con.forcedup = (!CL.state.worldmodel) || (CL.cls.signon !== 4);

    if (Con.forcedup) {
      SCR.con_current = 200;
      return;
    }

    let conlines;
    if (Key.destination === KeyDestination.console) {
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
  }

  /**
   * Draws the console or, if it is hidden, the notify messages.
   */
  static DrawConsole(): void {
    if (SCR.con_current > 0) {
      Con.DrawConsole(SCR.con_current);
      return;
    }
    if ((Key.destination === KeyDestination.game || Key.destination === KeyDestination.message) && CL.cls.signon === 4) {
      Con.DrawNotify();
    }
  }

  /** Requests a screenshot on the next rendered frame. */
  static ScreenShot_f(): void {
    SCR.screenshot = true;
  }

  /** Stops all sounds and blanks the display while a map is loading. */
  static BeginLoadingPlaque(): void {
    S.StopAllSounds();
    if ((CL.cls.state !== clientConnectionState.connected) || (CL.cls.signon !== 4)) {
      return;
    }
    SCR.centertime_off = 0.0;
    SCR.con_current = 0;
    SCR.disabled_for_loading = true;
    SCR.disabled_time = Host.realtime + 60.0;
  }

  /** Unhides the display and clears console notifications after loading completes. */
  static EndLoadingPlaque(): void {
    Draw.EndDisc();
    SCR.disabled_for_loading = false;
    Con.ClearNotify();
  }

  /**
   * Drives one render frame: updates the refdef, dispatches the rAF callback,
   * and optionally captures a screenshot.
   */
  static UpdateScreen(): void {
    if (SCR.oldfov !== SCR.fov.value) {
      SCR.oldfov = SCR.fov.value;
      SCR.recalc_refdef = true;
    }
    if (SCR.oldscreensize !== SCR.viewsize.value) {
      SCR.oldscreensize = SCR.viewsize.value;
      SCR.recalc_refdef = true;
    }
    if (SCR.recalc_refdef) {
      SCR.CalcRefdef();
    }

    SCR.SetUpToDrawConsole();

    if (SCR._requestedAnimationFrames > 0) {
      console.assert(SCR._requestedAnimationFrames === 1, 'SCR.UpdateScreen: too many rendering requests active');
      return;
    }

    V.PreRenderView(); // do some calculations independent of rendering

    requestAnimationFrame((animationTime) => {
      // we are already shutting down
      if ((gl as WebGL2RenderingContext | null) === null) {
        return;
      }

      if (SCR._lastAnimationTime > 0) {
        SCR._frameTimes[SCR._frameTimeIndex] = animationTime - SCR._lastAnimationTime;
        SCR._frameTimeIndex = (SCR._frameTimeIndex + 1) % SCR._frameTimes.length;

        const samples = SCR._frameTimes.filter((a): a is number => a !== null);
        SCR.FPS = 1000 / (samples.reduce((a, b) => a + b, 0) / samples.length);

        if (Host.refreshrate!.value === 0 && Host.framecount > SCR._frameTimes.length * 10) {
          const refreshRate = (Math.ceil(SCR.FPS / 15)) * 15;
          Con.DPrint(`Determined refresh rate: ${Math.round(SCR.FPS)} FPS\n`);
          Con.DPrint(`Setting Host refreshrate to ${Math.round(refreshRate)}\n`);
          Host.refreshrate!.set(Math.round(refreshRate));
        }
      }

      SCR._lastAnimationTime = animationTime;

      V.RenderView();
      GL.Set2D();
      if (R.usePostProcess || PostProcess.hasActiveEffects()) {
        PostProcess.end();
        console.assert(PostProcess.colorTexture !== null, 'PostProcess color texture is not set');
        PostProcess.resolve(
          R.refdef.vrect.x, R.refdef.vrect.y,
          R.refdef.vrect.width, R.refdef.vrect.height,
          PostProcess.colorTexture!,
        );

        const bloomEffect = PostProcess.getEffect('bloom');
        if (bloomEffect && bloomEffect.active && R.bloomDebug && R.bloomDebug.value !== 0) {
          bloomEffect.drawDebugPreview();
        }
      }
      if (!Con.forcedup) {
        R.PolyBlend();
      }

      if (CL.cls.state === clientConnectionState.connecting) {
        CL.Draw();
      } else if ((CL.state.intermission === 1) && (Key.destination === KeyDestination.game)) {
        if (!CL.sbarDisabled) {
          Sbar.IntermissionOverlay();
        } else {
          CL.DrawHUD();
        }
      } else if ((CL.state.intermission === 2) && (Key.destination === KeyDestination.game)) {
        if (!CL.sbarDisabled) {
          Sbar.FinaleOverlay();
          SCR.DrawCenterString();
        } else {
          CL.DrawHUD();
        }
      } else if ((CL.state.intermission === 3) && (Key.destination === KeyDestination.game)) {
        if (!CL.sbarDisabled) {
          SCR.DrawCenterString();
        } else {
          CL.DrawHUD();
        }
      } else {
        if (!SCR.disableCrosshair && SCR.crosshair.value !== 0) {
          Draw.Character(R.refdef.vrect.x + (R.refdef.vrect.width / 2) + SCR.crossx.value,
            R.refdef.vrect.y + (R.refdef.vrect.height / 2) + SCR.crossy.value, 43);
        }
        SCR.DrawNet();
        SCR.DrawTurtle();
        SCR.DrawPause();
        SCR.DrawCenterString();
        if (CL.cls.signon === 4) {
          CL.DrawHUD();
        }
        SCR.DrawConsole();
        CL.Draw();
        M.Draw();
      }

      GL.StreamFlush();

      R.PrintSpeeds();

      gl.disable(gl.BLEND);

      SCR._requestedAnimationFrames--;
    });

    SCR._requestedAnimationFrames++;

    if (SCR.screenshot) {
      SCR.screenshot = false;
      gl.finish();

      VID.DownloadScreenshot();
    }
  }
}
