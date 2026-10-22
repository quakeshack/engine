import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Mod, ModelScope } from '../../source/engine/common/Mod.ts';
import type { AliasModel } from '../../source/engine/common/model/AliasModel.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { AliasMDLLoader } from '../../source/engine/common/model/loaders/AliasMDLLoader.ts';
import type { ModelFiles } from '../../source/engine/common/model/ModelLoadContext.ts';
import { ServerEngineAPI } from '../../source/engine/server/ServerEngineAPI.ts';
import type Server from '../../source/engine/server/Server.ts';
import { createModelLoadContext } from '../support/modelContext.ts';

const MODEL_NAME = 'progs/test-collision.mdl';
const VERTEX_COUNT = 4;
const TRIANGLE_COUNT = 2;
const SKIN_SIZE = 2;

/** One pose: the four vertices as stored in the file (x, y, z, lightnormalindex). */
type Pose = readonly [number, number, number, number][];

/**
 * Builds the pose of the test model, shifted along x so every frame is distinguishable.
 * @param shiftX Offset added to x of every vertex.
 * @returns The pose.
 */
function createPose(shiftX: number): Pose {
  return [
    [shiftX, 0, 0, 0],
    [shiftX + 10, 0, 0, 0],
    [shiftX, 20, 0, 0],
    [shiftX, 0, 30, 0],
  ];
}

/**
 * Writes one frame body (bounding box, name, vertices) like the MDL format stores it.
 * @param bytes Bytes to append to.
 * @param name Frame name.
 * @param pose Vertices of the frame.
 */
function writeFrameBody(bytes: number[], name: string, pose: Pose): void {
  const xs = pose.map((vertex) => vertex[0]);

  bytes.push(Math.min(...xs), 0, 0, 0, Math.max(...xs), 20, 30, 0);

  for (let index = 0; index < 16; index++) {
    bytes.push(index < name.length ? name.charCodeAt(index) : 0);
  }

  for (const vertex of pose) {
    bytes.push(...vertex);
  }
}

/**
 * Builds a small `.mdl` file: one skin, 4 vertices, 2 triangles and 2 frames, the second of which is a group of two.
 * The group is there because skipping the poses of a frame group is the easiest place to lose the file offset.
 * @returns The file.
 */
function createAliasModelFile(): ArrayBuffer {
  const header = new DataView(new ArrayBuffer(84));

  header.setUint32(0, 0x4f504449, true); // IDPO
  header.setUint32(4, 6, true);
  header.setFloat32(8, 1, true);
  header.setFloat32(12, 1, true);
  header.setFloat32(16, 1, true);
  header.setUint32(48, 1, true); // skins
  header.setUint32(52, SKIN_SIZE, true);
  header.setUint32(56, SKIN_SIZE, true);
  header.setUint32(60, VERTEX_COUNT, true);
  header.setUint32(64, TRIANGLE_COUNT, true);
  header.setUint32(68, 2, true); // frames

  const body: number[] = [];
  const u32 = (value: number): void => {
    body.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  };

  // single skin
  u32(0);
  body.push(...new Array<number>(SKIN_SIZE * SKIN_SIZE).fill(1));

  // texture coordinates
  for (let vertex = 0; vertex < VERTEX_COUNT; vertex++) {
    u32(0);
    u32(vertex);
    u32(vertex);
  }

  // triangles
  for (const indices of [[0, 1, 2], [0, 3, 1]]) {
    u32(1);
    indices.forEach(u32);
  }

  // frame 0: single
  u32(0);
  writeFrameBody(body, 'idle', createPose(0));

  // frame 1: a group of two frames
  u32(1);
  u32(2);
  body.push(0, 0, 0, 0, 40, 20, 30, 0); // group bounding box
  const interval = new DataView(new ArrayBuffer(4));
  interval.setFloat32(0, 0.5, true);
  body.push(...new Uint8Array(interval.buffer));
  interval.setFloat32(0, 1.0, true);
  body.push(...new Uint8Array(interval.buffer));
  writeFrameBody(body, 'walk0', createPose(8));
  writeFrameBody(body, 'walk1', createPose(16));

  const file = new Uint8Array(header.byteLength + body.length);

  file.set(new Uint8Array(header.buffer), 0);
  file.set(body, header.byteLength);

  return file.buffer;
}

/**
 * Builds file access that serves the test model and counts reads.
 * @param gate Optional promise every read waits for, to control the order loads finish in.
 * @returns The file access and its read counter.
 */
