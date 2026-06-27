import Vector from '../../../shared/Vector.ts';
import { ModelRenderer, type ShadowRenderContext } from './ModelRenderer.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import GL, { type GLProgramInfo, ATTRIB_LOCATIONS, BRUSH_VERTEX_STRIDE } from '../GL.ts';
import { getEntityBloomEmissiveScale } from './BloomEffect.ts';
import { MaterialFlags, type BaseMaterial } from './Materials.ts';
import { BrushModel, type Node, type FogVolumeInfo, type WorldTurbulentChainInfo } from '../../common/model/BSP.ts';
import type { Face, BaseModel } from '../../common/model/BaseModel.ts';
import type { ClientEdict } from '../ClientEntities.ts';
import Mesh from './Mesh.ts';
import PostProcess from './PostProcess.ts';
import * as Def from '../../common/Def.ts';
import { content } from '../../../shared/Defs.ts';

let { CL, Host, R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Host, R } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

// Lightmap atlas configuration
// LIGHTMAP_BLOCK_SIZE defines the width and height of each lightmap layer.
// The lightmap is stored as a TEXTURE_2D_ARRAY with 3 layers (R, G, B).
// Each layer is LIGHTMAP_BLOCK_SIZE x LIGHTMAP_BLOCK_SIZE pixels in RGBA8,
// where the 4 RGBA channels carry the 4 lightstyle intensities.
// LIGHTMAP_BLOCK_HEIGHT = LIGHTMAP_BLOCK_SIZE * 4 is the RGBA byte stride per row,
// used internally for CPU-side lightmap data indexing.
export const LIGHTMAP_BLOCK_SIZE = 2048;
export const LIGHTMAP_BLOCK_HEIGHT = LIGHTMAP_BLOCK_SIZE * 4; // RGBA byte stride per row

const TURBULENT_FALLBACK_NORMAL_OFFSET = 2.0;
const TURBULENT_FALLBACK_LATERAL_OFFSET = 12.0;
const TURBULENT_FALLBACK_NEIGHBOR_COUNT = 6;
const TURBULENT_FALLBACK_NEIGHBOR_GAIN = 1.4;
const TURBULENT_FALLBACK_MAX_BOOST = 1.3;
const TURBULENT_FALLBACK_SCALE = 0.0078125;
const TURBULENT_FALLBACK_EPSILON = 0.0001;
// Position quantization factor for the vertex-light averaging map (1/16 Quake unit precision).
const TURBULENT_FALLBACK_POS_QUANT = 16.0;

/**
 * @param strength Requested brush bloom contribution strength.
 * @returns Sanitized non-negative bloom contribution strength.
 */
export function resolveBrushBloomContributionStrength(strength: number): number {
  return Number.isFinite(strength) && strength > 0.0 ? strength : 0.0;
}

/** Internal data held per fog volume light probe. */
interface FogLightProbeData {
  texture: WebGLTexture;
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
  #fogLightProbeWhite: WebGLTexture | null = null;

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

  /** Active 'turbulent' program during world turbulent pass. */
  _worldTurbulentProgram: GLProgramInfo | null = null;

  /** World model associated with the current turbulent pass. */
  _worldTurbulentModel: BrushModel | null = null;

  /** Active 'fog-volume' program during fog volume pass. */
  _fogVolumeProgram: GLProgramInfo | null = null;

  // ─── Static methods ───────────────────────────────────────────────

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
   * @param sampleLightPoint Light sampler callback from R.LightPoint.
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

