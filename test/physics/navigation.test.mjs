import assert from 'node:assert/strict';
import { describe, test, before } from 'node:test';
import { readFileSync } from 'node:fs';

import Vector from '../../source/shared/Vector.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import { Navigation } from '../../source/engine/server/Navigation.ts';

const NAV_MONSTER_MINS = new Vector(-16.0, -16.0, -24.0);
const NAV_MONSTER_MAXS = new Vector(16.0, 16.0, 40.0);

/**
 * @returns {{faces: object[], surfedges: number[], edges: number[][], vertexes: Vector[], checksum: number}} minimal worldmodel
 */
function createNavigationWorldModel() {
  return {
    checksum: 1337,
    planes: [{ normal: new Vector(0, 0, 1) }],
    faces: [{
      numedges: 3,
      normal: new Vector(0, 0, 1),
      plane: { normal: new Vector(0, 0, 1) },
      planeBack: false,
      turbulent: false,
      sky: false,
      submodel: false,
      firstedge: 0,
    }],
    surfedges: [1, 2, 3],
    edges: [
      [0, 0],
      [0, 1],
      [1, 2],
      [2, 0],
    ],
    vertexes: [
      new Vector(0, 0, 0),
      new Vector(512, 0, 0),
      new Vector(0, 512, 0),
    ],
  };
}

/**
 * @param {Vector} position stand origin to validate
 * @returns {boolean} true when the stand origin fits on the test floor
 */
function isSupportedStandOrigin(position) {
  return position[2] >= 24
    && position[2] <= 128;
}

/**
 * @param {Vector} point world point to validate
 * @returns {boolean} true when the point sits over the default supporting floor
 */
function isSupportedFloorPoint(point) {
  return point[2] <= 24.0;
}

/**
 * @param {Vector} mins trace mins
 * @param {Vector} maxs trace maxs
 */
function assertExpectedTraceShape(mins, maxs) {
  const isPointTrace = mins.isOrigin() && maxs.isOrigin();

  if (isPointTrace) {
    return;
  }

  assert.deepEqual([...mins], [...NAV_MONSTER_MINS]);
  assert.deepEqual([...maxs], [...NAV_MONSTER_MAXS]);
}

/**
 * @param {Vector} start trace start
 * @param {Vector} mins trace mins
 * @param {Vector} maxs trace maxs
 * @param {Vector} end trace end
 * @param {(point: Vector) => boolean} hasFloorAt test floor predicate
 * @returns {{endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null}} trace stub
 */
function traceAgainstFlatFloor(start, mins, maxs, end, hasFloorAt) {
  const isPointTrace = mins.isOrigin() && maxs.isOrigin();

  if (!isPointTrace && !isSupportedStandOrigin(start)) {
    return createTrace(end, start, 0.0, true, true);
  }

  if (end[2] < start[2]) {
    const landed = start.copy();
    landed[2] = isPointTrace ? 0.0 : 24.0;

    if (!hasFloorAt(landed)) {
      return createTrace(end, end, 1.0);
    }

    const totalDrop = start[2] - end[2];
    const travelled = start[2] - landed[2];
    const fraction = totalDrop > 0 ? travelled / totalDrop : 1.0;

    return createTrace(end, landed, fraction);
  }

  if (!isPointTrace && !isSupportedStandOrigin(end)) {
    return createTrace(end, start, 0.0, true, true);
  }

  return createTrace(end, end, 1.0);
}

/**
 * @param {Vector} point world point to test
 * @param {(point: Vector) => boolean} hasFloorAt test floor predicate
 * @returns {number} point contents result
 */
function contentsAgainstFlatFloor(point, hasFloorAt) {
  return hasFloorAt(point) ? -2 : 0;
}

/**
 * @param {Vector} end end position
 * @param {Vector} endpos resolved trace end position
 * @param {number} fraction travelled fraction
 * @param {boolean} [startsolid] whether the trace started in solid
 * @param {boolean} [allsolid] whether the trace stayed in solid
 * @returns {{endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null}} trace stub
 */
function createTrace(end, endpos, fraction, startsolid = false, allsolid = false) {
  return {
    endpos: endpos.copy(),
    fraction,
    startsolid,
    allsolid,
    ent: null,
  };
}

