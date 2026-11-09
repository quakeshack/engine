import GL, { GLCubeTexture, GLRenderTexture } from '../../GL.ts';
import Frame from '../frame/Frame.ts';
import RenderTarget from '../frame/RenderTarget.ts';
import Cvar from '../../../common/Cvar.ts';
import { limits } from '../../../common/Def.ts';
import { eventBus } from '../../../common/EventBus.ts';
import { MaterialFlags } from '../models/Materials.ts';
import { effect } from '../../../../shared/Defs.ts';
import Vector from '../../../../shared/Vector.ts';
import { BrushModel } from '../../../common/model/BSP.ts';
import { WorldRenderState } from '../../../common/model/WorldRenderState.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import { modelRendererRegistry } from '../models/ModelRendererRegistry.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import rendererCvars from '../resources/RendererCvars.ts';


let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * Orders draw chains (`[texture, first vertex, count]`) by where they start in the vertex buffer.
 * @returns Negative when a starts first.
 */
function compareChainsByFirstVertex(a: number[], b: number[]): number {
  return a[1] - b[1];
}

/** Top-down shadow map resolution (px). */
const TOPDOWN_SHADOW_SIZE = 2048;

/** Point light cube shadow map resolution (px per face). */
const POINT_SHADOW_SIZE = 512;

/**
 * How far a receiver may lie below the first world surface under a caster and still take its shadow, in world units.
 * Covers the receiver being that surface itself, sampled between texels on a slope. World geometry thinner than this
 * would not stop a shadow; no Quake brush is that thin.
 */
const BLOCKER_RECEIVER_BIAS = 4.0;

/**
 * How far a world surface must lie below a caster to be taken as the surface under it, in world units, so the
 * caster's own top, where it meets a world face, is not taken for one.
 */
const BLOCKER_CASTER_EPSILON = 1.0;

/**
 * Margin around a caster's footprint in the blocker map, in texels: how far beyond a caster's silhouette a receiver
 * still reads it, through the 5×5 PCF taps (2 texels), their linear filtering and that of the blocker lookup (1 each).
 */
const FOOTPRINT_MARGIN_TEXELS = 4;

