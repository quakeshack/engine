import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import { Navigation } from '../../source/engine/server/Navigation.mjs';

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

describe('Navigation.build', () => {
  test('uses monster-sized static-world traces and stores stand origins', async () => {
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
    Navigation.nav_save_waypoints = { value: 0 };
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

  test('clears previously extracted surfaces before rebuilding', async () => {
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
    Navigation.nav_save_waypoints = { value: 0 };
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

  test('does not collapse a large walkable region into a single node', async () => {
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
    Navigation.nav_save_waypoints = { value: 0 };
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

  test('rejects walkable samples that lack monster-style corner support', async () => {
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
    Navigation.nav_save_waypoints = { value: 0 };
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

  test('does not persist extracted waypoints into nav files', async () => {
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
    Navigation.nav_save_waypoints = { value: 1 };
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
});
