// The first import of this file is `SkeletalModel` on purpose, which is the order that used to fail: `SkeletalModel`
// imported `Mod` (for the `ModelType` enum), `Mod` imports the loaders, and the loader's `IQMModel extends SkeletalModel`
// was evaluated while `SkeletalModel` had not finished. It only worked when something else loaded `Mod` first, so a new
// importer (`EntityTags`, through `ClientEngineAPI`) broke five unrelated test files with "Cannot access 'SkeletalModel'
// before initialization". Every test file is a process of its own, so this file pins the order.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SkeletalModel } from '../../source/engine/common/model/SkeletalModel.ts';
import { IQMModel } from '../../source/engine/common/model/IQMModel.ts';
import { ModelType } from '../../source/engine/common/Mod.ts';

void describe('loading SkeletalModel before everything else', () => {
  void test('does not trip over the loaders that extend it', () => {
    const model = new IQMModel('progs/x.iqm');

    assert.ok(model instanceof SkeletalModel);
    assert.equal(model.type, ModelType.skeletal);
  });
});
