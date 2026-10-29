import Vector from '../../../../shared/Vector.ts';
import { ModelRenderer, type ShadowRenderContext } from './ModelRenderer.ts';
import { eventBus } from '../../../common/EventBus.ts';
import GL, { type GLProgramInfo, type GLRenderTexture, ATTRIB_LOCATIONS, BRUSH_VERTEX_STRIDE, GLVolumeTexture } from '../../GL.ts';
import { getEntityBloomEmissiveScale } from '../postprocess/BloomEffect.ts';
import { MaterialFlags, PBRMaterial, type BaseMaterial } from './Materials.ts';
import { BrushModel, type FogVolumeInfo, type WorldSurfaceBatch } from '../../../common/model/BSP.ts';
import { WorldRenderState } from '../../../common/model/WorldRenderState.ts';
import type { Face, BaseModel } from '../../../common/model/BaseModel.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import Mesh from './Mesh.ts';
import PostProcess from '../postprocess/PostProcess.ts';
import * as Def from '../../../common/Def.ts';
import { content } from '../../../../shared/Defs.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import Interpolation from '../scene/Interpolation.ts';
import LightStyles from '../lighting/LightStyles.ts';
import Lightmaps, { LIGHTMAP_BLOCK_SIZE } from '../lighting/Lightmaps.ts';
import ShadowMap from '../lighting/ShadowMap.ts';
import LightSampler from '../lighting/LightSampler.ts';
import EntityLighting from '../lighting/EntityLighting.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import Host from '../../../common/Host.ts';
import Camera from '../scene/Camera.ts';
import Visibility from '../scene/Visibility.ts';
import DefaultTextures from '../resources/DefaultTextures.ts';
import MaterialBinder from './MaterialBinder.ts';
import RenderStats from '../scene/RenderStats.ts';


let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

const TURBULENT_FALLBACK_NORMAL_OFFSET = 2.0;
// Deeper along-normal probe distance used to punch through a large/deep liquid volume down to
// the real (lightmapped) floor beneath it. The shallow TURBULENT_FALLBACK_NORMAL_OFFSET probe
// only clears thin water; for deep lava/water bodies (e.g. e4m1's lava lake) it can still land
// close enough to the surface plane to re-hit the turbulent face itself and fail.
const TURBULENT_FALLBACK_DEEP_NORMAL_OFFSET = 48.0;
const TURBULENT_FALLBACK_LATERAL_OFFSET = 12.0;
const TURBULENT_FALLBACK_NEIGHBOR_COUNT = 6;
const TURBULENT_FALLBACK_NEIGHBOR_GAIN = 1.4;
const TURBULENT_FALLBACK_MAX_BOOST = 1.3;
const TURBULENT_FALLBACK_SCALE = 0.0078125;
const TURBULENT_FALLBACK_EPSILON = 0.0001;
// Position quantization factor for the vertex-light averaging map (1/16 Quake unit precision).
const TURBULENT_FALLBACK_POS_QUANT = 16.0;
// Fraction of the model's own average sampled turbulent light used as a per-vertex minimum,
// so vertices whose probes found no nearby lit geometry (e.g. mid-lake) are lifted toward the
// map's general brightness instead of collapsing to black.
const TURBULENT_FALLBACK_FLOOR_FRACTION = 0.55;
// Last-resort floor used only when a model has no valid turbulent samples at all.
const TURBULENT_FALLBACK_DEFAULT_FLOOR = 0.4;

/**
 * @param strength Requested brush bloom contribution strength.
 * @returns Sanitized non-negative bloom contribution strength.
 */
export function resolveBrushBloomContributionStrength(strength: number): number {
  return Number.isFinite(strength) && strength > 0.0 ? strength : 0.0;
}

/** Internal data held per fog volume light probe. */
interface FogLightProbeData {
  texture: GLVolumeTexture;
  resX: number;
  resY: number;
  resZ: number;
  data: Uint8Array;
}

/** Dynamic light entry used for fog volume dlight uploads. */
interface FogDlightEntry {
  origin: Vector;
  radius: number;
  color: Vector;
  distSq: number;
}

/**
 * Resolver return type for entity lighting state.
 */
interface EntityLightingState {
  ambientlight: Vector;
  shadelight: Vector;
  lightPosition: Vector;
  dynamicShadeLight: Vector;
  dynamicLightPosition: Vector;
  hasDeluxemap: boolean;
}

/**
 * Renderer for BSP brush models (maps and inline models like doors, platforms).
 * Handles both static world geometry and dynamic brush entities.
 */
export class BrushModelRenderer extends ModelRenderer {
  // ─── Static properties ────────────────────────────────────────────

  /** Resolution of the 3D light probe grid per axis. */
  static FOG_LIGHT_PROBE_RES = 8;

  /**
   * Maximum number of dynamic lights passed to the fog volume shader.
   * Must match MAX_FOG_DLIGHTS in fog-volume.frag.
   */
  static MAX_FOG_DLIGHTS = 8;

  /** Reused by `getEntityViewDistance()`, once per transparent brush entity and frame. */
  /** Bounds of the leaf a loop looks at, see `#loadLeafBounds()`. */
  static readonly #leafMins = new Vector();
  static readonly #leafMaxs = new Vector();

  static readonly #scratchMins: [number, number, number] = [0, 0, 0];
  static readonly #scratchMaxs: [number, number, number] = [0, 0, 0];

  // ─── Private instance fields ──────────────────────────────────────

  /**
   * Light probe textures for fog volumes, keyed by the fog volume object.
   * Each entry holds a raw WebGL texture, the grid resolution, and a reusable
   * pixel buffer to avoid reallocating on every lightstyle update.
   */
  #fogLightProbes: Map<FogVolumeInfo, FogLightProbeData> = new Map();

  /**
   * The lightstyle animation frame index when probes were last rebuilt.
   * Lightstyles tick at 10 Hz (floor(time * 10)), so probes are only
   * regenerated when this value changes.
   */
  #fogProbeStyleFrame: number = -1;

  /** A 1×1 white texture used as a fallback when no light probe is available. */
  #fogLightProbeWhite: GLVolumeTexture | null = null;

  /**
   * Lazily created unit cube VBO for rendering world-level fog volumes.
   * The cube spans [0,1]^3 and is transformed via uOrigin/uAngles.
   */
  #fogCubeVBO: WebGLBuffer | null = null;

  /** Lazily created VAO for the fog cube VBO (position-only, 12-byte stride). */
  #fogCubeVAO: WebGLVertexArrayObject | null = null;

  // ─── Runtime program/model state ─────────────────────────────────

  /** Active 'brush' program during world transparent pass. */
  _worldTransparentProgram: GLProgramInfo | null = null;

  /** World model associated with the current transparent pass. */
  _worldTransparentModel: BrushModel | null = null;

  /** Whether the current transparent pass's model carries deluxemap data. */
  _worldTransparentHasDeluxemap = false;

  /** Active 'turbulent' program during world turbulent pass. */
  _worldTurbulentProgram: GLProgramInfo | null = null;

  /** World model associated with the current turbulent pass. */
  _worldTurbulentModel: BrushModel | null = null;

  /** Active 'fog-volume' program during fog volume pass. */
  _fogVolumeProgram: GLProgramInfo | null = null;

  /** The depth copy a fog volume pass samples, kept so that it can be bound again after a light probe was uploaded. */
  _fogVolumeDepth: GLRenderTexture | null = null;

  /** The batches `#collectVisibleBatches` has handed out in this call, reused by every call. */
  static readonly #seenBatches = new Set<WorldSurfaceBatch>();

  /**
   * How strongly translucent liquids refract in the transparent pass being drawn, 0 when they do not. Set by
   * {@link BrushModelRenderer.prepareRefraction} for the pass and back to 0 after it, so nothing outside the
   * pass samples a scene copy that was not made for it.
   */
  #liquidRefraction = 0.0;

  /**
   * The player's `r_refraction` for the transparent pass being drawn, 0 when nothing refracts. It scales the strength
   * of a material that sets its own, see {@link BrushModelRenderer.#refractionOf}. Set and cleared like `#liquidRefraction`.
   */
  #refractionScale = 0.0;

  /**
   * How much of its strength the item of the transparent pass that is checked or drawn next refracts with, by how far
   * it is, see {@link BrushModelRenderer.setRefractionDistance}. 1 outside the pass.
   */
  #refractionFade = 1.0;

  // ─── Static methods ───────────────────────────────────────────────

  /**
   * Whether a map has materials that refract what is behind them (`MF_REFRACT`), so the scene has to be captured.
   * @returns True when one of its textures has the flag.
   */
  static HasRefractingMaterials(model: BrushModel): boolean {
    for (let i = 0; i < model.textures.length; i++) {
      const material = model.textures[i] as BaseMaterial;

      if ((material.flags & MaterialFlags.MF_REFRACT) !== 0 || material.refraction !== null) {
        return true;
      }
    }

    return false;
  }

  /**
   * How strongly a map's translucent liquids refract.
   * @param value The worldspawn `_qs_waterrefraction` value: a strength, `"1"` being the default one.
   * @param scale The player's scale, `r_refraction`.
   * @returns The strength, 0 when the map does not ask for refraction, the value is not a number, or the player
   * turned it off.
   */
  static ResolveLiquidRefraction(value: string | undefined, scale: number): number {
    if (value === undefined) {
      return 0.0;
    }

    const strength = Number.parseFloat(value) * scale;

    return Number.isFinite(strength) && strength > 0.0 ? strength : 0.0;
  }

  /**
   * Determine whether a brush model should sample the shared deluxemap atlas.
   * Inline BSP submodels reuse the world atlas even when they do not carry
   * their own `deluxemap` pointer.
   * @returns True when the model references the shared world deluxemap atlas.
   */
  static usesDeluxemap(clmodel: BrushModel, worldModel: BrushModel | null): boolean {
    return (clmodel.deluxemap !== null || (clmodel.submodel && worldModel !== null && worldModel.deluxemap !== null));
  }

  /**
   * Build the lighting state used by inline brush entities.
   * Brush models should use the same BSP + dynamic-light sampling as alias/mesh entities.
   * @returns The resolved entity lighting state.
   */
  static resolveEntityLightingState(
    clmodel: BrushModel,
    entity: ClientEdict,
    calculateLightValues: (entity: ClientEdict) => [Vector, Vector, Vector, Vector, Vector],
    worldModel: BrushModel | null = null,
  ): EntityLightingState {
    const [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition] = calculateLightValues(entity);
    const usesSharedWorldLightmap = clmodel.submodel && (clmodel.lightdata !== null || clmodel.lightdata_rgb !== null);

    return {
      ambientlight: usesSharedWorldLightmap ? new Vector(1.0, 1.0, 1.0) : ambientlight,
      shadelight: usesSharedWorldLightmap ? new Vector(0.0, 0.0, 0.0) : shadelight,
      lightPosition,
      dynamicShadeLight,
      dynamicLightPosition,
      hasDeluxemap: BrushModelRenderer.usesDeluxemap(clmodel, worldModel),
    };
  }

  /**
   * Projects and normalises a tangent axis against the surface normal.
   * @private
   * @returns The projected axis, or null when the result is degenerate.
   */
  static _projectTurbulentFallbackAxis(axis: Vector, normal: Vector): Vector | null {
    const projectedAxis = axis.copy().subtract(normal.copy().multiply(axis.dot(normal)));

    if (projectedAxis.normalize() <= TURBULENT_FALLBACK_EPSILON) {
      return null;
    }

    return projectedAxis;
  }