/**
 * Run a callback with the registry state needed by Navigation tests.
 * @param {{ Con: object, COM: object, SV: object }} mockRegistry registry overrides
 * @param {() => Promise<void>|void} callback test body
 * @returns {Promise<void>} callback result after registry restoration
 */
function withNavigationRegistry(mockRegistry, callback) {
  const previousCL = registry.CL;
  const previousCOM = registry.COM;
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousR = registry.R;
  const previousSV = registry.SV;

  const restore = () => {
    registry.CL = previousCL;
    registry.COM = previousCOM;
    registry.Con = previousCon;
    registry.Host = previousHost;
    registry.R = previousR;
    registry.SV = previousSV;
    eventBus.publish('registry.frozen');
  };

  registry.CL = null;
  registry.COM = mockRegistry.COM;
  registry.Con = mockRegistry.Con;
  registry.Host = { frametime: 0.1 };
  registry.R = null;
  registry.SV = mockRegistry.SV;
  eventBus.publish('registry.frozen');

  let result;

  try {
    result = callback();
  } catch (error) {
    restore();
    throw error;
  }

  return Promise.resolve(result)
    .then(() => Promise.resolve())
    .finally(() => {
      restore();
    });
}

/**
 * @param {Uint8Array} data nav file data
 * @returns {{nodeCount: number, surfaceCounts: number[]}} parsed node and surface metadata
 */
function readNavSurfaceCounts(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const readBytes = (count) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset + offset, count);
    offset += count;
    return bytes;
  };
  const readUint8 = () => dv.getUint8(offset++);
  const readUint16 = () => {
    const value = dv.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const readUint32 = () => {
    const value = dv.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const readInt32 = () => {
    const value = dv.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const readFloat32 = () => {
    const value = dv.getFloat32(offset, true);
    offset += 4;
    return value;
  };

  assert.equal(String.fromCharCode(...readBytes(4)), 'QSNM');
  readUint32();

  const nameLength = readUint16();
  readBytes(nameLength);
  readUint32();
  readFloat32();
  readFloat32();

  const relinkCount = readUint32();
  for (let i = 0; i < relinkCount; i++) {
    readUint32();
  }

  const nodeCount = readUint32();
  const surfaceCounts = [];

  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
    readInt32();
    readFloat32();
    readFloat32();
    readFloat32();
    readFloat32();
    readUint8();
    readUint8();
    readUint8();

    const surfaceCount = readUint32();
    surfaceCounts.push(surfaceCount);

    for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
      readFloat32();
      readFloat32();
      readFloat32();
      readFloat32();
      readUint32();
      const waypointCount = readUint32();
      for (let waypointIndex = 0; waypointIndex < waypointCount; waypointIndex++) {
        readFloat32();
        readFloat32();
        readFloat32();
        readFloat32();
        readUint8();
        readUint8();
        readUint8();
      }
    }

    const neighborCount = readUint32();
    for (let neighborIndex = 0; neighborIndex < neighborCount; neighborIndex++) {
      readInt32();
      readFloat32();
      readFloat32();
    }
  }

  return { nodeCount, surfaceCounts };
}

