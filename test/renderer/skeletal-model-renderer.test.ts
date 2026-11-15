import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import GL, { type GLProgramInfo, type GLTexture } from '../../source/engine/client/GL.ts';
import type { ShadowRenderContext } from '../../source/engine/client/renderer/models/ModelRenderer.ts';
import { SkeletalModelRenderer } from '../../source/engine/client/renderer/models/SkeletalModelRenderer.ts';
import EntityLighting from '../../source/engine/client/renderer/lighting/EntityLighting.ts';
import DefaultTextures from '../../source/engine/client/renderer/resources/DefaultTextures.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { IQMModel } from '../../source/engine/common/model/IQMModel.ts';
import { IQMLoader } from '../../source/engine/common/model/loaders/IQMLoader.ts';
import { SkeletalAnimation } from '../../source/engine/common/model/SkeletalAnimation.ts';
import W from '../../source/engine/common/W.ts';
import { effect } from '../../source/shared/Defs.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { buildIqm, createTwoJointSpec, type IqmSpec } from '../support/iqmBuilder.ts';
import { createModelLoadContext } from '../support/modelContext.ts';
import { createRecordingContext, type RecordingContext } from '../support/recordingContext.ts';

const SQRT_HALF = Math.SQRT1_2;
const VERTEX_FLOATS = 8;
const GL_TRIANGLES = 4;
const GL_UNSIGNED_SHORT = 0x1403;

/** What a test says about the pose of an entity: the frames `lerp.frame` gives, and the entity's plain frame. */
interface EntityPose {
  lerpFrame: [number, number, number];
  frame: number;
}

/** A texture that records where it was bound. */
interface RecordingTexture {
  readonly label: string;
  bind(unit: number): RecordingTexture;
}

/**
 * @param identifier Program name.
 * @param uniforms Uniforms the program has; each is its own name, so a recorded call shows which one it was.
 * @returns A program for `GL.programs`, with sampler units 0 to 3 for the material layers.
 */
function createProgram(identifier: string, uniforms: readonly string[]): GLProgramInfo {
  const program: Record<string, unknown> = {
    identifier,
    program: { label: `program ${identifier}` },
    attribs: [],
    attribBits: 0,
    tTexture: 0,
    tGlow: 1,
    tShirt: 2,
    tPants: 3,
  };

  for (const uniform of uniforms) {
    program[uniform] = uniform;
  }

  return program as unknown as GLProgramInfo;
}

/**
 * @param spec The model file.
 * @returns The loaded model with its mesh, as the client realm has it.
 */
async function loadModel(spec: IqmSpec = createTwoJointSpec()): Promise<IQMModel> {
  return await new IQMLoader(createModelLoadContext({ loadRenderData: true })).load(buildIqm(spec), 'progs/two.iqm');
}

/**
 * Two meshes on two materials, a triangle each, so that a draw has two ranges.
 * @returns The description of the model.
 */
function createTwoMaterialSpec(): IqmSpec {
  return createTwoJointSpec({
    triangles: [0, 1, 2, 0, 2, 1],
    meshes: [
      { name: 'first', material: 'progs/first', firstVertex: 0, vertexCount: 3, firstTriangle: 0, triangleCount: 1 },
      { name: 'second', material: 'progs/second', firstVertex: 0, vertexCount: 3, firstTriangle: 1, triangleCount: 1 },
    ],
  });
}

