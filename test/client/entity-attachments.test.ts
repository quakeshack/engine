import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Chase from '../../source/engine/client/Chase.ts';
import ClientEntities, { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { EntityAttachments } from '../../source/engine/client/EntityAttachments.ts';
import { EntityTags } from '../../source/engine/client/EntityTags.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { MAX_ATTACHMENT_DEPTH, TRANSFORM_SIZE } from '../../source/engine/common/AttachmentTransform.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { JointAdjustments } from '../../source/engine/common/model/JointAdjustments.ts';
import { effect, modelFlags } from '../../source/shared/Defs.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';
import { createFlashModel } from '../support/skeletalModels.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/**
 * @param model The model the entity shows.
 * @param origin Where the entity is, or its offset in tag space once it is attached.
 * @param angles Its angles.
 * @returns A client-only entity.
 */
function createEntity(model: BaseModel | null, origin: number[] = [0, 0, 0], angles: number[] = [0, 0, 0]): ClientEdict {
  const entity = new ClientEdict(-1);

  entity.model = model;
  entity.origin.setTo(origin[0], origin[1], origin[2]);
  entity.angles.setTo(angles[0], angles[1], angles[2]);
  entity.updatecount = 1;

  return entity;
}

/**
 * @param parent The entity to follow.
 * @param tagName The tag, `null` for the parent's origin.
 * @param offset The child's origin in tag space.
 * @param angles The child's angles in tag space.
 * @returns A client-only entity attached to `parent`, with a tag-carrying model.
 */
function createChild(parent: ClientEdict, tagName: string | null, offset: number[] = [0, 0, 0], angles: number[] = [0, 0, 0]): ClientEdict {
  const child = createEntity(createFlashModel(), offset, angles);

  child.setAttachment(parent, tagName);

  return child;
}

/**
 * @param entity The entity.
 * @returns Where it is in the world: origin, then rotation.
 */
function worldOf(entity: ClientEdict): number[] | null {
  const out = new Float64Array(TRANSFORM_SIZE);

  return EntityAttachments.transformInto(entity, out) ? Array.from(out) : null;
}

/**
 * @param actual The numbers found.
 * @param expected The numbers wanted.
 * @param epsilon How far apart they may be.
 */
function assertAllNear(actual: ArrayLike<number>, expected: ArrayLike<number>, epsilon = 1e-4): void {
  assert.equal(actual.length, expected.length);

  for (let index = 0; index < expected.length; index++) {
    assertNear(actual[index], expected[index], epsilon);
  }
}

void describe('EntityAttachments', () => {
  const previousInterpolation = rendererCvars.interpolation;
  let restoreRenderTime: () => void = () => {};

  beforeEach(() => {
    rendererCvars.interpolation = { value: 1 } as unknown as Cvar;
    restoreRenderTime = patchMembers(clientRuntimeState.clientMessages, { renderTime: 5.05 });
  });

  afterEach(() => {
    rendererCvars.interpolation = previousInterpolation;
    restoreRenderTime();
  });

  void describe('transformInto', () => {
    void test('gives a free-standing entity its own origin and the rotation of its angles', () => {
      const entity = createEntity(createFlashModel(), [1, 2, 3], [30, 60, 15]);
      const world = worldOf(entity)!;

      assertAllNear(world.slice(0, 3), [1, 2, 3]);

      // the rotation, drawn as the renderers draw it, is the matrix of the angles
      const matrix: number[] = [];
      entity.attachmentTransform.set(world);
      entity.attachmentResolved = true;
      matrix.push(...entity.lerp.rotationMatrix);

      assertAllNear(matrix, new Vector(30, 60, 15).toRotationMatrix());
    });

    void test('puts a child on the tag of its parent, its own origin an offset in the tag\'s space', () => {
      // flash model: the tag is 10 units along X; the parent is at (100, 200, 300), unturned
      const parent = createEntity(createFlashModel(), [100, 200, 300]);
      const child = createChild(parent, 'tag_flash', [0, 5, 0]);

      assertAllNear(worldOf(child)!.slice(0, 3), [110, 205, 300]);
    });

    void test('turns the child\'s offset with the tag: frame 1 turns the tag 90 degrees, so the offset along the tag\'s X points along the world\'s Y', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300]);

      parent.frame = 1;
      parent.framePrevious = 1;

      assertAllNear(worldOf(createChild(parent, 'tag_flash', [5, 0, 0]))!.slice(0, 3), [110, 205, 300]);
    });

    void test('follows the pose the parent is drawn in, blended: halfway through a sequence the tag is 45 degrees round', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300]);

      parent.sequence = 0;
      parent.animtime = 5;

      const child = createChild(parent, 'tag_flash');

      // the same rotation, as the renderers read it
      child.attachmentTransform.set(worldOf(child)!);
      child.attachmentResolved = true;

      assertAllNear(child.lerp.rotationMatrix, new Vector(0, 45, 0).toRotationMatrix(), 1e-3);
    });

    // Pins the angle convention of the parent's renderer (a positive pitch lifts a model's nose, the opposite of the
    // view). A convention mismatch tilts every attached model the wrong way when its parent pitches.
    void test('uses the model convention for a pitched parent: the tag is ahead of the nose and the child leans with the parent', () => {
      const angles = [30, 0, 0];
      const axes = new Vector(...angles).toRotationMatrix();
      const parent = createEntity(createFlashModel(), [100, 200, 300], angles);
      const child = createChild(parent, 'tag_flash', [0, 0, 4]);
      const world = worldOf(child)!;

      // 10 along the parent's forward axis, 4 along its up axis (rows 0 and 2 of the matrix)
      assertAllNear(world.slice(0, 3), [0, 1, 2].map((axis) => [100, 200, 300][axis] + 10 * axes[axis] + 4 * axes[6 + axis]));
      assert.ok(world[2] > 304, 'a positive pitch lifts the tag above the parent');

      child.attachmentTransform.set(world);
      child.attachmentResolved = true;
      assertAllNear(child.lerp.rotationMatrix, axes);
    });

    void test('composes parent, tag and offset in that order: the child\'s own turn is the innermost', () => {
      // parent yawed 90, tag at frame 1 turned 90 more, child turned a further 90: 270 in all
      const parent = createEntity(createFlashModel(), [0, 0, 0], [0, 90, 0]);

      parent.frame = 1;
      parent.framePrevious = 1;

      const child = createChild(parent, 'tag_flash', [0, 0, 0], [0, 90, 0]);

      child.attachmentTransform.set(worldOf(child)!);
      child.attachmentResolved = true;
      assertAllNear(child.lerp.rotationMatrix, new Vector(0, 270, 0).toRotationMatrix());
    });

    void test('follows a chain of attachments: a flash on a weapon on a player', () => {
      const player = createEntity(createFlashModel(), [100, 200, 300], [0, 90, 0]);
      const weapon = createChild(player, 'tag_flash', [0, 0, 0]);
      const flash = createChild(weapon, 'tag_flash', [0, 0, 1]);

      // player faces +Y: its tag is at +10 Y; the weapon faces +Y too, so its tag is another 10 further
      assertAllNear(worldOf(flash)!.slice(0, 3), [100, 220, 301]);
    });

    void test('attaches to the parent\'s origin without a tag name, with an unknown tag, and to a parent that has no tags', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300]);

      assertAllNear(worldOf(createChild(parent, null, [1, 2, 3]))!.slice(0, 3), [101, 202, 303]);
      assertAllNear(worldOf(createChild(parent, 'tag_nowhere', [1, 2, 3]))!.slice(0, 3), [101, 202, 303]);
      assertAllNear(worldOf(createChild(createEntity(createFlashModel(), [100, 200, 300]), 'tag_flash'))!.slice(0, 3), [110, 200, 300]);
    });

    void test('uses the tag index the server sent when there is no name, and the origin for -1', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300]);
      const child = createEntity(createFlashModel(), [0, 0, 0]);

      child.attachmentParent = parent;
      child.attachmentTag = 1;
      assertAllNear(worldOf(child)!.slice(0, 3), [110, 200, 300]);

      child.attachmentTag = -1;
      assertAllNear(worldOf(child)!.slice(0, 3), [100, 200, 300]);
    });

    void test('cannot place a child whose parent is free, has no model, or is in a loop, and leaves the output alone', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300]);
      const child = createChild(parent, 'tag_flash');
      const out = new Float64Array(TRANSFORM_SIZE).fill(-7);

      parent.free = true;
      assert.equal(EntityAttachments.transformInto(child, out), false);

      parent.free = false;
      parent.model = null;
      assert.equal(EntityAttachments.transformInto(child, out), false);

      const first = createEntity(createFlashModel());
      const second = createChild(first, 'tag_flash');

      first.setAttachment(second, 'tag_flash');
      assert.equal(EntityAttachments.transformInto(first, out), false);
      assert.equal(EntityAttachments.transformInto(second, out), false);
      assert.deepEqual(Array.from(out), new Array<number>(TRANSFORM_SIZE).fill(-7));
    });

    void test('follows a chain of MAX_ATTACHMENT_DEPTH parents and gives up on one more', () => {
      let entity = createEntity(createFlashModel(), [0, 0, 0]);

      for (let depth = 0; depth < MAX_ATTACHMENT_DEPTH; depth++) {
        entity = createChild(entity, null);
      }

      assert.notEqual(worldOf(entity), null);
      assert.equal(worldOf(createChild(entity, null)), null);
    });
  });

  void describe('resolve and the lerp accessors', () => {
    void test('leaves a free-standing entity alone: lerp answers its own origin and the matrix of its angles', () => {
      const entity = createEntity(createFlashModel(), [10, 20, 30], [20, 40, 60]);

      assert.equal(EntityAttachments.resolve(entity), false);
      assert.equal(entity.attachmentResolved, false);
      assertAllNear(entity.lerp.origin, [10, 20, 30]);
      assertAllNear(entity.lerp.rotationMatrix, new Vector(20, 40, 60).toRotationMatrix(), 0);
      assert.equal(entity.worldOrigin, entity.origin);
    });

    void test('an entity whose pitch is turned into joint rotations draws upright: lerp.angles keeps the pitch, the body does not use it', () => {
      const entity = createEntity(createFlashModel(), [10, 20, 30], [20, 40, 60]);
      entity.bodyPitch = false;

      assertAllNear(entity.lerp.angles, [20, 40, 60]);
      assertAllNear(entity.lerp.bodyAngles, [0, 40, 60]);
      assertAllNear(entity.lerp.rotationMatrix, new Vector(0, 40, 60).toRotationMatrix(), 0);
    });

    void test('the pitch of an entity that has bodyPitch is what it always was, and a freed entity gets it back', () => {
      const entity = createEntity(createFlashModel(), [10, 20, 30], [20, 40, 60]);
      entity.bodyPitch = false;
      entity.jointAdjustments = new JointAdjustments(2);

      entity.freeEdict();

      assert.equal(entity.bodyPitch, true);
      assert.equal(entity.jointAdjustments, null);
    });

    void test('an entity attached to an upright body hangs on the tag of that body, not of a tilted one', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300], [30, 0, 0]);
      parent.bodyPitch = false;
      const child = createChild(parent, 'tag_flash', [0, 0, 0]);

      assert.equal(EntityAttachments.resolve(child), true);

      assertAllNear(child.lerp.origin, [110, 200, 300]);
    });

    void test('a tag follows the joint rotations of its parent, so does what is attached to it', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300]);
      const adjustments = new JointAdjustments(2);
      adjustments.setAngles(0, new Vector(30, 0, 0));
      parent.jointAdjustments = adjustments;
      const child = createChild(parent, 'tag_flash', [0, 0, 0]);

      assert.equal(EntityAttachments.resolve(child), true);

      // the tag is 10 units ahead of the root, and the root is lifted by 30 degrees
      assertAllNear(child.lerp.origin, [100 + 10 * Math.cos(Math.PI / 6), 200, 300 + 10 * Math.sin(Math.PI / 6)]);
    });

    void test('makes an attached entity draw where the attachment puts it, while its own origin stays the offset', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300], [0, 90, 0]);
      const child = createChild(parent, 'tag_flash', [0, 0, 3], [0, 0, 0]);

      assert.equal(EntityAttachments.resolve(child), true);
      assertAllNear(child.lerp.origin, [100, 210, 303]);
      assertAllNear(child.worldOrigin, [100, 210, 303]);
      assertAllNear(child.lerp.localOrigin, [0, 0, 3]);
      assertAllNear(child.origin, [0, 0, 3]);
      // it turned with its parent although its own angles are zero
      assertAllNear(child.lerp.rotationMatrix, new Vector(0, 90, 0).toRotationMatrix());
      assertAllNear(child.angles, [0, 0, 0]);
    });

    void test('is not resolved again once the entity is detached, and a freed entity forgets its parent', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300]);
      const child = createChild(parent, 'tag_flash', [1, 2, 3]);

      EntityAttachments.resolve(child);
      child.clearAttachment();
      assertAllNear(child.lerp.origin, [1, 2, 3]);

      child.setAttachment(parent, 'tag_flash');
      child.freeEdict();
      assert.equal(child.attachmentParent, null);
      assert.equal(child.attachmentResolved, false);
    });

    // The point of resolving through the parent's own pose: a flash on a barrel is where `GetEntityTag` says the
    // barrel is, with the same blend as the vertices.
    void test('puts a child where GetEntityTag finds the tag of the parent, also between two frames', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300], [10, 20, 30]);

      parent.sequence = 0;
      parent.animtime = 5;

      const child = createChild(parent, 'tag_flash');
      const tagOrigin = new Vector();
      const tagAngles = new Vector();

      assert.equal(EntityTags.resolve(parent, 'tag_flash', tagOrigin, tagAngles), true);
      EntityAttachments.resolve(child);
      assertAllNear(child.lerp.origin, tagOrigin);
      assertAllNear(child.lerp.rotationMatrix, tagAngles.toRotationMatrix(), 1e-3);
    });

    void test('lets GetEntityTag find a tag of an attached entity through its parent', () => {
      const parent = createEntity(createFlashModel(), [100, 200, 300], [0, 90, 0]);
      const weapon = createChild(parent, 'tag_flash');
      const origin = new Vector();

      // the weapon sits on the parent's tag (+10 Y) facing +Y; its own tag is another 10 along
      assert.equal(EntityTags.resolve(weapon, 'tag_flash', origin), true);
      assertAllNear(origin, [100, 220, 300]);
    });
  });
});

