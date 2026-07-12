import fs from 'node:fs/promises';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { BrushModel, Node } from '../../source/engine/common/model/BSP.ts';
import { BrushTrace } from '../../source/engine/common/Pmove.ts';
import { BSP38Loader } from '../../source/engine/common/model/loaders/BSP38Loader.ts';
import { QSMatLoader } from '../../source/engine/common/model/QSMatLoader.ts';
import { GLTexture } from '../../source/engine/client/GL.ts';
import { MaterialFlags, PBRMaterial, QuakeMaterial } from '../../source/engine/client/renderer/Materials.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import COMClass from '../../source/engine/common/Com.ts';
import Mod from '../../source/engine/common/Mod.ts';

const silentCon = /** @type {typeof import('../../source/engine/common/Console.ts').default} */ ({
  Print() {},
  DPrint() {},
  PrintWarning() {},
  PrintError(...args) { console.error(...args); },
  PrintSuccess() {},
});

/**
 * Temporarily install a mocked registry (COM/Con/isDedicatedServer) and
 * publish `registry.frozen` so module-level bindings (Mod, QSMatLoader, etc.)
 * pick up the mock, then restore the previous registry afterward.
 * @param {{isDedicatedServer?: boolean, COM?: object, Con?: object}} overrides registry overrides
 * @param {() => Promise<void>} callback test body to run under the mock
 */
async function withMockedRegistry(overrides, callback) {
  const previousRegistry = {
    COM: registry.COM,
    Con: registry.Con,
    Mod: registry.Mod,
    isDedicatedServer: registry.isDedicatedServer,
  };

  Object.assign(registry, { Mod, ...overrides });
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    Object.assign(registry, previousRegistry);
    eventBus.publish('registry.frozen');
  }
}

/**
 * Load the shared BSP38 test fixture (data/bsp38-tests/maps/bsp38_areaportal.bsp)
 * through Com and Mod, mirroring the BSP29 loadBSPMap helper used by the
 * physics collision-regressions tests.
 * @param {boolean} [isDedicatedServer] whether to load as a dedicated server (skips texture decoding)
 * @returns {Promise<import('../../source/engine/common/model/BSP.ts').BrushModel>} loaded model
 */
async function loadBSP38Map(isDedicatedServer = true) {
  const baseUrl = new URL('../../data/bsp38-tests/', import.meta.url);
  const knownKeysBefore = new Set(Object.keys(Mod.known));

  let model;

  await withMockedRegistry({
    isDedicatedServer,
    Con: silentCon,
    COM: /** @type {typeof import('../../source/engine/common/Com.ts').default} */ ({
      Parse: COMClass.Parse,
      ParseEntityLump: COMClass.ParseEntityLump,
      async LoadFile(name) {
        try {
          const data = await fs.readFile(new URL(name, baseUrl));
          return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } catch {
          return null;
        }
      },
      async LoadTextFile(name) {
        try {
          return await fs.readFile(new URL(name, baseUrl), 'utf8');
        } catch {
          return null;
        }
      },
    }),
  }, async () => {
    Mod.Init();
    model = /** @type {BrushModel} */ (await Mod.ForNameAsync('maps/bsp38_areaportal.bsp', true));
  });

  for (const name of Object.keys(Mod.known)) {
    if (!knownKeysBefore.has(name)) {
      delete Mod.known[name];
    }
  }

  return model;
}

