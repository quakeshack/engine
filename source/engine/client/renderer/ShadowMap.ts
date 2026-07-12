import GL from '../GL.ts';
import Cvar from '../../common/Cvar.ts';
import { limits } from '../../common/Def.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import { MaterialFlags } from './Materials.ts';
import { effect } from '../../../shared/Defs.ts';
import Vector from '../../../shared/Vector.ts';
import type { BrushModel } from '../../common/model/BSP.ts';
import type { ClientEdict } from '../ClientEntities.ts';
import { modelRendererRegistry } from './ModelRendererRegistry.ts';

let { CL, R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, R } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/** Top-down shadow map resolution (px). */
const TOPDOWN_SHADOW_SIZE = 2048;

/** Point light cube shadow map resolution (px per face). */
const POINT_SHADOW_SIZE = 512;

/** Near plane for point light perspective projection. */
const POINT_NEAR = 1.0;

/**
 * Maximum number of simultaneous point-light shadow casters. Each slot renders
 * a full 6-face cube depth map, so this is deliberately small — enough for
 * the common case of a couple of nearby dlights (e.g. two rockets in
 * flight) to correctly occlude each other's contribution independently,
 * instead of only the single strongest dlight casting a shadow at all.
 */
const POINT_SHADOW_COUNT = 3;

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

/** A dynamic light scored by influence at the camera, before slot assignment. */
interface LightScoreCandidate {
  readonly index: number;
  readonly score: number;
}

/**
 * Shadow mapping for the scene: a single top-down directional shadow plus a
 * pool of dynamic point-light (dlight) cube shadows.
 *
 * The top-down shadow is deliberately simple — one fixed direction
 * (r_shadow_yaw/r_shadow_pitch), one orthographic depth map centered on the
 * camera every frame, only qualifying entities rendered as casters (world
 * geometry receives the shadow but never casts into this pass — see
 * renderTopDownShadow() for why). There is no per-frame light selection,
 * scoring, or hysteresis to reason about: the direction never changes, so
 * there is nothing to pop.
 *
 * The point-light pool is unrelated and untouched by any of that — dynamic
 * lights (rockets, explosions) each get their own cube depth map, centered
 * on the light itself, exactly as before.
 */
export default class ShadowMap {
  // ─── Top-down shadow ────────────────────────────────────────────────

  /** Master toggle for the top-down shadow (0 = off, 1 = on). */
  static enabled: Cvar | null = null;

  /** Orthographic half-size of the top-down shadow's coverage area, in world units, centered on the camera every frame. */
  static range: Cvar | null = null;

  /** Minimum brightness in shadow (0 = pitch black, 1 = no shadow). */
  static darkness: Cvar | null = null;

  /**
   * Maximum reach of the top-down shadow below its caster, in world units.
   * Without this cap, a caster high overhead (e.g. standing on a catwalk)
   * would bleed its shadow straight through the catwalk itself onto whatever
   * floor happens to be far below, since a single-layer depth map has no way
   * to know the catwalk was ever there — see the shaders' sampleLocalShadow /
   * sampleLocalShadowPCF for how this is enforced.
   */
  static maxDepth: Cvar | null = null;

  /** Top-down shadow direction yaw (degrees). */
  static yaw: Cvar | null = null;

  /** Top-down shadow direction pitch (degrees, negative = downward; -90 = straight down). */
  static pitch: Cvar | null = null;

  /** Depth-only FBO for the top-down shadow pass. */
  static topdownFBO: WebGLFramebuffer | null = null;

  /** Depth texture with hardware comparison (sampler2DShadow). */
  static topdownDepthTexture: WebGLTexture | null = null;

  /** 1×1 always-lit dummy texture used when the top-down shadow is off. */
  static topdownDummyTexture: WebGLTexture | null = null;

  /** Column-major 4×4 top-down light-space view-projection matrix, recomputed every frame from the camera position. */
  static topdownMatrix: Float64Array = new Float64Array(16);

  /** Top-down shadow map resolution in pixels (read by shaders for PCF texel size). */
  static size: number = TOPDOWN_SHADOW_SIZE;

  /**
   * Unit vector the top-down shadow travels along (from sky toward ground),
   * recomputed every frame in updateTopDownMatrix(). Read by the scene
   * shaders to mask the shadow off surfaces that face away from it — a
   * surface that never receives direct light from straight overhead (a wall,
   * the underside of a beam) shouldn't show a contact-shadow blotch either.
   */
  static lightDir: Vector = new Vector();

