import Vector from '../../shared/Vector.ts';
import Cvar from '../common/Cvar.ts';

import { eventBus } from '../common/EventBus.ts';
import Chase from './Chase.ts';
import VID from './VID.ts';
import GL, { GLCubeTexture, GLRenderTexture, GLTexture, GLTextureArray } from './GL.ts';
import { content } from '../../shared/Defs.ts';
import { modelRendererRegistry } from './renderer/models/ModelRendererRegistry.ts';
import type { ModelRenderer } from './renderer/models/ModelRenderer.ts';
import { BrushModelRenderer } from './renderer/models/BrushModelRenderer.ts';
import { AliasModelRenderer } from './renderer/models/AliasModelRenderer.ts';
import { SpriteModelRenderer } from './renderer/models/SpriteModelRenderer.ts';
import { MeshModelRenderer } from './renderer/models/MeshModelRenderer.ts';
import Draw from './Draw.ts';
import { BrushModel, type FogVolumeInfo, Node, type WorldTurbulentChainInfo } from '../common/model/BSP.ts';
import { MeshModel } from '../common/model/MeshModel.ts';
import { SpriteModel } from '../common/model/SpriteModel.ts';
import PostProcess from './renderer/postprocess/PostProcess.ts';
import BloomEffect from './renderer/postprocess/BloomEffect.ts';
import ColorGradeEffect from './renderer/postprocess/ColorGradeEffect.ts';
import BlurEffect from './renderer/postprocess/BlurEffect.ts';
import WarpEffect from './renderer/postprocess/WarpEffect.ts';
import UnderwaterFogEffect from './renderer/postprocess/UnderwaterFogEffect.ts';
import ShadowMap from './renderer/lighting/ShadowMap.ts';
import { ClientEdict } from './ClientEntities.ts';
import { SkyRenderer } from './renderer/scene/Sky.ts';
import LightStyles from './renderer/lighting/LightStyles.ts';
import Lightmaps from './renderer/lighting/Lightmaps.ts';
import DynamicLights from './renderer/lighting/DynamicLights.ts';
import rendererCvars from './renderer/resources/RendererCvars.ts';
import Camera from './renderer/scene/Camera.ts';
import FrameUniforms from './renderer/scene/FrameUniforms.ts';
import Visibility from './renderer/scene/Visibility.ts';
import Particles, { type Particle } from './renderer/effects/Particles.ts';
import Decals, { type Decal } from './renderer/effects/Decals.ts';
import { clientRuntimeState } from './ClientState.ts';
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