void describe('Navigation.build', () => {
  void test('uses monster-sized static-world traces and stores stand origins', async () => {
    const worldmodel = createNavigationWorldModel();
    let boxTraceCount = 0;
    let lineTraceCount = 0;

    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        boxTraceCount++;

        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        lineTraceCount++;
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: {
        DPrint() {},
        PrintWarning() {},
        PrintSuccess() {},
        PrintError() {},
      },
      SV: {
        collision,
        server: {
          mapname: 'nav-test',
          worldmodel,
          num_edicts: 0,
          edicts: [],
        },
      },
    }, () => {
      navigation.build();
    });

    assert.equal(lineTraceCount, 0);
    assert.ok(boxTraceCount > 0);
    assert.ok(navigation.graph.nodes.length > 0);
    assert.ok(navigation.geometry.walkableSurfaces.length > 0);

    for (const node of navigation.graph.nodes) {
      assert.ok(node.origin[2] >= 24, 'navigation node should be stored as a stand origin');
    }
  });

  void test('clears previously extracted surfaces before rebuilding', async () => {
    const worldmodel = createNavigationWorldModel();
    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: {
        DPrint() {},
        PrintWarning() {},
        PrintSuccess() {},
        PrintError() {},
      },
      SV: {
        collision,
        server: {
          mapname: 'nav-test',
          worldmodel,
          num_edicts: 0,
          edicts: [],
        },
      },
    }, () => {
      navigation.build();
      const firstSurfaceCount = navigation.geometry.walkableSurfaces.length;
      const firstNodeCount = navigation.graph.nodes.length;

      navigation.build();

      assert.equal(navigation.geometry.walkableSurfaces.length, firstSurfaceCount);
      assert.equal(navigation.graph.nodes.length, firstNodeCount);
    });
  });

  void test('does not collapse a large walkable region into a single node', async () => {
    const worldmodel = createNavigationWorldModel();
    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: {
        DPrint() {},
        PrintWarning() {},
        PrintSuccess() {},
        PrintError() {},
      },
      SV: {
        collision,
        server: {
          mapname: 'nav-test',
          worldmodel,
          num_edicts: 0,
          edicts: [],
        },
      },
    }, () => {
      navigation.build();
    });

    assert.ok(navigation.graph.nodes.length > 4);
    assert.ok(navigation.graph.nodes.some((node) => node.neighbors.length > 0));
  });

  void test('rejects walkable samples that lack monster-style corner support', async () => {
    const worldmodel = createNavigationWorldModel();
    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(
          start,
          mins,
          maxs,
          end,
          (point) => point[0] >= -4 && point[0] <= 44 && Math.abs(point[1]) <= 16 && point[2] <= 24.0,
        );
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(
          start,
          mins,
          maxs,
          end,
          (point) => point[0] >= -4 && point[0] <= 44 && Math.abs(point[1]) <= 16 && point[2] <= 24.0,
        );
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, (probe) => probe[0] >= -4 && probe[0] <= 44 && Math.abs(probe[1]) <= 16 && probe[2] <= 24.0);
      },
      staticWorldContents(point) {
        return point[0] >= -4 && point[0] <= 44 && Math.abs(point[1]) <= 16 && point[2] <= 24.0 ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: {
        DPrint() {},
        PrintWarning() {},
        PrintSuccess() {},
        PrintError() {},
      },
      SV: {
        collision,
        server: {
          mapname: 'nav-test',
          worldmodel,
          num_edicts: 0,
          edicts: [],
        },
      },
    }, () => {
      navigation.build();
    });

    assert.equal(navigation.graph.nodes.length, 0);
    assert.equal(navigation.graph.octree, null);
    assert.equal(navigation.geometry.walkableSurfaces.length, 0);
  });

  void test('does not persist extracted waypoints into nav files', async () => {
    const worldmodel = createNavigationWorldModel();
    let writtenData = null;

    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: {
        WriteFile(_filename, data) {
          writtenData = new Uint8Array(data);
          return Promise.resolve();
        },
      },
      Con: {
        DPrint() {},
        PrintWarning() {},
        PrintSuccess() {},
        PrintError() {},
      },
      SV: {
        collision,
        server: {
          mapname: 'nav-test',
          worldmodel,
          num_edicts: 0,
          edicts: [],
        },
      },
    }, () => {
      navigation.build();
    });

    assert.ok(writtenData);

    const { nodeCount, surfaceCounts } = readNavSurfaceCounts(writtenData);

    assert.ok(nodeCount > 0);
    assert.ok(surfaceCounts.every((count) => count === 0));
  });

  void test('publishes nav.load after saving a rebuilt graph in listen-server mode', async () => {
    const worldmodel = createNavigationWorldModel();
    const publishedLoads = [];

    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: {
        DPrint() {},
        PrintWarning() {},
        PrintSuccess() {},
        PrintError() {},
      },
      SV: {
        collision,
        server: {
          mapname: 'nav-test',
          worldmodel,
          num_edicts: 0,
          edicts: [],
        },
      },
    }, async () => {
      registry.isDedicatedServer = false;

      const unsubscribe = eventBus.subscribe('nav.load', (mapname, checksum) => {
        publishedLoads.push({ mapname, checksum });
      });

      navigation.build();
      await Promise.resolve();
      await Promise.resolve();
      unsubscribe();
    });

    assert.deepEqual(publishedLoads, [{ mapname: 'nav-test', checksum: worldmodel.checksum }]);
  });

  void test('does not call SV.collision.move during nav mesh build', async () => {
    const worldmodel = createNavigationWorldModel();

    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        assertExpectedTraceShape(mins, maxs);
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move() {
        assert.fail('Navigation.build must not call SV.collision.move — use traceStaticWorld for static-only queries');
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {
        collision,
        server: { mapname: 'nav-test', worldmodel, num_edicts: 0, edicts: [] },
      },
    }, () => {
      navigation.build();
    });

    assert.ok(navigation.graph.nodes.length > 0, 'should have produced nodes');
  });

});