  // ─── Point light (cube) shadow ────────────────────────────────────

  /** Depth-only FBO for point light shadow (reused for all slots and faces). */
  static pointFBO: WebGLFramebuffer | null = null;

  /** Depth cubemaps with hardware comparison (samplerCubeShadow), one per active point-light slot. */
  static pointDepthCubes: WebGLTexture[] = [];

  /** 1×1 always-lit dummy cubemap used for inactive point-light slots. */
  static pointDummyCube: WebGLTexture | null = null;

  /** Column-major 4×4 per-face view-projection matrix (scratch, reused across slots and faces). */
  static pointFaceMatrix: Float64Array = new Float64Array(16);

  /** Active point light positions for this frame, one per slot. */
  static pointLightOrigins: Vector[] = Array.from({ length: POINT_SHADOW_COUNT }, () => new Vector());

  /** Active point light radii for this frame, one per slot. */
  static pointLightRadii: number[] = new Array(POINT_SHADOW_COUNT).fill(0);

  /** Active point light colors for this frame, one per slot (used for the un-baked analytic dlight contribution). */
  static pointLightColors: Vector[] = Array.from({ length: POINT_SHADOW_COUNT }, () => new Vector(1, 1, 1));

  /** Number of active point-light shadow slots this frame (0..POINT_SHADOW_COUNT). */
  static pointLightActiveCount: number = 0;

  /**
   * Index into CL.state.clientEntities.dlights for each active point-light
   * slot (-1 when the slot is unused). Read by R.AddDynamicLights() to
   * exclude these lights from the baked surface dlight texture, since their
   * contribution is instead computed analytically per-fragment and shadowed
   * independently by their own cube depth map.
   */
  static pointLightDlightIndices: Int32Array = Int32Array.from([-1, -1, -1]);

  /** Enable point light shadow mapping (0 = off, 1 = on). */
  static pointEnabled: Cvar | null = null;

  /** Normal offset bias for point light shadows (world units). */
  static pointNormalBias: Cvar | null = null;

  /** Receiver-side depth bias for point light shadows (normalized depth units, applied post-projection). */
  static pointBias: Cvar | null = null;

  /** Per-leaf flags marking world leaves that only hold submodel faces (lazy cache). */
  static _submodelLeafFlags: Uint8Array | null = null;

  /** Worldmodel the submodel leaf flags were computed for. */
  static _submodelLeafFlagsModel: BrushModel | null = null;

  // ─── Initialization ───────────────────────────────────────────────

