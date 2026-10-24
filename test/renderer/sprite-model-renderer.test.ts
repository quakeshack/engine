import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import GL, { type GLProgramInfo, type GLTextureArray } from '../../source/engine/client/GL.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { SpriteModelRenderer } from '../../source/engine/client/renderer/models/SpriteModelRenderer.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import { SpriteAsset } from '../../source/engine/common/model/sprite/SpriteAsset.ts';
import { SpriteDirection, SpriteOrientation, type SpriteImage, type SpriteSequence } from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { patchMembers } from '../support/clientState.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext } from '../support/recordingContext.ts';

/** Position, texture coordinates and layer, then the layer it fades into and how far: the vertex of `sprite`. */
const FLOATS_PER_VERTEX = 8;

/**
 * @returns A picture of one unit, on the given layer.
 */
function image(layer: number): SpriteImage {
  return { layer, origin: [0, 0], width: 1, height: 1, pixelWidth: 1, pixelHeight: 1, uvScale: [1, 1] };
}

/**
 * @param viewCount Number of views.
 * @param steps Images per view; view `v` shows the layers `v * steps` and up.
 * @returns A sequence with rotations whose images each take a second.
 */
function rotatedSequence(viewCount: number, steps: number): SpriteSequence {
  const views = Array.from({ length: viewCount }, (_value, view) => Array.from({ length: steps }, (_image, step) => image(view * steps + step)));

  return {
    name: 'walk',
    images: views[0],
    views,
    endTimes: Float32Array.from({ length: steps }, (_value, index) => index + 1),
    direction: SpriteDirection.forward,
    repeat: 0,
  };
}

void describe('SpriteModelRenderer', () => {
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
    vieworg: new Vector(),
    vright: new Vector(),
    vup: new Vector(),
  };
  const renderer = new SpriteModelRenderer();
  let restoreClientState: () => void = () => {};

  /**
   * @returns The layer the last quad streamed shows.
   */
  function streamedLayer(): number {
    return new Float32Array(GL.streamArray, 0, FLOATS_PER_VERTEX)[5];
  }

  /**
   * Draws a sprite model with one sequence for an entity.
   * @returns The layer the quad shows.
   */
  function draw(sequence: SpriteSequence, origin: Vector, yaw: number): number {
    const model = new SpriteModel('gfx/guy.png');

    model.orientation = SpriteOrientation.parallelUpright;
    model.asset = new SpriteAsset({ frames: [sequence], texture: { bind() { return this; } } as unknown as GLTextureArray });

    const entity = { origin, angles: new Vector(0, yaw, 0), frame: 0, alpha: 1, effects: 0, syncbase: 0, animationStartTime: 0 } as unknown as ClientEdict;

    GL.streamArrayPosition = 0;
    GL.streamArrayVertexCount = 0;
    renderer.setupRenderState(1);
    renderer.render(model, entity, 1);

    return streamedLayer();
  }

  beforeEach(() => {
    const recording = createRecordingContext();

    GL.gl = recording.gl;
    publishGlReady(recording.gl);

    const program: Record<string, unknown> = {
      identifier: 'sprite',
      program: { label: 'program sprite' },
      attribs: [],
      vertexSize: FLOATS_PER_VERTEX * 4,
      attribBits: 0,
      tTexture: 0,
    };

    for (const uniform of ['uAlpha', 'uBloomEmissiveScale', 'uBlendMode', 'uLight']) {
      program[uniform] = uniform;
    }

    GL.programs = [program as unknown as GLProgramInfo];
    GL.currentProgram = null;
    GL.streamArray = new ArrayBuffer(8192);
    GL.streamArrayBytes = new Uint8Array(GL.streamArray);
    GL.streamArrayView = new DataView(GL.streamArray);
    GL.streamBuffer = { label: 'stream buffer' } as unknown as WebGLBuffer;
    GL.streamBufferPosition = 0;
    rendererCvars.interpolation = { value: 0 } as unknown as Cvar;
    restoreClientState = patchMembers(clientRuntimeState, { time: 0.5 });
    previous.vieworg.set(Camera.refdef.vieworg);
    previous.vright.set(Camera.vright);
    previous.vup.set(Camera.vup);
    Camera.vright.setTo(0, -1, 0);
    Camera.vup.setTo(0, 0, 1);
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
    restoreClientState();
    Camera.refdef.vieworg.set(previous.vieworg);
    Camera.vright.set(previous.vright);
    Camera.vup.set(previous.vup);
  });

  void describe('rotations', () => {
    void test('shows the front view to a camera in front of the entity', () => {
      Camera.refdef.vieworg.setTo(100, 0, 0);

      assert.equal(draw(rotatedSequence(8, 2), new Vector(0, 0, 0), 0), 0);
    });

    void test('shows the view of the side the camera is on, counterclockwise from the front', () => {
      // the camera at +Y is 90 degrees counterclockwise from an entity facing +X: view 2 of 8, which starts at layer 4
      Camera.refdef.vieworg.setTo(0, 100, 0);

      assert.equal(draw(rotatedSequence(8, 2), new Vector(0, 0, 0), 0), 4);
    });

    void test('turns with the entity: the back of an entity that faces away from the camera', () => {
      Camera.refdef.vieworg.setTo(100, 0, 0);

      assert.equal(draw(rotatedSequence(8, 2), new Vector(0, 0, 0), 180), 8);
    });

    void test('measures from the entity\'s origin, not the world\'s', () => {
      Camera.refdef.vieworg.setTo(50, 100, 0);

      assert.equal(draw(rotatedSequence(4, 1), new Vector(50, 0, 0), 0), 1);
    });

    void test('a sequence without rotations shows its images whatever the angle', () => {
      Camera.refdef.vieworg.setTo(-100, 0, 0);

      assert.equal(draw(rotatedSequence(1, 2), new Vector(0, 0, 0), 0), 0);
    });
  });
});
