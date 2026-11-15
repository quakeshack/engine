import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import GL, { type GLProgramInfo, type GLTextureArray } from '../../source/engine/client/GL.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { ShadowRenderContext } from '../../source/engine/client/renderer/models/ModelRenderer.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { SpriteModelRenderer } from '../../source/engine/client/renderer/models/SpriteModelRenderer.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import { SpriteAsset } from '../../source/engine/common/model/sprite/SpriteAsset.ts';
import { SpriteDirection, SpriteOrientation, SpritePhase, type SpriteImage, type SpriteSequence } from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { patchMembers } from '../support/clientState.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext, type RecordingContext } from '../support/recordingContext.ts';

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

/**
 * @returns A program drawing the vertex of `sprite` from the stream, with the given uniforms.
 */
function streamProgram(identifier: string, uniforms: readonly string[]): GLProgramInfo {
  const attribs = [['aPosition', 3, 0], ['aTexCoord', 3, 12], ['aBlend', 2, 24]] as const;
  const program: Record<string, unknown> = {
    identifier,
    program: { label: `program ${identifier}` },
    attribs: attribs.map(([name, components, offset], location) => ({ name, location, type: 0x1406, components, normalized: false, offset })),
    vertexSize: FLOATS_PER_VERTEX * 4,
    attribBits: 0,
    tTexture: 0,
  };

  for (const uniform of uniforms) {
    program[uniform] = uniform;
  }

  return program as unknown as GLProgramInfo;
}

/**
 * @returns The context of a point-light shadow pass for a light at `origin`.
 */
function pointLight(origin: Vector): ShadowRenderContext {
  return { lightSpaceMatrix: new Float64Array(16), casterFade: 1, isPointLight: true, pointLightOrigin: origin, lightDirection: new Vector(0, 0, -1) };
}

/**
 * @returns The context of a top-down shadow pass whose light travels along `direction`.
 */
