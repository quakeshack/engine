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

/** A BSP light entity scored by influence at a focus point, before line-of-sight testing. */
interface LightScoreCandidate {
  readonly index: number;
  readonly score: number;
}

/** A BSP light entity selected as a local shadow-casting source. */
interface LocalLightSelection {
  readonly index: number;
  readonly origin: Vector;
  readonly radius: number;
}

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

  /** Width of the local caster fade band near the cutoff radius (world units). */
  static casterFadeRange: Cvar | null = null;

  /** Fallback shadow yaw when no nearby light is found (degrees). */
  static sunYaw: Cvar | null = null;

  /** Fallback shadow pitch when no nearby light is found (degrees, negative = downward). */
  static sunPitch: Cvar | null = null;

  /**
   * Minimum angle (degrees from horizontal) a map light must clear to cast a
   * local directional shadow. This pass only depth-tests entity geometry
   * (not the world), so grazing-angle directions both stretch shadows to
   * unnatural lengths and are the likeliest to bleed through walls.
   */
  static minElevation: Cvar | null = null;

  // ─── Local light direction ────────────────────────────────────────

  /**
   * Normalized direction vector the shadow light travels (light → scene).
   * Derived each frame from the closest visible light entity.
   */
  static localLightDirs: Vector[] = Array.from({ length: LOCAL_SHADOW_COUNT }, () => new Vector(0, 0, -1));

  /** Number of active local shadow directions this frame. */
  static localLightCount: number = 0;

  /**
   * Shadow intensity multiplier passed to the fragment shader as a blend
   * factor on `uShadowDarkness`. Fades toward 0 (no shadow) as the weakest
   * active local light approaches the edge of its influence radius, instead
   * of the shadow popping abruptly when a light falls out of range. Always
   * 1.0 (full configured darkness) when using the fallback direction.
   */
  static localLightFalloff: number = 1.0;

  /**
   * Score multiplier applied to a light that already occupies a local shadow
   * slot from the previous frame. Prevents near-tied candidates from
   * flip-flopping (and their potentially very different directions with
   * them) from one frame to the next as the player takes a single step.
   */
  static readonly _SELECTION_STICKINESS: number = 1.35;

  /** Entity num of the previous frame's local-shadow focus anchor, used for anchor-selection hysteresis. */
  static _previousAnchorNum: number = -1;

  /**
   * Squared distance-ratio hysteresis threshold for keeping the previous
   * frame's anchor entity: the incumbent is kept unless a new candidate is
   * closer by more than this margin, avoiding the shadow focus point
   * teleporting between similarly-distant casters (e.g. walking past a row
   * of pickups) on every frame.
   */
  static readonly _ANCHOR_HYSTERESIS_SQ: number = 1.3 * 1.3;

  // ─── Static light entity cache ────────────────────────────────────

  /**
   * Parsed light entities from the BSP entity lump.
   * Each entry holds a position and radius (derived from the entity's
   * `light` key, defaulting to 300). Populated once per map load.
   */
  static lightEntities: { origin: Vector; radius: number }[] = [];

  /** Reference to the worldmodel whose entities were last parsed. */
  static _parsedWorldmodel: BrushModel | null = null;

  /** Maximum number of light entities to test per frame (performance cap). */
  static _MAX_LIGHT_TRACES: number = 8;

  /** Distance used to nudge embedded light origins out of fixtures for LOS tests. */
  static _LIGHT_VISIBILITY_BIAS: number = 16.0;

  /** Scratch buffer for relaxed map-light visibility traces. */
  static _lightTraceScratch: Vector = new Vector();

  /** Stable focus point for the local entity-shadow projection. */
  static _shadowFocusPoint: Vector = new Vector();

  /** Indices of the map lights steering the local shadow directions. */
  static _currentLocalLightIndices: Int32Array = Int32Array.from([-1, -1, -1]);

  // ─── Point light shadow ──────────────────────────────────────────

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
    ShadowMap.casterFadeRange = new Cvar('r_shadow_caster_fade_range', (SHADOW_SIZE / 4).toFixed(0), Cvar.FLAG.ARCHIVE, 'Fade range near r_shadow_caster_radius where caster shadows dither in smoothly');
    ShadowMap.sunYaw = new Cvar('r_shadow_fallback_yaw', '225', Cvar.FLAG.ARCHIVE, 'Fallback shadow direction yaw when no nearby light is found (degrees)');
    ShadowMap.sunPitch = new Cvar('r_shadow_fallback_pitch', '-90', Cvar.FLAG.ARCHIVE, 'Fallback shadow direction pitch when no nearby light is found (degrees, negative = down)');
    ShadowMap.minElevation = new Cvar('r_shadow_min_elevation', '20', Cvar.FLAG.ARCHIVE, 'Minimum angle (degrees from horizontal) a map light must be at to cast a local directional shadow');

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
    isPointLight: boolean,
    cutoffOrigin: Vector | null = null,
    cutoffDistSq = Infinity,
  ): void {
    if (R.drawentities.value === 0) {
      return;
    }
    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (!ShadowMap._isLocalShadowCasterEntity(entity)) {
        continue;
      }

      // brush submodels only cast point light shadows, not top-down local shadows
      if (!isPointLight && entity.model!.name.startsWith('*')) {
        continue;
      }

      const casterFade = ShadowMap._computeLocalCasterFade(entity, cutoffOrigin, cutoffDistSq);

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
        // cutoffOrigin is the active point light's own origin for point-light
        // passes (see _renderPointLightShadowSlot); unused for local shadows.
        pointLightOrigin: cutoffOrigin!,
        pointNormalBias: ShadowMap.pointNormalBias?.value ?? 0,
      });
    }
  }

  /**
   * Determine whether an entity should contribute to the local shadow pass.
   * @returns True when the entity should cast a local directional shadow this frame.
   */
  static _isLocalShadowCasterEntity(
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
   * Compute distance-based fade for local shadow casters near the cutoff radius.
   * Returns 1 in the inner range and smoothly approaches 0 at the outer cutoff.
   * @returns Fade factor in the [0, 1] range.
   */
  static _computeLocalCasterFade(
    entity: ClientEdict,
    cutoffOrigin: Vector | null,
    cutoffDistSq: number,
  ): number {
    if (cutoffOrigin === null || !Number.isFinite(cutoffDistSq)) {
      return 1.0;
    }

    const distSq = ShadowMap._computeEntityDistanceSqToCutoff(entity, cutoffOrigin);
    if (distSq >= cutoffDistSq) {
      return 0.0;
    }

    const cutoffRadius = Math.sqrt(Math.max(0.0, cutoffDistSq));
    const fadeRange = Math.max(0.0, ShadowMap.casterFadeRange?.value ?? 0.0);
    if (fadeRange <= 0.0) {
      return 1.0;
    }

    const innerRadius = Math.max(0.0, cutoffRadius - fadeRange);
    const dist = Math.sqrt(distSq);
    if (dist <= innerRadius) {
      return 1.0;
    }

    const t = Math.min(1.0, Math.max(0.0, (dist - innerRadius) / fadeRange));
    return 1.0 - (t * t * (3.0 - 2.0 * t));
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
  static parseLightEntities(entityString: string): void { // TODO: that should not be done here
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

      const origin = new Vector(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
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
  static _traceVisible(start: Vector, end: Vector): boolean {
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
  static _traceLightVisible(start: Vector, end: Vector): boolean {
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
   * Determine up to LOCAL_SHADOW_COUNT local shadow directions used this frame.
   * The shadow focus follows the nearest visible caster; directions are drawn
   * from the strongest nearby, visible BSP light entities. Falls back to a
   * single configurable direction when no map light reaches the focus point.
   */
  static selectLocalLights(viewOrigin: Vector): void {
    let anchorEntity: ClientEdict | null = null;
    let bestDistSq = Infinity;
    let previousAnchorEntity: ClientEdict | null = null;
    let previousAnchorDistSq = Infinity;

    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (!ShadowMap._isLocalShadowCasterEntity(entity)) {
        continue;
      }

      // skip rendering top-down shadows for submodel brushes
      if (entity.model && entity.model.name.startsWith('*')) {
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

      if (entity.num === ShadowMap._previousAnchorNum) {
        previousAnchorEntity = entity;
        previousAnchorDistSq = distSq;
      }
    }

    // Hysteresis: keep the previous anchor unless a new candidate is
    // meaningfully closer, so the shadow focus point doesn't teleport
    // between similarly-distant casters (e.g. walking past clustered
    // entities) every frame.
    if (previousAnchorEntity !== null && previousAnchorDistSq <= bestDistSq * ShadowMap._ANCHOR_HYSTERESIS_SQ) {
      anchorEntity = previousAnchorEntity;
    }

    ShadowMap._previousAnchorNum = anchorEntity !== null ? anchorEntity.num : -1;

    const anchorPoint = anchorEntity !== null ? anchorEntity.lerp.origin : viewOrigin;

    ShadowMap._shadowFocusPoint[0] = anchorPoint[0];
    ShadowMap._shadowFocusPoint[1] = anchorPoint[1];
    ShadowMap._shadowFocusPoint[2] = anchorPoint[2];

    ShadowMap._ensureLightEntitiesParsed();

    const previousIndices = Int32Array.from(ShadowMap._currentLocalLightIndices);
    const selected = ShadowMap._selectNearbyMapLights(ShadowMap._shadowFocusPoint, previousIndices);

    if (selected.length === 0) {
      ShadowMap.localLightCount = 1;
      ShadowMap._applyFallbackDirection(0);
      for (let slotIndex = 1; slotIndex < LOCAL_SHADOW_COUNT; slotIndex++) {
        ShadowMap._currentLocalLightIndices[slotIndex] = -1;
      }
      return;
    }

    ShadowMap.localLightCount = selected.length;
    let minDistanceFade = 1.0;

    for (let slotIndex = 0; slotIndex < selected.length; slotIndex++) {
      const { index, origin, radius } = selected[slotIndex];
      ShadowMap._currentLocalLightIndices[slotIndex] = index;

      const dx = ShadowMap._shadowFocusPoint[0] - origin[0];
      const dy = ShadowMap._shadowFocusPoint[1] - origin[1];
      const dz = ShadowMap._shadowFocusPoint[2] - origin[2];
      const len = Math.hypot(dx, dy, dz);

      const dir = ShadowMap.localLightDirs[slotIndex];
      if (len < 1.0) {
        dir[0] = 0.0;
        dir[1] = 0.0;
        dir[2] = -1.0;
      } else {
        dir[0] = dx / len;
        dir[1] = dy / len;
        dir[2] = dz / len;
      }

      // Fade the shadow toward invisible as the caster nears the edge of the
      // light's influence radius, instead of the shadow popping abruptly
      // when the light drops out of range on the next frame.
      const distanceFade = Math.max(0.0, Math.min(1.0, (radius - len) / Math.max(radius, 1.0)));
      minDistanceFade = Math.min(minDistanceFade, distanceFade);
    }

    ShadowMap.localLightFalloff = minDistanceFade;

    for (let slotIndex = selected.length; slotIndex < LOCAL_SHADOW_COUNT; slotIndex++) {
      ShadowMap._currentLocalLightIndices[slotIndex] = -1;
    }
  }

  /**
   * Score every parsed BSP light entity by its influence at the focus point
   * (radius / distance, matching selectPointLights()'s heuristic), reject
   * grazing-angle directions below r_shadow_min_elevation, then confirm
   * line-of-sight visibility for the strongest candidates in order. Caps the
   * number of traces performed per frame at _MAX_LIGHT_TRACES.
   * @returns Up to LOCAL_SHADOW_COUNT visible lights, strongest first.
   */
  static _selectNearbyMapLights(focusPoint: Vector, previousIndices: Int32Array): LocalLightSelection[] {
    const entities = ShadowMap.lightEntities;
    if (entities.length === 0) {
      return [];
    }

    const minElevationSin = Math.sin(ShadowMap.minElevation!.value * Math.PI / 180.0);

    const candidates: LightScoreCandidate[] = [];
    for (let i = 0; i < entities.length; i++) {
      const light = entities[i];
      const dx = light.origin[0] - focusPoint[0];
      const dy = light.origin[1] - focusPoint[1];
      const dz = light.origin[2] - focusPoint[2];
      const dist = Math.hypot(dx, dy, dz);

      if (dist >= light.radius) {
        continue;
      }

      if (Math.abs(dz) / Math.max(dist, 1.0) < minElevationSin) {
        continue;
      }

      let score = light.radius / Math.max(dist, 1.0);
      // Hysteresis: favor keeping the light already occupying a slot last
      // frame so near-tied candidates don't flip-flop as the player moves.
      if (previousIndices.includes(i)) {
        score *= ShadowMap._SELECTION_STICKINESS;
      }

      candidates.push({ index: i, score });
    }

    candidates.sort((a, b) => b.score - a.score);

    const selected: LocalLightSelection[] = [];
    const traceLimit = Math.min(candidates.length, ShadowMap._MAX_LIGHT_TRACES);

    for (let i = 0; i < traceLimit && selected.length < LOCAL_SHADOW_COUNT; i++) {
      const light = entities[candidates[i].index];
      if (!ShadowMap._traceLightVisible(light.origin, focusPoint)) {
        continue;
      }

      selected.push({ index: candidates[i].index, origin: light.origin, radius: light.radius });
    }

    return selected;
  }

  /**
   * Parses the BSP light entity list once per worldmodel change, reusing the
   * cached results across selectLocalLights() and selectPointLights() calls.
   */
  static _ensureLightEntitiesParsed(): void {
    const worldmodel = CL.state.worldmodel as BrushModel | null;
    if (worldmodel && ShadowMap._parsedWorldmodel !== worldmodel) {
      ShadowMap.parseLightEntities(worldmodel.entities as string);
      ShadowMap._parsedWorldmodel = worldmodel;
    }
  }

  /**
   * Apply the configurable fallback shadow direction to a slot, used when no
   * map light reaches the shadow focus point. Yaw/pitch use an elevation
   * convention (pitch negative = downward), matching r_shadow_fallback_pitch's
   * documented sign rather than Vector.angleVectors()'s view-pitch convention.
   */
  static _applyFallbackDirection(slotIndex: number): void {
    ShadowMap._currentLocalLightIndices[slotIndex] = -1;

    const yawRad = ShadowMap.sunYaw!.value * Math.PI / 180.0;
    const pitchRad = ShadowMap.sunPitch!.value * Math.PI / 180.0;
    const cosPitch = Math.cos(pitchRad);

    const dir = ShadowMap.localLightDirs[slotIndex];
    dir[0] = cosPitch * Math.cos(yawRad);
    dir[1] = cosPitch * Math.sin(yawRad);
    dir[2] = Math.sin(pitchRad);

    ShadowMap.localLightFalloff = 1.0;
  }

  /**
   * Select up to POINT_SHADOW_COUNT of the strongest nearby dynamic lights as
   * independent point-shadow casters, scored the same way as
   * _selectNearbyMapLights() (radius / distance). Each selected light gets
   * its own cube depth map and its own analytic dlight contribution in the
   * scene shaders, so nearby dlights correctly occlude each other instead of
   * only the single strongest one casting any shadow at all.
   * @returns The number of active point-light shadow slots (0..POINT_SHADOW_COUNT).
   */
  static selectPointLights(viewOrigin: Vector): number {
    ShadowMap.pointLightActiveCount = 0;
    ShadowMap.pointLightDlightIndices.fill(-1);

    if (!ShadowMap.pointEnabled!.value) {
      return 0;
    }

    ShadowMap._ensureLightEntitiesParsed();

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
