import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Draw from '../../source/engine/client/Draw.ts';
import GL, { type GLProgramInfo, type GLTextureArray } from '../../source/engine/client/GL.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { SpritePlayback } from '../../source/engine/client/renderer/sprite/SpritePlayback.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { SpriteAsset } from '../../source/engine/common/model/sprite/SpriteAsset.ts';
import { SpriteBlend, SpriteDirection, type SpriteFrame, type SpriteImage, type SpriteRegion } from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { assertNear } from '../support/assertions.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext, type RecordingContext } from '../support/recordingContext.ts';

/** One vertex of the `pic-sprite` program, as the stream holds it. */
interface SpriteVertex {
  x: number;
  y: number;
  u: number;
  v: number;
  layer: number;
  nextLayer: number;
  fade: number;
}

const FLOATS_PER_VERTEX = 7;

/**
 * @returns A picture of 4x2 pixels shown at twice the size, in a layer that is 8x4 pixels big of which it covers a share.
 */
function image(layer: number, uvScale: readonly [number, number] = [1, 1]): SpriteImage {
  return { layer, origin: [0, 0], width: 8, height: 4, pixelWidth: 4, pixelHeight: 2, uvScale };
}

void describe('Draw.Sprite', () => {
  const previous = {
    context: GL.gl,
    programs: GL.programs,
    currentProgram: GL.currentProgram,
    streamArray: GL.streamArray,
    streamArrayBytes: GL.streamArrayBytes,
    streamArrayView: GL.streamArrayView,
    streamArrayPosition: GL.streamArrayPosition,
    streamArrayVertexCount: GL.streamArrayVertexCount,
    streamBuffer: GL.streamBuffer,
    streamBufferPosition: GL.streamBufferPosition,
    interpolation: rendererCvars.interpolation,
  };
  let recording: RecordingContext = null!;
  let binds: string[] = [];

  /**
   * @returns A texture that records its binds.
   */
  function fakeTexture(): GLTextureArray {
    return {
      bind(unit: number, flushStream: boolean) {
        if (flushStream) {
          GL.StreamFlush();
        }

        binds.push(`unit ${unit}`);

        return this;
      },
    } as unknown as GLTextureArray;
  }

  /**
   * Draws a sprite the way a game would.
   * @returns The playback.
   */
  function createPlayback(frames: readonly SpriteFrame[], options: { blend?: SpriteBlend, regions?: ReadonlyMap<string, SpriteRegion>, interpolate?: boolean, texture?: GLTextureArray | null } = {}): SpritePlayback {
    const asset = new SpriteAsset({
      frames,
      blend: options.blend,
      interpolate: options.interpolate,
      regions: options.regions,
      texture: options.texture === undefined ? fakeTexture() : options.texture,
    });

    return new SpritePlayback(asset, () => 0);
  }

  /**
   * @returns The six vertices of the quad the last call streamed.
   */
  function streamedVertices(): SpriteVertex[] {
    const floats = new Float32Array(GL.streamArray, 0, FLOATS_PER_VERTEX * 6);

    return Array.from({ length: 6 }, (_value, index) => {
      const [x, y, u, v, layer, nextLayer, fade] = floats.subarray(index * FLOATS_PER_VERTEX, (index + 1) * FLOATS_PER_VERTEX);

      return { x, y, u, v, layer, nextLayer, fade };
    });
  }

  /**
   * @returns The corners of the streamed quad: left, top, right, bottom.
   */
  function streamedBounds(): { left: number, top: number, right: number, bottom: number } {
    const vertices = streamedVertices();

    return {
      left: Math.min(...vertices.map((vertex) => vertex.x)),
      top: Math.min(...vertices.map((vertex) => vertex.y)),
      right: Math.max(...vertices.map((vertex) => vertex.x)),
      bottom: Math.max(...vertices.map((vertex) => vertex.y)),
    };
  }

  beforeEach(() => {
    recording = createRecordingContext();
    binds = [];

    GL.gl = recording.gl;
    publishGlReady(recording.gl);

    const program: Record<string, unknown> = {
      identifier: 'pic-sprite',
      program: { label: 'program pic-sprite' },
      attribs: [],
      vertexSize: FLOATS_PER_VERTEX * 4,
      attribBits: 0,
      tTexture: 0,
    };

    for (const uniform of ['uOrtho', 'uColor', 'uAlpha', 'uBlendMode']) {
      program[uniform] = uniform;
    }

    GL.programs = [program as unknown as GLProgramInfo];
    GL.currentProgram = null;
    GL.streamArray = new ArrayBuffer(8192);
    GL.streamArrayBytes = new Uint8Array(GL.streamArray);
    GL.streamArrayView = new DataView(GL.streamArray);
    GL.streamArrayPosition = 0;
    GL.streamArrayVertexCount = 0;
    GL.streamBuffer = { label: 'stream buffer' } as unknown as WebGLBuffer;
    GL.streamBufferPosition = 0;
    rendererCvars.interpolation = { value: 1 } as unknown as Cvar;
  });

  afterEach(() => {
    eventBus.publish('gl.shutdown');
    GL.gl = previous.context;
    GL.programs = previous.programs;
    GL.currentProgram = previous.currentProgram;
    GL.streamArray = previous.streamArray;
    GL.streamArrayBytes = previous.streamArrayBytes;
    GL.streamArrayView = previous.streamArrayView;
    GL.streamArrayPosition = previous.streamArrayPosition;
    GL.streamArrayVertexCount = previous.streamArrayVertexCount;
    GL.streamBuffer = previous.streamBuffer;
    GL.streamBufferPosition = previous.streamBufferPosition;
    rendererCvars.interpolation = previous.interpolation;
  });

  void test('draws the whole image with its top left corner at the position', () => {
    Draw.Sprite(10, 20, createPlayback([image(3)]));

    assert.deepEqual(streamedBounds(), { left: 10, top: 20, right: 18, bottom: 24 }, 'the world size, 4x2 pixels at 2 units each');

    const vertices = streamedVertices();

    assert.deepEqual(vertices.map((vertex) => [vertex.u, vertex.v]), [[0, 0], [0, 1], [1, 0], [1, 0], [0, 1], [1, 1]]);
    assert.ok(vertices.every((vertex) => vertex.layer === 3 && vertex.nextLayer === 3 && vertex.fade === 0));
  });

  void test('draws one triangle pair and binds the array texture to the unit of the program', () => {
    Draw.Sprite(0, 0, createPlayback([image(0)]));

    assert.deepEqual(recording.calls('drawArrays'), ['drawArrays(4, 0, 6)']);
    assert.deepEqual(binds, ['unit 0']);
  });

  void test('blends premultiplied for the quad and puts straight alpha back after it is drawn', () => {
    Draw.Sprite(0, 0, createPlayback([image(0)]));

    const calls = recording.log.filter((line) => line.startsWith('blendFuncSeparate(') || line.startsWith('drawArrays('));

    assert.deepEqual(calls, [
      'blendFuncSeparate(1, ONE_MINUS_SRC_ALPHA, 1, 1)',
      'drawArrays(4, 0, 6)',
      'blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, 1, 1)',
    ]);
  });

  void test('options.scale scales the size of the image', () => {
    Draw.Sprite(10, 20, createPlayback([image(0)]), { scale: 1.5 });

    assert.deepEqual(streamedBounds(), { left: 10, top: 20, right: 22, bottom: 26 });
  });

  void describe('regions', () => {
    const regions = new Map<string, SpriteRegion>([['right', { x: 1, y: 0, width: 3, height: 1 }]]);

    void test('draws only the rectangle, at its size in world units', () => {
      Draw.Sprite(5, 5, createPlayback([image(0)], { regions }), { region: 'right' });

      assert.deepEqual(streamedBounds(), { left: 5, top: 5, right: 11, bottom: 7 }, '3x1 pixels at 2 units each');

      const [topLeft, , , , , bottomRight] = streamedVertices();

      assertNear(topLeft.u, 0.25);
      assertNear(topLeft.v, 0);
      assertNear(bottomRight.u, 1);
      assertNear(bottomRight.v, 0.5);
    });

    void test('cuts shares of the image, so a layer that is bigger than the image does not matter', () => {
      // the image covers the upper left quarter of its layer, as a smaller picture padded into a larger layer does
      Draw.Sprite(0, 0, createPlayback([image(0, [0.5, 0.5])], { regions }), { region: 'right' });

      const [topLeft, , , , , bottomRight] = streamedVertices();

      assertNear(topLeft.u, 0.125);
      assertNear(bottomRight.u, 0.5);
      assertNear(bottomRight.v, 0.25);
    });

    void test('scales with options.scale', () => {
      Draw.Sprite(0, 0, createPlayback([image(0)], { regions }), { region: 'right', scale: 2 });

      assert.deepEqual(streamedBounds(), { left: 0, top: 0, right: 12, bottom: 4 });
    });

    void test('throws for a region the sprite does not have, and draws nothing', () => {
      assert.throws(() => { Draw.Sprite(0, 0, createPlayback([image(0)], { regions }), { region: 'left' }); }, /no region "left" \(it has: right\)/);
      assert.deepEqual(recording.calls('drawArrays'), []);
      assert.deepEqual(recording.calls('blendFuncSeparate'), []);
    });
  });

  void describe('uniforms', () => {
    void test('are white and opaque by default', () => {
      Draw.Sprite(0, 0, createPlayback([image(0)]));

      assert.ok(recording.log.includes('uniform3f(uColor, 1, 1, 1)'));
      assert.ok(recording.log.includes('uniform1f(uAlpha, 1)'));
    });

    void test('carry the tint and the alpha', () => {
      Draw.Sprite(0, 0, createPlayback([image(0)]), { tint: [1, 0.5, 0], alpha: 0.25 });

      assert.ok(recording.log.includes('uniform3f(uColor, 1, 0.5, 0)'));
      assert.ok(recording.log.includes('uniform1f(uAlpha, 0.25)'));
    });

    void test('name the blend mode of the sprite', () => {
      for (const [blend, mode] of [[SpriteBlend.alphaTest, 0], [SpriteBlend.alpha, 1], [SpriteBlend.additive, 2]] as const) {
        recording.log.length = 0;
        Draw.Sprite(0, 0, createPlayback([image(0)], { blend }));

        assert.ok(recording.log.includes(`uniform1f(uBlendMode, ${mode})`), blend);
      }
    });
  });

  void describe('animation', () => {
    const images = [image(0), image(1)];
    const sequence = {
      name: '',
      images,
      views: [images],
      endTimes: Float32Array.from([1, 2]),
      direction: SpriteDirection.forward,
      repeat: 0,
    };

    void test('draws the image that is showing', () => {
      Draw.Sprite(0, 0, createPlayback([sequence]));

      assert.ok(streamedVertices().every((vertex) => vertex.layer === 0 && vertex.fade === 0));
    });

    void test('draws the view the playback is turned to', () => {
      const side = [image(2), image(3)];
      const playback = createPlayback([{ ...sequence, views: [images, side] }]);

      playback.view = 1;
      Draw.Sprite(0, 0, playback);

      assert.ok(streamedVertices().every((vertex) => vertex.layer === 2));
    });

    void test('fades into the next image for a sprite that interpolates', () => {
      const playback = createPlayback([sequence], { interpolate: true });
      let now = 0;
      const timed = new SpritePlayback(playback.asset, () => now);

      now = 0.25;
      Draw.Sprite(0, 0, timed);

      const [vertex] = streamedVertices();

      assert.equal(vertex.layer, 0);
      assert.equal(vertex.nextLayer, 1);
      assertNear(vertex.fade, 0.25);
    });

    void test('does not fade while r_interpolation is off', () => {
      rendererCvars.interpolation = { value: 0 } as unknown as Cvar;

      const timed = new SpritePlayback(createPlayback([sequence], { interpolate: true }).asset, () => 0.25);

      Draw.Sprite(0, 0, timed);

      assert.equal(streamedVertices()[0].fade, 0);
    });
  });

  void test('draws nothing for a sprite that has no texture', () => {
    Draw.Sprite(0, 0, createPlayback([image(0)], { texture: null }));

    assert.deepEqual(recording.log, []);
  });
});
