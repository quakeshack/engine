import Vector from '../../shared/Vector.ts';
import Cvar from '../common/Cvar.ts';
import * as Def from '../common/Def.ts';

import { eventBus } from '../common/EventBus.ts';
import Chase from './Chase.ts';
import VID from './VID.ts';
import GL, { ATTRIB_LOCATIONS, GLCubeTexture, GLRenderTexture, GLTexture, GLTextureArray } from './GL.ts';
import { content } from '../../shared/Defs.ts';
import { modelRendererRegistry } from './renderer/models/ModelRendererRegistry.ts';
import type { ModelRenderer } from './renderer/models/ModelRenderer.ts';
import { BrushModelRenderer } from './renderer/models/BrushModelRenderer.ts';
import { LIGHTMAP_BLOCK_HEIGHT, LIGHTMAP_BLOCK_SIZE } from './renderer/lighting/LightmapAtlas.ts';
import { AliasModelRenderer } from './renderer/models/AliasModelRenderer.ts';
import { SpriteModelRenderer } from './renderer/models/SpriteModelRenderer.ts';
import { MeshModelRenderer } from './renderer/models/MeshModelRenderer.ts';
import Draw from './Draw.ts';
import { BrushModel, type FogVolumeInfo, Node, type WorldTurbulentChainInfo, revealedVisibility } from '../common/model/BSP.ts';
import { MeshModel } from '../common/model/MeshModel.ts';
import { SpriteModel } from '../common/model/SpriteModel.ts';
import { type Face, Plane } from '../common/model/BaseModel.ts';
import PostProcess from './renderer/postprocess/PostProcess.ts';
import BloomEffect from './renderer/postprocess/BloomEffect.ts';
import ColorGradeEffect from './renderer/postprocess/ColorGradeEffect.ts';
import BlurEffect from './renderer/postprocess/BlurEffect.ts';
import WarpEffect from './renderer/postprocess/WarpEffect.ts';
import UnderwaterFogEffect from './renderer/postprocess/UnderwaterFogEffect.ts';
import ShadowMap from './renderer/lighting/ShadowMap.ts';
import { ClientDlight, ClientEdict } from './ClientEntities.ts';
import { SkyRenderer } from './renderer/scene/Sky.ts';
import LightStyles from './renderer/lighting/LightStyles.ts';
import LightSampler from './renderer/lighting/LightSampler.ts';
import rendererCvars from './renderer/resources/RendererCvars.ts';
import Particles, { type Particle } from './renderer/effects/Particles.ts';
import Decals, { type Decal } from './renderer/effects/Decals.ts';
import { clientRuntimeState } from './ClientState.ts';
import clientCvars from './ClientCvars.ts';
import { clientCollision } from './ClientPhysics.ts';
import SCR from './SCR.ts';
import V from './V.ts';
import Sys from './Sys.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

interface SortKindDistance {
  readonly dist: number;
  readonly kind: TransparentKind;
}

const enum TransparentKind {
  WorldLeaf = 0,
  Turbulent = 1,
  FogVolume = 2,
  Entity = 3,
  Sprite = 4,
  Decal = 5,
  Particle = 6,
}

interface DynamicLightSurfaceImpact {
  readonly distanceToPlane: number;
  readonly impact: Vector;
}

interface TransparentItem extends SortKindDistance {
  readonly data: Node | WorldTurbulentChainInfo | FogVolumeInfo | ClientEdict | Particle | Decal;
}

interface RefdefRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RefdefState {
  vrect: RefdefRect;
  vieworg: Vector;
  viewangles: Vector;
  fov_x: number;
  fov_y: number;
}

type Vec4 = [number, number, number, number];

const FOG_TURBULENT_SORT_EPSILON = 0.0001;

/**
 * Resolve deterministic tie-break priority for transparent item kinds.
 * @returns Higher values are sorted earlier on near-equal depth.
 */
function getTransparentKindPriority(kind: TransparentKind): number {
  switch (kind) {
  case TransparentKind.FogVolume:
    return 7;
  case TransparentKind.Turbulent:
    return 6;
  case TransparentKind.WorldLeaf:
    return 5;
  case TransparentKind.Entity:
    return 4;
  case TransparentKind.Sprite:
    return 3;
  case TransparentKind.Decal:
    return 2;
  case TransparentKind.Particle:
    return 1;
  default:
    return 0;
  }
}

/**
 * Compare unified transparent items for a single back-to-front pass.
 * Distances sort far-to-near. Near ties use deterministic kind priority,
 * with fog volumes before turbulent surfaces so liquid can blend over fog.
 * @returns Sort comparator result.
 */
export function compareTransparentItems(itemA: SortKindDistance, itemB: SortKindDistance): number {
  const distDelta = itemB.dist - itemA.dist;

  if (Math.abs(distDelta) > FOG_TURBULENT_SORT_EPSILON) {
    return distDelta;
  }

  return getTransparentKindPriority(itemB.kind) - getTransparentKindPriority(itemA.kind);
}

class R {
  /**
   * The `r_interpolation` console variable, which `Materials` still reads through the renderer.
   * @deprecated Moved to `rendererCvars.interpolation`; goes away with `RenderContext` (Phase 5 of plans/r-split.md).
   * @returns The console variable.
   */
  static get interpolation(): Cvar {
    return rendererCvars.interpolation;
  }

  // light

  static dlightframecount = 0;

  static waterwarp: Cvar = null!;
  static drawentities: Cvar = null!;
  static drawviewmodel: Cvar = null!;
  static drawturbulents: Cvar = null!;
  static underwater_fog_density: Cvar = null!;
  static novis: Cvar = null!;
  static speeds: Cvar = null!;
  static polyblend: Cvar = null!;
  static flashblend: Cvar = null!;
  static nocolors: Cvar = null!;
  static bloom: Cvar = null!;
  static bloomStrength: Cvar = null!;
  static bloomSkyStrength: Cvar = null!;
  static bloomDlightStrength: Cvar = null!;
  static bloomSpecularStrength: Cvar = null!;
  static bloomDownsample: Cvar = null!;
  static bloomDebug: Cvar = null!;
  static fog_color: Cvar = null!;
  static fog_start: Cvar = null!;
  static fog_end: Cvar = null!;
  static fog_density: Cvar = null!;
  static fog_mode: Cvar = null!;

  static notexture: GLTexture = null!;
  static blacktexture: GLTexture = null!;
  static flatnormalmap: GLTexture = null!;
  static deluxemap_texture: GLTextureArray = null!;
  static lightmap_texture: GLTextureArray = null!;
  static dlightmap_rgba_texture: GLRenderTexture = null!;
  static fullbright_texture: GLTextureArray = null!;
  static null_texture: GLRenderTexture = null!;
  static normal_up_texture: GLTextureArray = null!;
  static shadow_texture: GLRenderTexture | null = null;
  static point_shadow_textures: GLCubeTexture[] = [];
  static dlightVAO: WebGLVertexArrayObject = null!;

  static usePostProcess = false;

  /** RGB fog color used by the underwater fog effect this frame (0-1 range). */
  static underwaterFogColor: [number, number, number] = [0.05, 0.15, 0.2];

  /** Fog density exponent used by the underwater fog effect this frame. */
  static underwaterFogDensity = 0.05;
  static allocated: number[] = [];
  static c_brush_verts = 0;
  static c_brush_tris = 0;
  static c_brush_draws = 0;
  static c_brush_vbos = 0;
  static c_brush_texture_binds = 0;
  static c_alias_polys = 0;