// ---------------------------------------------------------------------------
// Tight-corridor regression test
//
// A flat floor inside a corridor that is exactly 72 units tall (8 units of headroom
// above the 64-unit walker). The adaptive start-height formula must keep the
// entity top (searchStart.z + 40) below the ceiling so waypoints are generated.
// The old fixed start of worldPoint.z + 82 (entity top at +122) would pierce
// this ceiling and produce startsolid=true, yielding zero nav nodes.
// ---------------------------------------------------------------------------

void describe('Navigation.build (tight corridor)', () => {
  void test('produces nav nodes in a corridor that is only 72 units tall', async () => {
    // Floor face at z=0, walkable surface normal (0,0,1), corridor ceiling at z=72.
    const worldmodel = createNavigationWorldModel();

    // Walker top when standing = stand_z + walkerMaxs.z = 24 + 40 = 64 < 72 (fits).
    // Adaptive searchStart.z = 0 + 24 + 0 + 2 = 26. Entity top = 66 < 72 (fine).
    // Old broken searchStart.z = 0 + 64 + 18 = 82. Entity top = 122 > 72 (startsolid).
    const CORRIDOR_CEILING_Z = 72;
    const WALKER_TOP_EXTENT = 40; // walkerMaxs.z

    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        const isPointTrace = mins.isOrigin() && maxs.isOrigin();

        if (!isPointTrace && start[2] + WALKER_TOP_EXTENT > CORRIDOR_CEILING_Z) {
          // Entity top exceeds the corridor ceiling — report startsolid.
          return createTrace(end, start, 0.0, true, true);
        }

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {
        collision,
        server: { mapname: 'tight-corridor-test', worldmodel, num_edicts: 0, edicts: [] },
      },
    }, () => {
      navigation.build();
    });

    assert.ok(
      navigation.graph.nodes.length > 0,
      'flat floor in a 72-unit corridor must produce nav nodes',
    );
  });
});

// ---------------------------------------------------------------------------
// Slope tests — use a face tilted at ~26.6° (stability ≈ 0.894, above MIN_STEP_NORMAL 0.7)
// Floor height: z_surface(x) = x * 0.5
// Stand origin on slope: z_stand(x) = x * 0.5 + 32
//   (bottom of walker AABB at x + walkerMaxs[0]=16 must sit on z=(x+16)*0.5;
//    so z_stand - 24 = (x+16)*0.5  →  z_stand = x*0.5 + 8 + 24 = x*0.5 + 32)
// ---------------------------------------------------------------------------

/** Slope rate dz/dx */
const SLOPE_RATE = 0.5;
/** Offset from slope surface z to walker stand-origin z (accounts for box width on slope). */
const SLOPE_STAND_OFFSET = (-NAV_MONSTER_MINS[2]) + NAV_MONSTER_MAXS[0] * SLOPE_RATE; // 24 + 8 = 32

/**
 * @param {number} x
 * @returns {number} floor surface z at x
 */
function slopeSurfaceZ(x) {
  return x * SLOPE_RATE;
}

/**
 * @param {number} x
 * @returns {number} stand origin z for walker centered at x
 */
function slopeStandZ(x) {
  return slopeSurfaceZ(x) + SLOPE_STAND_OFFSET;
}

/**
 * Box/point trace stub against a ramp surface whose height is z = x * SLOPE_RATE.
 * @param {Vector} start
 * @param {Vector} mins
 * @param {Vector} maxs
 * @param {Vector} end
 * @returns {{endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null}} trace stub result
 */
