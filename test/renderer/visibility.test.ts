import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import Visibility from '../../source/engine/client/renderer/scene/Visibility.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { BrushModel, Node } from '../../source/engine/common/model/BSP.ts';
import { content } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
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

void describe('Visibility.MarkLeafs', () => {
  const previous = {
    visframecount: Visibility.visframecount,
    viewleaf: Visibility.viewleaf,
    oldviewleaf: Visibility.oldviewleaf,
    skyVisible: Visibility.skyVisible,
    novis: rendererCvars.novis,
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
    Visibility.visframecount = 100;
    Visibility.viewleaf = world.leafs[1];
    Visibility.oldviewleaf = null;
    Visibility.skyVisible = false;
    rendererCvars.novis = { value: 0 } as unknown as Cvar;
    install();
  });

  afterEach(() => {
    restoreClientState();
    Visibility.visframecount = previous.visframecount;
    Visibility.viewleaf = previous.viewleaf;
    Visibility.oldviewleaf = previous.oldviewleaf;
    Visibility.skyVisible = previous.skyVisible;
    rendererCvars.novis = previous.novis;
  });

  void test('advances the frame counter and remembers the leaf it marked for', () => {
    Visibility.MarkLeafs();

    assert.equal(Visibility.visframecount, 101);
    assert.equal(Visibility.oldviewleaf, world.leafs[1]);
  });

  void test('does nothing while the view stays in the same leaf', () => {
    Visibility.MarkLeafs();
    Visibility.MarkLeafs();

    assert.equal(Visibility.visframecount, 101);
  });

  void test('marks again every frame with r_novis set, as the visible set is not cached then', () => {
    rendererCvars.novis = { value: 1 } as unknown as Cvar;

    Visibility.MarkLeafs();
    Visibility.MarkLeafs();

    assert.equal(Visibility.visframecount, 102);
  });

  void test('stamps the leafs the PVS reveals and leaves the others alone', () => {
    world.revealedLeafs.add(1);

    Visibility.MarkLeafs();

    assert.equal(world.leafs[1].visframe, Visibility.visframecount);
    assert.notEqual(world.leafs[2].visframe, Visibility.visframecount);
  });

  void test('marks the parents of a revealed leaf so the BSP walk can reach it', () => {
    world.revealedLeafs.add(2);

    Visibility.MarkLeafs();

    assert.equal(world.root.markvisframe, Visibility.visframecount);
    assert.equal(world.leafs[2].markvisframe, Visibility.visframecount);
    assert.notEqual(world.leafs[1].markvisframe, Visibility.visframecount);
  });

  void test('reveals every leaf when r_novis is 1', () => {
    rendererCvars.novis = { value: 1 } as unknown as Cvar;

    Visibility.MarkLeafs();

    assert.equal(world.leafs[1].visframe, Visibility.visframecount);
    assert.equal(world.leafs[2].visframe, Visibility.visframecount);
  });

  void test('skips leafs that the area portals cut off when cl_areaportals is on', () => {
    restoreClientState();
    areaportals = 1;
    install();
    world.revealedLeafs.add(1);
    world.revealedLeafs.add(2);
    world.connected = false;

    Visibility.MarkLeafs();

    assert.notEqual(world.leafs[1].visframe, Visibility.visframecount);
    assert.notEqual(world.leafs[2].visframe, Visibility.visframecount);
  });

  void test('ignores the area portals when cl_areaportals is off', () => {
    world.revealedLeafs.add(1);
    world.connected = false;

    Visibility.MarkLeafs();

    assert.equal(world.leafs[1].visframe, Visibility.visframecount);
  });

  void test('asks for the sky when a visible leaf has sky surfaces', () => {
    world.revealedLeafs.add(1);
    world.leafs[1].skychain = 0;
    world.leafs[1].waterchain = 2;

    Visibility.MarkLeafs();

    assert.equal(Visibility.skyVisible, true);
  });

  void test('does not ask for the sky when no visible leaf has sky surfaces', () => {
    world.revealedLeafs.add(1);

    Visibility.MarkLeafs();

    assert.equal(Visibility.skyVisible, false);
  });
});

void describe('Visibility view leaf', () => {
  const previous = {
    viewleaf: Visibility.viewleaf,
    oldviewleaf: Visibility.oldviewleaf,
    vieworg: Camera.refdef.vieworg.copy(),
  };
  let restoreClientState: () => void = () => {};

  afterEach(() => {
    restoreClientState();
    Visibility.viewleaf = previous.viewleaf;
    Visibility.oldviewleaf = previous.oldviewleaf;
    Camera.refdef.vieworg.set(previous.vieworg);
  });

  void test('UpdateViewLeaf asks the world for the leaf at the view origin and returns it', () => {
    const asked: number[][] = [];
    const leaf = createNode(5, content.CONTENT_WATER);

    restoreClientState = useClientStateOf({
      state: {
        worldmodel: {
          getLeafForPoint: (point: Vector) => {
            asked.push([point[0], point[1], point[2]]);
            return leaf;
          },
        },
      },
    });
    Camera.refdef.vieworg.setTo(12.0, -34.0, 56.0);

    assert.equal(Visibility.UpdateViewLeaf(), leaf);
    assert.equal(Visibility.viewleaf, leaf);
    assert.deepEqual(asked, [[12.0, -34.0, 56.0]]);
  });

  void test('Reset forgets the view leaf and the marking so the next frame marks again', () => {
    Visibility.viewleaf = createNode(1, content.CONTENT_EMPTY);
    Visibility.oldviewleaf = createNode(1, content.CONTENT_EMPTY);

    Visibility.Reset();

    assert.equal(Visibility.viewleaf, null);
    assert.equal(Visibility.oldviewleaf, null);
  });
});

void describe('view leaf invalidation', () => {
  const previousOldViewLeaf = Visibility.oldviewleaf;

  beforeEach(() => {
    Visibility.oldviewleaf = createNode(1, content.CONTENT_EMPTY);
  });

  afterEach(() => {
    Visibility.oldviewleaf = previousOldViewLeaf;
  });

  void test('is forced when the area portals change', () => {
    eventBus.publish('areaportals.changed');

    assert.equal(Visibility.oldviewleaf, null);
  });

  void test('is forced when r_novis changes', () => {
    eventBus.publish('cvar.changed', 'r_novis');

    assert.equal(Visibility.oldviewleaf, null);
  });

  void test('is forced when cl_areaportals changes', () => {
    eventBus.publish('cvar.changed', 'cl_areaportals');

    assert.equal(Visibility.oldviewleaf, null);
  });

  void test('is kept when an unrelated console variable changes', () => {
    eventBus.publish('cvar.changed', 'r_bloom');

    assert.notEqual(Visibility.oldviewleaf, null);
  });
});
