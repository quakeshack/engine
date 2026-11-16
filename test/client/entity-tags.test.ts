import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { EntityTagCommand } from '../../source/engine/client/EntityTagCommand.ts';
import { EntityTags } from '../../source/engine/client/EntityTags.ts';
import Con from '../../source/engine/common/Console.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import Vector from '../../source/shared/Vector.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';
import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { runConsoleCommand } from '../support/consoleCommands.ts';
import { createFlashModel } from '../support/skeletalModels.ts';

/**
 * @param model The model the entity shows.
 * @param members What else the entity has.
 * @param num The entity's number, -1 for a client-only entity.
 * @returns An entity at (100, 200, 300).
 */
function createEntity(model: BaseModel | null, members: Partial<Pick<ClientEdict, 'frame' | 'sequence' | 'animtime' | 'framerate'>> & { angles?: number[] } = {}, num = -1): ClientEdict {
  const entity = new ClientEdict(num);

  entity.model = model;
  entity.origin.setTo(100, 200, 300);
  entity.angles.setTo(...((members.angles ?? [0, 0, 0]) as [number, number, number]));
  Object.assign(entity, { ...members, angles: entity.angles });
  entity.animtime = members.animtime ?? 0;

  return entity;
}

/**
 * @param entity The entity.
 * @param tag The tag's name.
 * @returns Where the tag is, `null` when it is not there.
 */
function resolve(entity: ClientEdict, tag = 'tag_flash'): { origin: number[]; angles: number[] } | null {
  const origin = new Vector(-1, -1, -1);
  const angles = new Vector(-1, -1, -1);

  return EntityTags.resolve(entity, tag, origin, angles) ? { origin: Array.from(origin), angles: Array.from(angles) } : null;
}

void describe('EntityTags.resolve', () => {
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

  void test('puts the tag at the entity\'s origin plus the tag\'s place in the model', () => {
    const tag = resolve(createEntity(createFlashModel()))!;

    tag.origin.forEach((value, axis) => { assertNear(value, [110, 200, 300][axis], 1e-5); });
    tag.angles.forEach((value) => { assertNear(value, 0, 1e-5); });
  });

  void test('turns the tag with the entity: an entity facing +Y has its tag 10 units to +Y', () => {
    const tag = resolve(createEntity(createFlashModel(), { angles: [0, 90, 0] }))!;

    tag.origin.forEach((value, axis) => { assertNear(value, [100, 210, 300][axis], 1e-4); });
    assertNear(tag.angles[1], 90, 1e-4);
  });

  void test('turns the tag the way the model\'s pitch does, which is the opposite of the view\'s: a positive pitch lifts the nose', () => {
    // Model renderers negate the pitch (Quake's convention for models), `Vector.toRotationMatrix()` is the reference:
    // its first row is the entity's forward axis. A tag 10 units ahead of an entity pitched 30 is up there, not down.
    const angles = [30, 0, 0];
    const rows = new Vector(...angles).toRotationMatrix();
    const tag = resolve(createEntity(createFlashModel(), { angles }))!;

    tag.origin.forEach((value, axis) => { assertNear(value, [100, 200, 300][axis] + 10 * rows[axis], 1e-4); });
    assert.ok(tag.origin[2] > 300, 'the tag is above the entity');
    assertNear(tag.angles[0], 30, 1e-4);
  });

  void test('gives the entity\'s own angles for a tag that does not turn against its model, whatever they are', () => {
    for (const angles of [[30, 60, 15], [-20, 200, -50], [0, 0, 70]]) {
      const tag = resolve(createEntity(createFlashModel(), { angles }))!;
      const wanted = new Vector(...angles).toRotationMatrix();
      const got = new Vector(...tag.angles).toRotationMatrix();

      // the same turn, compared as matrices because 200 degrees of yaw and -160 are the same angles
      got.forEach((value, index) => { assertNear(value, wanted[index], 1e-4); });
    }
  });

  void test('composes the entity\'s turn with the tag\'s turn in that order: the tag turns inside the entity', () => {
    // Pitching the entity and turning the tag 90 degrees about Z do not commute. `toRotationMatrix()` holds the axes of
    // a turn as rows, so the rows of the result are (Rz90 transposed) times the rows of the entity.
    const entityAngles = [30, 0, 0];
    const rows = new Vector(...entityAngles).toRotationMatrix();
    const rz90Transposed = [0, 1, 0, -1, 0, 0, 0, 0, 1];
    const expected = [0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => [0, 1, 2].reduce((sum, k) => sum + rz90Transposed[row * 3 + k] * rows[k * 3 + column], 0)));

    const tag = resolve(createEntity(createFlashModel(), { frame: 1, angles: entityAngles }))!;
    const got = new Vector(...tag.angles).toRotationMatrix();

    expected.forEach((value, index) => { assertNear(got[index], value, 1e-4); });
  });

  void test('follows the pose the entity is drawn in: frame 1 turns the tag 90 degrees', () => {
    const tag = resolve(createEntity(createFlashModel(), { frame: 1 }))!;

    assertNear(tag.angles[1], 90, 1e-4);
  });

  void test('follows a sequence from its animtime, blended like the vertices: halfway through `turn` the tag is 45 degrees round', () => {
    const entity = createEntity(createFlashModel(), { sequence: 0, animtime: 5 });

    assertNear(resolve(entity)!.angles[1], 45, 1e-3);
  });

  void test('does not blend frames while interpolation is off, a sequence included', () => {
    rendererCvars.interpolation = { value: 0 } as unknown as Cvar;

    assertNear(resolve(createEntity(createFlashModel(), { sequence: 0, animtime: 5 }))!.angles[1], 0, 1e-4);
  });

  void test('answers without angles when only the position is wanted', () => {
    const origin = new Vector();

    assert.equal(EntityTags.resolve(createEntity(createFlashModel()), 'tag_flash', origin), true);
    assertNear(origin[0], 110, 1e-5);
  });

  void test('says no for a model without that tag, a model without tags, and an entity without a model, and touches nothing', () => {
    const origin = new Vector(7, 7, 7);
    const angles = new Vector(8, 8, 8);

    assert.equal(EntityTags.resolve(createEntity(createFlashModel()), 'tag_weapon', origin, angles), false);
    assert.equal(EntityTags.resolve(createEntity(new BaseModel('progs/soldier.mdl')), 'tag_flash', origin, angles), false);
    assert.equal(EntityTags.resolve(createEntity(null), 'tag_flash', origin, angles), false);
    assert.deepEqual([...Array.from(origin), ...Array.from(angles)], [7, 7, 7, 8, 8, 8]);
  });

  void test('a joint of the rig is a tag too, whatever it is called', () => {
    assert.ok(resolve(createEntity(createFlashModel()), 'root'));
  });
});

