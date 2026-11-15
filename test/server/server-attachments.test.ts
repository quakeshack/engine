import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Visibility } from '../../source/engine/common/model/BSP.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { ED, ServerEdict } from '../../source/engine/server/Edict.ts';
import { ServerMessages } from '../../source/engine/server/ServerMessages.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { ServerEntityState } from '../../source/engine/server/ServerEntityState.ts';
import type Server from '../../source/engine/server/Server.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';
import { defaultMockEngine, mockedSV, withMockEngine } from '../support/fixtures.ts';
import { createFlashModel } from '../support/skeletalModels.ts';

type EdictEntity = NonNullable<ServerEdict['entity']>;

/** What a test gives an entity beyond the inert defaults. */
interface EntityMembers {
  origin?: number[];
  angles?: number[];
  modelindex?: number;
  frame?: number;
  sequence?: number;
  animtime?: number | null;
}

/**
 * @param members What the entity has.
 * @returns An entity that does nothing but sit where it is, `SOLID_NOT` as an attached entity has to be.
 */
function createEntity(members: EntityMembers = {}): EdictEntity {
  return {
    classname: 'test',
    angles: new Vector(...(members.angles ?? [0, 0, 0]) as [number, number, number]),
    origin: new Vector(...(members.origin ?? [0, 0, 0]) as [number, number, number]),
    modelindex: members.modelindex ?? 0,
    frame: members.frame ?? 0,
    sequence: members.sequence,
    animtime: members.animtime,
    framerate: 1,
    solid: 0,
    clear() {},
    free() {},
  } as unknown as EdictEntity;
}

/** The world a test runs the server in. */
interface World {
  edicts: ServerEdict[];
  warnings: string[];
  debug: string[];
  linked: number[];
  models: Array<BaseModel | null>;
  run(callback: () => void): void;
  edict(entity?: EntityMembers): ServerEdict;
}

/**
 * Builds a server with a model table and area that remembers what was linked.
 * @returns The world, `run` installs it for a callback.
 */
function createWorld(): World {
  const world: World = {
    edicts: [],
    warnings: [],
    debug: [],
    linked: [],
    models: [null, createFlashModel()],
    run(callback) {
      withMockEngine(defaultMockEngine({
        server: { models: world.models, time: 10, edicts: world.edicts, num_edicts: 0 },
        area: { unlinkEdict() {}, linkEdict(edict: ServerEdict) { world.linked.push(edict.num); } },
        con: { PrintWarning(message: string) { world.warnings.push(message); }, DPrint(message: string) { world.debug.push(message); }, Print() {} },
      }), callback);
    },
    edict(entity = {}) {
      const edict = new ServerEdict(world.edicts.length, mockedSV());

      edict.entity = createEntity(entity);
      world.edicts.push(edict);
      return edict;
    },
  };

  return world;
}

/**
 * @param leafs The leaves that are revealed.
 * @returns A visibility that reveals an edict when any of its leaves is one of them.
 */
function revealing(leafs: number[]): Visibility {
  return { areRevealed: (edictLeafs: number[]) => edictLeafs.some((leaf) => leafs.includes(leaf)) } as unknown as Visibility;
}

