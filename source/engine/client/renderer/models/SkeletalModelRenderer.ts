import Vector from '../../../../shared/Vector.ts';
import { effect } from '../../../../shared/Defs.ts';
import { eventBus } from '../../../common/EventBus.ts';
import type { BaseModel } from '../../../common/model/BaseModel.ts';
import { SkeletalAnimation } from '../../../common/model/SkeletalAnimation.ts';
import type { SkeletalMaterial, SkeletalMeshData, SkeletalModel } from '../../../common/model/SkeletalModel.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import GL, { ATTRIB_LOCATIONS, type GLProgramInfo } from '../../GL.ts';
import EntityLighting from '../lighting/EntityLighting.ts';
import ShadowMap from '../lighting/ShadowMap.ts';
import { getEntityBloomEmissiveScale } from '../postprocess/BloomEffect.ts';
import DefaultTextures from '../resources/DefaultTextures.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import Camera from '../scene/Camera.ts';
import RenderStats from '../scene/RenderStats.ts';
import { ModelRenderer, type ShadowRenderContext } from './ModelRenderer.ts';
import { PlayerColors } from './PlayerColors.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
  SkeletalModelRenderer.resetGpuState();
});

/** Numbers per skinned vertex: position `x, y, z`, texture coordinate `s, t`, normal `x, y, z`. */
const VERTEX_FLOATS = 8;
const POSITION_OFFSET = 0;
const TEXCOORD_OFFSET = 3;
const NORMAL_OFFSET = 5;

/** The GL objects of one mesh, which every entity that uses the model shares. */
interface SkeletalGpuMesh {
  /** Receives the skinned vertices of the entity being drawn, again for every draw. */
  readonly vertexBuffer: WebGLBuffer;
  readonly indexBuffer: WebGLBuffer;
  readonly vao: WebGLVertexArrayObject;
  /** `gl.UNSIGNED_SHORT` or `gl.UNSIGNED_INT`. */
  readonly indexType: number;
  readonly indexBytes: number;
}

/** The skinned vertices of an entity, and the pose they were made for. */
interface SkinnedPose {
  readonly meshData: SkeletalMeshData;
  readonly vertices: Float32Array;
  frameA: number;
  frameB: number;
  blend: number;
}

/** What the garbage collector hands back when a model's mesh data is gone. */
interface GpuHandles {
  readonly vertexBuffer: WebGLBuffer;
  readonly indexBuffer: WebGLBuffer;
  readonly vao: WebGLVertexArrayObject;
}

/**
 * Renderer of skeletal models (IQM): poses and skins the mesh on the CPU for every entity, draws the result with the
 * `skeletal` program and casts its shadow through the same shadow programs as the mesh models.
 *
 * Per entity and pose the skinned vertices are made once (`#skinnedPose`) and reused by the shadow passes, which
 * upload them again for their own draw. An entity that is culled is never skinned. Which frames to blend comes from
 * the entity's `lerp.frame` as for alias models, so frame-driven game code needs no change.
 *
 * The GL objects belong to the mesh data of the model, which every scoped view of it shares, and go when the model
 * is dropped.
 */
export class SkeletalModelRenderer extends ModelRenderer {
  /** GL objects by mesh data, created the first time a model is drawn. */
  static #gpuMeshes = new WeakMap<SkeletalMeshData, SkeletalGpuMesh>();

  /** Frees the GL objects of a model whose mesh data has been collected. */
  static readonly #gpuCleanup = new FinalizationRegistry<GpuHandles>((handles) => {
    if (gl === null) {
      return;
    }

