import Vector from '../../../../shared/Vector.ts';
import { content } from '../../../../shared/Defs.ts';
import { eventBus } from '../../../common/EventBus.ts';
import { Node, revealedVisibility } from '../../../common/model/BSP.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import clientCvars from '../../ClientCvars.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import Camera from './Camera.ts';

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

  /** The leaf the view origin is in. `null` before the first frame and after a map change. */
  static viewleaf: Node | null = null;

  /** The view leaf the nodes were last marked for. `null` forces the next `MarkLeafs` to mark again. */
  static oldviewleaf: Node | null = null;

  /** Whether any revealed leaf has sky surfaces, so the sky needs drawing. */
  static skyVisible = true;

  /**
   * Finds the leaf the view origin is in and makes it the view leaf. Runs once per frame after the refdef is
   * final and before anything asks for the view contents (the blend color, the sound listener, fog).
   * @returns The view leaf.
   */
  static UpdateViewLeaf(): Node {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');

    const leaf = worldmodel.getLeafForPoint(Camera.refdef.vieworg);
    Visibility.viewleaf = leaf;

    return leaf;
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
    const vis = (novis.value === 1 || Visibility.viewleaf === null || Visibility.viewleaf.num === 0) ? revealedVisibility : (
      novis.value === 2 ?
        worldmodel.getPhsByLeaf(Visibility.viewleaf) :
        worldmodel.getPvsByLeaf(Visibility.viewleaf)
    );
    for (let i = 1; i < worldmodel.leafs.length; i++) {
      if (!vis.isRevealed(i)) {
        continue;
      }
      if (clientCvars.areaportals.value > 0 && Visibility.viewleaf && !worldmodel.areaPortals.leafsConnected(Visibility.viewleaf, worldmodel.leafs[i])) {
        continue;
      }
      for (let node: Node | null = worldmodel.leafs[i]; node !== null; node = node.parent) {
        if (node.markvisframe === Visibility.visframecount) {
          break;
        }
        node.markvisframe = Visibility.visframecount;
      }
    }
    do {
      if (novis.value !== 0 || Visibility.viewleaf === null) {
        break;
      }
      const p = Camera.refdef.vieworg.copy();
      let leaf: Node;
      if (Visibility.viewleaf.contents <= content.CONTENT_WATER) {
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
      if (leaf === Visibility.viewleaf) {
        break;
      }
      const vis = worldmodel.getPvsByLeaf(leaf);
      for (let i = 1; i < worldmodel.leafs.length; i++) {
        if (!vis.isRevealed(i)) {
          continue;
        }
        if (clientCvars.areaportals.value > 0 && !worldmodel.areaPortals.leafsConnected(Visibility.viewleaf, worldmodel.leafs[i])) {
          continue;
        }
        for (let node: Node | null = worldmodel.leafs[i]; node !== null; node = node.parent) {
          if (node.markvisframe === Visibility.visframecount) {
            break;
          }
          node.markvisframe = Visibility.visframecount;
        }
      }
    // eslint-disable-next-line no-constant-condition
    } while (false);
    Visibility.skyVisible = false;
    Visibility.#walkMarkedNodes(worldmodel.nodes[0]);
  }

  /**
   * Stamps the leafs that were marked in this marking with the current frame count and notes whether one of
   * them has sky surfaces.
   */
  static #walkMarkedNodes(node: Node): void {
    if (node.contents === content.CONTENT_SOLID) {
      return;
    }
    if (node.contents < content.CONTENT_NONE) {
      if (node.markvisframe !== Visibility.visframecount) {
        return;
      }
      node.visframe = Visibility.visframecount;
      if (node.skychain !== node.waterchain) {
        Visibility.skyVisible = true;
      }
      return;
    }
    const frontChild = node.children[0] as Node;
    const backChild = node.children[1] as Node;
    console.assert(frontChild instanceof Node, `Visibility.#walkMarkedNodes expected linked BSP child 0 on node ${node.num}`);
    console.assert(backChild instanceof Node, `Visibility.#walkMarkedNodes expected linked BSP child 1 on node ${node.num}`);
    Visibility.#walkMarkedNodes(frontChild);
    Visibility.#walkMarkedNodes(backChild);
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