void describe('ServerEdict.setAttachment', () => {
  void test('makes the child known to the parent, and clearAttachment forgets it again', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict();
      const child = world.edict();

      child.setAttachment(parent, 'tag_flash');
      assert.equal(child.attachmentParent, parent);
      assert.deepEqual([...parent.attachedChildren], [child]);

      child.clearAttachment();
      assert.equal(child.attachmentParent, null);
      assert.equal(parent.attachedChildren.size, 0);
    });
  });

  void test('moves the child from the old parent to the new one', () => {
    const world = createWorld();

    world.run(() => {
      const first = world.edict();
      const second = world.edict();
      const child = world.edict();

      child.setAttachment(first);
      child.setAttachment(second);

      assert.equal(first.attachedChildren.size, 0);
      assert.deepEqual([...second.attachedChildren], [child]);
    });
  });

  void test('refuses an entity attached to itself, and a loop of any length, with a warning, and changes nothing', () => {
    const world = createWorld();

    world.run(() => {
      const first = world.edict();
      const second = world.edict();
      const third = world.edict();

      first.setAttachment(first);
      assert.equal(first.attachmentParent, null);

      second.setAttachment(first);
      third.setAttachment(second);
      first.setAttachment(third);

      assert.equal(first.attachmentParent, null, 'the third would carry the first, which it hangs under');
      assert.equal(third.attachmentParent, second);
      assert.equal(world.warnings.length, 2);
    });
  });

  void test('refuses a free parent or a free child', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict();
      const child = world.edict();
      const gone = world.edict();

      gone.entity = null;
      child.setAttachment(gone);
      gone.setAttachment(parent);

      assert.equal(child.attachmentParent, null);
      assert.equal(gone.attachmentParent, null);
      assert.equal(world.warnings.length, 2);
    });
  });

  void test('treats an empty tag name as no tag', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict({ modelindex: 1 });
      const child = world.edict();

      child.setAttachment(parent, '');
      assert.equal(child.attachmentTagIndex(), -1);
      assert.deepEqual(world.debug, [], 'no tag was asked for, so none is missing');
    });
  });

  void test('forgets the parent when the edict is cleared for reuse', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict();
      const child = world.edict();

      child.setAttachment(parent);
      child.clear();

      assert.equal(child.attachmentParent, null);
      assert.equal(parent.attachedChildren.size, 0);
    });
  });
});

void describe('ServerEdict.attachmentTagIndex', () => {
  void test('looks the tag up in the parent\'s current model, by name', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict({ modelindex: 1 });
      const child = world.edict();

      child.setAttachment(parent, 'tag_flash');
      assert.equal(child.attachmentTagIndex(), 1);
    });
  });

  void test('follows the parent to another model without being told again, and falls to the origin when that has no such tag', () => {
    const world = createWorld();
    const plain = createFlashModel();

    plain.jointNames = ['root', 'barrel'];
    world.models.push(plain);

    world.run(() => {
      const parent = world.edict({ modelindex: 1 });
      const child = world.edict();

      child.setAttachment(parent, 'tag_flash');
      assert.equal(child.attachmentTagIndex(), 1);

      parent.entity!.modelindex = 2;
      assert.equal(child.attachmentTagIndex(), -1);

      parent.entity!.modelindex = 1;
      assert.equal(child.attachmentTagIndex(), 1);
    });
  });

  void test('says -1 for a parent without a model or whose model has not loaded, and reports a missing tag once', () => {
    const world = createWorld();

    world.models.push(Promise.resolve(createFlashModel()) as unknown as BaseModel);

    world.run(() => {
      const parent = world.edict({ modelindex: 0 });
      const child = world.edict();

      child.setAttachment(parent, 'tag_flash');
      assert.equal(child.attachmentTagIndex(), -1);

      parent.entity!.modelindex = 2;
      assert.equal(child.attachmentTagIndex(), -1);
      assert.equal(world.debug.length, 1, 'once for the attachment, not once per frame per client');
      assert.match(world.debug[0], /tag_flash/);
    });
  });

  void test('says -1 for an entity that is not attached', () => {
    const world = createWorld();

    world.run(() => {
      assert.equal(world.edict({ modelindex: 1 }).attachmentTagIndex(), -1);
    });
  });
});

