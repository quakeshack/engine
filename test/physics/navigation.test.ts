import assert from 'node:assert/strict';
import { describe, test, before, mock } from 'node:test';
import { readFileSync } from 'node:fs';

import Vector from '../../source/shared/Vector.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { Navigation, NavigationHull, NavMeshOutOfDateException } from '../../source/engine/server/Navigation.ts';
import { mockedNavigationServices } from '../support/fixtures.ts';
import { createCvarStub } from '../support/cvarStub.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

const NAV_MONSTER_MINS = new Vector(-16.0, -16.0, -24.0);
const NAV_MONSTER_MAXS = new Vector(16.0, 16.0, 40.0);
const NAV_LARGE_MONSTER_MINS = new Vector(-32.0, -32.0, -24.0);
const NAV_LARGE_MONSTER_MAXS = new Vector(32.0, 32.0, 64.0);

/**
 * @returns The minimal world model a navigation build reads: faces, edges and vertexes of one floor triangle.
 */
function createNavigationWorldModel(): BrushModel {
  // A real BrushModel comes from a BSP file; the build reads just the members below.
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
  } as unknown as BrushModel;
}

/**
 * @param position stand origin to validate
 * @returns true when the stand origin fits on the test floor
 */
function isSupportedStandOrigin(position: Vector): boolean {
  return position[2] >= 24
    && position[2] <= 128;
}

/**
 * @param point world point to validate
 * @returns true when the point sits over the default supporting floor
 */
function isSupportedFloorPoint(point: Vector): boolean {
  return point[2] <= 24.0;
}

/**
 * Asserts a box trace uses the walker's box or the large-monster box.
 * @param mins trace mins
 * @param maxs trace maxs
 */
function assertExpectedTraceShape(mins: Vector, maxs: Vector) {
  const isPointTrace = mins.isOrigin() && maxs.isOrigin();

  if (isPointTrace) {
    return;
  }

  if (mins[0] === NAV_LARGE_MONSTER_MINS[0]) {
    assert.deepEqual([...mins], [...NAV_LARGE_MONSTER_MINS]);
    assert.deepEqual([...maxs], [...NAV_LARGE_MONSTER_MAXS]);
    return;
  }

  assert.deepEqual([...mins], [...NAV_MONSTER_MINS]);
  assert.deepEqual([...maxs], [...NAV_MONSTER_MAXS]);
}

/**
 * @param start trace start
 * @param mins trace mins
 * @param maxs trace maxs
 * @param end trace end
 * @param hasFloorAt test floor predicate
 * @returns trace stub
 */
