import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import { clientConnectionState } from '../../source/engine/common/Def.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import Host from '../../source/engine/common/Host.ts';
import CL from '../../source/engine/client/CL.ts';
import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import ConsoleOverlay from '../../source/engine/client/ConsoleOverlay.ts';
import Draw from '../../source/engine/client/Draw.ts';
import GL from '../../source/engine/client/GL.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';
import M from '../../source/engine/client/Menu.ts';
import FramePacing from '../../source/engine/client/screen/FramePacing.ts';
import ScreenFrame from '../../source/engine/client/screen/ScreenFrame.ts';
import ScreenIndicators from '../../source/engine/client/screen/ScreenIndicators.ts';
import Screenshots from '../../source/engine/client/screen/Screenshots.ts';
import viewCvars from '../../source/engine/client/view/ViewCvars.ts';
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

void describe('ScreenFrame', () => {
  const globals = globalThis as { requestAnimationFrame?: unknown };
  const previousRequestAnimationFrame = globals.requestAnimationFrame;
  const previousContext = GL.gl;
  const previousConspeed = ConsoleOverlay.conspeed;
  const previousFov = viewCvars.fov;
  const previousViewsize = viewCvars.viewsize;

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
   * @returns The recorded calls from the first `ScreenFrame.RenderScene` on.
   */
  function frameCalls(): string[] {
    return calls.slice(calls.indexOf('ScreenFrame.RenderScene'));
  }

  beforeEach(() => {
    calls = [];
    frames = [];
    sceneCapture = false;
    gameplayStack = false;

    GL.gl = createFakeContext();
    publishGlReady();
    globals.requestAnimationFrame = (callback: AnimationCallback) => { frames.push(callback); return frames.length; };

    viewCvars.fov = { value: 90 } as Cvar;
    viewCvars.viewsize = { value: 120 } as Cvar;
    ConsoleOverlay.conspeed = { value: 300 } as Cvar;
    ConsoleOverlay.current = 0;
    ScreenFrame.pendingFrames = 0;
    Screenshots.requested = false;
    Screenshots.cleanRequested = false;
    FramePacing.Reset();

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
    record(ScreenFrame, 'Prepare', 'ScreenFrame.Prepare');
    record(ScreenFrame, 'RenderScene', 'ScreenFrame.RenderScene');
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
    record(ScreenIndicators, 'Draw', 'ScreenIndicators.Draw');
    record(ConsoleOverlay, 'Draw', 'ConsoleOverlay.Draw');
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
    ConsoleOverlay.conspeed = previousConspeed;
    viewCvars.fov = previousFov;
    viewCvars.viewsize = previousViewsize;
  });

  void describe('a frame of a connected game', () => {
    void test('prepares the view before the frame is requested, then draws scene, tint, overlays and flushes', () => {
      ScreenFrame.Update();

      assert.deepEqual(calls, ['PostProcess.advance', 'ScreenFrame.Prepare']);
      assert.equal(frames.length, 1);

      runFrame();

      assert.deepEqual(frameCalls(), [
        'ScreenFrame.RenderScene',
        'GL.Set2D',
        'ScreenIndicators.Draw',
        'CL.DrawHUD',
        'CL.Draw',
        'M.Draw',
        'ConsoleOverlay.Draw',
        'M.DrawOverlayNotice',
        'GL.StreamFlush',
        'RenderStats.Print',
      ]);
    });

    void test('draws no crosshair of its own, which is the game\'s job', () => {
      const characters: number[] = [];
      mock.method(Draw, 'Character', (_x: number, _y: number, code: number) => { characters.push(code); });

      ScreenFrame.Update();
      runFrame();

      assert.deepEqual(characters, []);
    });

    void test('resolves the captured scene after the 2D setup, with the game stack first', () => {
      sceneCapture = true;
      gameplayStack = true;

      ScreenFrame.Update();
      runFrame();

      assert.deepEqual(frameCalls().slice(0, 5), [
        'ScreenFrame.RenderScene',
        'GL.Set2D',
        'PostProcess.end',
        'PostProcess.resolveGameplayStack',
        'PostProcess.resolve',
      ]);
    });

    void test('skips the game stack when there is none', () => {
      sceneCapture = true;

      ScreenFrame.Update();
      runFrame();

      assert.equal(frameCalls().includes('PostProcess.resolveGameplayStack'), false);
      assert.equal(frameCalls().includes('PostProcess.resolve'), true);
    });

    void test('does not draw the console while it is closed', () => {
      // con_current is 0 and nothing is notifying: DrawConsole is called, it decides what to draw
      ScreenFrame.Update();
      runFrame();

      assert.equal(frameCalls().includes('ConsoleOverlay.Draw'), true);
    });

    void test('draws the intermission HUD alone, without indicators or menu', () => {
      clientRuntimeState.intermission = 1;

      ScreenFrame.Update();
      runFrame();

      assert.deepEqual(frameCalls().slice(2), [
        'CL.DrawHUD',
        'ConsoleOverlay.Draw',
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

      ScreenFrame.Update();
      runFrame();

      assert.deepEqual(frameCalls().slice(2), [
        'Draw.BlackScreen',
        'CL.Draw',
        'ConsoleOverlay.Draw',
        'M.DrawOverlayNotice',
        'GL.StreamFlush',
        'RenderStats.Print',
      ]);
    });
  });

  void describe('while the console is forced up', () => {
    void test('shows a black screen and draws the menu over it', () => {
      clientRuntimeState.worldmodel = null;

      ScreenFrame.Update();
      runFrame();

      assert.equal(ConsoleOverlay.forcedup, true);
      assert.deepEqual(frameCalls().slice(0, 4), ['ScreenFrame.RenderScene', 'GL.Set2D', 'Draw.BlackScreen', 'ScreenIndicators.Draw']);
      assert.equal(frameCalls().includes('M.Draw'), true);
    });

    void test('does not draw the console at all unless the player opened it', () => {
      clientRuntimeState.worldmodel = null;

      ScreenFrame.Update();
      runFrame();

      assert.equal(frameCalls().includes('ConsoleOverlay.Draw'), false);
    });

    void test('draws the console when the player opened it', () => {
      clientRuntimeState.worldmodel = null;
      ConsoleOverlay.isOpen = true;

      ScreenFrame.Update();
      runFrame();

      assert.equal(frameCalls().includes('ConsoleOverlay.Draw'), true);
    });
  });

  void describe('pacing', () => {
    void test('does not queue a second frame while one is waiting', () => {
      ScreenFrame.Update();
      ScreenFrame.Update();

      assert.equal(frames.length, 1);
      assert.deepEqual(calls, ['PostProcess.advance', 'ScreenFrame.Prepare']);
    });

    void test('queues the next frame once the callback has run', () => {
      ScreenFrame.Update();
      runFrame();
      ScreenFrame.Update();

      assert.equal(frames.length, 1);
    });

    void test('does nothing in the callback once the GL context is gone', () => {
      ScreenFrame.Update();
      eventBus.publish('gl.shutdown');

      runFrame();

      assert.equal(calls.includes('ScreenFrame.RenderScene'), false);
    });

    void test('hands the time the browser gave the frame to the frame pacing', () => {
      const times: number[] = [];
      mock.method(FramePacing, 'Record', (animationTime: number) => { times.push(animationTime); });

      ScreenFrame.Update();
      runFrame(1234.5);

      assert.deepEqual(times, [1234.5]);
    });
  });

  void describe('screenshots', () => {
    void test('downloads a regular screenshot right after the frame is requested', () => {
      Screenshots.requested = true;

      ScreenFrame.Update();

      assert.equal(Screenshots.requested, false);
      assert.deepEqual(calls, ['PostProcess.advance', 'ScreenFrame.Prepare', 'VID.DownloadScreenshot()']);
    });

    void test('renders a clean screenshot without the weapon and every overlay, then restores the weapon', () => {
      Screenshots.cleanRequested = true;
      let weaponWhileRendering: number | null = null;
      mock.method(ScreenFrame, 'RenderScene', () => {
        calls.push('ScreenFrame.RenderScene');
        weaponWhileRendering = rendererCvars.drawviewmodel.value;
      });

      ScreenFrame.Update();
      runFrame();

      assert.equal(weaponWhileRendering, 0);
      assert.equal(rendererCvars.drawviewmodel.value, 1);
      assert.equal(Screenshots.cleanRequested, false);
      assert.deepEqual(frameCalls(), [
        'ScreenFrame.RenderScene',
        'GL.Set2D',
        'GL.StreamFlush',
        'VID.DownloadScreenshot(screenshot-clean.jpg)',
      ]);
    });
  });
});
