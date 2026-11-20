import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import ClientEntities, { ClientBeam } from '../../source/engine/client/ClientEntities.ts';
import Chase from '../../source/engine/client/Chase.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import Vector from '../../source/shared/Vector.ts';
import { patchMembers } from '../support/clientState.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';
import { createFlashModel } from '../support/skeletalModels.ts';

const SERVER_START = [100, 200, 316];
const BEAM_END = [100, 500, 316];

/**
 * Puts a server entity somewhere the way the network does: `emit()` takes the position from the last message.
 * @param entity The entity.
 * @param origin Where it is.
 * @param angles Which way it faces.
 */
function place(entity: ReturnType<ClientEntities['getEntity']>, origin: number[], angles: number[]): void {
  entity.msg_origins[0].setTo(origin[0]!, origin[1]!, origin[2]!);
  entity.msg_angles[0].setTo(angles[0]!, angles[1]!, angles[2]!);
  entity.updatecount = 1;
}

/**
 * Lets a beam of a shooter think for one frame and finds where it starts: the first light it makes.
 * @param prepare Sets up the shooter (edict 1, at (100, 200, 300) facing +Y) and its surroundings.
 * @param viewentity The entity the local player is, 1 is the shooter.
 * @param chase Whether the view is a chase view.
 * @returns Where the beam starts.
 */
function beamStart(prepare: (clientEntities: ClientEntities, shooter: ReturnType<ClientEntities['getEntity']>) => void, viewentity = 2, chase = false): number[] {
  const clientEntities = new ClientEntities();
  const shooter = clientEntities.getEntity(1);

  place(shooter, [100, 200, 300], [0, 90, 0]);
  prepare(clientEntities, shooter);

  const beam = new ClientBeam();

  beam.entity = 1;
  beam.model = new BaseModel('progs/bolt2.mdl');
  beam.endtime = 10;
  beam.start = new Vector(...SERVER_START);
  beam.end = new Vector(...BEAM_END);
  clientEntities.beams[0] = beam;

  const restore = patchMembers(clientRuntimeState, { time: 5, viewentity, clientEntities, worldmodel: {} as never });
  const restoreChase = patchMembers(Chase, { active: { value: chase ? 1 : 0 } as Cvar });

  try {
    withEngineMocks({ Host: { frametime: 1 / 60 } }, () => { clientEntities.emit(); });
  } finally {
    restoreChase();
    restore();
  }

  const light = clientEntities.dlights.find((candidate) => !candidate.isFree() && candidate.radius === 50);

  assert.ok(light, 'a beam makes lights along itself');

  return Array.from(light.origin).map((value) => Math.round(value));
}