function createCountingFiles(gate: (() => Promise<void>) | null = null): { files: ModelFiles, reads: () => number } {
  let reads = 0;

  return {
    files: {
      async LoadFile(name: string): Promise<ArrayBuffer | null> {
        if (name !== MODEL_NAME) {
          return null;
        }

        reads++;

        if (gate !== null) {
          await gate();
        }

        return createAliasModelFile();
      },
      LoadTextFile: () => Promise.resolve(null),
    },
    reads: () => reads,
  };
}

/**
 * Creates a model cache set up like a server's (no render data) that reads the test model.
 * @param gate Optional gate for reads.
 * @returns The cache and its read counter.
 */
function createServerMod(gate: (() => Promise<void>) | null = null): { mod: Mod, reads: () => number } {
  const mod = new Mod();
  const { files, reads } = createCountingFiles(gate);
  const { con } = createModelLoadContext();

  mod.Init({ files, con, loadRenderData: false });

  return { mod, reads };
}

/**
 * Narrows a model the cache returned.
 * @param model The model.
 * @returns The model as an alias model.
 */
function asAliasModel(model: BaseModel | null): AliasModel {
  assert.notEqual(model, null);
  return model as AliasModel;
}

void describe('AliasMDLLoader collision geometry', () => {
  /**
   * Loads the test model through the loader the way a server realm does.
   * @param collisionGeometry Whether the load asks for collision geometry.
   * @returns The loaded model.
   */
  async function load(collisionGeometry: boolean): Promise<AliasModel> {
    const loader = new AliasMDLLoader(createModelLoadContext());

    return await loader.load(createAliasModelFile(), MODEL_NAME, { collisionGeometry });
  }

  void test('keeps bounds, frame names and counts without geometry by default', async () => {
    const model = await load(false);

    assert.equal(model.hasCollisionGeometry, false);
    assert.deepEqual([...model.mins], [0, 0, 0]);
    assert.deepEqual([...model.maxs], [26, 20, 30]); // widest frame: walk1 is shifted by 16 and 10 wide
    assert.equal(model._num_verts, VERTEX_COUNT);
    assert.equal(model._num_tris, TRIANGLE_COUNT);
    assert.equal(model.frames.length, 2);
    assert.equal(model.getCollisionTriangleCount(), 0);

    const [single, group] = model.frames;

    assert.equal(single.group, false);
    assert.equal(single.group ? '' : single.name, 'idle');
    assert.equal(single.group ? -1 : single.v.length, 0);
    assert.equal(group.group, true);
    assert.deepEqual(group.group ? group.frames.map((frame) => frame.name) : [], ['walk0', 'walk1']);
    assert.deepEqual(group.group ? group.frames.map((frame) => frame.v.length) : [], [0, 0]);
  });

  void test('keeps triangles and poses when asked for collision geometry', async () => {
    const model = await load(true);

    assert.equal(model.hasCollisionGeometry, true);
    assert.equal(model.getCollisionTriangleCount(), TRIANGLE_COUNT);
    assert.deepEqual(model.getCollisionTriangleVertexIndices(0), [0, 1, 2]);
    assert.deepEqual(model.getCollisionTriangleVertexIndices(1), [0, 3, 1]);

    const walk1 = model.resolveCollisionFrame(1, 0.75);

    assert.notEqual(walk1, null);
    assert.deepEqual([...model.getCollisionVertex(walk1!, 1)!], [26, 0, 0]);
    assert.deepEqual([...model.getCollisionVertex(model.resolveCollisionFrame(0, 0)!, 3)!], [0, 0, 30]);
  });

  void test('has the same bounds and frame metadata with and without geometry', async () => {
    const light = await load(false);
    const full = await load(true);

    assert.deepEqual([...light.mins], [...full.mins]);
    assert.deepEqual([...light.maxs], [...full.maxs]);
    assert.equal(light.checksum, full.checksum);
    assert.equal(light.frames.length, full.frames.length);
  });
});

