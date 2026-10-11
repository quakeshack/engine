import Cmd from '../../common/Cmd.ts';
import Cvar from '../../common/Cvar.ts';
import { eventBus } from '../../common/EventBus.ts';
import { clientRuntimeState } from '../ClientState.ts';
import Camera from '../renderer/scene/Camera.ts';
import VID from '../VID.ts';
import viewCvars from './ViewCvars.ts';

eventBus.subscribe('vid.resize', () => {
  Viewport.Invalidate();
});

/**
 * Where the 3D view is on the screen: its rectangle and the field of view that fits it, from the `viewsize` and
 * `fov` variables, the size of the screen and whether an intermission is on. It writes them into `Camera.refdef`
 * and the projection matrix, and keeps the height the game's HUD asks for (`hudReservedHeight`) free below it.
 */
export default class Viewport {
  /** Bottom-of-screen pixels reserved for HUD elements at the current view size. */
  static hudReservedHeight = 0;

  /** Whether the rectangle has to be calculated again before the next frame. */
  static invalidated = false;

  /** `fov` as it was when the rectangle was last calculated, to notice a change. */
  static #lastFov = 0;

  /** `viewsize` as it was when the rectangle was last calculated, to notice a change. */
  static #lastViewsize = 0;

  /**
   * Registers `sizeup` and `sizedown`.
   */
  static Init(): void {
    Cmd.AddCommand('sizeup', Viewport.SizeUp_f);
    Cmd.AddCommand('sizedown', Viewport.SizeDown_f);
  }

  /**
   * Asks for the rectangle to be calculated again before the next frame, because the screen or the map changed.
   */
  static Invalidate(): void {
    Viewport.invalidated = true;
  }

  /**
   * Calculates the rectangle again when something that decides it has changed since the last time.
   */
  static Update(): void {
    if (Viewport.#lastFov !== viewCvars.fov.value) {
      Viewport.#lastFov = viewCvars.fov.value;
      Viewport.invalidated = true;
    }

    if (Viewport.#lastViewsize !== viewCvars.viewsize.value) {
      Viewport.#lastViewsize = viewCvars.viewsize.value;
      Viewport.invalidated = true;
    }

    if (Viewport.invalidated) {
      Viewport.Recalculate();
    }
  }

  /**
   * Recalculates the 3D viewport rectangle and the field of view from the current variables, and keeps the
   * variables inside what makes sense (a view size of 30 to 120, a field of view of 10 to 170).
   */
  static Recalculate(): void {
    Viewport.invalidated = false;

    if (viewCvars.viewsize.value < 30) {
      Cvar.Set('viewsize', '30');
    } else if (viewCvars.viewsize.value > 120) {
      Cvar.Set('viewsize', '120');
    }

    let size = 0.0, full = false;
    if (clientRuntimeState.intermission !== 0) {
      full = true;
      size = 1.0;
      Viewport.hudReservedHeight = 0;
    } else {
      size = viewCvars.viewsize.value;

      // the game says how much of the bottom of the screen its HUD keeps, a game without one has all of it
      const reserved = clientRuntimeState.gameAPI?.hudReservedHeight?.(size) ?? 0;
      Viewport.hudReservedHeight = Number.isFinite(reserved) ? Math.max(0, Math.floor(reserved)) : 0;

      if (size >= 100.0) {
        full = true;
        size = 100.0;
      }
      size *= 0.01;
    }

    const vrect = Camera.refdef.vrect;
    vrect.width = Math.floor(VID.width * size);
    if (vrect.width < 96) {
      size = 96.0 / vrect.width;
      vrect.width = 96;
    }
    vrect.height = Math.floor(VID.height * size);
    if (vrect.height > (VID.height - Viewport.hudReservedHeight)) {
      vrect.height = VID.height - Viewport.hudReservedHeight;
    }
    vrect.x = (VID.width - vrect.width) / 2;
    if (full) {
      vrect.y = 0;
    } else {
      vrect.y = (VID.height - Viewport.hudReservedHeight - vrect.height) / 2;
    }

    if (viewCvars.fov.value < 10) {
      Cvar.Set('fov', '10');
    } else if (viewCvars.fov.value > 170) {
      Cvar.Set('fov', '170');
    }

    const fov = viewCvars.fov.value;

    if ((vrect.width * 0.75) <= vrect.height) {
      Camera.refdef.fov_x = fov;
      Camera.refdef.fov_y = Math.atan(vrect.height / (vrect.width / Math.tan(fov * Math.PI / 360.0))) * 360.0 / Math.PI;
    } else {
      Camera.refdef.fov_x = Math.atan(vrect.width / (vrect.height / Math.tan(fov * 0.82 * Math.PI / 360.0))) * 360.0 / Math.PI;
      Camera.refdef.fov_y = fov * 0.82;
    }

    Camera.UpdateProjection(Camera.refdef.fov_y, vrect.width / vrect.height);
  }

  /** Console command: increases the view size. */
  static SizeUp_f(this: void): void {
    Cvar.Set('viewsize', viewCvars.viewsize.value + 10);
    Viewport.Invalidate();
  }

  /** Console command: decreases the view size. */
  static SizeDown_f(this: void): void {
    Cvar.Set('viewsize', viewCvars.viewsize.value - 10);
    Viewport.Invalidate();
  }
}