function traceAgainstRamp(start, mins, maxs, end) {
  const isPointTrace = mins.isOrigin() && maxs.isOrigin();

  if (!isPointTrace) {
    // Box trace — use the stand-origin formula (walker bottom must clear uphill edge).
    const standZ = slopeStandZ(start[0]);

    if (end[2] < start[2]) {
      // Downward: snap to stand origin if in range.
      if (start[2] < standZ) {
        return createTrace(end, start, 0.0, true, true);
      }

      if (end[2] >= standZ) {
        return createTrace(end, end, 1.0);
      }

      const landed = start.copy();
      landed[2] = standZ;
      const fraction = (start[2] - standZ) / (start[2] - end[2]);
      return createTrace(end, landed, fraction);
    }

    // Upward or zero-length: not solid if at or above stand origin.
    if (start[2] < standZ - 0.5) {
      return createTrace(end, start, 0.0, true, true);
    }

    return createTrace(end, end, 1.0);
  }

  // Point trace — uses raw surface z.
  const floorZ = slopeSurfaceZ(start[0]);

  if (end[2] < start[2]) {
    if (start[2] <= floorZ || end[2] >= floorZ) {
      return createTrace(end, end, 1.0);
    }

    const landed = start.copy();
    landed[2] = floorZ;
    const fraction = (start[2] - floorZ) / (start[2] - end[2]);
    return createTrace(end, landed, fraction);
  }

  return createTrace(end, end, 1.0);
}

/**
 * @returns minimal worldmodel whose single face is a sloped ramp.
 * Vertices: (0,0,0)→(128,0,64)→(128,128,64)→(0,128,0) — a quad tilted in X at 26.6°.
 * Face normal ≈ (-0.447, 0, 0.894), stability ≈ 0.894 > MIN_STEP_NORMAL.
 */
function createSlopeWorldModel() {
  const invSqrt5 = 1.0 / Math.sqrt(5);

  return {
    checksum: 9999,
    planes: [{ normal: new Vector(-invSqrt5, 0, 2 * invSqrt5) }],
    faces: [{
      numedges: 4,
      normal: new Vector(-invSqrt5, 0, 2 * invSqrt5),
      plane: { normal: new Vector(-invSqrt5, 0, 2 * invSqrt5) },
      planeBack: false,
      turbulent: false,
      sky: false,
      submodel: false,
      firstedge: 0,
    }],
    surfedges: [1, 2, 3, 4],
    edges: [
      [0, 0],
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ],
    vertexes: [
      new Vector(0, 0, 0),
      new Vector(128, 0, 64),
      new Vector(128, 128, 64),
      new Vector(0, 128, 0),
    ],
  };
}

void describe('Navigation.build (slope)', () => {
  void test('produces nodes on a sloped face and stores slope-corrected stand origins', async () => {
    const worldmodel = createSlopeWorldModel();

    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        return traceAgainstRamp(start, mins, maxs, end);
      },
      move(start, mins, maxs, end) {
        // move must not be called during nav build
        return traceAgainstRamp(start, mins, maxs, end);
      },
      pointContents(point) {
        // solid below the ramp surface
        return point[2] < slopeSurfaceZ(point[0]) ? -2 : 0;
      },
      staticWorldContents(point) {
        return point[2] < slopeSurfaceZ(point[0]) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {
        collision,
        server: { mapname: 'slope-test', worldmodel, num_edicts: 0, edicts: [] },
      },
    }, () => {
      navigation.build();
    });

    assert.ok(navigation.graph.nodes.length > 0, 'slope face should produce at least one nav node');

    for (const node of navigation.graph.nodes) {
      // Stand origin must be on or above the slope-corrected height for its x position.
      const expectedMinZ = slopeStandZ(node.origin[0]);
      assert.ok(
        node.origin[2] >= expectedMinZ - 1.0,
        `node at x=${node.origin[0].toFixed(1)} should have z >= ${expectedMinZ.toFixed(1)}, got ${node.origin[2].toFixed(1)}`,
      );
    }
  });
});

