import Vector from '../../../../shared/Vector.ts';
import { content } from '../../../../shared/Defs.ts';
import { eventBus } from '../../../common/EventBus.ts';
import { revealedVisibility, type BrushModel, type Visibility as VisibilityData } from '../../../common/model/BSP.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import clientCvars from '../../ClientCvars.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import Camera from './Camera.ts';
import { WorldRenderState } from '../../../common/model/WorldRenderState.ts';

/**
 * What of the map the view can see: the leaf the view origin is in, and which leafs and nodes the PVS reveals
 * from there. The model renderers compare a leaf's `visframe` with `visframecount` to know whether to draw it.
 *
 * The marking is cached per view leaf. Anything that changes what a leaf reveals (area portals opening, `r_novis`,
 * `cl_areaportals`) invalidates the cache through the subscriptions at the bottom of this file; losing one of them
 * makes the PVS go stale silently.
 */
class Visibility {
  /** Counter that marks nodes and leafs as revealed in the current marking; bumped by every `MarkLeafs`. */
  static visframecount = 0;

  /** Index of the leaf the view origin is in. `null` before the first frame and after a map change. */
  static viewleaf: number | null = null;

  /** The view leaf the nodes were last marked for. `null` forces the next `MarkLeafs` to mark again. */
  static oldviewleaf: number | null = null;

  /** Whether any revealed leaf has sky surfaces, so the sky needs drawing. */
  static skyVisible = true;

  /**
   * Finds the leaf the view origin is in and makes it the view leaf. Runs once per frame after the refdef is
   * final and before anything asks for the view contents (the blend color, the sound listener, fog).
   * @returns Index of the view leaf.
   */
  static UpdateViewLeaf(): number {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    const leaf = worldmodel.getLeafIndexForPoint(Camera.refdef.vieworg);
    Visibility.viewleaf = leaf;

    return leaf;
  }

  /**
   * What the eye is in: the contents of the view leaf.
   * @returns `CONTENT_EMPTY` before there is a view.
   */
  static get viewContents(): content {
    const worldmodel = clientRuntimeState.worldmodel;

    if (worldmodel === null || Visibility.viewleaf === null) {
      return content.CONTENT_EMPTY;
    }

    return worldmodel.leafTable.contents[Visibility.viewleaf];
  }

  /**
   * Forgets the view leaf and the marking, so the next frame calculates them again.
   */
  static Reset(): void {
    Visibility.viewleaf = null;
    Visibility.oldviewleaf = null;
  }

  /**
   * Marks the nodes on the path from every revealed leaf to the root, then walks the tree once to see whether
   * any revealed leaf shows sky. Does nothing while the view leaf has not changed.
   */
  static MarkLeafs(): void {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    const novis = rendererCvars.novis;

    if ((Visibility.oldviewleaf === Visibility.viewleaf) && (novis.value === 0)) {
      return;
    }
    Visibility.visframecount++;
    Visibility.oldviewleaf = Visibility.viewleaf;

    const state = WorldRenderState.of(worldmodel);
    const viewleaf = Visibility.viewleaf;
    const vis = (novis.value === 1 || viewleaf === null || viewleaf === 0) ? revealedVisibility : (
      novis.value === 2 ?
        worldmodel.getPhsByLeaf(viewleaf) :
        worldmodel.getPvsByLeaf(viewleaf)
    );

    Visibility.#markRevealed(worldmodel, state, vis, viewleaf);

    do {
      if (novis.value !== 0 || viewleaf === null) {
        break;
      }
      const p = Camera.refdef.vieworg.copy();
      let leaf: number;
      if (worldmodel.leafTable.contents[viewleaf] <= content.CONTENT_WATER) {
        leaf = worldmodel.getLeafIndexForPoint(p.add(new Vector(0, 0, 16.0)));
        if (worldmodel.leafTable.contents[leaf] <= content.CONTENT_WATER) {
          break;
        }
      } else {
        leaf = worldmodel.getLeafIndexForPoint(p.add(new Vector(0, 0, -16.0)));
        if (worldmodel.leafTable.contents[leaf] > content.CONTENT_WATER) {
          break;
        }
      }
      if (leaf === viewleaf) {
        break;
      }
      Visibility.#markRevealed(worldmodel, state, worldmodel.getPvsByLeaf(leaf), viewleaf);
    // eslint-disable-next-line no-constant-condition
    } while (false);
    Visibility.skyVisible = false;
    Visibility.#walkMarkedNodes(worldmodel, state, 0);
  }

  /**
   * Marks every revealed leaf and the nodes on its path to the root.
   * @param worldmodel The map.
   * @param state The marks of the map.
   * @param vis What the view reveals.
   * @param viewleaf The leaf of the view, which area portals are measured from; they are not checked without one.
   */
  static #markRevealed(worldmodel: BrushModel, state: WorldRenderState, vis: VisibilityData, viewleaf: number | null): void {
    const leafs = worldmodel.leafTable;
    const nodes = worldmodel.nodeTable;
    const marks = state.markframes;
    const count = Visibility.visframecount;
    const checkPortals = clientCvars.areaportals.value > 0;

    for (let leaf = 1; leaf < leafs.count; leaf++) {
      if (!vis.isRevealed(leaf)) {
        continue;
      }

      if (checkPortals && viewleaf !== null && !worldmodel.leafsConnected(viewleaf, leaf)) {
        continue;
      }

      const slot = state.nodeCount + leaf;

      if (marks[slot] === count) {
        continue;
      }

      marks[slot] = count;

      for (let node = leafs.parents[leaf]; node >= 0; node = nodes.parents[node]) {
        if (marks[node] === count) {
          break;
        }

        marks[node] = count;
      }
    }
  }

  /**
   * Stamps the leafs that were marked in this marking with the current frame count and notes whether one of
   * them has sky surfaces.
   */
  static #walkMarkedNodes(worldmodel: BrushModel, state: WorldRenderState, reference: number): void {
    if (reference < 0) {
      const leaf = ~reference;

      if (worldmodel.leafTable.contents[leaf] === content.CONTENT_SOLID) {
        return;
      }

      if (state.markframes[state.nodeCount + leaf] !== Visibility.visframecount) {
        return;
      }

      state.visframes[leaf] = Visibility.visframecount;

      if (state.skychains[leaf] !== state.waterchains[leaf]) {
        Visibility.skyVisible = true;
      }

      return;
    }

    Visibility.#walkMarkedNodes(worldmodel, state, worldmodel.nodeTable.children[reference * 2]);
    Visibility.#walkMarkedNodes(worldmodel, state, worldmodel.nodeTable.children[reference * 2 + 1]);
  }
}

export default Visibility;

eventBus.subscribe('areaportals.changed', () => {
  Visibility.oldviewleaf = null;
});

eventBus.subscribe('cvar.changed', (cvarName) => {
  switch (cvarName) {
    case 'r_novis':
    case 'cl_areaportals':
      Visibility.oldviewleaf = null;
      break;
  }
});