  static RenderDlights() {
    if (R.flashblend.value === 0) {
      return;
    }
    R.dlightframecount++;
    gl.enable(gl.BLEND);
    const program = GL.UseProgram('dlight')!; let a;
    console.assert(program !== null, 'dlight program required');
    GL.BindVAO(R.dlightVAO);
    for (let i = 0; i < Def.limits.dlights; i++) {
      const l = clientRuntimeState.clientEntities.dlights[i];
      if ((l.die < clientRuntimeState.time) || (l.radius === 0.0)) {
        continue;
      }
      if (l.origin.copy().subtract(R.refdef.vieworg).len() < (l.radius * 0.35)) {
        a = l.radius * 0.0003;
        V.blend[3] += a * (1.0 - V.blend[3]);
        a /= V.blend[3];
        V.blend[0] = V.blend[1] * (1.0 - a) + (255.0 * a);
        V.blend[1] = V.blend[1] * (1.0 - a) + (127.5 * a);
        V.blend[2] *= 1.0 - a;
        continue;
      }
      gl.uniform3fv(program.uOrigin!, l.origin);
      gl.uniform1f(program.uRadius!, l.radius);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 18);
    }
    GL.UnbindVAO();
    gl.disable(gl.BLEND);
  };

  /**
   * Returns a known point on the face plane for dynamic-light projection.
   * @returns A known point on the surface plane.
   */
  static GetDynamicLightSurfacePoint(surf: Face): Vector {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const surfedge = worldmodel.surfedges[surf.firstedge!];

    if (surfedge >= 0) {
      return worldmodel.vertexes[worldmodel.edges[surfedge][0]].copy();
    }

    return worldmodel.vertexes[worldmodel.edges[-surfedge][1]].copy();
  };

  /**
   * Projects a dynamic light onto a face plane when the light is in front of the surface.
   * @returns Surface-plane hit information when the light is in front of the face.
   */
  static GetDynamicLightSurfaceImpact(light: ClientDlight, surf: Face): DynamicLightSurfaceImpact | null {
    const faceNormal = surf.normal!.copy();
    const surfacePoint = R.GetDynamicLightSurfacePoint(surf);
    const distanceToPlane = light.origin.copy().subtract(surfacePoint).dot(faceNormal);

    if (distanceToPlane <= 0.0 || distanceToPlane >= light.radius) {
      return null;
    }

    const impact = light.origin.copy().subtract(faceNormal.copy().multiply(distanceToPlane));

    return { distanceToPlane, impact };
  };

  /**
   * Returns whether the light can see the face at the projected impact point.
   * @returns True when the light has line of sight to the surface.
   */
  static IsDynamicLightSurfaceVisible(light: ClientDlight, surf: Face, impact: Vector): boolean {
    const end = impact.copy().add(surf.normal!.copy().multiply(1.0));
    const trace = clientCollision.traceStaticWorldLine(light.origin, end);

    return !trace.startsolid && !trace.allsolid && trace.fraction === 1.0;
  };

  /**
   * Propagates a dynamic light through the BSP and marks touched faces.
   */
  static MarkLights(light: ClientDlight, bit: number, node: Node): void {
    if (node.contents < content.CONTENT_NONE) {
      return;
    }
    const plane = node.plane!;
    console.assert(plane !== null, 'node plane required');
    const normal = plane.normal;
    const dist = light.origin.dot(normal) - plane.dist;
    if (dist > light.radius) {
      const frontChild = node.children[0] as Node;
      console.assert(frontChild instanceof Node, `R.MarkLights expected linked BSP child 0 on node ${node.num}`);
      R.MarkLights(light, bit, frontChild);
      return;
    }
    if (dist < -light.radius) {
      const backChild = node.children[1] as Node;
      console.assert(backChild instanceof Node, `R.MarkLights expected linked BSP child 1 on node ${node.num}`);
      R.MarkLights(light, bit, backChild);
      return;
    }
    for (const surf of node.facesIter()) {
      if (surf.sky) {
        continue;
      }

      const lightImpact = R.GetDynamicLightSurfaceImpact(light, surf);

      if (lightImpact === null || !R.IsDynamicLightSurfaceVisible(light, surf, lightImpact.impact)) {
        continue;
      }

      if (surf.dlightframe !== (R.dlightframecount + 1)) {
        surf.dlightbits = 0;
        surf.dlightframe = R.dlightframecount + 1;
      }
      surf.dlightbits |= bit;
    }
    const frontChild = node.children[0] as Node;
    const backChild = node.children[1] as Node;
    console.assert(frontChild instanceof Node, `R.MarkLights expected linked BSP child 0 on node ${node.num}`);
    console.assert(backChild instanceof Node, `R.MarkLights expected linked BSP child 1 on node ${node.num}`);
    R.MarkLights(light, bit, frontChild);
    R.MarkLights(light, bit, backChild);
  };

  static PushDlights() {
    if (R.flashblend.value !== 0) {
      return;
    }

    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    for (let i = 0; i < LIGHTMAP_BLOCK_SIZE; i++) {
      R.lightmap_modified[i] = 0;
    }

    let bit = 1;

    for (let i = 0; i < Def.limits.dlights; i++) {
      const l = clientRuntimeState.clientEntities.dlights[i];

      if (!l.isFree()) {
        R.MarkLights(l, bit, worldmodel.nodes[0]);
        for (const ent of clientRuntimeState.clientEntities.getVisibleEntities()) {
          if (ent.model === null) {
            continue;
          }
          if (!(ent.model instanceof BrushModel) || !ent.model.submodel) {
            continue;
          }
          const firstClipNode = ent.model.hulls[0]?.firstclipnode;
          const submodelNode = firstClipNode !== undefined ? worldmodel.nodes[firstClipNode] : null;

          if (submodelNode !== undefined && submodelNode !== null) {
            R.MarkLights(l, bit, submodelNode);
          }
        }
      }
      bit += bit;
    }

    let surf;
    for (let i = 0; i < worldmodel.faces.length; i++) {
      surf = worldmodel.faces[i];
      if (surf.dlightframe === R.dlightframecount) {
        R.RemoveDynamicLights(surf);
      } else if (surf.dlightframe === (R.dlightframecount + 1)) {
        R.AddDynamicLights(surf);
      }
    }

    R.dlightmap_rgba_texture.bind(0);
    for (let i = 0; i < LIGHTMAP_BLOCK_SIZE; i++) {
      if (!R.lightmap_modified[i]) {
        continue;
      }
      for (let j = LIGHTMAP_BLOCK_SIZE - 1; j >= i; j--) {
        if (!R.lightmap_modified[j]) {
          continue;
        }
        const dlightmapsRgba = R.dlightmaps_rgba!;
        console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, i, LIGHTMAP_BLOCK_SIZE, j - i + 1, gl.RGBA, gl.UNSIGNED_BYTE, dlightmapsRgba.subarray(i * LIGHTMAP_BLOCK_SIZE * 4, (j + 1) * LIGHTMAP_BLOCK_SIZE * 4));
        break;
      }
      break;
    }

    R.dlightframecount++;
  };

  // main

  static visframecount = 0;

  static frustum: Plane[] = [
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
    new Plane(new Vector(), 0),
  ];

  static vup = new Vector();
  static vpn = new Vector();
  static vright = new Vector();

  static refdef: RefdefState = {
    vrect: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    },
    vieworg: new Vector(),
    viewangles: new Vector(),
    fov_x: 0,
    fov_y: 0,
  };

  static oldviewleaf: Node | null = null;

  static CullBox(mins: Vector, maxs: Vector): boolean {
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[0]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[1]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[2]) === 2) {
      return true;
    }
    if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[3]) === 2) {
      return true;
    }
    return false;
  };

  static DrawEntitiesOnList() {
    if (R.drawentities.value === 0) {
      return;
    }

    // Group entities by renderer for batched rendering without numeric type dispatch.
    const entitiesByRenderer = new Map<ModelRenderer, ClientEdict[]>();

    for (const entity of clientRuntimeState.clientEntities.getVisibleEntities()) {
      if (entity.model === null || entity.alpha === 0.0) {
        continue;
      }

      const renderer = modelRendererRegistry.getRendererForModel(entity.model);
      if (renderer === null) {
        continue;
      }

      if (!entitiesByRenderer.has(renderer)) {
        entitiesByRenderer.set(renderer, []);
      }
      entitiesByRenderer.get(renderer)!.push(entity);
    }

    // Pass 0: Opaque models.
    for (const [renderer, entities] of entitiesByRenderer) {
      renderer.setupRenderState(0);
      for (const entity of entities) {
        const model = entity.model!;
        console.assert(model !== null, 'entity model required for opaque pass');

        if (!renderer.rendersOpaquePass(model, entity)) {
          continue;
        }

        renderer.render(model, entity, 0);
      }
      renderer.cleanupRenderState(0);
    }
    GL.StreamFlush();
  };

  /**
   * Linear nearest-neighbor search over pre-built liquid fog anchors.
   * Returns the fog tint of the closest anchor to `vieworg`, or null if none exist.
   * @returns Fog tint in 0–1 RGB range, or null.
   */
  static #nearestLiquidFogTint(worldmodel: BrushModel, vieworg: Vector): [number, number, number] | null {
    const anchors = worldmodel.liquidFogAnchors;
    if (anchors.length === 0) {
      return null;
    }

    let bestTint = anchors[0].fogTint;
    let bestDist = Number.MAX_VALUE;

    for (let i = 0; i < anchors.length; i++) {
      const c = anchors[i].center;
      const dx = c[0] - vieworg[0];
      const dy = c[1] - vieworg[1];
      const dz = c[2] - vieworg[2];
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestTint = anchors[i].fogTint;
      }
    }

    return bestTint;
  }

  /**
   * Compute transparent sort distance for an entity.
   * We currently sort entities by origin distance for consistency with prior
   * behavior and because model bounds are not uniformly available here.
   * @returns Euclidean distance from view origin to entity origin.
   */
  private static _getEntityTransparentDistance(entity: ClientEdict, vieworg: Vector): number {
    const dx = entity.origin[0] - vieworg[0];
    const dy = entity.origin[1] - vieworg[1];
    const dz = entity.origin[2] - vieworg[2];

    return Math.hypot(dx, dy, dz);
  }

  /**
   * Render all blended geometry in a single back-to-front sorted pass.
   */
  static _renderTransparentsUnified(worldEntity: ClientEdict): void {
    const worldmodel = worldEntity.model instanceof BrushModel ? worldEntity.model : null;
    const vieworg = R.refdef.vieworg;
    const items: TransparentItem[] = [];

    const brushRenderer = worldmodel !== null
      ? modelRendererRegistry.getRendererForModelClass(BrushModel) as BrushModelRenderer
      : null;
    if (worldmodel !== null) {
      console.assert(brushRenderer !== null, 'brush renderer required');

      const worldLeaves = brushRenderer!.getWorldTransparentLeaves(worldmodel, vieworg);
      for (let i = 0; i < worldLeaves.length; i++) {
        items.push({ dist: worldLeaves[i].dist, kind: TransparentKind.WorldLeaf, data: worldLeaves[i].leaf });
      }

      if (R.drawturbulents.value !== 0) {
        const turbulentChains = brushRenderer!.getWorldTurbulentChains(worldmodel, vieworg);
        for (let i = 0; i < turbulentChains.length; i++) {
          items.push({ dist: turbulentChains[i].dist, kind: TransparentKind.Turbulent, data: turbulentChains[i].chain });
        }
      }

      if (PostProcess.active && worldmodel.fogVolumes && worldmodel.fogVolumes.length > 0) {
        const fogItems = brushRenderer!.getFogVolumeItems(worldmodel, vieworg);
        for (let i = 0; i < fogItems.length; i++) {
          items.push({ dist: fogItems[i].dist, kind: TransparentKind.FogVolume, data: fogItems[i].fogVolume });
        }
      }
    }

    Decals.PruneExpired();
    for (let i = 0; i < Decals.list.length; i++) {
      const decal = Decals.list[i];
      const dx = decal.origin[0] - vieworg[0];
      const dy = decal.origin[1] - vieworg[1];
      const dz = decal.origin[2] - vieworg[2];
      items.push({
        dist: Math.hypot(dx, dy, dz),
        kind: TransparentKind.Decal,
        data: decal,
      });
    }

    for (let i = 0; i < Particles.numparticles; i++) {
      const particle = Particles.particles[i];
      if (particle.die < clientRuntimeState.time) {
        continue;
      }

      const dx = particle.org[0] - vieworg[0];
      const dy = particle.org[1] - vieworg[1];
      const dz = particle.org[2] - vieworg[2];
      items.push({
        dist: Math.hypot(dx, dy, dz),
        kind: TransparentKind.Particle,
        data: particle,
      });
    }

    if (R.drawentities.value !== 0) {
      const spriteRenderer = modelRendererRegistry.getRendererForModelClass(SpriteModel);

      for (const entity of clientRuntimeState.clientEntities.getVisibleEntities()) {
        if (entity.model === null || entity.alpha === 0.0) {
          continue;
        }

        const renderer = modelRendererRegistry.getRendererForModel(entity.model);
        console.assert(renderer !== null, `renderer required for ${entity.model.constructor.name}`);

        if (renderer === spriteRenderer) {
          items.push({
            dist: R._getEntityTransparentDistance(entity, vieworg),
            kind: TransparentKind.Sprite,
            data: entity,
          });
          continue;
        }

        if (!renderer!.rendersTransparentPass(entity.model, entity)) {
          continue;
        }

        items.push({
          dist: R._getEntityTransparentDistance(entity, vieworg),
          kind: TransparentKind.Entity,
          data: entity,
        });
      }
    }

    if (items.length === 0) {
      return;
    }

    items.sort(compareTransparentItems);

    gl.depthMask(false);

    const spriteRenderer = modelRendererRegistry.getRendererForModelClass(SpriteModel);
    let currentDecalTexture: GLTexture | null = null;
    const particleFrame = Particles.BeginFrame();
    let activeKind: TransparentKind | -1 = -1;

    const endActivePass = (): void => {
      switch (activeKind) {
      case TransparentKind.WorldLeaf:
        brushRenderer?.endWorldTransparentPass();
        GL.StreamFlush();
        break;
      case TransparentKind.Turbulent:
        brushRenderer?.endWorldTurbulentPass();
        break;
      case TransparentKind.FogVolume:
        brushRenderer?.endFogVolumePass();
        break;
      case TransparentKind.Entity:
        GL.StreamFlush();
        break;
      case TransparentKind.Sprite:
        if (spriteRenderer !== null) {
          spriteRenderer.cleanupRenderState(1);
        }
        GL.StreamFlush();
        break;
      case TransparentKind.Decal:
        GL.StreamFlush();
        break;
      case TransparentKind.Particle:
        GL.StreamFlush();
        break;
      default:
        break;
      }

      activeKind = -1;
    };

    const beginKindPass = (kind: TransparentKind): boolean => {
      gl.enable(gl.BLEND);
      gl.depthMask(false);

      switch (kind) {
      case TransparentKind.WorldLeaf:
        if (brushRenderer === null || worldmodel === null) {
          return false;
        }
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        brushRenderer.beginWorldTransparentPass(worldmodel);
        return true;
      case TransparentKind.Turbulent:
        if (brushRenderer === null || worldmodel === null) {
          return false;
        }
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        brushRenderer.beginWorldTurbulentPass(worldmodel);
        return true;
      case TransparentKind.FogVolume:
        if (brushRenderer === null || worldmodel === null) {
          return false;
        }
        if (!brushRenderer.beginFogVolumePass(worldmodel)) {
          gl.enable(gl.CULL_FACE);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          return false;
        }
        return true;
      case TransparentKind.Entity:
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        return true;
      case TransparentKind.Sprite:
        gl.enable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        if (spriteRenderer !== null) {
          spriteRenderer.setupRenderState(1);
          return true;
        }
        return false;
      case TransparentKind.Decal: {
        gl.disable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        const program = GL.UseProgram('decal')!;
        console.assert(program !== null, 'decal program required');
        gl.uniform1f(program.uAlpha!, 1.0);
        currentDecalTexture = null;
        return true;
      }
      case TransparentKind.Particle:
        gl.disable(gl.CULL_FACE);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        GL.UseProgram('particle');
        return true;
      default:
        return false;
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.kind !== activeKind) {
        endActivePass();
        if (!beginKindPass(item.kind)) {
          continue;
        }
        activeKind = item.kind;
      }

      switch (item.kind) {
      case TransparentKind.WorldLeaf:
        if (brushRenderer === null || worldmodel === null) {
          break;
        }
        brushRenderer.renderWorldTransparentLeaf(worldmodel, item.data as Node);
        break;
      case TransparentKind.Turbulent:
        if (brushRenderer === null || worldmodel === null) {
          break;
        }
        brushRenderer.renderWorldTurbulentChain(worldmodel, item.data as WorldTurbulentChainInfo);
        break;
      case TransparentKind.FogVolume:
        if (brushRenderer === null || worldmodel === null) {
          break;
        }
        brushRenderer.renderSingleFogVolume(worldmodel, item.data as FogVolumeInfo);
        break;
      case TransparentKind.Entity: {
        const entity = item.data as ClientEdict;
        if (entity.model === null) {
          break;
        }

        const renderer = modelRendererRegistry.getRendererForModel(entity.model);
        console.assert(renderer !== null, `renderer required for ${entity.model.constructor.name}`);

        renderer!.setupRenderState(2);
        renderer!.render(entity.model, entity, 2);
        renderer!.cleanupRenderState(2);
        GL.StreamFlush();
        break;
      }
      case TransparentKind.Sprite: {
        const entity = item.data as ClientEdict;
        if (entity.model === null || spriteRenderer === null) {
          break;
        }

        spriteRenderer.render(entity.model, entity, 1);
        break;
      }
      case TransparentKind.Decal: {
        const decal = item.data as Decal;
        const program = GL.UseProgram('decal')!;
        console.assert(program !== null, 'decal program required');

        if (decal.texture !== currentDecalTexture) {
          GL.StreamFlush();
          decal.texture.bind(program.tTexture!);
          currentDecalTexture = decal.texture;
        }

        Decals.EmitQuad(decal);
        break;
      }
      case TransparentKind.Particle: {
        const particle = item.data as Particle;
        if (particle.die < clientRuntimeState.time) {
          break;
        }

        Particles.RenderAndAdvance(particle, particleFrame);

        break;
      }
      default:
        break;
      }
    }

    endActivePass();
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  };

  static DrawViewModel() {
    if (R.drawviewmodel.value === 0) {
      return;
    }
    if (Chase.active.value !== 0) {
      return;
    }
    if (R.drawentities.value === 0) {
      return;
    }

    const viewmodel = clientRuntimeState.gameAPI?.viewmodel ?? null;

    if (viewmodel === null) {
      return;
    }

    if (!viewmodel.visible) {
      return; // game says to not draw the view model
    }

    if (!viewmodel.model) {
      return; // no model to draw
    }

    gl.depthRange(0.0, 0.3);

    let ymax = 4.0 * Math.tan(SCR.fov.value * 0.82 * Math.PI / 360.0);
    R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
    R.perspective[5] = 4.0 / ymax;
    let program = GL.UseProgram('alias')!;
    console.assert(program !== null, 'alias program required');
    gl.uniformMatrix4fv(program.uPerspective!, false, R.perspective);

    const viewent = clientRuntimeState.viewent;
    if (viewent !== null && viewent.model !== null) {
      const aliasRenderer = modelRendererRegistry.getRendererForModel(viewent.model);
      console.assert(aliasRenderer !== null, 'alias renderer required');
      aliasRenderer!.setupRenderState(0);
      aliasRenderer!.render(viewent.model, viewent, 0);
      aliasRenderer!.cleanupRenderState(0);
    }

    ymax = 4.0 * Math.tan(R.refdef.fov_y * Math.PI / 360.0);
    R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
    R.perspective[5] = 4.0 / ymax;
    program = GL.UseProgram('alias')!;
    console.assert(program !== null, 'alias program required');
    gl.uniformMatrix4fv(program.uPerspective!, false, R.perspective);

    gl.depthRange(0.0, 1.0);
  };

  static PolyBlend() {
    if (R.polyblend.value === 0) {
      return;
    }
    if (V.blend[3] === 0.0) {
      return;
    }
    GL.UseProgram('fill', true);
    const vrect = R.refdef.vrect;
    GL.StreamDrawColoredQuad(vrect.x, vrect.y, vrect.width, vrect.height, V.blend[0], V.blend[1], V.blend[2], V.blend[3] * 255.0);
  };

  static SetFrustum() {
    if (R.vup.isOrigin() || R.vright.isOrigin() || R.vpn.isOrigin()) { // can’t set frustum with these
      return;
    }
    R.frustum[0].normal = R.vup.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_x * 0.5));
    R.frustum[1].normal = R.vup.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_x * 0.5);
    R.frustum[2].normal = R.vright.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_y * 0.5);
    R.frustum[3].normal = R.vright.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_y * 0.5));
    for (let i = 0; i < 4; i++) {
      const out = R.frustum[i];
      out.type = 5;
      out.dist = R.refdef.vieworg.dot(out.normal);
      out.signbits = 0;
      if (out.normal[0] < 0.0) {
        out.signbits = 1;
      }
      if (out.normal[1] < 0.0) {
        out.signbits += 2;
      }
      if (out.normal[2] < 0.0) {
        out.signbits += 4;
      }
      if (out.normal[3] < 0.0) {
        out.signbits += 8;
      }
    }
  };

  static viewMatrix: number[] | null = null;
  static projectionMatrix: number[] | null = null;

  private static multiplyMatrixVec4(m: number[], v: Vec4): Vec4 {
    return [
      m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
      m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
      m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
      m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
    ];
  }

  /**
   * Convert a world-space position into screen coordinates.
   * @returns Screen coordinates or null when the point is off-screen.
   */
  static WorldToScreen(origin: Vector): Vector | null {
    const projectionMatrix = R.projectionMatrix;
    const viewMatrix = R.viewMatrix; // This is uViewAngles — rotation only

    if (projectionMatrix === null || viewMatrix === null) {
      return null;
    }

    // world-space delta from camera
    const delta = [
      origin[0] - R.refdef.vieworg[0],
      origin[1] - R.refdef.vieworg[1],
      origin[2] - R.refdef.vieworg[2],
    ];

    // Apply view rotation
    const x =
      viewMatrix[0] * delta[0] +
      viewMatrix[4] * delta[1] +
      viewMatrix[8] * delta[2];
    const y =
      viewMatrix[1] * delta[0] +
      viewMatrix[5] * delta[1] +
      viewMatrix[9] * delta[2];
    const z =
      viewMatrix[2] * delta[0] +
      viewMatrix[6] * delta[1] +
      viewMatrix[10] * delta[2];

    // Mimic gl_Position = projection * vec4(xz, -y, 1.0)
    const posVec = [x, z, -y, 1.0]; // Swizzle + flip Y

    const clip = R.multiplyMatrixVec4(projectionMatrix, posVec as Vec4);

    // If the clip space W coordinate is zero, we can't convert to NDC
    if (clip[3] === 0) {
      return null;
    }

    const ndc = [
      clip[0] / clip[3],
      clip[1] / clip[3],
      clip[2] / clip[3],
    ];

    if (clip[3] > 0 && ndc[0] >= -1 && ndc[0] <= 1 && ndc[1] >= -1 && ndc[1] <= 1 && ndc[2] >= 0 && ndc[2] <= 1) {
      return new Vector(
        R.refdef.vrect.x + (ndc[0] + 1) * 0.5 * R.refdef.vrect.width,
        R.refdef.vrect.y + (1 - ndc[1]) * 0.5 * R.refdef.vrect.height,
        ndc[2],
      );
    }

    return null;
  };

  static perspective = [
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, -65540.0 / 65532.0, -1.0,
    0.0, 0.0, -524288.0 / 65532.0, 0.0,
  ];

  static Perspective() {
    const viewangles = [
      R.refdef.viewangles[0] * Math.PI / 180.0,
      (R.refdef.viewangles[1] - 90.0) * Math.PI / -180.0,
      R.refdef.viewangles[2] * Math.PI / -180.0,
    ];
    const sp = Math.sin(viewangles[0]);
    const cp = Math.cos(viewangles[0]);
    const sy = Math.sin(viewangles[1]);
    const cy = Math.cos(viewangles[1]);
    const sr = Math.sin(viewangles[2]);
    const cr = Math.cos(viewangles[2]);
    const viewMatrix = [
      cr * cy + sr * sp * sy,		cp * sy,	-sr * cy + cr * sp * sy,
      cr * -sy + sr * sp * cy,	cp * cy,	-sr * -sy + cr * sp * cy,
      sr * cp,					-sp,		cr * cp,
    ];

    R.viewMatrix = [
      viewMatrix[0], viewMatrix[1], viewMatrix[2], 0.0,
      viewMatrix[3], viewMatrix[4], viewMatrix[5], 0.0,
      viewMatrix[6], viewMatrix[7], viewMatrix[8], 0.0,
      0.0,           0.0,           0.0,           1.0,
    ];

    R.projectionMatrix = R.perspective;

    if (V.gamma.value < 0.5) {
      V.gamma.set(0.5);
    } else if (V.gamma.value > 1.0) {
      V.gamma.set(1.0);
    }

    GL.UnbindProgram();
    for (let i = 0; i < GL.programs.length; i++) {
      const program = GL.programs[i];
      gl.useProgram(program.program);
      if (program.uViewOrigin !== undefined) {
        gl.uniform3fv(program.uViewOrigin, R.refdef.vieworg);
      }
      if (program.uViewAngles !== undefined) {
        gl.uniformMatrix3fv(program.uViewAngles, false, viewMatrix);
      }
      if (program.uPerspective !== undefined) {
        gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);
      }
      if (program.uGamma !== undefined) {
        gl.uniform1f(program.uGamma, V.gamma.value);
      }
      // global fog uniforms (only set when shader declares them)
      if (program.uFogColor !== undefined) {
        const colParts = (R.fog_color.string || '128 128 128').split(/\s+/).map(Number);
        gl.uniform3fv(program.uFogColor, [(colParts[0]||128)/255.0, (colParts[1]||128)/255.0, (colParts[2]||128)/255.0]);
      }
      if (program.uFogParams !== undefined) {
        // uFogParams = vec4(start, end, density, mode)
        gl.uniform4f(program.uFogParams, R.fog_start.value, R.fog_end.value, R.fog_density.value, R.fog_mode.value);
      }
      // shadow mapping uniforms (set on all programs that declare them)
      if (program.uLightSpaceMatrix !== undefined) {
        gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, ShadowMap.topdownMatrix);
      }
      if (program.uShadowEnabled !== undefined) {
        gl.uniform1f(program.uShadowEnabled, ShadowMap.enabled!.value ? 1.0 : 0.0);
      }
      if (program.uShadowDarkness !== undefined) {
        gl.uniform1f(program.uShadowDarkness, ShadowMap.darkness!.value);
      }
      if (program.uShadowMapSize !== undefined) {
        gl.uniform1f(program.uShadowMapSize, ShadowMap.size);
      }
      if (program.uShadowMaxDepthNDC !== undefined) {
        // Convert the world-unit max-depth cvar into the top-down shadow
        // map's normalized [0,1] depth space (which spans 2 * range world
        // units — see ShadowMap.updateTopDownMatrix's near/far planes).
        gl.uniform1f(program.uShadowMaxDepthNDC, ShadowMap.maxDepth!.value / (2.0 * ShadowMap.range!.value));
      }
      if (program.uShadowLightDir !== undefined) {
        gl.uniform3fv(program.uShadowLightDir, ShadowMap.lightDir);
      }
      // Point light shadow uniforms
      if (program.uPointShadowEnabled !== undefined) {
        gl.uniform1f(program.uPointShadowEnabled, ShadowMap.pointLightActiveCount > 0 ? 1.0 : 0.0);
      }
      if (program.uPointLightPos0 !== undefined) {
        gl.uniform3fv(program.uPointLightPos0, ShadowMap.pointLightOrigins[0]);
      }
      if (program.uPointLightRadius0 !== undefined) {
        gl.uniform1f(program.uPointLightRadius0, ShadowMap.pointLightRadii[0]);
      }
      if (program.uPointLightColor0 !== undefined) {
        gl.uniform3fv(program.uPointLightColor0, ShadowMap.pointLightColors[0]);
      }
      if (program.uPointLightPos1 !== undefined) {
        gl.uniform3fv(program.uPointLightPos1, ShadowMap.pointLightOrigins[1]);
      }
      if (program.uPointLightRadius1 !== undefined) {
        gl.uniform1f(program.uPointLightRadius1, ShadowMap.pointLightRadii[1]);
      }
      if (program.uPointLightColor1 !== undefined) {
        gl.uniform3fv(program.uPointLightColor1, ShadowMap.pointLightColors[1]);
      }
      if (program.uPointLightPos2 !== undefined) {
        gl.uniform3fv(program.uPointLightPos2, ShadowMap.pointLightOrigins[2]);
      }
      if (program.uPointLightRadius2 !== undefined) {
        gl.uniform1f(program.uPointLightRadius2, ShadowMap.pointLightRadii[2]);
      }
      if (program.uPointLightColor2 !== undefined) {
        gl.uniform3fv(program.uPointLightColor2, ShadowMap.pointLightColors[2]);
      }
      if (program.uPointShadowBias !== undefined) {
        gl.uniform1f(program.uPointShadowBias, ShadowMap.pointBias!.value);
      }
    }
  };

  static SetupGL() {
    const vrect = R.refdef.vrect;
    const pixelRatio = VID.pixelRatio;
    const w = (vrect.width * pixelRatio) >> 0;
    const h = (vrect.height * pixelRatio) >> 0;

    if (R.usePostProcess || PostProcess.hasActiveEffects()) {
      // Render the scene to the shared post-process capture FBO whenever a
      // screen-space effect needs to sample it. Depth-aware passes like fog
      // use the same capture path and sample the depth texture mid-frame.
      PostProcess.resize(w, h);
      PostProcess.begin();
      gl.viewport(0, 0, w, h);
    } else {
      gl.viewport((vrect.x * pixelRatio) >> 0, ((VID.height - vrect.height - vrect.y) * pixelRatio) >> 0, w, h);
    }
    R.Perspective();
    gl.enable(gl.DEPTH_TEST);
  };

  static viewleaf: Node | null = null;

  static PreRenderScene() {
    LightStyles.Animate();
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const {forward, right, up} = R.refdef.viewangles.angleVectors();
    [R.vpn, R.vright, R.vup] = [forward, right, up];
    R.viewleaf = worldmodel.getLeafForPoint(R.refdef.vieworg);
    V.SetContentsColor(R.viewleaf.contents);
    V.CalcBlend();
    // Underwater warp is a post-process effect, active while the camera is inside a liquid.
    const warpEffect = PostProcess.getEffect('warp');
    if (warpEffect) {
      warpEffect.active = (R.waterwarp.value !== 0) && (R.viewleaf.contents <= content.CONTENT_WATER);
    }

    const bloomEnabled = R.bloom.value !== 0;
    const bloomEffect = PostProcess.getEffect('bloom');
    if (!bloomEnabled) {
      BloomEffect.invalidateHistory();
    }
    if (bloomEffect) {
      bloomEffect.active = bloomEnabled;
    }

    // Configure underwater fog when the camera is inside a liquid.
    // Opt-in per map: worldspawn key _qs_waterfog must be "1" to enable.
    const waterfogEnabled = worldmodel.worldspawnInfo._qs_waterfog === '1';
    const isUnderwater = R.viewleaf.contents <= content.CONTENT_WATER;
    const underwaterFogEffect = PostProcess.getEffect('underwater-fog');
    if (underwaterFogEffect) {
      underwaterFogEffect.active = waterfogEnabled && isUnderwater && R.drawturbulents.value !== 0;
    }
    if (isUnderwater) {
      // Look up fog tint in priority order:
      //   1. First turbulent chain visible from the viewleaf (direct hit).
      //   2. Nearest spatial anchor built at load time — covers narrow passages
      //      where no surface is in view, and correctly distinguishes between
      //      multiple distinct liquid bodies of the same content type.
      //   3. Hardcoded content-type defaults as a last resort.
      const firstChain = R.viewleaf.turbulentChains[0];
      const material = firstChain !== undefined
        ? worldmodel.textures[firstChain.texture]
        : undefined;

      let fogTint = material?.fogTint ?? null;

      if (fogTint === null) {
        fogTint = R.#nearestLiquidFogTint(worldmodel, R.refdef.vieworg);
      }

      if (fogTint !== null) {
        R.underwaterFogColor = fogTint;
      } else if (R.viewleaf.contents <= content.CONTENT_LAVA) {
        R.underwaterFogColor = [0.25, 0.05, 0.0];
      } else if (R.viewleaf.contents <= content.CONTENT_SLIME) {
        R.underwaterFogColor = [0.02, 0.12, 0.0];
      } else {
        R.underwaterFogColor = [0.05, 0.15, 0.2];
      }
      R.underwaterFogDensity = R.underwater_fog_density.value;
    }

    // Enable post-process FBO (and thus depth texture) whenever turbulents, fog
    // volumes, or underwater fog are active so shaders can sample scene depth.
    R.usePostProcess = R.drawturbulents.value !== 0 || worldmodel.fogVolumes.length > 0
      || (waterfogEnabled && isUnderwater && R.drawturbulents.value !== 0);

    // Choose the shadow textures for this frame (real or dummy)
    R.shadow_texture = ShadowMap.getActiveTopDownTexture();
    R.point_shadow_textures = ShadowMap.getActivePointTextures();
  };

  static RenderWorld() {
    // Render world and entities using the renderer registry
    const worldEntity = clientRuntimeState.clientEntities.getEntity(0);
    if (worldEntity && worldEntity.model) {
      const brushRenderer = modelRendererRegistry.getRendererForModelClass(BrushModel);
      console.assert(brushRenderer !== null, 'brush renderer required');
      // Pass 0: World opaque surfaces
      brushRenderer!.render(worldEntity.model, worldEntity, 0);
    }

    // Draw all other entities (pass 0 opaque only).
    R.DrawEntitiesOnList();

    gl.disable(gl.CULL_FACE);
    R.RenderDlights();

    if (worldEntity && worldEntity.model) {
      gl.enable(gl.CULL_FACE);
      R._renderTransparentsUnified(worldEntity);
      gl.disable(gl.CULL_FACE);
    } else {
      Decals.Draw();
      Particles.Draw();
    }
  };

  static RenderScene() {
    R.SetFrustum();
    console.assert(ShadowMap.enabled !== null, 'shadow toggle required');

    // Top-down shadow pass — a single fixed-direction directional shadow,
    // centered on the camera. World and entities both cast into it.
    if (ShadowMap.enabled!.value) {
      ShadowMap.renderTopDownShadow(R.refdef.vieworg);
    }
    R.shadow_texture = ShadowMap.getActiveTopDownTexture();

    // Point light shadow pass — render world BSP into a cube depth map per
    // active point-light slot, from the strongest nearby dlights' positions.
    if (ShadowMap.selectPointLights(R.refdef.vieworg) > 0) {
      ShadowMap.renderPointLightShadow();
    }
    // Update point shadow textures AFTER selectPointLights so the correct
    // textures (real or dummy) are bound for this frame. PreRenderScene
    // runs before selectPointLights updates pointLightActiveCount, so its
    // assignment may be stale on the first frame a dlight appears.
    R.point_shadow_textures = ShadowMap.getActivePointTextures();

    R.SetupGL();
    R.MarkLeafs();

    // Turbulent boundary depth pre-pass — capture turbulent surface depths so the
    // underwater fog effect knows where the water boundary is per pixel.
    if (PostProcess.getEffect('underwater-fog')?.active && PostProcess.active) {
      const worldEntity = clientRuntimeState.clientEntities.getEntity(0);
      const worldmodel = worldEntity?.model instanceof BrushModel ? worldEntity.model : null;
      const brushRenderer = worldmodel !== null
        ? modelRendererRegistry.getRendererForModelClass(BrushModel) as BrushModelRenderer | null
        : null;
      if (brushRenderer !== null && worldmodel !== null) {
        PostProcess.beginTurbulentBoundaryPass();
        brushRenderer.renderWorldTurbulentsBoundaryDepth(worldmodel);
        PostProcess.endTurbulentBoundaryPass();
      }
    }

    gl.enable(gl.CULL_FACE);
    R.DrawSkyBox();
    R.DrawViewModel();
    R.RenderWorld();
  };

  static _speeds: string[] = [];

  static RenderView() {
    let time1 = 0;
    if (R.speeds.value !== 0) {
      gl.finish();
      time1 = Sys.FloatMilliTime();
    }
    R.c_brush_verts = 0;
    R.c_brush_tris = 0;
    R.c_brush_draws = 0;
    R.c_brush_vbos = 0;
    R.c_brush_texture_binds = 0;  // Track texture binding overhead
    R.c_alias_polys = 0;
    gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
    R.RenderScene();
    if (R.speeds.value !== 0) {
      const c_brush_polys = R.c_brush_verts / 3;
      const c_alias_polys = R.c_alias_polys;
      const avgTrisPerDraw = (R.c_brush_tris / R.c_brush_draws).toFixed(1);

      R._speeds[0] = `${R.c_brush_draws.toFixed().padStart(5)} draw calls`;
      R._speeds[1] = `${R.c_brush_tris.toFixed().padStart(5)} tris, ${R.c_brush_verts.toFixed().padStart(5)} verts`;
      R._speeds[2] = `${R.c_brush_vbos.toFixed().padStart(5)} VBOs used, ${R.c_brush_texture_binds.toFixed().padStart(5)} texture binds`;
      R._speeds[3] = `${c_alias_polys.toFixed().padStart(5)} alias polys, ${c_brush_polys.toFixed().padStart(5)} brush polys`;
      R._speeds[4] = '';
      R._speeds[5] = `Avg ${avgTrisPerDraw} tris/draw, time: ${((Sys.FloatMilliTime() - time1)).toFixed(1)} msec`;
    }
  };

  static PrintSpeeds() {
    if (!R.speeds.value) {
      return;
    }

    Draw.String(16, 16, `${SCR.FPS.toFixed(1)} FPS`, 2.0);

    for (let i = 0; i < R._speeds.length; i++) {
      Draw.String(16, 40 + i * 8, R._speeds[i]);
    }
  };

  // misc

  static InitTextures() {
    // make a default texture (a red and black checkerboard)
    const data = new Uint8Array(new ArrayBuffer(256 * 4));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        data[((i << 4) + j) * 4 + 0] = 255;
        data[((i << 4) + j) * 4 + 1] = 0;
        data[((i << 4) + j) * 4 + 2] = 0;
        data[((i << 4) + j) * 4 + 3] = 255;

        data[(136 + (i << 4) + j) * 4 + 0] = 255;
        data[(136 + (i << 4) + j) * 4 + 1] = 0;
        data[(136 + (i << 4) + j) * 4 + 2] = 0;
        data[(136 + (i << 4) + j) * 4 + 3] = 255;

        data[(8 + (i << 4) + j) * 4 + 0] = 0;
        data[(8 + (i << 4) + j) * 4 + 1] = 0;
        data[(8 + (i << 4) + j) * 4 + 2] = 0;
        data[(8 + (i << 4) + j) * 4 + 3] = 255;

        data[(128 + (i << 4) + j) * 4 + 0] = 0;
        data[(128 + (i << 4) + j) * 4 + 1] = 0;
        data[(128 + (i << 4) + j) * 4 + 2] = 0;
        data[(128 + (i << 4) + j) * 4 + 3] = 255;
      }
    }

    R.notexture = GLTexture.Allocate('r_notexture', 16, 16, data);
    R.blacktexture = GLTexture.Allocate('r_blacktexture', 1, 1, new Uint8Array([0, 0, 0, 255]));
    R.flatnormalmap = GLTexture.Allocate('r_flatnormalmap', 1, 1, new Uint8Array([128, 128, 255, 255]));

    R.deluxemap_texture = new GLTextureArray();
    R.deluxemap_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 3);

    R.lightmap_texture = new GLTextureArray();
    R.lightmap_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 3);

    R.dlightmap_rgba_texture = new GLRenderTexture();
    R.dlightmap_rgba_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE);

    LightStyles.Init();

    R.fullbright_texture = new GLTextureArray();
    R.fullbright_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 3);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 3, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([
      255, 0, 0, 0, // layer 0 (R): lightstyle 0 at full
      255, 0, 0, 0, // layer 1 (G): lightstyle 0 at full
      255, 0, 0, 0, // layer 2 (B): lightstyle 0 at full
    ]));

    R.null_texture = new GLRenderTexture();
    R.null_texture.bind(0);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    R.normal_up_texture = new GLTextureArray();
    R.normal_up_texture.bind(0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 3);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 3, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([
      128, 0, 0, 0, // layer 0 (X): neutral
      255, 0, 0, 0, // layer 1 (Y): full (up direction)
      128, 0, 0, 0, // layer 2 (Z): neutral
    ]));

    eventBus.publish('renderer.textures.initialized');
  };

  static async InitShaders(): Promise<void> {
    // rendering alias models
    await Promise.all([
      Promise.resolve(GL.CreateProgram('alias',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPositionA', gl.FLOAT, 3],
          ['aPositionB', gl.FLOAT, 3],
          ['aNormal', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
        ],
        ['tTexture', 'tLuminance', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering mesh models (OBJ, IQM, GLTF)
      Promise.resolve(GL.CreateProgram('mesh',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
        [
          ['aPosition', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
          ['aNormal', gl.FLOAT, 3],
        ],
        ['tTexture', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering brush models (water is down below)
      Promise.resolve(GL.CreateProgram('brush',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uLightstyleInterpolation', 'uAlpha', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uHaveDeluxemap', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMapSize', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightColor0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightColor1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointLightColor2', 'uPointShadowEnabled', 'uBloomEmissiveScale', 'uBloomDlightScale', 'uBloomSpecularScale'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            ['aTangent', gl.FLOAT, 3],
            ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTextureA', 'tTextureB', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tLuminance', 'tSpecular', 'tNormal', 'tDeluxemap', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // rendering dynamic lights
      Promise.resolve(GL.CreateProgram('dlight',
          ['uOrigin', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uRadius', 'uGamma'],
          [['aPosition', gl.FLOAT, 3]],
          [])),

      // rendering the player model (similar to alias model but with custom colors)
      Promise.resolve(GL.CreateProgram('player',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uDynamicLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uDynamicShadeLight', 'uInterpolation', 'uAlpha', 'uTime', 'uTop', 'uBottom', 'uFogColor', 'uFogParams', 'uLightSpaceMatrix', 'uShadowEnabled', 'uShadowDarkness', 'uShadowMaxDepthNDC', 'uShadowLightDir', 'uPointLightPos0', 'uPointLightRadius0', 'uPointLightPos1', 'uPointLightRadius1', 'uPointLightPos2', 'uPointLightRadius2', 'uPointShadowEnabled', 'uBloomEmissiveScale'],
          [
            ['aPositionA', gl.FLOAT, 3],
            ['aPositionB', gl.FLOAT, 3],
            ['aNormal', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 2],
          ],
          ['tTexture', 'tLuminance', 'tPlayer', 'tShadowMap', 'tPointShadowMap0', 'tPointShadowMap1', 'tPointShadowMap2'])),

      // for rendering sprites (usually effects)
      Promise.resolve(GL.CreateProgram('sprite',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams', 'uInterpolation', 'uAlpha', 'uBloomEmissiveScale'],
          [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2]],
          ['tTexture'])),

      // for rendering decals
      Promise.resolve(GL.CreateProgram('decal',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
          [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
          ['tTexture'])),

      // for rendering particles (colored round dots)
      Promise.resolve(GL.CreateProgram('particle',
        ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
          [['aOrigin', gl.FLOAT, 3], ['aCoord', gl.FLOAT, 2], ['aScale', gl.FLOAT, 1], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
          [])),

      // rendering water brushes
      Promise.resolve(GL.CreateProgram('turbulent',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uTime', 'uInterpolation', 'uLightstyleInterpolation', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uAlpha', 'uBloomEmissiveScale', 'uBloomDlightScale', 'uScreenSize', 'uWaterFogDensity', 'uCameraInside'],
          [
            ['aPosition', gl.FLOAT, 3],
            ['aTexCoord', gl.FLOAT, 4],
            ['aLightStyle', gl.FLOAT, 4],
            ['aNormal', gl.FLOAT, 3],
            // ['aTangent', gl.FLOAT, 3],
            // ['aBitangent', gl.FLOAT, 3],
          ],
          ['tTexture', 'tLuminance', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tDeluxemap', 'tDepth'])),

      // depth-only pre-pass for turbulent surface boundary (underwater fog)
      Promise.resolve(GL.CreateProgram('turbulent-depth',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uTime'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // underwater fog post-process effect
      Promise.resolve(GL.CreateProgram('underwater-fog',
        ['uOrtho', 'uFogColor', 'uFogDensity', 'uPerspective'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tScene', 'tDepth', 'tBoundaryDepth'])),

      // warp overlay effect
      Promise.resolve(GL.CreateProgram('warp',
          ['uOrtho', 'uTime'],
          [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
          ['tTexture'])),

      Promise.resolve(GL.CreateProgram('color-grade',
        ['uOrtho', 'uTime', 'uSaturation', 'uContrast', 'uExposure', 'uTintColor', 'uTintStrength', 'uPulseStrength', 'uPulsePeriod'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('blur',
        ['uOrtho', 'uDirection', 'uRadius'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-extract',
        ['uOrtho', 'uTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-blur',
        ['uOrtho', 'uTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-metric',
        ['uOrtho', 'uCoverageThreshold'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture'])),

      Promise.resolve(GL.CreateProgram('bloom-adapt',
        ['uOrtho', 'uFrameTime', 'uSettleRate', 'uRecoverRate', 'uFirstFrame', 'uMinMultiplier', 'uBrightnessStart', 'uBrightnessEnd', 'uCoverageStart', 'uCoverageEnd'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tMetric', 'tPrevious'])),

      Promise.resolve(GL.CreateProgram('bloom-composite',
        ['uOrtho', 'uStrength', 'uBloomTexelOffset'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tScene', 'tBloom', 'tAdaptation'])),

      Promise.resolve(GL.CreateProgram('sky',
        ['uViewAngles', 'uPerspective', 'uScale', 'uGamma', 'uTime', 'uFogColor', 'uFogParams', 'uBloomEmissiveScale'],
        [['aPosition', gl.FLOAT, 3]],
        ['tSolid', 'tAlpha'])),

      Promise.resolve(GL.CreateProgram('sky-chain',
        ['uViewOrigin', 'uViewAngles', 'uPerspective'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // rendering volumetric fog brush volumes
      Promise.resolve(GL.CreateProgram('fog-volume',
        ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma',
         'uFogVolumeColor', 'uFogVolumeDensity', 'uFogVolumeMaxOpacity',
         'uFogVolumeMins', 'uFogVolumeMaxs', 'uScreenSize',
         'uDlightCount',
         'uDlightPos[0]', 'uDlightPos[1]', 'uDlightPos[2]', 'uDlightPos[3]',
         'uDlightPos[4]', 'uDlightPos[5]', 'uDlightPos[6]', 'uDlightPos[7]',
         'uDlightColor[0]', 'uDlightColor[1]', 'uDlightColor[2]', 'uDlightColor[3]',
         'uDlightColor[4]', 'uDlightColor[5]', 'uDlightColor[6]', 'uDlightColor[7]'],
        [['aPosition', gl.FLOAT, 3]],
        ['tDepth', 'tLightProbe'])),

      // shadow depth pass for the top-down directional shadow
      Promise.resolve(GL.CreateProgram('shadow-brush',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uCasterFade'],
        [['aPosition', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for point light cube shadow mapping
      Promise.resolve(GL.CreateProgram('shadow-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uLightPos', 'uLightRadius', 'uNormalBias', 'uCasterFade'],
        [['aPosition', gl.FLOAT, 3], ['aNormal', gl.FLOAT, 3]],
        [])),

      // shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation', 'uCasterFade'],
        [['aPositionA', gl.FLOAT, 3], ['aPositionB', gl.FLOAT, 3]],
        [])),

      // point shadow depth pass for alias models (frame interpolation)
      Promise.resolve(GL.CreateProgram('shadow-alias-point',
        ['uOrigin', 'uAngles', 'uLightSpaceMatrix', 'uInterpolation', 'uLightPos', 'uLightRadius', 'uNormalBias', 'uCasterFade'],
        [['aPositionA', gl.FLOAT, 3], ['aPositionB', gl.FLOAT, 3], ['aNormalA', gl.FLOAT, 3], ['aNormalB', gl.FLOAT, 3]],
        [])),
    ]);

    eventBus.publish('renderer.shaders.initialized');
  };

  static async Init() {
    R.waterwarp = new Cvar('r_waterwarp', '1');
    rendererCvars.fullbright = new Cvar('r_fullbright', '0', Cvar.FLAG.CHEAT);
    R.drawentities = new Cvar('r_drawentities', '1', Cvar.FLAG.CHEAT);
    R.drawviewmodel = new Cvar('r_drawviewmodel', '1');
    R.drawturbulents = new Cvar('r_drawturbulents', '1', Cvar.FLAG.CHEAT);
    R.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
    R.speeds = new Cvar('r_speeds', '0');
    R.polyblend = new Cvar('gl_polyblend', '1');
    R.flashblend = new Cvar('gl_flashblend', '0');
    R.nocolors = new Cvar('gl_nocolors', '0');
    R.bloom = new Cvar('r_bloom', '0', Cvar.FLAG.NONE, 'Screen-space bloom post-process, 0 = off, 1 = on.');
    R.bloomStrength = new Cvar('r_bloom_strength', '0.8', Cvar.FLAG.NONE, 'Additive bloom intensity.');
    R.bloomSkyStrength = new Cvar('r_bloom_sky_strength', '0.33', Cvar.FLAG.NONE, 'Sky contribution added to the bloom emissive target. Lower than 1 keeps the sky glow subtle.');
    R.bloomDlightStrength = new Cvar('r_bloom_dlight_strength', '0.33', Cvar.FLAG.NONE, 'Dynamic-light surface contribution added to the bloom emissive target. Set to 0 to disable.');
    R.bloomSpecularStrength = new Cvar('r_bloom_specular_strength', '0.33', Cvar.FLAG.NONE, 'Specular reflection contribution added to the bloom emissive target. Set to 0 to disable.');
    R.bloomDownsample = new Cvar('r_bloom_downsample', '4', Cvar.FLAG.NONE, 'Bloom buffer downsample divisor, clamped to 1-8.');
    R.bloomDebug = new Cvar('r_bloom_debug', '0', Cvar.FLAG.NONE, 'Bloom debug preview: 0 = off, 1 = emissive, 2 = extract, 3 = blur, 4 = all.');
    rendererCvars.interpolation = new Cvar('r_interpolation', '1', Cvar.FLAG.NONE, 'Interpolation of textures and animation groups, 0 - off, 1 - on');
    // fog controls (TODO: make that a cheat, but resetting cvar to default is done after R.NewMapFog, so need to rethink the order of operations)
    R.fog_color = new Cvar('r_fog_color', '128 128 128', Cvar.FLAG.NONE, 'Fog color: R G B (0-255)');
    R.fog_start = new Cvar('r_fog_start', '128', Cvar.FLAG.NONE, 'Fog start distance (linear)');
    R.fog_end = new Cvar('r_fog_end', '4096', Cvar.FLAG.NONE, 'Fog end distance (linear)');
    R.fog_density = new Cvar('r_fog_density', '0.01', Cvar.FLAG.NONE, 'Fog density (for exp/exp2)');
    R.fog_mode = new Cvar('r_fog_mode', '-1', Cvar.FLAG.NONE, 'Fog mode: 0=linear, 1=exp, 2=exp2, -1=disable');

    // fog controls for underwater fog effect (post-process)
    R.underwater_fog_density = new Cvar('r_underwater_fog_density', '0.01', Cvar.FLAG.CHEAT, 'Fog density exponent for the underwater fog effect.');

    R.InitTextures();
    Particles.Init();
    Decals.Init();
    await R.InitShaders();

    // Register model renderers
    modelRendererRegistry.register(new BrushModelRenderer());
    modelRendererRegistry.register(new AliasModelRenderer());
    modelRendererRegistry.register(new SpriteModelRenderer());
    modelRendererRegistry.register(new MeshModelRenderer());

    // Initialize post-process infrastructure (scene FBO with depth texture)
    // and register screen-space effects that resolve from that capture.
    PostProcess.init();
    PostProcess.addEffect(new BloomEffect());
    PostProcess.addEffect(new UnderwaterFogEffect());
    PostProcess.addEffect(new WarpEffect());
    PostProcess.addEffect(new ColorGradeEffect());
    PostProcess.addEffect(new BlurEffect());

    // Initialize shadow mapping (depth-only FBO + sun light)
    ShadowMap.init();

    const dlightvecs = gl.createBuffer();
    console.assert(dlightvecs !== null, 'Expected a dynamic light vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, dlightvecs);
    gl.bufferData(gl.ARRAY_BUFFER, (() => {
      const positions = [];

      // 1) The "down" vector
      positions.push(0, -1, 0);

      // 2) 16 equally spaced vectors around the circle in y=0 plane
      const numSegments = 16;
      for (let i = 0; i <= numSegments; i++) {
        // Angle in radians
        const angle = (2 * Math.PI * i) / numSegments;
        // Match the pattern: x = -sin(angle), z = cos(angle)
        positions.push(-Math.sin(angle), 0, Math.cos(angle));
      }

      return new Float32Array(positions);
    })(), gl.STATIC_DRAW);

    const dlightVAO = GL.CreateVAO(dlightvecs, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride: 0, offset: 0 },
    ]);

    Object.assign(R, { dlightVAO });

    R.ClearAll();
  };

  static NewMapFog() {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel must be loaded before InitFog');

    const fogInfo = worldmodel.worldspawnInfo.fog;

    if (!fogInfo) {
      R.fog_mode.set(-1);
      return;
    }

    const [exp, r, g, b] = fogInfo.split(/\s+/).map(Number);

    // CR: I took that calculation from Ironwail’s Fog_SetupFrame:
    const ExpAdjustment = 1.20112241; // sqrt(log2(e))
    const SphericalCorrection = 0.85; // compensate higher perceived density with spherical fog
    const DensityScale = ExpAdjustment * SphericalCorrection / 64.0;

    R.fog_density.set(exp / DensityScale);
    R.fog_color.set(`${r * 255} ${g * 255} ${b * 255}`);
    R.fog_mode.set(1);
  };

  static NewMap() {
    R.BuildLightmaps();

    const dlightmapsRgba = R.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');

    for (let i = 0; i < dlightmapsRgba.length; i++) {
      dlightmapsRgba[i] = 0;
    }

    R.dlightmap_rgba_texture.bind(0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, dlightmapsRgba);

    // Reset the viewleafs so that the renderer will recalculate them on the next frame.
    R.viewleaf = null;
    R.oldviewleaf = null;

    R.NewMapFog();
    R.MakeSky();
  };

  static ClearAll() {
    LightStyles.Clear();

    R.oldviewleaf = null;
    R.viewleaf = null;

    R.deluxemap = null;
    R.lightmaps_rgb = null;
    R.dlightmaps_rgba = null;

    R.allocated = [];

    R.shadow_texture = null;
    R.point_shadow_textures = [];

    Particles.Clear();
    Decals.Clear();
    R.ClearSky();
  };

  // surf

  static lightmap_modified = new Uint8Array(LIGHTMAP_BLOCK_SIZE);
  static lightmaps_rgb: Uint8Array | null = null; // allocated on demand
  static dlightmaps_rgba: Uint8Array | null = null; // allocated on demand
  static deluxemap: Uint8Array | null = null; // allocated on demand

  static AddDynamicLights(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const dlightmapsRgba = R.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;
    const size = smax * tmax;

    const blocklights: number[] = [];
    for (let i = 0; i < size * 3; i++) {
      blocklights[i] = 0;
    }

    for (let i = 0; i < Def.limits.dlights; i++) {
      if (((surf.dlightbits >>> i) & 1) === 0) {
        continue;
      }
      // Lights promoted to a point-shadow slot are excluded from this baked
      // sum — their contribution is instead computed analytically per-fragment
      // in the scene shaders and occluded by their own cube depth map, so
      // multiple nearby dlights correctly shadow each other independently
      // instead of only the single strongest one darkening the combined sum.
      if (ShadowMap.pointLightDlightIndices.includes(i)) {
        continue;
      }
      const light = clientRuntimeState.clientEntities.dlights[i];
      const lightImpact = R.GetDynamicLightSurfaceImpact(light, surf);

      if (lightImpact === null) {
        continue;
      }
      let dist = lightImpact.distanceToPlane;
      const rad = light.radius - dist;
      let minlight = light.minlight;
      if (rad < minlight) {
        continue;
      }
      minlight = rad - minlight;
      const impact = lightImpact.impact;
      const tex = worldmodel.texinfo[surf.texinfo];
      const local = [
        impact.dot(LightSampler.TextureAxisToVector(tex.vecs[0])) + tex.vecs[0][3] - surf.texturemins[0],
        impact.dot(LightSampler.TextureAxisToVector(tex.vecs[1])) + tex.vecs[1][3] - surf.texturemins[1],
      ];
      for (let t = 0; t < tmax; t++) {
        let td = local[1] - (t << lmshift);
        if (td < 0.0) {
          td = -td;
        }
        td = Math.floor(td);
        for (let s = 0; s < smax; s++) {
          let sd = local[0] - (s << lmshift);
          if (sd < 0) {
            sd = -sd;
          }
          sd = Math.floor(sd);
          if (sd > td) {
            dist = sd + (td >> 1);
          } else {
            dist = td + (sd >> 1);
          }
          if (dist < minlight) {
            const bl = Math.floor((rad - dist) * 256.0);
            const pos = (t * smax + s) * 3;
            for (let i = 0; i < 3; i++) {
              blocklights[pos + i] += bl * light.color[i];
            }
          }
        }
      }
    }

    for (let t = 0, i = 0; t < tmax; t++) {
      R.lightmap_modified[surf.light_t + t] = 1;
      const dest = ((surf.light_t + t) * LIGHTMAP_BLOCK_SIZE) + surf.light_s;
      for (let s = 0; s < smax; s++) {
        const dldest = (dest + s) * 4;
        const blrgb = [
          Math.min(Math.floor(blocklights[i * 3] / 128), 255),
          Math.min(Math.floor(blocklights[i * 3 + 1] / 128), 255),
          Math.min(Math.floor(blocklights[i * 3 + 2] / 128), 255),
        ];
        // console.log(blrgb);
        i++;
        for (let i = 0; i < 3; i++) {
          dlightmapsRgba[dldest + i] = blrgb[i];
        }
      }
    }
  };

  static RemoveDynamicLights(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const dlightmapsRgba = R.dlightmaps_rgba!;
    console.assert(dlightmapsRgba !== null, 'dynamic lightmap buffer required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;
    for (let t = 0; t < tmax; t++) {
      R.lightmap_modified[surf.light_t + t] = 1;
      const dest = ((surf.light_t + t) * LIGHTMAP_BLOCK_SIZE) + surf.light_s;
      for (let s = 0; s < smax; s++) {
        const dldest = (dest + s) * 4;
        for (let i = 0; i < 3; i++) {
          dlightmapsRgba[dldest + i] = 0;
        }
        dlightmapsRgba[dldest + 3] = 255; // fully opaque
      }
    }
  };

  static BuildLightMap(currentmodel: BrushModel, surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const lightmapsRgb = R.lightmaps_rgb!;
    console.assert(lightmapsRgb !== null, 'lightmap buffer required');
    const lightdata = currentmodel.lightdata!;
    console.assert(lightdata !== null, 'brush lightdata required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;

    for (let k = 0; k < 3; k++) {
      const offset = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * k;
      let lightmap = surf.lightofs;
      let maps;

      for (maps = 0; maps < surf.styles.length; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = lightdata[lightmap + j];
          }
          lightmap += smax;
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }

      for (; maps < 4; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = 0;
          }
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }
    }
  };

  static BuildLightMapEx(currentmodel: BrushModel, surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const lightmapsRgb = R.lightmaps_rgb!;
    console.assert(lightmapsRgb !== null, 'lightmap buffer required');
    const lightdataRgb = currentmodel.lightdata_rgb!;
    console.assert(lightdataRgb !== null, 'brush rgb lightdata required');
    const smax = (surf.extents[0] >> lmshift) + 1;
    const tmax = (surf.extents[1] >> lmshift) + 1;

    if (currentmodel.deluxemap && !R.deluxemap) {
      R.deluxemap = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * 3));
    }

    for (let k = 0; k < 3; k++) {
      const offset = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * k;
      let lightmap = surf.lightofs * 3;
      let maps;

      for (maps = 0; maps < surf.styles.length; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = lightdataRgb[(lightmap + j * 3) + k];

            if (currentmodel.deluxemap) {
              R.deluxemap![dest + (j << 2) + offset] = currentmodel.deluxemap[(lightmap + j * 3) + k];
            }
          }
          lightmap += smax * 3;
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }

      for (; maps < 4; maps++) {
        let dest = (surf.light_t * LIGHTMAP_BLOCK_HEIGHT) + (surf.light_s << 2) + maps;
        for (let i = 0; i < tmax; i++) {
          for (let j = 0; j < smax; j++) {
            lightmapsRgb[dest + (j << 2) + offset] = 0;

            if (currentmodel.deluxemap) {
              R.deluxemap![dest + (j << 2) + offset] = 0;
            }
          }
          dest += LIGHTMAP_BLOCK_HEIGHT;
        }
      }
    }
  };

  static RecursiveWorldNode(node: Node): void {
    if (node.contents === content.CONTENT_SOLID) {
      return;
    }
    if (node.contents < content.CONTENT_NONE) {
      if (node.markvisframe !== R.visframecount) {
        return;
      }
      node.visframe = R.visframecount;
      if (node.skychain !== node.waterchain) {
        R.drawsky = true;
      }
      return;
    }
    const frontChild = node.children[0] as Node;
    const backChild = node.children[1] as Node;
    console.assert(frontChild instanceof Node, `R.RecursiveWorldNode expected linked BSP child 0 on node ${node.num}`);
    console.assert(backChild instanceof Node, `R.RecursiveWorldNode expected linked BSP child 1 on node ${node.num}`);
    R.RecursiveWorldNode(frontChild);
    R.RecursiveWorldNode(backChild);
  };

  static MarkLeafs() {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    if ((R.oldviewleaf === R.viewleaf) && (R.novis.value === 0)) {
      return;
    }
    R.visframecount++;
    R.oldviewleaf = R.viewleaf;
    const vis = (R.novis.value === 1 || R.viewleaf === null || R.viewleaf.num === 0) ? revealedVisibility : (
      R.novis.value === 2 ?
        worldmodel.getPhsByLeaf(R.viewleaf) :
        worldmodel.getPvsByLeaf(R.viewleaf)
    );
    for (let i = 1; i < worldmodel.leafs.length; i++) {
      if (!vis.isRevealed(i)) {
        continue;
      }
      if (clientCvars.areaportals.value > 0 && R.viewleaf && !worldmodel.areaPortals.leafsConnected(R.viewleaf, worldmodel.leafs[i])) {
        continue;
      }
      for (let node: Node | null = worldmodel.leafs[i]; node !== null; node = node.parent) {
        if (node.markvisframe === R.visframecount) {
          break;
        }
        node.markvisframe = R.visframecount;
      }
    }
    do {
      if (R.novis.value !== 0 || R.viewleaf === null) {
        break;
      }
      const p = R.refdef.vieworg.copy();
      let leaf: Node;
      if (R.viewleaf.contents <= content.CONTENT_WATER) {
        leaf = worldmodel.getLeafForPoint(p.add(new Vector(0, 0, 16.0)));
        if (leaf.contents <= content.CONTENT_WATER) {
          break;
        }
      } else {
        leaf = worldmodel.getLeafForPoint(p.add(new Vector(0, 0, -16.0)));
        if (leaf.contents > content.CONTENT_WATER) {
          break;
        }
      }
      if (leaf === R.viewleaf) {
        break;
      }
      const vis = worldmodel.getPvsByLeaf(leaf);
      for (let i = 1; i < worldmodel.leafs.length; i++) {
        if (!vis.isRevealed(i)) {
          continue;
        }
        if (clientCvars.areaportals.value > 0 && !worldmodel.areaPortals.leafsConnected(R.viewleaf, worldmodel.leafs[i])) {
          continue;
        }
        for (let node: Node | null = worldmodel.leafs[i]; node !== null; node = node.parent) {
          if (node.markvisframe === R.visframecount) {
            break;
          }
          node.markvisframe = R.visframecount;
        }
      }
    // eslint-disable-next-line no-constant-condition
    } while (false);
    R.drawsky = false;
    R.RecursiveWorldNode(worldmodel.nodes[0]);
  };

  static AllocBlock(surf: Face): void {
    const lmshift = surf.lmshift!;
    console.assert(lmshift !== null, 'face lightmap shift required');
    const w = (surf.extents[0] >> lmshift) + 1;
    const h = (surf.extents[1] >> lmshift) + 1;
    let x = 0; let y = 0; let i; let j; let best = LIGHTMAP_BLOCK_SIZE; let best2;
    for (i = 0; i < (LIGHTMAP_BLOCK_SIZE - w); i++) {
      best2 = 0;
      for (j = 0; j < w; j++) {
        if (R.allocated[i + j] >= best) {
          break;
        }
        if (R.allocated[i + j] > best2) {
          best2 = R.allocated[i + j];
        }
      }
      if (j === w) {
        x = i;
        y = best = best2;
      }
    }
    best += h;
    if (best > LIGHTMAP_BLOCK_SIZE) {
      throw new Error('R.AllocBlock: full');
    }
    for (i = 0; i < w; i++) {
      R.allocated[x + i] = best;
    }
    surf.light_s = x;
    surf.light_t = y;
  };

  static BuildLightmaps() {
    R.allocated = (new Array(LIGHTMAP_BLOCK_SIZE)).fill(0);

    R.lightmaps_rgb = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_HEIGHT * 3));
    R.dlightmaps_rgba = new Uint8Array(new ArrayBuffer(LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_SIZE * 4));

    const brushRenderer = modelRendererRegistry.getRendererForModelClass(BrushModel);
    const meshRenderer = modelRendererRegistry.getRendererForModelClass(MeshModel);
    console.assert(brushRenderer !== null, 'brush renderer required');
    console.assert(meshRenderer !== null, 'mesh renderer required');

    for (let i = 1; i < clientRuntimeState.model_precache.length; i++) {
      const currentmodel = clientRuntimeState.model_precache[i];

      // Handle brush models (BSP maps)
      if (currentmodel instanceof BrushModel) {
        if (currentmodel.name[0] !== '*') { // skip submodels
          for (let j = 0; j < currentmodel.faces.length; j++) {
            const surf = currentmodel.faces[j];
            if (!surf.sky) {
              R.AllocBlock(surf);
              if (currentmodel.lightdata_rgb !== null) {
                R.BuildLightMapEx(currentmodel, surf);
              } else if (currentmodel.lightdata !== null) {
                R.BuildLightMap(currentmodel, surf);
              }
            }
          }
        }
        // Use the brush renderer to prepare the model
        // Only model index 1 is the world model, all others are entity models
        brushRenderer!.prepareModel(currentmodel, i === 1);
      }

      // Handle mesh models (OBJ, IQM, etc.)
      if (currentmodel instanceof MeshModel) {
        meshRenderer!.prepareModel(currentmodel);
      }
    }

    const layerBytes = LIGHTMAP_BLOCK_SIZE * LIGHTMAP_BLOCK_SIZE * 4;
    R.lightmap_texture.bind(0);
    for (let k = 0; k < 3; k++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, R.lightmaps_rgb.subarray(k * layerBytes, (k + 1) * layerBytes));
    }

    R.deluxemap_texture.bind(0);
    if (R.deluxemap) {
      for (let k = 0; k < 3; k++) {
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, LIGHTMAP_BLOCK_SIZE, LIGHTMAP_BLOCK_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, R.deluxemap.subarray(k * layerBytes, (k + 1) * layerBytes));
      }
    }
  };

  // sky

  static skyrenderer: SkyRenderer | null = null;
  static drawsky = true;

  static DrawSkyBox() {
    if (!R.drawsky || !R.skyrenderer) {
      return;
    }

    R.skyrenderer.render();
  };

  static MakeSky() {
    // make sure we always free the old skyrenderer
    if (R.skyrenderer) {
      R.skyrenderer.shutdown();
    }

    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    R.skyrenderer = worldmodel.newSkyRenderer();

    if (!R.skyrenderer) {
      return;
    }

    R.skyrenderer.init();
  };

  static ClearSky() {
    if (!R.skyrenderer) {
      return;
    }

    R.skyrenderer.shutdown();
    R.skyrenderer = null;
  };
}

export default R;

eventBus.subscribe('client.disconnected', () => {
  R.ClearAll();
});

eventBus.subscribe('areaportals.changed', () => {
  R.oldviewleaf = null;
});

eventBus.subscribe('cvar.changed', (cvarName) => {
  switch (cvarName) {
    case 'r_novis':
    case 'cl_areaportals':
      R.oldviewleaf = null;
      break;
  }
});