  /**
   * Computes an orthonormal tangent/bitangent basis for turbulent UV fallback.
   * @private
   * @returns Tangent and bitangent vectors aligned to the surface.
   */
  static _getTurbulentFallbackBasis(model: BrushModel, face: Face): { tangent: Vector; bitangent: Vector } {
    const normal = face.normal.copy();

    if (normal.normalize() <= TURBULENT_FALLBACK_EPSILON) {
      return {
        tangent: new Vector(1.0, 0.0, 0.0),
        bitangent: new Vector(0.0, 1.0, 0.0),
      };
    }

    const texinfo = model.texinfo?.[face.texinfo] ?? null;
    let tangent = texinfo
      ? BrushModelRenderer._projectTurbulentFallbackAxis(new Vector(texinfo.vecs[0][0], texinfo.vecs[0][1], texinfo.vecs[0][2]), normal)
      : null;
    let bitangent = texinfo
      ? BrushModelRenderer._projectTurbulentFallbackAxis(new Vector(texinfo.vecs[1][0], texinfo.vecs[1][1], texinfo.vecs[1][2]), normal)
      : null;

    if (tangent === null && face.verts && face.verts.length >= 2) {
      const edge = new Vector(
        face.verts[1][0] - face.verts[0][0],
        face.verts[1][1] - face.verts[0][1],
        face.verts[1][2] - face.verts[0][2],
      );
      tangent = BrushModelRenderer._projectTurbulentFallbackAxis(edge, normal);
    }

    if (tangent === null) {
      tangent = normal.perpendicular();
    }

    if (bitangent === null || Math.abs(bitangent.dot(tangent)) >= 0.99) {
      bitangent = normal.cross(tangent);
      if (bitangent.normalize() <= TURBULENT_FALLBACK_EPSILON) {
        bitangent = normal.perpendicular();
      }
    }

    return { tangent, bitangent };
  }

  /**
   * Sample fallback light at a vertex position by probing the world in a neighborhood.
   * @param sampleLightPoint Light sampler callback from LightSampler.LightPoint.
   * @returns RGB light values in the 0..1 renderer range.
   */
  static sampleTurbulentFallbackLight(
    model: BrushModel,
    face: Face,
    worldPos: Vector,
    sampleLightPoint: (position: Vector) => [Vector, Vector],
  ): number[] {
    const normal = face.normal.copy();

    if (normal.normalize() <= TURBULENT_FALLBACK_EPSILON) {
      return [0.0, 0.0, 0.0];
    }

    const { tangent, bitangent } = BrushModelRenderer._getTurbulentFallbackBasis(model, face);
    const normalOffset = normal.copy().multiply(TURBULENT_FALLBACK_NORMAL_OFFSET);
    const tangentOffset = tangent.copy().multiply(TURBULENT_FALLBACK_LATERAL_OFFSET);
    const bitangentOffset = bitangent.copy().multiply(TURBULENT_FALLBACK_LATERAL_OFFSET);
    const diagonalOffset = tangent.copy().add(bitangent);
    diagonalOffset.normalize();
    diagonalOffset.multiply(TURBULENT_FALLBACK_LATERAL_OFFSET);
    const antiDiagonalOffset = tangent.copy().subtract(bitangent);
    antiDiagonalOffset.normalize();
    antiDiagonalOffset.multiply(TURBULENT_FALLBACK_LATERAL_OFFSET);
    const deepNormalOffset = normal.copy().multiply(TURBULENT_FALLBACK_DEEP_NORMAL_OFFSET);
    const samplePositions = [
      worldPos,
      worldPos.copy().add(normalOffset),
      worldPos.copy().subtract(normalOffset),
      worldPos.copy().add(tangentOffset),
      worldPos.copy().subtract(tangentOffset),
      worldPos.copy().add(bitangentOffset),
      worldPos.copy().subtract(bitangentOffset),
      worldPos.copy().add(diagonalOffset),
      worldPos.copy().subtract(diagonalOffset),
      worldPos.copy().add(antiDiagonalOffset),
      worldPos.copy().subtract(antiDiagonalOffset),
      new Vector(worldPos[0], worldPos[1], worldPos[2] - TURBULENT_FALLBACK_NORMAL_OFFSET),
      // Deep probes: punch further into the liquid volume to reach the real floor beneath
      // deep water/lava, where the shallow normal offset above can still self-hit the surface.
      worldPos.copy().subtract(deepNormalOffset),
      new Vector(worldPos[0], worldPos[1], worldPos[2] - TURBULENT_FALLBACK_DEEP_NORMAL_OFFSET),
    ];
    const visibleSamples: { color: Vector; intensity: number }[] = [];
    let bestColor = new Vector(0.0, 0.0, 0.0);
    let bestIntensity = 0.0;

    for (let i = 0; i < samplePositions.length; i++) {
      const [color] = sampleLightPoint(samplePositions[i]);
      const intensity = Math.max(color[0], color[1], color[2]);

      if (intensity <= 0.0) {
        continue;
      }

      visibleSamples.push({ color, intensity });

      if (intensity <= bestIntensity) {
        continue;
      }

      bestColor = color;
      bestIntensity = intensity;
    }

    if (visibleSamples.length === 0) {
      return [0.0, 0.0, 0.0];
    }

    visibleSamples.sort((sampleA, sampleB) => sampleB.intensity - sampleA.intensity);

    const neighborhoodColor = new Vector(0.0, 0.0, 0.0);
    const neighborhoodCount = Math.min(visibleSamples.length, TURBULENT_FALLBACK_NEIGHBOR_COUNT);

    for (let i = 0; i < neighborhoodCount; i++) {
      neighborhoodColor.add(visibleSamples[i].color);
    }

    neighborhoodColor.multiply(1.0 / neighborhoodCount);
    neighborhoodColor.multiply(TURBULENT_FALLBACK_NEIGHBOR_GAIN);

    const neighborhoodIntensity = Math.max(neighborhoodColor[0], neighborhoodColor[1], neighborhoodColor[2]);

    if (neighborhoodIntensity > bestIntensity && bestIntensity > 0.0) {
      const maxBoostedIntensity = bestIntensity * TURBULENT_FALLBACK_MAX_BOOST;
      if (neighborhoodIntensity > maxBoostedIntensity) {
        neighborhoodColor.multiply(maxBoostedIntensity / neighborhoodIntensity);
      }
    }

    const finalColor = new Vector(
      Math.max(bestColor[0], neighborhoodColor[0]),
      Math.max(bestColor[1], neighborhoodColor[1]),
      Math.max(bestColor[2], neighborhoodColor[2]),
    );

    return [
      Math.max(0.0, finalColor[0] * TURBULENT_FALLBACK_SCALE),
      Math.max(0.0, finalColor[1] * TURBULENT_FALLBACK_SCALE),
      Math.max(0.0, finalColor[2] * TURBULENT_FALLBACK_SCALE),
    ];
  }


  // ─── ModelRenderer interface ──────────────────────────────────────

  /** @returns BrushModel constructor. */
  override getModelClass(): typeof BrushModel {
    return BrushModel;
  }


  setupRenderState(_pass = 0): void {
    // Brush models bind their own buffers and state per-entity
  }

  rendersOpaquePass(_model: BaseModel, entity: ClientEdict): boolean {
    return entity.alpha >= 1.0;
  }

  rendersTransparentPass(model: BaseModel, entity: ClientEdict): boolean {
    if (entity.alpha <= 0.0) {
      return false;
    }

    if (entity.alpha < 1.0) {
      return true;
    }

    const clmodel = model as BrushModel;

    if (!clmodel.chains || clmodel.chains.length === 0) {
      return false;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]];

      // liquids of brush entities are drawn in the transparent pass, also opaque ones, see render()
      if ((material.flags & (MaterialFlags.MF_TRANSPARENT | MaterialFlags.MF_TURBULENT)) !== 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Render a single brush model entity.
   * Handles frustum culling, transforms, lighting, and both opaque and turbulent surfaces.
   * @param pass Rendering pass: 0 opaque, 1 only the liquids of a brush entity, 2 transparent (for a brush entity also
   * its liquids). The liquids of the world come from `getWorldTurbulentChains()` instead.
   */
  render(model: BaseModel, entity: ClientEdict, pass = 0): void {
    const clmodel = model as BrushModel;
    const e = entity;

    // Check if this is the world entity (entity 0)
    if (e === clientRuntimeState.clientEntities.getEntity(0)) {
      // the translucent surfaces and liquids of the world are drawn by the sorted transparent pass, see
      // getWorldTransparentBatches() and getWorldTurbulentChains()
      if (pass === 0) {
        this.renderWorld(clmodel);
      }
      return;
    }

    // Regular brush entity — frustum cull
    if (clmodel.submodel) {
      if (Camera.CullBox(
        new Vector(
          e.origin[0] + clmodel.mins[0],
          e.origin[1] + clmodel.mins[1],
          e.origin[2] + clmodel.mins[2],
        ),
        new Vector(
          e.origin[0] + clmodel.maxs[0],
          e.origin[1] + clmodel.maxs[1],
          e.origin[2] + clmodel.maxs[2],
        ))) {
        return;
      }
    } else {
      if (Camera.CullBox(
        new Vector(
          e.origin[0] - clmodel.radius,
          e.origin[1] - clmodel.radius,
          e.origin[2] - clmodel.radius,
        ),
        new Vector(
          e.origin[0] + clmodel.radius,
          e.origin[1] + clmodel.radius,
          e.origin[2] + clmodel.radius,
        ))) {
        return;
      }
    }

    const viewMatrix = e.lerp.angles.toRotationMatrix();

    if (pass === 0) {
      GL.BindVAO(clmodel.opaqueVAO!);
      RenderStats.c_brush_vbos++;
      this._renderOpaqueSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    } else if (pass === 1 && rendererCvars.drawturbulents.value) {
      GL.BindVAO(clmodel.turbulentVAO!);
      RenderStats.c_brush_vbos++;
      this._renderTurbulentSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    } else if (pass === 2) {
      GL.BindVAO(clmodel.opaqueVAO!);
      RenderStats.c_brush_vbos++;
      this._renderTransparentSurfaces(clmodel, e, viewMatrix, false);
      // glass behind the other translucent surfaces of the entity does not see them, the scene was copied before it
      if (this.#hasRefractingGlass(clmodel, e)) {
        this._renderTransparentSurfaces(clmodel, e, viewMatrix, true);
      }
      GL.UnbindVAO();

      // Liquids of a brush entity have their own vertex array and program. Nothing draws an entity in pass 1, so
      // they are drawn here, in the sorted transparent pass, opaque ones (which write depth) included.
      if (rendererCvars.drawturbulents.value !== 0 && BrushModelRenderer.#hasTurbulentChains(clmodel)) {
        GL.BindVAO(clmodel.turbulentVAO!);
        RenderStats.c_brush_vbos++;
        this._renderTurbulentSurfaces(clmodel, e, viewMatrix);
        GL.UnbindVAO();
        // back to the state of the transparent pass, which a liquid that writes depth left
        gl.enable(gl.BLEND);
        gl.depthMask(false);
      }
    }
  }

  // ─── Refraction ───────────────────────────────────────────────────

  /**
   * Sets how strongly translucent liquids and `MF_REFRACT` surfaces refract in the transparent pass that is about to
   * be drawn, or turns it off after the pass. Refraction needs the scene capture: the surfaces sample the copies of
   * the scene made during it. Liquids refract when the map asks for it, `MF_REFRACT` surfaces whenever `r_refraction`
   * is on.
   * @param worldmodel The world of the pass, `null` after the pass.
   */
  prepareRefraction(worldmodel: BrushModel | null): void {
    const active = worldmodel !== null && PostProcess.active;

    this.#liquidRefraction = active
      ? BrushModelRenderer.ResolveLiquidRefraction(worldmodel.worldspawnInfo._qs_waterrefraction, rendererCvars.refraction.value)
      : 0.0;
    this.#refractionScale = active ? Math.max(0.0, rendererCvars.refraction.value) : 0.0;
    this.#refractionFade = 1.0;
  }

  /**
   * Tells the renderer how far the item of the transparent pass that is checked (`refractsWorldBatch`, ...) or drawn
   * next is, so a far one refracts less, and beyond `r_refraction_distance` not at all: there the shift is a pixel
   * or two, not worth a copy of the scene. The transparent pass sets it before each, from the distance it sorts by,
   * so the decision whether to copy the scene and the strength the draw uses agree.
   * @param distance Distance of the item from the view, as sorted.
   */
  setRefractionDistance(distance: number): void {
    this.#refractionFade = BrushModelRenderer.RefractionFade(distance, rendererCvars.refractionDistance.value);
  }

  /**
   * The share of its strength a surface refracts with at a distance: all of it up to three quarters of the limit,
   * then less, down to none at the limit, so a surface does not snap from refracting to blended while moving.
   * @param distance Distance of the surface from the view.
   * @param limit `r_refraction_distance`, 0 or less for no limit.
   * @returns 0..1.
   */
  static RefractionFade(distance: number, limit: number): number {
    if (limit <= 0.0) {
      return 1.0;
    }

    return Math.min(1.0, Math.max(0.0, (limit - distance) / (limit * 0.25)));
  }

  /**
   * How strongly a material refracts in the pass being drawn: its own `refraction`, otherwise 1 for `MF_REFRACT`,
   * otherwise the map's strength for a liquid, times the player's `r_refraction`.
   * @returns The strength, 0 when the material does not refract.
   */
  #refractionOf(material: BaseMaterial): number {
    if (material.refraction !== null) {
      return material.refraction * this.#refractionScale * this.#refractionFade;
    }

    if ((material.flags & MaterialFlags.MF_REFRACT) !== 0) {
      return this.#refractionScale * this.#refractionFade;
    }

    return (material.flags & MaterialFlags.MF_TURBULENT) !== 0 ? this.#liquidRefraction * this.#refractionFade : 0.0;
  }

