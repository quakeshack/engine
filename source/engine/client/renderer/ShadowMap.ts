import GL from '../GL.ts';
import Cvar from '../../common/Cvar.ts';
import { limits } from '../../common/Def.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import { MaterialFlags } from './Materials.ts';
import { effect } from '../../../shared/Defs.ts';
import Vector from '../../../shared/Vector.ts';
import { AliasModelRenderer } from './AliasModelRenderer.ts';
import type { BrushModel } from '../../common/model/BSP.ts';
import type { AliasModel } from '../../common/model/AliasModel.ts';
import type { MeshModel } from '../../common/model/MeshModel.ts';
import type { ClientEdict } from '../ClientEntities.ts';
import { ModelType } from '../../common/Mod.ts';

let { CL, COM, R, SV } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, R, SV } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/** Shadow map resolution (px). Local coverage keeps this sharp at 1024. */
const SHADOW_SIZE = 2048;

/** Maximum number of local directional shadows rendered each frame. */
const LOCAL_SHADOW_COUNT = 3;

/** Point light cube shadow map resolution (px per face). */
const POINT_SHADOW_SIZE = 256;

/** Near plane for point light perspective projection. */
const POINT_NEAR = 1.0;

/**
 * The 6 cube face directions and their up vectors.
 * Order matches GL_TEXTURE_CUBE_MAP_POSITIVE_X .. NEGATIVE_Z.
 * Each entry: [targetX, targetY, targetZ, upX, upY, upZ]
 */
const CUBE_FACES: [number, number, number, number, number, number][] = [
  [ 1,  0,  0,   0, -1,  0], // +X
  [-1,  0,  0,   0, -1,  0], // -X
  [ 0,  1,  0,   0,  0,  1], // +Y
  [ 0, -1,  0,   0,  0, -1], // -Y
  [ 0,  0,  1,   0, -1,  0], // +Z
  [ 0,  0, -1,   0, -1,  0], // -Z
];

/**
 * Directional and point-light shadow mapping for the scene.
 *
 * Renders the world BSP into a depth-only FBO from the light's perspective,
 * then the scene shaders sample this depth texture (via `sampler2DShadow`)
 * to darken fragments that are occluded. The result is a coarse, soft shadow
 * that integrates naturally with the baked lightmaps.
 */
export default class ShadowMap {
  // ─── FBO & textures ──────────────────────────────────────────────

  /** Depth-only framebuffer for the shadow pass. */
  static fbo: WebGLFramebuffer | null = null;

  /** Depth textures with hardware comparison (sampler2DShadow). */
  static depthTextures: WebGLTexture[] = [];

  /** 1×1 always-lit dummy texture used when shadows are off. */
  static dummyTexture: WebGLTexture | null = null;

  // ─── Matrices ────────────────────────────────────────────────────

  /** Column-major 4×4 light-space view-projection matrices. */
  static lightSpaceMatrices: Float64Array[] = Array.from({ length: LOCAL_SHADOW_COUNT }, () => new Float64Array(16));

  // ─── Cvars ───────────────────────────────────────────────────────

  /** Master toggle (0 = off, 1 = on). */
  static enabled: Cvar | null = null;

  /** Orthographic half-size in world units. */
  static range: Cvar | null = null;

  /** Minimum brightness in shadow (0 = pitch black, 1 = no shadow). */
  static darkness: Cvar | null = null;

  /** Maximum distance from the viewer for local shadow casters. */
  static casterRadius: Cvar | null = null;

  /** Fallback shadow yaw when no nearby light is found (degrees). */
  static sunYaw: Cvar | null = null;

  /** Fallback shadow pitch when no nearby light is found (degrees, negative = downward). */
  static sunPitch: Cvar | null = null;

  // ─── Local light direction ────────────────────────────────────────

  /**
   * Normalized direction vector the shadow light travels (light → scene).
   * Derived each frame from the closest visible light entity.
   */
  static localLightDirs: Float64Array[] = Array.from({ length: LOCAL_SHADOW_COUNT }, () => new Float64Array([0, 0, -1]));

  /** Number of active local shadow directions this frame. */
  static localLightCount: number = 0;