      if ((material.flags & MaterialFlags.MF_TRANSPARENT) !== 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Render a single brush model entity.
   * Handles frustum culling, transforms, lighting, and both opaque and turbulent surfaces.
   * @param pass Rendering pass (0=opaque, 1=turbulent, 2=transparent)
   */
  render(model: BaseModel, entity: ClientEdict, pass = 0): void {
    const clmodel = model as BrushModel;
    const e = entity;

    // Check if this is the world entity (entity 0)
    if (e === CL.state.clientEntities.getEntity(0)) {
      if (pass === 0) {
        this.renderWorld(clmodel);
      } else if (pass === 1 && R.drawturbulents.value) {
        this.renderWorldTurbolents(clmodel);
      } else if (pass === 2) {
        this.renderWorldTransparent(clmodel);
      }
      return;
    }

    // Regular brush entity — frustum cull
    if (clmodel.submodel) {
      if (R.CullBox(
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
      if (R.CullBox(
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
      R.c_brush_vbos++;
      this._renderOpaqueSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    } else if (pass === 1 && R.drawturbulents.value) {
      GL.BindVAO(clmodel.turbulentVAO!);
      R.c_brush_vbos++;
      this._renderTurbulentSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    } else if (pass === 2) {
      GL.BindVAO(clmodel.opaqueVAO!);
      R.c_brush_vbos++;
      this._renderTransparentSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    }
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
    const worldspawn = CL.state.clientEntities.getEntity(0);

    GL.BindVAO(clmodel.opaqueVAO!);
    R.c_brush_vbos++;

    const program = GL.UseProgram('brush')!;
    gl.uniform3f(program.uAmbientLight!, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha!, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale!, 0.0);
    gl.uniform1f(program.uBloomDlightScale!, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));
    gl.uniform1f(program.uInterpolation!, R.GetTextureInterpolation());
    gl.uniform1f(program.uLightstyleInterpolation!, R.GetLightstyleInterpolation());
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform4f(program.uLightVec!, 0.0, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicLightVec!, 0.0, 0.0, 0.0);

    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA!, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB!, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];

      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }

      if (R.CullBox(leaf.mins!, leaf.maxs!)) {
        continue;
      }

      for (let j = 0; j < leaf.skychain; j++) {
        const cmds = leaf.cmds[j];
        const material = clmodel.textures[cmds[0]] as BaseMaterial;

        if (material.flags & MaterialFlags.MF_SKIP) {
          continue;
        }

        if (material.flags & MaterialFlags.MF_TRANSPARENT) {
          continue;
        }

        R.c_brush_verts += cmds[2];
        R.c_brush_tris += cmds[2] / 3;

        material.emit(worldspawn);
        material.bindTo(program);

        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
        R.c_brush_draws++;
      }
    }

    GL.UnbindVAO();
  }

  /**
   * Render the world (entity 0) transparent surfaces with alpha blending.
   */
  renderWorldTransparent(clmodel: BrushModel): void {
    this.beginWorldTransparentPass(clmodel);
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }
      if (R.CullBox(leaf.mins!, leaf.maxs!)) {
        continue;
      }
      this.renderWorldTransparentLeaf(clmodel, leaf);
    }
    this.endWorldTransparentPass();
  }

  /**
   * Collect visible world leafs that contain transparent surfaces, with
   * squared distance from the given viewpoint for back-to-front sorting.
   * @returns Leaf entries with squared view distances for back-to-front sorting.
   */
  getWorldTransparentLeaves(clmodel: BrushModel, vieworg: Float32Array | number[]): { leaf: Node; dist: number }[] {
    const items: { leaf: Node; dist: number }[] = [];
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }
      if (R.CullBox(leaf.mins!, leaf.maxs!)) {
        continue;
      }
      let hasTransparent = false;
      for (let j = 0; j < leaf.skychain; j++) {
        if ((clmodel.textures[leaf.cmds[j][0]] as BaseMaterial).flags & MaterialFlags.MF_TRANSPARENT) {
          hasTransparent = true;
          break;
        }
      }
      if (!hasTransparent) {
        continue;
      }
      const dist = this._getBoundsDistanceToView(leaf.mins!, leaf.maxs!, vieworg);
      items.push({ leaf, dist });
    }
    return items;
  }

  /**
   * Setup GL state for world transparent leaf rendering.
   * Call once before one or more `renderWorldTransparentLeaf` calls.
   */
  beginWorldTransparentPass(clmodel: BrushModel): void {
    GL.BindVAO(clmodel.opaqueVAO!);
    R.c_brush_vbos++;

    const program = GL.UseProgram('brush')!;
    this._worldTransparentProgram = program;
    this._worldTransparentModel = clmodel;

    gl.uniform3f(program.uAmbientLight!, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicShadeLight!, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha!, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale!, 0.0);
    gl.uniform1f(program.uBloomDlightScale!, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));
    gl.uniform1f(program.uInterpolation!, R.GetTextureInterpolation());
    gl.uniform1f(program.uLightstyleInterpolation!, R.GetLightstyleInterpolation());
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform4f(program.uLightVec!, 0.0, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicLightVec!, 0.0, 0.0, 0.0);

    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA!, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB!, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Render a single leaf's transparent surfaces.
   * Must be called between `beginWorldTransparentPass` and `endWorldTransparentPass`.
   */
  renderWorldTransparentLeaf(clmodel: BrushModel, leaf: Node): void {
    const worldspawn = CL.state.clientEntities.getEntity(0);
    const program = this._worldTransparentProgram!;

    for (let j = 0; j < leaf.skychain; j++) {
      const cmds = leaf.cmds[j];
      const material = clmodel.textures[cmds[0]] as BaseMaterial;

      if (material.flags & MaterialFlags.MF_SKIP) {
        continue;
      }
      if (!(material.flags & MaterialFlags.MF_TRANSPARENT)) {
        continue;
      }

      R.c_brush_verts += cmds[2];
      R.c_brush_tris += cmds[2] / 3;

      material.emit(worldspawn);
      material.bindTo(program);

      gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
      R.c_brush_draws++;
    }
  }

  /** Cleanup GL state after world transparent leaf rendering. */
  endWorldTransparentPass(): void {
    gl.disable(gl.BLEND);
    GL.UnbindVAO();
    this._worldTransparentProgram = null;
    this._worldTransparentModel = null;
  }

  // ─── World turbulent rendering ────────────────────────────────────

  /**
   * Render the world (entity 0) turbulent surfaces.
   * Note: method name preserves original typo for API compatibility.
   */
  renderWorldTurbolents(clmodel: BrushModel): void {
    this.beginWorldTurbulentPass(clmodel);
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins!, leaf.maxs!)) {
        continue;
      }
      this.renderWorldTurbulentLeaf(clmodel, leaf);
    }
    this.endWorldTurbulentPass();
  }

  /**
   * Collect visible world leafs that contain turbulent surfaces, sorted by
   * distance from the given viewpoint (farthest first).
   * @returns Leaf entries with view distances for farthest-first rendering.
   */
  getWorldTurbulentLeaves(clmodel: BrushModel, vieworg: Float32Array | number[]): { leaf: Node; dist: number }[] {
    const items: { leaf: Node; dist: number }[] = [];
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins!, leaf.maxs!)) {
        continue;
      }
      const dist = this._getBoundsDistanceToView(leaf.mins!, leaf.maxs!, vieworg);
      items.push({ leaf, dist });
    }
    return items;
  }

  /**
   * Collect visible world turbulent draw batches with tight bounds so fog and
   * semi-transparent liquids can share the same sorted space.
   * @returns Turbulent chain entries with view distances for back-to-front sorting.
   */
  getWorldTurbulentChains(clmodel: BrushModel, vieworg: Float32Array | number[]): { chain: WorldTurbulentChainInfo; dist: number }[] {
    const items: { chain: WorldTurbulentChainInfo; dist: number }[] = [];

    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins!, leaf.maxs!)) {
        continue;
      }

      for (let j = 0; j < leaf.turbulentChains.length; j++) {
        const chain = leaf.turbulentChains[j];
        if (R.CullBox(chain.mins!, chain.maxs!)) {
          continue;
        }

        items.push({
          chain,
          dist: this._getBoundsDistanceToView(chain.mins!, chain.maxs!, vieworg),
        });
      }
    }

    return items;
  }

  /**
   * Setup GL state for world turbulent leaf rendering.
   * Call once before one or more `renderWorldTurbulentLeaf` calls.
   */
  beginWorldTurbulentPass(clmodel: BrushModel): void {
    GL.BindVAO(clmodel.turbulentVAO!);
    R.c_brush_vbos++;

    const program = GL.UseProgram('turbulent')!;
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform1f(program.uTime!, Host.realtime);
    gl.uniform1f(program.uInterpolation!, R.GetTextureInterpolation());
    gl.uniform1f(program.uLightstyleInterpolation!, R.GetLightstyleInterpolation());
    gl.uniform1f(program.uBloomEmissiveScale!, 0.0);
    gl.uniform1f(program.uBloomDlightScale!, R.bloomDlightStrength.value);

    const cameraInside = R.viewleaf !== null && R.viewleaf.contents <= content.CONTENT_WATER ? 1.0 : 0.0;
    gl.uniform1f(program.uCameraInside!, cameraInside);

    if (PostProcess.active) {
      PostProcess.beginDepthSampling();
      GL.Bind(program.tDepth!, PostProcess.depthTexture);
      gl.uniform2f(program.uScreenSize!, PostProcess.width, PostProcess.height);
      // Per-surface alpha decides whether depth fog is active.
      gl.uniform1f(program.uWaterFogDensity!, 0.0);
    } else {
      GL.Bind(program.tDepth!, R.null_texture);
      gl.uniform1f(program.uWaterFogDensity!, 0.0);
    }

    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA!, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB!, R.lightstyle_texture_b);

    this._worldTurbulentProgram = program;
    this._worldTurbulentModel = clmodel;
  }

  /**
   * Render a single leaf's turbulent surfaces.
   * Must be called between `beginWorldTurbulentPass` and `endWorldTurbulentPass`.
   */
  renderWorldTurbulentLeaf(clmodel: BrushModel, leaf: Node): void {
    for (let j = leaf.waterchain; j < leaf.cmds.length; j++) {
      const cmds = leaf.cmds[j];
      this._renderWorldTurbulentBatch(clmodel, cmds[0], cmds[1], cmds[2]);
    }
  }

  /**
   * Render a single pre-sorted world turbulent draw batch.
   * Must be called between `beginWorldTurbulentPass` and `endWorldTurbulentPass`.
   */
  renderWorldTurbulentChain(clmodel: BrushModel, chain: WorldTurbulentChainInfo): void {
    this._renderWorldTurbulentBatch(clmodel, chain.texture, chain.firstVertex, chain.vertexCount);
  }

  /** Cleanup GL state after world turbulent leaf rendering. */
  endWorldTurbulentPass(): void {
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    GL.UnbindVAO();
    if (PostProcess.active) {
      // Unbind depthTexture from its sampler unit before reattaching it to the
      // FBO. The turbulent shader leaves depthTexture bound to unit 7 (tDepth).
      // The brush shader also uses unit 7 (tSpecular), and QuakeMaterial.bindTo
      // does not rebind that slot — leaving depthTexture simultaneously attached
      // as the FBO depth and sampled as tSpecular, which is a feedback loop.
      GL.Bind(this._worldTurbulentProgram!.tDepth as number, R.null_texture);
      PostProcess.endDepthSampling();
    }
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
    R.c_brush_vbos++;

    // World model is always at the origin with identity rotation.
    gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);
    gl.uniform1f(program.uTime!, Host.realtime);

    for (const leaf of clmodel.leafs) {
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      for (let j = leaf.waterchain; j < leaf.cmds.length; j++) {
        const cmd = leaf.cmds[j];
        gl.drawArrays(gl.TRIANGLES, cmd[1], cmd[2]);
        R.c_brush_verts += cmd[2];
      }
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

    PostProcess.beginDepthSampling();

    const program = GL.UseProgram('fog-volume')!;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.cullFace(gl.BACK);
    gl.enable(gl.CULL_FACE);

    GL.Bind(program.tDepth!, PostProcess.depthTexture);
    gl.uniform2f(program.uScreenSize!, PostProcess.width, PostProcess.height);

    this._fogVolumeProgram = program;
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
    // _getFogLightProbe / _getFogLightProbeWhite may upload via Bind3D(0, ...)
    // which clobbers texture unit 0 (tDepth). Re-bind depth after.
    const probe = this._getFogLightProbe(fogVolume);
    GL.Bind3D(program.tLightProbe!, probe ? probe.texture : this._getFogLightProbeWhite());
    GL.Bind(program.tDepth!, PostProcess.depthTexture);

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
      R.c_brush_vbos++;

      gl.drawArrays(gl.TRIANGLES, 0, 36);
      gl.bindVertexArray(null);
      R.c_brush_draws++;
    } else {
      const submodel = worldmodel.submodels[fogVolume.modelIndex - 1];

      if (!submodel || !submodel.cmds) {
        return;
      }

      gl.uniform3f(program.uOrigin!, 0.0, 0.0, 0.0);
      gl.uniformMatrix3fv(program.uAngles!, false, GL.identity);

      gl.bindBuffer(gl.ARRAY_BUFFER, submodel.cmds as WebGLBuffer);
      R.c_brush_vbos++;
      gl.vertexAttribPointer(program.aPosition!.location as number, 3, gl.FLOAT, false, 80, 0);

      if (submodel.chains) {
        for (const chain of submodel.chains) {
          gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
          R.c_brush_draws++;
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

    // Unbind depthTexture from its sampler unit before reattaching it to the FBO,
    // for the same reason as endWorldTurbulentPass (feedback loop prevention).
    GL.Bind(this._fogVolumeProgram!.tDepth as number, R.null_texture);
    PostProcess.endDepthSampling();
    this._fogVolumeProgram = null;
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
    if (model.opaqueVAO) {
      gl.deleteVertexArray(model.opaqueVAO as WebGLVertexArrayObject);
      model.opaqueVAO = null;
    }
    if (model.turbulentVAO) {
      gl.deleteVertexArray(model.turbulentVAO as WebGLVertexArrayObject);
      model.turbulentVAO = null;
    }
    if (model.cmds) {
      gl.deleteBuffer(model.cmds as WebGLBuffer);
      model.cmds = null;
    }

    if (model.fogVolumes && model.fogVolumes.length > 0) {
      this._freeFogLightProbes();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────

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
    const worldspawn = CL.state.clientEntities.getEntity(0);
    const program = this._worldTurbulentProgram!;
    const material = clmodel.textures[textureIndex] as BaseMaterial;

    material.emit(worldspawn);
    const alpha = this._getTurbulentMaterialAlpha(material, worldspawn);
    this._setTurbulentSurfaceState(alpha);
    gl.uniform1f(program.uAlpha!, alpha);
    // Only apply depth fog to translucent liquids when the map has opted in via
    // _qs_waterfog. Opaque turbulents rely on PVS and should not get absorption.
    const waterfogEnabled = CL.state.worldmodel?.worldspawnInfo._qs_waterfog === '1';
    gl.uniform1f(program.uWaterFogDensity!, PostProcess.active && alpha < 1.0 && waterfogEnabled ? 0.01 : 0.0);

    R.c_brush_verts += vertexCount;
    R.c_brush_tris += vertexCount / 3;
    material.bindTo(program);
    gl.drawArrays(gl.TRIANGLES, firstVertex, vertexCount);
    R.c_brush_draws++;
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
   * Opaque liquids must write depth so they occlude later fog/transparent passes.
   * @private
   */
  _setTurbulentSurfaceState(alpha: number): void {
    if (alpha >= 1.0) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      return;
    }

    gl.enable(gl.BLEND);
    gl.depthMask(false);
  }

  /** @private */
  _setupBrushShaderCommon(program: GLProgramInfo, clmodel: BrushModel, isWorld: boolean): void {
    if ((R.fullbright.value !== 0) || (clmodel.lightdata === null && clmodel.lightdata_rgb === null)) {
      GL.BindArray(program.tLightmap!, R.fullbright_texture);
    } else {
      GL.BindArray(program.tLightmap!, R.lightmap_texture);
    }

    if (R.flashblend.value === 0 && (isWorld || clmodel.submodel)) {
      GL.Bind(program.tDlight!, R.dlightmap_rgba_texture);
    } else {
      GL.Bind(program.tDlight!, R.null_texture);
    }

    if (program.tShadowMap0 !== undefined && R.shadow_textures?.[0]) {
      GL.Bind(program.tShadowMap0!, R.shadow_textures[0]);
    }
    if (program.tShadowMap1 !== undefined && R.shadow_textures?.[1]) {
      GL.Bind(program.tShadowMap1!, R.shadow_textures[1]);
    }
    if (program.tShadowMap2 !== undefined && R.shadow_textures?.[2]) {
      GL.Bind(program.tShadowMap2!, R.shadow_textures[2]);
    }

    if (program.tPointShadowMap !== undefined) {
      GL.BindCube(program.tPointShadowMap!, R.point_shadow_texture!);
    }
  }

  /** @private */
  _renderOpaqueSurfaces(clmodel: BrushModel, e: ClientEdict, viewMatrix: number[]): void {
    const program = GL.UseProgram('brush')!;
    this._applyEntityLighting(program, clmodel, e);

    gl.uniform3fv(program.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, viewMatrix);
    gl.uniform1f(program.uInterpolation!, R.GetTextureInterpolation());
    gl.uniform1f(program.uLightstyleInterpolation!, R.GetLightstyleInterpolation());
    gl.uniform1f(program.uAlpha!, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale!, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));

    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA!, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB!, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    if (!clmodel.chains || clmodel.chains.length === 0) {
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]] as BaseMaterial;

      if ((material.flags & (MaterialFlags.MF_TURBULENT | MaterialFlags.MF_TRANSPARENT | MaterialFlags.MF_SKIP)) !== 0) {
        continue;
      }

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;

      material.emit(e);
      material.bindTo(program);

      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }
  }

  /** @private */
  _renderTransparentSurfaces(clmodel: BrushModel, e: ClientEdict, viewMatrix: number[]): void {
    const program = GL.UseProgram('brush')!;
    this._applyEntityLighting(program, clmodel, e);

    gl.uniform3fv(program.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, viewMatrix);
    gl.uniform1f(program.uInterpolation!, R.GetTextureInterpolation());
    gl.uniform1f(program.uLightstyleInterpolation!, R.GetLightstyleInterpolation());
    gl.uniform1f(program.uAlpha!, e.alpha);
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale!, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale!, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));

    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA!, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB!, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (!clmodel.chains || clmodel.chains.length === 0) {
      gl.disable(gl.BLEND);
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]] as BaseMaterial;

      if (material.flags & MaterialFlags.MF_SKIP) {
        continue;
      }

      if (e.alpha === 1.0 && (
        (material.flags & MaterialFlags.MF_TURBULENT) || !(material.flags & MaterialFlags.MF_TRANSPARENT)
      )) {
        continue;
      }

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;

      material.emit(e);
      material.bindTo(program);

      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }

    gl.disable(gl.BLEND);
  }

  /** @private */
  _renderTurbulentSurfaces(clmodel: BrushModel, e: ClientEdict, viewMatrix: number[]): void {
    const program = GL.UseProgram('turbulent')!;
    gl.uniform3fv(program.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, viewMatrix);
    gl.uniform1f(program.uTime!, Host.realtime % (Math.PI * 2.0));
    gl.uniform1f(program.uInterpolation!, R.GetTextureInterpolation());
    gl.uniform1f(program.uLightstyleInterpolation!, R.GetLightstyleInterpolation());
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale!, R.bloomDlightStrength.value);

    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA!, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB!, R.lightstyle_texture_b);

    if (!clmodel.chains || clmodel.chains.length === 0) {
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

      material.emit(e);
      const alpha = this._getTurbulentMaterialAlpha(material, e);
      this._setTurbulentSurfaceState(alpha);
      gl.uniform1f(program.uAlpha!, alpha);
      material.bindTo(program);

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /** @private */
  _applyEntityLighting(program: GLProgramInfo, clmodel: BrushModel, entity: ClientEdict): void {
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      clmodel,
      entity,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      R._CalculateLightValues,
      CL.state.worldmodel as BrushModel | null,
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

  /** @private */
  _bindBrushDeluxemap(program: GLProgramInfo, clmodel: BrushModel): void {
    if (BrushModelRenderer.usesDeluxemap(clmodel, CL.state.worldmodel as BrushModel | null)) {
      GL.BindArray(program.tDeluxemap!, R.deluxemap_texture);
      gl.uniform1f(program.uHaveDeluxemap!, 1.0);
      return;
    }

    GL.BindArray(program.tDeluxemap!, R.normal_up_texture);
    gl.uniform1f(program.uHaveDeluxemap!, 0.0);
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
  _getFogLightProbeWhite(): WebGLTexture {
    if (this.#fogLightProbeWhite) {
      return this.#fogLightProbeWhite;
    }

    this.#fogLightProbeWhite = gl.createTexture()!;
    GL.Bind3D(0, this.#fogLightProbeWhite);
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

          const [color] = R.LightPoint(worldPos);

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
      GL.Bind3D(0, existing.texture);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, existing.resX, existing.resY, existing.resZ, gl.RGBA, gl.UNSIGNED_BYTE, existing.data);
      return existing;
    }

    const res = BrushModelRenderer.FOG_LIGHT_PROBE_RES;
    const resX = res;
    const resY = res;
    const resZ = res;
    const data = new Uint8Array(resX * resY * resZ * 4);

    this._sampleFogLightProbe(fogVolume, data, resX, resY, resZ);

    const texture = gl.createTexture()!;
    GL.Bind3D(0, texture);
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
    const worldmodel = CL.state.worldmodel as BrushModel | null;
    if (!worldmodel || (worldmodel.lightdata === null && worldmodel.lightdata_rgb === null)) {
      return null;
    }

    const styleFrame = Math.floor(CL.state.time * 10.0);
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
        gl.deleteTexture(texture);
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
    const dlights = CL.state.clientEntities.dlights;

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
    let verts = 0;
    let cutoff = 0;
    m.chains = [];

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
          cmds.push(vert[0], vert[1], vert[2]);
          cmds.push(vert[3], vert[4], vert[5], vert[6]);
          cmds.push(styles[0], styles[1], styles[2], styles[3]);
          cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
          cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
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

    Mesh.CalculateTangentBitangents(cmds, cutoff);

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
      if (vert[0] < mins[0]) { mins[0] = vert[0]; }
      if (vert[1] < mins[1]) { mins[1] = vert[1]; }
      if (vert[2] < mins[2]) { mins[2] = vert[2]; }
      if (vert[0] > maxs[0]) { maxs[0] = vert[0]; }
      if (vert[1] > maxs[1]) { maxs[1] = vert[1]; }
      if (vert[2] > maxs[2]) { maxs[2] = vert[2]; }
    }
  }

  /**
   * Expand a leaf's bounding box to contain all vertices of a surface.
   * @private
   */
  _expandLeafBoundsForSurface(leaf: Node, verts: number[][]): void {
    this._expandBounds(leaf.mins!, leaf.maxs!, verts);
  }

  /**
   * Build display lists for the world model using the leafs structure.
   * @private
   */
  _buildWorldModelDisplayLists(m: BrushModel): void {
    if (m.cmds !== null) {
      return;
    }

    m.resetWorldRenderState();

    const cmds: number[] = [];
    const styles = [0.0, 0.0, 0.0, 0.0];
    const turbulentFallbackCache = new Map<string, number[]>();
    const turbulentFallbackAvgMap = this._buildTurbulentFallbackLightMap(m, turbulentFallbackCache);
    let verts = 0;
    let cutoff = 0;

    // Build opaque surfaces (non-sky, non-turbulent) organized by leaf
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if ((texture.flags & MaterialFlags.MF_SKY) || (texture.flags & MaterialFlags.MF_TURBULENT)) {
        continue;
      }
      for (let j = 0; j < m.leafs.length; j++) {
        const leaf = m.leafs[j];
        const chain = [i, verts, 0];
        for (let k = 0; k < leaf.nummarksurfaces; k++) {
          const surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
          if (surf.texture !== i) {
            continue;
          }
          styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
          for (let l = 0; l < surf.styles.length; l++) {
            styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
          }
          console.assert(surf.verts !== null && Array.isArray(surf.verts));
          this._expandLeafBoundsForSurface(leaf, surf.verts!);
          chain[2] += surf.verts!.length;
          for (let l = 0; l < surf.verts!.length; l++) {
            const vert = surf.verts![l];
            cmds.push(vert[0], vert[1], vert[2]);
            cmds.push(vert[3], vert[4], vert[5], vert[6]);
            cmds.push(styles[0], styles[1], styles[2], styles[3]);
            cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
            cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
          }
        }
        if (chain[2] !== 0) {
          leaf.cmds.push(chain);
          leaf.skychain++;
          leaf.waterchain++;
          verts += chain[2];
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
      for (let j = 0; j < m.leafs.length; j++) {
        const leaf = m.leafs[j];
        const chain = [verts, 0];
        for (let k = 0; k < leaf.nummarksurfaces; k++) {
          const surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
          if (surf.texture !== i) {
            continue;
          }
          console.assert(surf.verts !== null && Array.isArray(surf.verts));
          this._expandLeafBoundsForSurface(leaf, surf.verts!);
          chain[1] += surf.verts!.length;
          for (let l = 0; l < surf.verts!.length; l++) {
            const vert = surf.verts![l];
            cmds.push(vert[0], vert[1], vert[2]);
          }
        }
        if (chain[1] !== 0) {
          leaf.cmds.push(chain);
          leaf.waterchain++;
          verts += chain[1];
        }
      }
    }
    m.waterchain = m.skychain + verts * 12;
    verts = 0;

    // Build turbulent surfaces (water, lava, slime)
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i] as BaseMaterial;
      if (!(texture.flags & MaterialFlags.MF_TURBULENT)) {
        continue;
      }
      for (let j = 0; j < m.leafs.length; j++) {
        const leaf = m.leafs[j];
        const chain = [i, verts, 0];
        const chainMins = new Vector(Infinity, Infinity, Infinity);
        const chainMaxs = new Vector(-Infinity, -Infinity, -Infinity);
        for (let k = 0; k < leaf.nummarksurfaces; k++) {
          const surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
          if (surf.texture !== i) {
            continue;
          }
          styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
          for (let l = 0; l < surf.styles.length; l++) {
            styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
          }
          const hasLightmap = this._surfaceHasTurbulentLightmap(m, surf);
          console.assert(surf.verts !== null && Array.isArray(surf.verts));
          this._expandLeafBoundsForSurface(leaf, surf.verts!);
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
          leaf.cmds.push(chain);
          leaf.turbulentChains.push({
            texture: i,
            firstVertex: chain[1],
            vertexCount: chain[2],
            mins: chainMins,
            maxs: chainMaxs,
          });
          verts += chain[2];
        }
      }
    }

    Mesh.CalculateTangentBitangents(cmds, cutoff);

    m.cmds = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds as WebGLBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);

    m.opaqueVAO = this._createBrushVAO(m.cmds as WebGLBuffer, 0);
    m.turbulentVAO = this._createBrushVAO(m.cmds as WebGLBuffer, m.waterchain);
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
   * @private
   * @returns Map from quantized position key to averaged RGB fallback light.
   */
  _buildTurbulentFallbackLightMap(m: BrushModel, cache: Map<string, number[]>): Map<string, number[]> {
    const accumMap = new Map<string, {r: number; g: number; b: number; n: number}>();

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
      }
    }

    const avgMap = new Map<string, number[]>();
    for (const [key, accum] of accumMap) {
      avgMap.set(key, [accum.r / accum.n, accum.g / accum.n, accum.b / accum.n]);
    }
    return avgMap;
  }

  /**
   * Sample turbulent fallback light at an arbitrary world-space position.
   * @private
   * @returns RGB fallback light values at the given position.
   */
  _getTurbulentFallbackLight(model: BrushModel, face: Face, worldPos: Vector, cache: Map<string, number[]> | null = null): number[] {
    if (model.submodel || CL.state.worldmodel === null) {
      return [1.0, 1.0, 1.0];
    }

    if (cache !== null) {
      const cacheKey = this._getTurbulentFallbackCacheKey(face, worldPos);
      const cachedLight = cache.get(cacheKey);

      if (cachedLight) {
        return cachedLight;
      }

      const fallbackLight = BrushModelRenderer.sampleTurbulentFallbackLight(model, face, worldPos, R.LightPoint);
      cache.set(cacheKey, fallbackLight);
      return fallbackLight;
    }

    return BrushModelRenderer.sampleTurbulentFallbackLight(model, face, worldPos, R.LightPoint);
  }
}