void describe('BSP38Loader', () => {
  void describe('format detection', () => {
    void test('reports the Quake 2 BSP38 magic number, extension and name', () => {
      const loader = new BSP38Loader();

      assert.deepEqual(loader.getMagicNumbers(), [1347633737]);
      assert.deepEqual(loader.getExtensions(), ['.bsp']);
      assert.equal(loader.getName(), 'Quake 2 BSP38');
    });
  });

  void describe('core tree loading', () => {
    void test('loads vertexes, edges, surfedges and faces', async () => {
      const model = await loadBSP38Map();

      assert.equal(model.vertexes.length, 36);
      assert.equal(model.edges.length, 83);
      assert.equal(model.surfedges.length, 148);
      assert.equal(model.faces.length, 36);
    });

    void test('loads and links BSP tree nodes to real Node instances', async () => {
      const model = await loadBSP38Map();

      assert.ok(model.nodes.length > 0);
      assert.ok(model.leafs.length > 1);

      const root = model.nodes[0];
      assert.ok(root.plane !== null);
      assert.ok(root.children[0] instanceof Node);
      assert.ok(root.children[1] instanceof Node);
      assert.equal(root.parent, null);
    });

    void test('assigns leaf contents from the leafs lump, including the sentinel outside leaf', async () => {
      const model = await loadBSP38Map();

      assert.equal(model.leafs[0].contents, content.CONTENT_SOLID);
      assert.ok(model.leafs.some((leaf) => leaf.contents === content.CONTENT_SOLID));
      assert.ok(model.leafs.some((leaf) => leaf.contents === content.CONTENT_EMPTY));
    });
  });

  void describe('textures and materials', () => {
    void test('registers one placeholder material per distinct texinfo texture name', async () => {
      const model = await loadBSP38Map();

      // the fixture uses a single texture name across every brush face
      assert.equal(model.textures.length, 1);
      assert.equal(model.textures[0].name, 'e1u1/box1_5');

      for (const texinfo of model.texinfo) {
        assert.equal(typeof texinfo.texture, 'number');
        assert.equal(texinfo.texture, 0);
      }
    });

    void test('loads native RGB lighting data', async () => {
      const model = await loadBSP38Map();

      assert.ok(model.coloredlights);
      assert.ok(model.lightdata_rgb !== null);
      assert.ok(model.lightdata_rgb.length > 0);
    });

    void test('normalizes lightofs from a Q2 RGB byte offset to a sample count, matching BuildLightMapEx/RecursiveLightPoint', async () => {
      // Q2's dface_t.lightofs is a byte offset directly into the LIGHTING lump
      // (confirmed against ericw-tools' own light/write.cc and bsputils.cc),
      // unlike BSP29/BSP2 where lightofs is a sample count and the renderer
      // derives the RGB byte offset itself via `* 3` / `* channels`. If the
      // loader didn't divide the raw value by 3, every face's derived byte
      // range would run 3x too far into lightdata_rgb.
      const model = await loadBSP38Map();

      let maxEndByte = 0;

      for (const face of model.faces) {
        const smax = (face.extents[0] >> face.lmshift) + 1;
        const tmax = (face.extents[1] >> face.lmshift) + 1;
        const startByte = face.lightofs * 3;
        const endByte = startByte + (smax * tmax * face.styles.length * 3);

        assert.ok(endByte <= model.lightdata_rgb.length, `face texinfo=${face.texinfo} lightmap range exceeds lightdata_rgb bounds`);
        maxEndByte = Math.max(maxEndByte, endByte);
      }

      // A correctly-normalized set of faces packs the lump almost exactly full
      // (light's own allocator leaves a few bytes of slack) — this is what
      // actually distinguishes "happens to fit" from "decoded correctly."
      // Without the /3 normalization, every face's byte range would run 3x
      // too far and blow past the buffer entirely, failing the bounds check above.
      assert.ok(maxEndByte > model.lightdata_rgb.length * 0.99);
    });

    void test('loads real .wal pixel data when opted in via worldspawn _qs_wal, replacing the 1x1 placeholder', async () => {
      // data/bsp38-tests/textures/e1u1/box1_5.wal is a synthetic 8x8 test
      // texture (not real game content) matching the fixture's only texture
      // name, so this exercises the full textures/<name>.wal lookup path.
      // The fixture's worldspawn sets "_qs_wal" "1" to opt in.
      const fakeTexture = /** @type {GLTexture} */ ({ width: 8, height: 8 });
      const originalAllocate = GLTexture.Allocate;

      try {
        GLTexture.Allocate = () => fakeTexture;

        const model = await loadBSP38Map(false);

        assert.equal(model.worldspawnInfo._qs_wal, '1');
        assert.equal(model.textures.length, 1);
        assert.equal(model.textures[0].width, 8);
        assert.equal(model.textures[0].height, 8);
        assert.equal(model.textures[0].texture, fakeTexture);
      } finally {
        // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
        GLTexture.Allocate = originalAllocate;
      }
    });

    void test('.wal loading is opt-in: skipped by default even when not on a dedicated server', async () => {
      const originalAllocate = GLTexture.Allocate;

      try {
        GLTexture.Allocate = () => {
          throw new Error('GLTexture.Allocate must not be called when _qs_wal is not opted in');
        };

        const bspPath = new URL('../../data/bsp38-tests/maps/bsp38_areaportal.bsp', import.meta.url);
        const raw = await fs.readFile(bspPath);
        const patched = new Uint8Array(raw);
        // ASCII text, so a latin1 decode keeps a 1:1 byte<->char index mapping
        const text = new TextDecoder('latin1').decode(patched);
        const needle = '_qs_wal" "1';
        const needleIndex = text.indexOf(needle);
        assert.ok(needleIndex >= 0, 'fixture must contain _qs_wal for this test to be meaningful');
        patched[needleIndex + needle.length - 1] = '0'.charCodeAt(0); // flip opted-in "1" to "0", same byte length

        let model;

        await withMockedRegistry({
          isDedicatedServer: false,
          Con: silentCon,
          COM: /** @type {typeof import('../../source/engine/common/Com.ts').default} */ ({
            Parse: COMClass.Parse,
            ParseEntityLump: COMClass.ParseEntityLump,
            LoadFile(name) {
              throw new Error(`unexpected LoadFile(${name}) — .wal loading must not run when _qs_wal is off`);
            },
            LoadTextFile() {
              return Promise.resolve(null);
            },
          }),
        }, async () => {
          const buffer = patched.buffer.slice(patched.byteOffset, patched.byteOffset + patched.byteLength);
          model = await new BSP38Loader().load(buffer, 'maps/bsp38_areaportal.bsp');
        });

        assert.equal(model.worldspawnInfo._qs_wal, '0');
        assert.equal(model.textures[0].width, 1);
        assert.equal(model.textures[0].height, 1);
      } finally {
        // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
        GLTexture.Allocate = originalAllocate;
      }
    });

    void test('does not touch GLTexture.Allocate on a dedicated server (no .wal decoding at all)', async () => {
      const originalAllocate = GLTexture.Allocate;

      try {
        GLTexture.Allocate = () => {
          throw new Error('GLTexture.Allocate must not be called on a dedicated server');
        };

        const model = await loadBSP38Map(true);

        assert.equal(model.textures[0].width, 1);
        assert.equal(model.textures[0].height, 1);
      } finally {
        // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
        GLTexture.Allocate = originalAllocate;
      }
    });
  });

  void describe('visibility (PVS/PHS)', () => {
    void test('loads native cluster-indexed PVS and PHS offset tables', async () => {
      const model = await loadBSP38Map();

      assert.equal(model.numclusters, 9);
      assert.ok(model.visdata !== null);
      assert.ok(model.phsdata !== null);
      assert.equal(model.clusterPvsOffsets.length, model.numclusters);
      assert.equal(model.clusterPhsOffsets.length, model.numclusters);
    });

    void test('reveals a leaf to itself via PVS', async () => {
      const model = await loadBSP38Map();

      const leaf = model.getLeafForPoint(new Vector(-160, 0, 24));
      assert.notEqual(leaf.cluster, -1);

      const pvs = model.getPvsByPoint(new Vector(-160, 0, 24));
      assert.ok(pvs.isRevealed(model.leafs.indexOf(leaf)));
    });
  });

  void describe('brush collision', () => {
    void test('exposes brush-based collision data with valid AABBs (no clipnodes/hulls needed)', async () => {
      const model = await loadBSP38Map();

      assert.ok(model.hasBrushData);
      assert.equal(model.brushes.length, 12);

      for (const brush of model.brushes) {
        assert.ok(brush.mins !== null && brush.maxs !== null);

        for (let axis = 0; axis < 3; axis++) {
          assert.ok(brush.maxs[axis] > brush.mins[axis]);
        }
      }
    });

    void test('BrushTrace.testPosition blocks inside a wall and clears open space', async () => {
      const model = await loadBSP38Map();
      const zero = new Vector();

      assert.equal(BrushTrace.testPosition(model, 0, new Vector(-200, 0, 24), zero, zero), false);
      assert.equal(BrushTrace.testPosition(model, 0, new Vector(-160, 0, 24), zero, zero), true);
    });

    void test('BrushTrace.boxTrace stops at the dividing wall away from the doorway', async () => {
      const model = await loadBSP38Map();
      const zero = new Vector();

      const trace = BrushTrace.boxTrace(model, 0, new Vector(-20, 48, 24), new Vector(20, 48, 24), zero, zero);
      assert.ok(trace.fraction < 1.0);
    });

    void test('BrushTrace.boxTrace passes cleanly through the open doorway', async () => {
      const model = await loadBSP38Map();
      const zero = new Vector();

      const trace = BrushTrace.boxTrace(model, 0, new Vector(-20, 0, 24), new Vector(20, 0, 24), zero, zero);
      assert.equal(trace.fraction, 1.0);
    });
  });

  void describe('submodels', () => {
    void test('loads one submodel each for the trigger_multiple and func_door brush entities (func_areaportal has none)', async () => {
      const model = await loadBSP38Map();

      // *1 = trigger_multiple, *2 = func_door — func_areaportal's brush is
      // discarded by qbsp into the AREAPORTALS lump and gets no dmodel_t.
      assert.equal(model.submodels.length, 2);

      for (const submodel of model.submodels) {
        assert.equal(submodel.submodel, true);
        assert.equal(submodel.numBrushes, 1);
        assert.ok(submodel.hasBrushData);
      }
    });
  });

  void describe('door-to-portal mapping (modelPortalMap)', () => {
    void test('auto-derives modelPortalMap for the door sharing the areaportal doorway, matching the compiled portal group', async () => {
      const model = await loadBSP38Map();

      // *2 (func_door) fills the same doorway gap as the func_areaportal
      // brush, so BSP38Loader#computeModelPortalMap should resolve it to the
      // same portal group portalDefs independently reports for that doorway.
      assert.equal(model.portalDefs.length, 1);
      assert.equal(model.modelPortalMap['*2'], model.portalDefs[0].group);
    });

    void test('an explicit "portal" key on an unrelated brush entity overrides automatic derivation', async () => {
      const model = await loadBSP38Map();

      // *1 (trigger_multiple) sits entirely on the west side, nowhere near
      // the doorway — the geometric heuristic alone would never assign it a
      // portal (it only touches one area). Its explicit "portal" "1" map key
      // must still win via #parseExplicitPortalKeys.
      assert.equal(model.modelPortalMap['*1'], 1);
    });
  });

  void describe('areas and area portals', () => {
    void test('loads native area/areaportal connectivity from the AREAS/AREAPORTALS lumps', async () => {
      const model = await loadBSP38Map();

      assert.equal(model.numAreas, 3);
      assert.equal(model.portalDefs.length, 1);
      assert.equal(model.areaPortals.numAreas, model.numAreas);
    });

    void test('opening and closing the areaportal changes connectivity between the two sides', async () => {
      const model = await loadBSP38Map();

      const leafA = model.getLeafForPoint(new Vector(-160, 0, 24));
      const leafB = model.getLeafForPoint(new Vector(160, 0, 24));

      assert.notEqual(leafA.area, leafB.area);

      model.areaPortals.closeAll();
      assert.equal(model.areaPortals.leafsConnected(leafA, leafB), false);

      model.areaPortals.openAll();
      assert.equal(model.areaPortals.leafsConnected(leafA, leafB), true);
    });
  });

  void describe('BSPX extension lumps', () => {
    void test('loads the BSPX trailer and the LIGHTGRID_OCTREE lump', async () => {
      const model = await loadBSP38Map();

      assert.ok(model.bspxlumps !== null);
      assert.ok('LIGHTGRID_OCTREE' in model.bspxlumps);

      assert.ok(model.lightgrid !== null);
      assert.ok(model.lightgrid.nodes.length > 0);
      assert.ok(model.lightgrid.leafs.length > 0);
    });

    void test('loads the LIGHTINGDIR (deluxemap) lump with one sample per lightdata_rgb texel', async () => {
      const model = await loadBSP38Map();

      assert.ok(model.deluxemap !== null);
      // deluxemap and lightdata_rgb are both 3 bytes/sample over the same face layout
      assert.equal(model.deluxemap.length, model.lightdata_rgb.length);

      let nonZeroBytes = 0;
      for (const byte of model.deluxemap) {
        if (byte !== 0) {
          nonZeroBytes++;
        }
      }
      // a real direction map should carry actual data, not just an empty/degenerate buffer
      assert.ok(nonZeroBytes > 0);
    });

    void test('propagates the deluxemap to submodels', async () => {
      const model = await loadBSP38Map();

      assert.equal(model.submodels.length, 2);

      for (const submodel of model.submodels) {
        assert.equal(submodel.deluxemap, model.deluxemap);
      }
    });

    void test('loads the FACENORMALS lump with unit-length per-vertex normals for every face', async () => {
      const model = await loadBSP38Map();

      assert.ok('FACENORMALS' in model.bspxlumps);
      assert.ok(model.faces.length > 0);

      for (const face of model.faces) {
        assert.ok(face.vertexNormals !== null, 'expected FACENORMALS coverage for every face');
        assert.ok(face.vertexTangents !== null);
        assert.ok(face.vertexBitangents !== null);
        assert.equal(face.vertexNormals.length, face.numedges);
        assert.equal(face.vertexTangents.length, face.numedges);
        assert.equal(face.vertexBitangents.length, face.numedges);

        for (const normal of face.vertexNormals) {
          const length = Math.hypot(normal[0], normal[1], normal[2]);
          assert.ok(Math.abs(length - 1.0) < 1e-3);
        }
      }
    });
  });
});

