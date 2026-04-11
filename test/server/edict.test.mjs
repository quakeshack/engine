import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { ED } from '../../source/engine/server/Edict.ts';
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