void describe('where a beam starts', () => {
  const previousInterpolation = rendererCvars.interpolation;
  const previousNovis = rendererCvars.novis;
  let restoreRenderTime: () => void = () => {};

  beforeEach(() => {
    rendererCvars.interpolation = { value: 1 } as unknown as Cvar;
    // novis reveals everything, so emit() needs no world model to look up a PVS
    rendererCvars.novis = { value: 1 } as unknown as Cvar;
    restoreRenderTime = patchMembers(clientRuntimeState.clientMessages, { renderTime: 5.05 });
  });

  afterEach(() => {
    rendererCvars.interpolation = previousInterpolation;
    rendererCvars.novis = previousNovis;
    restoreRenderTime();
  });

  void test('starts where the server said for a shooter whose model has no muzzle', () => {
    assert.deepEqual(beamStart((_entities, shooter) => { shooter.model = new BaseModel('progs/shambler.mdl'); }), SERVER_START);
  });

  void test('starts on the tag_flash of the weapon the shooter holds, 10 units along the weapon\'s X, turned with the shooter', () => {
    const start = beamStart((entities, shooter) => {
      shooter.model = new BaseModel('progs/player.iqm');

      const weapon = entities.allocateClientEntity();

      weapon.model = createFlashModel();
      weapon.origin.setTo(0, 0, 0);
      weapon.angles.setTo(0, 0, 0);
      weapon.setAttachment(shooter);
    });

    assert.deepEqual(start, [100, 210, 300]);
  });

  void test('starts on the shooter\'s own tag_flash', () => {
    assert.deepEqual(beamStart((_entities, shooter) => { shooter.model = createFlashModel(); }), [100, 210, 300]);
  });

  void test('ignores the weapon of another shooter', () => {
    const start = beamStart((entities, shooter) => {
      shooter.model = new BaseModel('progs/player.iqm');

      const weapon = entities.allocateClientEntity();

      weapon.model = createFlashModel();
      weapon.origin.setTo(0, 0, 0);
      weapon.angles.setTo(0, 0, 0);
      weapon.setAttachment(entities.getEntity(2));
    });

    assert.deepEqual(start, SERVER_START);
  });

  void test('the local player\'s beam starts at the player\'s origin in first person, even when the model has a muzzle', () => {
    assert.deepEqual(beamStart((_entities, shooter) => { shooter.model = new BaseModel('progs/player.mdl'); }, 1), [100, 200, 300]);
    assert.deepEqual(beamStart((_entities, shooter) => { shooter.model = createFlashModel(); }, 1), [100, 200, 300]);
  });

  void test('the local player\'s beam starts at the muzzle in a chase view, and at the player\'s origin there without one', () => {
    assert.deepEqual(beamStart((_entities, shooter) => { shooter.model = createFlashModel(); }, 1, true), [100, 210, 300]);
    assert.deepEqual(beamStart((_entities, shooter) => { shooter.model = new BaseModel('progs/player.mdl'); }, 1, true), [100, 200, 300]);
  });

  void test('follows the weapon from frame to frame while the beam lasts', () => {
    const clientEntities = new ClientEntities();
    const shooter = clientEntities.getEntity(1);
    const weapon = clientEntities.allocateClientEntity();

    shooter.model = new BaseModel('progs/player.iqm');
    place(shooter, [100, 200, 300], [0, 0, 0]);
    weapon.model = createFlashModel();
    weapon.origin.setTo(0, 0, 0);
    weapon.angles.setTo(0, 0, 0);
    weapon.setAttachment(shooter);

    const beam = new ClientBeam();

    beam.entity = 1;
    beam.model = new BaseModel('progs/bolt2.mdl');
    beam.endtime = 10;
    beam.start = new Vector(...SERVER_START);
    beam.end = new Vector(...BEAM_END);
    clientEntities.beams[0] = beam;

    const restore = patchMembers(clientRuntimeState, { time: 5, viewentity: 2, clientEntities, worldmodel: {} as never });
    const starts: number[][] = [];

    try {
      withEngineMocks({ Host: { frametime: 1 / 60 } }, () => {
        for (const yaw of [0, 90]) {
          place(shooter, [100, 200, 300], [0, yaw, 0]);
          clientEntities.emit();
          starts.push(Array.from(clientEntities.dlights.filter((light) => !light.isFree() && light.radius === 50)[0]!.origin).map((value) => Math.round(value)));
          clientEntities.dlights.forEach((light) => { light.die = 0; });
        }
      });
    } finally {
      restore();
    }

    assert.deepEqual(starts, [[110, 200, 300], [100, 210, 300]]);
  });

  void test('starts at the muzzle of the frame it is drawn in when the shooter moves (it trailed by a frame when built before emit)', () => {
    const clientEntities = new ClientEntities();
    const shooter = clientEntities.getEntity(1);

    shooter.model = createFlashModel();

    const beam = new ClientBeam();

    beam.entity = 1;
    beam.model = new BaseModel('progs/bolt2.mdl');
    beam.endtime = 10;
    beam.start = new Vector(...SERVER_START);
    beam.end = new Vector(...BEAM_END);
    clientEntities.beams[0] = beam;

    const restore = patchMembers(clientRuntimeState, { time: 5, viewentity: 2, clientEntities, worldmodel: {} as never });
    const frames: { light: number[]; segment: number[] }[] = [];

    try {
      withEngineMocks({ Host: { frametime: 1 / 60 } }, () => {
        for (const origin of [[100, 200, 300], [160, 200, 300]]) {
          place(shooter, origin, [0, 90, 0]);
          clientEntities.think();
          clientEntities.emit();

          const light = clientEntities.dlights.filter((candidate) => !candidate.isFree() && candidate.radius === 50)[0]!;
          const segment = Array.from(clientEntities.getVisibleEntities()).find((entity) => entity.model === beam.model)!;

          frames.push({ light: Array.from(light.origin), segment: Array.from(segment.lerp.origin) });
          clientEntities.dlights.forEach((candidate) => { candidate.die = 0; });
        }
      });
    } finally {
      restore();
    }

    // the muzzle is 10 units ahead along the shooter's own X, which a yaw of 90 turns onto +Y
    assert.deepEqual(frames[1]!.light, [160, 210, 300]);
    assert.deepEqual(frames[1]!.segment, [160, 210, 300]);
  });
});
