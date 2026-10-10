import Vector from '../../shared/Vector.ts';
import Cvar from '../common/Cvar.ts';

import { eventBus } from '../common/EventBus.ts';
import Chase from './Chase.ts';
import VID from './VID.ts';
import GL, { GLTexture } from './GL.ts';
import { content } from '../../shared/Defs.ts';
import { modelRendererRegistry } from './renderer/models/ModelRendererRegistry.ts';
import type { ModelRenderer } from './renderer/models/ModelRenderer.ts';
import { BrushModelRenderer } from './renderer/models/BrushModelRenderer.ts';
import { AliasModelRenderer } from './renderer/models/AliasModelRenderer.ts';
import { SpriteModelRenderer } from './renderer/models/SpriteModelRenderer.ts';
import { MeshModelRenderer } from './renderer/models/MeshModelRenderer.ts';
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
import DefaultTextures from './renderer/resources/DefaultTextures.ts';
import ShaderPrograms from './renderer/programs/ShaderPrograms.ts';
import Fog from './renderer/scene/Fog.ts';
import RenderStats from './renderer/scene/RenderStats.ts';
import SkyBox from './renderer/scene/SkyBox.ts';
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
  static DrawEntitiesOnList() {
    if (rendererCvars.drawentities.value === 0) {
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

      if (rendererCvars.drawturbulents.value !== 0) {
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

    if (rendererCvars.drawentities.value !== 0) {
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
    if (rendererCvars.drawviewmodel.value === 0) {
      return;
    }
    if (Chase.active.value !== 0) {
      return;
    }
    if (rendererCvars.drawentities.value === 0) {
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
    if (rendererCvars.polyblend.value === 0) {
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
      warpEffect.active = (rendererCvars.waterwarp.value !== 0) && (viewleaf.contents <= content.CONTENT_WATER);
    }

    const bloomEnabled = rendererCvars.bloom.value !== 0;
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
      underwaterFogEffect.active = waterfogEnabled && isUnderwater && rendererCvars.drawturbulents.value !== 0;
    }
    if (isUnderwater) {
      Fog.SelectUnderwaterTint(worldmodel, viewleaf, Camera.refdef.vieworg);
    }

    // Enable post-process FBO (and thus depth texture) whenever turbulents, fog
    // volumes, or underwater fog are active so shaders can sample scene depth.
    PostProcess.requestSceneCapture(rendererCvars.drawturbulents.value !== 0 || worldmodel.fogVolumes.length > 0
      || (waterfogEnabled && isUnderwater && rendererCvars.drawturbulents.value !== 0));
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
    SkyBox.Draw();
    R.DrawViewModel();
    R.RenderWorld();
  };

  static RenderView() {
    let time1 = 0;
    if (rendererCvars.speeds.value !== 0) {
      gl.finish();
      time1 = Sys.FloatMilliTime();
    }
    RenderStats.Reset();
    gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
    R.RenderScene();
    if (rendererCvars.speeds.value !== 0) {
      RenderStats.Summarize(time1);
    }
  };

  static async Init() {
    rendererCvars.waterwarp = new Cvar('r_waterwarp', '1');
    rendererCvars.fullbright = new Cvar('r_fullbright', '0', Cvar.FLAG.CHEAT);
    rendererCvars.drawentities = new Cvar('r_drawentities', '1', Cvar.FLAG.CHEAT);
    rendererCvars.drawviewmodel = new Cvar('r_drawviewmodel', '1');
    rendererCvars.drawturbulents = new Cvar('r_drawturbulents', '1', Cvar.FLAG.CHEAT);
    rendererCvars.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
    rendererCvars.speeds = new Cvar('r_speeds', '0');
    rendererCvars.polyblend = new Cvar('gl_polyblend', '1');
    rendererCvars.flashblend = new Cvar('gl_flashblend', '0');
    rendererCvars.nocolors = new Cvar('gl_nocolors', '0');
    rendererCvars.bloom = new Cvar('r_bloom', '0', Cvar.FLAG.NONE, 'Screen-space bloom post-process, 0 = off, 1 = on.');
    rendererCvars.bloomStrength = new Cvar('r_bloom_strength', '0.8', Cvar.FLAG.NONE, 'Additive bloom intensity.');
    rendererCvars.bloomSkyStrength = new Cvar('r_bloom_sky_strength', '0.33', Cvar.FLAG.NONE, 'Sky contribution added to the bloom emissive target. Lower than 1 keeps the sky glow subtle.');
    rendererCvars.bloomDlightStrength = new Cvar('r_bloom_dlight_strength', '0.33', Cvar.FLAG.NONE, 'Dynamic-light surface contribution added to the bloom emissive target. Set to 0 to disable.');
    rendererCvars.bloomSpecularStrength = new Cvar('r_bloom_specular_strength', '0.33', Cvar.FLAG.NONE, 'Specular reflection contribution added to the bloom emissive target. Set to 0 to disable.');
    rendererCvars.bloomDownsample = new Cvar('r_bloom_downsample', '4', Cvar.FLAG.NONE, 'Bloom buffer downsample divisor, clamped to 1-8.');
    rendererCvars.bloomDebug = new Cvar('r_bloom_debug', '0', Cvar.FLAG.NONE, 'Bloom debug preview: 0 = off, 1 = emissive, 2 = extract, 3 = blur, 4 = all.');
    rendererCvars.interpolation = new Cvar('r_interpolation', '1', Cvar.FLAG.NONE, 'Interpolation of textures and animation groups, 0 - off, 1 - on');
    // fog controls (TODO: make that a cheat, but resetting cvar to default is done after Fog.NewMap, so need to rethink the order of operations)
    rendererCvars.fog_color = new Cvar('r_fog_color', '128 128 128', Cvar.FLAG.NONE, 'Fog color: R G B (0-255)');
    rendererCvars.fog_start = new Cvar('r_fog_start', '128', Cvar.FLAG.NONE, 'Fog start distance (linear)');
    rendererCvars.fog_end = new Cvar('r_fog_end', '4096', Cvar.FLAG.NONE, 'Fog end distance (linear)');
    rendererCvars.fog_density = new Cvar('r_fog_density', '0.01', Cvar.FLAG.NONE, 'Fog density (for exp/exp2)');
    rendererCvars.fog_mode = new Cvar('r_fog_mode', '-1', Cvar.FLAG.NONE, 'Fog mode: 0=linear, 1=exp, 2=exp2, -1=disable');

    // fog controls for underwater fog effect (post-process)
    rendererCvars.underwater_fog_density = new Cvar('r_underwater_fog_density', '0.01', Cvar.FLAG.CHEAT, 'Fog density exponent for the underwater fog effect.');

    DefaultTextures.Init();
    Lightmaps.Init();
    LightStyles.Init();
    Particles.Init();
    Decals.Init();
    await ShaderPrograms.Init();

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

  static NewMap() {
    R.PrepareModels();
    Lightmaps.ResetDynamic();

    // Reset the viewleafs so that the renderer will recalculate them on the next frame.
    Visibility.Reset();

    Fog.NewMap();
    SkyBox.Make();
  };

  static ClearAll() {
    LightStyles.Clear();

    Visibility.Reset();

    Lightmaps.Clear();

    Particles.Clear();
    Decals.Clear();
    SkyBox.Clear();
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
}

export default R;

eventBus.subscribe('client.disconnected', () => {
  R.ClearAll();
});