    gl.deleteBuffer(handles.vertexBuffer);
    gl.deleteBuffer(handles.indexBuffer);
    gl.deleteVertexArray(handles.vao);
  });

  /** Skinned vertices by entity. */
  static readonly #skinnedPoses = new WeakMap<ClientEdict, SkinnedPose>();

  /** Joint matrices of the pose being made, grown to the largest model. */
  static #jointMatrices = new Float32Array(0);

  /** Skinning matrices of the pose being made. */
  static #skinningMatrices = new Float32Array(0);

  static readonly #cullMins = new Vector();
  static readonly #cullMaxs = new Vector();
  static readonly #shirtColor = new Float32Array(3);
  static readonly #pantsColor = new Float32Array(3);

  /** Model class this renderer is registered for. A renderer per class: the registry matches the exact class. */
  readonly #modelClass: typeof BaseModel;

  /**
   * @param modelClass The concrete class of the model format this renderer is registered for.
   */
  constructor(modelClass: typeof BaseModel) {
    super();
    this.#modelClass = modelClass;
  }

  override get profileName(): string {
    return 'skeletal models';
  }

  override getModelClass(): typeof BaseModel {
    return this.#modelClass;
  }

  /**
   * Forgets every GL object. Run when the GL context goes away, which takes the objects with it.
   */
  static resetGpuState(): void {
    SkeletalModelRenderer.#gpuMeshes = new WeakMap();
  }

  override setupRenderState(_pass = 0): void {
    // Every entity binds its own program and buffers.
  }

  /**
   * @param _model The skeletal model.
   * @param entity The entity being rendered.
   * @returns True when the entity is opaque.
   */
  override rendersOpaquePass(_model: BaseModel, entity: ClientEdict): boolean {
    return entity.alpha >= 1.0;
  }

  /**
   * @param _model The skeletal model.
   * @param entity The entity being rendered.
   * @returns True when the entity is translucent, which sorts it into the blended pass.
   */
  override rendersTransparentPass(_model: BaseModel, entity: ClientEdict): boolean {
    return entity.alpha > 0.0 && entity.alpha < 1.0;
  }

  override cleanupRenderState(_pass = 0): void {
    // Every entity cleans up after itself.
  }

  /**
   * Draws one entity: culls it, skins it for its pose, lights it and draws one range of triangles per material.
   * @param model The skeletal model.
   * @param entity The entity being rendered.
   * @param pass 0 for opaque entities, 2 for translucent ones.
   */
  override render(model: BaseModel, entity: ClientEdict, pass = 0): void {
    const skeletal = model as SkeletalModel;
    const meshData = skeletal.meshData;

    if (meshData === null || SkeletalModelRenderer.#isCulled(skeletal, entity)) {
      return;
    }

    const gpuMesh = SkeletalModelRenderer.#gpuMeshFor(meshData);
    const vertices = SkeletalModelRenderer.#skinnedPose(skeletal, meshData, entity);

    const program = GL.UseProgram('skeletal')!;
    GL.BindVAO(gpuMesh.vao);

    gl.uniform3fv(program.uOrigin!, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, entity.lerp.angles.toRotationMatrix());

    const [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition] = EntityLighting.CalculateLightValues(entity);
    gl.uniform3fv(program.uAmbientLight!, ambientlight);
    gl.uniform3fv(program.uShadeLight!, shadelight);
    gl.uniform3fv(program.uLightVec!, lightPosition);
    gl.uniform3fv(program.uDynamicShadeLight!, dynamicShadeLight);
    gl.uniform3fv(program.uDynamicLightVec!, dynamicLightPosition);
    gl.uniform1f(program.uAlpha!, entity.alpha);
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(entity.effects));
    SkeletalModelRenderer.#uploadPlayerColors(program.uShirtColor!, program.uPantsColor!, entity);

    SkeletalModelRenderer.#bindShadowTextures(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);

    if (pass === 2) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    for (const range of skeletal.meshes) {
      SkeletalModelRenderer.#bindMaterial(skeletal.materials[range.materialIndex], program);
      gl.drawElements(gl.TRIANGLES, range.triangleCount * 3, gpuMesh.indexType, range.firstTriangle * 3 * gpuMesh.indexBytes);
    }

    if (pass === 2) {
      gl.disable(gl.BLEND);
    }

    GL.UnbindVAO();

    // Counted with the alias models' polygons in r_speeds, like the mesh models.
    RenderStats.c_alias_polys += skeletal._num_tris;
  }

  /**
   * Draws the entity's shadow into the active shadow map with the shadow programs of the mesh models.
   * @param model The skeletal model.
   * @param entity The shadow caster.
   * @param ctx The shadow pass the caster is drawn into.
   */
  override renderShadow(model: BaseModel, entity: ClientEdict, ctx: ShadowRenderContext): void {
    const skeletal = model as SkeletalModel;
    const meshData = skeletal.meshData;

    if (meshData === null) {
      return;
    }

    const gpuMesh = SkeletalModelRenderer.#gpuMeshFor(meshData);
    const vertices = SkeletalModelRenderer.#skinnedPose(skeletal, meshData, entity);

    const program = GL.UseProgram(ctx.isPointLight ? 'shadow-point' : 'shadow-brush')!;
    GL.BindVAO(gpuMesh.vao);

    gl.uniform3fv(program.uOrigin!, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ctx.lightSpaceMatrix);

    gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, meshData.triangles.length, gpuMesh.indexType, 0);

    GL.UnbindVAO();
  }

  /**
   * Nothing to build up front: the GL objects are made when the model is first drawn, so a model that is never
   * visible costs none.
   */
  override prepareModel(_model: BaseModel, _isWorldModel = false): void {
    // See above.
  }

  /**
   * Frees the GL objects of a model's mesh now, rather than when its data is collected.
   * @param model The skeletal model.
   */
  override cleanupModel(model: BaseModel): void {
    const meshData = (model as SkeletalModel).meshData;
    const gpuMesh = meshData === null ? undefined : SkeletalModelRenderer.#gpuMeshes.get(meshData);

    if (meshData === null || gpuMesh === undefined) {
      return;
    }

    gl.deleteBuffer(gpuMesh.vertexBuffer);
    gl.deleteBuffer(gpuMesh.indexBuffer);
    gl.deleteVertexArray(gpuMesh.vao);
    SkeletalModelRenderer.#gpuMeshes.delete(meshData);
  }

  /**
   * Whether the entity is outside the view frustum. The sphere around the origin that holds every frame of the
   * model is used, so a turning entity needs no box of its own.
   * @param model The skeletal model.
   * @param entity The entity.
   * @returns True when it cannot be seen.
   */
  static #isCulled(model: SkeletalModel, entity: ClientEdict): boolean {
    const radius = model.boundingradius;
    const mins = SkeletalModelRenderer.#cullMins;
    const maxs = SkeletalModelRenderer.#cullMaxs;

    mins.setTo(entity.origin[0] - radius, entity.origin[1] - radius, entity.origin[2] - radius);
    maxs.setTo(entity.origin[0] + radius, entity.origin[1] + radius, entity.origin[2] + radius);

    return Camera.CullBox(mins, maxs);
  }

  /**
   * Picks the two frames to blend and the weight of the second, the way alias models do: the entity's interpolated
   * frame, or its plain frame while interpolation is off or a muzzle flash makes the pose jump.
   * @param entity The entity.
   * @returns Frame A, frame B and the blend.
   */
  static #selectPose(entity: ClientEdict): [number, number, number] {
    if (rendererCvars.interpolation.value && (entity.effects & effect.EF_MUZZLEFLASH) === 0) {
      return entity.lerp.frame;
    }

    return [entity.frame, entity.frame, 0];
  }

  /**
   * The skinned vertices of an entity for the frame it is in, made again only when the pose changed since the last
   * call, so the main pass and the shadow passes of a frame share one skinning.
   * @param model The skeletal model.
   * @param meshData Its mesh data.
   * @param entity The entity.
   * @returns Interleaved vertices (`VERTEX_FLOATS` numbers each), owned by the cache: valid until the next call for this entity.
   */
  static #skinnedPose(model: SkeletalModel, meshData: SkeletalMeshData, entity: ClientEdict): Float32Array {
    const [frameA, frameB, blend] = SkeletalModelRenderer.#selectPose(entity);
    let pose = SkeletalModelRenderer.#skinnedPoses.get(entity);

    if (pose === undefined || pose.meshData !== meshData) {
      pose = { meshData, vertices: SkeletalModelRenderer.#createVertices(meshData), frameA: -1, frameB: -1, blend: 0 };
      SkeletalModelRenderer.#skinnedPoses.set(entity, pose);
    }

    if (pose.frameA === frameA && pose.frameB === frameB && pose.blend === blend) {
      return pose.vertices;
    }

    const matrixFloats = model.jointCount * SkeletalAnimation.MATRIX_FLOATS;

    if (SkeletalModelRenderer.#jointMatrices.length < matrixFloats) {
      SkeletalModelRenderer.#jointMatrices = new Float32Array(matrixFloats);
      SkeletalModelRenderer.#skinningMatrices = new Float32Array(matrixFloats);
    }

    SkeletalAnimation.computePose(model, frameA, frameB, blend, SkeletalModelRenderer.#jointMatrices, SkeletalModelRenderer.#skinningMatrices);
    SkeletalAnimation.skinMeshInto(meshData, SkeletalModelRenderer.#skinningMatrices, pose.vertices, VERTEX_FLOATS, POSITION_OFFSET, NORMAL_OFFSET);

    pose.frameA = frameA;
    pose.frameB = frameB;
    pose.blend = blend;

    return pose.vertices;
  }

  /**
   * @param meshData The bind pose mesh.
   * @returns An interleaved vertex array with the texture coordinates in place, which skinning never changes.
   */
  static #createVertices(meshData: SkeletalMeshData): Float32Array {
    const vertexCount = meshData.positions.length / 3;
    const vertices = new Float32Array(vertexCount * VERTEX_FLOATS);

    for (let vertex = 0; vertex < vertexCount; vertex++) {
      vertices[vertex * VERTEX_FLOATS + TEXCOORD_OFFSET] = meshData.texcoords[vertex * 2];
      vertices[vertex * VERTEX_FLOATS + TEXCOORD_OFFSET + 1] = meshData.texcoords[vertex * 2 + 1];
    }

    return vertices;
  }

  /**
   * @param meshData The mesh data of the model being drawn.
   * @returns Its GL objects, created on the first call.
   */
  static #gpuMeshFor(meshData: SkeletalMeshData): SkeletalGpuMesh {
    const existing = SkeletalModelRenderer.#gpuMeshes.get(meshData);

    if (existing !== undefined) {
      return existing;
    }

    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const vertexCount = meshData.positions.length / 3;
    const useShortIndices = vertexCount <= 0x10000;

    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexCount * VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, SkeletalModelRenderer.#windingFlipped(meshData.triangles, useShortIndices), gl.STATIC_DRAW);

    const stride = VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    const vao = GL.CreateVAO(vertexBuffer, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride, offset: POSITION_OFFSET * 4 },
      { location: ATTRIB_LOCATIONS.aTexCoord, components: 2, type: gl.FLOAT, normalized: false, stride, offset: TEXCOORD_OFFSET * 4 },
      { location: ATTRIB_LOCATIONS.aNormal, components: 3, type: gl.FLOAT, normalized: false, stride, offset: NORMAL_OFFSET * 4 },
    ], indexBuffer);

    const gpuMesh: SkeletalGpuMesh = {
      vertexBuffer: vertexBuffer!,
      indexBuffer: indexBuffer!,
      vao,
      indexType: useShortIndices ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
      indexBytes: useShortIndices ? 2 : 4,
    };

    SkeletalModelRenderer.#gpuMeshes.set(meshData, gpuMesh);
    SkeletalModelRenderer.#gpuCleanup.register(meshData, { vertexBuffer: gpuMesh.vertexBuffer, indexBuffer: gpuMesh.indexBuffer, vao });

    return gpuMesh;
  }

  /**
   * The engine culls the front face (`gl.cullFace(gl.FRONT)`), so a model whose triangles run counter-clockwise, as IQM
   * stores them, needs every triangle turned round, which is what the OBJ models get as well.
   * @param triangles Three vertex indexes per triangle, counter-clockwise.
   * @param useShortIndices Whether the vertex count fits in 16 bits.
   * @returns The same triangles, clockwise.
   */
  static #windingFlipped(triangles: Uint32Array, useShortIndices: boolean): Uint16Array | Uint32Array {
    const flipped = useShortIndices ? new Uint16Array(triangles.length) : new Uint32Array(triangles.length);

    for (let index = 0; index < triangles.length; index += 3) {
      flipped[index] = triangles[index];
      flipped[index + 1] = triangles[index + 2];
      flipped[index + 2] = triangles[index + 1];
    }

    return flipped;
  }

  /**
   * Binds the textures of a material, with the dark default for a layer it does not have.
   * @param material The material of the range being drawn.
   * @param program The `skeletal` program.
   */
  static #bindMaterial(material: SkeletalMaterial, program: GLProgramInfo): void {
    (material.diffuse ?? DefaultTextures.notexture).bind(program.tTexture!);
    (material.glow ?? DefaultTextures.blacktexture).bind(program.tGlow!);
    (material.shirt ?? DefaultTextures.blacktexture).bind(program.tShirt!);
    (material.pants ?? DefaultTextures.blacktexture).bind(program.tPants!);
  }

  /**
   * Sets the shirt and pants colors of a player entity, black for everything else, which turns the masks off.
   * @param shirtLocation Location of `uShirtColor`.
   * @param pantsLocation Location of `uPantsColor`.
   * @param entity The entity being drawn.
   */
  static #uploadPlayerColors(shirtLocation: WebGLUniformLocation, pantsLocation: WebGLUniformLocation, entity: ClientEdict): void {
    const shirt = SkeletalModelRenderer.#shirtColor;
    const pants = SkeletalModelRenderer.#pantsColor;
    const score = entity.colormap !== 0 && rendererCvars.nocolors.value === 0 ? clientRuntimeState.scores[entity.colormap - 1] : undefined;

    if (score === undefined) {
      shirt.fill(0.0);
      pants.fill(0.0);
    } else {
      PlayerColors.shirtInto(score.colors, shirt);
      PlayerColors.pantsInto(score.colors, pants);

      for (let channel = 0; channel < 3; channel++) {
        shirt[channel] /= 255.0;
        pants[channel] /= 255.0;
      }
    }

    gl.uniform3fv(shirtLocation, shirt);
    gl.uniform3fv(pantsLocation, pants);
  }

  /**
   * Binds the top-down and point light shadow maps the lighting reads, when there are any.
   * @param program The `skeletal` program.
   */
  static #bindShadowTextures(program: GLProgramInfo): void {
    const topDownShadow = ShadowMap.getActiveTopDownTexture();

    if (program.tShadowMap !== undefined && topDownShadow) {
      topDownShadow.bind(program.tShadowMap);
    }

    const topDownBlockers = ShadowMap.getActiveTopDownBlockerTexture();

    if (program.tShadowBlockerMap !== undefined && topDownBlockers) {
      topDownBlockers.bind(program.tShadowBlockerMap);
    }

    const pointShadows = ShadowMap.getActivePointTextures();

    if (program.tPointShadowMap0 !== undefined && pointShadows[0]) {
      pointShadows[0].bind(program.tPointShadowMap0);
    }

    if (program.tPointShadowMap1 !== undefined && pointShadows[1]) {
      pointShadows[1].bind(program.tPointShadowMap1);
    }

    if (program.tPointShadowMap2 !== undefined && pointShadows[2]) {
      pointShadows[2].bind(program.tPointShadowMap2);
    }
  }
}
