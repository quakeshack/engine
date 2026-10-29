import type { BrushModel, WorldSurfaceBatch } from './BSP.ts';

/**
 * What the renderer keeps per node and leaf of one view of a map: which of them the last marking revealed, the draw
 * chains the display list builder made per leaf, and the bounds of a leaf grown to contain its surfaces. It is the
 * mutable half of the BSP tree: the tree itself (`NodeTable`, `LeafTable`) never changes after loading and is shared.
 *
 * A node has the index it has in the node table; the slot of a leaf follows the nodes (`nodeCount + leaf`), so one array
 * holds the marks of both.
 */
export class WorldRenderState {
  /** Number of nodes, which is where the slots of the leafs start. */
  readonly nodeCount: number;

  /** The marking that last reached each node and leaf. */
  readonly markframes: Int32Array;

  /** The marking that revealed each leaf. A leaf is drawn when this is the current marking. */
  readonly visframes: Int32Array;

  /**
   * The leafs the last marking revealed, in leaf order: the ones whose `visframes` entry is the current marking. The
   * passes of a frame walk this instead of every leaf of the map. It changes only when the view leaf does.
   */
  readonly visibleLeafs: number[] = [];

  /** Number of draw chains of each leaf that are sky or opaque surfaces (the chains before the water ones). */
  readonly skychains: Int32Array;

  /** Number of draw chains of each leaf before its turbulent ones. */
  readonly waterchains: Int32Array;

  /** Draw chains of each leaf, `[texture, first vertex, count]`. */
  readonly cmds: number[][][];

  /** Tight turbulent draw batches of each leaf for sorted world rendering. */
  readonly turbulentChains: WorldSurfaceBatch[][];

  /**
   * Tight batches of the translucent surfaces of each leaf that are not liquids (fences, glass), for sorted world
   * rendering. They are not among the draw chains of `cmds`. A batch on the boundary of leafs is in each of them.
   */
  readonly transparentBatches: WorldSurfaceBatch[][];

  /** Bounds of each leaf, six values, grown while the display lists are packed. */
  readonly leafBounds: Float32Array;

  readonly #model: BrushModel;

  constructor(model: BrushModel) {
    const leafCount = model.leafTable.count;

    this.#model = model;
    this.nodeCount = model.nodeTable.count;
    this.markframes = new Int32Array(this.nodeCount + leafCount);
    this.visframes = new Int32Array(leafCount);
    this.skychains = new Int32Array(leafCount);
    this.waterchains = new Int32Array(leafCount);
    this.cmds = Array.from({ length: leafCount }, () => []);
    this.turbulentChains = Array.from({ length: leafCount }, () => []);
    this.transparentBatches = Array.from({ length: leafCount }, () => []);
    this.leafBounds = model.leafTable.bounds.slice();
  }

  /**
   * The state of a view of the map, made when it is first needed.
   * @param model The view of the map.
   * @returns Its render state.
   */
  static of(model: BrushModel): WorldRenderState {
    model.renderState ??= new WorldRenderState(model);

    return model.renderState;
  }

  /**
   * Forgets the marks and the draw chains, and restores the bounds of the leafs, before the display lists are rebuilt.
   */
  reset(): void {
    this.markframes.fill(0);
    this.visframes.fill(0);
    this.visibleLeafs.length = 0;
    this.skychains.fill(0);
    this.waterchains.fill(0);
    this.leafBounds.set(this.#model.leafTable.bounds);

    for (let leaf = 0; leaf < this.cmds.length; leaf++) {
      this.cmds[leaf].length = 0;
      this.turbulentChains[leaf].length = 0;
      this.transparentBatches[leaf].length = 0;
    }
  }
}
