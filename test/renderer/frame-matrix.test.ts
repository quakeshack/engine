import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import GL, { type GLRenderTexture } from '../../source/engine/client/GL.ts';
import VID from '../../source/engine/client/VID.ts';
import Frame from '../../source/engine/client/renderer/frame/Frame.ts';
import RenderTarget from '../../source/engine/client/renderer/frame/RenderTarget.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import PostProcessEffect, { type PostProcessOutput } from '../../source/engine/client/renderer/postprocess/PostProcessEffect.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { patchMembers } from '../support/clientState.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext } from '../support/recordingContext.ts';

/**
 * An effect that behaves the way the bloom does: it draws into a target of its own, then puts the output it was
 * handed back. `leaks` makes it forget that, which is the bug the frame is there to catch.
 */
class ScratchEffect extends PostProcessEffect {
  readonly #scratch: RenderTarget;
  readonly #leaks: boolean;

  constructor(name: string, scratch: RenderTarget, sampled: readonly GLRenderTexture[], leaks = false) {
    super(name);
    this.#scratch = scratch;
    this.#leaks = leaks;
    this.stackable = true;
    this.sampledTextures = sampled;
  }

  override apply(_input: GLRenderTexture, _x: number, _y: number, _width: number, _height: number, _settings: object | null | undefined, output: PostProcessOutput): void {
    this.#scratch.bind();

    if (!this.#leaks) {
      RenderTarget.bindOutput(output.target);
    }
  }
}

/** What differs between frames: the toggles `R` and the game turn. */
interface FrameConfig {
  readonly msaa: number;
  readonly depthSamplingPasses: number;
  readonly underwaterFog: boolean;
  readonly bloom: boolean;
  readonly stack: 'none' | 'scene' | 'final' | 'both';
}

/**
 * Names a configuration in a failure message.
 * @param config The toggles of the frame.
 * @returns What was on.
 */
function describeConfig(config: FrameConfig): string {
  return `msaa ${config.msaa}, ${config.depthSamplingPasses} depth sampling passes, underwater fog ${config.underwaterFog}, bloom ${config.bloom}, ${config.stack} stack`;
}