void describe('QSMatLoader (used by BSP38Loader, BSP29Loader and BSP2Loader alike)', () => {
  void test('replaces a placeholder texture with a PBRMaterial using explicit width/height from qsmat', async () => {
    const fakeTexture = /** @type {GLTexture} */ ({ width: 256, height: 256 });
    const originalFromImageFile = GLTexture.FromImageFile;

    try {
      GLTexture.FromImageFile = () => Promise.resolve(fakeTexture);

      await withMockedRegistry({
        isDedicatedServer: false,
        Con: silentCon,
        COM: /** @type {typeof import('../../source/engine/common/Com.ts').default} */ ({
          LoadTextFile(name) {
            if (name !== 'textures/test.qsmat.json') {
              return Promise.resolve(null);
            }

            return Promise.resolve(JSON.stringify({
              version: 1,
              materials: {
                'e1u1/box1_5': {
                  diffuse: 'textures/test_diffuse.png',
                  width: 64,
                  height: 64,
                  flags: ['MF_FULLBRIGHT'],
                },
              },
            }));
          },
        }),
      }, async () => {
        const model = new BrushModel('qsmat-test');
        model.worldspawnInfo = { _qs_mat: 'textures/test.qsmat.json' };
        model.textures = [new QuakeMaterial('e1u1/box1_5', 1, 1)];

        await QSMatLoader.load(model);

        assert.ok(model.textures[0] instanceof PBRMaterial);
        assert.equal(model.textures[0].width, 64);
        assert.equal(model.textures[0].height, 64);
        assert.equal(model.textures[0].diffuse, fakeTexture);
        assert.ok(model.textures[0].flags & MaterialFlags.MF_FULLBRIGHT);
      });
    } finally {
      // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
      GLTexture.FromImageFile = originalFromImageFile;
    }
  });

  void test('falls back to the loaded diffuse image size when no width/height or base texture is available', async () => {
    // This is the BSP38-relevant case: before native .wal loading exists, the
    // placeholder texture has no real base size, so QSMatLoader must fall
    // back to the diffuse image's own dimensions as an approximation.
    const fakeTexture = /** @type {GLTexture} */ ({ width: 128, height: 32 });
    const originalFromImageFile = GLTexture.FromImageFile;

    try {
      GLTexture.FromImageFile = () => Promise.resolve(fakeTexture);

      await withMockedRegistry({
        isDedicatedServer: false,
        Con: silentCon,
        COM: /** @type {typeof import('../../source/engine/common/Com.ts').default} */ ({
          LoadTextFile() {
            return Promise.resolve(JSON.stringify({
              version: 1,
              materials: {
                'e1u1/box1_5': { diffuse: 'textures/test_diffuse.png' },
              },
            }));
          },
        }),
      }, async () => {
        const model = new BrushModel('qsmat-test-fallback');
        model.worldspawnInfo = { _qs_mat: 'textures/test.qsmat.json' };
        model.textures = [new QuakeMaterial('e1u1/box1_5', 1, 1)]; // placeholder has no real base texture

        await QSMatLoader.load(model);

        assert.equal(model.textures[0].width, 128);
        assert.equal(model.textures[0].height, 32);
      });
    } finally {
      // eslint-disable-next-line require-atomic-updates -- sequential test cleanup, not a real race
      GLTexture.FromImageFile = originalFromImageFile;
    }
  });
});
