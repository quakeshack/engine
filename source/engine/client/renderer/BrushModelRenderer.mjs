import Vector from '../../../shared/Vector.mjs';
import { ModelRenderer } from './ModelRenderer.mjs';
import { eventBus, registry } from '../../registry.mjs';
import GL, { ATTRIB_LOCATIONS, BRUSH_VERTEX_STRIDE } from '../GL.mjs';
import { getEntityBloomEmissiveScale } from './BloomEffect.mjs';
import { materialFlags } from './Materials.mjs';
import { BrushModel, Node } from '../../common/model/BSP.mjs';
import { ClientEdict } from '../ClientEntities.mjs';
import Mesh from './Mesh.mjs';
import PostProcess from './PostProcess.mjs';
import * as Def from '../../common/Def.mjs';

let { CL, Host, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Host, R } = registry);
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
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
const TURBULENT_FALLBACK_FACE_BLEND = 0.35;
const TURBULENT_FALLBACK_SCALE = 0.0078125;
const TURBULENT_FALLBACK_EPSILON = 0.0001;

/**
 * @param {number} strength Requested brush bloom contribution strength.
 * @returns {number} Sanitized non-negative bloom contribution strength.
 */
export function resolveBrushBloomContributionStrength(strength) {
  return Number.isFinite(strength) && strength > 0.0 ? strength : 0.0;
}

/**
 * Renderer for BSP brush models (maps and inline models like doors, platforms).
 * Handles both static world geometry and dynamic brush entities.
 */
export class BrushModelRenderer extends ModelRenderer {
  /**
   * Determine whether a brush model should sample the shared deluxemap atlas.
   * Inline BSP submodels reuse the world atlas even when they do not carry
   * their own `deluxemap` pointer.
   * @param {BrushModel} clmodel The brush model being rendered
   * @param {BrushModel|null} worldModel The active world model
   * @returns {boolean} True when deluxemap sampling should stay enabled
   */
  static usesDeluxemap(clmodel, worldModel) {
    return Boolean(clmodel.deluxemap !== null || (clmodel.submodel && worldModel?.deluxemap !== null));
  }

  /**
   * Build the lighting state used by inline brush entities.
   * Brush models should use the same BSP + dynamic-light sampling as alias/mesh entities.
   * @param {BrushModel} clmodel The brush model being rendered
   * @param {ClientEdict} entity The entity being rendered
   * @param {(entity: ClientEdict) => [Vector, Vector, Vector, Vector, Vector]} calculateLightValues Light sampler callback
   * @param {BrushModel|null} [worldModel] The active world model
   * @returns {{ambientlight: Vector, shadelight: Vector, lightPosition: Vector, dynamicShadeLight: Vector, dynamicLightPosition: Vector, hasDeluxemap: boolean}} Resolved lighting state
   */
  static resolveEntityLightingState(clmodel, entity, calculateLightValues, worldModel = null) {
    const [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition] = calculateLightValues(entity);
    const usesSharedWorldLightmap = clmodel.submodel === true
      && (clmodel.lightdata !== null || clmodel.lightdata_rgb !== null);

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
   * @private
   * @param {Vector} axis Axis candidate.
   * @param {Vector} normal Surface normal.
   * @returns {Vector|null} Axis projected onto the face plane, or null when degenerate.
   */
  static _projectTurbulentFallbackAxis(axis, normal) {
    const projectedAxis = axis.copy().subtract(normal.copy().multiply(axis.dot(normal)));

    if (projectedAxis.normalize() <= TURBULENT_FALLBACK_EPSILON) {
      return null;
    }

    return projectedAxis;
  }

  /**
   * @private
   * @param {BrushModel} model Model containing the face.
   * @param {import('../../common/model/BaseModel.mjs').Face} face Turbulent face being packed.
   * @returns {{tangent: Vector, bitangent: Vector}} Face-plane sampling basis.
   */
  static _getTurbulentFallbackBasis(model, face) {
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

    const faceWithVerts = /** @type {import('../../common/model/BaseModel.mjs').Face & { verts?: number[][] }} */ (face);

    if (tangent === null && faceWithVerts.verts && faceWithVerts.verts.length >= 2) {
      const edge = new Vector(
        faceWithVerts.verts[1][0] - faceWithVerts.verts[0][0],
        faceWithVerts.verts[1][1] - faceWithVerts.verts[0][1],
        faceWithVerts.verts[1][2] - faceWithVerts.verts[0][2],
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
   * @param {BrushModel} model Model containing the face.
   * @param {import('../../common/model/BaseModel.mjs').Face} face Turbulent face being packed.
   * @param {Vector} worldPos Vertex position used for the fallback sample.
   * @param {(position: Vector) => [Vector, Vector]} sampleLightPoint Light sampler callback.
   * @returns {number[]} Vertex-level fallback light color.
   */
  static sampleTurbulentFallbackLight(model, face, worldPos, sampleLightPoint) {
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
    const visibleSamples = [];
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

  /**
   * @param {number[]} vertexLight Per-vertex fallback color.
   * @param {number[]} faceLight Face-level fallback color.
   * @param {number} factor Blend factor in the 0..1 range.
   * @returns {number[]} Smoothed fallback color.
   */
  static blendTurbulentFallbackLight(vertexLight, faceLight, factor) {
    const clampedFactor = Math.max(0.0, Math.min(factor, 1.0));
    const inverseFactor = 1.0 - clampedFactor;

    return [
      vertexLight[0] * inverseFactor + faceLight[0] * clampedFactor,
      vertexLight[1] * inverseFactor + faceLight[1] * clampedFactor,
      vertexLight[2] * inverseFactor + faceLight[2] * clampedFactor,
    ];
  }

  /**
   * Get the model type this renderer handles
   * @returns {number} Mod.type.brush (0)
   */
  getModelType() {
    return 0; // Mod.type.brush
  }

  /**
   * Setup rendering state for brush models.
   * Binds shared textures and prepares GL state for brush rendering.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  setupRenderState(_pass = 0) {
    // Brush models bind their own buffers and state per-entity
    // No shared setup needed at this level
  }

  /**
   * @param {BrushModel} _model The brush model
   * @param {ClientEdict} entity The entity being rendered
   * @returns {boolean} True when the brush model should contribute to the opaque pass
   */
  rendersOpaquePass(_model, entity) {
    return entity.alpha >= 1.0;
  }

  /**
   * @param {BrushModel} model The brush model
   * @param {ClientEdict} entity The entity being rendered
   * @returns {boolean} True when the brush model has transparent content for the sorted pass
   */
  rendersTransparentPass(model, entity) {
    if (entity.alpha <= 0.0) {
      return false;
    }

    if (entity.alpha < 1.0) {
      return true;
    }

    if (!model.chains || model.chains.length === 0) {
      return false;
    }

    for (let i = 0; i < model.chains.length; i++) {
      const chain = model.chains[i];
      const material = model.textures[chain[0]];

      if ((material.flags & materialFlags.MF_TRANSPARENT) !== 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Render a single brush model entity.
   * Handles frustum culling, transforms, lighting, and both opaque and turbulent surfaces.
   * @param {BrushModel} model The brush model to render
   * @param {ClientEdict} entity The entity being rendered
   * @param {number} pass Rendering pass (0=opaque, 1=transparent)
   */
  render(model, entity, pass = 0) {
    const clmodel = model;
    const e = entity;

    // Check if this is the world entity (entity 0)
    // World uses leafs structure, entities use chains structure
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

    // Regular brush entity rendering (doors, platforms, etc)
    // Frustum culling
    if (clmodel.submodel === true) {
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
        )) === true) {
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
        )) === true) {
        return;
      }
    }

    // Bind VAO and render appropriate pass
    const viewMatrix = e.lerp.angles.toRotationMatrix();

    if (pass === 0) {
      GL.BindVAO(clmodel.opaqueVAO);
      R.c_brush_vbos++;
      this._renderOpaqueSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    } else if (pass === 1 && R.drawturbulents.value) {
      GL.BindVAO(clmodel.turbulentVAO);
      R.c_brush_vbos++;
      this._renderTurbulentSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    } else if (pass === 2) {
      GL.BindVAO(clmodel.opaqueVAO);
      R.c_brush_vbos++;
      this._renderTransparentSurfaces(clmodel, e, viewMatrix);
      GL.UnbindVAO();
    }
  }

  /**
   * Render the world (entity 0) opaque surfaces.
   * World uses leafs structure instead of chains.
   * @param {BrushModel} clmodel The world model
   */
  renderWorld(clmodel) {
    const worldspawn = CL.state.clientEntities.getEntity(0);

    GL.BindVAO(clmodel.opaqueVAO);
    R.c_brush_vbos++;

    const program = GL.UseProgram('brush');
    gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale, 0.0);
    gl.uniform1f(program.uBloomDlightScale, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));

    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform4f(program.uLightVec, 0.0, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicLightVec, 0.0, 0.0, 0.0);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    // wallhack: GL_BLEND is required
    // gl.enable(gl.BLEND);
    // gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Iterate through visible leafs
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];

      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }

      if (R.CullBox(leaf.mins, leaf.maxs)) {
        continue;
      }

      for (let j = 0; j < leaf.skychain; j++) {
        const cmds = leaf.cmds[j];
        const material = clmodel.textures[cmds[0]];

        if (material.flags & materialFlags.MF_SKIP) {
          continue;
        }

        // Skip transparent surfaces in opaque pass
        if (material.flags & materialFlags.MF_TRANSPARENT) {
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
   * World uses leafs structure instead of chains.
   * @param {BrushModel} clmodel The world model
   */
  renderWorldTransparent(clmodel) {
    this.beginWorldTransparentPass(clmodel);
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs)) {
        continue;
      }
      this.renderWorldTransparentLeaf(clmodel, leaf);
    }
    this.endWorldTransparentPass();
  }

  /**
   * Collect visible world leafs that contain transparent surfaces, with
   * squared distance from the given viewpoint for back-to-front sorting.
   * @param {BrushModel} clmodel The world model
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {{leaf: Node, dist: number}[]} Transparent leaf items sorted by distance (farthest first)
   */
  getWorldTransparentLeaves(clmodel, vieworg) {
    const items = [];
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs)) {
        continue;
      }
      // Check if this leaf has any transparent surfaces
      let hasTransparent = false;
      for (let j = 0; j < leaf.skychain; j++) {
        if (clmodel.textures[leaf.cmds[j][0]].flags & materialFlags.MF_TRANSPARENT) {
          hasTransparent = true;
          break;
        }
      }
      if (!hasTransparent) {
        continue;
      }
      const dist = this._getBoundsDistanceToView(leaf.mins, leaf.maxs, vieworg);
      items.push({ leaf, dist });
    }
    return items;
  }

  /**
   * Setup GL state for world transparent leaf rendering.
   * Call once before one or more `renderWorldTransparentLeaf` calls.
   * @param {BrushModel} clmodel The world model
   */
  beginWorldTransparentPass(clmodel) {
    GL.BindVAO(clmodel.opaqueVAO);
    R.c_brush_vbos++;

    /** @type {object} */
    const program = GL.UseProgram('brush');
    this._worldTransparentProgram = program;
    this._worldTransparentModel = clmodel;

    gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale, 0.0);
    gl.uniform1f(program.uBloomDlightScale, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform4f(program.uLightVec, 0.0, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicLightVec, 0.0, 0.0, 0.0);

    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Render a single leaf’s transparent surfaces.
   * Must be called between `beginWorldTransparentPass` and `endWorldTransparentPass`.
   * @param {BrushModel} clmodel The world model
   * @param {Node} leaf The BSP leaf to render
   */
  renderWorldTransparentLeaf(clmodel, leaf) {
    const worldspawn = CL.state.clientEntities.getEntity(0);
    const program = this._worldTransparentProgram;

    for (let j = 0; j < leaf.skychain; j++) {
      const cmds = leaf.cmds[j];
      const material = clmodel.textures[cmds[0]];

      if (material.flags & materialFlags.MF_SKIP) {
        continue;
      }
      if (!(material.flags & materialFlags.MF_TRANSPARENT)) {
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

  /**
   * Cleanup GL state after world transparent leaf rendering.
   */
  endWorldTransparentPass() {
    gl.disable(gl.BLEND);
    GL.UnbindVAO();
    this._worldTransparentProgram = null;
    this._worldTransparentModel = null;
  }

  /**
   * Render the world (entity 0) turbulent surfaces.
   * World uses leafs structure instead of chains.
   * @param {BrushModel} clmodel The world model
   */
  renderWorldTurbolents(clmodel) {
    this.beginWorldTurbulentPass(clmodel);
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs) === true) {
        continue;
      }
      this.renderWorldTurbulentLeaf(clmodel, leaf);
    }
    this.endWorldTurbulentPass();
  }

  /**
   * Collect visible world leafs that contain turbulent surfaces, with
   * squared distance from the given viewpoint for back-to-front sorting.
   * @param {BrushModel} clmodel The world model
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {{leaf: Node, dist: number}[]} Turbulent leaf items sorted by distance (farthest first)
   */
  getWorldTurbulentLeaves(clmodel, vieworg) {
    const items = [];
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs) === true) {
        continue;
      }
      const dist = this._getBoundsDistanceToView(leaf.mins, leaf.maxs, vieworg);
      items.push({ leaf, dist });
    }
    return items;
  }

  /**
   * Collect visible world turbulent draw batches with tight bounds so fog and
   * semi-transparent liquids can share the same sorted space.
   * @param {BrushModel} clmodel The world model
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {{chain: import('../../common/model/BSP.mjs').WorldTurbulentChainInfo, dist: number}[]} Turbulent draw items with distance metadata
   */
  getWorldTurbulentChains(clmodel, vieworg) {
    const items = [];

    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs) === true) {
        continue;
      }

      for (let j = 0; j < leaf.turbulentChains.length; j++) {
        const chain = leaf.turbulentChains[j];
        if (R.CullBox(chain.mins, chain.maxs) === true) {
          continue;
        }

        items.push({
          chain,
          dist: this._getBoundsDistanceToView(chain.mins, chain.maxs, vieworg),
        });
      }
    }

    return items;
  }

  /**
   * Approximate view-relative sort distance for bounded transparent content.
   * Uses the nearest point on the AABB instead of the center so large leaves
   * and fog volumes sort by the depth where they begin affecting the view.
   * @private
   * @param {Vector|number[]|Float32Array} mins Minimum corner of the AABB
   * @param {Vector|number[]|Float32Array} maxs Maximum corner of the AABB
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {number} Euclidean distance from the view to the nearest point on the bounds
   */
  _getBoundsDistanceToView(mins, maxs, vieworg) {
    const nearestX = Math.max(mins[0], Math.min(vieworg[0], maxs[0]));
    const nearestY = Math.max(mins[1], Math.min(vieworg[1], maxs[1]));
    const nearestZ = Math.max(mins[2], Math.min(vieworg[2], maxs[2]));
    const dx = nearestX - vieworg[0];
    const dy = nearestY - vieworg[1];
    const dz = nearestZ - vieworg[2];

    return Math.hypot(dx, dy, dz);
  }

  /**
   * Setup GL state for world turbulent leaf rendering.
   * Call once before one or more `renderWorldTurbulentLeaf` calls.
   * @param {BrushModel} clmodel The world model
   */
  beginWorldTurbulentPass(clmodel) {
    GL.BindVAO(clmodel.turbulentVAO);
    R.c_brush_vbos++;

    const program = GL.UseProgram('turbulent');
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform1f(program.uTime, Host.realtime);
    gl.uniform1f(program.uBloomEmissiveScale, 0.0);
    gl.uniform1f(program.uBloomDlightScale, R.bloomDlightStrength.value);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyle, R.lightstyle_texture_a);

    this._worldTurbulentProgram = program;
    this._worldTurbulentModel = clmodel;
  }

  /**
   * Render a single leaf's turbulent surfaces.
   * Must be called between `beginWorldTurbulentPass` and `endWorldTurbulentPass`.
   * @param {BrushModel} clmodel The world model
   * @param {Node} leaf The BSP leaf to render
   */
  renderWorldTurbulentLeaf(clmodel, leaf) {
    for (let j = leaf.waterchain; j < leaf.cmds.length; j++) {
      const cmds = leaf.cmds[j];
      this._renderWorldTurbulentBatch(clmodel, cmds[0], cmds[1], cmds[2]);
    }
  }

  /**
   * Render a single pre-sorted world turbulent draw batch.
   * Must be called between `beginWorldTurbulentPass` and `endWorldTurbulentPass`.
   * @param {BrushModel} clmodel The world model
   * @param {import('../../common/model/BSP.mjs').WorldTurbulentChainInfo} chain The turbulent draw batch to render
   */
  renderWorldTurbulentChain(clmodel, chain) {
    this._renderWorldTurbulentBatch(clmodel, chain.texture, chain.firstVertex, chain.vertexCount);
  }

  /**
   * @private
   * @param {BrushModel} clmodel The world model
   * @param {number} textureIndex Texture index for this draw
   * @param {number} firstVertex First vertex in the turbulent VBO region
   * @param {number} vertexCount Number of vertices in the draw batch
   */
  _renderWorldTurbulentBatch(clmodel, textureIndex, firstVertex, vertexCount) {
    const worldspawn = CL.state.clientEntities.getEntity(0);
    const program = this._worldTurbulentProgram;
    const material = clmodel.textures[textureIndex];

    material.emit(worldspawn);
    const alpha = this._getTurbulentMaterialAlpha(material, worldspawn);
    this._setTurbulentSurfaceState(alpha);
    gl.uniform1f(program.uAlpha, alpha);

    R.c_brush_verts += vertexCount;
    R.c_brush_tris += vertexCount / 3;
    material.bindTo(program);
    gl.drawArrays(gl.TRIANGLES, firstVertex, vertexCount);
    R.c_brush_draws++;
  }

  /**
   * Cleanup GL state after world turbulent leaf rendering.
   */
  endWorldTurbulentPass() {
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    GL.UnbindVAO();
    this._worldTurbulentProgram = null;
    this._worldTurbulentModel = null;
  }

  /**
   * @private
   * @param {import('./Materials.mjs').BaseMaterial} material Material chosen for the draw.
   * @param {ClientEdict} entity Entity that owns the surface.
   * @returns {number} Combined material/entity alpha in the 0..1 range.
   */
  _getTurbulentMaterialAlpha(material, entity) {
    const entityAlpha = entity?.alpha ?? 1.0;
    return Math.max(0.0, Math.min(material.currentAlpha * entityAlpha, 1.0));
  }

  /**
   * Opaque liquids must write depth so they occlude later fog/transparent passes.
   * Transparent liquids stay blended and keep depth writes disabled.
   * @private
   * @param {number} alpha Effective surface alpha.
   */
  _setTurbulentSurfaceState(alpha) {
    if (alpha >= 1.0) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      return;
    }

    gl.enable(gl.BLEND);
    gl.depthMask(false);
  }

  /**
   * Setup common brush shader uniforms and textures.
   * Configures lightmaps, dynamic lights, light styles, and deluxemaps.
   * @private
   * @param {WebGLProgram} program The shader program (brush or turbulent)
   * @param {BrushModel} clmodel The brush model
   * @param {boolean} isWorld Whether this is the world entity (affects deluxemap/dlight settings)
   */
  _setupBrushShaderCommon(program, clmodel, isWorld) {
    // Bind lightmap textures
    if ((R.fullbright.value !== 0) || (clmodel.lightdata === null && clmodel.lightdata_rgb === null)) {
      GL.BindArray(program.tLightmap, R.fullbright_texture);
    } else {
      GL.BindArray(program.tLightmap, R.lightmap_texture);
    }

    // Bind dynamic light texture
    if (R.flashblend.value === 0 && (isWorld || clmodel.submodel)) {
      GL.Bind(program.tDlight, R.dlightmap_rgba_texture);
    } else {
      GL.Bind(program.tDlight, R.null_texture);
    }

    // Bind local shadow map textures
    if (program.tShadowMap0 !== undefined && R.shadow_textures?.[0]) {
      GL.Bind(program.tShadowMap0, R.shadow_textures[0]);
    }
    if (program.tShadowMap1 !== undefined && R.shadow_textures?.[1]) {
      GL.Bind(program.tShadowMap1, R.shadow_textures[1]);
    }
    if (program.tShadowMap2 !== undefined && R.shadow_textures?.[2]) {
      GL.Bind(program.tShadowMap2, R.shadow_textures[2]);
    }

    // Bind point light cube shadow map
    if (program.tPointShadowMap !== undefined) {
      GL.BindCube(program.tPointShadowMap, R.point_shadow_texture);
    }
  }

  /**
   * Render opaque (non-turbulent) brush surfaces
   * @private
   * @param {BrushModel} clmodel The brush model
   * @param {ClientEdict} e The entity
   * @param {number[]} viewMatrix Rotation matrix for entity orientation
   */
  _renderOpaqueSurfaces(clmodel, e, viewMatrix) {
    const program = GL.UseProgram('brush');
    this._applyEntityLighting(program, clmodel, e);

    // Setup transforms
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);

    // Setup uniforms
    gl.uniform1f(program.uInterpolation, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);
    gl.uniform1f(program.uAlpha, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    // Render each texture chain
    if (!clmodel.chains || clmodel.chains.length === 0) {
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]];

      // Skip turbulent and transparent surfaces in opaque pass
      if ((material.flags & materialFlags.MF_TURBULENT) || (material.flags & materialFlags.MF_TRANSPARENT)) {
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

  /**
   * Render transparent brush surfaces with alpha blending
   * @private
   * @param {BrushModel} clmodel The brush model
   * @param {ClientEdict} e The entity
   * @param {number[]} viewMatrix Rotation matrix for entity orientation
   */
  _renderTransparentSurfaces(clmodel, e, viewMatrix) {
    const program = GL.UseProgram('brush');
    this._applyEntityLighting(program, clmodel, e);

    // Setup transforms
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);

    // Setup uniforms
    gl.uniform1f(program.uInterpolation, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);
    gl.uniform1f(program.uAlpha, e.alpha);
    gl.uniform1f(program.uBloomEmissiveScale, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale, R.bloomDlightStrength.value);
    gl.uniform1f(program.uBloomSpecularScale, resolveBrushBloomContributionStrength(R.bloomSpecularStrength?.value ?? 0.0));

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    this._bindBrushDeluxemap(program, clmodel);

    // Enable blending for transparent surfaces (depth writes stay ON so
    // the Z-buffer correctly orders transparent geometry against each other)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Render each texture chain (only transparent ones)
    if (!clmodel.chains || clmodel.chains.length === 0) {
      gl.disable(gl.BLEND);
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]];

      // Skip requested
      if (material.flags & materialFlags.MF_SKIP) {
        continue;
      }

      // Only render transparent surfaces in this pass
      if (e.alpha === 1.0 && (
        (material.flags & materialFlags.MF_TURBULENT) || !(material.flags & materialFlags.MF_TRANSPARENT)
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

  /**
   * Render turbulent (water, slime, lava, teleport) brush surfaces
   * @private
   * @param {BrushModel} clmodel The brush model
   * @param {ClientEdict} e The entity
   * @param {number[]} viewMatrix Rotation matrix for entity orientation
   */
  _renderTurbulentSurfaces(clmodel, e, viewMatrix) {
    const program = GL.UseProgram('turbulent');
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);
    gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));
    gl.uniform1f(program.uBloomEmissiveScale, getEntityBloomEmissiveScale(e.effects));
    gl.uniform1f(program.uBloomDlightScale, R.bloomDlightStrength.value);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyle, R.lightstyle_texture_a);

    // Render each turbulent chain
    if (!clmodel.chains || clmodel.chains.length === 0) {
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]];

      // Skip requested
      if (material.flags & materialFlags.MF_SKIP) {
        continue;
      }

      if (!(material.flags & materialFlags.MF_TURBULENT)) {
        continue; // Skip non-turbulent surfaces in this pass
      }

      material.emit(e);
      const alpha = this._getTurbulentMaterialAlpha(material, e);
      this._setTurbulentSurfaceState(alpha);
      gl.uniform1f(program.uAlpha, alpha);
      material.bindTo(program);

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /**
   * @private
   * @param {object} program Active brush shader program
   * @param {BrushModel} clmodel The brush model
   * @param {ClientEdict} entity The entity being rendered
   */
  _applyEntityLighting(program, clmodel, entity) {
    const lightingState = BrushModelRenderer.resolveEntityLightingState(
      clmodel,
      entity,
      R._CalculateLightValues,
      CL.state.worldmodel,
    );

    gl.uniform3fv(program.uAmbientLight, lightingState.ambientlight);
    gl.uniform3fv(program.uShadeLight, lightingState.shadelight);
    gl.uniform4f(
      program.uLightVec,
      lightingState.lightPosition[0],
      lightingState.lightPosition[1],
      lightingState.lightPosition[2],
      0.0,
    );
    gl.uniform3fv(program.uDynamicShadeLight, lightingState.dynamicShadeLight);
    gl.uniform3fv(program.uDynamicLightVec, lightingState.dynamicLightPosition);
  }

  /**
   * @private
   * @param {object} program Active brush shader program
   * @param {BrushModel} clmodel The brush model
   */
  _bindBrushDeluxemap(program, clmodel) {
    if (BrushModelRenderer.usesDeluxemap(clmodel, CL.state.worldmodel)) {
      GL.BindArray(program.tDeluxemap, R.deluxemap_texture);
      gl.uniform1f(program.uHaveDeluxemap, 1.0);
      return;
    }

    GL.BindArray(program.tDeluxemap, R.normal_up_texture);
    gl.uniform1f(program.uHaveDeluxemap, 0.0);
  }

  /**
   * Resolution of the 3D light probe grid per axis.
   * A grid of RES^3 probes is sampled from R.LightPoint and packed into a 2D texture.
   * @type {number}
   */
  static FOG_LIGHT_PROBE_RES = 8;

  /**
   * Create a VAO for brush geometry at the given byte offset in the VBO.
   * All 6 standard brush attributes are configured with 80-byte stride.
   * @private
   * @param {WebGLBuffer} vbo The VBO containing brush vertex data
   * @param {number} offset Byte offset for the first vertex
   * @returns {WebGLVertexArrayObject} The created VAO
   */
  _createBrushVAO(vbo, offset) {
    return GL.CreateVAO(vbo, [
      { location: 0, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset },
      { location: 1, components: 4, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 12 },
      { location: 2, components: 4, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 28 },
      { location: 3, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 44 },
      { location: 4, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 56 },
      { location: 5, components: 3, type: gl.FLOAT, normalized: false, stride: BRUSH_VERTEX_STRIDE, offset: offset + 68 },
    ]);
  }

  /**
   * Maximum number of dynamic lights passed to the fog volume shader.
   * Must match MAX_FOG_DLIGHTS in fog-volume.frag.
   * @type {number}
   */
  static MAX_FOG_DLIGHTS = 8;

  /**
   * Light probe textures for fog volumes, keyed by the fog volume object.
   * Each entry holds a raw WebGL texture, the grid resolution, and a reusable
   * pixel buffer to avoid reallocating on every lightstyle update.
   * @type {Map<import('../../common/model/BSP.mjs').FogVolumeInfo, {texture: WebGLTexture, resX: number, resY: number, resZ: number, data: Uint8Array}>}
   */
  #fogLightProbes = new Map();

  /**
   * The lightstyle animation frame index when probes were last rebuilt.
   * Lightstyles tick at 10 Hz (floor(time * 10)), so probes are only
   * regenerated when this value changes.
   * @type {number}
   */
  #fogProbeStyleFrame = -1;

  /**
   * A 1x1 white texture used as a fallback when no light probe is available.
   * @type {WebGLTexture|null}
   */
  #fogLightProbeWhite = null;

  /**
   * Lazily created unit cube VBO for rendering world-level fog volumes.
   * The cube spans [0,1]^3 and is transformed via uOrigin/uAngles to match each fog volume's AABB.
   * @type {WebGLBuffer|null}
   */
  #fogCubeVBO = null;

  /**
   * Lazily created VAO for the fog cube VBO (position-only, 12-byte stride).
   * @type {WebGLVertexArrayObject|null}
   */
  #fogCubeVAO = null;

  /**
   * Get or create a 1×1×1 white fallback 3D texture for fog volumes without light probes.
   * @returns {WebGLTexture} The white 3D texture
   */
  _getFogLightProbeWhite() {
    if (this.#fogLightProbeWhite) {
      return this.#fogLightProbeWhite;
    }

    this.#fogLightProbeWhite = gl.createTexture();
    GL.Bind3D(0, this.#fogLightProbeWhite);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return this.#fogLightProbeWhite;
  }

  /**
   * Sample R.LightPoint into a pixel buffer for a fog volume's light probe grid.
   * Data is laid out for TEXTURE_3D upload: Z slices are contiguous in memory.
   * Texel at grid (ix, iy, iz) is at index (iz * resY * resX + iy * resX + ix).
   * @param {import('../../common/model/BSP.mjs').FogVolumeInfo} fogVolume The fog volume
   * @param {Uint8Array} data Pixel buffer to fill (resX * resY * resZ * 4)
   * @param {number} resX Grid resolution X
   * @param {number} resY Grid resolution Y
   * @param {number} resZ Grid resolution Z
   */
  _sampleFogLightProbe(fogVolume, data, resX, resY, resZ) {
    const sizeX = fogVolume.maxs[0] - fogVolume.mins[0];
    const sizeY = fogVolume.maxs[1] - fogVolume.mins[1];
    const sizeZ = fogVolume.maxs[2] - fogVolume.mins[2];
    const sliceSize = resX * resY;

    for (let iz = 0; iz < resZ; iz++) {
      for (let iy = 0; iy < resY; iy++) {
        for (let ix = 0; ix < resX; ix++) {
          // Map grid position to world position (probe at cell center)
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

          // Normalize light color: preserve hue, map maximum component to 1.0.
          // This prevents the light probe from dimming the fog (the base fog
          // color already accounts for ambient brightness). We only want the
          // chromatic variation from colored lights.
          const maxComp = Math.max(color[0], color[1], color[2]);

          if (maxComp > 1.0) {
            data[idx] = Math.min(255, Math.round((color[0] / maxComp) * 255));
            data[idx + 1] = Math.min(255, Math.round((color[1] / maxComp) * 255));
            data[idx + 2] = Math.min(255, Math.round((color[2] / maxComp) * 255));
          } else {
            // Very dark area — keep as white (no tinting)
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
   * Create or update the light probe texture for a fog volume.
   * If the probe already exists, re-samples into the existing pixel buffer
   * and re-uploads via texSubImage2D (avoids GPU allocation).
   * @param {import('../../common/model/BSP.mjs').FogVolumeInfo} fogVolume The fog volume
   * @returns {{texture: WebGLTexture, resX: number, resY: number, resZ: number, data: Uint8Array}} The probe data
   */
  _createOrUpdateFogLightProbe(fogVolume) {
    const existing = this.#fogLightProbes.get(fogVolume);

    if (existing) {
      // Re-sample into existing buffer and re-upload
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

    const texture = gl.createTexture();
    GL.Bind3D(0, texture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, resX, resY, resZ, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

    const probe = { texture, resX, resY, resZ, data };
    this.#fogLightProbes.set(fogVolume, probe);
    return probe;
  }

  /**
   * Get the light probe texture for a fog volume, creating or updating it
   * when lightstyle animations tick. Lightstyles animate at 10 Hz, so the
   * probes are re-sampled at most 10 times per second.
   * @param {import('../../common/model/BSP.mjs').FogVolumeInfo} fogVolume The fog volume
   * @returns {{texture: WebGLTexture, resX: number, resY: number, resZ: number, data: Uint8Array}|null} Probe data, or null if light data is unavailable
   */
  _getFogLightProbe(fogVolume) {
    // Only create probes if the world has light data to sample
    const worldmodel = CL.state.worldmodel;
    if (!worldmodel || (worldmodel.lightdata === null && worldmodel.lightdata_rgb === null)) {
      return null;
    }

    // Check if lightstyles have ticked since last update
    const styleFrame = Math.floor(CL.state.time * 10.0);
    const needsUpdate = styleFrame !== this.#fogProbeStyleFrame;

    if (needsUpdate) {
      this.#fogProbeStyleFrame = styleFrame;
    }

    // First access: always create. Subsequent: only re-sample on style tick.
    if (!this.#fogLightProbes.has(fogVolume) || needsUpdate) {
      return this._createOrUpdateFogLightProbe(fogVolume);
    }

    return this.#fogLightProbes.get(fogVolume);
  }

  /**
   * Free all fog light probe textures. Called on map change.
   */
  _freeFogLightProbes() {
    if (gl) {
      for (const { texture } of this.#fogLightProbes.values()) {
        gl.deleteTexture(texture);
      }
    }
    this.#fogLightProbes.clear();
  }

  /**
   * Collect active dynamic lights that overlap a fog volume's AABB.
   * Returns up to MAX_FOG_DLIGHTS lights sorted by contribution (closest first).
   * @param {import('../../common/model/BSP.mjs').FogVolumeInfo} fogVolume The fog volume
   * @returns {{origin: Vector, radius: number, color: Vector}[]} Overlapping dlights
   */
  _collectFogDlights(fogVolume) {
    const results = [];
    const dlights = CL.state.clientEntities.dlights;

    for (let i = 0; i < Def.limits.dlights; i++) {
      const dl = dlights[i];

      if (dl.isFree()) {
        continue;
      }

      // Sphere-AABB overlap: find closest point on AABB to light origin
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

    // Sort by distance (closest first) and cap at MAX_FOG_DLIGHTS
    results.sort((a, b) => a.distSq - b.distSq);
    return results.slice(0, BrushModelRenderer.MAX_FOG_DLIGHTS);
  }

  /**
   * Upload dynamic light uniforms for the current fog volume.
   * @param {import('../../common/model/BSP.mjs').FogVolumeInfo} fogVolume The fog volume
   */
  _uploadFogDlights(fogVolume) {
    const program = this._fogVolumeProgram;
    const dlights = this._collectFogDlights(fogVolume);

    gl.uniform1i(program.uDlightCount, dlights.length);

    for (let i = 0; i < dlights.length; i++) {
      const dl = dlights[i];
      gl.uniform4f(
        program['uDlightPos[' + i + ']'],
        dl.origin[0], dl.origin[1], dl.origin[2], dl.radius,
      );
      gl.uniform4f(
        program['uDlightColor[' + i + ']'],
        dl.color[0], dl.color[1], dl.color[2], 0.0,
      );
    }
  }

  /**
   * Get or create the shared unit cube VBO used for world-level fog volumes.
   * @returns {WebGLBuffer} The unit cube VBO
   */
  _getFogCubeVBO() {
    if (this.#fogCubeVBO) {
      return this.#fogCubeVBO;
    }

    // Unit cube [0,1]^3 — 12 triangles, 36 vertices, CW winding from outside
    // (matching Quake BSP convention: outward faces are CW in world space).
    // The fog shader uses gl.cullFace(gl.BACK) which, with the Quake projection's
    // coordinate mapping, culls near-side faces and renders far-side faces.
    // This gives exit-point fragments for correct fog thickness calculation.
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

    this.#fogCubeVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#fogCubeVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    this.#fogCubeVAO = GL.CreateVAO(this.#fogCubeVBO, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride: 12, offset: 0 },
    ]);

    return this.#fogCubeVBO;
  }

  /**
   * Render all fog volumes defined in the world model.
   * Handles both inline brush model fog volumes (*N) and world-level
   * water/slime/lava fog volumes (modelIndex === 0).
   * @param {BrushModel} worldmodel The world model containing fog volume definitions
   */
  renderFogVolumes(worldmodel) {
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
   * @param {BrushModel} worldmodel The world model containing fog volume definitions
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {{fogVolume: import('../../common/model/BSP.mjs').FogVolumeInfo, dist: number}[]} Fog volume items with distance
   */
  getFogVolumeItems(worldmodel, vieworg) {
    if (!worldmodel.fogVolumes || worldmodel.fogVolumes.length === 0) {
      return [];
    }
    const items = [];
    for (const fogVolume of worldmodel.fogVolumes) {
      const dist = this._getBoundsDistanceToView(fogVolume.mins, fogVolume.maxs, vieworg);
      items.push({ fogVolume, dist });
    }
    return items;
  }

  /**
   * Setup GL state for fog volume rendering.
   * Call once before one or more `renderSingleFogVolume` calls.
   * @param {BrushModel} worldmodel The world model
   * @returns {boolean} True if fog volume pass was started, false if skipped
   */
  beginFogVolumePass(worldmodel) {
    if (!worldmodel.fogVolumes || worldmodel.fogVolumes.length === 0) {
      return false;
    }

    // Detach depth texture from FBO so we can sample it
    PostProcess.beginDepthSampling();

    const program = GL.UseProgram('fog-volume');

    // GL state for fog volumes:
    // - Blend: src alpha compositing
    // - No depth test: shader handles depth via texture sampling
    // - No depth writes
    // - Cull back faces (Quake winding): renders the far side of the brush,
    //   giving us exit points for the fog ray. The shader computes entry via AABB.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.cullFace(gl.BACK);
    gl.enable(gl.CULL_FACE);

    // Bind scene depth texture
    GL.Bind(program.tDepth, PostProcess.depthTexture);

    // Pass screen dimensions for depth texture UV calculation
    gl.uniform2f(program.uScreenSize, PostProcess.width, PostProcess.height);

    this._fogVolumeProgram = program;
    return true;
  }

  /**
   * Render a single fog volume.
   * Must be called between `beginFogVolumePass` and `endFogVolumePass`.
   * @param {BrushModel} worldmodel The world model
   * @param {import('../../common/model/BSP.mjs').FogVolumeInfo} fogVolume The fog volume to render
   */
  renderSingleFogVolume(worldmodel, fogVolume) {
    const program = this._fogVolumeProgram;

    // Set fog volume parameters
    gl.uniform3f(
      program.uFogVolumeColor,
      fogVolume.color[0] / 255.0,
      fogVolume.color[1] / 255.0,
      fogVolume.color[2] / 255.0,
    );
    gl.uniform1f(program.uFogVolumeDensity, fogVolume.density);
    gl.uniform1f(program.uFogVolumeMaxOpacity, fogVolume.maxOpacity);

    // Bind the light probe 3D texture for this fog volume.
    // _getFogLightProbe / _getFogLightProbeWhite may upload via Bind3D(0, ...)
    // which clobbers texture unit 0 (tDepth). Re-bind depth after.
    const probe = this._getFogLightProbe(fogVolume);
    GL.Bind3D(program.tLightProbe, probe ? probe.texture : this._getFogLightProbeWhite());
    // Restore depth texture on unit 0 (may have been clobbered by probe upload)
    GL.Bind(program.tDepth, PostProcess.depthTexture);

    // Upload dynamic lights overlapping this fog volume
    this._uploadFogDlights(fogVolume);

    // Pass the AABB of the fog volume for ray intersection
    gl.uniform3f(program.uFogVolumeMins, fogVolume.mins[0], fogVolume.mins[1], fogVolume.mins[2]);
    gl.uniform3f(program.uFogVolumeMaxs, fogVolume.maxs[0], fogVolume.maxs[1], fogVolume.maxs[2]);

    if (fogVolume.modelIndex === 0) {
      // World-level fog volume: use a unit cube transformed to match the AABB
      const sizeX = fogVolume.maxs[0] - fogVolume.mins[0];
      const sizeY = fogVolume.maxs[1] - fogVolume.mins[1];
      const sizeZ = fogVolume.maxs[2] - fogVolume.mins[2];

      // uAngles becomes a scale matrix (diagonal = AABB size)
      gl.uniformMatrix3fv(program.uAngles, false, new Float32Array([
        sizeX, 0, 0,
        0, sizeY, 0,
        0, 0, sizeZ,
      ]));
      gl.uniform3f(program.uOrigin, fogVolume.mins[0], fogVolume.mins[1], fogVolume.mins[2]);

      this._getFogCubeVBO();

      // Bind the fog cube VAO directly instead of through GL.BindVAO/UnbindVAO.
      // GL.UnbindVAO() disables vertex attributes on the default VAO and clears
      // GL.currentProgram, which breaks subsequent submodel fog volumes that
      // rely on the default VAO having aPosition enabled from beginFogVolumePass.
      gl.bindVertexArray(this.#fogCubeVAO);
      R.c_brush_vbos++;

      gl.drawArrays(gl.TRIANGLES, 0, 36);
      gl.bindVertexArray(null);
      R.c_brush_draws++;
    } else {
      // Submodel fog volume: use the submodel's own VBO
      const submodel = worldmodel.submodels[fogVolume.modelIndex - 1];

      if (!submodel || !submodel.cmds) {
        return;
      }

      gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
      gl.uniformMatrix3fv(program.uAngles, false, GL.identity);

      gl.bindBuffer(gl.ARRAY_BUFFER, submodel.cmds);
      R.c_brush_vbos++;
      gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 80, 0);

      if (submodel.chains) {
        for (const chain of submodel.chains) {
          gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
          R.c_brush_draws++;
        }
      }
    }
  }

  /**
   * Cleanup GL state after fog volume rendering.
   */
  endFogVolumePass() {
    // Restore GL state for subsequent passes (turbulents, particles, etc.).
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.cullFace(gl.FRONT);
    gl.enable(gl.CULL_FACE);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    gl.disable(gl.BLEND);

    // Reattach depth texture to FBO
    PostProcess.endDepthSampling();
    this._fogVolumeProgram = null;
  }

  // eslint-disable-next-line no-unused-vars
  cleanupRenderState(_pass = 0) {
    // Brush models clean up their own state per-entity
    // No shared cleanup needed at this level
  }

  /**
   * Prepare brush model for rendering (build display lists, upload to GPU).
   * Handles both world models (using leafs) and entity models (using chains).
   * @param {BrushModel} model The brush model to prepare
   * @param {boolean} [isWorldModel] True if this is the actual world map (model index 1)
   */
  prepareModel(model, isWorldModel = false) {
    const m = model;

    // Clean up existing buffer if present
    if (m.cmds && typeof m.cmds === 'object' && m.cmds !== null) {
      gl.deleteBuffer(m.cmds);
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
   * Build display lists for regular brush entities (doors, platforms, etc).
   * Uses chains structure to group surfaces by texture.
   * @private
   * @param {BrushModel} m The brush model
   */
  _buildBrushModelDisplayLists(m) {
    const cmds = [];
    const styles = [0.0, 0.0, 0.0, 0.0];
    const turbulentFallbackCache = new Map();
    let verts = 0;
    let cutoff = 0;
    m.chains = [];

    // Build opaque surfaces (non-sky, non-turbulent)
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i];
      if (texture.flags & materialFlags.MF_SKY || texture.flags & materialFlags.MF_TURBULENT) {
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
          // Position (12 bytes)
          cmds.push(vert[0], vert[1], vert[2]);
          // TexCoord (16 bytes)
          cmds.push(vert[3], vert[4], vert[5], vert[6]);
          // LightStyle (16 bytes)
          cmds.push(styles[0], styles[1], styles[2], styles[3]);
          // Normal (12 bytes) + Tangent/Bitangent placeholders (24 bytes)
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
      const texture = m.textures[i];
      if (!(texture.flags & materialFlags.MF_TURBULENT)) {
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
        const faceFallbackLight = hasLightmap ? null : this._getTurbulentFallbackFaceLight(m, surf, turbulentFallbackCache);
        chain[2] += surf.verts.length;
        for (let k = 0; k < surf.verts.length; k++) {
          const vert = surf.verts[k];
          const fallbackLight = hasLightmap
            ? [0.0, 0.0, 0.0]
            : BrushModelRenderer.blendTurbulentFallbackLight(
              this._getTurbulentFallbackLight(m, surf, new Vector(vert[0], vert[1], vert[2]), turbulentFallbackCache),
              faceFallbackLight,
              TURBULENT_FALLBACK_FACE_BLEND,
            );
          const dlightTexCoordS = vert[5];
          const dlightTexCoordT = vert[6];
          // Position (12 bytes)
          cmds.push(vert[0], vert[1], vert[2]);
          // TexCoord (16 bytes) keeps the lightmap atlas UVs for dlights.
          cmds.push(vert[3], vert[4], dlightTexCoordS, dlightTexCoordT);
          // LightStyle (16 bytes)
          cmds.push(styles[0], styles[1], styles[2], styles[3]);
          // aNormal carries per-vertex fallback light for no-lightmap turbulents.
          cmds.push(fallbackLight[0], fallbackLight[1], fallbackLight[2]);
          // aTangent carries dynamic-light atlas UVs and the baked-lightmap flag.
          cmds.push(dlightTexCoordS, dlightTexCoordT, hasLightmap ? 1.0 : 0.0, 0.0, 0.0, 0.0);
        }
      }
      if (chain[2] !== 0) {
        m.chains.push(chain);
        verts += chain[2];
      }
    }

    // Calculate tangents and bitangents for PBR normal mapping
    Mesh.CalculateTangentBitangents(cmds, cutoff);

    // Upload to GPU
    m.cmds = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);

    // Create VAOs for opaque (offset 0) and turbulent (offset waterchain) passes
    m.opaqueVAO = this._createBrushVAO(m.cmds, 0);
    m.turbulentVAO = this._createBrushVAO(m.cmds, m.waterchain);
  }

  /**
   * Expand arbitrary bounds to contain all vertices of a surface.
   * @private
   * @param {Vector} mins Mutable bounds minimum
   * @param {Vector} maxs Mutable bounds maximum
   * @param {Array<number[]>} verts The surface's vertex array
   */
  _expandBounds(mins, maxs, verts) {
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
   * Expand a leaf's bounding box to contain all vertices of a surface.
   * BSP leaf bounds represent only the leaf's convex volume, but surfaces
   * assigned via marksurfaces can extend beyond it. Without expansion,
   * frustum culling incorrectly rejects leafs whose geometry is visible.
   * @private
   * @param {Node} leaf The leaf whose bounds to expand
   * @param {Array<number[]>} verts The surface's vertex array
   */
  _expandLeafBoundsForSurface(leaf, verts) {
    this._expandBounds(leaf.mins, leaf.maxs, verts);
  }

  /**
   * Build display lists for the world model.
   * Uses leafs structure for visibility-based rendering.
   * @private
   * @param {BrushModel} m The world model
   */
  _buildWorldModelDisplayLists(m) {
    if (m.cmds !== null) {
      return; // Already built
    }

    m.resetWorldRenderState();

    const cmds = [];
    const styles = [0.0, 0.0, 0.0, 0.0];
    const turbulentFallbackCache = new Map();
    let verts = 0;
    let cutoff = 0;

    // Build opaque surfaces (non-sky, non-turbulent) organized by leaf
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i];
      if ((texture.flags & materialFlags.MF_SKY) || (texture.flags & materialFlags.MF_TURBULENT)) {
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
          this._expandLeafBoundsForSurface(leaf, surf.verts);
          chain[2] += surf.verts.length;
          for (let l = 0; l < surf.verts.length; l++) {
            const vert = surf.verts[l];
            // Position (12 bytes)
            cmds.push(vert[0], vert[1], vert[2]);
            // TexCoord (16 bytes)
            cmds.push(vert[3], vert[4], vert[5], vert[6]);
            // LightStyle (16 bytes)
            cmds.push(styles[0], styles[1], styles[2], styles[3]);
            // Normal (12 bytes) + Tangent/Bitangent placeholders (24 bytes)
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
      const texture = m.textures[i];
      if (!(texture.flags & materialFlags.MF_SKY)) {
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
          this._expandLeafBoundsForSurface(leaf, surf.verts);
          chain[1] += surf.verts.length;
          for (let l = 0; l < surf.verts.length; l++) {
            const vert = surf.verts[l];
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
      const texture = m.textures[i];
      if (!(texture.flags & materialFlags.MF_TURBULENT)) {
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
          const faceFallbackLight = hasLightmap ? null : this._getTurbulentFallbackFaceLight(m, surf, turbulentFallbackCache);
          this._expandLeafBoundsForSurface(leaf, surf.verts);
          this._expandBounds(chainMins, chainMaxs, surf.verts);
          chain[2] += surf.verts.length;
          for (let l = 0; l < surf.verts.length; l++) {
            const vert = surf.verts[l];
            const fallbackLight = hasLightmap
              ? [0.0, 0.0, 0.0]
              : BrushModelRenderer.blendTurbulentFallbackLight(
                this._getTurbulentFallbackLight(m, surf, new Vector(vert[0], vert[1], vert[2]), turbulentFallbackCache),
                faceFallbackLight,
                TURBULENT_FALLBACK_FACE_BLEND,
              );
            const dlightTexCoordS = vert[5];
            const dlightTexCoordT = vert[6];
            // Position (12 bytes)
            cmds.push(vert[0], vert[1], vert[2]);
            // TexCoord (16 bytes) keeps the lightmap atlas UVs for dlights.
            cmds.push(vert[3], vert[4], dlightTexCoordS, dlightTexCoordT);
            // LightStyle (16 bytes)
            cmds.push(styles[0], styles[1], styles[2], styles[3]);
            // aNormal carries per-vertex fallback light for no-lightmap turbulents.
            cmds.push(fallbackLight[0], fallbackLight[1], fallbackLight[2]);
            // aTangent carries dynamic-light atlas UVs and the baked-lightmap flag.
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

    // Calculate tangents and bitangents for PBR normal mapping
    Mesh.CalculateTangentBitangents(cmds, cutoff);

    // Upload to GPU
    m.cmds = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);

    // Create VAOs for opaque (offset 0) and turbulent (offset waterchain) passes
    m.opaqueVAO = this._createBrushVAO(m.cmds, 0);
    m.turbulentVAO = this._createBrushVAO(m.cmds, m.waterchain);
  }

  _buildSurfaceDisplayList(model, face) {
    face.verts = [];
    if (face.numedges < 3) {
      return;
    }
    const texinfo = model.texinfo[face.texinfo];
    const texture = model.textures[texinfo.texture];
    for (let i = 0; i < face.numedges; i++) {
      const index = model.surfedges[face.firstedge + i];
      let vec;
      if (index > 0) {
        vec = model.vertexes[model.edges[index][0]];
      } else {
        vec = model.vertexes[model.edges[-index][1]];
      }
      const vert = [vec[0], vec[1], vec[2]];
      if (face.sky !== true) {
        const s = vec.dot(new Vector(...texinfo.vecs[0])) + texinfo.vecs[0][3];
        const t = vec.dot(new Vector(...texinfo.vecs[1])) + texinfo.vecs[1][3];
        vert[3] = s / texture.width;
        vert[4] = t / texture.height;
        vert[5] = (s - face.texturemins[0] + (face.light_s << face.lmshift) + (1 << (face.lmshift - 1))) / (LIGHTMAP_BLOCK_SIZE * (1 << face.lmshift));
        vert[6] = (t - face.texturemins[1] + (face.light_t << face.lmshift) + (1 << (face.lmshift - 1))) / (LIGHTMAP_BLOCK_SIZE * (1 << face.lmshift));
      }
      if (i >= 3) {
        face.verts[face.verts.length] = face.verts[0];
        face.verts[face.verts.length] = face.verts[face.verts.length - 2];
      }
      face.verts[face.verts.length] = vert;
    }
  }

  /**
   * @private
   * @param {BrushModel} model Model containing the face.
   * @param {import('../../common/model/BaseModel.mjs').Face} face Turbulent face being packed.
   * @returns {boolean} True when the face has usable baked lightmap samples.
   */
  _surfaceHasTurbulentLightmap(model, face) {
    if (face.styles.length === 0 || face.lightofs < 0) {
      return false;
    }

    if (model.version === 38 && face.lightofs === 0) {
      return false;
    }

    return true;
  }

  /**
   * @private
   * @param {import('../../common/model/BaseModel.mjs').Face} face Turbulent face being packed.
   * @param {Vector} worldPos Vertex position used for the fallback sample.
   * @returns {string} Cache key shared by coplanar turbulent edges.
   */
  _getTurbulentFallbackCacheKey(face, worldPos) {
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
   * @private
   * @param {BrushModel} model Model containing the face.
   * @param {import('../../common/model/BaseModel.mjs').Face} face Turbulent face being packed.
   * @returns {Vector} Approximate center used for face-level fallback smoothing.
   */
  _getTurbulentFallbackFaceCenter(model, face) {
    const center = new Vector(0.0, 0.0, 0.0);

    for (let i = 0; i < face.numedges; i++) {
      const surfEdgeIndex = model.surfedges[face.firstedge + i];
      const vertex = surfEdgeIndex > 0
        ? model.vertexes[model.edges[surfEdgeIndex][0]]
        : model.vertexes[model.edges[-surfEdgeIndex][1]];
      center.add(vertex);
    }

    center.multiply(1.0 / Math.max(face.numedges, 1));
    return center;
  }

  /**
   * @private
   * @param {BrushModel} model Model containing the face.
   * @param {import('../../common/model/BaseModel.mjs').Face} face Turbulent face being packed.
   * @param {Map<string, number[]>} cache Shared per-model fallback cache.
   * @returns {number[]} Face-level fallback color.
   */
  _getTurbulentFallbackFaceLight(model, face, cache) {
    const faceCenter = this._getTurbulentFallbackFaceCenter(model, face);
    return this._getTurbulentFallbackLight(model, face, faceCenter, cache);
  }

  /**
   * @private
   * @param {BrushModel} model Model containing the face.
   * @param {import('../../common/model/BaseModel.mjs').Face} face Turbulent face being packed.
   * @param {Vector} worldPos Vertex position used for the fallback sample.
   * @param {Map<string, number[]>} [cache] Shared per-model fallback cache.
   * @returns {number[]} Vertex-level fallback light color.
   */
  _getTurbulentFallbackLight(model, face, worldPos, cache = null) {
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

  /**
   * Free GPU resources for this brush model.
   * Uses global `gl` from registry.
   * @param {BrushModel} model The brush model to cleanup
   */
  cleanupModel(model) {
    if (model.opaqueVAO) {
      gl.deleteVertexArray(model.opaqueVAO);
      model.opaqueVAO = null;
    }
    if (model.turbulentVAO) {
      gl.deleteVertexArray(model.turbulentVAO);
      model.turbulentVAO = null;
    }
    if (model.cmds) {
      gl.deleteBuffer(model.cmds);
      model.cmds = null;
    }

    // Free fog light probe textures when world model is cleaned up
    if (model.fogVolumes && model.fogVolumes.length > 0) {
      this._freeFogLightProbes();
    }
  }
}