void describe('the frame of the renderer', () => {
  const previousContext = GL.gl;
  const previousEffects = PostProcess.effects;
  let restores: Array<() => void> = [];
  let scratch: RenderTarget = null!;

  beforeEach(() => {
    const { gl } = createRecordingContext();

    GL.gl = gl;
    publishGlReady(gl);
    PostProcess.init();
    scratch = new RenderTarget({ name: 'effect-scratch', color: [{ storage: 'texture' }], depth: null });

    restores = [patchMembers(VID, { width: 640, height: 480, pixelRatio: 1 })];
    mock.method(PostProcess, '_blitToScreen', () => {});
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    PostProcess.clearStack();
    PostProcess.effects = previousEffects;
    PostProcess.msaa!.free();
    PostProcess.shutdown();
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  /**
   * Runs the passes of one frame through the real post-process code, in the order `R.RenderScene` and
   * `ScreenFrame` call them.
   * @param config The toggles of the frame.
   * @param leakyEffect Whether the first renderer effect forgets to put the output back.
   */
  function runFrame(config: FrameConfig, leakyEffect = false): void {
    const sceneDepth = PostProcess.depthTexture!;
    const emissive = PostProcess.emissiveTexture!;
    const effects: PostProcessEffect[] = [];

    if (config.bloom) {
      const bloom = new ScratchEffect('bloom', scratch, [emissive], leakyEffect);

      bloom.active = true;
      bloom.stackable = false;
      effects.push(bloom);
    }

    if (config.underwaterFog) {
      const fog = new ScratchEffect('underwater-fog', scratch, [sceneDepth, PostProcess.turbulentBoundaryDepthTexture!]);

      fog.active = true;
      fog.stackable = false;
      effects.push(fog);
    }

    effects.push(new ScratchEffect('blur', scratch, []));
    PostProcess.effects = effects;

    if (config.stack === 'scene' || config.stack === 'both') {
      PostProcess.setStack([{ id: 'blur', settings: { radius: 2 } }]);
    }

    if (config.stack === 'final' || config.stack === 'both') {
      PostProcess.setStack([{ id: 'blur', settings: { radius: 2 }, stage: 'final' }], { channel: 'final' });
    }

    Frame.beginFrame();
    PostProcess.msaa!.set(String(config.msaa));
    PostProcess.resize(640, 480);

    PostProcess.begin();

    if (config.underwaterFog) {
      PostProcess.beginTurbulentBoundaryPass();
      PostProcess.endTurbulentBoundaryPass();
    }

    for (let i = 0; i < config.depthSamplingPasses; i++) {
      PostProcess.copySceneDepth().bind(7);
    }

    PostProcess.end();

    if (PostProcess.hasGameplayStack()) {
      PostProcess.resolveGameplayStack();
    }

    PostProcess.resolve(0, 0, 640, 480, PostProcess.colorTexture!);

    Frame.beginPass('overlays', null);
    Frame.endPass();
  }

  void test('every combination of the frame is free of hazards and ends on the screen', () => {
    let configurations = 0;

    for (const msaa of [0, 4]) {
      for (const depthSamplingPasses of [0, 1, 3]) {
        for (const underwaterFog of [false, true]) {
          for (const bloom of [false, true]) {
            for (const stack of ['none', 'scene', 'final', 'both'] as const) {
              const config: FrameConfig = { msaa, depthSamplingPasses, underwaterFog, bloom, stack };

              runFrame(config);
              configurations++;

              assert.deepEqual(Frame.violations, [], describeConfig(config));
              assert.equal(RenderTarget.bound, null, `${describeConfig(config)}: the screen is bound at the end`);

              // nothing was left open: the next frame does not report it
              Frame.beginFrame();
              assert.deepEqual(Frame.violations, [], `${describeConfig(config)}: no pass is left open`);
              PostProcess.clearStack();
            }
          }
        }
      }
    }

    assert.equal(configurations, 96);
  });

  void test('a frame in which the scene is not drawn presents the picture of the last one, without violations', () => {
    // the last frame that drew the scene, multisampled
    runFrame({ msaa: 4, depthSamplingPasses: 1, underwaterFog: false, bloom: true, stack: 'scene' });
    assert.deepEqual(Frame.violations, []);

    // a map is loading: ScreenFrame still ends the scene, runs the game's stack and the effects, and presents
    mock.method(PostProcess, 'resizePingPong', () => {});
    PostProcess.effects = [new ScratchEffect('bloom', scratch, [PostProcess.emissiveTexture!])];
    PostProcess.effects[0].active = true;
    const recording = createRecordingContext();

    Frame.beginFrame();
    GL.gl = recording.gl;
    publishGlReady(recording.gl);
    PostProcess.end();
    PostProcess.resolveGameplayStack();
    PostProcess.resolve(0, 0, 640, 480, PostProcess.colorTexture!);

    assert.deepEqual(Frame.violations, []);
    assert.equal(RenderTarget.bound, null);
    assert.equal(Frame.records[0].name, 'scene of an earlier frame');
    // nothing was resolved: no multisample blit
    assert.deepEqual(recording.calls('blitFramebuffer'), []);
  });

  void test('a frame without a world still presents the underwater fog of the last one, without violations', () => {
    // the last frame that drew the scene, underwater, which drew the turbulent boundary depth the fog samples
    runFrame({ msaa: 0, depthSamplingPasses: 0, underwaterFog: true, bloom: false, stack: 'none' });
    assert.deepEqual(Frame.violations, []);

    // a host error disconnects the client: the effects keep the state the last frame preparation gave them, but the
    // scene and the turbulent boundary are not drawn
    mock.method(PostProcess, 'resizePingPong', () => {});
    PostProcess.effects = [new ScratchEffect('underwater-fog', scratch, [PostProcess.depthTexture!, PostProcess.turbulentBoundaryDepthTexture!])];
    PostProcess.effects[0].active = true;

    Frame.beginFrame();
    PostProcess.end();
    PostProcess.resolve(0, 0, 640, 480, PostProcess.colorTexture!);

    assert.deepEqual(Frame.violations, []);
    assert.deepEqual(Frame.records.slice(0, 2).map((record) => record.name), ['scene of an earlier frame', 'turbulent-boundary of an earlier frame']);
  });

  void test('a multisampled frame copies the depth from the multisampled target and resolves the scene once, at the end', () => {
    runFrame({ msaa: 4, depthSamplingPasses: 2, underwaterFog: false, bloom: false, stack: 'none' });

    const names = Frame.records.map((record) => `${'  '.repeat(record.depth)}${record.name}`);

    assert.deepEqual(names, [
      'scene',
      '  scene-depth-copy',
      '  scene-depth-copy',
      '  msaa-resolve',
      'present',
      'overlays',
    ]);
    assert.equal(Frame.records[0].output, 'scene-msaa -> scene');

    // a renderbuffer is not an input of the pass; without multisampling the depth texture of the scene is
    assert.deepEqual(Frame.records[1].inputs, []);
  });

  void test('a frame without multisampling copies the depth of the scene itself', () => {
    runFrame({ msaa: 0, depthSamplingPasses: 1, underwaterFog: false, bloom: false, stack: 'none' });

    assert.deepEqual(Frame.records[1].inputs, ['scene.depth']);
    assert.equal(Frame.records[0].output, 'scene');
  });

  void test('an effect that leaves its own target bound is reported, and so is what is drawn into it afterwards', () => {
    mock.method(console, 'assert', () => {});

    runFrame({ msaa: 0, depthSamplingPasses: 0, underwaterFog: false, bloom: true, stack: 'none' }, true);

    // the bloom is the last effect, so the overlays would be drawn into its scratch target: the black screen of
    // 5f8a761, found by the frame instead of by someone looking at it
    assert.deepEqual(Frame.violations, [
      'post-process:bloom ended with effect-scratch bound, it draws into the screen',
      'overlays ended with effect-scratch bound, it draws into the screen',
    ]);
  });
});