void describe('ClientEngineAPI tags', () => {
  const previousInterpolation = rendererCvars.interpolation;
  const previousModels = clientRuntimeState.model_precache;

  beforeEach(() => {
    rendererCvars.interpolation = { value: 1 } as unknown as Cvar;
    clientRuntimeState.model_precache = [undefined as unknown as BaseModel, createFlashModel(), new BaseModel('progs/soldier.mdl')];
  });

  afterEach(() => {
    rendererCvars.interpolation = previousInterpolation;
    clientRuntimeState.model_precache = previousModels;
  });

  void test('GetTagIndex finds a tag of a precached model, -1 for a missing one and for a model that has none', () => {
    const api = createClientEngineApi();
    const [, flash] = clientRuntimeState.model_precache;

    assert.equal(api.GetTagIndex(flash.name, 'tag_flash'), 1);
    assert.equal(api.GetTagIndex(flash.name, 'tag_weapon'), -1);
    assert.equal(api.GetTagIndex('progs/soldier.mdl', 'tag_flash'), -1);
  });

  void test('GetTagIndex fails for a model that was not precached', () => {
    assert.throws(() => createClientEngineApi().GetTagIndex('progs/missing.iqm', 'tag_flash'), /not precached/);
  });

  void test('GetEntityTag fills the vectors it is given and says whether it found the tag', () => {
    const api = createClientEngineApi();
    const entity = createEntity(clientRuntimeState.model_precache[1], { angles: [0, 90, 0] });
    const origin = new Vector();
    const angles = new Vector();

    assert.equal(api.GetEntityTag(entity, 'tag_flash', origin, angles), true);
    assertNear(origin[1], 210, 1e-4);
    assertNear(angles[1], 90, 1e-4);
    assert.equal(api.GetEntityTag(entity, 'nowhere', origin, angles), false);
  });
});

