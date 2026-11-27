import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { GLTexture } from '../../source/engine/client/GL.ts';
import { IQMLoader } from '../../source/engine/common/model/loaders/IQMLoader.ts';
import type { ModelTextures } from '../../source/engine/common/model/ModelLoadContext.ts';
import { SkeletalMaterialLoader } from '../../source/engine/common/model/SkeletalMaterialLoader.ts';
import type { SkeletalMaterial } from '../../source/engine/common/model/SkeletalModel.ts';
import { buildIqm, createTwoJointSpec } from '../support/iqmBuilder.ts';
import { createModelLoadContext, createSilentConsole } from '../support/modelContext.ts';

/** A texture stand-in: the loader only stores what the source returns, it never calls into it. */
interface FakeTexture {
  readonly file: string;
}

/**
 * A texture source that has some files and records every request.
 * @param existing The files that exist.
 * @returns The source and the list of files asked for, in order.
 */
function createTextureSource(existing: string[]): { textures: ModelTextures; requested: string[] } {
  const requested: string[] = [];
  const textures: ModelTextures = {
    loadImage(filename: string): Promise<GLTexture | null> {
      requested.push(filename);
      // Only the identity of the object matters to these tests, so it is cast once, here.
      return Promise.resolve(existing.includes(filename) ? { file: filename } as FakeTexture as unknown as GLTexture : null);
    },
  };

  return { textures, requested };
}

/**
 * @param name The material name.
 * @returns A material with no textures yet.
 */
function createMaterial(name: string): SkeletalMaterial {
  return { name, diffuse: null, glow: null, shirt: null, pants: null };
}

/**
 * @param texture A texture found by the loader.
 * @returns The file it was loaded from, `null` for no texture.
 */
function fileOf(texture: GLTexture | null): string | null {
  return texture === null ? null : (texture as unknown as FakeTexture).file;
}

void describe('SkeletalMaterialLoader', () => {
  void test('finds the base image by adding an extension to a name that ends in .0, and its companions in the same format', async () => {
    // The exporter names materials like the MDL skin (`progs/player.mdl.0`): the `.0` is not an extension.
    const { textures } = createTextureSource([
      'progs/player.mdl.0.png', 'progs/player.mdl.0_glow.png', 'progs/player.mdl.0_shirt.png', 'progs/player.mdl.0_pants.png',
    ]);
    const material = createMaterial('progs/player.mdl.0');

    await SkeletalMaterialLoader.load([material], textures, createSilentConsole());

    assert.equal(fileOf(material.diffuse), 'progs/player.mdl.0.png');
    assert.equal(fileOf(material.glow), 'progs/player.mdl.0_glow.png');
    assert.equal(fileOf(material.shirt), 'progs/player.mdl.0_shirt.png');
    assert.equal(fileOf(material.pants), 'progs/player.mdl.0_pants.png');
  });

  void test('leaves out the companions a material does not have, and the base image still loads', async () => {
    const { textures } = createTextureSource(['progs/soldier.mdl.0.png', 'progs/soldier.mdl.0_glow.png']);
    const material = createMaterial('progs/soldier.mdl.0');

    await SkeletalMaterialLoader.load([material], textures, createSilentConsole());

    assert.equal(fileOf(material.diffuse), 'progs/soldier.mdl.0.png');
    assert.equal(fileOf(material.glow), 'progs/soldier.mdl.0_glow.png');
    assert.equal(material.shirt, null);
    assert.equal(material.pants, null);
  });

  void test('falls back to a JPEG, and then looks for companions in JPEG, not PNG', async () => {
    const { textures, requested } = createTextureSource(['progs/dog.0.jpg', 'progs/dog.0_pants.jpg', 'progs/dog.0_pants.png']);
    const material = createMaterial('progs/dog.0');

    await SkeletalMaterialLoader.load([material], textures, createSilentConsole());

    assert.equal(fileOf(material.diffuse), 'progs/dog.0.jpg');
    assert.equal(fileOf(material.pants), 'progs/dog.0_pants.jpg');
    assert.ok(!requested.includes('progs/dog.0_pants.png'));
  });

  void test('takes a name that already ends in an image extension as it is', async () => {
    const { textures, requested } = createTextureSource(['skins/hero.webp', 'skins/hero_shirt.webp']);
    const material = createMaterial('skins/hero.webp');

    await SkeletalMaterialLoader.load([material], textures, createSilentConsole());

    assert.equal(fileOf(material.diffuse), 'skins/hero.webp');
    assert.equal(fileOf(material.shirt), 'skins/hero_shirt.webp');
    assert.ok(!requested.includes('skins/hero.webp.png'));
  });

  void test('probes for no companions of a material whose base image is missing, and reports it once', async () => {
    // Every probe is a lookup in the game's files, so a model without any texture must not cost three more per material.
    const { textures, requested } = createTextureSource([]);
    const warnings: string[] = [];
    const material = createMaterial('progs/nothing.0');

    await SkeletalMaterialLoader.load([material], textures, createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }));

    assert.deepEqual(requested, ['progs/nothing.0.png', 'progs/nothing.0.jpg']);
    assert.equal(material.diffuse, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /progs\/nothing\.0/);
  });

  void test('gives every material its own textures', async () => {
    const { textures } = createTextureSource(['a.png', 'b.png', 'b_glow.png']);
    const first = createMaterial('a');
    const second = createMaterial('b');

    await SkeletalMaterialLoader.load([first, second], textures, createSilentConsole());

    assert.equal(fileOf(first.diffuse), 'a.png');
    assert.equal(first.glow, null);
    assert.equal(fileOf(second.diffuse), 'b.png');
    assert.equal(fileOf(second.glow), 'b_glow.png');
  });
});

void describe('IQMLoader materials', () => {
  void test('loads the textures of the file\'s materials in a realm that draws', async () => {
    const { textures } = createTextureSource(['progs/body.png', 'progs/body_shirt.png']);

    const model = await new IQMLoader(createModelLoadContext({ loadRenderData: true, textures })).load(buildIqm(createTwoJointSpec()), 'progs/two.iqm');

    assert.equal(model.materials.length, 1);
    assert.equal(fileOf(model.materials[0].diffuse), 'progs/body.png');
    assert.equal(fileOf(model.materials[0].shirt), 'progs/body_shirt.png');
  });

  void test('asks for no image in a realm that does not draw', async () => {
    // The server realm has no materials at all, and must not touch the file system for textures it cannot use.
    const { textures, requested } = createTextureSource(['progs/body.png']);

    const model = await new IQMLoader(createModelLoadContext({ loadRenderData: false, textures })).load(buildIqm(createTwoJointSpec()), 'progs/two.iqm');

    assert.equal(model.materials.length, 0);
    assert.deepEqual(requested, []);
  });
});
