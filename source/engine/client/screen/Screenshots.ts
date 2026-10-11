import Cmd from '../../common/Cmd.ts';
import { eventBus } from '../../common/EventBus.ts';
import GL from '../GL.ts';
import rendererCvars from '../renderer/resources/RendererCvars.ts';
import VID from '../VID.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * The `screenshot` and `screenshot_clean` commands: the request is remembered and carried out by the frame, at the
 * point of the frame where the picture is the right one.
 */
export default class Screenshots {
  /** A screenshot of the screen as it is was asked for. */
  static requested = false;

  /** A screenshot of the 3D scene alone was asked for. */
  static cleanRequested = false;

  /** `r_drawviewmodel` as it was before a clean screenshot switched the weapon off. */
  static #drawViewModel = 1;

  /**
   * Registers the commands.
   */
  static Init(): void {
    Cmd.AddCommand('screenshot', Screenshots.Screenshot_f);
    Cmd.AddCommand('screenshot_clean', Screenshots.ScreenshotClean_f);
  }

  /** Console command: requests a screenshot on the next rendered frame. */
  static Screenshot_f(this: void): void {
    Screenshots.requested = true;
  }

  /**
   * Console command: requests a screenshot on the next rendered frame with the view model and all UI
   * overlays (crosshair, HUD, console, menu) suppressed for that one frame. Intended for clean map captures.
   */
  static ScreenshotClean_f(this: void): void {
    Screenshots.cleanRequested = true;
  }

  /**
   * Takes the screenshot of the screen as it is, if one was asked for.
   */
  static TakeRequested(): void {
    if (!Screenshots.requested) {
      return;
    }

    Screenshots.requested = false;
    gl.finish();
    VID.DownloadScreenshot();
  }

  /**
   * Starts a frame that is a clean screenshot: switches the weapon off for it.
   * @returns True when this frame is one, and the overlays are to be left out.
   */
  static BeginClean(): boolean {
    if (!Screenshots.cleanRequested) {
      return false;
    }

    Screenshots.#drawViewModel = rendererCvars.drawviewmodel.value;
    rendererCvars.drawviewmodel.set(0);

    return true;
  }

  /**
   * Ends the frame of a clean screenshot: puts the weapon back and saves the picture.
   */
  static EndClean(): void {
    rendererCvars.drawviewmodel.set(Screenshots.#drawViewModel);
    gl.finish();
    VID.DownloadScreenshot('screenshot-clean.jpg');
    Screenshots.cleanRequested = false;
  }
}