void describe('SkeletalModelRenderer', () => {
  const previous = {
    context: GL.gl,
    programs: GL.programs,
    currentProgram: GL.currentProgram,
    interpolation: rendererCvars.interpolation,
    nocolors: rendererCvars.nocolors,
    notexture: DefaultTextures.notexture,
    blacktexture: DefaultTextures.blacktexture,
    colorTable: W.d_8to24table,
  };
  const renderer = new SkeletalModelRenderer(IQMModel);
  const bound: string[] = [];
  let recording: RecordingContext = createRecordingContext();
  let culled = false;
  let restoreClientState: () => void = () => {};
  let skinning: { mock: { callCount(): number } } = { mock: { callCount: () => 0 } };

  /**
   * @param label How the texture shows in `bound`.
   * @returns A texture that records its binds as `label@unit`.
   */
  function createTexture(label: string): GLTexture {
    const texture: RecordingTexture = {
      label,
      bind(unit: number) {
        bound.push(`${label}@${unit}`);
        return texture;
      },
    };

    return texture as unknown as GLTexture;
  }

  /**
   * @param pose The frames the entity is in.
   * @param overrides Other members of the entity.
   * @returns An entity at (10, 20, 30).
   */
  function createEntity(pose: Partial<EntityPose> = {}, overrides: Record<string, unknown> = {}): ClientEdict {
    const entityPose: EntityPose = { lerpFrame: [0, 0, 0], frame: 0, ...pose };

    return {
      origin: new Vector(10, 20, 30),
      lerp: { origin: new Vector(10, 20, 30), angles: new Vector(), frame: entityPose.lerpFrame },
      frame: entityPose.frame,
      effects: 0,
      alpha: 1,
      colormap: 0,
      ...overrides,
    } as unknown as ClientEdict;
  }

  /**
   * @returns The vertices of the last upload of skinned vertices (every upload of a float array), as a list.
   */
  function lastUploadedVertices(): Float32Array {
    const uploads = recording.invocations('bufferData').filter((args) => args[1] instanceof Float32Array);
    assert.ok(uploads.length > 0, 'no vertices were uploaded');
    return uploads[uploads.length - 1][1] as Float32Array;
  }

  /**
   * @returns How many index buffers were filled, which is once for each model's GL objects.
   */
  function indexBufferUploads(): number {
    return recording.invocations('bufferData').filter((args) => args[1] instanceof Uint16Array || args[1] instanceof Uint32Array).length;
  }

  /**
   * @returns How many times skinned vertices were uploaded.
   */
  function uploadCount(): number {
    return recording.invocations('bufferData').filter((args) => args[1] instanceof Float32Array).length;
  }

  /**
   * @param name The uniform's name, as the fake program has it.
   * @param method The uniform call.
   * @returns The values of the last call, `null` when there was none.
   */
  function lastUniform(name: string, method = 'uniform3fv'): number[] | null {
    const calls = recording.invocations(method).filter((args) => args[0] === name);
    return calls.length === 0 ? null : Array.from(calls[calls.length - 1][1] as ArrayLike<number>);
  }

  /**
   * @returns A point-light shadow pass.
   */
  function shadowPass(): ShadowRenderContext {
    return { lightSpaceMatrix: new Float64Array(16), casterFade: 1, isPointLight: true, pointLightOrigin: new Vector(), lightDirection: new Vector(0, 0, -1) };
  }

  /**
   * @param vertices The array uploaded.
   * @param index The vertex.
   * @returns Its `x, y, z`.
   */
  function positionOf(vertices: Float32Array, index: number): number[] {
    return Array.from(vertices.subarray(index * VERTEX_FLOATS, index * VERTEX_FLOATS + 3));
  }

  beforeEach(() => {
    recording = createRecordingContext();
    bound.length = 0;
    culled = false;

    GL.gl = recording.gl;
    publishGlReady(recording.gl);
    GL.programs = [
      createProgram('skeletal', ['uOrigin', 'uAngles', 'uLightVec', 'uDynamicLightVec', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uAlpha', 'uShirtColor', 'uPantsColor', 'uBloomEmissiveScale']),
      createProgram('shadow-brush', ['uOrigin', 'uAngles', 'uLightSpaceMatrix']),
      createProgram('shadow-point', ['uOrigin', 'uAngles', 'uLightSpaceMatrix']),
    ];
    GL.currentProgram = null;

    rendererCvars.interpolation = { value: 1 } as unknown as Cvar;
    rendererCvars.nocolors = { value: 0 } as unknown as Cvar;
    DefaultTextures.notexture = createTexture('notexture');
    DefaultTextures.blacktexture = createTexture('black');
    restoreClientState = patchMembers(clientRuntimeState, { scores: [{ colors: 0x3c }] });

    mock.method(Camera, 'CullBox', () => culled);
    mock.method(EntityLighting, 'CalculateLightValues', () => [new Vector(), new Vector(), new Vector(), new Vector(), new Vector()]);
    skinning = mock.method(SkeletalAnimation, 'skinMeshInto');
  });

  afterEach(() => {
    mock.restoreAll();
    eventBus.publish('gl.shutdown');
    GL.gl = previous.context;
    GL.programs = previous.programs;
    GL.currentProgram = previous.currentProgram;
    rendererCvars.interpolation = previous.interpolation;
    rendererCvars.nocolors = previous.nocolors;
    DefaultTextures.notexture = previous.notexture;
    DefaultTextures.blacktexture = previous.blacktexture;
    W.d_8to24table = previous.colorTable;
    restoreClientState();
  });

  void describe('skinning', () => {
    void test('uploads the vertices skinned for the entity\'s frame, with texture coordinates and normals in place', async () => {
      // Frame 1 of the two-joint model turns `child` 90 degrees about Z; the places of the three vertices are worked
      // out by hand in `createTwoJointSpec`.
      const model = await loadModel();

      renderer.render(model, createEntity({ lerpFrame: [1, 1, 0], frame: 1 }), 0);

      const vertices = lastUploadedVertices();
      assert.equal(vertices.length, 3 * VERTEX_FLOATS);
      [[9, 0, 0], [0, 1, 0], [7.5, -2.5, 0]].forEach((expected, index) => {
        positionOf(vertices, index).forEach((value, axis) => { assertNear(value, expected[axis], 1e-5); });
      });
      assert.deepEqual(Array.from(vertices.subarray(3, 5)), [0, 0]);
      assert.deepEqual(Array.from(vertices.subarray(VERTEX_FLOATS + 3, VERTEX_FLOATS + 5)), [1, 0]);
      assert.deepEqual(Array.from(vertices.subarray(2 * VERTEX_FLOATS + 3, 2 * VERTEX_FLOATS + 5)), [0, 1]);
      assert.deepEqual(Array.from(vertices.subarray(5, 8)), [0, 0, 1]);
    });

    void test('blends the two frames of the entity\'s interpolated frame', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity({ lerpFrame: [0, 1, 0.5], frame: 1 }), 0);

      // Halfway through the turn the vertex on `child` is 45 degrees round its joint at (10, 0, 0).
      const [x, y] = positionOf(lastUploadedVertices(), 0);
      assertNear(x, 10 - SQRT_HALF, 1e-5);
      assertNear(y, SQRT_HALF, 1e-5);
    });

    void test('shows the plain frame without blending when interpolation is off', async () => {
      rendererCvars.interpolation = { value: 0 } as unknown as Cvar;
      const model = await loadModel();

      renderer.render(model, createEntity({ lerpFrame: [0, 1, 0.5], frame: 1 }), 0);

      positionOf(lastUploadedVertices(), 0).forEach((value, axis) => { assertNear(value, [9, 0, 0][axis], 1e-5); });
    });

    void test('shows the plain frame during a muzzle flash, where alias models do not blend either', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity({ lerpFrame: [0, 1, 0.5], frame: 1 }, { effects: effect.EF_MUZZLEFLASH }), 0);

      positionOf(lastUploadedVertices(), 0).forEach((value, axis) => { assertNear(value, [9, 0, 0][axis], 1e-5); });
    });

    void test('does not skin or draw an entity that is outside the view', async () => {
      culled = true;
      const model = await loadModel();

      renderer.render(model, createEntity({ frame: 1 }), 0);

      assert.equal(skinning.mock.callCount(), 0);
      assert.equal(recording.invocations('drawElements').length, 0);
    });

    void test('skins an entity once for the frame, and its shadow passes upload the same vertices again', async () => {
      const model = await loadModel();
      const entity = createEntity({ lerpFrame: [0, 1, 0.25], frame: 1 });

      renderer.render(model, entity, 0);
      renderer.renderShadow(model, entity, shadowPass());
      renderer.renderShadow(model, entity, { ...shadowPass(), isPointLight: false });

      assert.equal(skinning.mock.callCount(), 1);
      assert.equal(uploadCount(), 3, 'every pass has to upload them to the one vertex buffer');
    });

    void test('skins again when the entity\'s frame changed', async () => {
      const model = await loadModel();
      const lerpFrame: [number, number, number] = [0, 1, 0.25];
      const entity = createEntity({ lerpFrame, frame: 1 });

      renderer.render(model, entity, 0);
      lerpFrame[2] = 0.75;
      renderer.render(model, entity, 0);

      assert.equal(skinning.mock.callCount(), 2);
    });

    void test('keeps the pose of each entity that uses the same model apart', async () => {
      // Entities share a model's GL buffers but not their skinning: an entity must not draw another one's pose.
      const model = await loadModel();
      const first = createEntity({ lerpFrame: [0, 0, 0], frame: 0 });
      const second = createEntity({ lerpFrame: [1, 1, 0], frame: 1 });

      renderer.render(model, first, 0);
      const firstVertices = Array.from(lastUploadedVertices());
      renderer.render(model, second, 0);
      renderer.render(model, first, 0);

      assert.deepEqual(Array.from(lastUploadedVertices()), firstVertices);
      assert.equal(skinning.mock.callCount(), 2, 'the first entity\'s second draw reuses its own skinning');
    });

    void test('skins afresh when the entity gets another model in the same frame', async () => {
      // A game may swap an entity's model without touching its frame (a weapon pickup becoming another weapon); the
      // cached vertices belong to the old model's mesh.
      const first = await loadModel();
      const second = await loadModel(createTwoJointSpec({ positions: [20, 2, 0, 0, 2, 0, 10, 0, 0] }));
      const entity = createEntity({ lerpFrame: [1, 1, 0], frame: 1 });

      renderer.render(first, entity, 0);
      renderer.render(second, entity, 0);

      // (20, 2, 0) is 10 right of and 2 above the joint at (10, 0, 0); a quarter turn takes it to (8, 10, 0).
      positionOf(lastUploadedVertices(), 0).forEach((value, axis) => { assertNear(value, [8, 10, 0][axis], 1e-5); });
    });

    void test('draws nothing for a model without mesh data, as the server realm loads it', async () => {
      const model = await new IQMLoader(createModelLoadContext({ loadRenderData: false })).load(buildIqm(createTwoJointSpec()), 'progs/server.iqm');

      renderer.render(model, createEntity(), 0);
      renderer.renderShadow(model, createEntity(), shadowPass());

      assert.equal(recording.invocations('drawElements').length, 0);
      assert.equal(indexBufferUploads(), 0);
    });
  });

  void describe('drawing', () => {
    void test('uploads the triangles with their winding turned round, in 16 bits for a small mesh', async () => {
      // The engine culls the front face, so IQM's counter-clockwise triangles are drawn as 0, 2, 1.
      const model = await loadModel();

      renderer.render(model, createEntity(), 0);

      const indexUpload = recording.invocations('bufferData').find((args) => args[1] instanceof Uint16Array);
      assert.ok(indexUpload, 'no 16-bit index buffer was uploaded');
      assert.deepEqual(Array.from(indexUpload[1] as Uint16Array), [0, 2, 1]);
    });

    void test('draws one range per material with its own textures, each from its place in the index buffer', async () => {
      const model = await loadModel(createTwoMaterialSpec());
      model.materials[0].diffuse = createTexture('first diffuse');
      model.materials[0].glow = createTexture('first glow');
      model.materials[1].diffuse = createTexture('second diffuse');

      renderer.render(model, createEntity(), 0);

      // A triangle is three 16-bit indexes: the second range starts 6 bytes in.
      assert.deepEqual(recording.invocations('drawElements'), [
        [GL_TRIANGLES, 3, GL_UNSIGNED_SHORT, 0],
        [GL_TRIANGLES, 3, GL_UNSIGNED_SHORT, 6],
      ]);
      assert.deepEqual(bound, [
        'first diffuse@0', 'first glow@1', 'black@2', 'black@3',
        'second diffuse@0', 'black@1', 'black@2', 'black@3',
      ]);
    });

    void test('draws the checkerboard for a material without a base image', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity(), 0);

      assert.ok(bound.includes('notexture@0'));
    });

    void test('counts the triangles for r_speeds', async () => {
      const model = await loadModel(createTwoMaterialSpec());
      const stats = await import('../../source/engine/client/renderer/scene/RenderStats.ts');
      const before = stats.default.c_alias_polys;

      renderer.render(model, createEntity(), 0);

      assert.equal(stats.default.c_alias_polys - before, model._num_tris);
    });

    void test('shares one set of GL objects between all entities of a model', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity(), 0);
      renderer.render(model, createEntity(), 0);

      assert.equal(indexBufferUploads(), 1, 'the triangles are uploaded once, with the buffers of the model');
    });

    void test('makes new GL objects after the context was lost', async () => {
      const model = await loadModel();
      renderer.render(model, createEntity(), 0);

      eventBus.publish('gl.shutdown');
      recording = createRecordingContext();
      GL.gl = recording.gl;
      publishGlReady(recording.gl);
      renderer.render(model, createEntity(), 0);

      assert.equal(indexBufferUploads(), 1);
    });

    void test('blends only in the translucent pass, with the entity\'s alpha', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity({}, { alpha: 0.5 }), 0);
      assert.equal(recording.invocations('enable').length, 0);

      renderer.render(model, createEntity({}, { alpha: 0.5 }), 2);
      assert.equal(recording.invocations('enable').length, 1);
      assert.equal(recording.invocations('disable').length, 1);
      assert.equal(recording.invocations('uniform1f').find((args) => args[0] === 'uAlpha')![1], 0.5);
    });

    void test('draws a fully opaque entity in the opaque pass and a translucent one in the blended pass', async () => {
      const model = await loadModel();

      assert.equal(renderer.rendersOpaquePass(model, createEntity({}, { alpha: 1 })), true);
      assert.equal(renderer.rendersTransparentPass(model, createEntity({}, { alpha: 1 })), false);
      assert.equal(renderer.rendersOpaquePass(model, createEntity({}, { alpha: 0.5 })), false);
      assert.equal(renderer.rendersTransparentPass(model, createEntity({}, { alpha: 0.5 })), true);
      assert.equal(renderer.rendersTransparentPass(model, createEntity({}, { alpha: 0 })), false);
    });
  });

  void describe('player colors', () => {
    beforeEach(() => {
      W.d_8to24table = new Uint32Array(256);
      // colors 0x3c: shirt row 3 (index 59), pants row 12 (index 196)
      W.d_8to24table[59] = 51 + (102 << 8) + (153 << 16);
      W.d_8to24table[196] = 255 + (0 << 8) + (51 << 16);
    });

    void test('tints the shirt and pants of an entity with a colormap, in 0 to 1', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity({}, { colormap: 1 }), 0);

      assert.deepEqual(lastUniform('uShirtColor')!.map((value) => Math.round(value * 255)), [51, 102, 153]);
      assert.deepEqual(lastUniform('uPantsColor')!.map((value) => Math.round(value * 255)), [255, 0, 51]);
    });

    void test('leaves an entity without a colormap uncolored', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity({}, { colormap: 0 }), 0);

      assert.deepEqual(lastUniform('uShirtColor'), [0, 0, 0]);
      assert.deepEqual(lastUniform('uPantsColor'), [0, 0, 0]);
    });

    void test('leaves players uncolored while gl_nocolors is set', async () => {
      rendererCvars.nocolors = { value: 1 } as unknown as Cvar;
      const model = await loadModel();

      renderer.render(model, createEntity({}, { colormap: 1 }), 0);

      assert.deepEqual(lastUniform('uShirtColor'), [0, 0, 0]);
    });

    void test('leaves an entity whose colormap names no player uncolored', async () => {
      // `colormap` is a player's slot number plus one; an entity may carry a number no player has.
      const model = await loadModel();

      renderer.render(model, createEntity({}, { colormap: 9 }), 0);

      assert.deepEqual(lastUniform('uShirtColor'), [0, 0, 0]);
    });

    void test('starts the next entity from its own colors, not the last player\'s', async () => {
      const model = await loadModel();

      renderer.render(model, createEntity({}, { colormap: 1 }), 0);
      renderer.render(model, createEntity({}, { colormap: 0 }), 0);

      assert.deepEqual(lastUniform('uShirtColor'), [0, 0, 0]);
    });
  });

  void describe('shadows', () => {
    void test('draws every triangle with the shadow program of the pass, whatever the materials', async () => {
      const model = await loadModel(createTwoMaterialSpec());
      const entity = createEntity();

      renderer.renderShadow(model, entity, shadowPass());
      GL.currentProgram = null;
      renderer.renderShadow(model, entity, { ...shadowPass(), isPointLight: false });

      assert.deepEqual(recording.invocations('drawElements'), [
        [GL_TRIANGLES, 6, GL_UNSIGNED_SHORT, 0],
        [GL_TRIANGLES, 6, GL_UNSIGNED_SHORT, 0],
      ]);
      assert.deepEqual(recording.calls('useProgram'), ['useProgram(program shadow-point)', 'useProgram(program shadow-brush)']);
    });
  });
});