void describe('ClientEntities.emit with attachments', () => {
  const previousInterpolation = rendererCvars.interpolation;
  const previousChase = Chase.active;
  let restoreRenderTime: () => void = () => {};

  beforeEach(() => {
    rendererCvars.interpolation = { value: 1 } as unknown as Cvar;
    Chase.active = { value: 0 } as Cvar;
    restoreRenderTime = patchMembers(clientRuntimeState.clientMessages, { renderTime: 5.05 });
  });

  afterEach(() => {
    rendererCvars.interpolation = previousInterpolation;
    Chase.active = previousChase;
    restoreRenderTime();
  });

  /**
   * Runs the emit pass of a registry in a world that shows the leaves 1 and nothing else.
   * @param clientEntities The registry.
   * @param viewentity The entity the view is in.
   * @returns The entities that were put on screen.
   */
  function emit(clientEntities: ClientEntities, viewentity = 1): ClientEdict[] {
    let drawn: ClientEdict[] = [];

    withEngineMocks({
      CL: { nolerp: { value: 0 }, state: { worldmodel: { getPvsByPoint: () => ({ areRevealed: (leafs: number[]) => leafs.includes(1) }) }, viewentity, clientMessages: { mtime: [0.0], renderTime: 5.05 } } },
      R: { novis: { value: 0 }, refdef: { vieworg: new Vector() } },
    }, () => {
      clientEntities.emit();
      drawn = [...clientEntities.getVisibleEntities()];
    });

    return drawn;
  }

  /**
   * @param clientEntities The registry.
   * @param leafs The leaves the entity sits in.
   * @returns A client-only entity with a model, placed in `leafs`.
   */
  function allocate(clientEntities: ClientEntities, leafs: number[] = [1]): ClientEdict {
    const entity = clientEntities.allocateClientEntity();

    entity.model = createFlashModel();
    entity.origin.setTo(0, 0, 0);
    entity.angles.setTo(0, 0, 0);
    entity.leafs.push(...leafs);

    return entity;
  }

  void test('draws a child when its parent is drawn, resolved, and follows the parent\'s PVS rather than its own leaves', () => {
    const clientEntities = new ClientEntities();
    const parent = allocate(clientEntities);
    const child = allocate(clientEntities, [9]);

    parent.origin.setTo(100, 200, 300);
    child.setAttachment(parent, 'tag_flash');

    const drawn = emit(clientEntities);

    assert.deepEqual(drawn, [parent, child]);
    assertAllNear(child.lerp.origin, [110, 200, 300]);
  });

  void test('hides a child whose parent is out of the PVS, although the child\'s own leaves are in it', () => {
    const clientEntities = new ClientEntities();
    const parent = allocate(clientEntities, [9]);
    const child = allocate(clientEntities, [1]);

    child.setAttachment(parent, 'tag_flash');

    assert.deepEqual(emit(clientEntities), []);
    assert.equal(child.attachmentResolved, false);
  });

  void test('hides a child whose parent is not drawn, an invisible one or one without a model, and one whose parent is freed', () => {
    const clientEntities = new ClientEntities();
    const parent = allocate(clientEntities);
    const child = allocate(clientEntities);

    child.setAttachment(parent, 'tag_flash');

    parent.effects |= effect.EF_NODRAW;
    assert.deepEqual(emit(clientEntities), []);

    parent.effects &= ~effect.EF_NODRAW;
    parent.model = null;
    assert.deepEqual(emit(clientEntities), []);

    parent.model = createFlashModel();
    assert.deepEqual(emit(clientEntities), [parent, child]);

    parent.markFree();
    assert.deepEqual(emit(clientEntities), []);
  });

  void test('draws a chain whatever order the entities were allocated in: the grandchild comes first here', () => {
    const clientEntities = new ClientEntities();
    const flash = allocate(clientEntities);
    const weapon = allocate(clientEntities);
    const player = allocate(clientEntities);

    player.origin.setTo(100, 200, 300);
    weapon.setAttachment(player, 'tag_flash');
    flash.setAttachment(weapon, 'tag_flash');

    const drawn = emit(clientEntities);

    assert.deepEqual(new Set(drawn), new Set([player, weapon, flash]));
    // the parent is put on screen before whatever hangs on it
    assert.ok(drawn.indexOf(player) < drawn.indexOf(weapon) && drawn.indexOf(weapon) < drawn.indexOf(flash));
    assertAllNear(flash.lerp.origin, [120, 200, 300]);
  });

  void test('draws neither of two entities attached to each other, and returns', () => {
    const clientEntities = new ClientEntities();
    const first = allocate(clientEntities);
    const second = allocate(clientEntities);

    first.setAttachment(second, 'tag_flash');
    second.setAttachment(first, 'tag_flash');

    assert.deepEqual(emit(clientEntities), []);
  });

  // The handler's emit changes the entity's own angles (a pickup that spins), which for an attached entity are its turn
  // in tag space. Resolving before it ran left the spin out of what was drawn: the pickup stood still on the hand.
  void test('lets what the handler does to the entity\'s angles count: a spinning pickup on a tag spins', () => {
    const restoreTime = patchMembers(clientRuntimeState, { time: 0.5 });

    try {
      const clientEntities = new ClientEntities();
      const parent = allocate(clientEntities);
      const pickup = allocate(clientEntities);

      pickup.model!.flags = modelFlags.MF_ROTATE;
      pickup.loadHandler();
      pickup.setAttachment(parent);

      emit(clientEntities);

      // 0.5 s at 100 degrees per second
      assertAllNear(pickup.lerp.rotationMatrix, new Vector(0, 50, 0).toRotationMatrix());
    } finally {
      restoreTime();
    }
  });

  void test('hides a child of the view entity in first person and draws it with the chase camera', () => {
    const clientEntities = new ClientEntities();
    const player = clientEntities.getEntity(1);

    player.model = createFlashModel();
    player.updatecount = 1;
    player.origin.setTo(100, 200, 300);
    player.angles.setTo(0, 0, 0);
    player.msg_origins[0].set(player.origin);
    player.msg_angles[0].set(player.angles);

    const weapon = allocate(clientEntities);

    weapon.setAttachment(player, 'tag_flash');

    assert.deepEqual(emit(clientEntities, 1), []);

    Chase.active = { value: 1 } as Cvar;
    assert.deepEqual(emit(clientEntities, 1), [player, weapon]);
  });

  void test('draws a server entity attached to another by what the wire said: the parent\'s number and tag index', () => {
    const clientEntities = new ClientEntities();
    const parent = clientEntities.getEntity(5);
    const child = clientEntities.getEntity(6);

    for (const entity of [parent, child]) {
      entity.model = createFlashModel();
      entity.updatecount = 1;
      entity.origin.setTo(0, 0, 0);
      entity.angles.setTo(0, 0, 0);
      entity.msg_origins[0].set(entity.origin);
      entity.msg_angles[0].set(entity.angles);
    }

    parent.origin.setTo(100, 200, 300);
    parent.msg_origins[0].set(parent.origin);
    child.attachmentParent = parent;
    child.attachmentTag = 1;

    const drawn = emit(clientEntities, 99);

    assert.deepEqual(drawn, [parent, child]);
    assertAllNear(child.lerp.origin, [110, 200, 300]);
  });
});