/** Near plane for point light perspective projection, `POINT_SHADOW_NEAR` in shadow-point.glsl. */
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
 * renderTopDownShadow() for why). A second map of the same projection holds
 * the first world surface below the casters, so the shadow stops there
 * instead of passing through a floor (see renderTopDownBlockers()). There is
 * no per-frame light selection, scoring, or hysteresis to reason about: the
 * direction never changes, so there is nothing to pop.
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
   * Maximum reach of the top-down shadow below its caster, in world units, so
   * a caster high above an open floor does not darken it. What keeps a shadow
   * from passing through world geometry is the blocker map, not this cap (see
   * renderTopDownBlockers() and limitTopDownShadowReach in shadow-topdown.glsl).
   */
  static maxDepth: Cvar | null = null;

  /** Top-down shadow direction yaw (degrees). */
  static yaw: Cvar | null = null;

  /** Top-down shadow direction pitch (degrees, negative = downward; -90 = straight down). */
  static pitch: Cvar | null = null;

  /** Depth-only target of the top-down shadow pass; its depth attachment is {@link ShadowMap.topdownDepthTexture}. */
  static topdownTarget: RenderTarget | null = null;

  /** Depth texture with hardware comparison (sampler2DShadow). */
  static topdownDepthTexture: GLRenderTexture | null = null;

  /**
   * Depth-only target of the blocker pass; its depth attachment is {@link ShadowMap.topdownBlockerTexture}.
   */
  static topdownBlockerTarget: RenderTarget | null = null;

  /**
   * Depth texture with hardware comparison (sampler2DShadow), in the projection of the top-down shadow: per texel the
   * nearest world surface below a caster around it, cleared (1.0) where there is none. Only meaningful where the caster
   * map holds a caster; it keeps the last frame's content when no caster was drawn.
   */
  static topdownBlockerTexture: GLRenderTexture | null = null;

  /** 1×1 always-lit dummy texture used when the top-down shadow is off, for the caster and the blocker map alike. */
  static topdownDummyTexture: GLRenderTexture | null = null;

  /** Column-major 4×4 top-down light-space view-projection matrix, recomputed every frame from the camera position. */
  static topdownMatrix: Float64Array = new Float64Array(16);

  /** Top-down shadow map resolution in pixels (read by shaders for PCF texel size). */
  static size: number = TOPDOWN_SHADOW_SIZE;

  /** {@link BLOCKER_RECEIVER_BIAS}, for the receivers' uniform. */
  static readonly blockerReceiverBias: number = BLOCKER_RECEIVER_BIAS;

  /**
   * Footprints of this frame's top-down casters in the shadow map, four values each: x, y, width and height in texels.
   * Recorded by the caster pass, read by the blocker pass.
   */
  static readonly topdownFootprints: number[] = [];

  /** Scratch rectangle of {@link ShadowMap.computeTopDownFootprint}: x0, y0, x1, y1 in texels. */
  static readonly #footprint: Int32Array = new Int32Array(4);

  /**
   * Unit vector the top-down shadow travels along (from sky toward ground),
   * recomputed every frame in updateTopDownMatrix(). Read by the scene
   * shaders to mask the shadow off surfaces that face away from it — a
   * surface that never receives direct light from straight overhead (a wall,
   * the underside of a beam) shouldn't show a contact-shadow blotch either.
   */
  static lightDir: Vector = new Vector();

  // ─── Point light (cube) shadow ────────────────────────────────────

  /** Depth-only target for point light shadow (reused for all slots and faces; the cube face is attached per pass). */
  static pointTarget: RenderTarget | null = null;

  /** Depth cubemaps with hardware comparison (samplerCubeShadow), one per active point-light slot. */
  static pointDepthCubes: GLCubeTexture[] = [];

  /** 1×1 always-lit dummy cubemap used for inactive point-light slots. */
  static pointDummyCube: GLCubeTexture | null = null;

  /** Reused by {@link ShadowMap.getActivePointTextures}. */
  static readonly #activePointTextures: Array<GLCubeTexture | null> = new Array<GLCubeTexture | null>(POINT_SHADOW_COUNT).fill(null);

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
   * Index into clientRuntimeState.clientEntities.dlights for each active point-light
   * slot (-1 when the slot is unused). Read by DynamicLights.AddDynamicLights() to
   * exclude these lights from the baked surface dlight texture, since their
   * contribution is instead computed analytically per-fragment and shadowed
   * independently by their own cube depth map.
   */
  static pointLightDlightIndices: Int32Array = Int32Array.from([-1, -1, -1]);

  /** Enable point light shadow mapping (0 = off, 1 = on). */
  static pointEnabled: Cvar | null = null;

  /** Offset of the receiver's lookup along its surface normal, in shadow map texels (scaled by the sine of the light's angle). */
  static pointNormalBias: Cvar | null = null;

  /** Receiver-side depth bias for point light shadows, in shadow map texels. */
  static pointBias: Cvar | null = null;

  /** Per-leaf flags marking world leaves that only hold submodel faces (lazy cache). */
  static _submodelLeafFlags: Uint8Array | null = null;

  /** Worldmodel the submodel leaf flags were computed for. */
  static _submodelLeafFlagsModel: BrushModel | null = null;

  /** The draw chains a point light reaches, gathered by {@link ShadowMap.collectPointLightRanges}, reused. */
  static readonly #pointLightChains: number[][] = [];

  /** The vertex ranges of the world a point light's cube draws, `first, count` pairs, reused. */
  static readonly #pointLightRanges: number[] = [];

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

    // ── Top-down caster and blocker depth textures and their depth-only FBOs ──
    ShadowMap.topdownDepthTexture = ShadowMap.#createTopDownDepthTexture();
    ShadowMap.topdownTarget = new RenderTarget({
      name: 'shadow-topdown',
      color: [],
      depth: { storage: 'external', texture: ShadowMap.topdownDepthTexture },
    });

    ShadowMap.topdownBlockerTexture = ShadowMap.#createTopDownDepthTexture();
    ShadowMap.topdownBlockerTarget = new RenderTarget({
      name: 'shadow-topdown-blockers',
      color: [],
      depth: { storage: 'external', texture: ShadowMap.topdownBlockerTexture },
    });

    // ── 1×1 dummy (always-lit) ─────────────────────────────────────
    ShadowMap.topdownDummyTexture = new GLRenderTexture();
    ShadowMap.topdownDummyTexture.bind(0);
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
    ShadowMap.pointNormalBias = new Cvar('r_shadow_point_normal_bias', '2', Cvar.FLAG.NONE, 'Normal offset of point light shadow lookups, in shadow map texels');
    ShadowMap.pointBias = new Cvar('r_shadow_point_bias', '1', Cvar.FLAG.NONE, 'Depth bias of point light shadow lookups, in shadow map texels');

    ShadowMap.pointDepthCubes.length = 0;
    for (let slot = 0; slot < POINT_SHADOW_COUNT; slot++) {
      const depthCube = new GLCubeTexture();
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, depthCube.texture);
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
    ShadowMap.pointTarget = new RenderTarget({ name: 'shadow-point', color: [], depth: null });
    ShadowMap.pointTarget.bind();
    ShadowMap.pointTarget.attachDepthCubeFace(ShadowMap.pointDepthCubes[0].texture, 0);
    RenderTarget.unbind();

    // ── 1×1 dummy cubemap (always-lit) ─────────────────────────────
    ShadowMap.pointDummyCube = new GLCubeTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, ShadowMap.pointDummyCube.texture);
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

  /**
   * A depth texture the size of the top-down shadow map, filtered and compared in hardware (sampler2DShadow).
   * @returns The texture.
   */
  static #createTopDownDepthTexture(): GLRenderTexture {
    const texture = new GLRenderTexture();
    texture.bind(0);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, TOPDOWN_SHADOW_SIZE, TOPDOWN_SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    return texture;
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
    ShadowMap.topdownTarget!.bind();
    Frame.beginPass('shadow-topdown', ShadowMap.topdownTarget);
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
    Frame.endPass();
    RenderTarget.unbind();
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
   * never contributes its own occlusion into the same depth map. What it
   * does block is drawn afterwards by renderTopDownBlockers().
   * @returns How many entities were drawn as casters.
   */
  static renderTopDownShadow(viewOrigin: Vector): number {
    if (!clientRuntimeState.worldmodel) {
      return 0;
    }

    ShadowMap.updateTopDownMatrix(viewOrigin);
    ShadowMap.topdownFootprints.length = 0;
    ShadowMap.beginTopDown();

    const range = ShadowMap.range!.value;
    const casterCount = ShadowMap.renderEntitiesShadow(ShadowMap.topdownMatrix, false, viewOrigin, range * range);

    ShadowMap.endTopDown();
    return casterCount;
  }

  /**
   * Render the blocker map of the top-down shadow: per texel, the nearest
   * world surface below the casters around it. Run after
   * renderTopDownShadow(), with the same matrix, and only when it drew a
   * caster.
   *
   * The caster map alone has one layer: it knows how far above a receiver
   * the nearest caster is, not whether a floor lies in between, so a
   * caster on a ledge would shadow the floor below the ledge as well. The
   * opaque world surfaces of the revealed leafs are drawn here, and the
   * shader discards every fragment that is not below a caster within the
   * receivers' PCF footprint (shadow-blocker.frag), so the depth test keeps
   * the first surface under the casters. A receiver farther below than that
   * surface is out of the shadow (limitTopDownShadowReach in
   * shadow-topdown.glsl). Roofs above the casters are discarded, so they
   * do not shadow the floor as they would as casters.
   *
   * Brush entities are not drawn here: they cast into the caster map
   * themselves, so the floor below one is in its shadow anyway.
   *
   * Only the footprints of the casters need the surfaces, and testing them
   * against the casters is what costs: the depth is cleared to 0 (nothing
   * passes) and back to 1 only inside each footprint, so the depth test
   * rejects the world everywhere else before it is shaded, and the draw is
   * scissored to the footprints. Outside them the map reads "blocked",
   * which nothing notices, there is no caster there.
   */
  static renderTopDownBlockers(): void {
    const worldmodel = clientRuntimeState.worldmodel as BrushModel | null;
    const footprints = ShadowMap.topdownFootprints;
    if (!worldmodel || footprints.length === 0) {
      return;
    }

    ShadowMap.topdownBlockerTarget!.bind();
    Frame.beginPass('shadow-topdown-blockers', ShadowMap.topdownBlockerTarget);
    gl.viewport(0, 0, TOPDOWN_SHADOW_SIZE, TOPDOWN_SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.CULL_FACE);

    gl.clearDepth(0.0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.clearDepth(1.0);
    gl.enable(gl.SCISSOR_TEST);
    let minX = TOPDOWN_SHADOW_SIZE;
    let minY = TOPDOWN_SHADOW_SIZE;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < footprints.length; i += 4) {
      const x = footprints[i];
      const y = footprints[i + 1];
      const width = footprints[i + 2];
      const height = footprints[i + 3];
      gl.scissor(x, y, width, height);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }
    gl.scissor(minX, minY, maxX - minX, maxY - minY);

    GL.BindVAO(worldmodel.opaqueVAO as WebGLVertexArrayObject);
    const program = GL.UseProgram('shadow-blocker')!;
    gl.uniform3f(program.uOrigin!, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ShadowMap.topdownMatrix);
    // the caster map's [0,1] depth spans 2 * range world units, see updateTopDownMatrix()
    gl.uniform1f(program.uCasterEpsilon!, BLOCKER_CASTER_EPSILON / (2.0 * ShadowMap.range!.value));
    ShadowMap.topdownDepthTexture!.bind(program.tShadowMap!);

    const renderState = WorldRenderState.of(worldmodel);
    const visibleLeafs = renderState.visibleLeafs;
    for (let i = 0; i < visibleLeafs.length; i++) {
      const leaf = visibleLeafs[i];
      for (let j = 0; j < renderState.skychains[leaf]; j++) {
        const cmds = renderState.cmds[leaf][j];
        const flags = (worldmodel.textures[cmds[0]] as { flags: number }).flags;
        if (flags & (MaterialFlags.MF_SKIP | MaterialFlags.MF_TRANSPARENT)) {
          continue;
        }
        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
      }
    }

    GL.UnbindVAO();
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.colorMask(true, true, true, true);
    Frame.endPass();
    RenderTarget.unbind();
  }

  /**
   * The square in the top-down shadow map that holds an entity's shadow in every pose and rotation, grown by the
   * receivers' filter reach and clipped to the map. In the orthographic projection the shadow of a sphere is a disc of
   * the same radius, so the square is that of the sphere around the model: centered on the bounds of a brush entity
   * that is not rotated (a door's bounds are in world space, far from its origin at 0 0 0), on the origin otherwise.
   * @param entity The caster, with a model.
   * @returns The square, x0, y0, x1, y1 in texels, in a scratch array that the next call overwrites; `null` when it is
   * outside the map.
   */
  static computeTopDownFootprint(entity: ClientEdict): Int32Array | null {
    const model = entity.model!;
    const origin = entity.lerp.origin;
    const angles = entity.lerp.angles;
    const mins = model.mins;
    const maxs = model.maxs;

    let centerX = origin[0];
    let centerY = origin[1];
    let centerZ = origin[2];
    let radius: number;
    if (model instanceof BrushModel && angles[0] === 0 && angles[1] === 0 && angles[2] === 0) {
      centerX += (mins[0] + maxs[0]) * 0.5;
      centerY += (mins[1] + maxs[1]) * 0.5;
      centerZ += (mins[2] + maxs[2]) * 0.5;
      radius = Math.hypot(maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]) * 0.5;
    } else {
      radius = Math.hypot(
        Math.max(-mins[0], maxs[0]),
        Math.max(-mins[1], maxs[1]),
        Math.max(-mins[2], maxs[2]),
      );
    }

    const m = ShadowMap.topdownMatrix;
    const ndcX = m[0] * centerX + m[4] * centerY + m[8] * centerZ + m[12];
    const ndcY = m[1] * centerX + m[5] * centerY + m[9] * centerZ + m[13];
    const texelX = (ndcX * 0.5 + 0.5) * TOPDOWN_SHADOW_SIZE;
    const texelY = (ndcY * 0.5 + 0.5) * TOPDOWN_SHADOW_SIZE;
    // the map spans 2 * range world units
    const halfSize = radius * TOPDOWN_SHADOW_SIZE / (2.0 * ShadowMap.range!.value) + FOOTPRINT_MARGIN_TEXELS;

    const footprint = ShadowMap.#footprint;
    footprint[0] = Math.max(Math.floor(texelX - halfSize), 0);
    footprint[1] = Math.max(Math.floor(texelY - halfSize), 0);
    footprint[2] = Math.min(Math.ceil(texelX + halfSize), TOPDOWN_SHADOW_SIZE);
    footprint[3] = Math.min(Math.ceil(texelY + halfSize), TOPDOWN_SHADOW_SIZE);
    if (footprint[2] <= footprint[0] || footprint[3] <= footprint[1]) {
      return null;
    }
    return footprint;
  }

  /**
   * Records a top-down caster's footprint for the blocker pass.
   */
  static #recordTopDownFootprint(entity: ClientEdict): void {
    const footprint = ShadowMap.computeTopDownFootprint(entity);
    if (footprint === null) {
      return;
    }
    ShadowMap.topdownFootprints.push(footprint[0], footprint[1], footprint[2] - footprint[0], footprint[3] - footprint[1]);
  }

  /**
   * The texture to bind as the blocker map of the top-down shadow this frame: the real one while shadows are on, the
   * dummy (nothing blocks) otherwise.
   * @returns The texture, `null` before {@link ShadowMap.init}.
   */
  static getActiveTopDownBlockerTexture(): GLRenderTexture | null {
    return ShadowMap.enabled !== null && ShadowMap.enabled.value ? ShadowMap.topdownBlockerTexture : ShadowMap.topdownDummyTexture;
  }

  /**
   * The texture to bind as the top-down shadow map this frame: the real one while shadows are on, the dummy otherwise.
   * @returns The texture, `null` before {@link ShadowMap.init}.
   */
  static getActiveTopDownTexture(): GLRenderTexture | null {
    return ShadowMap.enabled !== null && ShadowMap.enabled.value ? ShadowMap.topdownDepthTexture : ShadowMap.topdownDummyTexture;
  }

  // ─── Entity shadow rendering ──────────────────────────────────────

  /**
   * Render visible entities (brush submodels, alias models, mesh models)
   * into the active shadow map.
   * @returns How many entities were drawn as casters.
   */
  static renderEntitiesShadow(
    lightSpaceMatrix: Float64Array,
    isPointLight: boolean,
    cutoffOrigin: Vector,
    cutoffDistSq: number,
  ): number {
    if (rendererCvars.drawentities.value === 0) {
      return 0;
    }
    let casterCount = 0;
    for (const entity of clientRuntimeState.clientEntities.getVisibleEntities()) {
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
        lightDirection: ShadowMap.lightDir,
      });
      casterCount++;
      if (!isPointLight) {
        ShadowMap.#recordTopDownFootprint(entity);
      }
    }
    return casterCount;
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

    if (entity.num === 0 || entity.isClientOwned()) {
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

    const dlights = clientRuntimeState.clientEntities.dlights;
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

    const leafs = worldmodel.leafTable;
    const flags = new Uint8Array(leafs.count);
    for (let i = 0; i < leafs.count; i++) {
      for (let k = 0; k < leafs.numMarkSurfaces[i]; k++) {
        const face = worldmodel.faces[worldmodel.marksurfaces[leafs.firstMarkSurfaces[i] + k]];
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

  /**
   * The vertex ranges of the opaque world surfaces a point light can shadow with: the draw chains of the leafs its
   * sphere reaches, found by walking the BSP tree down from the root by the node planes, like
   * DynamicLights.MarkLights. Nothing beyond the radius is needed: a receiver is only tested against the cube within
   * the radius, and whatever occludes it lies between it and the light. The leafs of inline submodels are left out (the
   * entity pass draws those where the entity is), and so are the materials no shadow pass draws. The chains of a
   * texture follow each other in the vertex buffer leaf by leaf, so the ones that touch are merged: a cube face takes
   * a few draws instead of one per chain and leaf.
   * @param submodelLeafFlags One flag per leaf, see {@link ShadowMap._getSubmodelLeafFlags}.
   * @param origin Position of the light.
   * @param radius Radius of the light, the far plane of its cube.
   * @returns `first, count` pairs in vertex buffer order. The array is reused by every call: do not keep it.
   */
  static collectPointLightRanges(worldmodel: BrushModel, submodelLeafFlags: Uint8Array, origin: Vector, radius: number): readonly number[] {
    const chains = ShadowMap.#pointLightChains;
    const ranges = ShadowMap.#pointLightRanges;

    chains.length = 0;
    ranges.length = 0;

    ShadowMap.#collectPointLightChains(worldmodel, WorldRenderState.of(worldmodel), submodelLeafFlags, origin, radius, 0);
    chains.sort(compareChainsByFirstVertex);

    for (const chain of chains) {
      const last = ranges.length - 2;

      if (last >= 0 && ranges[last] + ranges[last + 1] === chain[1]) {
        ranges[last + 1] += chain[2];
        continue;
      }

      ranges.push(chain[1], chain[2]);
    }

    // do not keep the chains of a map alive after it is gone
    chains.length = 0;

    return ranges;
  }

  /**
   * Walks the subtree at reference and gathers the shadow-casting draw chains of the leafs the light's sphere reaches.
   * @param reference A node index, or `~leaf` for a leaf.
   */
  static #collectPointLightChains(
    worldmodel: BrushModel,
    state: WorldRenderState,
    submodelLeafFlags: Uint8Array,
    origin: Vector,
    radius: number,
    reference: number,
  ): void {
    if (reference < 0) {
      ShadowMap.#collectLeafChains(worldmodel, state, submodelLeafFlags, ~reference);
      return;
    }

    const nodes = worldmodel.nodeTable;
    const plane = worldmodel.planes[nodes.planeNums[reference]];
    const dist = origin.dot(plane.normal) - plane.dist;

    if (dist >= -radius) {
      ShadowMap.#collectPointLightChains(worldmodel, state, submodelLeafFlags, origin, radius, nodes.children[reference * 2]);
    }

    if (dist <= radius) {
      ShadowMap.#collectPointLightChains(worldmodel, state, submodelLeafFlags, origin, radius, nodes.children[reference * 2 + 1]);
    }
  }

  /**
   * Gathers the opaque draw chains of one leaf that cast point light shadows.
   */
  static #collectLeafChains(worldmodel: BrushModel, state: WorldRenderState, submodelLeafFlags: Uint8Array, leaf: number): void {
    if (submodelLeafFlags[leaf]) {
      return;
    }

    const leafChains = state.cmds[leaf];

    for (let j = 0; j < state.skychains[leaf]; j++) {
      const chain = leafChains[j];
      const flags = (worldmodel.textures[chain[0]] as { flags: number }).flags;

      if (flags & (MaterialFlags.MF_SKIP | MaterialFlags.MF_TRANSPARENT)) {
        continue;
      }

      ShadowMap.#pointLightChains.push(chain);
    }
  }

  /**
   * Render the point light shadow cube maps (all 6 faces) for every active slot.
   * Casters are drawn without any depth bias: the receivers bias their own
   * lookups per fragment, scaled by the texel size at their distance
   * (samplePointShadowMap in shadow-point.glsl).
   */
  static renderPointLightShadow(): void {
    const worldmodel = clientRuntimeState.worldmodel as BrushModel | null;
    if (!worldmodel) {
      return;
    }

    const submodelLeafFlags = ShadowMap._getSubmodelLeafFlags(worldmodel);

    ShadowMap.pointTarget!.bind();
    Frame.beginPass('shadow-point', ShadowMap.pointTarget);
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
    Frame.endPass();
    RenderTarget.unbind();
  }

  /**
   * Render one point-light slot's 6 cube faces (the opaque world geometry
   * within the light's radius, see collectPointLightRanges, plus entities)
   * into ShadowMap.pointDepthCubes[slot].
   */
  static _renderPointLightShadowSlot(
    worldmodel: BrushModel,
    submodelLeafFlags: Uint8Array,
    slot: number,
  ): void {
    const pointLightOrigin = ShadowMap.pointLightOrigins[slot];
    const pointLightRadius = ShadowMap.pointLightRadii[slot];
    const pointCasterCutoffDistSq = pointLightRadius * pointLightRadius;

    const ranges = ShadowMap.collectPointLightRanges(worldmodel, submodelLeafFlags, pointLightOrigin, pointLightRadius);

    GL.BindVAO(worldmodel.opaqueVAO as WebGLVertexArrayObject);
    const program = GL.UseProgram('shadow-point')!;

    gl.uniform3f(program.uOrigin!, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);

    for (let face = 0; face < 6; face++) {
      ShadowMap.pointTarget!.attachDepthCubeFace(ShadowMap.pointDepthCubes[slot].texture, face);
      gl.clear(gl.DEPTH_BUFFER_BIT);

      ShadowMap.buildPointFaceMatrix(face, slot);
      gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ShadowMap.pointFaceMatrix);

      for (let i = 0; i < ranges.length; i += 2) {
        gl.drawArrays(gl.TRIANGLES, ranges[i], ranges[i + 1]);
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

  /**
   * The cube textures to bind as point shadow maps this frame, one per slot: the depth cube of a slot that has a
   * light, the dummy cube for the others. The array is reused by every call, so a draw does not allocate; do not
   * keep it across calls.
   * @returns The cubes, `null` before {@link ShadowMap.init}.
   */
  static getActivePointTextures(): ReadonlyArray<GLCubeTexture | null> {
    const textures = ShadowMap.#activePointTextures;
    for (let i = 0; i < POINT_SHADOW_COUNT; i++) {
      textures[i] = i < ShadowMap.pointLightActiveCount
        ? ShadowMap.pointDepthCubes[i]
        : ShadowMap.pointDummyCube;
    }
    return textures;
  }
}