void describe('ServerEdict.isInPXS with attachments', () => {
  // The child's own origin is an offset in tag space, so the leaves it was linked into are wherever the map's origin
  // is. Looked up there it would pop in and out of view on its own, away from its parent.
  void test('answers for the parent, whatever leaves the child was linked into', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict();
      const child = world.edict();

      parent.leafnums = [5];
      child.leafnums = [99];
      child.setAttachment(parent);

      assert.equal(child.isInPXS(revealing([5])), true);
      assert.equal(child.isInPXS(revealing([99])), false);
    });
  });

  void test('follows a whole chain to its root', () => {
    const world = createWorld();

    world.run(() => {
      const player = world.edict();
      const weapon = world.edict();
      const flash = world.edict();

      player.leafnums = [5];
      weapon.setAttachment(player);
      flash.setAttachment(weapon);

      assert.equal(flash.isInPXS(revealing([5])), true);
      assert.equal(flash.isInPXS(revealing([6])), false);
    });
  });

  void test('is unchanged for an entity that stands free', () => {
    const world = createWorld();

    world.run(() => {
      const edict = world.edict();

      edict.leafnums = [3];
      assert.equal(edict.isInPXS(revealing([3])), true);
      assert.equal(edict.isInPXS(revealing([4])), false);
    });
  });
});

void describe('ED.Free with attached entities', () => {
  // A weapon its owner drops, or a flash on a monster that dies, must stay where it was held. Its own origin was an
  // offset in tag space, which as a world position is a point near the origin of the map.
  void test('keeps a child where it was in the world, turned as it was, and lets go of it', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict({ origin: [100, 200, 300], angles: [0, 90, 0], modelindex: 1 });
      const child = world.edict({ origin: [0, 0, 3], angles: [0, 0, 0] });

      child.setAttachment(parent, 'tag_flash');
      new ED(mockedSV()).Free(parent);

      // the parent faces +Y, its tag is 10 along that, and the child is 3 above the tag
      assertNear(child.entity!.origin[0], 100, 1e-4);
      assertNear(child.entity!.origin[1], 210, 1e-4);
      assertNear(child.entity!.origin[2], 303, 1e-4);
      assertNear(child.entity!.angles[1], 90, 1e-4);
      assert.equal(child.attachmentParent, null);
      assert.ok(world.linked.includes(child.num), 'it is relinked at the new place');
    });
  });

  void test('puts the child where the parent\'s pose has the tag: frame 1 turns it, and turns the child with it', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict({ origin: [100, 200, 300], modelindex: 1, frame: 1 });
      const child = world.edict({ origin: [5, 0, 0] });

      child.setAttachment(parent, 'tag_flash');
      new ED(mockedSV()).Free(parent);

      // the tag at frame 1 is turned 90 degrees about Z, so the child's X offset points along the world's Y
      assertNear(child.entity!.origin[0], 110, 1e-4);
      assertNear(child.entity!.origin[1], 205, 1e-4);
      assertNear(child.entity!.angles[1], 90, 1e-3);
    });
  });

  void test('follows a sequence from the animtime the game set', () => {
    const world = createWorld();

    world.run(() => {
      // `turn` plays frame 0, then 1, at 10 fps: 0.15 s in is on frame 1
      const parent = world.edict({ origin: [0, 0, 0], modelindex: 1, sequence: 0, animtime: 9.85 });
      const child = world.edict();

      child.setAttachment(parent, 'tag_flash');
      new ED(mockedSV()).Free(parent);

      assertNear(child.entity!.angles[1], 90, 1e-3);
    });
  });

  void test('releases every child, and the grandchildren keep following their own parent', () => {
    const world = createWorld();

    world.run(() => {
      const player = world.edict({ origin: [100, 200, 300], modelindex: 1 });
      const weapon = world.edict({ modelindex: 1 });
      const flash = world.edict({ origin: [0, 0, 1] });
      const badge = world.edict();

      weapon.setAttachment(player, 'tag_flash');
      flash.setAttachment(weapon, 'tag_flash');
      badge.setAttachment(player);
      new ED(mockedSV()).Free(player);

      assert.equal(weapon.attachmentParent, null);
      assert.equal(badge.attachmentParent, null);
      assert.equal(flash.attachmentParent, weapon, 'the weapon is still there to follow');
      assertNear(weapon.entity!.origin[0], 110, 1e-4);
      assertNear(badge.entity!.origin[0], 100, 1e-4);
    });
  });

  void test('forgets a freed child, so it is not carried to a parent later freed', () => {
    const world = createWorld();

    world.run(() => {
      const parent = world.edict({ origin: [100, 200, 300] });
      const child = world.edict();

      child.setAttachment(parent);
      new ED(mockedSV()).Free(child);

      assert.equal(parent.attachedChildren.size, 0);
      assert.doesNotThrow(() => { new ED(mockedSV()).Free(parent); });
    });
  });
});

