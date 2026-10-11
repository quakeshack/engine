import Cvar from '../../common/Cvar.ts';
import { clientConnectionState } from '../../common/Def.ts';
import { eventBus } from '../../common/EventBus.ts';
import Con from '../../common/Console.ts';
import CL from '../CL.ts';
import { clientRuntimeState, clientStaticState } from '../ClientState.ts';
import ConsoleOverlay from '../ConsoleOverlay.ts';
import Draw from '../Draw.ts';
import GL from '../GL.ts';
import Key, { KeyDestination } from '../Key.ts';
import M from '../Menu.ts';
import R from '../R.ts';
import S from '../Sound.ts';
import DynamicLights from '../renderer/lighting/DynamicLights.ts';
import PostProcess from '../renderer/postprocess/PostProcess.ts';
import rendererCvars from '../renderer/resources/RendererCvars.ts';
import Camera from '../renderer/scene/Camera.ts';
import RenderStats from '../renderer/scene/RenderStats.ts';
import Visibility from '../renderer/scene/Visibility.ts';
import FirstPersonView from '../view/FirstPersonView.ts';
import Viewport from '../view/Viewport.ts';
import CenterPrint from './CenterPrint.ts';
import FramePacing from './FramePacing.ts';
import ScreenIndicators from './ScreenIndicators.ts';
import Screenshots from './Screenshots.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * One frame of the screen, as named steps: where the 3D view is, what it looks like, the scene, the post-process
 * resolve, the overlays on top, and the end of the frame. Also the loading plaque: what a level change does to
 * the screen.
 */
export default class ScreenFrame {
  /** Frames asked of the browser that have not been drawn yet: 0 or 1. */
  static pendingFrames = 0;

  /**
   * Creates the variables and registers the commands of everything the screen draws, in the order `cvarlist`
   * shows them.
   */
  static Init(): void {
    Viewport.Init();
    ScreenIndicators.Init();
    CenterPrint.Init();
    Screenshots.Init();
  }

  /**
   * Drives one frame: updates the viewport and the console, prepares the view, and asks the browser for the frame
   * that draws it. A regular screenshot is taken of what is on the screen.
   */
  static Update(): void {
    Viewport.Update();
    ConsoleOverlay.Update();

    if (ScreenFrame.pendingFrames > 0) {
      console.assert(ScreenFrame.pendingFrames === 1, 'ScreenFrame.Update: too many rendering requests active');
      return;
    }

    // the fades and pulses of the post-process entries count the frames that are drawn
    PostProcess.advance();

    ScreenFrame.Prepare(); // do some calculations independent of rendering

    requestAnimationFrame((animationTime) => {
      // we are already shutting down
      if ((gl as WebGL2RenderingContext | null) === null) {
        return;
      }

      ScreenFrame.#draw(animationTime);
    });

    ScreenFrame.pendingFrames++;

    Screenshots.TakeRequested();
  }

  /**
   * Prepares the 3D view of the frame: the first-person view, then what the frame derives from it, in the order
   * each step needs it. Nothing while the console is forced up, there is no 3D view then.
   */
  static Prepare(): void {
    if (ConsoleOverlay.forcedup) {
      return;
    }
    if (clientRuntimeState.maxclients >= 2) {
      Cvar.Set('scr_ofsx', '0');
      Cvar.Set('scr_ofsy', '0');
      Cvar.Set('scr_ofsz', '0');
    }
    if (clientRuntimeState.intermission > 0) {
      FirstPersonView.CalcIntermissionRefdef();
    } else if (!clientRuntimeState.paused) {
      FirstPersonView.CalcRefdef();
    }

    // The refdef is final from here on. Derive what the frame reads from it, in the order each step needs.
    Camera.UpdateViewVectors();
    Visibility.UpdateViewLeaf();
    R.PreRenderScene();
  }

  /**
   * Renders the 3D view of the frame, when there is a map to render and the connection is ready for it.
   */
  static RenderScene(): void {
    if (ConsoleOverlay.forcedup) {
      return;
    }
    if (!clientRuntimeState.worldmodel) {
      return;
    }
    if (clientStaticState.signon < 4) {
      return;
    }
    DynamicLights.Push();
    R.RenderView();
  }