void describe('joint angles of an entity', () => {
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

  void test('SetEntityJointAngles turns the joint, and the tag of the entity is where the turned model has it', () => {
    const api = createClientEngineApi();
    const entity = createEntity(createFlashModel());

    assert.equal(api.SetEntityJointAngles(entity, 'root', new Vector(30, 0, 0)), true);

    const tag = resolve(entity)!;
    tag.origin.forEach((value, axis) => { assertNear(value, [100 + 10 * Math.cos(Math.PI / 6), 200, 300 + 10 * Math.sin(Math.PI / 6)][axis], 1e-4); });
  });

  void test('says no, and changes nothing, for a joint the model does not have, a model that is not skeletal and an entity without one', () => {
    const api = createClientEngineApi();
    const entity = createEntity(createFlashModel());

    assert.equal(api.SetEntityJointAngles(entity, 'nowhere', new Vector(30, 0, 0)), false);
    assert.equal(entity.jointAdjustments, null);
    assert.equal(api.SetEntityJointAngles(createEntity(null), 'root', new Vector(30, 0, 0)), false);
    assert.equal(api.SetEntityJointAngles(createEntity(new BaseModel('progs/alias.mdl')), 'root', new Vector(30, 0, 0)), false);
  });

  void test('ClearEntityJointAngles puts the animation back', () => {
    const api = createClientEngineApi();
    const entity = createEntity(createFlashModel());
    api.SetEntityJointAngles(entity, 'root', new Vector(30, 0, 0));

    api.ClearEntityJointAngles(entity);

    const tag = resolve(entity)!;
    tag.origin.forEach((value, axis) => { assertNear(value, [110, 200, 300][axis], 1e-5); });
  });

  void test('an entity that gets another model gets rotations that fit it', () => {
    const api = createClientEngineApi();
    const entity = createEntity(createFlashModel());
    api.SetEntityJointAngles(entity, 'root', new Vector(30, 0, 0));
    const first = entity.jointAdjustments;

    const bigger = createFlashModel();
    bigger.jointNames = ['root', 'tag_flash', 'extra'];
    bigger.jointParents = Int32Array.from([-1, 0, 0]);
    entity.model = bigger;
    api.SetEntityJointAngles(entity, 'extra', new Vector(10, 0, 0));

    assert.notEqual(entity.jointAdjustments, first);
    assert.equal(entity.jointAdjustments?.jointCount, 3);
  });

  void test('SetEntityPitchesBody switches the tilt of the body', () => {
    const api = createClientEngineApi();
    const entity = createEntity(createFlashModel(), { angles: [20, 90, 0] });

    api.SetEntityPitchesBody(entity, false);
    assert.equal(entity.lerp.bodyAngles[0], 0);

    api.SetEntityPitchesBody(entity, true);
    assert.equal(entity.lerp.bodyAngles[0], 20);
  });
});

void describe('entitytag command', () => {
  const previousInterpolation = rendererCvars.interpolation;
  const previousClientEntities = clientRuntimeState.clientEntities;

  beforeEach(() => {
    rendererCvars.interpolation = { value: 1 } as unknown as Cvar;
  });

  afterEach(() => {
    rendererCvars.interpolation = previousInterpolation;
    clientRuntimeState.clientEntities = previousClientEntities;
  });

  /**
   * Runs the command with one entity, number 5, as the only one the client knows.
   * @param entity The entity.
   * @param args The command's arguments.
   * @returns What it printed.
   */
  function runWith(entity: ClientEdict, ...args: string[]): string {
    clientRuntimeState.clientEntities = { getEntities: function* () { yield entity; } } as unknown as typeof clientRuntimeState.clientEntities;

    Con.StartCapturing();
    void runConsoleCommand(EntityTagCommand, { command: 'entitytag' }, ...args);

    return Con.StopCapturing();
  }

  void test('prints where the tag is, so that running it again as the entity moves shows the tag move', () => {
    const entity = createEntity(createFlashModel(), {}, 5);

    const first = runWith(entity, '5', 'tag_flash');
    entity.origin.setTo(100, 250, 300);
    const second = runWith(entity, '5', 'tag_flash');

    assert.match(first, /tag_flash \(1\) of entity 5: origin 110 200 300/);
    assert.match(second, /origin 110 250 300/);
  });

  void test('lists the tags of the model when no tag is named', () => {
    assert.match(runWith(createEntity(createFlashModel(), {}, 5), '5'), /root, tag_flash/);
  });

  void test('explains itself for a missing tag, a model without tags and a bad number, and shows its usage without arguments', () => {
    assert.match(runWith(createEntity(createFlashModel(), {}, 5), '5', 'tag_weapon'), /has no tag tag_weapon/);
    assert.match(runWith(createEntity(new BaseModel('progs/soldier.mdl'), {}, 5), '5', 'tag_flash'), /has no tags/);
    assert.match(runWith(createEntity(createFlashModel(), {}, 5), '9', 'tag_flash'), /no entity 9/);
    assert.match(runWith(createEntity(createFlashModel(), {}, 5), 'x', 'tag_flash'), /no entity x/);
    assert.match(runWith(createEntity(createFlashModel(), {}, 5)), /Usage: entitytag/);
  });
});
