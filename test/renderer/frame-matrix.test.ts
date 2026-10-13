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
      PostProcess.beginDepthSampling();
      PostProcess.bindDepthForSampling(7);
      PostProcess.endDepthSampling();
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

  void test('a multisampled frame with a depth sampling pass resolves the scene first, and says so', () => {
    runFrame({ msaa: 4, depthSamplingPasses: 1, underwaterFog: false, bloom: false, stack: 'none' });

    const names = Frame.records.map((record) => `${'  '.repeat(record.depth)}${record.name}`);

    assert.deepEqual(names.slice(0, 4), [
      'scene',
      '  msaa-resolve',
      '  scene-depth-sample',
      'present',
    ]);
    assert.equal(Frame.records[0].output, 'scene-msaa -> scene');
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
