import type Vector from '../../../../shared/Vector.ts';
import { eventBus } from '../../../common/EventBus.ts';
import { BrushModel, type FogVolumeInfo, type Node, type WorldTurbulentChainInfo } from '../../../common/model/BSP.ts';
import { SpriteModel } from '../../../common/model/SpriteModel.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import GL, { type GLTexture } from '../../GL.ts';
import Decals, { type Decal } from '../effects/Decals.ts';
import Particles, { type Particle } from '../effects/Particles.ts';
import type { BrushModelRenderer } from '../models/BrushModelRenderer.ts';
import type { ModelRenderer } from '../models/ModelRenderer.ts';
import { modelRendererRegistry } from '../models/ModelRendererRegistry.ts';
import PostProcess from '../postprocess/PostProcess.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import Camera from './Camera.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * What a blended thing is, which decides how it is drawn and how it ranks against another at the same depth.
 */
export enum TransparentKind {
  WorldLeaf = 0,
  Turbulent = 1,
  FogVolume = 2,
  Entity = 3,
  Sprite = 4,
  Decal = 5,
  Particle = 6,
}

/**
 * The two things the transparent sort looks at.
 */
export interface SortKindDistance {
  readonly dist: number;
  readonly kind: TransparentKind;
}

/**
 * One blended thing of a frame, with what it takes to draw it.
 */
export interface TransparentItem extends SortKindDistance {
  readonly data: Node | WorldTurbulentChainInfo | FogVolumeInfo | ClientEdict | Particle | Decal;
}

/** Depths closer than this count as equal, so fog and the water that shares its boundary rank by kind. */
const SORT_EPSILON = 0.0001;

/**
 * Everything blended in a frame, drawn in one back-to-front pass: transparent world leafs, turbulent surfaces,
 * fog volumes, translucent entities, sprites, decals and particles. Gathering the items and drawing them are
 * separate steps so the order can be tested without a GL context.
 */
class TransparentPass {
  /** The items of the frame being drawn; truncated after every pass. */
  static readonly #items: TransparentItem[] = [];

  /** What the pass is drawing the world with, set by `Collect()` and `Render()`. */
  static #worldmodel: BrushModel | null = null;
  static #brushRenderer: BrushModelRenderer | null = null;
  static #spriteRenderer: ModelRenderer | null = null;

  /** The kind whose GL state is set up right now, -1 between kinds. */
  static #activeKind: TransparentKind | -1 = -1;

  /** The decal texture bound right now, so a run of decals with one texture flushes once. */
  static #currentDecalTexture: GLTexture | null = null;

  /**
   * Resolves deterministic tie-break priority for the kinds.
   * @returns Higher values are sorted earlier on near-equal depth.
   */
  static #getKindPriority(kind: TransparentKind): number {
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
   * Compares two items for a single back-to-front pass. Distances sort far to near. Near ties use the kind
   * priority, with fog volumes before turbulent surfaces so liquid can blend over fog.
   * @returns Sort comparator result.
   */
  static Compare(this: void, itemA: SortKindDistance, itemB: SortKindDistance): number {
    const distDelta = itemB.dist - itemA.dist;

    if (Math.abs(distDelta) > SORT_EPSILON) {
      return distDelta;
    }

    return TransparentPass.#getKindPriority(itemB.kind) - TransparentPass.#getKindPriority(itemA.kind);
  }

  /**
   * Computes the sort distance of an entity. Entities sort by origin distance for consistency with prior
   * behavior and because model bounds are not uniformly available here.
   * @returns Euclidean distance from the view origin to the entity origin.
   */
  static #getEntityDistance(entity: ClientEdict, vieworg: Vector): number {
    const dx = entity.origin[0] - vieworg[0];
    const dy = entity.origin[1] - vieworg[1];
    const dz = entity.origin[2] - vieworg[2];

