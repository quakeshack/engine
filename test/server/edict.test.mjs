import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { eventBus } from '../../source/engine/registry.ts';
import { ED, ServerEdict } from '../../source/engine/server/Edict.ts';
import { defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

void describe('ED.Print', () => {
  void test('prints serializable and public entity fields without Progs fielddefs', () => {
    const prints = [];
    const entity = {
      classname: 'monster_ogre',
      edictId: 7,
      origin: new Vector(1, 2, 3),
      health: 80,
      solid: 0,
      owner: { num: 2 },
      _aiState: 'idle',
      _internal: 'ignore me',
      engine: { shouldNotPrint1: true },
      game: { shouldNotPrint2: true },
      serialize() {
        return {
          _aiState: ['P', this._aiState],
          health: ['P', this.health],
          origin: ['V', this.origin[0], this.origin[1], this.origin[2]],
          owner: ['E', 2],
          solid: ['P', this.solid],
        };
      },
      deserialize() {},
    };
    const edict = {
      entity,
      num: 7,
      isFree() {
        return false;
      },
    };

    void withMockRegistry({
      ...defaultMockRegistry({ server: { active: true } }),
      Con: {
        Print(message) {
          prints.push(message);
        },
        DPrint() {},
      },
    }, () => {
      ED.Print(edict);
    });

    const output = prints.join('');

    assert.match(output, /EDICT 7:/);
    assert.match(output, /health/);
    assert.match(output, /origin/);
    assert.match(output, /owner/);
    assert.match(output, /solid/);
    assert.match(output, /edict #2/);
    assert.doesNotMatch(output, /_aiState/);
    assert.doesNotMatch(output, /_internal/);
    assert.doesNotMatch(output, /shouldNotPrint1/);
    assert.doesNotMatch(output, /shouldNotPrint2/);
  });
});

void describe('ED lifecycle events', () => {
  void test('emits server.edict.assigned when reusing a freed slot', () => {
    const worldEdict = new ServerEdict(0);
    const clientEdict = new ServerEdict(1);
    const reusableEdict = new ServerEdict(2);
    reusableEdict.free = true;
    reusableEdict.freetime = 0;

    const assignedEdictIds = [];
    const unsubscribe = eventBus.subscribe('server.edict.assigned', (edictId) => {
      assignedEdictIds.push(edictId);
    });

    try {
      void withMockRegistry(defaultMockRegistry({
        svs: {
          maxclients: 1,
        },
        server: {
          time: 1,
          num_edicts: 3,
          edicts: [worldEdict, clientEdict, reusableEdict],
        },
      }), () => {
        const assigned = ED.Alloc();
        assert.equal(assigned.num, 2);
      });
    } finally {
      unsubscribe();
    }

    assert.deepEqual(assignedEdictIds, [2]);
  });

  void test('emits server.edict.assigned when allocating a fresh slot', () => {
    const worldEdict = new ServerEdict(0);
    const clientEdict = new ServerEdict(1);
    const activeEdict = new ServerEdict(2);
    activeEdict.free = false;
    const freshEdict = new ServerEdict(3);

    const assignedEdictIds = [];
    const unsubscribe = eventBus.subscribe('server.edict.assigned', (edictId) => {
      assignedEdictIds.push(edictId);
    });

    try {
      void withMockRegistry(defaultMockRegistry({
        svs: {
          maxclients: 1,
        },
        server: {
          time: 1,
          num_edicts: 3,
          edicts: [worldEdict, clientEdict, activeEdict, freshEdict],
        },
      }), () => {
        const assigned = ED.Alloc();
        assert.equal(assigned.num, 3);
      });
    } finally {
      unsubscribe();
    }

    assert.deepEqual(assignedEdictIds, [3]);
  });
});