function traceAgainstFlatFloor(start: Vector, mins: Vector, maxs: Vector, end: Vector, hasFloorAt: (point: Vector) => boolean): {endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null} {
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
 * @param point world point to test
 * @param hasFloorAt test floor predicate
 * @returns point contents result
 */
function contentsAgainstFlatFloor(point: Vector, hasFloorAt: (point: Vector) => boolean): number {
  return hasFloorAt(point) ? -2 : 0;
}

/**
 * @param end end position
 * @param endpos resolved trace end position
 * @param fraction travelled fraction
 * @param [startsolid] whether the trace started in solid
 * @param [allsolid] whether the trace stayed in solid
 * @returns trace stub
 */
function createTrace(end: Vector, endpos: Vector, fraction: number, startsolid: boolean = false, allsolid: boolean = false): {endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null} {
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
 * @param mockRegistry registry overrides
 * @param callback test body
 * @returns callback result after registry restoration
 */
function withNavigationRegistry(mockRegistry: { Con: object, COM: object, SV: object }, callback: () => Promise<void>|void): Promise<void> {
  return withEngineMocks({
    CL: null,
    COM: mockRegistry.COM,
    Con: mockRegistry.Con,
    Host: { frametime: 0.1 },
    R: null,
    SV: mockRegistry.SV,
  }, async () => {
    await callback();

    // The navigation graph is saved in the background and reports a failure through the console of the mocks:
    // keep them installed until what is still pending has settled.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
}

/**
 * @param data nav file data
 * @returns parsed node and surface metadata
 */
function readNavSurfaceCounts(data: Uint8Array): {nodeCount: number, surfaceCounts: number[]} {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const readBytes = (count: number) => {
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

    // large-hull origin, when the node has one
    if (readUint8()) {
      readFloat32();
      readFloat32();
      readFloat32();
    }

    const neighborCount = readUint32();
    for (let neighborIndex = 0; neighborIndex < neighborCount; neighborIndex++) {
      readInt32();
      readFloat32();
      readFloat32();
      readUint8();
    }
  }

  // the reader must end where the file does, or it read another layout
  assert.equal(offset, data.byteLength);

  return { nodeCount, surfaceCounts };
}

void describe('Navigation.build', () => {
  void test('uses monster-sized static-world traces and stores stand origins', async () => {
    const worldmodel = createNavigationWorldModel();
    let boxTraceCount = 0;
    let lineTraceCount = 0;

    const collision = {
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        boxTraceCount++;

        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point: Vector) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        lineTraceCount++;
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point: Vector) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point: Vector) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(
          start,
          mins,
          maxs,
          end,
          (point) => point[0] >= -4 && point[0] <= 44 && Math.abs(point[1]) <= 16 && point[2] <= 24.0,
        );
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(
          start,
          mins,
          maxs,
          end,
          (point) => point[0] >= -4 && point[0] <= 44 && Math.abs(point[1]) <= 16 && point[2] <= 24.0,
        );
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, (probe) => probe[0] >= -4 && probe[0] <= 44 && Math.abs(probe[1]) <= 16 && probe[2] <= 24.0);
      },
      staticWorldContents(point: Vector) {
        return point[0] >= -4 && point[0] <= 44 && Math.abs(point[1]) <= 16 && point[2] <= 24.0 ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point: Vector) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: {
        WriteGeneratedFile(_filename: string, data: Uint8Array) {
          writtenData = new Uint8Array(data);
          return Promise.resolve(true);
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
    const publishedLoads: Array<{ mapname: string; checksum: number | null }> = [];

    const collision = {
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        assertExpectedTraceShape(mins, maxs);

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point: Vector) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        assertExpectedTraceShape(mins, maxs);
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move() {
        assert.fail('Navigation.build must not call SV.collision.move — use traceStaticWorld for static-only queries');
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point: Vector) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        const isPointTrace = mins.isOrigin() && maxs.isOrigin();

        if (!isPointTrace && start[2] + WALKER_TOP_EXTENT > CORRIDOR_CEILING_Z) {
          // Entity top exceeds the corridor ceiling — report startsolid.
          return createTrace(end, start, 0.0, true, true);
        }

        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
      staticWorldContents(point: Vector) {
        return isSupportedFloorPoint(point) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
 * @param x
 * @returns floor surface z at x
 */
function slopeSurfaceZ(x: number): number {
  return x * SLOPE_RATE;
}

/**
 * @param x
 * @returns stand origin z for walker centered at x
 */
function slopeStandZ(x: number): number {
  return slopeSurfaceZ(x) + SLOPE_STAND_OFFSET;
}

/**
 * Box/point trace stub against a ramp surface whose height is z = x * SLOPE_RATE.
 * @param start
 * @param mins
 * @param maxs
 * @param end
 * @returns trace stub result
 */
function traceAgainstRamp(start: Vector, mins: Vector, maxs: Vector, end: Vector): {endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null} {
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
function createSlopeWorldModel(): BrushModel {
  // A real BrushModel comes from a BSP file; the build reads just the members below.
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
  } as unknown as BrushModel;
}

void describe('Navigation.build (slope)', () => {
  void test('produces nodes on a sloped face and stores slope-corrected stand origins', async () => {
    const worldmodel = createSlopeWorldModel();

    const collision = {
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstRamp(start, mins, maxs, end);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        // move must not be called during nav build
        return traceAgainstRamp(start, mins, maxs, end);
      },
      pointContents(point: Vector) {
        // solid below the ramp surface
        return point[2] < slopeSurfaceZ(point[0]) ? -2 : 0;
      },
      staticWorldContents(point: Vector) {
        return point[2] < slopeSurfaceZ(point[0]) ? -1 : 0;
      },
      traceStaticWorldLine() {
        assert.fail('Navigation.build should not use point-sized static line traces');
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
    const navigation = new Navigation(null, mockedNavigationServices());

    Navigation.nav_debug_path = createCvarStub(0);

    const path = navigation.findPath(new Vector(0, 0, 24), new Vector(100, 100, 24));
    assert.equal(path, null);
  });

  void test('returns null when start or goal has no nearby node', async () => {
    const worldmodel = createNavigationWorldModel();
    const collision = {
      traceStaticWorld(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      move(start: Vector, mins: Vector, maxs: Vector, end: Vector) {
        return traceAgainstFlatFloor(start, mins, maxs, end, isSupportedFloorPoint);
      },
      pointContents(point: Vector) {
        return contentsAgainstFlatFloor(point, isSupportedFloorPoint);
      },
    };

    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

    await withNavigationRegistry({
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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
 * @returns The world model of two floors, one above the other.
 */
function createTwoLevelWorldModel(): BrushModel {
  // A real BrushModel comes from a BSP file; the build reads just the members below.
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
  } as unknown as BrushModel;
}

// Upper floor (y≤200) surface at z=0, stand z=24.
// Lower floor (y>200) surface at z=-72, stand z=-48.
// Floor determination uses the center position (no AABB overlap modelling).
const TWO_LEVEL_BOUNDARY_Y = 200;
const UPPER_FLOOR_SURFACE_Z = 0;
const LOWER_FLOOR_SURFACE_Z = -72;
const TWO_LEVEL_WALKER_CLEARANCE = 24; // -walkerMins.z

/**
 * @param y
 * @returns floor surface z at this y position
 */
function twoLevelSurfaceZ(y: number): number {
  return y <= TWO_LEVEL_BOUNDARY_Y ? UPPER_FLOOR_SURFACE_Z : LOWER_FLOOR_SURFACE_Z;
}

/**
 * Box/point trace stub for the two-level floor.
 * Uses the center y position to determine which floor level applies.
 * @param start
 * @param mins
 * @param maxs
 * @param end
 * @returns trace stub
 */
function traceAgainstTwoLevelFloor(start: Vector, mins: Vector, maxs: Vector, end: Vector): {endpos: Vector, fraction: number, startsolid: boolean, allsolid: boolean, ent: null} {
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
 * @param point
 * @returns CONTENT_SOLID (-2) when below the floor surface, else 0
 */
function twoLevelPointContents(point: Vector): number {
  return point[2] < twoLevelSurfaceZ(point[1]) ? -2 : 0;
}

void describe('Navigation (two-level floor — drop-link regression)', () => {
  /**
   * Build a navigation graph on the two-level test world and return it.
   * @returns built navigation instance
   */
  async function buildTwoLevelNavigation(): Promise<Navigation> {
    const worldmodel = createTwoLevelWorldModel();
    const navigation = new Navigation(worldmodel, mockedNavigationServices());

    Navigation.nav_build_process = null;
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);
    Navigation.nav_debug_path = createCvarStub(0);

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
      COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
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

  void test('a walking monster gets no path down the drop, which it would not step off', async () => {
    const navigation = await buildTwoLevelNavigation();

    const path = navigation.findPath(new Vector(100, 100, 24), new Vector(100, 300, -48), NavigationHull.SMALL);

    assert.equal(path, null);
  });
});

// ---------------------------------------------------------------------------
// Worlds of solid boxes
//
// Box traces against axis-aligned solid boxes are exact (the box swept against each solid grown by the box's size),
// so these worlds have walls, gaps and corridors that the navigation builder sees as it sees a map's.
// ---------------------------------------------------------------------------

/** A solid axis-aligned box: mins and maxs. */
type Solid = readonly [readonly [number, number, number], readonly [number, number, number]];

/** A floor rectangle at z = 0 the builder samples for waypoints: x0, y0, x1, y1. */
type FloorRectangle = readonly [number, number, number, number];

/** The trace members the navigation builder reads. */
interface BoxWorldTrace {
  endpos: Vector;
  fraction: number;
  startsolid: boolean;
  allsolid: boolean;
  plane: { normal: Vector; dist: number };
  ent: null;
}

/** Quake keeps a trace this far off the surface it hit. */
const DIST_EPSILON = 0.03125;

/**
 * Whether a box at `point` overlaps a solid grown by the box's size, touching excluded.
 * @returns True when inside.
 */
function insideGrownSolid(point: Vector, solid: Solid, mins: Vector, maxs: Vector): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (point[axis] <= solid[0][axis] - maxs[axis] || point[axis] >= solid[1][axis] - mins[axis]) {
      return false;
    }
  }

  return true;
}

/**
 * Sweeps a box from `start` to `end` through solid boxes.
 * @returns The trace.
 */
function traceBoxWorld(solids: readonly Solid[], start: Vector, mins: Vector, maxs: Vector, end: Vector): BoxWorldTrace {
  const startsolid = solids.some((solid) => insideGrownSolid(start, solid, mins, maxs));

  if (startsolid) {
    const allsolid = solids.some((solid) => insideGrownSolid(end, solid, mins, maxs));
    return { endpos: start.copy(), fraction: 0.0, startsolid: true, allsolid, plane: { normal: new Vector(), dist: 0 }, ent: null };
  }

  const delta = end.copy().subtract(start);
  let fraction = 1.0;
  let normal = new Vector();

  for (const solid of solids) {
    let enter = -Infinity;
    let exit = Infinity;
    let enterAxis = -1;

    for (let axis = 0; axis < 3; axis++) {
      const low = solid[0][axis] - maxs[axis];
      const high = solid[1][axis] - mins[axis];

      if (delta[axis] === 0.0) {
        if (start[axis] <= low || start[axis] >= high) {
          exit = -Infinity;
        }
        continue;
      }

      const first = (low - start[axis]) / delta[axis];
      const second = (high - start[axis]) / delta[axis];

      if (Math.min(first, second) > enter) {
        enter = Math.min(first, second);
        enterAxis = axis;
      }

      exit = Math.min(exit, Math.max(first, second));
    }

    if (enterAxis !== -1 && enter < exit && enter >= 0.0 && enter < fraction) {
      fraction = enter;
      normal = new Vector();
      normal[enterAxis] = delta[enterAxis] > 0.0 ? -1.0 : 1.0;
    }
  }

  const endpos = start.copy().add(delta.copy().multiply(fraction));

  if (fraction < 1.0) {
    endpos.add(normal.copy().multiply(DIST_EPSILON));
  }

  return { endpos, fraction, startsolid: false, allsolid: false, plane: { normal, dist: 0 }, ent: null };
}

/**
 * @returns The world model of floor rectangles at z = 0, which the build samples for waypoints.
 */
function createFloorWorldModel(floors: readonly FloorRectangle[]): BrushModel {
  const vertexes: Vector[] = [];
  const edges: number[][] = [[0, 0]];
  const surfedges: number[] = [];
  const faces = floors.map(([x0, y0, x1, y1]) => {
    const first = vertexes.length;
    vertexes.push(new Vector(x0, y0, 0), new Vector(x1, y0, 0), new Vector(x1, y1, 0), new Vector(x0, y1, 0));
    const firstedge = surfedges.length;

    for (let corner = 0; corner < 4; corner++) {
      surfedges.push(edges.length);
      edges.push([first + corner, first + (corner + 1) % 4]);
    }

    return {
      numedges: 4,
      normal: new Vector(0, 0, 1),
      plane: { normal: new Vector(0, 0, 1) },
      planeBack: false,
      turbulent: false,
      sky: false,
      submodel: false,
      firstedge,
    };
  });

  // A real BrushModel comes from a BSP file; the build reads just the members below.
  return { checksum: 4242, planes: [{ normal: new Vector(0, 0, 1) }], faces, surfedges, edges, vertexes } as unknown as BrushModel;
}

/** The members of an entity the navigation builder reads: teleporters, their destinations and doors. */
interface BoxWorldEntity {
  readonly classname: string;
  readonly centerPoint: Vector;
  readonly mins: Vector;
  readonly maxs: Vector;
  readonly target?: string;
  readonly targetname?: string;
  readonly spawnflags?: number;
}

/**
 * Builds the navigation graph of a world of solid boxes.
 * @param entities What `FindAllByFieldAndValue` finds while the graph is built.
 * @returns The navigation with its graph.
 */
async function buildBoxWorldNavigation(solids: readonly Solid[], floors: readonly FloorRectangle[], entities: readonly BoxWorldEntity[] = []): Promise<Navigation> {
  const worldmodel = createFloorWorldModel(floors);
  const navigation = new Navigation(worldmodel, mockedNavigationServices());

  Navigation.nav_build_process = null;
  Navigation.nav_debug_graph = createCvarStub(0);
  Navigation.nav_debug_waypoints = createCvarStub(0);
  Navigation.nav_debug_path = createCvarStub(0);

  const trace = (start: Vector, mins: Vector, maxs: Vector, end: Vector): BoxWorldTrace => traceBoxWorld(solids, start, mins, maxs, end);
  const contents = (point: Vector): number => (solids.some((solid) => insideGrownSolid(point, solid, Vector.origin, Vector.origin)) ? -2 : 0);

  await withNavigationRegistry({
    COM: { WriteGeneratedFile() { return Promise.resolve(true); } },
    Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
    SV: {
      collision: { traceStaticWorld: trace, move: trace, pointContents: contents, staticWorldContents: contents },
      server: { mapname: 'box-world-test', worldmodel, num_edicts: 0, edicts: [] },
      engineAPI: {
        FindAllByFieldAndValue: (field: keyof BoxWorldEntity, value: string) => entities
          .filter((entity) => entity[field] === value)
          .map((entity) => ({ entity })),
      },
    },
  }, () => {
    navigation.build();
  });

  return navigation;
}

/** Walls 256 high around x 0…576, y 0…320, a floor slab below. */
const ENCLOSED_FLOOR: readonly Solid[] = [
  [[-64, -64, -64], [640, 384, 0]],
  [[-64, -64, 0], [0, 384, 256]],
  [[576, -64, 0], [640, 384, 256]],
  [[-64, -64, 0], [640, 0, 256]],
  [[-64, 320, 0], [640, 384, 256]],
];

void describe('Navigation.findPath (monster hulls)', () => {
  // Two rooms (x 0…192 and 384…576) joined by a corridor 48 wide (y 24…72) and, farther away, one 72 wide
  // (y 192…264). The walker (32 wide) fits through both, Quake's hull 2 (64 wide) only through the wide one, and only
  // near its middle, where few of the walker's nodes are.
  const CORRIDOR_WORLD: readonly Solid[] = [
    ...ENCLOSED_FLOOR,
    [[192, -64, 0], [384, 24, 256]],
    [[192, 72, 0], [384, 192, 256]],
    [[192, 264, 0], [384, 320, 256]],
  ];
  const CORRIDOR_FLOORS: readonly FloorRectangle[] = [[0, 0, 192, 320], [384, 0, 576, 320], [192, 24, 384, 72], [192, 192, 384, 264]];
  const LARGE_BOX = { mins: new Vector(-32, -32, -24), maxs: new Vector(32, 32, 64) };
  const SMALL_BOX = { mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 40) };

  /**
   * Whether a path goes through the narrow corridor: a point between the rooms, south of the wall between them.
   * @returns True when it does.
   */
  function throughNarrowCorridor(path: Vector[]): boolean {
    return path.some((point) => point[0] > 192 && point[0] < 384 && point[1] < 192);
  }

  let navigation: Navigation;

  before(async () => {
    navigation = await buildBoxWorldNavigation(CORRIDOR_WORLD, CORRIDOR_FLOORS);
  });

  void test('a small monster takes the narrow corridor, the short way', () => {
    const path = navigation.findPath(new Vector(96, 48, 24), new Vector(480, 48, 24), Navigation.hullFor(SMALL_BOX));

    assert.ok(path !== null);
    assert.ok(throughNarrowCorridor(path));
  });

  void test('a large monster goes around through the wide corridor', () => {
    const path = navigation.findPath(new Vector(96, 64, 24), new Vector(480, 64, 24), Navigation.hullFor(LARGE_BOX));

    assert.ok(path !== null);
    assert.ok(!throughNarrowCorridor(path));
    assert.ok(path.some((point) => point[0] > 192 && point[0] < 384 && point[1] > 192));
  });

  void test('a large monster\'s waypoints leave its box room to stand', () => {
    const path = navigation.findPath(new Vector(96, 64, 24), new Vector(480, 64, 24), Navigation.hullFor(LARGE_BOX))!;

    // every node beside a wall is 16 units from it, where the 64-wide box doesn't fit
    for (const point of path.slice(1, -1)) {
      assert.equal(traceBoxWorld(CORRIDOR_WORLD, point, LARGE_BOX.mins, LARGE_BOX.maxs, point).startsolid, false, `${point}`);
    }
  });

  void test('without a box the path is the player\'s, through the narrow corridor', () => {
    const path = navigation.findPath(new Vector(96, 48, 24), new Vector(480, 48, 24), Navigation.hullFor(null));

    assert.ok(path !== null);
    assert.ok(throughNarrowCorridor(path));
  });

  void test('a gap in the floor too wide for a monster\'s box to stand over stops monsters, not players', async () => {
    // e1m1 has one, 24 wide: the walker's box spans it, QuakeC's checkBottom refuses a step with a corner over it
    const gapWorld: readonly Solid[] = [
      [[-64, -64, -64], [200, 192, 0]],
      [[224, -64, -64], [488, 192, 0]],
    ];
    const gapNavigation = await buildBoxWorldNavigation(gapWorld, [[0, 0, 200, 128], [224, 0, 424, 128]]);
    const start = new Vector(100, 64, 24);
    const goal = new Vector(324, 64, 24);

    assert.ok(gapNavigation.findPath(start, goal, Navigation.hullFor(null)) !== null);
    assert.equal(gapNavigation.findPath(start, goal, Navigation.hullFor(SMALL_BOX)), null);
  });
});

void describe('Navigation.findPath (teleporters)', () => {
  // Two closed rooms, x 0…192 and 384…576, a teleporter in the first one leads into the second.
  const TWO_ROOMS: readonly Solid[] = [...ENCLOSED_FLOOR, [[192, -64, 0], [384, 384, 256]]];
  const TWO_ROOM_FLOORS: readonly FloorRectangle[] = [[0, 0, 192, 320], [384, 0, 576, 320]];
  const SMALL_BOX = { mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 40) };
  const START = new Vector(96, 64, 24);
  const GOAL = new Vector(480, 64, 24);

  /**
   * Builds the two rooms with a teleporter between them.
   * @returns The navigation with its graph.
   */
  function buildWithTeleporter(spawnflags: number, targetname?: string): Promise<Navigation> {
    return buildBoxWorldNavigation(TWO_ROOMS, TWO_ROOM_FLOORS, [
      {
        classname: 'trigger_teleport',
        centerPoint: new Vector(96, 240, 56),
        mins: new Vector(-32, -32, -56),
        maxs: new Vector(32, 32, 56),
        target: 'there',
        targetname,
        spawnflags,
      },
      {
        classname: 'info_teleport_destination',
        centerPoint: new Vector(480, 240, 24),
        mins: new Vector(),
        maxs: new Vector(),
        targetname: 'there',
      },
    ]);
  }

  void test('a monster walks through a teleporter that takes monsters', async () => {
    const navigation = await buildWithTeleporter(0);

    assert.ok(navigation.findPath(START, GOAL, Navigation.hullFor(SMALL_BOX)) !== null);
  });

  void test('a monster gets no path through a player-only teleporter, a player does', async () => {
    // e1m2 has two: monsters walked into them and stood there, the trigger ignoring them
    const navigation = await buildWithTeleporter(1);

    assert.ok(navigation.findPath(START, GOAL, Navigation.hullFor(null)) !== null);
    assert.equal(navigation.findPath(START, GOAL, Navigation.hullFor(SMALL_BOX)), null);
  });

  void test('a monster gets no path through a teleporter that only works once it was fired', async () => {
    const navigation = await buildWithTeleporter(0, 'switched-on-later');

    assert.equal(navigation.findPath(START, GOAL, Navigation.hullFor(SMALL_BOX)), null);
  });
});

void describe('Navigation.hullFor', () => {
  void test('picks the smallest hull whose box encloses the monster', () => {
    assert.equal(Navigation.hullFor(null), NavigationHull.PLAYER);
    // a zombie or knight, Quake's hull 1
    assert.equal(Navigation.hullFor({ mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 40) }), NavigationHull.SMALL);
    // a fish-sized box still walks the walker's links
    assert.equal(Navigation.hullFor({ mins: new Vector(-8, -8, 0), maxs: new Vector(8, 8, 16) }), NavigationHull.SMALL);
    // a shambler, wider than the walker
    assert.equal(Navigation.hullFor({ mins: new Vector(-32, -32, -24), maxs: new Vector(32, 32, 64) }), NavigationHull.LARGE);
    // as wide as the walker but taller
    assert.equal(Navigation.hullFor({ mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 64) }), NavigationHull.LARGE);
  });
});

// Load test_e1m1.nav once for all in-game regression tests.
const navFileBytes = readFileSync(new URL('../../data/id1/maps/test_e1m1.nav', import.meta.url));
const navFileBuffer = navFileBytes.buffer.slice(navFileBytes.byteOffset, navFileBytes.byteOffset + navFileBytes.byteLength);

void describe('Navigation.findPath (test_e1m1.nav — in-game path regression)', () => {
  let navigation: Navigation;

  before(async () => {
    navigation = new Navigation(null, mockedNavigationServices());
    Navigation.nav_debug_path = createCvarStub(0);
    Navigation.nav_debug_graph = createCvarStub(0);
    Navigation.nav_debug_waypoints = createCvarStub(0);

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

void describe('Navigation.load (outdated meshes)', () => {
  void test('treats a mesh of another file version as out of date, so it is rebuilt', async () => {
    const navigation = new Navigation(null, { ...mockedNavigationServices(), sv: null });
    const olderMesh = navFileBuffer.slice(0);

    // The version follows the four bytes of the magic.
    new DataView(olderMesh).setUint32(4, 2, true);

    await withNavigationRegistry({
      COM: { LoadFile: () => Promise.resolve(olderMesh) },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {},
    }, async () => {
      await assert.rejects(navigation.load('test_e1m1', 5874), (error: Error) => error instanceof NavMeshOutOfDateException && /version 2/.test(error.message));
    });
  });

  void test('treats a mesh of another map build as out of date', async () => {
    const navigation = new Navigation(null, { ...mockedNavigationServices(), sv: null });

    await withNavigationRegistry({
      COM: { LoadFile: () => Promise.resolve(navFileBuffer) },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {},
    }, async () => {
      await assert.rejects(navigation.load('test_e1m1', 1234), NavMeshOutOfDateException);
    });
  });
});

void describe('Navigation.rebuildOutdated', () => {
  void test('rebuilds once per map, so a mesh that still does not reach the worker cannot loop', async () => {
    const navigation = new Navigation(createNavigationWorldModel(), mockedNavigationServices());
    const build = mock.method(navigation, 'build', () => {});

    await withNavigationRegistry({
      COM: {},
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: {},
    }, () => {
      navigation.rebuildOutdated();
      navigation.rebuildOutdated();
    });

    assert.equal(build.mock.callCount(), 1);
  });
});

void describe('Navigation.save', () => {
  void test('keeps the mesh as a generated file', async () => {
    const worldmodel = createNavigationWorldModel();
    const navigation = new Navigation(worldmodel, mockedNavigationServices());
    const written: string[] = [];

    await withNavigationRegistry({
      COM: {
        WriteGeneratedFile(filename: string) {
          written.push(filename);
          return Promise.resolve(true);
        },
      },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: { server: { mapname: 'nav-test', worldmodel } },
    }, async () => {
      await navigation.save();
    });

    assert.deepEqual(written, ['maps/nav-test.nav']);
  });

  void test('fails without telling the worker to load when the mesh could not be stored', async () => {
    const worldmodel = createNavigationWorldModel();
    const navigation = new Navigation(worldmodel, mockedNavigationServices());
    const loads: string[] = [];

    await withNavigationRegistry({
      COM: { WriteGeneratedFile: () => Promise.resolve(false) },
      Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
      SV: { server: { mapname: 'nav-test', worldmodel } },
    }, async () => {
      const unsubscribe = eventBus.subscribe('nav.load', (mapname) => { loads.push(mapname); });

      try {
        await assert.rejects(navigation.save(), /could not write maps\/nav-test\.nav/);
      } finally {
        unsubscribe();
      }
    });

    assert.deepEqual(loads, []);
  });
});

void describe('Navigation.load on the worker thread', () => {
  void test('does not touch the debug variables, which only the server thread registers', async () => {
    const debugCvars = { nav_debug_path: Navigation.nav_debug_path, nav_debug_graph: Navigation.nav_debug_graph, nav_debug_waypoints: Navigation.nav_debug_waypoints };

    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const services = { ...mockedNavigationServices(), sv: null };
      const navigation = new Navigation(null, services);

      Navigation.nav_debug_path = null;
      Navigation.nav_debug_graph = null;
      Navigation.nav_debug_waypoints = null;

      await withNavigationRegistry({
        COM: { LoadFile: () => Promise.resolve(navFileBuffer) },
        Con: { DPrint() {}, PrintWarning() {}, PrintSuccess() {}, PrintError() {} },
        SV: {},
      }, async () => {
        await navigation.load('test_e1m1', 5874);
      });

      assert.doesNotThrow(() => { mock.timers.tick(2000); });
    } finally {
      mock.timers.reset();
      // timers of earlier tests are still pending and read these
      Object.assign(Navigation, debugCvars);
    }
  });
});