function topDownLight(direction: Vector): ShadowRenderContext {
  return { lightSpaceMatrix: new Float64Array(16), casterFade: 1, isPointLight: false, pointLightOrigin: new Vector(), lightDirection: direction };
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
  let recording: RecordingContext = createRecordingContext();

  /**
   * @returns The layer the last quad streamed shows.
   */
  function streamedLayer(): number {
    return new Float32Array(GL.streamArray, 0, FLOATS_PER_VERTEX)[5];
  }

  /**
   * @returns A sprite model showing one sequence (or picture).
   */
  function spriteModel(frame: SpriteSequence | SpriteImage, orientation: SpriteOrientation): SpriteModel {
    const model = new SpriteModel('gfx/guy.png');

    model.orientation = orientation;
    model.asset = new SpriteAsset({ frames: [frame], texture: { bind() { return this; } } as unknown as GLTextureArray });

    return model;
  }

  /**
   * @returns An entity at `origin`, turned by `yaw`.
   */
  function entityAt(origin: Vector, yaw: number, extra: Record<string, unknown> = {}): ClientEdict {
    return { origin, worldOrigin: origin, angles: new Vector(0, yaw, 0), frame: 0, sequence: -1, animtime: 0, framerate: 1, alpha: 1, effects: 0, syncbase: 0, ...extra } as unknown as ClientEdict;
  }

  /**
   * Draws a sprite model with one sequence for an entity.
   * @returns The layer the quad shows.
   */
  function draw(sequence: SpriteSequence, origin: Vector, yaw: number): number {
    const model = spriteModel(sequence, SpriteOrientation.parallelUpright);
    const entity = entityAt(origin, yaw);

    GL.streamArrayPosition = 0;
    GL.streamArrayVertexCount = 0;
    renderer.setupRenderState(1);
    renderer.render(model, entity, 1);

    return streamedLayer();
  }

  beforeEach(() => {
    recording = createRecordingContext();

    GL.gl = recording.gl;
    publishGlReady(recording.gl);

    GL.programs = [
      streamProgram('sprite', ['uAlpha', 'uBloomEmissiveScale', 'uBlendMode', 'uLight']),
      streamProgram('shadow-sprite', ['uLightSpaceMatrix', 'uCasterFade', 'uBlendMode']),
    ];
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

  void describe('shadows', () => {
    /**
     * Renders a sprite's shadow.
     * @returns The corners of the quad streamed, `null` when nothing was drawn.
     */
    function cast(model: SpriteModel, entity: ClientEdict, ctx: ShadowRenderContext): Vector[] | null {
      GL.streamArrayPosition = 0;
      GL.streamArrayVertexCount = 0;
      GL.currentProgram = null;
      renderer.renderShadow(model, entity, ctx);

      if (recording.calls('drawArrays').length === 0) {
        return null;
      }

      const floats = new Float32Array(GL.streamArray, 0, FLOATS_PER_VERTEX * 6);

      return Array.from({ length: 6 }, (_value, vertex) => new Vector(...floats.subarray(vertex * FLOATS_PER_VERTEX, vertex * FLOATS_PER_VERTEX + 3)));
    }

    /**
     * @returns A sprite model of one unit picture that casts a shadow.
     */
    function caster(orientation: SpriteOrientation): SpriteModel {
      const model = spriteModel(image(0), orientation);

      model.castsShadow = true;

      return model;
    }

    void test('a sprite whose settings do not ask for one casts no shadow', () => {
      const model = caster(SpriteOrientation.parallel);

      model.castsShadow = false;

      assert.equal(cast(model, entityAt(new Vector(), 0), pointLight(new Vector(100, 0, 0))), null);
    });

    void test('turns the quad to face a point light, not the camera', () => {
      Camera.refdef.vieworg.setTo(0, 100, 0);

      const corners = cast(caster(SpriteOrientation.parallel), entityAt(new Vector(), 0), pointLight(new Vector(100, 0, 0)))!;

      assert.notEqual(corners, null);
      assert.deepEqual(corners.map((corner) => corner[0]), [0, 0, 0, 0, 0, 0], 'the quad lies in the plane facing the light at +X');
      assert.deepEqual([Math.max(...corners.map((corner) => corner[1])), Math.max(...corners.map((corner) => corner[2]))], [1, 1]);
    });

    void test('draws with the shadow program, light passing through by the sprite\'s blend mode', () => {
      cast(caster(SpriteOrientation.parallel), entityAt(new Vector(), 0), pointLight(new Vector(100, 0, 0)));

      assert.equal(GL.currentProgram?.identifier, 'shadow-sprite');
      assert.ok(recording.calls('uniform1f').includes('uniform1f(uBlendMode, 0)'), 'an alpha tested sprite');
    });

    void test('enables its attributes, whatever the caster before it left disabled', () => {
      cast(caster(SpriteOrientation.parallel), entityAt(new Vector(), 0), pointLight(new Vector(100, 0, 0)));

      for (const location of [0, 1, 2]) {
        assert.ok(recording.calls('enableVertexAttribArray').includes(`enableVertexAttribArray(${location})`), `attribute ${location}`);
      }
    });

    void test('an upright sprite under a light that points straight down casts nothing', () => {
      assert.equal(cast(caster(SpriteOrientation.parallelUpright), entityAt(new Vector(), 0), topDownLight(new Vector(0, 0, -1))), null);
      assert.equal(cast(caster(SpriteOrientation.facingUpright), entityAt(new Vector(), 0), topDownLight(new Vector(0, 0, -1))), null);
    });

    void test('an upright sprite under a slanted light stands up, turned to the light', () => {
      const corners = cast(caster(SpriteOrientation.parallelUpright), entityAt(new Vector(), 0), topDownLight(new Vector(Math.SQRT1_2, 0, -Math.SQRT1_2)))!;

      assert.notEqual(corners, null);
      assert.deepEqual(corners.map((corner) => corner[0]), [0, 0, 0, 0, 0, 0]);
      assert.equal(Math.max(...corners.map((corner) => corner[2])), 1, 'upright along Z');
    });

    void test('a sprite under a light that points straight down lies flat', () => {
      const corners = cast(caster(SpriteOrientation.parallel), entityAt(new Vector(), 0), topDownLight(new Vector(0, 0, -1)))!;

      assert.notEqual(corners, null);
      assert.deepEqual(corners.map((corner) => corner[2]), [0, 0, 0, 0, 0, 0]);
    });

    void test('shows the view of the side the light is on', () => {
      // the light at +Y is 90 degrees counterclockwise from an entity facing +X: view 2 of 8, which starts at layer 4
      Camera.refdef.vieworg.setTo(100, 0, 0);

      const model = spriteModel(rotatedSequence(8, 2), SpriteOrientation.parallelUpright);

      model.castsShadow = true;
      cast(model, entityAt(new Vector(), 0), pointLight(new Vector(0, 100, 0)));

      assert.equal(streamedLayer(), 4);
    });
  });

  void describe('which sequence is shown, and when', () => {
    /**
     * @param layers The layers of the images, each shown for one second.
     * @returns A sequence that loops over them.
     */
    function sequenceOf(...layers: number[]): SpriteSequence {
      return {
        name: 'seq',
        images: layers.map(image),
        views: [layers.map(image)],
        endTimes: Float32Array.from(layers, (_layer, index) => index + 1),
        direction: SpriteDirection.forward,
        repeat: 0,
      };
    }

    /**
     * Draws an entity with a model of two sequences, the first of the layers 0 and 1, the second of 2 and 3.
     * @param options What the model and the entity are like.
     * @returns The layer the quad shows.
     */
    function drawTwoSequences(options: { bySequence: boolean; phase?: SpritePhase; entity?: Record<string, unknown> }): number {
      const model = spriteModel(sequenceOf(0, 1), SpriteOrientation.parallelUpright);

      model.asset = new SpriteAsset({ frames: [sequenceOf(0, 1), sequenceOf(2, 3)], texture: { bind() { return this; } } as unknown as GLTextureArray });
      model.selectsBySequence = options.bySequence;
      model.phase = options.phase ?? SpritePhase.global;
      Camera.refdef.vieworg.setTo(100, 0, 0);
      GL.streamArrayPosition = 0;
      GL.streamArrayVertexCount = 0;
      renderer.setupRenderState(1);
      renderer.render(model, entityAt(new Vector(), 0, options.entity), 1);

      return streamedLayer();
    }

    void test('an image sprite plays the sequence the entity selects, and ignores its frame', () => {
      assert.equal(drawTwoSequences({ bySequence: true, entity: { sequence: 1, frame: 0 } }), 2);
      assert.equal(drawTwoSequences({ bySequence: true, entity: { sequence: 0, frame: 1 } }), 0);
    });

    void test('an image sprite whose entity selects none plays the first sequence', () => {
      assert.equal(drawTwoSequences({ bySequence: true, entity: { sequence: -1, frame: 1 } }), 0);
      assert.equal(drawTwoSequences({ bySequence: true, entity: { sequence: 9 } }), 0, 'a number out of range, like the frame it replaces');
    });

    void test('a Quake sprite keeps selecting by frame and ignores the sequence', () => {
      assert.equal(drawTwoSequences({ bySequence: false, entity: { frame: 1, sequence: 0 } }), 2);
      assert.equal(drawTwoSequences({ bySequence: false, entity: { frame: 0, sequence: 1 } }), 0);
    });

    void test('a sprite on the spawn clock shows the point the entity\'s animtime puts it at', () => {
      // the client clock reads 0.5: started at 0 it is half a second in, still on the first image of a second each
      assert.equal(drawTwoSequences({ bySequence: true, phase: SpritePhase.spawn, entity: { sequence: 1, animtime: 0 } }), 2);
      // started at -0.8, the clock at 0.5 is 1.3 s in: on the second image
      assert.equal(drawTwoSequences({ bySequence: true, phase: SpritePhase.spawn, entity: { sequence: 1, animtime: -0.8 } }), 3);
    });

    void test('the framerate scales the speed, and 0 holds the first image', () => {
      assert.equal(drawTwoSequences({ bySequence: true, phase: SpritePhase.spawn, entity: { sequence: 1, framerate: 3 } }), 3, '0.5 s at three times the speed is 1.5 s in');
      assert.equal(drawTwoSequences({ bySequence: true, phase: SpritePhase.spawn, entity: { sequence: 1, animtime: -9, framerate: 0 } }), 2);
    });

    void test('a sprite on the global clock does not look at animtime', () => {
      assert.equal(drawTwoSequences({ bySequence: true, phase: SpritePhase.global, entity: { sequence: 1, animtime: -0.8 } }), 2);
    });
  });
});