void describe('Mod collision geometry cache', () => {
  void test('a plain load has no geometry and an asking load replaces it in every cache', async () => {
    const { mod, reads } = createServerMod();

    const light = asAliasModel(await mod.ForNameAsync(MODEL_NAME, true, ModelScope.server));

    assert.equal(light.hasCollisionGeometry, false);

    const full = asAliasModel(await mod.ForNameAsync(MODEL_NAME, true, ModelScope.server, { collisionGeometry: true }));

    assert.equal(full.hasCollisionGeometry, true);
    assert.equal(reads(), 2);
    assert.equal(mod.known[MODEL_NAME].hasCollisionGeometry, true);
    assert.equal(mod.serverKnown[MODEL_NAME], full);
  });

  void test('a model that has its geometry answers a plain load without reading the file again', async () => {
    const { mod, reads } = createServerMod();

    await mod.ForNameAsync(MODEL_NAME, true, ModelScope.server, { collisionGeometry: true });
    const again = asAliasModel(await mod.ForNameAsync(MODEL_NAME, true, ModelScope.server));

    assert.equal(again.hasCollisionGeometry, true);
    assert.equal(reads(), 1);
  });

  void test('an asking load answers a repeated asking load without reading the file again', async () => {
    const { mod, reads } = createServerMod();

    await mod.ForNameAsync(MODEL_NAME, true, ModelScope.server);
    await mod.ForNameAsync(MODEL_NAME, true, ModelScope.server, { collisionGeometry: true });
    await mod.ForNameAsync(MODEL_NAME, true, ModelScope.server, { collisionGeometry: true });

    assert.equal(reads(), 2);
  });

  for (const finishFirst of ['plain', 'collision'] as const) {
    void test(`the model keeps its geometry when the plain load finishes ${finishFirst === 'plain' ? 'first' : 'last'}`, async () => {
      const releases: Array<() => void> = [];
      const { mod } = createServerMod(() => new Promise<void>((resolve) => {
        releases.push(resolve);
      }));

      const plain = mod.ForNameAsync(MODEL_NAME, true, ModelScope.server);
      const asking = mod.ForNameAsync(MODEL_NAME, true, ModelScope.server, { collisionGeometry: true });

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(releases.length, 2, 'both loads are waiting for the file');

      // The reads were issued in the order plain, collision.
      const order = finishFirst === 'plain' ? [0, 1] : [1, 0];

      for (const index of order) {
        releases[index]();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      await Promise.all([plain, asking]);

      assert.equal(asAliasModel(await asking).hasCollisionGeometry, true);
      assert.equal(mod.known[MODEL_NAME].hasCollisionGeometry, true);
      assert.equal(mod.serverKnown[MODEL_NAME].hasCollisionGeometry, true);
    });
  }
});

/** The part of the server state `PrecacheModel` works on. */
interface PrecacheServer {
  modelPrecache: string[];
  models: Array<BaseModel | Promise<BaseModel | null> | null>;
}

void describe('ServerEngineAPI.PrecacheModel', () => {
  /**
   * Builds the engine API on top of a minimal server: just the precache lists and a model cache.
   * @returns The API, the server state it works on and the read counter of its model cache.
   */
  function createApi(): { api: ServerEngineAPI, server: PrecacheServer, reads: () => number } {
    const { mod, reads } = createServerMod();
    const server: PrecacheServer = { modelPrecache: [''], models: [null] };
    const sv = { server, mod } as unknown as Server;

    return { api: new ServerEngineAPI(sv, () => ({ registered: true, hipnotic: false, rogue: false })), server, reads };
  }

  /**
   * Waits for the precache entry of a model.
   * @param server The server state.
   * @param index Index in the precache lists.
   * @returns The model the entry resolves to.
   */
  async function resolved(server: PrecacheServer, index: number): Promise<AliasModel> {
    return asAliasModel(await server.models[index] as BaseModel | null);
  }

  void test('precaches without geometry unless the game asks for mesh collision', async () => {
    const { api, server } = createApi();

    api.PrecacheModel(MODEL_NAME);

    assert.deepEqual(server.modelPrecache, ['', MODEL_NAME]);
    assert.equal((await resolved(server, 1)).hasCollisionGeometry, false);
  });

  void test('precaches with geometry when the game asks for mesh collision', async () => {
    const { api, server } = createApi();

    api.PrecacheModel(MODEL_NAME, { meshCollision: true });

    assert.equal((await resolved(server, 1)).hasCollisionGeometry, true);
  });

  void test('precaching again with mesh collision upgrades the entry without a second index', async () => {
    const { api, server, reads } = createApi();

    api.PrecacheModel(MODEL_NAME);
    await resolved(server, 1);
    api.PrecacheModel(MODEL_NAME, { meshCollision: true });

    assert.deepEqual(server.modelPrecache, ['', MODEL_NAME]);
    assert.equal((await resolved(server, 1)).hasCollisionGeometry, true);
    assert.equal(reads(), 2);
  });

  void test('precaching again without mesh collision leaves the entry alone', async () => {
    const { api, server, reads } = createApi();

    api.PrecacheModel(MODEL_NAME, { meshCollision: true });
    const entry = server.models[1];

    api.PrecacheModel(MODEL_NAME);

    assert.equal(server.models[1], entry);
    assert.equal((await resolved(server, 1)).hasCollisionGeometry, true);
    assert.equal(reads(), 1);
  });
});