void describe('Navigation.findPath', () => {
  void test('returns direct path when start and goal share the nearest node', async () => {
    const worldmodel = createNavigationWorldModel();
    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {
        collision,
        server: { mapname: 'nav-test', worldmodel, num_edicts: 0, edicts: [] },
      },
    }, () => {
      navigation.build();
    });

    assert.ok(navigation.graph.nodes.length > 1, 'should have multiple nodes');

    const node = navigation.graph.nodes[0];
    const start = node.origin.copy();
    const goal = node.origin.copy().add(new Vector(1, 1, 0));

    const path = navigation.findPath(start, goal);
    assert.ok(path);
    assert.equal(path.length, 2);
    assert.deepEqual([...path[0]], [...start]);
    assert.deepEqual([...path[1]], [...goal]);
  });

  void test('finds a multi-hop path across connected nodes', async () => {
    const worldmodel = createNavigationWorldModel();
    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {
        collision,
        server: { mapname: 'nav-test', worldmodel, num_edicts: 0, edicts: [] },
      },
    }, () => {
      navigation.build();
    });

    // pick two distant nodes that require multiple hops
    const nodes = navigation.graph.nodes;
    assert.ok(nodes.length >= 4, 'need at least 4 nodes for a multi-hop test');

    // use two nodes that are far apart
    const startNode = nodes[0];
    const goalNode = nodes[nodes.length - 1];

    // ensure they are distinct
    assert.notEqual(startNode.id, goalNode.id);

    const path = navigation.findPath(startNode.origin.copy(), goalNode.origin.copy());

    // the single flat floor must be fully connected — a null path means links were not built
    assert.ok(path, 'expected a path across a single connected floor');
    assert.ok(path.length >= 2, 'path should have at least start and goal');
    assert.deepEqual([...path[0]], [...startNode.origin]);
    assert.deepEqual([...path[path.length - 1]], [...goalNode.origin]);
  });

  void test('returns null when graph is empty', () => {
    const navigation = new Navigation(null);

    Navigation.nav_debug_path = { value: 0 };

    const path = navigation.findPath(new Vector(0, 0, 24), new Vector(100, 100, 24));
    assert.equal(path, null);
  });

  void test('returns null when start or goal has no nearby node', async () => {
    const worldmodel = createNavigationWorldModel();
    const collision = {
      traceStaticWorld(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start, mins, maxs, end) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
    };

    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {
        collision,
        server: { mapname: 'nav-test', worldmodel, num_edicts: 0, edicts: [] },
      },
    }, () => {
      navigation.build();

      assert.ok(navigation.graph.nodes.length > 0);

      // position far away from any node
      const farAway = new Vector(99999, 99999, 99999);
      const path = navigation.findPath(farAway, navigation.graph.nodes[0].origin.copy());
      assert.equal(path, null);
    });
  });
});

// ---------------------------------------------------------------------------
// Two-level floor regression test
//
// Two flat floors at different heights joined by a 72-unit vertical drop:
//   - Upper floor: x=[0,200], y=[0,200], z=0 (stand z=24)
//   - Lower floor: x=[0,200], y=[200,400], z=-72 (stand z=-48)
//
// The closest valid node pair across the transition is ~76 units apart in 3D,
// which exceeds the old linkRadius=64.  After fixing to linkRadius=96, the
// drop link is built and findPath from the upper to the lower floor succeeds.
//
// This reproduces the in-game failure where monster_army (edict 93) and
// monster_dog (edict 94) on e1m1 could not find a path to the player at
// [18, 884.375, -200] because the nav graph lacked drop links across the
// ~72-unit staircase transition between the upper floor and the lower corridor.
// ---------------------------------------------------------------------------

/**
 * @returns {{faces: object[], surfedges: number[], edges: number[][], vertexes: Vector[], checksum: number}} two-level worldmodel
 */
function createTwoLevelWorldModel() {
  return {
    checksum: 2024,
    planes: [
      { normal: new Vector(0, 0, 1) },
      { normal: new Vector(0, 0, 1) },
    ],
    faces: [
      // Upper floor: x=[0,200], y=[0,200], z=0
      {
        numedges: 4,
        normal: new Vector(0, 0, 1),
        plane: { normal: new Vector(0, 0, 1) },
        planeBack: false,
        turbulent: false,
        sky: false,
        submodel: false,
        firstedge: 0,
      },
      // Lower floor: x=[0,200], y=[200,400], z=-72
      {
        numedges: 4,
        normal: new Vector(0, 0, 1),
        plane: { normal: new Vector(0, 0, 1) },
        planeBack: false,
        turbulent: false,
        sky: false,
        submodel: false,
        firstedge: 4,
      },
    ],
    surfedges: [1, 2, 3, 4, 5, 6, 7, 8],
    edges: [
      [0, 0],   // 0: placeholder
      [0, 1],   // 1: upper v0→v1
      [1, 2],   // 2: upper v1→v2
      [2, 3],   // 3: upper v2→v3
      [3, 0],   // 4: upper v3→v0
      [4, 5],   // 5: lower v4→v5
      [5, 6],   // 6: lower v5→v6
      [6, 7],   // 7: lower v6→v7
      [7, 4],   // 8: lower v7→v4
    ],
    vertexes: [
      new Vector(0, 0, 0),         // 0: upper (0,0)
      new Vector(200, 0, 0),       // 1: upper (200,0)
      new Vector(200, 200, 0),     // 2: upper (200,200)
      new Vector(0, 200, 0),       // 3: upper (0,200)
      new Vector(0, 200, -72),     // 4: lower (0,200)
      new Vector(200, 200, -72),   // 5: lower (200,200)
      new Vector(200, 400, -72),   // 6: lower (200,400)
      new Vector(0, 400, -72),     // 7: lower (0,400)
    ],
  };
}

