import Cvar from '../common/Cvar.ts';

import { eventBus } from '../common/EventBus.ts';
import Chase from './Chase.ts';
import VID from './VID.ts';
import GL from './GL.ts';
import { content } from '../../shared/Defs.ts';
import { modelRendererRegistry } from './renderer/models/ModelRendererRegistry.ts';
import type { ModelRenderer } from './renderer/models/ModelRenderer.ts';
import { BrushModelRenderer } from './renderer/models/BrushModelRenderer.ts';
import { AliasModelRenderer } from './renderer/models/AliasModelRenderer.ts';
import { SpriteModelRenderer } from './renderer/models/SpriteModelRenderer.ts';
import { MeshModelRenderer } from './renderer/models/MeshModelRenderer.ts';
import { BrushModel } from '../common/model/BSP.ts';
import { MeshModel } from '../common/model/MeshModel.ts';
import PostProcess from './renderer/postprocess/PostProcess.ts';
import BloomEffect from './renderer/postprocess/BloomEffect.ts';
import ColorGradeEffect from './renderer/postprocess/ColorGradeEffect.ts';
import BlurEffect from './renderer/postprocess/BlurEffect.ts';
import ColorShiftEffect from './renderer/postprocess/ColorShiftEffect.ts';
import WarpEffect from './renderer/postprocess/WarpEffect.ts';
import UnderwaterFogEffect from './renderer/postprocess/UnderwaterFogEffect.ts';
import ShadowMap from './renderer/lighting/ShadowMap.ts';
import type { ClientEdict } from './ClientEntities.ts';
import DefaultTextures from './renderer/resources/DefaultTextures.ts';
import ShaderPrograms from './renderer/programs/ShaderPrograms.ts';
import Fog from './renderer/scene/Fog.ts';
import RenderStats from './renderer/scene/RenderStats.ts';
import SkyBox from './renderer/scene/SkyBox.ts';
import TransparentPass from './renderer/scene/TransparentPass.ts';
import LightStyles from './renderer/lighting/LightStyles.ts';
import Lightmaps from './renderer/lighting/Lightmaps.ts';
import DynamicLights from './renderer/lighting/DynamicLights.ts';
import rendererCvars from './renderer/resources/RendererCvars.ts';
import Camera from './renderer/scene/Camera.ts';
import FrameUniforms from './renderer/scene/FrameUniforms.ts';
import Visibility from './renderer/scene/Visibility.ts';
import Particles from './renderer/effects/Particles.ts';
import Decals from './renderer/effects/Decals.ts';
import { clientRuntimeState } from './ClientState.ts';
import SCR from './SCR.ts';
import Sys from './Sys.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * The renderer of the page: creates and tears down the renderer's subsystems and runs the frame's passes in
 * order. What a pass draws, and the state it needs, lives in the classes under `renderer/`.
 */