  /**
   * Whether a translucent world batch refracts in this pass, so it is drawn by `brush-refract` and the scene has to
   * be copied before it.
   * @returns True for a refracting material while refraction is on.
   */
  refractsWorldBatch(clmodel: BrushModel, batch: WorldSurfaceBatch): boolean {
    return this.#refractionOf(clmodel.textures[batch.texture] as BaseMaterial) > 0.0;
  }

  /**
   * Whether a turbulent chain of the world refracts in this pass, so the scene has to be copied before it is drawn.
   * @returns True when it is drawn translucent and refracts, by the map or by its material.
   */
  refractsWorldTurbulentChain(clmodel: BrushModel, chain: WorldSurfaceBatch): boolean {
    const worldspawn = clientRuntimeState.clientEntities.getEntity(0);
    const material = clmodel.textures[chain.texture] as BaseMaterial;

    return this.#refractionOf(material) > 0.0 && this.#turbulentAlpha(material, worldspawn) < 1.0;
  }

  /**
   * Whether a brush entity has a liquid that refracts in this pass, so the scene has to be copied before it is drawn.
   * @returns True when one of its liquids is drawn translucent and refracts, by the map or by its material.
   */
  refractsEntity(model: BaseModel, entity: ClientEdict): boolean {
    if (!(model instanceof BrushModel)) {
      return false;
    }

    if (this.#hasRefractingGlass(model, entity)) {
      return true;
    }

    if (this.#refractionScale === 0.0 || rendererCvars.drawturbulents.value === 0) {
      return false;
    }

    for (let i = 0; i < model.chains.length; i++) {
      const material = model.textures[model.chains[i][0]] as BaseMaterial;

      if ((material.flags & MaterialFlags.MF_SKIP) === 0 && (material.flags & MaterialFlags.MF_TURBULENT) !== 0
        && this.#refractionOf(material) > 0.0 && this.#turbulentAlpha(material, entity) < 1.0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether a chain of a brush entity is glass that refracts in this pass: a refracting material that is drawn
   * translucent, because the material or the entity is.
   * @returns True when it is drawn by `brush-refract`.
   */
  #refractsGlassChain(material: BaseMaterial, entity: ClientEdict): boolean {
    return this.#refractionOf(material) > 0.0
      && (material.flags & (MaterialFlags.MF_TURBULENT | MaterialFlags.MF_SKIP)) === 0
      && ((material.flags & MaterialFlags.MF_TRANSPARENT) !== 0 || entity.alpha < 1.0);
  }

  /**
   * Whether a brush entity has glass that refracts in this pass.
   * @returns True when one of its chains does.
   */
  #hasRefractingGlass(clmodel: BrushModel, entity: ClientEdict): boolean {
    for (let i = 0; i < clmodel.chains.length; i++) {
      if (this.#refractsGlassChain(clmodel.textures[clmodel.chains[i][0]] as BaseMaterial, entity)) {
        return true;
      }
    }

    return false;
  }

  /**
   * `brush-refract` bends what is behind the surface along its normal map. A PBR material binds its own or a flat one;
   * any other material binds none without a deluxemap, so it gets the flat one here and does not bend.
   */
  static #bindGlassNormal(material: BaseMaterial, program: GLProgramInfo): void {
    if (program.tSceneColor === undefined || material instanceof PBRMaterial) {
      return;
    }

    DefaultTextures.flatnormalmap.bind(program.tNormal!);
  }