// Upper floor (y≤200) surface at z=0, stand z=24.
// Lower floor (y>200) surface at z=-72, stand z=-48.
// Floor determination uses the center position (no AABB overlap modelling).
const TWO_LEVEL_BOUNDARY_Y = 200;
const UPPER_FLOOR_SURFACE_Z = 0;
const LOWER_FLOOR_SURFACE_Z = -72;
const TWO_LEVEL_WALKER_CLEARANCE = 24; // -walkerMins.z

/**
 * @param {number} y
 * @returns {number} floor surface z at this y position
 */
function twoLevelSurfaceZ(y) {
  return y <= TWO_LEVEL_BOUNDARY_Y ? UPPER_FLOOR_SURFACE_Z : LOWER_FLOOR_SURFACE_Z;
}

/**
 * Box/point trace stub for the two-level floor.
 * Uses the center y position to determine which floor level applies.
 * @param {Vector} start
 * @param {Vector} mins
 * @param {Vector} maxs
 * @param {Vector} end
 * @returns {{endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null}} trace stub
 */
function traceAgainstTwoLevelFloor(start, mins, maxs, end) {
  const isPointTrace = mins.isOrigin() && maxs.isOrigin();
  const surfZ = twoLevelSurfaceZ(start[1]);
  // Box traces land when the bottom of the walker box reaches the floor surface.
  const landZ = isPointTrace ? surfZ : surfZ + TWO_LEVEL_WALKER_CLEARANCE;

  if (end[2] < start[2]) {
    // Downward trace.
    if (start[2] < landZ) {
      return createTrace(end, start, 0.0, true, true);
    }
    if (end[2] >= landZ) {
      return createTrace(end, end, 1.0);
    }
    const landed = start.copy();
    landed[2] = landZ;
    const totalDrop = start[2] - end[2];
    const travelled = start[2] - landZ;
    return createTrace(end, landed, Math.max(0, travelled / totalDrop));
  }

  // Zero-length or upward trace: startsolid if strictly below the floor stand level.
  if (start[2] < landZ - 0.5) {
    return createTrace(end, start, 0.0, true, true);
  }

  // No ceiling in this test — upward traces always succeed.
  return createTrace(end, end, 1.0);
}

/**
 * @param {Vector} point
 * @returns {number} CONTENT_SOLID (-2) when below the floor surface, else 0
 */
function twoLevelPointContents(point) {
  return point[2] < twoLevelSurfaceZ(point[1]) ? -2 : 0;
}

void describe('Navigation (two-level floor — drop-link regression)', () => {
  /**
   * Build a navigation graph on the two-level test world and return it.
   * @returns {Promise<import('../../source/engine/server/Navigation.ts').Navigation>} built navigation instance
   */
  async function buildTwoLevelNavigation() {
    const worldmodel = createTwoLevelWorldModel();
    const navigation = new Navigation(worldmodel);

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };
    Navigation.nav_debug_path = { value: 0 };

    const collision = {
      traceStaticWorld: traceAgainstTwoLevelFloor,
      move: traceAgainstTwoLevelFloor,
      pointContents: twoLevelPointContents,
      staticWorldContents: twoLevelPointContents,
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    await withNavigationRegistry({
      COM: { WriteFile() { return Promise.resolve(); } },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {
        collision,
        server: { mapname: 'two-level-drop-test', worldmodel, num_edicts: 0, edicts: [] },
      },
    }, () => {
      navigation.build();
    });

    return navigation;
  }

  void test('produces nav nodes on both floor levels', async () => {
    const navigation = await buildTwoLevelNavigation();
    const nodes = navigation.graph.nodes;

    assert.ok(nodes.length > 0, 'should have nav nodes');

    const upperNodes = nodes.filter((n) => n.origin[2] > 20 && n.origin[2] < 30);
    const lowerNodes = nodes.filter((n) => n.origin[2] > -55 && n.origin[2] < -40);

    assert.ok(upperNodes.length > 0, 'should have nav nodes on the upper floor (z≈24)');
    assert.ok(lowerNodes.length > 0, 'should have nav nodes on the lower floor (z≈-48)');
  });

  void test('finds a path from upper floor to lower floor via a drop link', async () => {
    const navigation = await buildTwoLevelNavigation();

    // Start in the middle of the upper floor, goal in the middle of the lower floor.
    // The two floors are joined by a 72-unit vertical drop; the closest valid node pair
    // across the transition is ~76 units apart — above the old linkRadius=64.
    const startPos = new Vector(100, 100, 24);
    const goalPos = new Vector(100, 300, -48);

    const path = navigation.findPath(startPos, goalPos);

    assert.ok(
      path !== null,
      'findPath must connect the upper and lower floors via a drop link; ' +
      'if null, linkRadius is too small for the ~76-unit inter-floor gap',
    );
    assert.ok(path.length >= 2, 'path should have at least the start and goal positions');
  });
});