  /**
   * Shadow intensity multiplier passed to the fragment shader as `uShadowEnabled`.
   * Always 1.0 when using static BSP light data.
   */
  static localLightFalloff: number = 1.0;

  // ─── Static light entity cache ────────────────────────────────────

  /**
   * Parsed light entities from the BSP entity lump.
   * Each entry holds a position and radius (derived from the entity's
   * `light` key, defaulting to 300). Populated once per map load.
   */
  static lightEntities: { origin: Float64Array; radius: number }[] = [];

  /** Reference to the worldmodel whose entities were last parsed. */
  static _parsedWorldmodel: BrushModel | null = null;

  /** Maximum number of light entities to test per frame (performance cap). */
  static _MAX_LIGHT_TRACES: number = 8;

  /** Distance used to nudge embedded light origins out of fixtures for LOS tests. */
  static _LIGHT_VISIBILITY_BIAS: number = 16.0;

  /** Scratch buffer for relaxed map-light visibility traces. */
  static _lightTraceScratch: Float64Array = new Float64Array(3);

  /** Stable focus point for the local entity-shadow projection. */
  static _shadowFocusPoint: Float64Array = new Float64Array(3);

  /** Indices of the map lights steering the local shadow directions. */
  static _currentLocalLightIndices: Int32Array = Int32Array.from([-1, -1, -1]);

  // ─── Point light shadow ──────────────────────────────────────────

  /** Depth-only FBO for point light shadow (reused for all 6 faces). */
  static pointFBO: WebGLFramebuffer | null = null;

  /** Depth cubemap with hardware comparison (samplerCubeShadow). */
  static pointDepthCube: WebGLTexture | null = null;

  /** 1×1 always-lit dummy cubemap used when point shadows are off. */
  static pointDummyCube: WebGLTexture | null = null;

  /** Column-major 4×4 per-face view-projection matrix. */
  static pointFaceMatrix: Float64Array = new Float64Array(16);

  /** Active point light position [x, y, z] for this frame. */
  static pointLightOrigin: Float64Array = new Float64Array(3);

  /** Active point light radius for this frame. */
  static pointLightRadius: number = 0;

  /** Whether a point light shadow was rendered this frame. */
  static pointLightActive: boolean = false;

  /** Enable point light shadow mapping (0 = off, 1 = on). */
  static pointEnabled: Cvar | null = null;

  /** Normal offset bias for point light shadows (world units). */
  static pointNormalBias: Cvar | null = null;

  /** Shadow map resolution in pixels (read by shaders for PCF texel size). */
  static size: number = SHADOW_SIZE;

  // ─── Initialization ───────────────────────────────────────────────