    return Math.hypot(dx, dy, dz);
  }

  /**
   * Gathers everything blended that the view may show, unsorted.
   * @param worldEntity The world entity, whose brush model supplies the transparent leafs, turbulent chains and fog volumes.
   * @returns The items of this frame. The array is reused by the next call.
   */
  static Collect(worldEntity: ClientEdict): TransparentItem[] {
    const items = TransparentPass.#items;
    const worldmodel = worldEntity.model instanceof BrushModel ? worldEntity.model : null;
    const vieworg = Camera.refdef.vieworg;

    items.length = 0;

    const brushRenderer = worldmodel !== null
      ? modelRendererRegistry.getRendererForModelClass(BrushModel) as BrushModelRenderer
      : null;

    TransparentPass.#worldmodel = worldmodel;
    TransparentPass.#brushRenderer = brushRenderer;

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
            dist: TransparentPass.#getEntityDistance(entity, vieworg),
            kind: TransparentKind.Sprite,
            data: entity,
          });
          continue;
        }

        if (!renderer!.rendersTransparentPass(entity.model, entity)) {
          continue;
        }

        items.push({
          dist: TransparentPass.#getEntityDistance(entity, vieworg),
          kind: TransparentKind.Entity,
          data: entity,
        });
      }
    }

    return items;
  }

  /**
   * Draws everything blended in a single back-to-front sorted pass.
   * @param worldEntity The world entity, as for `Collect()`.
   */
  static Render(worldEntity: ClientEdict): void {
    const items = TransparentPass.Collect(worldEntity);

    if (items.length === 0) {
      return;
    }

    items.sort(TransparentPass.Compare);

    gl.depthMask(false);

    TransparentPass.#spriteRenderer = modelRendererRegistry.getRendererForModelClass(SpriteModel);
    TransparentPass.#currentDecalTexture = null;
    TransparentPass.#activeKind = -1;

    const particleFrame = Particles.BeginFrame();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.kind !== TransparentPass.#activeKind) {
        TransparentPass.#endActiveKind();
        if (!TransparentPass.#beginKind(item.kind)) {
          continue;
        }
        TransparentPass.#activeKind = item.kind;
      }

      TransparentPass.#drawItem(item, particleFrame);
    }

    TransparentPass.#endActiveKind();
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    // do not keep the frame's entities and particles alive
    items.length = 0;
    TransparentPass.#worldmodel = null;
    TransparentPass.#brushRenderer = null;
    TransparentPass.#spriteRenderer = null;
    TransparentPass.#currentDecalTexture = null;
  }

  /**
   * Leaves the GL state of the kind that was being drawn.
   */
  static #endActiveKind(): void {
    const brushRenderer = TransparentPass.#brushRenderer;
    const spriteRenderer = TransparentPass.#spriteRenderer;

    switch (TransparentPass.#activeKind) {
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

    TransparentPass.#activeKind = -1;
  }

  /**
   * Sets up the GL state for a run of items of one kind.
   * @returns false when the kind cannot be drawn, so its items are skipped.
   */
  static #beginKind(kind: TransparentKind): boolean {
    const brushRenderer = TransparentPass.#brushRenderer;
    const worldmodel = TransparentPass.#worldmodel;
    const spriteRenderer = TransparentPass.#spriteRenderer;

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
        TransparentPass.#currentDecalTexture = null;
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
  }

  /**
   * Draws one item. The GL state of its kind is already set up.
   */
  static #drawItem(item: TransparentItem, particleFrame: ReturnType<typeof Particles.BeginFrame>): void {
    const brushRenderer = TransparentPass.#brushRenderer;
    const worldmodel = TransparentPass.#worldmodel;
    const spriteRenderer = TransparentPass.#spriteRenderer;

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

        if (decal.texture !== TransparentPass.#currentDecalTexture) {
          GL.StreamFlush();
          decal.texture.bind(program.tTexture!);
          TransparentPass.#currentDecalTexture = decal.texture;
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
}

export default TransparentPass;
