import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import Frame from '../../source/engine/client/renderer/frame/Frame.ts';
import RenderTarget from '../../source/engine/client/renderer/frame/RenderTarget.ts';
import Con from '../../source/engine/common/Console.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext } from '../support/recordingContext.ts';

void describe('Frame', () => {
  const previousContext = GL.gl;
  let scene: RenderTarget = null!;
  let multisampled: RenderTarget = null!;
  let ping: RenderTarget = null!;
  let history: RenderTarget = null!;
  let asserts: unknown[][] = [];

  beforeEach(() => {
    const { gl } = createRecordingContext();

    GL.gl = gl;
    publishGlReady(gl);

    scene = new RenderTarget({
      name: 'scene',
      color: [{ storage: 'texture' }, { storage: 'texture' }],
      depth: { storage: 'texture' },
    });
    multisampled = new RenderTarget({ name: 'scene-msaa', color: [{ storage: 'renderbuffer' }], depth: { storage: 'renderbuffer' } });
    ping = new RenderTarget({ name: 'ping', color: [{ storage: 'texture' }], depth: null });
    history = new RenderTarget({ name: 'history', color: [{ storage: 'texture' }], depth: null, persistent: true });

    asserts = [];
    mock.method(console, 'assert', (...args: unknown[]) => { asserts.push(args); });
    Frame.beginFrame();
  });

  afterEach(() => {
    mock.restoreAll();
    RenderTarget.unbind();
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void describe('a frame that does what it should', () => {
    void test('has no violations and records the passes with their nesting, outputs and inputs', () => {
      scene.bind();
      Frame.beginPass('scene', scene);
      scene.swapDepthToRenderbuffer({} as WebGLRenderbuffer);
      Frame.beginPass('scene-depth-sample', scene, scene.depthTexture);
      Frame.endPass();
      scene.restoreDepthTexture();
      Frame.endPass();
      ping.bind();
      Frame.beginPass('post-process:underwater-fog', ping, scene.colorTexture(0), [scene.depthTexture!]);
      Frame.endPass();

      assert.deepEqual(Frame.violations, []);
      assert.equal(asserts.filter((args) => args[0] === false).length, 0);
      assert.deepEqual(Frame.records.map((record) => [record.name, record.depth, record.output, record.inputs]), [
        ['scene', 0, 'scene', []],
        ['scene-depth-sample', 1, 'scene', ['scene.depth']],
        ['post-process:underwater-fog', 0, 'ping', ['scene.color0', 'scene.depth']],
      ]);
    });

    void test('lets a history be read before it is drawn this frame', () => {
      ping.bind();
      Frame.beginPass('adapt', ping, history.colorTexture(0));
      Frame.endPass();

      assert.deepEqual(Frame.violations, []);
    });

    void test('follows a multisampled scene into the target it was resolved to', () => {
      multisampled.bind();
      Frame.beginPass('scene', multisampled);
      Frame.beginPass('msaa-resolve', scene);
      scene.bind();
      Frame.endPass();
      Frame.continueIn(scene);
      Frame.endPass();

      assert.deepEqual(Frame.violations, []);
      assert.equal(Frame.records[0].output, 'scene-msaa -> scene');
    });
  });

  void describe('what it catches', () => {
    void test('a pass that samples what is attached to its own output', () => {
      scene.bind();
      Frame.beginPass('scene', scene);
      // the depth texture was not taken off the framebuffer first
      Frame.beginPass('scene-depth-sample', scene, scene.depthTexture);
      Frame.endPass();
      Frame.endPass();

      assert.deepEqual(Frame.violations, ['scene-depth-sample samples scene.depth, which is attached to its own output scene']);
      assert.equal(asserts.some((args) => args[0] === false && String(args[1]).includes('attached to its own output')), true);
    });

    void test('the same pass is fine once the depth texture is swapped for a renderbuffer', () => {
      const renderbuffer = {} as WebGLRenderbuffer;

      scene.bind();
      Frame.beginPass('scene', scene);
      scene.swapDepthToRenderbuffer(renderbuffer);
      Frame.beginPass('scene-depth-sample', scene, scene.depthTexture);
      Frame.endPass();
      scene.restoreDepthTexture();
      Frame.endPass();

      assert.deepEqual(Frame.violations, []);
    });

    void test('a pass that samples a target nothing drew into this frame', () => {
      Frame.beginPass('post-process:warp', null, ping.colorTexture(0));
      Frame.endPass();

      assert.deepEqual(Frame.violations, ['post-process:warp samples ping.color0 before anything drew into ping this frame']);
    });

    void test('a multisampled scene that was never resolved', () => {
      multisampled.bind();
      Frame.beginPass('scene', multisampled);
      Frame.beginPass('scene-depth-sample', multisampled, scene.depthTexture);
      Frame.endPass();
      Frame.endPass();

      assert.equal(Frame.violations.length, 1);
      assert.match(Frame.violations[0], /scene-depth-sample samples scene\.depth before anything drew into scene this frame/);
    });

    void test('a pass that leaves another framebuffer bound than its own', () => {
      ping.bind();
      Frame.beginPass('post-process:bloom', ping);
      scene.bind();
      Frame.endPass();

      assert.deepEqual(Frame.violations, ['post-process:bloom ended with scene bound, it draws into ping']);
    });

    void test('a pass for the screen that leaves a target bound', () => {
      Frame.beginPass('overlays', null);
      ping.bind();
      Frame.endPass();

      assert.deepEqual(Frame.violations, ['overlays ended with ping bound, it draws into the screen']);
    });

    void test('an endPass without a pass', () => {
      Frame.endPass();

      assert.deepEqual(Frame.violations, ['endPass without an open pass']);
    });

    void test('passes that the previous frame left open', () => {
      Frame.beginPass('scene', null);
      Frame.beginPass('scene-depth-sample', null);

      Frame.beginFrame();

      assert.deepEqual(Frame.violations, ['passes were left open by the previous frame: scene, scene-depth-sample']);
    });

    void test('a new frame starts a clean record', () => {
      Frame.endPass();
      Frame.beginFrame();

      assert.deepEqual(Frame.violations, []);
      assert.deepEqual(Frame.records, []);
    });
  });

  void describe('r_framegraph', () => {
    void test('prints the passes of the frame with their violations', () => {
      const lines: string[] = [];

      mock.method(Con, 'Print', (text: string) => { lines.push(text); });
      scene.bind();
      Frame.beginPass('scene', scene);
      Frame.beginPass('scene-depth-sample', scene, scene.depthTexture);
      Frame.endPass();
      Frame.endPass();

      Frame.Dump_f();

      assert.match(lines[0], /^frame \d+: 2 passes, 1 violations\n$/);
      assert.equal(lines[1], 'scene -> scene  reads -\n');
      assert.equal(lines[2], '  scene-depth-sample -> scene  reads scene.depth\n');
      assert.match(lines[3], /!! scene-depth-sample samples scene\.depth, which is attached/);
    });
  });
});
