import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import Visibility from '../../source/engine/client/renderer/scene/Visibility.ts';
import { createCvarStub } from '../support/cvarStub.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { WorldRenderState } from '../../source/engine/common/model/WorldRenderState.ts';
import { content } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { createTreeModel } from '../support/bspTree.ts';

interface FakeWorld {
  readonly worldmodel: BrushModel;
  readonly state: WorldRenderState;
  readonly revealedLeafs: Set<number>;
  connected: boolean;
}

/**
 * Builds the smallest map that has something to mark: a root node with two empty leafs, leaf 0 being the
 * solid leaf every BSP has. Which leafs the PVS reveals is controlled through `revealedLeafs`.
 * @returns The fake world.
 */
function createWorld(): FakeWorld {
  const worldmodel = createTreeModel(
    [{ normal: [1, 0, 0], dist: 0, type: 0 }],
    [{ planeNum: 0, children: [~1, ~2] }],
    [{ contents: content.CONTENT_SOLID }, { contents: content.CONTENT_EMPTY }, { contents: content.CONTENT_EMPTY }],
  );
  const revealedLeafs = new Set<number>();
  const visibility = { isRevealed: (leaf: number): boolean => revealedLeafs.has(leaf) };

  const world: FakeWorld = {
    worldmodel,
    state: WorldRenderState.of(worldmodel),
    revealedLeafs,
    connected: true,
  };

  const overrides = worldmodel as unknown as Record<string, unknown>;

  overrides.getPvsByLeaf = () => visibility;
  overrides.getPhsByLeaf = () => visibility;
  // the player stands in empty space, so the "just above/below the water line" lookup finds nothing new
  overrides.getLeafIndexForPoint = () => 1;
  overrides.leafsConnected = () => world.connected;

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
    Visibility.viewleaf = 1;
    Visibility.oldviewleaf = null;
    Visibility.skyVisible = false;
    rendererCvars.novis = createCvarStub(0);
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
    assert.equal(Visibility.oldviewleaf, 1);
  });

  void test('does nothing while the view stays in the same leaf', () => {
    Visibility.MarkLeafs();
    Visibility.MarkLeafs();

    assert.equal(Visibility.visframecount, 101);
  });

  void test('marks again every frame with r_novis set, as the visible set is not cached then', () => {
    rendererCvars.novis = createCvarStub(1);

    Visibility.MarkLeafs();
    Visibility.MarkLeafs();

    assert.equal(Visibility.visframecount, 102);
  });

  void test('stamps the leafs the PVS reveals and leaves the others alone', () => {
    world.revealedLeafs.add(1);

    Visibility.MarkLeafs();

    assert.equal(world.state.visframes[1], Visibility.visframecount);
    assert.notEqual(world.state.visframes[2], Visibility.visframecount);
  });

  void test('marks the parents of a revealed leaf so the BSP walk can reach it', () => {
    world.revealedLeafs.add(2);

    Visibility.MarkLeafs();

    // the marks of the nodes come first, then those of the leafs
    assert.equal(world.state.markframes[0], Visibility.visframecount);
    assert.equal(world.state.markframes[world.state.nodeCount + 2], Visibility.visframecount);
    assert.notEqual(world.state.markframes[world.state.nodeCount + 1], Visibility.visframecount);
  });

  void test('reveals every leaf when r_novis is 1', () => {
    rendererCvars.novis = createCvarStub(1);

    Visibility.MarkLeafs();

    assert.equal(world.state.visframes[1], Visibility.visframecount);
    assert.equal(world.state.visframes[2], Visibility.visframecount);
  });

  void test('skips leafs that the area portals cut off when cl_areaportals is on', () => {
    restoreClientState();
    areaportals = 1;
    install();
    world.revealedLeafs.add(1);
    world.revealedLeafs.add(2);
    world.connected = false;

    Visibility.MarkLeafs();

    assert.notEqual(world.state.visframes[1], Visibility.visframecount);
    assert.notEqual(world.state.visframes[2], Visibility.visframecount);
  });

  void test('ignores the area portals when cl_areaportals is off', () => {
    world.revealedLeafs.add(1);
    world.connected = false;

    Visibility.MarkLeafs();

    assert.equal(world.state.visframes[1], Visibility.visframecount);
  });

  void test('asks for the sky when a visible leaf has sky surfaces', () => {
    world.revealedLeafs.add(1);
    world.state.skychains[1] = 0;
    world.state.waterchains[1] = 2;

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
    const leaf = 5;

    restoreClientState = useClientStateOf({
      state: {
        worldmodel: {
          getLeafIndexForPoint: (point: Vector) => {
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
    Visibility.viewleaf = 1;
    Visibility.oldviewleaf = 1;

    Visibility.Reset();

    assert.equal(Visibility.viewleaf, null);
    assert.equal(Visibility.oldviewleaf, null);
  });
});

void describe('view leaf invalidation', () => {
  const previousOldViewLeaf = Visibility.oldviewleaf;

  beforeEach(() => {
    Visibility.oldviewleaf = 1;
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
