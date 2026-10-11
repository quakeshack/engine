import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import Host from '../../source/engine/common/Host.ts';
import CL from '../../source/engine/client/CL.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import ConsoleOverlay from '../../source/engine/client/ConsoleOverlay.ts';
import Draw from '../../source/engine/client/Draw.ts';
import GL from '../../source/engine/client/GL.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import M from '../../source/engine/client/Menu.ts';
import SCR from '../../source/engine/client/SCR.ts';
import VID from '../../source/engine/client/VID.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import RenderStats from '../../source/engine/client/renderer/scene/RenderStats.ts';
import { patchMembers } from '../support/clientState.ts';

type AnimationCallback = (animationTime: number) => void;

/**
 * A stand-in for a WebGL context that creates objects for anything asked of it.
 * @returns The stand-in.
 */
function createFakeContext(): WebGL2RenderingContext {
  return new Proxy({}, {
    get: (_target, property) => (typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

void describe('SCR.UpdateScreen', () => {
  const globals = globalThis as { requestAnimationFrame?: unknown };
  const previousRequestAnimationFrame = globals.requestAnimationFrame;
  const previousContext = GL.gl;
  const previousConspeed = SCR.conspeed;
  const previousFov = SCR.fov;
  const previousViewsize = SCR.viewsize;

  let restores: Array<() => void> = [];
  let calls: string[] = [];
  let frames: AnimationCallback[] = [];
  let sceneCapture = false;
  let gameplayStack = false;

  /**
   * Replaces a method by one that records a label and does nothing else.
   * @param target The object that owns the method.
   * @param name The method.
   * @param label What to record, `Class.method`.
   */
  function record(target: object, name: string, label: string): void {
    mock.method(target as Record<string, () => void>, name, () => { calls.push(label); });
  }

  /**
   * Runs the callback the engine handed to `requestAnimationFrame`.
   * @param animationTime The time the browser reports.
   */
  function runFrame(animationTime = 1000): void {
    const frame = frames.shift();

    assert.ok(frame !== undefined, 'a frame was requested');
    frame(animationTime);
  }

  /**
   * The work that happens in the animation frame, without the setup in front of it.
   * @returns The recorded calls from the first `SCR.RenderView` on.
   */
  function frameCalls(): string[] {
    return calls.slice(calls.indexOf('SCR.RenderView'));
  }

  beforeEach(() => {
    calls = [];
    frames = [];
    sceneCapture = false;
    gameplayStack = false;

    GL.gl = createFakeContext();
    eventBus.publish('gl.ready');
    globals.requestAnimationFrame = (callback: AnimationCallback) => { frames.push(callback); return frames.length; };

    SCR.fov = { value: 90 } as Cvar;
    SCR.viewsize = { value: 120 } as Cvar;
    SCR.conspeed = { value: 300 } as Cvar;
    SCR.oldfov = 90;
    SCR.oldscreensize = 120;
    SCR.recalc_refdef = false;
    SCR.con_current = 0;
    SCR._requestedAnimationFrames = 0;
    SCR.screenshot = false;
    SCR.screenshotClean = false;

    restores = [
      patchMembers(Host, { frametime: 0.1, realtime: 5, framecount: 0, refreshrate: { value: 60, set() {} } as unknown as Cvar }),
      patchMembers(VID, { width: 640, height: 480 }),
      patchMembers(clientRuntimeState, { worldmodel: {} as never, intermission: 0, paused: false }),
      patchMembers(clientStaticState, { state: clientConnectionState.connected, signon: 4, demoplayback: false }),
      patchMembers(Key, { destination: KeyDestination.game }),
      patchMembers(ConsoleOverlay, { forcedup: false, isOpen: false }),
      patchMembers(PostProcess, { colorTexture: {} as never }),
      patchMembers(rendererCvars, {
        drawviewmodel: {
          value: 1,
          set(this: { value: number }, value: number) {
            this.value = value;
          },
        } as unknown as Cvar,
      }),
    ];

    record(PostProcess, 'advance', 'PostProcess.advance');
    record(SCR, 'PreRenderView', 'SCR.PreRenderView');
    record(SCR, 'RenderView', 'SCR.RenderView');
    record(GL, 'Set2D', 'GL.Set2D');
    record(GL, 'StreamFlush', 'GL.StreamFlush');
    mock.method(PostProcess, 'needsSceneCapture', () => sceneCapture);
    mock.method(PostProcess, 'hasGameplayStack', () => gameplayStack);
    mock.method(PostProcess, 'getEffect', () => undefined);
    record(PostProcess, 'end', 'PostProcess.end');
    record(PostProcess, 'resolveGameplayStack', 'PostProcess.resolveGameplayStack');
    record(PostProcess, 'resolve', 'PostProcess.resolve');
    record(Draw, 'BlackScreen', 'Draw.BlackScreen');
    record(CL, 'Draw', 'CL.Draw');
    record(CL, 'DrawHUD', 'CL.DrawHUD');
    record(M, 'Draw', 'M.Draw');
    record(M, 'DrawOverlayNotice', 'M.DrawOverlayNotice');
    record(SCR, 'DrawNet', 'SCR.DrawNet');
    record(SCR, 'DrawTurtle', 'SCR.DrawTurtle');
    record(SCR, 'DrawPause', 'SCR.DrawPause');
    record(SCR, 'DrawCenterString', 'SCR.DrawCenterString');
    record(SCR, 'DrawConsole', 'SCR.DrawConsole');
    record(RenderStats, 'Print', 'RenderStats.Print');
    mock.method(VID, 'DownloadScreenshot', (filename?: string) => { calls.push(`VID.DownloadScreenshot(${filename ?? ''})`); });
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
    globals.requestAnimationFrame = previousRequestAnimationFrame;
    SCR.conspeed = previousConspeed;
    SCR.fov = previousFov;
    SCR.viewsize = previousViewsize;
  });

  void describe('a frame of a connected game', () => {
    void test('prepares the view before the frame is requested, then draws scene, tint, overlays and flushes', () => {
      SCR.UpdateScreen();

      assert.deepEqual(calls, ['PostProcess.advance', 'SCR.PreRenderView']);
      assert.equal(frames.length, 1);

      runFrame();

      assert.deepEqual(frameCalls(), [
        'SCR.RenderView',
        'GL.Set2D',
        'SCR.DrawNet',
        'SCR.DrawTurtle',
        'SCR.DrawPause',
        'SCR.DrawCenterString',
        'CL.DrawHUD',
        'CL.Draw',
        'M.Draw',
        'SCR.DrawConsole',
        'M.DrawOverlayNotice',
        'GL.StreamFlush',
        'RenderStats.Print',
      ]);
    });

    void test('draws no crosshair of its own, which is the game\'s job', () => {
      const characters: number[] = [];
      mock.method(Draw, 'Character', (_x: number, _y: number, code: number) => { characters.push(code); });

      SCR.UpdateScreen();
      runFrame();

      assert.deepEqual(characters, []);
    });

    void test('resolves the captured scene after the 2D setup, with the game stack first', () => {
      sceneCapture = true;
      gameplayStack = true;

      SCR.UpdateScreen();
      runFrame();

      assert.deepEqual(frameCalls().slice(0, 5), [
        'SCR.RenderView',
        'GL.Set2D',
        'PostProcess.end',
        'PostProcess.resolveGameplayStack',
        'PostProcess.resolve',
      ]);
    });

    void test('skips the game stack when there is none', () => {
      sceneCapture = true;

      SCR.UpdateScreen();
      runFrame();

      assert.equal(frameCalls().includes('PostProcess.resolveGameplayStack'), false);
      assert.equal(frameCalls().includes('PostProcess.resolve'), true);
    });

    void test('does not draw the console while it is closed', () => {
      // con_current is 0 and nothing is notifying: DrawConsole is called, it decides what to draw
      SCR.UpdateScreen();
      runFrame();

      assert.equal(frameCalls().includes('SCR.DrawConsole'), true);
    });

    void test('draws the intermission HUD alone, without indicators or menu', () => {
      clientRuntimeState.intermission = 1;

      SCR.UpdateScreen();
      runFrame();

      assert.deepEqual(frameCalls().slice(2), [
        'CL.DrawHUD',
        'SCR.DrawConsole',
        'M.DrawOverlayNotice',
        'GL.StreamFlush',
        'RenderStats.Print',
      ]);
    });

    void test('draws only the connecting screen while connecting', () => {
      clientStaticState.state = clientConnectionState.connecting;
      clientStaticState.signon = 1;
      clientRuntimeState.worldmodel = null;
      ConsoleOverlay.isOpen = true;

      SCR.UpdateScreen();
      runFrame();

      assert.deepEqual(frameCalls().slice(2), [
        'Draw.BlackScreen',
        'CL.Draw',
        'SCR.DrawConsole',
        'M.DrawOverlayNotice',
        'GL.StreamFlush',
        'RenderStats.Print',
      ]);
    });
  });

  void describe('while the console is forced up', () => {
    void test('shows a black screen and draws the menu over it', () => {
      clientRuntimeState.worldmodel = null;

      SCR.UpdateScreen();
      runFrame();

      assert.equal(ConsoleOverlay.forcedup, true);
      assert.deepEqual(frameCalls().slice(0, 4), ['SCR.RenderView', 'GL.Set2D', 'Draw.BlackScreen', 'SCR.DrawNet']);
      assert.equal(frameCalls().includes('M.Draw'), true);
    });

    void test('does not draw the console at all unless the player opened it', () => {
      clientRuntimeState.worldmodel = null;

      SCR.UpdateScreen();
      runFrame();

      assert.equal(frameCalls().includes('SCR.DrawConsole'), false);
    });

    void test('draws the console when the player opened it', () => {
      clientRuntimeState.worldmodel = null;
      ConsoleOverlay.isOpen = true;

      SCR.UpdateScreen();
      runFrame();

      assert.equal(frameCalls().includes('SCR.DrawConsole'), true);
    });
  });

  void describe('pacing', () => {
    void test('does not queue a second frame while one is waiting', () => {
      SCR.UpdateScreen();
      SCR.UpdateScreen();

      assert.equal(frames.length, 1);
      assert.deepEqual(calls, ['PostProcess.advance', 'SCR.PreRenderView']);
    });

    void test('queues the next frame once the callback has run', () => {
      SCR.UpdateScreen();
      runFrame();
      SCR.UpdateScreen();

      assert.equal(frames.length, 1);
    });

    void test('does nothing in the callback once the GL context is gone', () => {
      SCR.UpdateScreen();
      eventBus.publish('gl.shutdown');

      runFrame();

      assert.equal(calls.includes('SCR.RenderView'), false);
    });

    void test('measures the frame rate over the last frames and sets the refresh rate from it once there are enough', () => {
      const set = mock.fn();
      SCR._frameTimes.fill(null);
      SCR._frameTimeIndex = 0;
      SCR._lastAnimationTime = 0;
      Host.refreshrate = { value: 0, set } as unknown as Cvar;
      Host.framecount = 301;

      // 17 ms apart is 58.8 frames per second, which rounds up to the next multiple of 15. A rate that measures
      // a hair above a multiple of 15 (60.0000001) rounds up to the next one as well, so the detection is
      // only as good as the timestamps of the browser.
      for (let frame = 0; frame < 3; frame++) {
        SCR.UpdateScreen();
        runFrame(1000 + frame * 17);
      }

      assertAlmost(SCR.FPS, 1000 / 17);
      assert.deepEqual(set.mock.calls.map((call) => call.arguments), [[60], [60]]);
    });

    /**
     * Compares two numbers with a tolerance suited to millisecond sums.
     * @param actual The value under test.
     * @param expected The value it should have.
     */
    function assertAlmost(actual: number, expected: number): void {
      assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${actual} to be ${expected}`);
    }
  });

  void describe('screenshots', () => {
    void test('downloads a regular screenshot right after the frame is requested', () => {
      SCR.screenshot = true;

      SCR.UpdateScreen();

      assert.equal(SCR.screenshot, false);
      assert.deepEqual(calls, ['PostProcess.advance', 'SCR.PreRenderView', 'VID.DownloadScreenshot()']);
    });

    void test('renders a clean screenshot without the weapon and every overlay, then restores the weapon', () => {
      SCR.screenshotClean = true;
      let weaponWhileRendering: number | null = null;
      mock.method(SCR, 'RenderView', () => {
        calls.push('SCR.RenderView');
        weaponWhileRendering = rendererCvars.drawviewmodel.value;
      });

      SCR.UpdateScreen();
      runFrame();

      assert.equal(weaponWhileRendering, 0);
      assert.equal(rendererCvars.drawviewmodel.value, 1);
      assert.equal(SCR.screenshotClean, false);
      assert.deepEqual(frameCalls(), [
        'SCR.RenderView',
        'GL.Set2D',
        'GL.StreamFlush',
        'VID.DownloadScreenshot(screenshot-clean.jpg)',
      ]);
    });
  });
});
