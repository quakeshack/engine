import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import R from '../../source/engine/client/R.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { BrushModel, Node } from '../../source/engine/common/model/BSP.ts';
import { content } from '../../source/shared/Defs.ts';
import { useClientStateOf } from '../support/clientState.ts';

interface FakeWorld {
  readonly worldmodel: BrushModel;
  readonly root: Node;
  readonly leafs: Node[];
  readonly revealedLeafs: Set<number>;
  connected: boolean;
}

/**
 * Creates a node or a leaf that is not attached to a real map.
 * @param num Node or leaf number.
 * @param contents Contents, `CONTENT_NONE` for a node and a negative value for a leaf.
 * @returns The node.
 */
function createNode(num: number, contents: content): Node {
  const node = new Node({} as BrushModel);

  node.num = num;
  node.contents = contents;

  return node;
}

/**
 * Builds the smallest map that has something to mark: a root node with two empty leafs, leaf 0 being the
 * solid leaf every BSP has. Which leafs the PVS reveals is controlled through `revealedLeafs`.
 * @returns The fake world.
 */
function createWorld(): FakeWorld {
  const root = createNode(0, content.CONTENT_NONE);
  const leafs = [
    createNode(0, content.CONTENT_SOLID),
    createNode(1, content.CONTENT_EMPTY),
    createNode(2, content.CONTENT_EMPTY),
  ];

  leafs[1].parent = root;
  leafs[2].parent = root;
  root.children = [leafs[1], leafs[2]];

  const revealedLeafs = new Set<number>();
  const visibility = { isRevealed: (leaf: number): boolean => revealedLeafs.has(leaf) };

  const world: FakeWorld = {
    root,
    leafs,
    revealedLeafs,
    connected: true,
    worldmodel: null!,
  };

  (world as { worldmodel: BrushModel }).worldmodel = {
    nodes: [root],
    leafs,
    getPvsByLeaf: () => visibility,
    getPhsByLeaf: () => visibility,
    // the player stands in empty space, so the "just above/below the water line" lookup finds nothing new
    getLeafForPoint: () => leafs[1],
    areaPortals: { leafsConnected: () => world.connected },
  } as unknown as BrushModel;

  return world;
}

void describe('R.MarkLeafs', () => {
  const previous = {
    visframecount: R.visframecount,
    viewleaf: R.viewleaf,
    oldviewleaf: R.oldviewleaf,
    drawsky: R.drawsky,
    novis: R.novis,
  };
  let world: FakeWorld = null!;
  let areaportals = 0;
  let restoreClientState: () => void = () => {};

  /**
   * Installs the fake world and the console variables `MarkLeafs` reads.
   */
  function install(): void {
    restoreClientState = useClientStateOf({
      state: { worldmodel: world.worldmodel },
      areaportals: { value: areaportals },
    });
  }

  beforeEach(() => {
    world = createWorld();
    areaportals = 0;
    R.visframecount = 100;
    R.viewleaf = world.leafs[1];
    R.oldviewleaf = null;
    R.drawsky = false;
    R.novis = { value: 0 } as unknown as Cvar;
    install();
  });

  afterEach(() => {
    restoreClientState();
    R.visframecount = previous.visframecount;
    R.viewleaf = previous.viewleaf;
    R.oldviewleaf = previous.oldviewleaf;
    R.drawsky = previous.drawsky;
    R.novis = previous.novis;
  });

  void test('advances the frame counter and remembers the leaf it marked for', () => {
    R.MarkLeafs();

    assert.equal(R.visframecount, 101);
    assert.equal(R.oldviewleaf, world.leafs[1]);
  });

  void test('does nothing while the view stays in the same leaf', () => {
    R.MarkLeafs();
    R.MarkLeafs();

    assert.equal(R.visframecount, 101);
  });

  void test('marks again every frame with r_novis set, as the visible set is not cached then', () => {
    R.novis = { value: 1 } as unknown as Cvar;

    R.MarkLeafs();
    R.MarkLeafs();

    assert.equal(R.visframecount, 102);
  });

  void test('stamps the leafs the PVS reveals and leaves the others alone', () => {
    world.revealedLeafs.add(1);

    R.MarkLeafs();

    assert.equal(world.leafs[1].visframe, R.visframecount);
    assert.notEqual(world.leafs[2].visframe, R.visframecount);
  });

  void test('marks the parents of a revealed leaf so the BSP walk can reach it', () => {
    world.revealedLeafs.add(2);

    R.MarkLeafs();

    assert.equal(world.root.markvisframe, R.visframecount);
    assert.equal(world.leafs[2].markvisframe, R.visframecount);
    assert.notEqual(world.leafs[1].markvisframe, R.visframecount);
  });

  void test('reveals every leaf when r_novis is 1', () => {
    R.novis = { value: 1 } as unknown as Cvar;

    R.MarkLeafs();

    assert.equal(world.leafs[1].visframe, R.visframecount);
    assert.equal(world.leafs[2].visframe, R.visframecount);
  });

  void test('skips leafs that the area portals cut off when cl_areaportals is on', () => {
    restoreClientState();
    areaportals = 1;
    install();
    world.revealedLeafs.add(1);
    world.revealedLeafs.add(2);
    world.connected = false;

    R.MarkLeafs();

    assert.notEqual(world.leafs[1].visframe, R.visframecount);
    assert.notEqual(world.leafs[2].visframe, R.visframecount);
  });

  void test('ignores the area portals when cl_areaportals is off', () => {
    world.revealedLeafs.add(1);
    world.connected = false;

    R.MarkLeafs();

    assert.equal(world.leafs[1].visframe, R.visframecount);
  });

  void test('asks for the sky when a visible leaf has sky surfaces', () => {
    world.revealedLeafs.add(1);
    world.leafs[1].skychain = 0;
    world.leafs[1].waterchain = 2;

    R.MarkLeafs();

    assert.equal(R.drawsky, true);
  });

  void test('does not ask for the sky when no visible leaf has sky surfaces', () => {
    world.revealedLeafs.add(1);

    R.MarkLeafs();

    assert.equal(R.drawsky, false);
  });
});

void describe('view leaf invalidation', () => {
  const previousOldViewLeaf = R.oldviewleaf;

  beforeEach(() => {
    R.oldviewleaf = createNode(1, content.CONTENT_EMPTY);
  });

  afterEach(() => {
    R.oldviewleaf = previousOldViewLeaf;
  });

  void test('is forced when the area portals change', () => {
    eventBus.publish('areaportals.changed');

    assert.equal(R.oldviewleaf, null);
  });

  void test('is forced when r_novis changes', () => {
    eventBus.publish('cvar.changed', 'r_novis');

    assert.equal(R.oldviewleaf, null);
  });

  void test('is forced when cl_areaportals changes', () => {
    eventBus.publish('cvar.changed', 'cl_areaportals');

    assert.equal(R.oldviewleaf, null);
  });

  void test('is kept when an unrelated console variable changes', () => {
    eventBus.publish('cvar.changed', 'r_bloom');

    assert.notEqual(R.oldviewleaf, null);
  });
});