  /**
   * Binds what `brush-refract` samples of the scene: the depth and color copies the transparent pass made before the
   * refracting run. The strength is set per material, see {@link BrushModelRenderer.#setGlassDrawUniforms}. Undo with
   * `_unbindSceneInputs`.
   */
  #bindRefractionInputs(program: GLProgramInfo): void {
    PostProcess.depthCopy!.depthTexture!.bind(program.tDepth!);
    PostProcess.colorCopy!.colorTexture(0).bind(program.tSceneColor!);
    gl.uniform2f(program.uScreenSize!, PostProcess.width, PostProcess.height);
  }

  /**
   * Sets the uniforms of one draw of a translucent brush surface that depend on its material: the alpha, and the
   * strength of the refraction when the program refracts (`brush-refract`).
   * @param program The program in use.
   * @param material The material about to be drawn, after `MaterialBinder.Emit`.
   * @param entityAlpha The alpha of the entity it is drawn for, 1 for the world.
   */
  #setGlassDrawUniforms(program: GLProgramInfo, material: BaseMaterial, entityAlpha: number): void {
    gl.uniform1f(program.uAlpha!, entityAlpha * material.currentAlpha);

    if (program.uRefraction !== undefined) {
      gl.uniform1f(program.uRefraction, this.#refractionOf(material));
    }
  }

  /**
   * The alpha a turbulent material is drawn with for an entity, resolved the way the draw resolves it.
   * @returns Alpha in the 0..1 range.
   */
  #turbulentAlpha(material: BaseMaterial, entity: ClientEdict): number {
    MaterialBinder.Emit(material, entity);

    return this._getTurbulentMaterialAlpha(material, entity);
  }

  /**
   * Whether a brush model has liquid surfaces.
   * @returns True when one of its chains is turbulent.
   */
  static #hasTurbulentChains(clmodel: BrushModel): boolean {
    for (let i = 0; i < clmodel.chains.length; i++) {
      const material = clmodel.textures[clmodel.chains[i][0]] as BaseMaterial;

      if ((material.flags & MaterialFlags.MF_TURBULENT) !== 0 && (material.flags & MaterialFlags.MF_SKIP) === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Binds what the turbulent shader samples of the scene: the depth drawn so far (`PostProcess.sceneDepthCopy`, which
   * copies it again only when it changed) and the color copy the transparent pass made before the refracting
   * liquids. Without the scene capture the units get empty textures.
   */
  _bindTurbulentSceneInputs(program: GLProgramInfo): void {
    gl.uniform1f(program.uCameraInside!, Visibility.viewContents <= content.CONTENT_WATER ? 1.0 : 0.0);

    if (!PostProcess.active) {
      DefaultTextures.null_texture.bind(program.tDepth!);
      DefaultTextures.null_texture.bind(program.tSceneColor!);
      gl.uniform2f(program.uScreenSize!, 1.0, 1.0);
      return;
    }

    PostProcess.sceneDepthCopy().bind(program.tDepth!);
    PostProcess.colorCopy!.colorTexture(0).bind(program.tSceneColor!);
    gl.uniform2f(program.uScreenSize!, PostProcess.width, PostProcess.height);
  }

  /**
   * Puts empty textures on the units the scene inputs of a program (`turbulent`, `brush-refract`) were bound to.
   * Other programs read their own maps from the same units (the brush shader its specular, normal and deluxe maps),
   * and a material that has none does not rebind them: without this the scene copies would be sampled as the maps
   * of the surfaces that follow. A program without scene inputs (`brush`) leaves the units alone.
   */
  _unbindSceneInputs(program: GLProgramInfo): void {
    if (!PostProcess.active || program.tSceneColor === undefined) {
      return;
    }

    DefaultTextures.null_texture.bind(program.tDepth!);
    DefaultTextures.null_texture.bind(program.tSceneColor!);
  }

  /**
   * Sets the uniforms of one turbulent draw that depend on its alpha: the alpha, the depth fog of translucent liquids
   * when the map opted in with `_qs_waterfog`, and the refraction of translucent liquids when it opted in with
   * `_qs_waterrefraction` or its material asked for it. Opaque liquids rely on PVS, get no absorption and do not refract.
   */
  _setTurbulentDrawUniforms(program: GLProgramInfo, material: BaseMaterial, alpha: number): void {
    const translucent = PostProcess.active && alpha < 1.0;
    const waterfogEnabled = clientRuntimeState.worldmodel?.worldspawnInfo._qs_waterfog === '1';

    gl.uniform1f(program.uAlpha!, alpha);
    gl.uniform1f(program.uWaterFogDensity!, translucent && waterfogEnabled ? 0.01 : 0.0);
    gl.uniform1f(program.uRefraction!, translucent ? this.#refractionOf(material) : 0.0);
  }

  // ─── Shadow rendering ────────────────────────────────────────────

  override renderShadow(model: BaseModel, entity: ClientEdict, ctx: ShadowRenderContext): void {
    const clmodel = model as BrushModel;
    if (!clmodel.opaqueVAO || !clmodel.chains || clmodel.chains.length === 0) {
      return;
    }
    GL.BindVAO(clmodel.opaqueVAO as WebGLVertexArrayObject);
    const program = GL.UseProgram(ctx.isPointLight ? 'shadow-point' : 'shadow-brush')!;

    gl.uniform3fv(program.uOrigin!, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ctx.lightSpaceMatrix);
    gl.uniform1f(program.uCasterFade!, ctx.casterFade);

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const flags = (clmodel.textures[chain[0]] as { flags: number }).flags;
      if (flags & (MaterialFlags.MF_SKIP | MaterialFlags.MF_TRANSPARENT | MaterialFlags.MF_TURBULENT)) {
        continue;
      }
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
    }
    GL.UnbindVAO();
  }

  // ─── World rendering ──────────────────────────────────────────────

  /**
   * Render the world (entity 0) opaque surfaces using the leafs structure.
   */
  renderWorld(clmodel: BrushModel): void {
    const worldspawn = clientRuntimeState.clientEntities.getEntity(0);

    GL.BindVAO(clmodel.opaqueVAO!);
    RenderStats.c_brush_vbos++;

    const program = GL.UseProgram('brush')!;
    gl.uniform3f(program.uAmbientLight!, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha!, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale!, 0.0);
    gl.uniform1f(program.uBloomDlightScale!, rendererCvars.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(rendererCvars.bloomSpecularStrength?.value ?? 0.0));
    gl.uniform1f(program.uInterpolation!, Interpolation.Texture());
    gl.uniform1f(program.uLightstyleInterpolation!, Interpolation.Lightstyle());
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform4f(program.uLightVec!, 0.0, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicLightVec!, 0.0, 0.0, 0.0);

    this._setupBrushShaderCommon(program, clmodel, true);
    LightStyles.lightstyle_texture_a.bind(program.tLightStyleA!);
    LightStyles.lightstyle_texture_b.bind(program.tLightStyleB!);
    const hasDeluxemap = this._bindBrushDeluxemap(program, clmodel);

    const state = WorldRenderState.of(clmodel);
    const visibleLeafs = state.visibleLeafs;

    for (let i = 0; i < visibleLeafs.length; i++) {
      const leaf = visibleLeafs[i];

      if (state.skychains[leaf] === 0) {
        continue;
      }

      BrushModelRenderer.#loadLeafBounds(state, leaf);

      if (Camera.CullBox(BrushModelRenderer.#leafMins, BrushModelRenderer.#leafMaxs)) {
        continue;
      }

      for (let j = 0; j < state.skychains[leaf]; j++) {
        const cmds = state.cmds[leaf][j];
        const material = clmodel.textures[cmds[0]] as BaseMaterial;

        if (material.flags & MaterialFlags.MF_SKIP) {
          continue;
        }

        if (material.flags & MaterialFlags.MF_TRANSPARENT) {
          continue;
        }

        RenderStats.c_brush_verts += cmds[2];
        RenderStats.c_brush_tris += cmds[2] / 3;

        MaterialBinder.Emit(material, worldspawn);
        MaterialBinder.Bind(material, program, hasDeluxemap);

        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
        RenderStats.c_brush_draws++;
      }
    }

    GL.UnbindVAO();
  }

  /**
   * Sets up a program of the brush family for the translucent world batches.
   * @returns The program in use.
   */
  #beginWorldBlendedPass(clmodel: BrushModel, programName: 'brush' | 'brush-refract'): GLProgramInfo {
    GL.BindVAO(clmodel.opaqueVAO!);
    RenderStats.c_brush_vbos++;

    const program = GL.UseProgram(programName)!;
    this._worldTransparentProgram = program;
    this._worldTransparentModel = clmodel;

    gl.uniform3f(program.uAmbientLight!, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha!, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale!, 0.0);
    gl.uniform1f(program.uBloomDlightScale!, rendererCvars.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(rendererCvars.bloomSpecularStrength?.value ?? 0.0));
    gl.uniform1f(program.uInterpolation!, Interpolation.Texture());
    gl.uniform1f(program.uLightstyleInterpolation!, Interpolation.Lightstyle());
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform4f(program.uLightVec!, 0.0, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicLightVec!, 0.0, 0.0, 0.0);

    this._setupBrushShaderCommon(program, clmodel, true);
    LightStyles.lightstyle_texture_a.bind(program.tLightStyleA!);
    LightStyles.lightstyle_texture_b.bind(program.tLightStyleB!);
    this._worldTransparentHasDeluxemap = this._bindBrushDeluxemap(program, clmodel);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    return program;
  }

  /**
   * Collect the visible translucent world batches that are not liquids (fences, glass), with their distance from the
   * viewpoint for back-to-front sorting. Like the liquids, every batch is handed out once.
   * @returns Batch entries with view distances.
   */
  getWorldTransparentBatches(clmodel: BrushModel, vieworg: Float32Array | number[]): { batch: WorldSurfaceBatch; dist: number }[] {
    return this.#collectVisibleBatches(WorldRenderState.of(clmodel), WorldRenderState.of(clmodel).transparentBatches, vieworg);
  }

  /**
   * Setup GL state for drawing translucent world batches with the `brush` program.
   * Call once before one or more `renderWorldTransparentBatch` calls.
   */
  beginWorldTransparentPass(clmodel: BrushModel): void {
    this.#beginWorldBlendedPass(clmodel, 'brush');
  }

  /**
   * Setup GL state for drawing translucent world batches that refract, with the `brush-refract` program, which
   * samples the copies of the scene the transparent pass made before them.
   * Call once before one or more `renderWorldTransparentBatch` calls.
   */
  beginWorldRefractivePass(clmodel: BrushModel): void {
    const program = this.#beginWorldBlendedPass(clmodel, 'brush-refract');

    this.#bindRefractionInputs(program);
  }

  /**
   * Render a single translucent world batch.
   * Must be called between `beginWorldTransparentPass` or `beginWorldRefractivePass` and `endWorldTransparentPass`.
   */
  renderWorldTransparentBatch(clmodel: BrushModel, batch: WorldSurfaceBatch): void {
    const worldspawn = clientRuntimeState.clientEntities.getEntity(0);
    const material = clmodel.textures[batch.texture] as BaseMaterial;

    if (material.flags & MaterialFlags.MF_SKIP) {
      return;
    }

    RenderStats.c_brush_verts += batch.vertexCount;
    RenderStats.c_brush_tris += batch.vertexCount / 3;

    MaterialBinder.Emit(material, worldspawn);
    this.#setGlassDrawUniforms(this._worldTransparentProgram!, material, 1.0);
    MaterialBinder.Bind(material, this._worldTransparentProgram!, this._worldTransparentHasDeluxemap);
    BrushModelRenderer.#bindGlassNormal(material, this._worldTransparentProgram!);

    gl.drawArrays(gl.TRIANGLES, batch.firstVertex, batch.vertexCount);
    RenderStats.c_brush_draws++;
  }

  /** Cleanup GL state after world transparent rendering. */
  endWorldTransparentPass(): void {
    gl.disable(gl.BLEND);
    GL.UnbindVAO();
    this._unbindSceneInputs(this._worldTransparentProgram!);
    this._worldTransparentProgram = null;
    this._worldTransparentModel = null;
    this._worldTransparentHasDeluxemap = false;
  }

  // ─── World turbulent rendering ────────────────────────────────────

  /**
   * Collect visible world turbulent draw batches with tight bounds so fog and
   * semi-transparent liquids can share the same sorted space.
   * @returns Turbulent chain entries with view distances for back-to-front sorting.
   */
  getWorldTurbulentChains(clmodel: BrushModel, vieworg: Float32Array | number[]): { batch: WorldSurfaceBatch; dist: number }[] {
    return this.#collectVisibleBatches(WorldRenderState.of(clmodel), WorldRenderState.of(clmodel).turbulentChains, vieworg);
  }

  /**
   * Collects the batches of the visible leafs that are in the view, once each: a batch on the boundary of leafs is
   * referred to by each of them.
   * @returns Batch entries with view distances.
   */
  #collectVisibleBatches(state: WorldRenderState, batchesOfLeafs: WorldSurfaceBatch[][], vieworg: Float32Array | number[]): { batch: WorldSurfaceBatch; dist: number }[] {
    const items: { batch: WorldSurfaceBatch; dist: number }[] = [];
    const seen = BrushModelRenderer.#seenBatches;

    seen.clear();

    const visibleLeafs = state.visibleLeafs;

    for (let i = 0; i < visibleLeafs.length; i++) {
      const leaf = visibleLeafs[i];
      const batches = batchesOfLeafs[leaf];

      if (batches.length === 0) {
        continue;
      }

      BrushModelRenderer.#loadLeafBounds(state, leaf);

      if (Camera.CullBox(BrushModelRenderer.#leafMins, BrushModelRenderer.#leafMaxs)) {
        continue;
      }

      for (let j = 0; j < batches.length; j++) {
        const batch = batches[j];

        if (seen.has(batch)) {
          continue;
        }
        seen.add(batch);

        if (Camera.CullBox(batch.mins, batch.maxs)) {
          continue;
        }

        items.push({ batch, dist: this._getBoundsDistanceToView(batch.mins, batch.maxs, vieworg) });
      }
    }

    // do not keep the batches of a map alive after it is gone
    seen.clear();

    return items;
  }

  /**
   * Setup GL state for world turbulent rendering.
   * Call once before one or more `renderWorldTurbulentChain` calls.
   */
  beginWorldTurbulentPass(clmodel: BrushModel): void {
    GL.BindVAO(clmodel.turbulentVAO!);
    RenderStats.c_brush_vbos++;

    const program = GL.UseProgram('turbulent')!;
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform1f(program.uTime!, Host.realtime);
    gl.uniform1f(program.uInterpolation!, Interpolation.Texture());
    gl.uniform1f(program.uLightstyleInterpolation!, Interpolation.Lightstyle());
    gl.uniform1f(program.uBloomEmissiveScale!, 0.0);
    gl.uniform1f(program.uBloomDlightScale!, rendererCvars.bloomDlightStrength.value);

    this._bindTurbulentSceneInputs(program);

    this._setupBrushShaderCommon(program, clmodel, true);
    LightStyles.lightstyle_texture_a.bind(program.tLightStyleA!);
    LightStyles.lightstyle_texture_b.bind(program.tLightStyleB!);

    this._worldTurbulentProgram = program;
    this._worldTurbulentModel = clmodel;
  }

  /**
   * Render a single pre-sorted world turbulent draw batch.
   * Must be called between `beginWorldTurbulentPass` and `endWorldTurbulentPass`.
   */
  renderWorldTurbulentChain(clmodel: BrushModel, chain: WorldSurfaceBatch): void {
    this._renderWorldTurbulentBatch(clmodel, chain.texture, chain.firstVertex, chain.vertexCount);
  }

  /** Cleanup GL state after world turbulent rendering. */
  endWorldTurbulentPass(): void {
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    GL.UnbindVAO();
    this._unbindSceneInputs(this._worldTurbulentProgram!);
    this._worldTurbulentProgram = null;
    this._worldTurbulentModel = null;
  }

  /**
   * Render turbulent surfaces into the boundary depth texture only.
   * Called as a pre-pass (before the main scene render) when the camera is
   * submerged in a liquid. The captured depths tell the UnderwaterFogEffect
   * where the water surface is per pixel, so fog stops at the boundary.
   */
  renderWorldTurbulentsBoundaryDepth(clmodel: BrushModel): void {
    const program = GL.UseProgram('turbulent-depth')!;
    GL.BindVAO(clmodel.turbulentVAO!);
    RenderStats.c_brush_vbos++;

    // World model is always at the origin with identity rotation.
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform1f(program.uTime!, Host.realtime);

    // the batches of the visible leafs in the view, each once although several leafs refer to it
    const state = WorldRenderState.of(clmodel);
    const items = this.#collectVisibleBatches(state, state.turbulentChains, Camera.refdef.vieworg);

    for (let i = 0; i < items.length; i++) {
      const batch = items[i].batch;
      gl.drawArrays(gl.TRIANGLES, batch.firstVertex, batch.vertexCount);
      RenderStats.c_brush_verts += batch.vertexCount;
    }

    GL.UnbindVAO();
  }

  // ─── Fog volume rendering ─────────────────────────────────────────

  /**
   * Render all fog volumes defined in the world model.
   * Handles both inline brush model fog volumes (*N) and world-level
   * water/slime/lava fog volumes (modelIndex === 0).
   */
  renderFogVolumes(worldmodel: BrushModel): void {
    if (!this.beginFogVolumePass(worldmodel)) {
      return;
    }
    for (const fogVolume of worldmodel.fogVolumes) {
      this.renderSingleFogVolume(worldmodel, fogVolume);
    }
    this.endFogVolumePass();
  }

  /**
   * Collect fog volumes with distance from the given viewpoint for back-to-front sorting.
   * @returns Fog volume entries with view distances for back-to-front sorting.
   */
  getFogVolumeItems(worldmodel: BrushModel, vieworg: Float32Array | number[]): { fogVolume: FogVolumeInfo; dist: number }[] {
    if (!worldmodel.fogVolumes || worldmodel.fogVolumes.length === 0) {
      return [];
    }
    const items: { fogVolume: FogVolumeInfo; dist: number }[] = [];
    for (const fogVolume of worldmodel.fogVolumes) {
      const dist = this._getBoundsDistanceToView(fogVolume.mins, fogVolume.maxs, vieworg);
      items.push({ fogVolume, dist });
    }
    return items;
  }

  /**
   * Setup GL state for fog volume rendering.
   * @returns True if fog volume pass was started, false if skipped.
   */
  beginFogVolumePass(worldmodel: BrushModel): boolean {
    if (!worldmodel.fogVolumes || worldmodel.fogVolumes.length === 0) {
      return false;
    }

    const depthCopy = PostProcess.sceneDepthCopy();
    const program = GL.UseProgram('fog-volume')!;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.cullFace(gl.BACK);
    gl.enable(gl.CULL_FACE);

    depthCopy.bind(program.tDepth!);
    gl.uniform2f(program.uScreenSize!, PostProcess.width, PostProcess.height);

    this._fogVolumeProgram = program;
    this._fogVolumeDepth = depthCopy;
    return true;
  }

  /**
   * Render a single fog volume.
   * Must be called between `beginFogVolumePass` and `endFogVolumePass`.
   */
  renderSingleFogVolume(worldmodel: BrushModel, fogVolume: FogVolumeInfo): void {
    const program = this._fogVolumeProgram!;

    gl.uniform3f(
      program.uFogVolumeColor!,
      fogVolume.color[0] / 255.0,
      fogVolume.color[1] / 255.0,
      fogVolume.color[2] / 255.0,
    );
    gl.uniform1f(program.uFogVolumeDensity!, fogVolume.density);
    gl.uniform1f(program.uFogVolumeMaxOpacity!, fogVolume.maxOpacity);

    // Bind the light probe 3D texture for this fog volume.
    // _getFogLightProbe / _getFogLightProbeWhite may upload via .bind(0), which
    // clobbers texture unit 0 (tDepth). Re-bind depth after.
    const probe = this._getFogLightProbe(fogVolume);
    (probe ? probe.texture : this._getFogLightProbeWhite()).bind(program.tLightProbe!);
    this._fogVolumeDepth!.bind(program.tDepth!);

    this._uploadFogDlights(fogVolume);

    gl.uniform3f(program.uFogVolumeMins!, fogVolume.mins[0], fogVolume.mins[1], fogVolume.mins[2]);
    gl.uniform3f(program.uFogVolumeMaxs!, fogVolume.maxs[0], fogVolume.maxs[1], fogVolume.maxs[2]);

    if (fogVolume.modelIndex === 0) {
      const sizeX = fogVolume.maxs[0] - fogVolume.mins[0];
      const sizeY = fogVolume.maxs[1] - fogVolume.mins[1];
      const sizeZ = fogVolume.maxs[2] - fogVolume.mins[2];

      gl.uniformMatrix3fv(program.uAngles!, false, new Float32Array([
        sizeX, 0, 0,
        0, sizeY, 0,
        0, 0, sizeZ,
      ]));
      gl.uniform3f(program.uOrigin!, fogVolume.mins[0], fogVolume.mins[1], fogVolume.mins[2]);

      this._getFogCubeVBO();

      // Bind the fog cube VAO directly instead of through GL.BindVAO/UnbindVAO
      // to avoid attribute/program state being cleared between volumes.
      gl.bindVertexArray(this.#fogCubeVAO);
      RenderStats.c_brush_vbos++;

      gl.drawArrays(gl.TRIANGLES, 0, 36);
      gl.bindVertexArray(null);
      RenderStats.c_brush_draws++;
    } else {
      const submodel = worldmodel.submodels[fogVolume.modelIndex - 1];

      if (!submodel || !submodel.cmds) {
        return;
      }

      gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
      gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);

      gl.bindBuffer(gl.ARRAY_BUFFER, submodel.cmds as WebGLBuffer);
      RenderStats.c_brush_vbos++;
      gl.vertexAttribPointer(program.aPosition!.location as number, 3, gl.FLOAT, false, 80, 0);

      if (submodel.chains) {
        for (const chain of submodel.chains) {
          gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
          RenderStats.c_brush_draws++;
        }
      }
    }
  }

  /** Cleanup GL state after fog volume rendering. */
  endFogVolumePass(): void {
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.cullFace(gl.FRONT);
    gl.enable(gl.CULL_FACE);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    gl.disable(gl.BLEND);

    this._fogVolumeProgram = null;
    this._fogVolumeDepth = null;
  }


  cleanupRenderState(_pass = 0): void {
    // Brush models clean up their own state per-entity
  }

  // ─── Model preparation ────────────────────────────────────────────

  /**
   * Prepare brush model for rendering (build display lists, upload to GPU).
   * Handles both world models (using leafs) and entity models (using chains).
   * @param isWorldModel True if this is the actual world map (model index 1)
   */
  prepareModel(model: BrushModel, isWorldModel = false): void {
    const m = model;

    if (m.cmds && typeof m.cmds === 'object' && m.cmds !== null) {
      gl.deleteBuffer(m.cmds as WebGLBuffer);
      m.cmds = null;
    }

    if (model.name[0] !== '*') {
      for (const face of model.faces) {
        this._buildSurfaceDisplayList(model, face);
      }
    }

    if (isWorldModel) {
      this._buildWorldModelDisplayLists(m);
    } else {
      this._buildBrushModelDisplayLists(m);
    }
  }

  /**
   * Free GPU resources for this brush model.
   */
  cleanupModel(model: BrushModel): void {
    if (gl) {
      if (model.opaqueVAO) {
        gl.deleteVertexArray(model.opaqueVAO!);
        model.opaqueVAO = null;
      }

      if (model.turbulentVAO) {
        gl.deleteVertexArray(model.turbulentVAO!);
        model.turbulentVAO = null;
      }

      if (model.cmds) {
        gl.deleteBuffer(model.cmds!);
        model.cmds = null;
      }
    }

    if (model.fogVolumes && model.fogVolumes.length > 0) {
      this._freeFogLightProbes();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /**
   * Distance from the viewpoint to the nearest point of the bounds of a brush entity, the same measure the world
   * leafs, turbulent chains and fog volumes sort by, so they rank against each other in the transparent pass.
   * An inline submodel keeps its vertices at world coordinates, so a door or a window that has not moved has the
   * origin 0 0 0 wherever it is in the map: its bounds are the model bounds moved by the origin, as the frustum
   * cull in `render()` has it. A model that is not a submodel is bounded by its radius around the origin.
   * @returns Distance in world units.
   */
  getEntityViewDistance(clmodel: BrushModel, entity: ClientEdict, vieworg: Float32Array | number[]): number {
    const origin = entity.origin;

    if (clmodel.submodel) {
      for (let axis = 0; axis < 3; axis++) {
        BrushModelRenderer.#scratchMins[axis] = origin[axis] + clmodel.mins[axis];
        BrushModelRenderer.#scratchMaxs[axis] = origin[axis] + clmodel.maxs[axis];
      }
    } else {
      for (let axis = 0; axis < 3; axis++) {
        BrushModelRenderer.#scratchMins[axis] = origin[axis] - clmodel.radius;
        BrushModelRenderer.#scratchMaxs[axis] = origin[axis] + clmodel.radius;
      }
    }

    return this._getBoundsDistanceToView(BrushModelRenderer.#scratchMins, BrushModelRenderer.#scratchMaxs, vieworg);
  }

  /**
   * Distance from the viewpoint to the nearest point of an axis-aligned bounding box.
   * @private
   * @returns Distance to the nearest AABB corner in world units.
   */
  _getBoundsDistanceToView(
    mins: Vector | number[] | Float32Array,
    maxs: Vector | number[] | Float32Array,
    vieworg: Float32Array | number[],
  ): number {
    const nearestX = Math.max(mins[0], Math.min(vieworg[0], maxs[0]));
    const nearestY = Math.max(mins[1], Math.min(vieworg[1], maxs[1]));
    const nearestZ = Math.max(mins[2], Math.min(vieworg[2], maxs[2]));
    const dx = nearestX - vieworg[0];
    const dy = nearestY - vieworg[1];
    const dz = nearestZ - vieworg[2];

    return Math.hypot(dx, dy, dz);
  }

  /** @private */
  _renderWorldTurbulentBatch(clmodel: BrushModel, textureIndex: number, firstVertex: number, vertexCount: number): void {
    const worldspawn = clientRuntimeState.clientEntities.getEntity(0);
    const program = this._worldTurbulentProgram!;
    const material = clmodel.textures[textureIndex] as BaseMaterial;

    MaterialBinder.Emit(material, worldspawn);
    const alpha = this._getTurbulentMaterialAlpha(material, worldspawn);
    this._setTurbulentSurfaceState(alpha);
    this._setTurbulentDrawUniforms(program, material, alpha);

    RenderStats.c_brush_verts += vertexCount;
    RenderStats.c_brush_tris += vertexCount / 3;
    MaterialBinder.Bind(material, program);
    gl.drawArrays(gl.TRIANGLES, firstVertex, vertexCount);
    RenderStats.c_brush_draws++;
  }

  /**
   * Combined clamped alpha for a turbulent material surface.
   * @private
   * @returns Clamped product of material and entity alpha in the 0..1 range.
   */
  _getTurbulentMaterialAlpha(material: BaseMaterial, entity: ClientEdict): number {
    const entityAlpha = entity?.alpha ?? 1.0;
    return Math.max(0.0, Math.min(material.currentAlpha * entityAlpha, 1.0));
  }

  /**
   * Opaque liquids must write depth so they occlude later fog/transparent passes, which then need a new copy of it.
   * @private
   */
  _setTurbulentSurfaceState(alpha: number): void {
    if (alpha >= 1.0) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      PostProcess.invalidateSceneDepthCopy();
      return;
    }

    gl.enable(gl.BLEND);
    gl.depthMask(false);
  }

  /** @private */
  _setupBrushShaderCommon(program: GLProgramInfo, clmodel: BrushModel, isWorld: boolean): void {
    if ((rendererCvars.fullbright.value !== 0) || (clmodel.lightdata === null && clmodel.lightdata_rgb === null)) {
      DefaultTextures.fullbright_texture.bind(program.tLightmap!);
    } else {
      Lightmaps.lightmap_texture.bind(program.tLightmap!);
    }

    if (rendererCvars.flashblend.value === 0 && (isWorld || clmodel.submodel)) {
      Lightmaps.dlightmap_rgba_texture.bind(program.tDlight!);
    } else {
      DefaultTextures.null_texture.bind(program.tDlight!);
    }

    const topDownShadow = ShadowMap.getActiveTopDownTexture();
    if (program.tShadowMap !== undefined && topDownShadow) {
      topDownShadow.bind(program.tShadowMap);
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

  /** @private */
  _renderOpaqueSurfaces(clmodel: BrushModel, e: ClientEdict, viewMatrix: number[]): void {
    const program = GL.UseProgram('brush')!;
    this._applyEntityLighting(program, clmodel, e);

    gl.uniform3fv(program.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, viewMatrix);
    gl.uniform1f(program.uInterpolation!, Interpolation.Texture());
    gl.uniform1f(program.uLightstyleInterpolation!, Interpolation.Lightstyle());
    gl.uniform1f(program.uAlpha!, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale!, rendererCvars.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(rendererCvars.bloomSpecularStrength?.value ?? 0.0));

    this._setupBrushShaderCommon(program, clmodel, false);
    LightStyles.lightstyle_texture_a.bind(program.tLightStyleA!);
    LightStyles.lightstyle_texture_b.bind(program.tLightStyleB!);
    const hasDeluxemap = this._bindBrushDeluxemap(program, clmodel);

    if (!clmodel.chains || clmodel.chains.length === 0) {
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]] as BaseMaterial;

      if ((material.flags & (MaterialFlags.MF_TURBULENT | MaterialFlags.MF_TRANSPARENT | MaterialFlags.MF_SKIP)) !== 0) {
        continue;
      }

      RenderStats.c_brush_verts += chain[2];
      RenderStats.c_brush_tris += chain[2] / 3;

      MaterialBinder.Emit(material, e);
      MaterialBinder.Bind(material, program, hasDeluxemap);

      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      RenderStats.c_brush_draws++;
    }
  }

  /**
   * Draws the translucent surfaces of a brush entity that are not liquids.
   * @param refractive True for the glass that refracts in this pass (drawn by `brush-refract`), false for the rest.
   */
  _renderTransparentSurfaces(clmodel: BrushModel, e: ClientEdict, viewMatrix: number[], refractive: boolean): void {
    const program = GL.UseProgram(refractive ? 'brush-refract' : 'brush')!;
    this._applyEntityLighting(program, clmodel, e);

    gl.uniform3fv(program.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, viewMatrix);
    gl.uniform1f(program.uInterpolation!, Interpolation.Texture());
    gl.uniform1f(program.uLightstyleInterpolation!, Interpolation.Lightstyle());
    gl.uniform1f(program.uAlpha!, e.alpha);
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale!, rendererCvars.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(rendererCvars.bloomSpecularStrength?.value ?? 0.0));

    this._setupBrushShaderCommon(program, clmodel, false);
    LightStyles.lightstyle_texture_a.bind(program.tLightStyleA!);
    LightStyles.lightstyle_texture_b.bind(program.tLightStyleB!);
    const hasDeluxemap = this._bindBrushDeluxemap(program, clmodel);

    if (refractive) {
      this.#bindRefractionInputs(program);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (!clmodel.chains || clmodel.chains.length === 0) {
      this._unbindSceneInputs(program);
      gl.disable(gl.BLEND);
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]] as BaseMaterial;

      if (material.flags & MaterialFlags.MF_SKIP) {
        continue;
      }

      // refracting glass is drawn by the second call, with its own program
      if (this.#refractsGlassChain(material, e) !== refractive) {
        continue;
      }

      // liquids index the turbulent vertex array, render() draws them with their own program
      if ((material.flags & MaterialFlags.MF_TURBULENT) !== 0) {
        continue;
      }

      if (e.alpha === 1.0 && !(material.flags & MaterialFlags.MF_TRANSPARENT)) {
        continue;
      }

      RenderStats.c_brush_verts += chain[2];
      RenderStats.c_brush_tris += chain[2] / 3;

      MaterialBinder.Emit(material, e);
      this.#setGlassDrawUniforms(program, material, e.alpha);
      MaterialBinder.Bind(material, program, hasDeluxemap);
      BrushModelRenderer.#bindGlassNormal(material, program);

      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      RenderStats.c_brush_draws++;
    }

    this._unbindSceneInputs(program);
    gl.disable(gl.BLEND);
  }

  /** @private */
  _renderTurbulentSurfaces(clmodel: BrushModel, e: ClientEdict, viewMatrix: number[]): void {
    const program = GL.UseProgram('turbulent')!;
    gl.uniform3fv(program.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, viewMatrix);
    gl.uniform1f(program.uTime!, Host.realtime % (Math.PI * 2.0));
    gl.uniform1f(program.uInterpolation!, Interpolation.Texture());
    gl.uniform1f(program.uLightstyleInterpolation!, Interpolation.Lightstyle());
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale!, rendererCvars.bloomDlightStrength.value);

    this._setupBrushShaderCommon(program, clmodel, false);
    LightStyles.lightstyle_texture_a.bind(program.tLightStyleA!);
    LightStyles.lightstyle_texture_b.bind(program.tLightStyleB!);
    this._bindTurbulentSceneInputs(program);

    if (!clmodel.chains || clmodel.chains.length === 0) {
      this._unbindSceneInputs(program);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]] as BaseMaterial;

      if (material.flags & MaterialFlags.MF_SKIP) {
        continue;
      }

      if (!(material.flags & MaterialFlags.MF_TURBULENT)) {
        continue;
      }

      MaterialBinder.Emit(material, e);
      const alpha = this._getTurbulentMaterialAlpha(material, e);
      this._setTurbulentSurfaceState(alpha);
      this._setTurbulentDrawUniforms(program, material, alpha);
      MaterialBinder.Bind(material, program);

      RenderStats.c_brush_verts += chain[2];
      RenderStats.c_brush_tris += chain[2] / 3;
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      RenderStats.c_brush_draws++;
    }

    this._unbindSceneInputs(program);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /** @private */
  _applyEntityLighting(program: GLProgramInfo, clmodel: BrushModel, entity: ClientEdict): void {
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      clmodel,
      entity,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      EntityLighting.CalculateLightValues,
      clientRuntimeState.worldmodel as BrushModel | null,
    );

    gl.uniform3fv(program.uAmbientLight!, lightingState.ambientlight);
    gl.uniform3fv(program.uShadeLight!, lightingState.shadelight);
    gl.uniform4f(
      program.uLightVec!,
      lightingState.lightPosition[0],
      lightingState.lightPosition[1],
      lightingState.lightPosition[2],
      0.0,
    );
    gl.uniform3fv(program.uDynamicShadeLight!, lightingState.dynamicShadeLight);
    gl.uniform3fv(program.uDynamicLightVec!, lightingState.dynamicLightPosition);
  }

  /**
   * @private
   * @returns Whether `clmodel` carries deluxemap data, so callers can pass it
   * on to `BaseMaterial.bindTo()` and enable per-pixel dot lighting for
   * plain (non-PBR) surfaces too.
   */
  _bindBrushDeluxemap(program: GLProgramInfo, clmodel: BrushModel): boolean {
    const hasDeluxemap = BrushModelRenderer.usesDeluxemap(clmodel, clientRuntimeState.worldmodel as BrushModel | null);

    if (hasDeluxemap) {
      Lightmaps.deluxemap_texture.bind(program.tDeluxemap!);
      gl.uniform1f(program.uHaveDeluxemap!, 1.0);
      return true;
    }

    DefaultTextures.normal_up_texture.bind(program.tDeluxemap!);
    gl.uniform1f(program.uHaveDeluxemap!, 0.0);
    return false;
  }

  /**
   * Create a VAO for brush geometry at the given byte offset in the VBO.
   * @private
   * @returns The created vertex array object.
   */
  _createBrushVAO(vbo: WebGLBuffer, offset: number): WebGLVertexArrayObject {
    return GL.CreateVAO(vbo, [
      { location: 0, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset },
      { location: 1, components: 4, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 12 },
      { location: 2, components: 4, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 28 },
      { location: 3, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 44 },
      { location: 4, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 56 },
      { location: 5, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 68 },
    ]);
  }

  // ─── Fog light probes ─────────────────────────────────────────────

  /**
   * Get or create the 1×1×1 white fallback fog light probe texture.
   * @private
   * @returns A white 3-D texture used when no probe data is available.
   */
  _getFogLightProbeWhite(): GLVolumeTexture {
    if (this.#fogLightProbeWhite) {
      return this.#fogLightProbeWhite;
    }

    this.#fogLightProbeWhite = new GLVolumeTexture();
    this.#fogLightProbeWhite.bind(0);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return this.#fogLightProbeWhite;
  }

  /** @private */
  _sampleFogLightProbe(fogVolume: FogVolumeInfo, data: Uint8Array, resX: number, resY: number, resZ: number): void {
    const sizeX = fogVolume.maxs[0] - fogVolume.mins[0];
    const sizeY = fogVolume.maxs[1] - fogVolume.mins[1];
    const sizeZ = fogVolume.maxs[2] - fogVolume.mins[2];
    const sliceSize = resX * resY;

    for (let iz = 0; iz < resZ; iz++) {
      for (let iy = 0; iy < resY; iy++) {
        for (let ix = 0; ix < resX; ix++) {
          const u = (ix + 0.5) / resX;
          const v = (iy + 0.5) / resY;
          const w = (iz + 0.5) / resZ;
          const worldPos = new Vector(
            fogVolume.mins[0] + u * sizeX,
            fogVolume.mins[1] + v * sizeY,
            fogVolume.mins[2] + w * sizeZ,
          );

          const [color] = LightSampler.LightPoint(worldPos);

          const idx = (iz * sliceSize + iy * resX + ix) * 4;
          const maxComp = Math.max(color[0], color[1], color[2]);

          if (maxComp > 1.0) {
            data[idx] = Math.min(255, Math.round((color[0] / maxComp) * 255));
            data[idx + 1] = Math.min(255, Math.round((color[1] / maxComp) * 255));
            data[idx + 2] = Math.min(255, Math.round((color[2] / maxComp) * 255));
          } else {
            data[idx] = 255;
            data[idx + 1] = 255;
            data[idx + 2] = 255;
          }
          data[idx + 3] = 255;
        }
      }
    }
  }

  /**
   * Build or refresh the 3-D light probe texture for a fog volume.
   * @private
   * @returns The created or updated probe data stored in the fog light probe map.
   */
  _createOrUpdateFogLightProbe(fogVolume: FogVolumeInfo): FogLightProbeData {
    const existing = this.#fogLightProbes.get(fogVolume);

    if (existing) {
      this._sampleFogLightProbe(fogVolume, existing.data, existing.resX, existing.resY, existing.resZ);
      existing.texture.bind(0);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, existing.resX, existing.resY, existing.resZ, gl.RGBA, gl.UNSIGNED_BYTE, existing.data);
      return existing;
    }

    const res = BrushModelRenderer.FOG_LIGHT_PROBE_RES;
    const resX = res;
    const resY = res;
    const resZ = res;
    const data = new Uint8Array(resX * resY * resZ * 4);

    this._sampleFogLightProbe(fogVolume, data, resX, resY, resZ);

    const texture = new GLVolumeTexture();
    texture.bind(0);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, resX, resY, resZ, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

    const probe: FogLightProbeData = { texture, resX, resY, resZ, data };
    this.#fogLightProbes.set(fogVolume, probe);
    return probe;
  }

  /**
   * Get the current fog light probe for a volume, rebuilding it when stale.
   * @private
   * @returns The probe data, or null when world lighting is unavailable.
   */
  _getFogLightProbe(fogVolume: FogVolumeInfo): FogLightProbeData | null {
    const worldmodel = clientRuntimeState.worldmodel as BrushModel | null;
    if (!worldmodel || (worldmodel.lightdata === null && worldmodel.lightdata_rgb === null)) {
      return null;
    }

    const styleFrame = Math.floor(clientRuntimeState.time * 10.0);
    const needsUpdate = styleFrame !== this.#fogProbeStyleFrame;

    if (needsUpdate) {
      this.#fogProbeStyleFrame = styleFrame;
    }

    if (!this.#fogLightProbes.has(fogVolume) || needsUpdate) {
      return this._createOrUpdateFogLightProbe(fogVolume);
    }

    return this.#fogLightProbes.get(fogVolume) ?? null;
  }

  /** @private */
  _freeFogLightProbes(): void {
    if (gl) {
      for (const { texture } of this.#fogLightProbes.values()) {
        texture.free();
      }
    }
    this.#fogLightProbes.clear();
  }

  /**
   * Collect active dynamic lights that overlap a fog volume's AABB.
   * @returns Up to MAX_FOG_DLIGHTS lights sorted by contribution (closest first).
   * @private
   */
  _collectFogDlights(fogVolume: FogVolumeInfo): FogDlightEntry[] {
    const results: FogDlightEntry[] = [];
    const dlights = clientRuntimeState.clientEntities.dlights;

    for (let i = 0; i < Def.limits.dlights; i++) {
      const dl = dlights[i];

      if (dl.isFree()) {
        continue;
      }

      const cx = Math.max(fogVolume.mins[0], Math.min(dl.origin[0], fogVolume.maxs[0]));
      const cy = Math.max(fogVolume.mins[1], Math.min(dl.origin[1], fogVolume.maxs[1]));
      const cz = Math.max(fogVolume.mins[2], Math.min(dl.origin[2], fogVolume.maxs[2]));
      const dx = dl.origin[0] - cx;
      const dy = dl.origin[1] - cy;
      const dz = dl.origin[2] - cz;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < dl.radius * dl.radius) {
        results.push({
          origin: dl.origin,
          radius: dl.radius,
          color: dl.color,
          distSq,
        });
      }
    }

    results.sort((a, b) => a.distSq - b.distSq);
    return results.slice(0, BrushModelRenderer.MAX_FOG_DLIGHTS);
  }

  /** @private */
  _uploadFogDlights(fogVolume: FogVolumeInfo): void {
    const program = this._fogVolumeProgram!;
    const dlights = this._collectFogDlights(fogVolume);

    gl.uniform1i(program.uDlightCount!, dlights.length);

    for (let i = 0; i < dlights.length; i++) {
      const dl = dlights[i];
      gl.uniform4f(
        program[`uDlightPos[${i}]`] as WebGLUniformLocation,
        dl.origin[0], dl.origin[1], dl.origin[2], dl.radius,
      );
      gl.uniform4f(
        program[`uDlightColor[${i}]`] as WebGLUniformLocation,
        dl.color[0], dl.color[1], dl.color[2], 0.0,
      );
    }
  }

  /**
   * Get or create the shared unit cube VBO used for world-level fog volumes.
   * @private
   * @returns The shared unit cube VBO for fog volume rendering.
   */
  _getFogCubeVBO(): WebGLBuffer {
    if (this.#fogCubeVBO) {
      return this.#fogCubeVBO;
    }

    // Unit cube [0,1]^3 — 12 triangles, 36 vertices, CW winding from outside
    const verts = new Float32Array([
      // Front face (z=1)
      0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1,
      // Back face (z=0)
      1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      // Top face (y=1)
      0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1,
      // Bottom face (y=0)
      0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0,
      // Right face (x=1)
      1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0,
      // Left face (x=0)
      0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1,
    ]);

    this.#fogCubeVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#fogCubeVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    this.#fogCubeVAO = GL.CreateVAO(this.#fogCubeVBO, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride: 12, offset: 0 },
    ]);

    return this.#fogCubeVBO;
  }

  // ─── Display list builders ────────────────────────────────────────

  /**
   * Build display lists for regular brush entities (doors, platforms, etc).
   * @private
   */
  _buildBrushModelDisplayLists(m: BrushModel): void {
    const cmds: number[] = [];
    const styles = [0.0, 0.0, 0.0, 0.0];
    const turbulentFallbackCache = new Map<string, number[]>();
    const turbulentFallbackAvgMap = this._buildTurbulentFallbackLightMap(m, turbulentFallbackCache);
    const precomputedVertices = new Set<number>();
    let verts = 0;
    let cutoff = 0;
    m.chains.length = 0;

    // Build opaque surfaces (non-sky, non-turbulent)
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if ((texture.flags & (MaterialFlags.MF_SKY | MaterialFlags.MF_TURBULENT | MaterialFlags.MF_SKIP)) !== 0) {
        continue;
      }
      const chain = [i, verts, 0];
      for (const surf of m.facesIter()) {
        if (surf.texture !== i) {
          continue;
        }
        if (!surf.verts || surf.verts.length === 0) {
          continue;
        }
        styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
        for (let l = 0; l < surf.styles.length; l++) {
          styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
        }
        chain[2] += surf.verts.length;
        for (let k = 0; k < surf.verts.length; k++) {
          const vert = surf.verts[k];
          const vertexIndex = cmds.length / Mesh.VERTEX_STRIDE;
          cmds.push(vert[0], vert[1], vert[2]);
          cmds.push(vert[3], vert[4], vert[5], vert[6]);
          cmds.push(styles[0], styles[1], styles[2], styles[3]);
          if (vert.length > 9) {
            cmds.push(vert[7], vert[8], vert[9]);
          } else {
            cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
          }
          if (vert.length > 15) {
            cmds.push(vert[10], vert[11], vert[12], vert[13], vert[14], vert[15]);
            precomputedVertices.add(vertexIndex);
          } else {
            cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
          }
        }
      }
      if (chain[2] !== 0) {
        m.chains.push(chain);
        verts += chain[2];
      }
    }
    cutoff = cmds.length;
    m.waterchain = verts * 80;
    verts = 0;

    // Build turbulent surfaces (water, lava, slime)
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if (!(texture.flags & MaterialFlags.MF_TURBULENT)) {
        continue;
      }
      const chain = [i, verts, 0];
      for (const surf of m.facesIter()) {
        if (surf.texture !== i) {
          continue;
        }
        if (!surf.verts || surf.verts.length === 0) {
          continue;
        }
        styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
        for (let l = 0; l < surf.styles.length; l++) {
          styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
        }
        const hasLightmap = this._surfaceHasTurbulentLightmap(m, surf);
        chain[2] += surf.verts.length;
        for (let k = 0; k < surf.verts.length; k++) {
          const vert = surf.verts[k];
          const posKey = `${Math.round(vert[0] * TURBULENT_FALLBACK_POS_QUANT)}|${Math.round(vert[1] * TURBULENT_FALLBACK_POS_QUANT)}|${Math.round(vert[2] * TURBULENT_FALLBACK_POS_QUANT)}`;
          const fallbackLight = hasLightmap ? [0.0, 0.0, 0.0] : (turbulentFallbackAvgMap.get(posKey) ?? [0.0, 0.0, 0.0]);
          const dlightTexCoordS = vert[5];
          const dlightTexCoordT = vert[6];
          cmds.push(vert[0], vert[1], vert[2]);
          cmds.push(vert[3], vert[4], dlightTexCoordS, dlightTexCoordT);
          cmds.push(styles[0], styles[1], styles[2], styles[3]);
          cmds.push(fallbackLight[0], fallbackLight[1], fallbackLight[2]);
          cmds.push(dlightTexCoordS, dlightTexCoordT, hasLightmap ? 1.0 : 0.0, 0.0, 0.0, 0.0);
        }
      }
      if (chain[2] !== 0) {
        m.chains.push(chain);
        verts += chain[2];
      }
    }

    Mesh.CalculateTangentBitangents(cmds, cutoff, precomputedVertices);

    m.cmds = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds as WebGLBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);

    m.opaqueVAO = this._createBrushVAO(m.cmds as WebGLBuffer, 0);
    m.turbulentVAO = this._createBrushVAO(m.cmds as WebGLBuffer, m.waterchain);
  }

  /**
   * Expand arbitrary bounds to contain all vertices of a surface.
   * @private
   */
  _expandBounds(mins: Vector, maxs: Vector, verts: number[][]): void {
    for (let v = 0; v < verts.length; v++) {
      const vert = verts[v];
      if (vert[0] < mins[0]) {
        mins[0] = vert[0];
      }
      if (vert[1] < mins[1]) {
        mins[1] = vert[1];
      }
      if (vert[2] < mins[2]) {
        mins[2] = vert[2];
      }
      if (vert[0] > maxs[0]) {
        maxs[0] = vert[0];
      }
      if (vert[1] > maxs[1]) {
        maxs[1] = vert[1];
      }
      if (vert[2] > maxs[2]) {
        maxs[2] = vert[2];
      }
    }
  }

  /**
   * Puts the bounds of a leaf, as the display lists grew them, into the scratch vectors the loops cull and measure with.
   */
  static #loadLeafBounds(state: WorldRenderState, leaf: number): void {
    const bounds = state.leafBounds;
    const base = leaf * 6;

    BrushModelRenderer.#leafMins.setTo(bounds[base], bounds[base + 1], bounds[base + 2]);
    BrushModelRenderer.#leafMaxs.setTo(bounds[base + 3], bounds[base + 4], bounds[base + 5]);
  }

  /**
   * Expand a leaf's bounding box to contain all vertices of a surface.
   * @private
   */
  _expandLeafBoundsForSurface(state: WorldRenderState, leaf: number, verts: number[][]): void {
    const bounds = state.leafBounds;
    const base = leaf * 6;

    for (const vert of verts) {
      for (let axis = 0; axis < 3; axis++) {
        bounds[base + axis] = Math.min(bounds[base + axis], vert[axis]);
        bounds[base + 3 + axis] = Math.max(bounds[base + 3 + axis], vert[axis]);
      }
    }
  }

  /**
   * Build display lists for the world model using the leafs structure.
   * @private
   */
  _buildWorldModelDisplayLists(m: BrushModel): void {
    if (m.cmds !== null) {
      return;
    }

    const state = WorldRenderState.of(m);
    const leafs = m.leafTable;

    state.reset();
    m._resetScopedFaces();

    const cmds: number[] = [];
    const styles = [0.0, 0.0, 0.0, 0.0];
    const turbulentFallbackCache = new Map<string, number[]>();
    const turbulentFallbackAvgMap = this._buildTurbulentFallbackLightMap(m, turbulentFallbackCache);
    const precomputedVertices = new Set<number>();
    let verts = 0;
    let cutoff = 0;

    // Build opaque surfaces (non-sky, non-turbulent, non-translucent) organized by leaf
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if (texture.flags & (MaterialFlags.MF_SKY | MaterialFlags.MF_TURBULENT | MaterialFlags.MF_TRANSPARENT)) {
        continue;
      }
      for (let j = 0; j < leafs.count; j++) {
        const chain = [i, verts, 0];
        for (let k = 0; k < leafs.numMarkSurfaces[j]; k++) {
          const surf = m.faces[m.marksurfaces[leafs.firstMarkSurfaces[j] + k]];
          if (surf.texture !== i) {
            continue;
          }
          console.assert(surf.verts !== null && Array.isArray(surf.verts));
          this._expandLeafBoundsForSurface(state, j, surf.verts!);
          chain[2] += BrushModelRenderer.#pushOpaqueVertices(cmds, surf, styles, precomputedVertices);
        }
        if (chain[2] !== 0) {
          state.cmds[j].push(chain);
          state.skychains[j]++;
          state.waterchains[j]++;
          verts += chain[2];
        }
      }
    }

    // Build translucent surfaces (fences, glass): packed once and shared by the leafs that list them, for the reason
    // the liquids below are, and kept out of the per-leaf chains the opaque and shadow passes walk.
    const translucentFaceLeafs = BrushModelRenderer.#collectFaceLeafs(m, MaterialFlags.MF_TRANSPARENT, MaterialFlags.MF_SKY | MaterialFlags.MF_TURBULENT);
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if ((texture.flags & MaterialFlags.MF_TRANSPARENT) === 0 || (texture.flags & (MaterialFlags.MF_SKY | MaterialFlags.MF_TURBULENT)) !== 0) {
        continue;
      }
      for (const group of BrushModelRenderer.#groupFacesByLeafs(m, i, translucentFaceLeafs)) {
        const firstVertex = verts;
        const batchMins = new Vector(Infinity, Infinity, Infinity);
        const batchMaxs = new Vector(-Infinity, -Infinity, -Infinity);
        for (const faceIndex of group.faces) {
          const surf = m.faces[faceIndex];
          console.assert(surf.verts !== null && Array.isArray(surf.verts));
          for (const leaf of group.leafs) {
            this._expandLeafBoundsForSurface(state, leaf, surf.verts!);
          }
          this._expandBounds(batchMins, batchMaxs, surf.verts!);
          verts += BrushModelRenderer.#pushOpaqueVertices(cmds, surf, styles, precomputedVertices);
        }
        if (verts !== firstVertex) {
          const batch: WorldSurfaceBatch = { texture: i, firstVertex, vertexCount: verts - firstVertex, mins: batchMins, maxs: batchMaxs };
          for (const leaf of group.leafs) {
            state.transparentBatches[leaf].push(batch);
          }
        }
      }
    }

    cutoff = cmds.length;
    m.skychain = verts * 80;
    verts = 0;

    // Build sky surfaces
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if (!(texture.flags & MaterialFlags.MF_SKY)) {
        continue;
      }
      for (let j = 0; j < leafs.count; j++) {
        const chain = [verts, 0];
        for (let k = 0; k < leafs.numMarkSurfaces[j]; k++) {
          const surf = m.faces[m.marksurfaces[leafs.firstMarkSurfaces[j] + k]];
          if (surf.texture !== i) {
            continue;
          }
          console.assert(surf.verts !== null && Array.isArray(surf.verts));
          this._expandLeafBoundsForSurface(state, j, surf.verts!);
          chain[1] += surf.verts!.length;
          for (let l = 0; l < surf.verts!.length; l++) {
            const vert = surf.verts![l];
            cmds.push(vert[0], vert[1], vert[2]);
          }
        }
        if (chain[1] !== 0) {
          state.cmds[j].push(chain);
          state.waterchains[j]++;
          verts += chain[1];
        }
      }
    }
    m.waterchain = m.skychain + verts * 12;
    verts = 0;

    // Build turbulent surfaces (water, lava, slime). Quake lists a face in every leaf it borders, and a blended liquid
    // drawn once per listing leaf is blended over itself. So a face is packed once, in a batch with the faces of its
    // texture that the same leafs list, and each of those leafs refers to that batch: getWorldTurbulentChains draws it
    // once however many of them are visible. It cannot belong to one leaf only, the leaf on the other side may be the
    // only one the view sees (a map compiled without transparent water).
    const liquidFaceLeafs = BrushModelRenderer.#collectFaceLeafs(m, MaterialFlags.MF_TURBULENT, MaterialFlags.MF_NONE);
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if (!(texture.flags & MaterialFlags.MF_TURBULENT)) {
        continue;
      }
      for (const batch of BrushModelRenderer.#groupFacesByLeafs(m, i, liquidFaceLeafs)) {
        const chain = [i, verts, 0];
        const chainMins = new Vector(Infinity, Infinity, Infinity);
        const chainMaxs = new Vector(-Infinity, -Infinity, -Infinity);
        for (const faceIndex of batch.faces) {
          const surf = m.faces[faceIndex];
          styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
          for (let l = 0; l < surf.styles.length; l++) {
            styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
          }
          const hasLightmap = this._surfaceHasTurbulentLightmap(m, surf);
          console.assert(surf.verts !== null && Array.isArray(surf.verts));
          for (const leaf of batch.leafs) {
            this._expandLeafBoundsForSurface(state, leaf, surf.verts!);
          }
          this._expandBounds(chainMins, chainMaxs, surf.verts!);
          chain[2] += surf.verts!.length;
          for (let l = 0; l < surf.verts!.length; l++) {
            const vert = surf.verts![l];
            const posKey = `${Math.round(vert[0] * TURBULENT_FALLBACK_POS_QUANT)}|${Math.round(vert[1] * TURBULENT_FALLBACK_POS_QUANT)}|${Math.round(vert[2] * TURBULENT_FALLBACK_POS_QUANT)}`;
            const fallbackLight = hasLightmap ? [0.0, 0.0, 0.0] : (turbulentFallbackAvgMap.get(posKey) ?? [0.0, 0.0, 0.0]);
            const dlightTexCoordS = vert[5];
            const dlightTexCoordT = vert[6];
            cmds.push(vert[0], vert[1], vert[2]);
            cmds.push(vert[3], vert[4], dlightTexCoordS, dlightTexCoordT);
            cmds.push(styles[0], styles[1], styles[2], styles[3]);
            cmds.push(fallbackLight[0], fallbackLight[1], fallbackLight[2]);
            cmds.push(dlightTexCoordS, dlightTexCoordT, hasLightmap ? 1.0 : 0.0, 0.0, 0.0, 0.0);
          }
        }
        if (chain[2] !== 0) {
          const info: WorldSurfaceBatch = {
            texture: i,
            firstVertex: chain[1],
            vertexCount: chain[2],
            mins: chainMins,
            maxs: chainMaxs,
          };
          for (const leaf of batch.leafs) {
            state.cmds[leaf].push(chain);
            state.turbulentChains[leaf].push(info);
          }
          verts += chain[2];
        }
      }
    }

    Mesh.CalculateTangentBitangents(cmds, cutoff, precomputedVertices);

    m.cmds = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds as WebGLBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);

    m.opaqueVAO = this._createBrushVAO(m.cmds as WebGLBuffer, 0);
    m.turbulentVAO = this._createBrushVAO(m.cmds as WebGLBuffer, m.waterchain);
  }

  /**
   * Which leafs list each face of the world whose material has a flag.
   * @param flag The flag the material must have.
   * @param exclude Flags the material must not have.
   * @returns The leafs of every such face, by face index, in leaf order and without repeats.
   */
  static #collectFaceLeafs(model: BrushModel, flag: MaterialFlags, exclude: MaterialFlags): Map<number, number[]> {
    const leafs = model.leafTable;
    const faceLeafs = new Map<number, number[]>();

    for (let leaf = 0; leaf < leafs.count; leaf++) {
      for (let k = 0; k < leafs.numMarkSurfaces[leaf]; k++) {
        const faceIndex = model.marksurfaces[leafs.firstMarkSurfaces[leaf] + k];
        const texture = model.textures[model.faces[faceIndex].texture] as BaseMaterial;

        if ((texture.flags & flag) === 0 || (texture.flags & exclude) !== 0) {
          continue;
        }

        const listing = faceLeafs.get(faceIndex);

        if (listing === undefined) {
          faceLeafs.set(faceIndex, [leaf]);
        } else if (listing[listing.length - 1] !== leaf) {
          listing.push(leaf);
        }
      }
    }

    return faceLeafs;
  }

  /**
   * Writes the vertices of an opaque-layout surface (position, texture and lightmap coordinates, lightstyles, normal,
   * tangent and bitangent when the BSP has them).
   * @returns The number of vertices written.
   */
  static #pushOpaqueVertices(cmds: number[], surf: Face, styles: number[], precomputedVertices: Set<number>): number {
    styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
    for (let l = 0; l < surf.styles.length; l++) {
      styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
    }
    for (let l = 0; l < surf.verts!.length; l++) {
      const vert = surf.verts![l];
      const vertexIndex = cmds.length / Mesh.VERTEX_STRIDE;
      cmds.push(vert[0], vert[1], vert[2]);
      cmds.push(vert[3], vert[4], vert[5], vert[6]);
      cmds.push(styles[0], styles[1], styles[2], styles[3]);
      if (vert.length > 9) {
        cmds.push(vert[7], vert[8], vert[9]);
      } else {
        cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
      }
      if (vert.length > 15) {
        cmds.push(vert[10], vert[11], vert[12], vert[13], vert[14], vert[15]);
        precomputedVertices.add(vertexIndex);
      } else {
        cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      }
    }

    return surf.verts!.length;
  }

  /**
   * Groups the faces of one texture by the leafs that list them: the faces of a group are visible together,
   * so they are drawn as one batch.
   * @returns The groups, in the order their first face is listed.
   */
  static #groupFacesByLeafs(model: BrushModel, textureIndex: number, faceLeafs: Map<number, number[]>): { leafs: number[]; faces: number[] }[] {
    const groups = new Map<string, { leafs: number[]; faces: number[] }>();

    for (const [faceIndex, leafs] of faceLeafs) {
      if (model.faces[faceIndex].texture !== textureIndex) {
        continue;
      }

      const key = leafs.join(',');
      const group = groups.get(key);

      if (group === undefined) {
        groups.set(key, { leafs, faces: [faceIndex] });
      } else {
        group.faces.push(faceIndex);
      }
    }

    return [...groups.values()];
  }

  /** @private */
  _buildSurfaceDisplayList(model: BrushModel, face: Face): void {
    face.verts = [];
    if (face.numedges < 3) {
      return;
    }
    const texinfo = model.texinfo[face.texinfo];
    const texture = model.textures[texinfo.texture as number] as BaseMaterial;
    for (let i = 0; i < face.numedges; i++) {
      const index = model.surfedges[face.firstedge + i];
      let vec: Vector;
      if (index > 0) {
        vec = model.vertexes[model.edges[index][0]];
      } else {
        vec = model.vertexes[model.edges[-index][1]];
      }
      const vert: number[] = [vec[0], vec[1], vec[2]];
      if (!face.sky) {
        const s = vec.dot(new Vector(texinfo.vecs[0][0], texinfo.vecs[0][1], texinfo.vecs[0][2])) + texinfo.vecs[0][3];
        const t = vec.dot(new Vector(texinfo.vecs[1][0], texinfo.vecs[1][1], texinfo.vecs[1][2])) + texinfo.vecs[1][3];
        vert[3] = s / texture.width;
        vert[4] = t / texture.height;
        const lmshift = face.lmshift ?? 0;
        vert[5] = (s - face.texturemins[0] + (face.light_s << lmshift) + (1 << (lmshift - 1))) / (LIGHTMAP_BLOCK_SIZE * (1 << lmshift));
        vert[6] = (t - face.texturemins[1] + (face.light_t << lmshift) + (1 << (lmshift - 1))) / (LIGHTMAP_BLOCK_SIZE * (1 << lmshift));
      }
      // Carry precomputed BSPX FACENORMALS data (indices 7-9 normal, 10-12 tangent, 13-15
      // bitangent) so the display-list builders can use it instead of the flat face normal and
      // recomputed UV-derivative tangent/bitangent.
      if (face.vertexNormals) {
        const normal = face.vertexNormals[i];
        vert[7] = normal[0];
        vert[8] = normal[1];
        vert[9] = normal[2];
        if (face.vertexTangents && face.vertexBitangents) {
          const tangent = face.vertexTangents[i];
          const bitangent = face.vertexBitangents[i];
          vert[10] = tangent[0];
          vert[11] = tangent[1];
          vert[12] = tangent[2];
          vert[13] = bitangent[0];
          vert[14] = bitangent[1];
          vert[15] = bitangent[2];
        }
      }
      if (i >= 3) {
        face.verts.push(face.verts[0]);
        face.verts.push(face.verts[face.verts.length - 2]);
      }
      face.verts.push(vert);
    }
  }

  /**
   * Whether a surface has baked lightmap data available for turbulent sampling.
   * @private
   * @returns True when the surface carries valid lightmap data.
   */
  _surfaceHasTurbulentLightmap(model: BrushModel, face: Face): boolean {
    if (face.styles.length === 0 || face.lightofs < 0) {
      return false;
    }

    if (model.version === 38 && face.lightofs === 0) {
      return false;
    }

    return true;
  }

  /**
   * Build a cache key encoding the face and world-space sample position.
   * @private
   * @returns A string key for the turbulent fallback light cache.
   */
  _getTurbulentFallbackCacheKey(face: Face, worldPos: Vector): string {
    return [
      face.texture,
      Math.round(face.normal[0] * 1024.0),
      Math.round(face.normal[1] * 1024.0),
      Math.round(face.normal[2] * 1024.0),
      Math.round(worldPos[0] * 16.0),
      Math.round(worldPos[1] * 16.0),
      Math.round(worldPos[2] * 16.0),
    ].join('|');
  }

  /**
   * Pre-compute a position-keyed map of averaged turbulent fallback lights.
   * Vertices at the same world position are averaged across all faces sharing that position,
   * eliminating seams at BSP face boundaries caused by per-face light discontinuities.
   *
   * A per-model ambient floor is derived from the mean of every vertex that did find nearby lit
   * geometry, then applied as a per-channel minimum to every entry. This keeps vertices whose
   * probes found nothing (e.g. the middle of a large lake, where every nearby probe just re-hits
   * more lightmap-less water) from collapsing to black, while leaving already-lit vertices alone.
   * @private
   * @returns Map from quantized position key to averaged RGB fallback light.
   */
  _buildTurbulentFallbackLightMap(m: BrushModel, cache: Map<string, number[]>): Map<string, number[]> {
    const accumMap = new Map<string, {r: number; g: number; b: number; n: number}>();
    const modelAverage = {r: 0, g: 0, b: 0, n: 0};

    for (const surf of m.facesIter()) {
      const texture = m.textures[surf.texture] as BaseMaterial;
      if (!(texture.flags & MaterialFlags.MF_TURBULENT)) {
        continue;
      }
      if (!surf.verts || surf.verts.length === 0) {
        continue;
      }
      if (this._surfaceHasTurbulentLightmap(m, surf)) {
        continue;
      }
      for (let k = 0; k < surf.verts.length; k++) {
        const vert = surf.verts[k];
        const posKey = `${Math.round(vert[0] * TURBULENT_FALLBACK_POS_QUANT)}|${Math.round(vert[1] * TURBULENT_FALLBACK_POS_QUANT)}|${Math.round(vert[2] * TURBULENT_FALLBACK_POS_QUANT)}`;
        const light = this._getTurbulentFallbackLight(m, surf, new Vector(vert[0], vert[1], vert[2]), cache);
        const existing = accumMap.get(posKey);
        if (existing !== undefined) {
          existing.r += light[0];
          existing.g += light[1];
          existing.b += light[2];
          existing.n++;
        } else {
          accumMap.set(posKey, {r: light[0], g: light[1], b: light[2], n: 1});
        }
        if (light[0] > 0.0 || light[1] > 0.0 || light[2] > 0.0) {
          modelAverage.r += light[0];
          modelAverage.g += light[1];
          modelAverage.b += light[2];
          modelAverage.n++;
        }
      }
    }

    const floor = modelAverage.n > 0
      ? [
        modelAverage.r / modelAverage.n * TURBULENT_FALLBACK_FLOOR_FRACTION,
        modelAverage.g / modelAverage.n * TURBULENT_FALLBACK_FLOOR_FRACTION,
        modelAverage.b / modelAverage.n * TURBULENT_FALLBACK_FLOOR_FRACTION,
      ]
      : [TURBULENT_FALLBACK_DEFAULT_FLOOR, TURBULENT_FALLBACK_DEFAULT_FLOOR, TURBULENT_FALLBACK_DEFAULT_FLOOR];

    const avgMap = new Map<string, number[]>();
    for (const [key, accum] of accumMap) {
      avgMap.set(key, [
        Math.max(accum.r / accum.n, floor[0]),
        Math.max(accum.g / accum.n, floor[1]),
        Math.max(accum.b / accum.n, floor[2]),
      ]);
    }
    return avgMap;
  }

  /**
   * Sample turbulent fallback light at an arbitrary world-space position.
   * @private
   * @returns RGB fallback light values at the given position.
   */
  _getTurbulentFallbackLight(model: BrushModel, face: Face, worldPos: Vector, cache: Map<string, number[]> | null = null): number[] {
    if (model.submodel || clientRuntimeState.worldmodel === null) {
      return [1.0, 1.0, 1.0];
    }

    if (cache !== null) {
      const cacheKey = this._getTurbulentFallbackCacheKey(face, worldPos);
      const cachedLight = cache.get(cacheKey);

      if (cachedLight) {
        return cachedLight;
      }

      // eslint-disable-next-line @typescript-eslint/unbound-method
      const fallbackLight = BrushModelRenderer.sampleTurbulentFallbackLight(model, face, worldPos, LightSampler.LightPoint);
      cache.set(cacheKey, fallbackLight);
      return fallbackLight;
    }

      // eslint-disable-next-line @typescript-eslint/unbound-method
    return BrushModelRenderer.sampleTurbulentFallbackLight(model, face, worldPos, LightSampler.LightPoint);
  }
}