void describe('ServerMessages.writeEntitiesToClient with attachments', () => {
  /**
   * Sends the entities of a world to one client whose view reveals `revealed`, and reads back what the server now
   * believes the client knows.
   * @param world The world, with its edicts.
   * @param revealed The leaves the client's PVS reveals.
   * @returns The state of every edict number, as the client holds it.
   */
  function send(world: World, revealed: number[]): (num: number) => ServerEntityState {
    const states = new Map<number, ServerEntityState>();
    const client = {
      state: 0,
      getEntityState(num: number): ServerEntityState {
        if (!states.has(num)) {
          states.set(num, new ServerEntityState(num));
        }

        return states.get(num)!;
      },
    };
    const sv = {
      server: { time: 10, edicts: world.edicts, num_edicts: world.edicts.length, worldmodel: { getFatPvsByPoint: () => revealing(revealed) }, clientEntityFields: {} },
      svs: { maxclients: 0, clients: [client] },
      con: { PrintWarning() {}, DPrint() {} },
    } as unknown as Server;

    for (const edict of world.edicts) {
      Object.assign(edict.entity!, { classname: 'test', model: 'x', colormap: 0, skin: 0, effects: 0, alpha: 1, velocity: new Vector(), maxs: new Vector(), mins: new Vector(), nextthink: 0, view_ofs: new Vector() });
    }

    // edict 0 is the world and edict 1 the client, which is always included; the others follow the PVS
    new ServerMessages(sv).writeEntitiesToClient(world.edicts[1], new SzBuffer(4096, 'attachment test'));

    return (num) => client.getEntityState(num);
  }

  void test('sends a child with the number of its parent and the tag index of the parent\'s model, wherever the child\'s own leaves are', () => {
    const world = createWorld();

    world.run(() => {
      world.edict();
      world.edict();
      const parent = world.edict({ origin: [100, 200, 300], modelindex: 1 });
      const child = world.edict({ origin: [0, 0, 3] });

      parent.leafnums = [5];
      child.leafnums = [99];
      child.setAttachment(parent, 'tag_flash');

      const state = send(world, [5]);

      assert.equal(state(child.num).free, false, 'the child is sent because its parent is');
      assert.equal(state(child.num).attachmentParent, parent.num);
      assert.equal(state(child.num).attachmentTag, 1);
      assert.equal(state(parent.num).attachmentParent, 0);
    });
  });

  // A player in noclip inside a wall is linked into no leaf, so there is nothing to look up for the weapon in its hand.
  void test('sends what hangs on the client\'s own entity, which is always sent, although that has no leaves', () => {
    const world = createWorld();

    world.run(() => {
      world.edict();
      const player = world.edict({ modelindex: 1 });
      const weapon = world.edict();

      player.leafnums = [];
      weapon.leafnums = [99];
      weapon.setAttachment(player, 'tag_flash');

      const state = send(world, [5]);

      assert.equal(state(weapon.num).free, false);
      assert.equal(state(weapon.num).attachmentParent, player.num);
    });
  });

  void test('sends neither when the parent is out of view, although the child\'s own leaves are in it', () => {
    const world = createWorld();

    world.run(() => {
      world.edict();
      world.edict();
      const parent = world.edict({ modelindex: 1 });
      const child = world.edict();

      parent.leafnums = [5];
      child.leafnums = [99];
      child.setAttachment(parent, 'tag_flash');

      const state = send(world, [99]);

      assert.equal(state(child.num).free, true);
      assert.equal(state(parent.num).free, true);
    });
  });
});