  /**
   * Initialize the shadow mapping system.
   * Creates the depth FBO, shadow texture and dummy texture.
   */
  static init(): void {
    ShadowMap.enabled = new Cvar('r_shadows', '1', Cvar.FLAG.ARCHIVE, 'Enable local entity shadow mapping');
    ShadowMap.range = new Cvar('r_shadow_range', (SHADOW_SIZE / 4).toFixed(0), Cvar.FLAG.ARCHIVE, 'Local shadow map coverage radius in world units');
    ShadowMap.darkness = new Cvar('r_shadow_darkness', '0.66', Cvar.FLAG.ARCHIVE, 'Minimum brightness in shadow (0=black, 1=no shadow)');
    ShadowMap.casterRadius = new Cvar('r_shadow_caster_radius', (SHADOW_SIZE / 4).toFixed(0), Cvar.FLAG.ARCHIVE, 'Maximum distance from the local caster cluster for entities to contribute to local shadows');
    ShadowMap.sunYaw = new Cvar('r_shadow_fallback_yaw', '225', Cvar.FLAG.ARCHIVE, 'Fallback shadow direction yaw when no nearby light is found (degrees)');
    ShadowMap.sunPitch = new Cvar('r_shadow_fallback_pitch', '-90', Cvar.FLAG.ARCHIVE, 'Fallback shadow direction pitch when no nearby light is found (degrees, negative = down)');

    // ── Shadow depth textures ──────────────────────────────────────
    ShadowMap.depthTextures.length = 0;
    for (let i = 0; i < LOCAL_SHADOW_COUNT; i++) {
      const depthTexture = gl.createTexture()!;
      ShadowMap.depthTextures.push(depthTexture);
      GL.Bind(0, depthTexture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    }

    // ── Depth-only FBO ─────────────────────────────────────────────
    ShadowMap.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, ShadowMap.depthTextures[0], 0);
    gl.drawBuffers([]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ── 1×1 dummy (always-lit) ─────────────────────────────────────
    ShadowMap.dummyTexture = gl.createTexture()!;
    GL.Bind(0, ShadowMap.dummyTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, new Uint32Array([0xFFFFFFFF]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    // ── Point light cubemap depth texture ──────────────────────────
    ShadowMap.pointEnabled = new Cvar('r_shadow_point', '1', Cvar.FLAG.ARCHIVE, 'Enable point light shadow mapping');
    ShadowMap.pointNormalBias = new Cvar('r_shadow_point_normal_bias', '1.5', Cvar.FLAG.ARCHIVE, 'Normal offset bias for point light shadows (world units)');

    ShadowMap.pointDepthCube = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, ShadowMap.pointDepthCube);
    for (let face = 0; face < 6; face++) {
      gl.texImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.DEPTH_COMPONENT24,
        POINT_SHADOW_SIZE, POINT_SHADOW_SIZE, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null,
      );
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);

    // ── Point light depth FBO (face attachment swapped each pass) ──
    ShadowMap.pointFBO = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.pointFBO);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_CUBE_MAP_POSITIVE_X, ShadowMap.pointDepthCube, 0,
    );
    gl.drawBuffers([]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ── 1×1 dummy cubemap (always-lit) ─────────────────────────────
    ShadowMap.pointDummyCube = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, ShadowMap.pointDummyCube);
    const dummyPixel = new Uint32Array([0xFFFFFFFF]);
    for (let face = 0; face < 6; face++) {
      gl.texImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.DEPTH_COMPONENT24,
        1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, dummyPixel,
      );
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  }

  // ─── Matrix computation ───────────────────────────────────────────

  /**
   * Recompute the light-space view-projection matrix for one local shadow.
   * Uses an orthographic projection centred on the local shadow focus point.
   */
  static _updateLightSpaceMatrix(slotIndex: number): void {
    const range = ShadowMap.range!.value;
    const focusPoint = ShadowMap._shadowFocusPoint;
    const focusX = focusPoint[0];
    const focusY = focusPoint[1];
    const focusZ = focusPoint[2];

    const dir = ShadowMap.localLightDirs[slotIndex];
    const dirX = dir[0];
    const dirY = dir[1];
    const dirZ = dir[2];

    const eyeX = focusX - dirX * range;
    const eyeY = focusY - dirY * range;
    const eyeZ = focusZ - dirZ * range;

    const fX = dirX, fY = dirY, fZ = dirZ;

    let upX = 0, upY = 0, upZ = 1;
    if (Math.abs(fZ) > 0.99) {
      upX = 1; upY = 0; upZ = 0;
    }

    let rX = fY * upZ - fZ * upY;
    let rY = fZ * upX - fX * upZ;
    let rZ = fX * upY - fY * upX;
    const rLen = Math.hypot(rX, rY, rZ);
    rX /= rLen; rY /= rLen; rZ /= rLen;

    upX = rY * fZ - rZ * fY;
    upY = rZ * fX - rX * fZ;
    upZ = rX * fY - rY * fX;

    const zX = -fX, zY = -fY, zZ = -fZ;

    const v0 = rX, v1 = upX, v2 = zX;
    const v4 = rY, v5 = upY, v6 = zY;
    const v8 = rZ, v9 = upZ, v10 = zZ;
    let v12 = -(rX * eyeX + rY * eyeY + rZ * eyeZ);
    let v13 = -(upX * eyeX + upY * eyeY + upZ * eyeZ);
    const v14 = -(zX * eyeX + zY * eyeY + zZ * eyeZ);

    const halfSize = range;
    const near = 0.0;
    const far = range * 2.0;
    const invHS = 1.0 / halfSize;
    const invDepth = -2.0 / (far - near);
    const nfTerm = -(far + near) / (far - near);

    const texelSize = (2.0 * halfSize) / SHADOW_SIZE;
    v12 = Math.floor(v12 / texelSize) * texelSize;
    v13 = Math.floor(v13 / texelSize) * texelSize;

    const m = ShadowMap.lightSpaceMatrices[slotIndex];
    m[0]  = invHS * v0;
    m[1]  = invHS * v1;
    m[2]  = invDepth * v2;
    m[3]  = 0;
    m[4]  = invHS * v4;
    m[5]  = invHS * v5;
    m[6]  = invDepth * v6;
    m[7]  = 0;
    m[8]  = invHS * v8;
    m[9]  = invHS * v9;
    m[10] = invDepth * v10;
    m[11] = 0;
    m[12] = invHS * v12;
    m[13] = invHS * v13;
    m[14] = invDepth * v14 + nfTerm;
    m[15] = 1;
  }

  /** Recompute all active local shadow matrices for the current frame. */
  static updateLightSpaceMatrices(): void {
    for (let i = 0; i < ShadowMap.localLightCount; i++) {
      ShadowMap._updateLightSpaceMatrix(i);
    }
  }

  // ─── Shadow pass management ───────────────────────────────────────

  /**
   * Begin the shadow depth pass for a local directional shadow slot.
   * Binds the shadow FBO, clears depth, and sets GL state.
   */
  static begin(slotIndex: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      ShadowMap.depthTextures[slotIndex],
      0,
    );
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    gl.disable(gl.CULL_FACE);
  }

  /** End the shadow depth pass and restore GL state. */
  static end(): void {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ─── World shadow rendering ───────────────────────────────────────

  /**
   * Render the world BSP opaque geometry into the shadow map.
   * Uses a large polygon offset so the world depth is pushed well behind
   * its true position to prevent self-shadowing on world surfaces.
   */
  static renderWorldShadow(): void {
    const worldmodel = CL.state.worldmodel as BrushModel | null;
    if (!worldmodel) {
      return;
    }

    gl.polygonOffset(8.0, 4096.0);

    GL.BindVAO(worldmodel.opaqueVAO as WebGLVertexArrayObject);
    const program = GL.UseProgram('shadow-brush')!;

    gl.uniform3f(program.uOrigin!, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ShadowMap.lightSpaceMatrices[0]);

    for (let i = 0; i < worldmodel.leafs.length; i++) {
      const leaf = worldmodel.leafs[i];
      if (leaf.skychain === 0) {
        continue;
      }

      for (let j = 0; j < leaf.skychain; j++) {
        const cmds = leaf.cmds[j];
        const flags = (worldmodel.textures[cmds[0]] as { flags: number }).flags;

        if (flags & (MaterialFlags.MF_SKIP | MaterialFlags.MF_TRANSPARENT)) {
          continue;
        }

        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
      }
    }

    GL.UnbindVAO();
    gl.polygonOffset(1.0, 1.0);
  }

  // ─── Entity shadow rendering ──────────────────────────────────────

  /**
   * Render visible entities (brush submodels, alias models, mesh models)
   * into the active shadow map.
   */
  static renderEntitiesShadow(
    lightSpaceMatrix: Float64Array,
    brushProgram = 'shadow-brush',
    aliasProgram = 'shadow-alias',
    cutoffOrigin: Vector | Float64Array | number[] | null = null,
    cutoffDistSq = Infinity,
  ): void {
    if (R.drawentities.value === 0) {
      return;
    }
    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (!ShadowMap._isLocalShadowCasterEntity(entity, cutoffOrigin, cutoffDistSq)) {
        continue;
      }
      const model = entity.model!;
      console.assert(model !== null, `Entity ${entity.num} has no model`);
      switch (model.type) {
        case ModelType.brush:
          ShadowMap._renderBrushEntityShadow(model as BrushModel, entity, lightSpaceMatrix, brushProgram);
          break;
        case ModelType.alias:
          ShadowMap._renderAliasEntityShadow(model as AliasModel, entity, lightSpaceMatrix, aliasProgram);
          break;
        case ModelType.mesh:
          ShadowMap._renderMeshEntityShadow(model as MeshModel, entity, lightSpaceMatrix, brushProgram);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Determine whether an entity should contribute to the local shadow pass.
   * @returns True when the entity should cast a local directional shadow this frame.
   */
  static _isLocalShadowCasterEntity(
    entity: ClientEdict,
    cutoffOrigin: Vector | Float64Array | number[] | null,
    cutoffDistSq: number,
  ): boolean {
    if (entity.model === null || entity.alpha === 0.0 || entity.alpha < 1.0) {
      return false;
    }

    if (entity.num === 0 || entity.isStatic()) {
      return false;
    }

    if (entity.model.name.startsWith('*')) {
      return false;
    }

    const noShadowEffects = effect.EF_MUZZLEFLASH | effect.EF_NOSHADOW
      | effect.EF_DIMLIGHT | effect.EF_FULLBRIGHT | effect.EF_BRIGHTLIGHT;
    if (entity.effects & noShadowEffects) {
      return false;
    }

    const type = entity.model.type;
    if (type !== ModelType.brush && type !== ModelType.alias && type !== ModelType.mesh) {
      return false;
    }

    if (cutoffOrigin !== null && Number.isFinite(cutoffDistSq)) {
      const dx = entity.lerp.origin[0] - cutoffOrigin[0];
      const dy = entity.lerp.origin[1] - cutoffOrigin[1];
      const dz = entity.lerp.origin[2] - cutoffOrigin[2];
      if ((dx * dx + dy * dy + dz * dz) > cutoffDistSq) {
        return false;
      }
    }

    return true;
  }

  /** @private */
  static _renderBrushEntityShadow(
    model: BrushModel,
    entity: ClientEdict,
    lightSpaceMatrix: Float64Array,
    programName: string,
  ): void {
    if (!model.opaqueVAO || !model.chains || model.chains.length === 0) {
      return;
    }
    GL.BindVAO(model.opaqueVAO as WebGLVertexArrayObject);
    const program = GL.UseProgram(programName)!;

    gl.uniform3fv(program.uOrigin!, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, lightSpaceMatrix);

    for (let i = 0; i < model.chains.length; i++) {
      const chain = model.chains[i];
      const flags = (model.textures[chain[0]] as { flags: number }).flags;
      if (flags & (MaterialFlags.MF_SKIP | MaterialFlags.MF_TRANSPARENT | MaterialFlags.MF_TURBULENT)) {
        continue;
      }
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
    }
    GL.UnbindVAO();
  }

  /** @private */
  static _renderAliasEntityShadow(
    model: AliasModel,
    entity: ClientEdict,
    lightSpaceMatrix: Float64Array,
    programName: string,
  ): void {
    if (!model.cmds) {
      return;
    }
    const program = GL.UseProgram(programName)!;

    gl.uniform3fv(program.uOrigin!, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, lightSpaceMatrix);

    const { frameA, frameB, targettime } = AliasModelRenderer._selectFrames(model, entity);

    gl.uniform1f(program.uInterpolation!, R.interpolation.value && (entity.effects & effect.EF_MUZZLEFLASH) === 0 ? Math.min(1, Math.max(0, targettime)) : 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, model.cmds as WebGLBuffer);
    gl.enableVertexAttribArray(program.aPositionA!.location as number);
    gl.enableVertexAttribArray(program.aPositionB!.location as number);
    gl.vertexAttribPointer(program.aPositionA!.location as number, 3, gl.FLOAT, false, 24, frameA.cmdofs!);
    gl.vertexAttribPointer(program.aPositionB!.location as number, 3, gl.FLOAT, false, 24, frameB.cmdofs!);

    if (program.aNormalA) {
      gl.enableVertexAttribArray(program.aNormalA!.location as number);
      gl.enableVertexAttribArray(program.aNormalB!.location as number);
      gl.vertexAttribPointer(program.aNormalA!.location as number, 3, gl.FLOAT, false, 24, frameA.cmdofs! + 12);
      gl.vertexAttribPointer(program.aNormalB!.location as number, 3, gl.FLOAT, false, 24, frameB.cmdofs! + 12);
      gl.uniform3fv(program.uLightPos!, ShadowMap.pointLightOrigin);
      gl.uniform1f(program.uNormalBias!, ShadowMap.pointNormalBias!.value);
    }

    gl.drawArrays(gl.TRIANGLES, 0, model._num_tris * 3);

    gl.disableVertexAttribArray(program.aPositionA!.location as number);
    gl.disableVertexAttribArray(program.aPositionB!.location as number);
    if (program.aNormalA) {
      gl.disableVertexAttribArray(program.aNormalA!.location as number);
      gl.disableVertexAttribArray(program.aNormalB!.location as number);
    }
  }

  /** @private */
  static _renderMeshEntityShadow(
    model: MeshModel,
    entity: ClientEdict,
    lightSpaceMatrix: Float64Array,
    programName: string,
  ): void {
    if (!model.vao) {
      return;
    }
    GL.BindVAO(model.vao);
    const program = GL.UseProgram(programName)!;

    gl.uniform3fv(program.uOrigin!, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, lightSpaceMatrix);

    const indexType = model.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    gl.drawElements(gl.TRIANGLES, model.numTriangles * 3, indexType, 0);
    GL.UnbindVAO();
  }

  // ─── Active texture queries ───────────────────────────────────────

  /** @returns The textures to bind as local shadow maps. */
  static getActiveTextures(): WebGLTexture[] {
    const textures = new Array<WebGLTexture>(LOCAL_SHADOW_COUNT);
    for (let i = 0; i < LOCAL_SHADOW_COUNT; i++) {
      textures[i] = ShadowMap.enabled!.value && i < ShadowMap.localLightCount
        ? ShadowMap.depthTextures[i]
        : ShadowMap.dummyTexture!;
    }
    return textures;
  }

  // ─── Point light (cube) shadow mapping ───────────────────────────

  /**
   * Parse all light entities from the BSP entity lump and cache them.
   * Scans the raw entity string for entities whose classname starts with `"light"`.
   */
  static parseLightEntities(entityString: string): void {
    ShadowMap.lightEntities.length = 0;
    ShadowMap._currentLocalLightIndices.fill(-1);
    ShadowMap.localLightCount = 0;

    if (!entityString) {
      return;
    }

    let data: string | null = entityString;

    while (data) {
      const parsed = COM.Parse(data);
      data = parsed.data;

      if (!data || parsed.token !== '{') {
        break;
      }

      const ent: Record<string, string> = {};
      while (data) {
        const parsedKey = COM.Parse(data);
        data = parsedKey.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        const parsedValue = COM.Parse(data);
        data = parsedValue.data;

        if (!data || parsedValue.token === '}') {
          break;
        }

        ent[parsedKey.token] = parsedValue.token;
      }

      if (!ent.classname || !ent.classname.startsWith('light') || !ent.origin) {
        continue;
      }

      const parts = ent.origin.split(' ');
      if (parts.length < 3) {
        continue;
      }

      const origin = new Float64Array([
        parseFloat(parts[0]),
        parseFloat(parts[1]),
        parseFloat(parts[2]),
      ]);

      const radius = ent.light ? parseFloat(ent.light) : 300;

      if (radius > 0 && !Number.isNaN(origin[0])) {
        ShadowMap.lightEntities.push({ origin, radius });
      }
    }

    console.debug(`Parsed ${ShadowMap.lightEntities.length} light entities from BSP`, ShadowMap.lightEntities);
  }

  /**
   * Test line-of-sight between two points using the world BSP hull 0.
   * @returns True if the line is unobstructed.
   */
  static _traceVisible(start: Vector | Float64Array | number[], end: Vector | Float64Array | number[]): boolean {
    const trace = SV.collision.traceStaticWorldLine(
      new Vector(start[0], start[1], start[2]),
      new Vector(end[0], end[1], end[2]),
    );
    return trace.fraction === 1.0 && !trace.allsolid && !trace.startsolid;
  }

  /**
   * Test visibility from a map light to the target, allowing for lights that
   * are embedded slightly inside wall fixtures or ceilings.
   * @returns True if a direct or nudged trace is unobstructed.
   */
  static _traceLightVisible(start: Vector | Float64Array | number[], end: Vector | Float64Array | number[]): boolean {
    if (ShadowMap._traceVisible(start, end)) {
      return true;
    }

    const dirX = end[0] - start[0];
    const dirY = end[1] - start[1];
    const dirZ = end[2] - start[2];
    const dist = Math.hypot(dirX, dirY, dirZ);

    if (dist <= 1.0) {
      return false;
    }

    const invDist = 1.0 / dist;
    const bias = Math.min(ShadowMap._LIGHT_VISIBILITY_BIAS, dist * 0.33);
    const nudgedStart = ShadowMap._lightTraceScratch;
    nudgedStart[0] = start[0] + dirX * invDist * bias;
    nudgedStart[1] = start[1] + dirY * invDist * bias;
    nudgedStart[2] = start[2] + dirZ * invDist * bias;

    return ShadowMap._traceVisible(nudgedStart, end);
  }

  /**
   * Determine the single top-down local shadow used this frame.
   * The shadow focus follows the nearest visible caster.
   */
  static selectLocalLights(viewOrigin: Vector | Float64Array | number[]): void {
    let anchorEntity: ClientEdict | null = null;
    let bestDistSq = Infinity;

    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (!ShadowMap._isLocalShadowCasterEntity(entity, null, Infinity)) {
        continue;
      }

      const dx = entity.lerp.origin[0] - viewOrigin[0];
      const dy = entity.lerp.origin[1] - viewOrigin[1];
      const dz = entity.lerp.origin[2] - viewOrigin[2];
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        anchorEntity = entity;
      }
    }

    const anchorPoint = anchorEntity !== null ? anchorEntity.lerp.origin : viewOrigin;

    ShadowMap._shadowFocusPoint[0] = anchorPoint[0];
    ShadowMap._shadowFocusPoint[1] = anchorPoint[1];
    ShadowMap._shadowFocusPoint[2] = anchorPoint[2];

    ShadowMap.localLightCount = 1;
    ShadowMap._applyFallbackDirection(0);
    for (let slotIndex = 1; slotIndex < LOCAL_SHADOW_COUNT; slotIndex++) {
      ShadowMap._currentLocalLightIndices[slotIndex] = -1;
    }
  }

  /** Apply the configurable fallback shadow direction to a slot. */
  static _applyFallbackDirection(slotIndex: number): void {
    ShadowMap._currentLocalLightIndices[slotIndex] = -1;
    const dir = ShadowMap.localLightDirs[slotIndex];
    dir[0] = 0.0;
    dir[1] = 0.0;
    dir[2] = -1.0;
    ShadowMap.localLightFalloff = 1.0;
  }

  /**
   * Select the strongest light for point shadow casting.
   * Considers both transient dynamic lights and static BSP light entities.
   * @returns True if a suitable light was found.
   */
  static selectPointLight(viewOrigin: Vector | Float64Array | number[]): boolean {
    ShadowMap.pointLightActive = false;

    if (!ShadowMap.pointEnabled!.value) {
      return false;
    }

    const worldmodel = CL.state.worldmodel as BrushModel | null;
    if (worldmodel && ShadowMap._parsedWorldmodel !== worldmodel) {
      ShadowMap.parseLightEntities(worldmodel.entities as string);
      ShadowMap._parsedWorldmodel = worldmodel;
    }

    let bestScore = -1;
    let bestOriginX = 0;
    let bestOriginY = 0;
    let bestOriginZ = 0;
    let bestRadius = 0;

    const dlights = CL.state.clientEntities.dlights;
    for (let i = 0; i < limits.dlights; i++) {
      const l = dlights[i];
      if (l.isFree() || l.radius <= 0) {
        continue;
      }

      const dx = l.origin[0] - viewOrigin[0];
      const dy = l.origin[1] - viewOrigin[1];
      const dz = l.origin[2] - viewOrigin[2];
      const dist = Math.hypot(dx, dy, dz);
      const score = l.radius / Math.max(dist, 1.0);

      if (score > bestScore) {
        bestScore = score;
        bestOriginX = l.origin[0];
        bestOriginY = l.origin[1];
        bestOriginZ = l.origin[2];
        bestRadius = l.radius;
      }
    }

    if (bestScore < 0) {
      return false;
    }

    ShadowMap.pointLightOrigin[0] = bestOriginX;
    ShadowMap.pointLightOrigin[1] = bestOriginY;
    ShadowMap.pointLightOrigin[2] = bestOriginZ;
    ShadowMap.pointLightRadius = bestRadius;
    ShadowMap.pointLightActive = true;
    return true;
  }

  /**
   * Build a 90° perspective view-projection matrix for one cube face.
   * Writes into ShadowMap.pointFaceMatrix (column-major).
   */
  static buildPointFaceMatrix(faceIndex: number): void {
    const face = CUBE_FACES[faceIndex];
    const ox = ShadowMap.pointLightOrigin[0];
    const oy = ShadowMap.pointLightOrigin[1];
    const oz = ShadowMap.pointLightOrigin[2];
    const far = ShadowMap.pointLightRadius;

    const tx = face[0], ty = face[1], tz = face[2];
    let ux = face[3], uy = face[4], uz = face[5];

    let rx = ty * uz - tz * uy;
    let ry = tz * ux - tx * uz;
    let rz = tx * uy - ty * ux;
    const rLen = Math.hypot(rx, ry, rz);
    rx /= rLen; ry /= rLen; rz /= rLen;

    ux = ry * tz - rz * ty;
    uy = rz * tx - rx * tz;
    uz = rx * ty - ry * tx;

    const fwX = -tx, fwY = -ty, fwZ = -tz;

    const v12 = -(rx * ox + ry * oy + rz * oz);
    const v13 = -(ux * ox + uy * oy + uz * oz);
    const v14 = -(fwX * ox + fwY * oy + fwZ * oz);

    const nf = POINT_NEAR / (POINT_NEAR - far);
    const nf2 = (POINT_NEAR * far) / (POINT_NEAR - far);

    const m = ShadowMap.pointFaceMatrix;
    m[0]  = rx;
    m[1]  = ux;
    m[2]  = nf * fwX;
    m[3]  = -fwX;
    m[4]  = ry;
    m[5]  = uy;
    m[6]  = nf * fwY;
    m[7]  = -fwY;
    m[8]  = rz;
    m[9]  = uz;
    m[10] = nf * fwZ;
    m[11] = -fwZ;
    m[12] = v12;
    m[13] = v13;
    m[14] = nf * v14 + nf2;
    m[15] = -v14;
  }

  /** Render the point light shadow cube map (all 6 faces). */
  static renderPointLightShadow(): void {
    const worldmodel = CL.state.worldmodel as BrushModel | null;
    if (!worldmodel) {
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.pointFBO);
    gl.viewport(0, 0, POINT_SHADOW_SIZE, POINT_SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.CULL_FACE);

    GL.BindVAO(worldmodel.opaqueVAO as WebGLVertexArrayObject);
    const program = GL.UseProgram('shadow-point')!;

    gl.uniform3f(program.uOrigin!, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform3fv(program.uLightPos!, ShadowMap.pointLightOrigin);
    gl.uniform1f(program.uLightRadius!, ShadowMap.pointLightRadius);
    gl.uniform1f(program.uNormalBias!, ShadowMap.pointNormalBias!.value);

    for (let face = 0; face < 6; face++) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        ShadowMap.pointDepthCube, 0,
      );
      gl.clear(gl.DEPTH_BUFFER_BIT);

      ShadowMap.buildPointFaceMatrix(face);
      gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ShadowMap.pointFaceMatrix);

      for (let i = 0; i < worldmodel.leafs.length; i++) {
        const leaf = worldmodel.leafs[i];
        if (leaf.skychain === 0) {
          continue;
        }
        for (let j = 0; j < leaf.skychain; j++) {
          const cmds = leaf.cmds[j];
          const flags = (worldmodel.textures[cmds[0]] as { flags: number }).flags;
          if (flags & (MaterialFlags.MF_SKIP | MaterialFlags.MF_TRANSPARENT)) {
            continue;
          }
          gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
        }
      }

      GL.UnbindVAO();
      ShadowMap.renderEntitiesShadow(ShadowMap.pointFaceMatrix, 'shadow-point', 'shadow-alias-point');

      GL.BindVAO(worldmodel.opaqueVAO as WebGLVertexArrayObject);
      GL.UseProgram('shadow-point');
      gl.uniform3f(program.uOrigin!, 0, 0, 0);
      gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    }

    GL.UnbindVAO();
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** @returns The cube texture to bind as point shadow map (real or dummy). */
  static getActivePointTexture(): WebGLTexture {
    return ShadowMap.pointLightActive ? ShadowMap.pointDepthCube! : ShadowMap.pointDummyCube!;
  }
}