// Load test_e1m1.nav once for all in-game regression tests.
const navFileBytes = readFileSync(new URL('../../data/id1/maps/test_e1m1.nav', import.meta.url));
const navFileBuffer = navFileBytes.buffer.slice(navFileBytes.byteOffset, navFileBytes.byteOffset + navFileBytes.byteLength);

void describe('Navigation.findPath (test_e1m1.nav — in-game path regression)', () => {
  /** @type {import('../../source/engine/server/Navigation.ts').Navigation} */
  let navigation;

  before(async () => {
    navigation = new Navigation(null);
    Navigation.nav_debug_path = { value: 0 };
    Navigation.nav_debug_graph = { value: 0 };
    Navigation.nav_debug_waypoints = { value: 0 };

    await withNavigationRegistry({
      COM: { LoadFile: () => Promise.resolve(navFileBuffer) },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {},
    }, async () => {
      await navigation.load('test_e1m1', 5874);
    });
  });

  void test('same-level path: monster at [0,576,24] → player at [500,574,24]', () => {
    const path = navigation.findPath(
      new Vector(0, 576, 24.03125),
      new Vector(500.125, 573.875, 24.125),
    );

    assert.ok(
      path !== null,
      'path should exist — both positions are in the same flat starting area',
    );
  });

  void test('cross-area path: monster at [88,1520,-200] → player at [-144,572,-223]', () => {
    // Monster is in the large lower corridor (y≈1500), player is near the start area
    // (y≈572). Both positions are physically reachable from each other in e1m1.
    //
    // Failure means the nav file has disconnected components. The root cause is that the
    // nav builder was run with linkRadius=64, which is too small for staircase transitions
    // (~115 unit inter-node gaps). Fix: rebuild test_e1m1.nav after setting linkRadius=128.
    const path = navigation.findPath(
      new Vector(88, 1520, -199.96875),
      new Vector(-143.75, 571.875, -223.25),
    );

    assert.ok(
      path !== null,
      'path should exist — monster and player are physically reachable in e1m1. ' +
      'Failure indicates the nav file has disconnected components due to small linkRadius. ' +
      'Rebuild test_e1m1.nav with linkRadius=128.',
    );
  });

  void test('deep-area path: monster at [832,2072,-408] → player at [-144,572,-223]', () => {
    // Monster is in the outdoor silver-key area (y≈2072, z=-408), player is near the
    // start area (y≈572, z=-223). Both are physically reachable in e1m1.
    //
    // Failure means the nav file is missing node coverage in the transition zone between
    // z=-408 and z=-344 (the closest boundary is ~234 units — no amount of linkRadius
    // increase can bridge a gap that has no intermediate nodes). Fix: rebuild
    // test_e1m1.nav so the nav builder generates nodes through the connecting corridors.
    const path = navigation.findPath(
      new Vector(832, 2072, -407.96875),
      new Vector(-143.75, 571.875, -223.25),
    );

    assert.ok(
      path !== null,
      'path should exist — monster and player are physically reachable in e1m1. ' +
      'Failure indicates missing nav node coverage in the connecting corridor ' +
      '(z=-408 to z=-344 transition). Rebuild test_e1m1.nav.',
    );
  });
});
