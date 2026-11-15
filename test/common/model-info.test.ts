import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Con from '../../source/engine/common/Console.ts';
import Mod from '../../source/engine/common/Mod.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { IQMLoader } from '../../source/engine/common/model/loaders/IQMLoader.ts';
import { ModelInfo, ModelInfoCommand } from '../../source/engine/common/model/ModelInfoCommand.ts';
import { buildIqm, createTwoJointSpec } from '../support/iqmBuilder.ts';
import { runConsoleCommand } from '../support/consoleCommands.ts';
import { createDirectoryFiles, createModelLoadContext } from '../support/modelContext.ts';

/**
 * Loads the two joint test model.
 * @param loadRenderData Whether the realm draws.
 * @returns The model.
 */
async function loadTestModel(loadRenderData: boolean) {
  return await new IQMLoader(createModelLoadContext({ loadRenderData })).load(buildIqm(createTwoJointSpec()), 'progs/test.iqm');
}

/**
 * Runs `modelinfo` and collects what it prints.
 * @param args The arguments of the command.
 * @returns The printed text.
 */
async function runModelInfo(...args: string[]): Promise<string> {
  Con.StartCapturing();
  await runConsoleCommand(ModelInfoCommand, { command: 'modelinfo' }, ...args);

  return Con.StopCapturing();
}

void describe('ModelInfo', () => {
  void describe('describe', () => {
    void test('lists joints as a tree, sequences with their range and loop, and the materials', async () => {
      const lines = ModelInfo.describe(await loadTestModel(true));

      assert.equal(lines[0], 'progs/test.iqm: skeletal model');
      assert.ok(lines.includes('  2 joints (each one is a tag):'));
      assert.ok(lines.some((line) => /^\s+0 root$/.test(line)), 'root is not indented');
      assert.ok(lines.some((line) => /^\s+1 {3}child$/.test(line)), 'child is indented below root');
      assert.ok(lines.some((line) => /^\s+0 turn: frames 0-1, 10 fps, loops$/.test(line)));
      assert.ok(lines.some((line) => /^\s+0 progs\/body$/.test(line)));
      assert.ok(lines.some((line) => /body: material 0, 3 vertices, 1 triangles$/.test(line)));
    });

    void test('says that a realm that does not draw has no mesh data, and still lists joints and sequences', async () => {
      const lines = ModelInfo.describe(await loadTestModel(false));

      assert.ok(lines.includes('  no mesh data in this realm'));
      assert.ok(lines.some((line) => /^\s+1 {3}child$/.test(line)));
      assert.ok(lines.some((line) => /turn: frames 0-1/.test(line)));
    });

    void test('describes a model of any other type by its bounds and counts', () => {
      const model = new BaseModel('progs/plain.mdl');
      model._num_frames = 3;

      assert.deepEqual(ModelInfo.describe(model), [
        'progs/plain.mdl: unknown type model',
        '  bounds (0.00 0.00 0.00) to (0.00 0.00 0.00)',
        '  3 frames, 0 skins, 0 vertices, 0 triangles',
      ]);
    });
  });

  void describe('modelinfo command', () => {
    void test('prints the usage without a model name', async () => {
      assert.match(await runModelInfo(), /Usage: modelinfo <model>/);
    });

    void test('loads a model that is not loaded yet and describes it', async () => {
      Mod.Init(createModelLoadContext({ files: createDirectoryFiles(new URL('../fixtures/skeletal/', import.meta.url)) }));

      const output = await runModelInfo('player.iqm');

      assert.match(output, /player\.iqm: skeletal model/);
      assert.match(output, /25 joints/);
      assert.match(output, /axrun: frames 0-5, 10 fps, loops/);
    });
  });
});