class R {
  /**
   * Draws the opaque entities, batched by the model renderer that handles their model. Blended entities are
   * left to `TransparentPass`.
   */
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
  }

  /**
   * Draws the weapon model in front of the world, in a depth range of its own and with its own field of view.
   */
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
  }

  /**
   * Binds the target of the frame (the capture FBO when an effect needs the scene, the screen otherwise) and
   * uploads the matrices and the per-frame uniforms of every program.
   */
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
  }

  /**
   * Sets up what the frame's passes read: lightstyles, the effects that depend on where the camera is, the fog
   * tint, and whether the scene needs to be captured. `SCR.PreRenderView` runs it after `Camera.UpdateViewVectors()`
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
  }

  /**
   * Draws the world, the entities and everything blended, in the order the passes need: opaque world surfaces,
   * opaque entities, coronas, then the single sorted pass of everything transparent.
   */
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
      TransparentPass.Render(worldEntity);
      gl.disable(gl.CULL_FACE);
    } else {
      Decals.Draw();
      Particles.Draw();
    }
  }

  /**
   * Renders the depth maps the scene is lit with: the top-down directional shadow and the cube maps of the
   * strongest point lights.
   */
  static #renderShadowMaps(): void {
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
  }

  /**
   * Turbulent boundary depth pre-pass — captures turbulent surface depths so the underwater fog effect knows
   * where the water boundary is per pixel.
   */
  static #renderTurbulentBoundaryDepth(): void {
    if (!PostProcess.getEffect('underwater-fog')?.active || !PostProcess.active) {
      return;
    }

    const worldEntity = clientRuntimeState.clientEntities.getEntity(0);
    const worldmodel = worldEntity?.model instanceof BrushModel ? worldEntity.model : null;
    const brushRenderer = worldmodel !== null
      ? modelRendererRegistry.getRendererForModelClass(BrushModel) as BrushModelRenderer | null
      : null;

    if (brushRenderer === null || worldmodel === null) {
      return;
    }

    PostProcess.beginTurbulentBoundaryPass();
    brushRenderer.renderWorldTurbulentsBoundaryDepth(worldmodel);
    PostProcess.endTurbulentBoundaryPass();
  }

  /**
   * Renders the 3D scene of the frame into the current target, in pass order: shadow maps, the frame's GL and
   * uniform setup, visibility, the turbulent boundary depth, sky, view model, then world and entities.
   */
  static RenderScene() {
    Camera.SetFrustum();
    R.#renderShadowMaps();

    // The point-light state that FrameUniforms uploads is only final once selectPointLights has run, so the
    // uniforms are written here and not in PreRenderScene.
    R.SetupGL();
    Visibility.MarkLeafs();
    R.#renderTurbulentBoundaryDepth();

    gl.enable(gl.CULL_FACE);
    SkyBox.Draw();
    R.DrawViewModel();
    R.RenderWorld();
  }

  /**
   * Renders one frame of the 3D view, with the `r_speeds` bookkeeping around it.
   */
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
  }

  /**
   * Creates the console variables, then the resources and subsystems in the order they depend on each other.
   */
  static async Init() {
    rendererCvars.waterwarp = new Cvar('r_waterwarp', '1');
    rendererCvars.fullbright = new Cvar('r_fullbright', '0', Cvar.FLAG.CHEAT);
    rendererCvars.drawentities = new Cvar('r_drawentities', '1', Cvar.FLAG.CHEAT);
    rendererCvars.drawviewmodel = new Cvar('r_drawviewmodel', '1');
    rendererCvars.drawturbulents = new Cvar('r_drawturbulents', '1', Cvar.FLAG.CHEAT);
    rendererCvars.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
    rendererCvars.speeds = new Cvar('r_speeds', '0');
    rendererCvars.polyblend = new Cvar('gl_polyblend', '1');
    rendererCvars.cshiftpercent = new Cvar('gl_cshiftpercent', '100');
    rendererCvars.gamma = new Cvar('gamma', '0.8', Cvar.FLAG.ARCHIVE | Cvar.FLAG.CHEAT); // CR: 1 is too dark
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
    PostProcess.addEffect(new ColorShiftEffect());

    // Initialize shadow mapping (depth-only FBO + sun light)
    ShadowMap.init();

    DynamicLights.Init();

    R.ClearAll();
  }

  /**
   * Prepares the renderer for the map that was just loaded.
   */
  static NewMap() {
    R.PrepareModels();
    Lightmaps.ResetDynamic();

    // Reset the viewleafs so that the renderer will recalculate them on the next frame.
    Visibility.Reset();

    Fog.NewMap();
    SkyBox.Make();
  }

  /**
   * Releases what belongs to the current map, on a disconnect and before the next map.
   */
  static ClearAll() {
    LightStyles.Clear();

    Visibility.Reset();

    Lightmaps.Clear();

    Particles.Clear();
    Decals.Clear();
    SkyBox.Clear();
  }

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