  /**
   * Initialize the shadow mapping system.
   * Creates the top-down depth FBO/texture and the point-light cube FBO/textures.
   */
  static init(): void {
    ShadowMap.enabled = new Cvar('r_shadows', '1', Cvar.FLAG.ARCHIVE, 'Enable top-down shadow mapping');
    ShadowMap.range = new Cvar('r_shadow_range', (TOPDOWN_SHADOW_SIZE / 4).toFixed(0), Cvar.FLAG.ARCHIVE, 'Top-down shadow coverage radius in world units, centered on the camera');
    ShadowMap.darkness = new Cvar('r_shadow_darkness', '0.75', Cvar.FLAG.ARCHIVE, 'Minimum brightness in shadow (0=black, 1=no shadow)');
    ShadowMap.maxDepth = new Cvar('r_shadow_max_depth', '128', Cvar.FLAG.ARCHIVE, 'Maximum reach of the top-down shadow below its caster, in world units');
    ShadowMap.yaw = new Cvar('r_shadow_yaw', '0', Cvar.FLAG.ARCHIVE, 'Top-down shadow direction yaw (degrees)');
    ShadowMap.pitch = new Cvar('r_shadow_pitch', '-90', Cvar.FLAG.ARCHIVE, 'Top-down shadow direction pitch (degrees, negative = down)');

    // ── Top-down shadow depth texture ──────────────────────────────
    ShadowMap.topdownDepthTexture = gl.createTexture()!;
    GL.Bind(0, ShadowMap.topdownDepthTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, TOPDOWN_SHADOW_SIZE, TOPDOWN_SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    // ── Depth-only FBO ─────────────────────────────────────────────
    ShadowMap.topdownFBO = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.topdownFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, ShadowMap.topdownDepthTexture, 0);
    gl.drawBuffers([]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ── 1×1 dummy (always-lit) ─────────────────────────────────────
    ShadowMap.topdownDummyTexture = gl.createTexture()!;
    GL.Bind(0, ShadowMap.topdownDummyTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, new Uint32Array([0xFFFFFFFF]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    // ── Point light cubemap depth texture ──────────────────────────
    ShadowMap.pointEnabled = new Cvar('r_shadow_point', '1', Cvar.FLAG.NONE, 'Enable point light shadow mapping');
    ShadowMap.pointNormalBias = new Cvar('r_shadow_point_normal_bias', '2.5', Cvar.FLAG.NONE, 'Normal offset bias for point light shadows (world units)');
    ShadowMap.pointBias = new Cvar('r_shadow_point_bias', '0.002', Cvar.FLAG.NONE, 'Receiver depth bias for point light shadows (normalized depth units)');

    ShadowMap.pointDepthCubes.length = 0;
    for (let slot = 0; slot < POINT_SHADOW_COUNT; slot++) {
      const depthCube = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, depthCube);
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
      ShadowMap.pointDepthCubes.push(depthCube);
    }
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);

    // ── Point light depth FBO (face and slot attachment swapped each pass) ──
    ShadowMap.pointFBO = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.pointFBO);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_CUBE_MAP_POSITIVE_X, ShadowMap.pointDepthCubes[0], 0,
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

  // ─── Top-down matrix computation ───────────────────────────────────

  /**
   * Recompute the top-down light-space view-projection matrix. Uses a fixed
   * direction (r_shadow_yaw/r_shadow_pitch) and an orthographic frustum
   * centered on the camera every frame — there is no anchor entity, no
   * per-light scoring, nothing that can pop: the only thing that changes
   * frame to frame is where the camera itself is.
   */
  static updateTopDownMatrix(viewOrigin: Vector): void {
    const range = ShadowMap.range!.value;

    const yawRad = ShadowMap.yaw!.value * Math.PI / 180.0;
    const pitchRad = ShadowMap.pitch!.value * Math.PI / 180.0;
    const cosPitch = Math.cos(pitchRad);
    const dirX = cosPitch * Math.cos(yawRad);
    const dirY = cosPitch * Math.sin(yawRad);
    const dirZ = Math.sin(pitchRad);

    ShadowMap.lightDir[0] = dirX;
    ShadowMap.lightDir[1] = dirY;
    ShadowMap.lightDir[2] = dirZ;

    const eyeX = viewOrigin[0] - dirX * range;
    const eyeY = viewOrigin[1] - dirY * range;
    const eyeZ = viewOrigin[2] - dirZ * range;

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

    // Snap the frustum's translation to whole texels so the shadow doesn't
    // visibly swim/shimmer as the camera moves continuously.
    const texelSize = (2.0 * halfSize) / TOPDOWN_SHADOW_SIZE;
    v12 = Math.floor(v12 / texelSize) * texelSize;
    v13 = Math.floor(v13 / texelSize) * texelSize;

    const m = ShadowMap.topdownMatrix;
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

  // ─── Top-down shadow pass ──────────────────────────────────────────

  /**
   * Begin the top-down shadow depth pass. Binds the shadow FBO, clears
   * depth, and sets GL state.
   */
  static beginTopDown(): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.topdownFBO);
    gl.viewport(0, 0, TOPDOWN_SHADOW_SIZE, TOPDOWN_SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    gl.disable(gl.CULL_FACE);
  }

  /** End the top-down shadow depth pass and restore GL state. */
  static endTopDown(): void {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Render the top-down shadow depth pass: qualifying entities only, from a
   * fixed top-down direction, centered on the camera this frame.
   *
   * World geometry deliberately does not cast into this pass. A literal
   * top-down ray is blocked by whatever roof is overhead, and virtually
   * every indoor Quake room has one — rendering world geometry as a caster
   * here would mark almost the entire indoor floor plan "in shadow" all the
   * time, not just the spots actually shadowed by something. World geometry
   * still *receives* this shadow (a monster standing on the floor correctly
   * darkens the floor beneath it via the entity-caster pass below); it just
   * never contributes its own occlusion into the same depth map.
   */
  static renderTopDownShadow(viewOrigin: Vector): void {
    if (!CL.state.worldmodel) {
      return;
    }

    ShadowMap.updateTopDownMatrix(viewOrigin);
    ShadowMap.beginTopDown();

    const range = ShadowMap.range!.value;
    ShadowMap.renderEntitiesShadow(ShadowMap.topdownMatrix, false, viewOrigin, range * range);

    ShadowMap.endTopDown();
  }

  /** @returns The texture to bind as the top-down shadow map (real or dummy). */
  static getActiveTopDownTexture(): WebGLTexture {
    return ShadowMap.enabled!.value ? ShadowMap.topdownDepthTexture! : ShadowMap.topdownDummyTexture!;
  }

  // ─── Entity shadow rendering ──────────────────────────────────────

  /**
   * Render visible entities (brush submodels, alias models, mesh models)
   * into the active shadow map.
   */
  static renderEntitiesShadow(
    lightSpaceMatrix: Float64Array,
    isPointLight: boolean,
    cutoffOrigin: Vector,
    cutoffDistSq: number,
  ): void {
    if (R.drawentities.value === 0) {
      return;
    }
    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (!ShadowMap._isShadowCasterEntity(entity)) {
        continue;
      }

      // CR: commented out the submodel skip, I tuned the effects a bit
      // // brush submodels only cast point light shadows, not top-down shadows
      // if (!isPointLight && entity.model!.name.startsWith('*')) {
      //   continue;
      // }

      const casterFade = ShadowMap._computeCasterFade(entity, cutoffOrigin, cutoffDistSq);
      if (casterFade <= 0.0) {
        continue;
      }

      const model = entity.model!;
      console.assert(model !== null, `Entity ${entity.num} has no model`);

      const renderer = modelRendererRegistry.getRendererForModel(model);
      if (renderer === null) {
        continue;
      }

      renderer.renderShadow(model, entity, {
        lightSpaceMatrix,
        casterFade,
        isPointLight,
        pointLightOrigin: cutoffOrigin,
        pointNormalBias: ShadowMap.pointNormalBias?.value ?? 0,
      });
    }
  }

  /**
   * Determine whether an entity should contribute to the shadow pass.
   * @returns True when the entity should cast a shadow this frame.
   */
  static _isShadowCasterEntity(
    entity: ClientEdict,
  ): boolean {
    if (entity.model === null || entity.alpha === 0.0 || entity.alpha < 1.0) {
      return false;
    }

    if (entity.num === 0 || entity.isStatic()) {
      return false;
    }

    const noShadowEffects = effect.EF_MUZZLEFLASH | effect.EF_NOSHADOW
      | effect.EF_DIMLIGHT | effect.EF_FULLBRIGHT | effect.EF_BRIGHTLIGHT;
    if ((entity.effects & noShadowEffects) !== 0) {
      return false;
    }

    return true;
  }

  /**
   * Determine whether a caster is within its shadow's cutoff radius (the
   * top-down pass's r_shadow_range, or a point light's own radius).
   * @returns 1 when the entity is within cutoffDistSq of cutoffOrigin, 0 otherwise.
   */
  static _computeCasterFade(
    entity: ClientEdict,
    cutoffOrigin: Vector,
    cutoffDistSq: number,
  ): number {
    const distSq = ShadowMap._computeEntityDistanceSqToCutoff(entity, cutoffOrigin);
    return distSq < cutoffDistSq ? 1.0 : 0.0;
  }

  /**
   * Compute squared distance from the cutoff origin to the nearest point on an entity's
   * world-space AABB, falling back to entity origin when model bounds are unavailable.
   * @returns Squared distance in world units.
   */
  static _computeEntityDistanceSqToCutoff(
    entity: ClientEdict,
    cutoffOrigin: Vector,
  ): number {
    const model = entity.model;
    if (model === null) {
      return Infinity;
    }

    const origin = entity.lerp.origin;
    const modelMins = model.mins;
    const modelMaxs = model.maxs;
    if (modelMins === null || modelMaxs === null) {
      const dx = origin[0] - cutoffOrigin[0];
      const dy = origin[1] - cutoffOrigin[1];
      const dz = origin[2] - cutoffOrigin[2];
      return dx * dx + dy * dy + dz * dz;
    }

    const minsX = origin[0] + modelMins[0];
    const minsY = origin[1] + modelMins[1];
    const minsZ = origin[2] + modelMins[2];
    const maxsX = origin[0] + modelMaxs[0];
    const maxsY = origin[1] + modelMaxs[1];
    const maxsZ = origin[2] + modelMaxs[2];

    const nearestX = Math.max(minsX, Math.min(cutoffOrigin[0], maxsX));
    const nearestY = Math.max(minsY, Math.min(cutoffOrigin[1], maxsY));
    const nearestZ = Math.max(minsZ, Math.min(cutoffOrigin[2], maxsZ));
    const dx = nearestX - cutoffOrigin[0];
    const dy = nearestY - cutoffOrigin[1];
    const dz = nearestZ - cutoffOrigin[2];
    return dx * dx + dy * dy + dz * dz;
  }

  // ─── Point light selection ────────────────────────────────────────

  /**
   * Select up to POINT_SHADOW_COUNT of the strongest nearby dynamic lights as
   * independent point-shadow casters, scored by radius / distance from the
   * camera. Each selected light gets its own cube depth map and its own
   * analytic dlight contribution in the scene shaders, so nearby dlights
   * correctly occlude each other instead of only the single strongest one
   * casting any shadow at all.
   * @returns The number of active point-light shadow slots (0..POINT_SHADOW_COUNT).
   */
  static selectPointLights(viewOrigin: Vector): number {
    ShadowMap.pointLightActiveCount = 0;
    ShadowMap.pointLightDlightIndices.fill(-1);

    if (!ShadowMap.pointEnabled!.value) {
      return 0;
    }

    const dlights = CL.state.clientEntities.dlights;
    const candidates: LightScoreCandidate[] = [];

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

      candidates.push({ index: i, score });
    }

    candidates.sort((a, b) => b.score - a.score);

    const count = Math.min(candidates.length, POINT_SHADOW_COUNT);
    for (let slot = 0; slot < count; slot++) {
      const { index } = candidates[slot];
      const l = dlights[index];

      ShadowMap.pointLightDlightIndices[slot] = index;

      const origin = ShadowMap.pointLightOrigins[slot];
      origin[0] = l.origin[0];
      origin[1] = l.origin[1];
      origin[2] = l.origin[2];
      ShadowMap.pointLightRadii[slot] = l.radius;

      const color = ShadowMap.pointLightColors[slot];
      color[0] = l.color[0];
      color[1] = l.color[1];
      color[2] = l.color[2];
    }

    // Zero out any slots that held a light last frame but are unused this
    // frame (e.g. an expired explosion dlight dropping out of the top-N).
    // The scene shaders derive their analytic glow from radius alone (no
    // separate active-count uniform), so a stale non-zero radius here would
    // leave that light's last position glowing forever, unshadowed, until
    // some other dlight happened to reuse the same array slot.
    for (let slot = count; slot < POINT_SHADOW_COUNT; slot++) {
      ShadowMap.pointLightRadii[slot] = 0;
    }

    ShadowMap.pointLightActiveCount = count;
    return count;
  }