  /**
   * Stops all sounds and puts the console and the center print away while a map is loading.
   */
  static BeginLoadingPlaque(): void {
    S.StopAllSounds();
    if ((clientStaticState.state !== clientConnectionState.connected) || (clientStaticState.signon !== 4)) {
      return;
    }
    CenterPrint.Clear();
    ConsoleOverlay.Reset();
  }

  /**
   * Clears console notifications after loading completes.
   */
  static EndLoadingPlaque(): void {
    Draw.EndDisc();
    Con.ClearNotify();
  }

  /**
   * Draws the frame the browser asked for.
   * @param animationTime The time the browser gave the frame, in milliseconds.
   */
  static #draw(animationTime: number): void {
    FramePacing.Record(animationTime);

    const clean = Screenshots.BeginClean();

    ScreenFrame.RenderScene();
    GL.Set2D();
    ScreenFrame.#resolve();

    if (ConsoleOverlay.forcedup) {
      // ScreenFrame.RenderScene() (above) skips the 3D scene render entirely while forcedup — and with
      // it, the gl.clear() that normally happens inside R.RenderView(). Without this, a
      // half-open console drawer or the menu's own semi-transparent fade would blend against
      // whatever 3D frame is still sitting in the framebuffer from the last time a game was
      // actually running, instead of a clean background.
      Draw.BlackScreen();
    }

    // A clean screenshot only wants the 3D scene (plus the post-process/cshift passes
    // above, which are part of the scene rendering, not UI) -- skip every overlay,
    // including the console and menu, for this one frame.
    if (!clean) {
      ScreenFrame.#drawOverlays();
    }

    ScreenFrame.#finish(clean);
  }

  /**
   * Resolves the captured scene to the screen through the effects of the renderer and of the game.
   */
  static #resolve(): void {
    if (!PostProcess.needsSceneCapture()) {
      return;
    }

    PostProcess.end();
    console.assert(PostProcess.colorTexture !== null, 'PostProcess color texture is not set');
    if (PostProcess.hasGameplayStack()) {
      PostProcess.resolveGameplayStack();
    }

    PostProcess.resolve(
      Camera.refdef.vrect.x, Camera.refdef.vrect.y,
      Camera.refdef.vrect.width, Camera.refdef.vrect.height,
      PostProcess.colorTexture!,
    );

    const bloomEffect = PostProcess.getEffect('bloom');
    if (bloomEffect && bloomEffect.active && rendererCvars.bloomDebug && rendererCvars.bloomDebug.value !== 0) {
      bloomEffect.drawDebugPreview();
    }
  }

  /**
   * Draws what goes over the scene: the HUD and the indicators, the menu, the console.
   */
  static #drawOverlays(): void {
    if (clientStaticState.state === clientConnectionState.connecting) {
      CL.Draw();
    } else if ((clientRuntimeState.intermission !== 0) && (Key.destination === KeyDestination.game)) {
      CL.DrawHUD();
    } else {
      ScreenIndicators.Draw();
      CenterPrint.Draw();
      if (clientStaticState.signon === 4) {
        CL.DrawHUD();
      }
      CL.Draw();
      M.Draw();
    }

    // Drawn above absolutely everything above — including the menu and the
    // connecting/intermission branches — so the console is always reachable while open or
    // closing. Never drawn at all while it's neither open nor connected (see
    // ConsoleOverlay.IsPassiveBackdrop) -- the menu is always showing then, and a full-screen console
    // texture behind it would blot it out for no reason.
    if (!ConsoleOverlay.IsPassiveBackdrop()) {
      ConsoleOverlay.Draw();
    }

    M.DrawOverlayNotice();
  }

  /**
   * Ends the frame: flushes what was streamed, and completes a clean screenshot.
   * @param clean Whether this frame is a clean screenshot.
   */
  static #finish(clean: boolean): void {
    GL.StreamFlush();

    if (!clean) {
      RenderStats.Print(FramePacing.FPS);
    }

    gl.disable(gl.BLEND);

    if (clean) {
      Screenshots.EndClean();
    }

    ScreenFrame.pendingFrames--;
  }
}