interface TransparentItem extends SortKindDistance {
  readonly data: Node | WorldTurbulentChainInfo | FogVolumeInfo | ClientEdict | Particle | Decal;
}

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

  /**
   * The top-down shadow map to sample this frame (the real one or the dummy), for `Sky`, which reads it through
   * the renderer.
   * @deprecated Ask `ShadowMap.getActiveTopDownTexture()`; goes away with `RenderContext` (Phase 5 of plans/r-split.md).
   * @returns The texture, `null` before `ShadowMap.init()`.
   */
  static get shadow_texture(): GLRenderTexture | null {
    return ShadowMap.getActiveTopDownTexture();
  }

  /**
   * The point-light shadow cubes to sample this frame (real or dummy), for `Sky`.
   * @deprecated Ask `ShadowMap.getActivePointTextures()`; goes away with `RenderContext` (Phase 5 of plans/r-split.md).
   * @returns The cubes, one per slot.
   */
  static get point_shadow_textures(): ReadonlyArray<GLCubeTexture | null> {
    return ShadowMap.getActivePointTextures();
  }

  /**
   * The marking counter of the current PVS, for `Sky`, which reads it through the renderer.
   * @deprecated Moved to `Visibility.visframecount`; goes away with `RenderContext` (Phase 5 of plans/r-split.md).
   * @returns The counter.
   */
  static get visframecount(): number {
    return Visibility.visframecount;
  }

  /**
   * The view of this frame, for `Sky`, which reads it through the renderer.
   * @deprecated Moved to `Camera.refdef`; goes away with `RenderContext` (Phase 5 of plans/r-split.md).
   * @returns The refdef.
   */
  static get refdef(): typeof Camera.refdef {
    return Camera.refdef;
  }

  /**
   * Whether a box is outside of the view frustum, for `Sky`, which reads it through the renderer.
   * @deprecated Moved to `Camera.CullBox`; goes away with `RenderContext` (Phase 5 of plans/r-split.md).
   * @returns True when the box can be skipped.
   */
  static CullBox(mins: Vector, maxs: Vector): boolean {
    return Camera.CullBox(mins, maxs);
  }

  // light

  static waterwarp: Cvar = null!;
  static drawentities: Cvar = null!;
  static drawviewmodel: Cvar = null!;
  static drawturbulents: Cvar = null!;
  static underwater_fog_density: Cvar = null!;
  static speeds: Cvar = null!;
  static polyblend: Cvar = null!;
  static nocolors: Cvar = null!;
  static bloom: Cvar = null!;
  static bloomStrength: Cvar = null!;
  static bloomSkyStrength: Cvar = null!;
  static bloomDlightStrength: Cvar = null!;
  static bloomSpecularStrength: Cvar = null!;
  static bloomDownsample: Cvar = null!;
  static bloomDebug: Cvar = null!;

  static notexture: GLTexture = null!;
  static blacktexture: GLTexture = null!;
  static flatnormalmap: GLTexture = null!;
  static fullbright_texture: GLTextureArray = null!;
  static null_texture: GLRenderTexture = null!;
  static normal_up_texture: GLTextureArray = null!;

  /** RGB fog color used by the underwater fog effect this frame (0-1 range). */
  static underwaterFogColor: [number, number, number] = [0.05, 0.15, 0.2];

  /** Fog density exponent used by the underwater fog effect this frame. */
  static underwaterFogDensity = 0.05;
  static c_brush_verts = 0;
  static c_brush_tris = 0;
  static c_brush_draws = 0;
  static c_brush_vbos = 0;
  static c_brush_texture_binds = 0;
  static c_alias_polys = 0;

  // main

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
    const vieworg = Camera.refdef.vieworg;
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
    Camera.perspective[0] = 4.0 / (ymax * Camera.refdef.vrect.width / Camera.refdef.vrect.height);
    Camera.perspective[5] = 4.0 / ymax;
    let program = GL.UseProgram('alias')!;
    console.assert(program !== null, 'alias program required');
    gl.uniformMatrix4fv(program.uPerspective!, false, Camera.perspective);

    const viewent = clientRuntimeState.viewent;
    if (viewent !== null && viewent.model !== null) {
      const aliasRenderer = modelRendererRegistry.getRendererForModel(viewent.model);
      console.assert(aliasRenderer !== null, 'alias renderer required');
      aliasRenderer!.setupRenderState(0);
      aliasRenderer!.render(viewent.model, viewent, 0);
      aliasRenderer!.cleanupRenderState(0);
    }

    ymax = 4.0 * Math.tan(Camera.refdef.fov_y * Math.PI / 360.0);
    Camera.perspective[0] = 4.0 / (ymax * Camera.refdef.vrect.width / Camera.refdef.vrect.height);
    Camera.perspective[5] = 4.0 / ymax;
    program = GL.UseProgram('alias')!;
    console.assert(program !== null, 'alias program required');
    gl.uniformMatrix4fv(program.uPerspective!, false, Camera.perspective);

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
    const vrect = Camera.refdef.vrect;
    GL.StreamDrawColoredQuad(vrect.x, vrect.y, vrect.width, vrect.height, V.blend[0], V.blend[1], V.blend[2], V.blend[3] * 255.0);
  };

  static SetupGL() {
    const vrect = Camera.refdef.vrect;
    const pixelRatio = VID.pixelRatio;
    const w = (vrect.width * pixelRatio) >> 0;
    const h = (vrect.height * pixelRatio) >> 0;

    if (PostProcess.needsSceneCapture()) {
      // Render the scene to the shared post-process capture FBO whenever a
      // screen-space effect needs to sample it. Depth-aware passes like fog
      // use the same capture path and sample the depth texture mid-frame.
      PostProcess.resize(w, h);
      PostProcess.begin();
      gl.viewport(0, 0, w, h);
    } else {
      gl.viewport((vrect.x * pixelRatio) >> 0, ((VID.height - vrect.height - vrect.y) * pixelRatio) >> 0, w, h);
    }
    Camera.UpdateMatrices();
    FrameUniforms.Upload();
    gl.enable(gl.DEPTH_TEST);
  };

  /**
   * Sets up what the frame's passes read: lightstyles, the effects that depend on where the camera is, the fog
   * tint, and whether the scene needs to be captured. `V.PreRenderView` runs it after `Camera.UpdateViewVectors()`
   * and `Visibility.UpdateViewLeaf()`, because it reads the view leaf.
   */
  static PreRenderScene() {
    LightStyles.Animate();
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    const viewleaf = Visibility.viewleaf!;
    console.assert(viewleaf !== null, 'view leaf required, Visibility.UpdateViewLeaf() runs before this');

    // Underwater warp is a post-process effect, active while the camera is inside a liquid.
    const warpEffect = PostProcess.getEffect('warp');
    if (warpEffect) {
      warpEffect.active = (R.waterwarp.value !== 0) && (viewleaf.contents <= content.CONTENT_WATER);
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
    const isUnderwater = viewleaf.contents <= content.CONTENT_WATER;
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
      const firstChain = viewleaf.turbulentChains[0];
      const material = firstChain !== undefined
        ? worldmodel.textures[firstChain.texture]
        : undefined;

      let fogTint = material?.fogTint ?? null;

      if (fogTint === null) {
        fogTint = R.#nearestLiquidFogTint(worldmodel, Camera.refdef.vieworg);
      }

      if (fogTint !== null) {
        R.underwaterFogColor = fogTint;
      } else if (viewleaf.contents <= content.CONTENT_LAVA) {
        R.underwaterFogColor = [0.25, 0.05, 0.0];
      } else if (viewleaf.contents <= content.CONTENT_SLIME) {
        R.underwaterFogColor = [0.02, 0.12, 0.0];
      } else {
        R.underwaterFogColor = [0.05, 0.15, 0.2];
      }
      R.underwaterFogDensity = R.underwater_fog_density.value;
    }

    // Enable post-process FBO (and thus depth texture) whenever turbulents, fog
    // volumes, or underwater fog are active so shaders can sample scene depth.
    PostProcess.requestSceneCapture(R.drawturbulents.value !== 0 || worldmodel.fogVolumes.length > 0
      || (waterfogEnabled && isUnderwater && R.drawturbulents.value !== 0));
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
    DynamicLights.RenderCoronas();

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
    Camera.SetFrustum();
    console.assert(ShadowMap.enabled !== null, 'shadow toggle required');

    // Top-down shadow pass — a single fixed-direction directional shadow,
    // centered on the camera. World and entities both cast into it.
    if (ShadowMap.enabled!.value) {
      ShadowMap.renderTopDownShadow(Camera.refdef.vieworg);
    }

    // Point light shadow pass — render world BSP into a cube depth map per
    // active point-light slot, from the strongest nearby dlights' positions.
    if (ShadowMap.selectPointLights(Camera.refdef.vieworg) > 0) {
      ShadowMap.renderPointLightShadow();
    }

    // The point-light state that FrameUniforms uploads is only final once selectPointLights has run, so the
    // uniforms are written here and not in PreRenderScene.
    R.SetupGL();
    Visibility.MarkLeafs();

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

    Lightmaps.Init();

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
    rendererCvars.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
    R.speeds = new Cvar('r_speeds', '0');
    R.polyblend = new Cvar('gl_polyblend', '1');
    rendererCvars.flashblend = new Cvar('gl_flashblend', '0');
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
    rendererCvars.fog_color = new Cvar('r_fog_color', '128 128 128', Cvar.FLAG.NONE, 'Fog color: R G B (0-255)');
    rendererCvars.fog_start = new Cvar('r_fog_start', '128', Cvar.FLAG.NONE, 'Fog start distance (linear)');
    rendererCvars.fog_end = new Cvar('r_fog_end', '4096', Cvar.FLAG.NONE, 'Fog end distance (linear)');
    rendererCvars.fog_density = new Cvar('r_fog_density', '0.01', Cvar.FLAG.NONE, 'Fog density (for exp/exp2)');
    rendererCvars.fog_mode = new Cvar('r_fog_mode', '-1', Cvar.FLAG.NONE, 'Fog mode: 0=linear, 1=exp, 2=exp2, -1=disable');

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

    DynamicLights.Init();

    R.ClearAll();
  };

  static NewMapFog() {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel must be loaded before InitFog');

    const fogInfo = worldmodel.worldspawnInfo.fog;

    if (!fogInfo) {
      rendererCvars.fog_mode.set(-1);
      return;
    }

    const [exp, r, g, b] = fogInfo.split(/\s+/).map(Number);

    // CR: I took that calculation from Ironwail’s Fog_SetupFrame:
    const ExpAdjustment = 1.20112241; // sqrt(log2(e))
    const SphericalCorrection = 0.85; // compensate higher perceived density with spherical fog
    const DensityScale = ExpAdjustment * SphericalCorrection / 64.0;

    rendererCvars.fog_density.set(exp / DensityScale);
    rendererCvars.fog_color.set(`${r * 255} ${g * 255} ${b * 255}`);
    rendererCvars.fog_mode.set(1);
  };

  static NewMap() {
    R.PrepareModels();
    Lightmaps.ResetDynamic();

    // Reset the viewleafs so that the renderer will recalculate them on the next frame.
    Visibility.Reset();

    R.NewMapFog();
    R.MakeSky();
  };

  static ClearAll() {
    LightStyles.Clear();

    Visibility.Reset();

    Lightmaps.Clear();

    Particles.Clear();
    Decals.Clear();
    R.ClearSky();
  };

  /**
   * Prepares every model of the map for drawing: gives faces their place in the lightmap atlas, lets the model
   * renderers build their buffers, and uploads the atlas. The world is model 1, the rest are entity models.
   */
  static PrepareModels(): void {
    Lightmaps.Begin();

    const brushRenderer = modelRendererRegistry.getRendererForModelClass(BrushModel);
    const meshRenderer = modelRendererRegistry.getRendererForModelClass(MeshModel);
    console.assert(brushRenderer !== null, 'brush renderer required');
    console.assert(meshRenderer !== null, 'mesh renderer required');

    for (let i = 1; i < clientRuntimeState.model_precache.length; i++) {
      const currentmodel = clientRuntimeState.model_precache[i];

      // Handle brush models (BSP maps)
      if (currentmodel instanceof BrushModel) {
        Lightmaps.AddModel(currentmodel);
        // Use the brush renderer to prepare the model
        // Only model index 1 is the world model, all others are entity models
        brushRenderer!.prepareModel(currentmodel, i === 1);
      }

      // Handle mesh models (OBJ, IQM, etc.)
      if (currentmodel instanceof MeshModel) {
        meshRenderer!.prepareModel(currentmodel);
      }
    }

    Lightmaps.Upload();
  }

  // sky

  static skyrenderer: SkyRenderer | null = null;

  static DrawSkyBox() {
    if (!Visibility.skyVisible || !R.skyrenderer) {
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