  /**
   * Build a 90° perspective view-projection matrix for one cube face of one
   * point-light slot. Writes into ShadowMap.pointFaceMatrix (column-major).
   */
  static buildPointFaceMatrix(faceIndex: number, slot: number): void {
    const face = CUBE_FACES[faceIndex];
    const origin = ShadowMap.pointLightOrigins[slot];
    const ox = origin[0];
    const oy = origin[1];
    const oz = origin[2];
    const far = ShadowMap.pointLightRadii[slot];

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

    // Standard full-range GL perspective depth: distance POINT_NEAR maps to
    // NDC z = -1 and distance `far` maps to NDC z = +1. The scene shaders
    // reconstruct the same mapping analytically from the light distance, so
    // these coefficients and the shader formula must stay in sync.
    const nf = (POINT_NEAR + far) / (POINT_NEAR - far);
    const nf2 = (2.0 * POINT_NEAR * far) / (POINT_NEAR - far);

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

  /**
   * Compute (and cache) per-leaf flags marking leaves that reference inline
   * submodel faces. The BSP leaf lump contains the leaves of all submodels,
   * and the world display list builder bakes their faces into `leaf.cmds` at
   * map-compile position. Those leaves must not be drawn as static world
   * geometry in the shadow passes — the entity shadow pass renders submodels
   * at their actual entity position instead.
   * @returns One flag per leaf; 1 when the leaf references submodel faces.
   */
  static _getSubmodelLeafFlags(worldmodel: BrushModel): Uint8Array {
    if (ShadowMap._submodelLeafFlagsModel === worldmodel && ShadowMap._submodelLeafFlags !== null) {
      return ShadowMap._submodelLeafFlags;
    }

    const flags = new Uint8Array(worldmodel.leafs.length);
    for (let i = 0; i < worldmodel.leafs.length; i++) {
      const leaf = worldmodel.leafs[i];
      for (let k = 0; k < leaf.nummarksurfaces; k++) {
        const face = worldmodel.faces[worldmodel.marksurfaces[leaf.firstmarksurface + k]];
        if (face.submodel) {
          flags[i] = 1;
          break;
        }
      }
    }

    ShadowMap._submodelLeafFlags = flags;
    ShadowMap._submodelLeafFlagsModel = worldmodel;
    return flags;
  }

  /** Render the point light shadow cube maps (all 6 faces) for every active slot. */
  static renderPointLightShadow(): void {
    const worldmodel = CL.state.worldmodel as BrushModel | null;
    if (!worldmodel) {
      return;
    }

    const submodelLeafFlags = ShadowMap._getSubmodelLeafFlags(worldmodel);

    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.pointFBO);
    gl.viewport(0, 0, POINT_SHADOW_SIZE, POINT_SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.CULL_FACE);

    for (let slot = 0; slot < ShadowMap.pointLightActiveCount; slot++) {
      ShadowMap._renderPointLightShadowSlot(worldmodel, submodelLeafFlags, slot);
    }

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Render one point-light slot's 6 cube faces (world BSP opaque geometry
   * plus entities) into ShadowMap.pointDepthCubes[slot].
   */
  static _renderPointLightShadowSlot(
    worldmodel: BrushModel,
    submodelLeafFlags: Uint8Array,
    slot: number,
  ): void {
    const pointLightOrigin = ShadowMap.pointLightOrigins[slot];
    const pointLightRadius = ShadowMap.pointLightRadii[slot];
    const pointCasterCutoffDistSq = pointLightRadius * pointLightRadius;

    GL.BindVAO(worldmodel.opaqueVAO as WebGLVertexArrayObject);
    const program = GL.UseProgram('shadow-point')!;

    gl.uniform3f(program.uOrigin!, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform3fv(program.uLightPos!, pointLightOrigin);
    gl.uniform1f(program.uLightRadius!, pointLightRadius);
    gl.uniform1f(program.uNormalBias!, ShadowMap.pointNormalBias!.value);

    for (let face = 0; face < 6; face++) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        ShadowMap.pointDepthCubes[slot], 0,
      );
      gl.clear(gl.DEPTH_BUFFER_BIT);

      ShadowMap.buildPointFaceMatrix(face, slot);
      gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ShadowMap.pointFaceMatrix);

      for (let i = 0; i < worldmodel.leafs.length; i++) {
        const leaf = worldmodel.leafs[i];

        if (leaf.skychain === 0) {
          continue;
        }

        // skip submodel leaves, since they are rendered separately by the entity shadow pass
        if (submodelLeafFlags[i]) {
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
      ShadowMap.renderEntitiesShadow(
        ShadowMap.pointFaceMatrix,
        true,
        pointLightOrigin,
        pointCasterCutoffDistSq,
      );

      GL.BindVAO(worldmodel.opaqueVAO!);
      GL.UseProgram('shadow-point');
      gl.uniform3f(program.uOrigin!, 0, 0, 0);
      gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    }

    GL.UnbindVAO();
  }

  /** @returns The cube textures to bind as point shadow maps, one per slot (real or dummy). */
  static getActivePointTextures(): WebGLTexture[] {
    const textures = new Array<WebGLTexture>(POINT_SHADOW_COUNT);
    for (let i = 0; i < POINT_SHADOW_COUNT; i++) {
      textures[i] = i < ShadowMap.pointLightActiveCount
        ? ShadowMap.pointDepthCubes[i]
        : ShadowMap.pointDummyCube!;
    }
    return textures;
  }
}
