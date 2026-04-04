// import sampleBSpline from '../../shared/BSpline.ts';
import * as Def from '../../shared/Defs.ts';
import { Octree, type OctreeNode } from '../../shared/Octree.ts';
import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.ts';
// import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { CorruptedResourceError, MissingResourceError } from '../common/Errors.ts';
import { ServerEngineAPI } from '../common/GameAPIs.ts';
import type { BrushModel } from '../common/Mod.ts';
import { MIN_STEP_NORMAL, STEPSIZE } from '../common/Pmove.ts';
import type { Face } from '../common/model/BaseModel.ts';
import type PlatformWorker from '../common/PlatformWorker.ts';
import WorkerManager from '../common/WorkerManager.ts';
import { eventBus, registry } from '../registry.ts';
import type { BaseEntity, ServerEdict } from './Edict.ts';
import type { CollisionTrace } from './physics/ServerCollisionSupport.ts';

type VectorTuple = [number, number, number];
type PlanePoint = [number, number];
type WorkerVectorLike = Vector | VectorTuple;
type WorkerPath = WorkerVectorLike[] | null;
type NeighborLink = [id: number, cost: number, temporaryCostAdjustment: number];
type SerializedWaypoint = [origin: VectorTuple, availableHeight: number, nearLedge: boolean, isClipping: boolean, isFloating: boolean];
type SerializedWalkableSurface = [stability: number, normal: VectorTuple, faceIndex: number, waypoints: SerializedWaypoint[]];
type SerializedNode = [
  id: number,
  origin: VectorTuple,
  availableHeight: number,
  nearLedge: boolean,
  isClipping: boolean,
  isFloating: boolean,
  surfaces: SerializedWalkableSurface[],
  neighbors: NeighborLink[],
];
type PathRequestResolver = (path: Vector[] | null) => void;
type EventUnsubscribe = (() => void) | null;
type TimeoutHandle = ReturnType<typeof setTimeout>;

interface NavigationGraph {
  readonly nodes: Node[];
  octree: Octree<Node> | null;
}

interface NavigationGeometry {
  walkableSurfaces: WalkableSurface[];
}

interface TraversalResult {
  readonly ok: boolean;
  readonly reason: string;
}

interface WaypointGroupItem {
  readonly wp: Waypoint;
  readonly surface: WalkableSurface;
  readonly index: number;
}

interface WaypointGroup {
  seedOrigin: Vector;
  items: WaypointGroupItem[];
}

interface DebugPoint {
  readonly origin: Vector;
  readonly color: number;
  readonly surface: WalkableSurface;
}

interface ServerEntity extends BaseEntity {
  readonly centerPoint: Vector;
  target?: string | null;
  targetname?: string | null;
}

/**
 * Converts a vector to a serializable tuple.
 * @returns The vector components as a tuple.
 */
function vectorToTuple(vector: Vector): VectorTuple {
  return [vector[0], vector[1], vector[2]];
}

let { CL, COM, Con, R, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, R, SV } = registry);
});

class Waypoint {
  origin: Vector = new Vector();
  /** available clearance on the Z-axis */
  availableHeight = Infinity; // space above the waypoint that is free
  /** whether waypoint is near a ledge */
  nearLedge = false;
  /** whether waypoint is intersection something solid */
  isClipping = false;
  /** whether the point is sitting in the air */
  isFloating = false;

  /**
   * Creates a sampled waypoint on a walkable surface.
   */
  constructor(origin: Vector) {
    this.origin.set(origin);
  }

  serialize(): SerializedWaypoint {
    return [
      vectorToTuple(this.origin),
      this.availableHeight,
      this.nearLedge,
      this.isClipping,
      this.isFloating,
    ];
  }

  static deserialize(data: SerializedWaypoint): Waypoint {
    const wp = new Waypoint(new Vector(...data[0]));
    wp.availableHeight = data[1];
    wp.nearLedge = data[2];
    wp.isClipping = data[3];
    wp.isFloating = data[4];
    return wp;
  }
}

class WalkableSurface {
  /** dot product of downwards and plane’s normal, e.g. 1 = flat, down to ~0.7 = slope */
  stability = 0;
  /** surface’s normal vector. */
  normal: Vector = new Vector();
  face: Face;
  readonly faceIndex: number;
  waypoints: Waypoint[] = [];

  /**
   * Creates a walkable-face wrapper used during nav extraction.
   */
  constructor(face: Face, index: number) {
    this.face = face;
    this.faceIndex = index;
  }

  serialize(): SerializedWalkableSurface {
    return [
      this.stability,
      vectorToTuple(this.normal),
      this.faceIndex,
      this.waypoints.map((wp) => wp.serialize()),
    ];
  }

  static deserialize(data: SerializedWalkableSurface, navigation: Navigation): WalkableSurface {
    const faceIndex = data[2];
    const face = navigation.worldmodel?.faces[faceIndex];

    console.assert(face, 'Navigation requires a worldmodel when deserializing surfaces');

    const surface = new WalkableSurface(face, faceIndex);
    surface.stability = data[0];
    surface.normal = new Vector(...data[1]);
    surface.waypoints = data[3].map((wpData) => Waypoint.deserialize(wpData));
    return surface;
  }
};

/**
 * Navigation graph node
 */
class Node {
  id = -1;
  origin: Vector = new Vector();
  absmin: Vector | null = null;
  absmax: Vector | null = null;
  octreeNode: OctreeNode<Node> | null = null;
  availableHeight = 0; // average available height from all waypoints
  nearLedge = false;
  isClipping = false;
  isFloating = false;
  surfaces: Set<WalkableSurface> = new Set();
  /** list of [id, cost, temporary cost adjustment]. */
  neighbors: NeighborLink[] = [];

  /**
   * Creates a graph node representing one merged walkable region.
   */
  constructor(id: number, origin: Vector) {
    this.id = id;
    this.origin.set(origin);
  }

  serialize(): SerializedNode {
    return [
      this.id,
      vectorToTuple(this.origin),
      this.availableHeight,
      this.nearLedge,
      this.isClipping,
      this.isFloating,
      Array.from(this.surfaces).map((s) => s.serialize()),
      this.neighbors.slice(),
    ];
  }

  /**
   * Rebuilds a node from nav-file data.
   * @returns The reconstructed navigation node.
   */
  static deserialize(data: SerializedNode, _navigation: Navigation): Node {
    const node = new Node(data[0], new Vector(...data[1]));

    node.availableHeight = data[2];
    node.nearLedge = data[3];
    node.isClipping = data[4];
    node.isFloating = data[5];
    // node.surfaces = new Set(data[6].map((id) => WalkableSurface.deserialize(id, navigation)));
    node.neighbors = data[7].slice();

    return node;
  }
}

/**
 * Binary min-heap keyed by fScore for efficient A* open-set extraction.
 */
class MinHeap {
  /** node IDs stored in heap order. */
  #data: number[] = [];
  /** fScore reference, indexed by node ID. */
  #keys: Float64Array;
  /** heap index of each node ID (-1 = not in heap). */
  #index: Int32Array;

  /**
   * Creates the A* open-set heap for a bounded node count.
   */
  constructor(capacity: number) {
    this.#keys = new Float64Array(capacity).fill(Infinity);
    this.#index = new Int32Array(capacity).fill(-1);
  }

  /**
   * Returns the number of queued node IDs.
   * @returns The current heap size.
   */
  get size(): number {
    return this.#data.length;
  }

  /**
   * Insert or update a node's priority.
   */
  pushOrDecrease(id: number, priority: number): void {
    this.#keys[id] = priority;

    if (this.#index[id] !== -1) {
      this.#bubbleUp(this.#index[id]);
      return;
    }

    this.#data.push(id);
    this.#index[id] = this.#data.length - 1;
    this.#bubbleUp(this.#data.length - 1);
  }

  /**
   * Extract the node with the smallest fScore.
   * @returns The node ID with the smallest priority.
   */
  pop(): number {
    const top = this.#data[0]!;
    const last = this.#data.pop()!;

    this.#index[top] = -1;

    if (this.#data.length > 0) {
      this.#data[0] = last;
      this.#index[last] = 0;
      this.#sinkDown(0);
    }

    return top;
  }

  /**
   * Bubbles a node up until the heap invariant is restored.
   */
    #bubbleUp(i: number): void {
    const data = this.#data;
    const keys = this.#keys;
    const idx = this.#index;

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (keys[data[i]] >= keys[data[parent]]) {
        break;
      }

      const tmp = data[i];
      data[i] = data[parent];
      data[parent] = tmp;
      idx[data[i]] = i;
      idx[data[parent]] = parent;
      i = parent;
    }
  }

  /**
   * Sinks a node down until the heap invariant is restored.
   */
    #sinkDown(i: number): void {
    const data = this.#data;
    const keys = this.#keys;
    const idx = this.#index;
    const n = data.length;

    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;

      if (left < n && keys[data[left]] < keys[data[smallest]]) {
        smallest = left;
      }

      if (right < n && keys[data[right]] < keys[data[smallest]]) {
        smallest = right;
      }

      if (smallest === i) {
        break;
      }

      const tmp = data[i];
      data[i] = data[smallest];
      data[smallest] = tmp;
      idx[data[i]] = i;
      idx[data[smallest]] = smallest;
      i = smallest;
    }
  }
}

export class NavMeshOutOfDateException extends CorruptedResourceError {}

// TODO: in future we could build graphs per entity type (e.g. monster navmesh with tighter clearances, flying monster navmesh that ignores ground support, etc.)

const NAV_FILE_VERSION = 3;
const NAV_MONSTER_MINS = new Vector(-16.0, -16.0, -24.0);
const NAV_MONSTER_MAXS = new Vector(16.0, 16.0, 40.0);
const NAV_LINK_STEP_DISTANCE = 8.0;

export class Navigation {
  static nav_save_waypoints: Cvar | null = null;
  static nav_debug_waypoints: Cvar | null = null;
  static nav_debug_graph: Cvar | null = null;
  static nav_debug_path: Cvar | null = null;
  /** unavailable outside of the dedicated server. */
  static nav_build_process: Cvar | null = null;

  /** maximum slope that is passable */
  readonly maxSlope = MIN_STEP_NORMAL;
  readonly walkerMins: Vector = NAV_MONSTER_MINS.copy();
  readonly walkerMaxs: Vector = NAV_MONSTER_MAXS.copy();
  /** units of headroom required above waypoint */
  requiredHeight = NAV_MONSTER_MAXS[2] - NAV_MONSTER_MINS[2];
  requiredRadius = Math.max(
    NAV_MONSTER_MAXS[0],
    NAV_MONSTER_MAXS[1],
    -NAV_MONSTER_MINS[0],
    -NAV_MONSTER_MINS[1],
  );

  /** holds pending requests for the worker thread. */
  #requests: Record<string, PathRequestResolver> = {};

  /** worker thread handling navigation lookups. */
  #worker: PlatformWorker | null = null;

  /** unsubscribe from nav.path.request. */
  #pathRequestEventListener: EventUnsubscribe = null;

  /** unsubscribe from nav.path.response. */
  #pathResponseEventListener: EventUnsubscribe = null;

  /** unsubscribe from nav_debug_graph changes. */
  #debugGraphEventListener: EventUnsubscribe = null;

  /** unsubscribe from nav_debug_waypoints changes. */
  #debugWaypointsEventListener: EventUnsubscribe = null;

  worldmodel: BrushModel | null;
  graph: NavigationGraph;
  geometry: NavigationGeometry;

  relinkEdictCooldown: Record<number, TimeoutHandle> = {};
  relinkEdictLinks: Record<number, Node> = {};
  relinkSkiplist: Set<number> = new Set();

  /**
   * Creates a navigation graph builder/runtime for a worldmodel.
   */
  constructor(worldmodel: BrushModel | null) {
    this.worldmodel = worldmodel;
    this.graph = {
      nodes: [],
      octree: null,
    };

    this.geometry = {
      walkableSurfaces: [],
    };
  }

  static Init(): void {
    if (registry.isDedicatedServer) {
      this.nav_build_process = new Cvar('nav_build_process', '0', Cvar.FLAG.NONE, 'if set to 1, it will force build the nav mesh and quit');
    }

    this.nav_save_waypoints = new Cvar('nav_save_waypoints', '0', Cvar.FLAG.NONE, 'deprecated, extracted waypoints stay in memory and are not written to nav files');
    this.nav_debug_graph = new Cvar('nav_debug_graph', '0', Cvar.FLAG.NONE, 'if set to 1, will render the navigation graph for debugging');
    this.nav_debug_waypoints = new Cvar('nav_debug_waypoints', '0', Cvar.FLAG.NONE, 'if set to 1, will render all waypoints for debugging');
    this.nav_debug_path = new Cvar('nav_debug_path', '0', Cvar.FLAG.NONE | Cvar.FLAG.CHEAT, 'if set to 1, will render the last computed path for debugging');

    // worker thread -> main thread: mesh probably out of date
    eventBus.subscribe('nav.build', (): void => {
      if (SV.server.navigation) {
        SV.server.navigation.build();
      }
    });

    eventBus.subscribe('nav.debug.emit-dot.temporarily', (position: WorkerVectorLike, color: number, ttl: number): void => {
      this.#emitDotFrontend(new Vector(...position), color, ttl);
    });

    eventBus.subscribe('nav.debug.emit-dot.permanently', (position: WorkerVectorLike, color: number): void => {
      this.#emitDotFrontend(new Vector(...position), color, Infinity);
    });
  }

  #initWorker(): void {
    this.#worker = WorkerManager.SpawnWorker('server/NavigationWorker.ts', [
      'nav.load',
      'nav.path.request',
    ]);
  }

  #shutdownWorker(): void {
    if (this.#worker) {
      this.#worker.shutdown().catch((err) => {
        Con.PrintError(`Failed to shutdown the navigation worker: ${err}\n`);
      });

      this.#worker = null;
    }
  }

  #subscribePathResponse(): void {
    this.#pathResponseEventListener = eventBus.subscribe('nav.path.response', (id: string, path: WorkerPath): void => {
      const vecpath = path ? path.map((point) => new Vector(...point)) : null;

      if (vecpath && Navigation.nav_debug_path?.value) {
        this.#debugPath(vecpath);
      }

      // since all events are global, we need to check what’s intended for us
      if (id in this.#requests) {
        this.#requests[id](vecpath);
        delete this.#requests[id];
      }
    });
  }

  #subscribeDebugCvars(): void {
    this.#debugGraphEventListener = eventBus.subscribe('cvar.changed.nav_debug_graph', (cvar: Cvar): void => {
      if (cvar.value !== 0) {
        this.#scheduleDebugRefresh();
      }
    });

    this.#debugWaypointsEventListener = eventBus.subscribe('cvar.changed.nav_debug_waypoints', (cvar: Cvar): void => {
      if (cvar.value !== 0) {
        this.#scheduleDebugRefresh();
      }
    });
  }

  #scheduleDebugRefresh(): void {
    if (!R) {
      return;
    }

    setTimeout((): void => {
      this.#debugWaypoints();
      this.#debugNavigation();
    }, 1000);
  }

  init(): void {
    Con.DPrint('Navigation: initializing navigation graph...\n');

    if (Navigation.nav_build_process?.value) {
      this.build();
    }

    this.#initWorker();
    this.#subscribePathResponse();
    this.#subscribeDebugCvars();
    eventBus.publish('nav.load', SV.server.mapname, SV.server.worldmodel.checksum);
  }

  shutdown(): void {
    for (const timeout of Object.values(this.relinkEdictCooldown)) {
      clearTimeout(timeout);
    }

    this.#shutdownWorker();

    if (this.#pathRequestEventListener) {
      this.#pathRequestEventListener();
      this.#pathRequestEventListener = null;
    }

    if (this.#pathResponseEventListener) {
      this.#pathResponseEventListener();
      this.#pathResponseEventListener = null;
    }

    if (this.#debugGraphEventListener) {
      this.#debugGraphEventListener();
      this.#debugGraphEventListener = null;
    }

    if (this.#debugWaypointsEventListener) {
      this.#debugWaypointsEventListener();
      this.#debugWaypointsEventListener = null;
    }

    Con.DPrint('Navigation: shutdown complete.\n');
  }

  async load(mapname: string, expectedChecksum: number | null = null): Promise<void> {
    console.assert(this.worldmodel || expectedChecksum, 'Navigation: worldmodel or expectedChecksum is required');

    const filename = `maps/${mapname}.nav`;

    this.graph.nodes.length = 0;
    this.graph.octree = null;
    this.relinkSkiplist.clear();

    // Try to load binary file first (ArrayBuffer). Fallback to text JSON for older files.
    const buf = await COM.LoadFile(filename);

    if (!buf) {
      throw new MissingResourceError(filename);
    }

    const dv = new DataView(buf);
    let off = 0;

    const readBytes = (n: number): Uint8Array => {
      const out = new Uint8Array(buf, off, n);
      off += n;
      return out;
    };

    const readUint8 = (): number => dv.getUint8(off++);
    const readUint32 = (): number => {
      const value = dv.getUint32(off, true);
      off += 4;
      return value;
    };
    const readInt32 = (): number => {
      const value = dv.getInt32(off, true);
      off += 4;
      return value;
    };
    const readFloat32 = (): number => {
      const value = dv.getFloat32(off, true);
      off += 4;
      return value;
    };

    // magic: 4 bytes
    const magic = String.fromCharCode(...readBytes(4));
    if (magic !== 'QSNM') {
      throw new CorruptedResourceError(filename, 'invalid binary magic');
    }

    const version = readUint32();
    if (version !== NAV_FILE_VERSION) {
      throw new CorruptedResourceError(filename, 'invalid binary version');
    }

    // worldmodel name (uint16 length + utf8 bytes)
    const nameLen = dv.getUint16(off, true); off += 2;
    const nameBytes = readBytes(nameLen);
    const worldName = new TextDecoder().decode(nameBytes);

    const checksum = readUint32();
    const requiredHeight = readFloat32();
    const requiredRadius = readFloat32();

    if (worldName !== mapname) {
      throw new CorruptedResourceError(filename, 'wrong map');
    }

    if (expectedChecksum !== null) {
      if (checksum !== expectedChecksum) {
        throw new NavMeshOutOfDateException(filename, 'outdated map');
      }
    } else if (checksum !== this.worldmodel.checksum) {
      throw new NavMeshOutOfDateException(filename, 'outdated map');
    }

    if (requiredHeight !== this.requiredHeight || requiredRadius !== this.requiredRadius) {
      throw new NavMeshOutOfDateException(filename, 'configuration changed');
    }

    // relink skiplist
    const relinkCount = readUint32();
    for (let i = 0; i < relinkCount; i++) {
      this.relinkSkiplist.add(readUint32());
    }

    // nodes
    const nodeCount = readUint32();
    for (let ni = 0; ni < nodeCount; ni++) {
      const id = readInt32();
      const ox = readFloat32(); const oy = readFloat32(); const oz = readFloat32();
      const node = new Node(id, new Vector(ox, oy, oz));
      node.availableHeight = readFloat32();
      node.nearLedge = !!readUint8();
      node.isClipping = !!readUint8();
      node.isFloating = !!readUint8();

      // surfaces (optional)
      const surfCount = readUint32();
      if (surfCount > 0) {
        for (let si = 0; si < surfCount; si++) {
          readFloat32();
          readFloat32(); readFloat32(); readFloat32();
          readUint32();
          const wpCount = readUint32();
          for (let wi = 0; wi < wpCount; wi++) {
            readFloat32(); readFloat32(); readFloat32();
            readFloat32();
            readUint8();
            readUint8();
            readUint8();
          }
        }
      }

      // neighbors
      const nbCount = readUint32();
      const nbs: NeighborLink[] = [];
      for (let k = 0; k < nbCount; k++) {
        const nid = readInt32();
        const cost = readFloat32();
        const adj = readFloat32();
        nbs.push([nid, cost, adj]);
      }
      node.neighbors = nbs;

      this.graph.nodes.push(node);
    }

    this.#buildOctree();
    this.#scheduleDebugRefresh();
  }

  async save(): Promise<void> {
    console.assert(Boolean(this.worldmodel), 'Navigation: worldmodel is required');

    const filename = `maps/${SV.server.mapname}.nav`;

    const bytes: number[] = [];
    const tmp = new ArrayBuffer(8);
    const tdv = new DataView(tmp);

    const pushUint8 = (value: number): void => { bytes.push(value & 0xff); };
    const pushUint16 = (value: number): void => { bytes.push(value & 0xff); bytes.push((value >>> 8) & 0xff); };
    const pushUint32 = (value: number): void => {
      bytes.push(value & 0xff);
      bytes.push((value >>> 8) & 0xff);
      bytes.push((value >>> 16) & 0xff);
      bytes.push((value >>> 24) & 0xff);
    };
    const pushInt32 = (value: number): void => pushUint32(value >>> 0);
    const pushFloat32 = (value: number): void => {
      tdv.setFloat32(0, value, true);
      const byteView = new Uint8Array(tmp, 0, 4);
      bytes.push(byteView[0], byteView[1], byteView[2], byteView[3]);
    };
    const pushBytes = (values: Uint8Array): void => {
      for (let i = 0; i < values.length; i++) {
        bytes.push(values[i]);
      }
    };

    // header magic
    pushBytes(new TextEncoder().encode('QSNM'));
    pushUint32(NAV_FILE_VERSION);

    // world name
    const nameBytes = new TextEncoder().encode(SV.server.mapname);
    pushUint16(nameBytes.length);
    pushBytes(nameBytes);

    pushUint32(this.worldmodel.checksum);
    pushFloat32(this.requiredHeight);
    pushFloat32(this.requiredRadius);

    // relink skiplist
    pushUint32(this.relinkSkiplist.size);
    for (const v of this.relinkSkiplist) {
      pushUint32(v);
    }

    // nodes
    pushUint32(this.graph.nodes.length);
    for (const n of this.graph.nodes) {
      pushInt32(n.id);
      pushFloat32(n.origin[0]); pushFloat32(n.origin[1]); pushFloat32(n.origin[2]);
      pushFloat32(n.availableHeight);
      pushUint8(n.nearLedge ? 1 : 0);
      pushUint8(n.isClipping ? 1 : 0);
      pushUint8(n.isFloating ? 1 : 0);

      // waypoints are build-only debug data and are intentionally not serialized
      pushUint32(0);

      // neighbors
      pushUint32(n.neighbors.length);
      for (const nb of n.neighbors) {
        pushInt32(nb[0]);
        pushFloat32(nb[1]);
        pushFloat32(nb[2]);
      }
    }

    const out = new Uint8Array(bytes);
    await COM.WriteFile(filename, out, out.length);

    // Keep the worker in sync after every successful rebuild, including listen-server sessions.
    eventBus.publish('nav.load', SV.server.mapname, this.worldmodel.checksum);
  }

  #newWalkerStandOffset(): Vector {
    return new Vector(0, 0, -this.walkerMins[2]);
  }

  /**
   * Returns whether the player-sized walker fits at the given stand origin.
   * @returns True when the walker box does not start in solid.
   */
  #isValidStandOrigin(position: Vector): boolean {
    const trace = SV.collision.traceStaticWorld(
      position.copy(),
      this.walkerMins,
      this.walkerMaxs,
      position.copy(),
    );

    return !trace.startsolid && !trace.allsolid;
  }

  /**
   * Traces the player-sized walker through the static world.
   * @returns The resulting static-world collision trace.
   */
  #traceWalkerStatic(startpos: Vector, endpos: Vector): CollisionTrace {
    return SV.collision.traceStaticWorld(
      startpos.copy(),
      this.walkerMins,
      this.walkerMaxs,
      endpos.copy(),
    );
  }

  /**
   * Returns whether the walker has enough floor support at the stand origin.
   * @returns True when the walker can stand on the sampled floor.
   */
  #hasGroundSupport(position: Vector): boolean {
    const mins = position.copy().add(this.walkerMins);
    const maxs = position.copy().add(this.walkerMaxs);

    const allCornersSolid =
      SV.collision.pointContents(new Vector(mins[0], mins[1], mins[2] - 1.0)) === Def.content.CONTENT_SOLID
      && SV.collision.pointContents(new Vector(mins[0], maxs[1], mins[2] - 1.0)) === Def.content.CONTENT_SOLID
      && SV.collision.pointContents(new Vector(maxs[0], mins[1], mins[2] - 1.0)) === Def.content.CONTENT_SOLID
      && SV.collision.pointContents(new Vector(maxs[0], maxs[1], mins[2] - 1.0)) === Def.content.CONTENT_SOLID;

    if (allCornersSolid) {
      return true;
    }

    const start = position.copy().add(new Vector(0.0, 0.0, this.walkerMins[2] + 1.0));
    const stop = start.copy().add(new Vector(0.0, 0.0, -2.0 * STEPSIZE));

    let trace = SV.collision.move(start, Vector.origin, Vector.origin, stop, Def.moveTypes.MOVE_NOMONSTERS, null);

    if (trace.fraction === 1.0) {
      return false;
    }

    let bottom = trace.endpos[2];
    const mid = bottom;

    for (let x = 0; x <= 1; x++) {
      for (let y = 0; y <= 1; y++) {
        start[0] = stop[0] = x !== 0 ? maxs[0] : mins[0];
        start[1] = stop[1] = y !== 0 ? maxs[1] : mins[1];

        trace = SV.collision.move(start, Vector.origin, Vector.origin, stop, Def.moveTypes.MOVE_NOMONSTERS, null);

        if (trace.fraction !== 1.0 && trace.endpos[2] > bottom) {
          bottom = trace.endpos[2];
        }

        if (trace.fraction === 1.0 || (mid - trace.endpos[2]) > STEPSIZE) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Measures the free vertical space above a stand origin.
   * @returns The available vertical distance before colliding overhead.
   */
  #measureAvailableHeight(position: Vector, probeHeight = this.requiredHeight): number {
    const trace = this.#traceWalkerStatic(position, position.copy().add(new Vector(0, 0, probeHeight)));
    return Math.max(0.0, trace.endpos[2] - position[2]);
  }

  /**
   * Returns a point on the surface plane.
   * @returns A point lying on the given surface plane.
   */
  #getSurfacePoint(surface: WalkableSurface): Vector {
    const surfedge = this.worldmodel.surfedges[surface.face.firstedge];

    if (surfedge > 0) {
      return new Vector().set(this.worldmodel.vertexes[this.worldmodel.edges[surfedge][0]]);
    }

    return new Vector().set(this.worldmodel.vertexes[this.worldmodel.edges[-surfedge][1]]);
  }

  /**
   * Projects a world point onto the supporting surface plane.
   * @returns The projected point on the target surface.
   */
  #projectPointOntoSurface(point: Vector, surface: WalkableSurface): Vector {
    const surfacePoint = this.#getSurfacePoint(surface);
    const pointToSurface = point.copy().subtract(surfacePoint);
    const distanceToPlane = pointToSurface.dot(surface.normal);

    return point.copy().subtract(surface.normal.copy().multiply(distanceToPlane));
  }

  /**
   * Projects a stand origin back onto the supporting surface plane.
   * @returns The projected stand origin.
   */
  #projectStandOriginOntoSurface(standOrigin: Vector, surface: WalkableSurface): Vector {
    const floorPoint = standOrigin.copy();
    floorPoint[2] += this.walkerMins[2];

    return this.#projectPointOntoSurface(floorPoint, surface).add(this.#newWalkerStandOffset());
  }

  /**
   * Offsets a stand origin along a surface plane.
   * @returns The offset stand origin following the surface plane.
   */
  #offsetStandOrigin(origin: Vector, surface: WalkableSurface, x: number, y: number): Vector {
    const floorPoint = origin.copy();
    floorPoint[2] += this.walkerMins[2];
    floorPoint[0] += x;
    floorPoint[1] += y;

    return this.#projectPointOntoSurface(floorPoint, surface).add(this.#newWalkerStandOffset());
  }

  /**
   * Evaluates whether a walker can traverse between two stand origins.
   * @returns The traversal decision and failure reason.
   */
  #evaluateTraversalBetween(startOrigin: Vector, endOrigin: Vector): TraversalResult {
    if (!this.#isValidStandOrigin(startOrigin)) {
      return { ok: false, reason: 'start-fit' };
    }

    if (!this.#isValidStandOrigin(endOrigin)) {
      return { ok: false, reason: 'end-fit' };
    }

    if (!this.#hasGroundSupport(startOrigin) || !this.#hasGroundSupport(endOrigin)) {
      return {
        ok: false,
        reason: !this.#hasGroundSupport(startOrigin) ? 'start-support' : 'end-support',
      };
    }

    const delta = endOrigin.copy().subtract(startOrigin);
    delta[2] = 0.0;

    const totalDistance = delta.len();

    if (totalDistance === 0.0) {
      return {
        ok: Math.abs(endOrigin[2] - startOrigin[2]) <= STEPSIZE,
        reason: 'same-spot',
      };
    }

    const stepDistance = Math.min(NAV_LINK_STEP_DISTANCE, totalDistance);
    const direction = delta.copy().multiply(1.0 / totalDistance);
    let previousOrigin = startOrigin;

    for (let travelled = stepDistance; travelled < totalDistance; travelled += stepDistance) {
      const t = travelled / totalDistance;
      const sampleOrigin = startOrigin.copy().add(direction.copy().multiply(travelled));
      sampleOrigin[2] = startOrigin[2] + (endOrigin[2] - startOrigin[2]) * t;

      if (Math.abs(sampleOrigin[2] - previousOrigin[2]) > STEPSIZE + 1.0) {
        return { ok: false, reason: 'height-mismatch' };
      }

      if (!this.#isValidStandOrigin(sampleOrigin)) {
        return { ok: false, reason: 'step-fit' };
      }

      if (!this.#hasGroundSupport(sampleOrigin)) {
        return { ok: false, reason: 'step-support' };
      }

      previousOrigin = sampleOrigin;
    }

    if (Math.abs(endOrigin[2] - previousOrigin[2]) > STEPSIZE + 1.0) {
      return { ok: false, reason: 'height-mismatch' };
    }

    return { ok: true, reason: 'ok' };
  }

  #extractWalkableSurfaces(): void {
    const walkableSurfaces = [];
    let sampledWaypointCount = 0;
    let retainedWaypointCount = 0;

    const upwards = new Vector(0, 0, 1);
    const sidewards = new Vector(0, 1, 0);

    // Pass 1: collect all potentially walkable surfaces
    for (let i = 0; i < this.worldmodel.faces.length; i++) {
      const face = this.worldmodel.faces[i];

      if (face.numedges < 3) {
        continue;
      }

      const walkableSurface = new WalkableSurface(face, i);

      // Only accept surfaces whose normals point upward and do not exceed a 45 degrees incline.
      const faceNormal = face.normal;

      walkableSurface.stability = faceNormal.dot(upwards);

      if (walkableSurface.stability < this.maxSlope) {
        continue;
      }

      // Ignore special surfaces, also submodel faces
      if (face.turbulent === true || face.sky === true || face.submodel === true) {
        continue;
      }

      walkableSurface.normal.set(faceNormal);

      walkableSurfaces.push(walkableSurface);
    }

    // Pass 2: check if the walkable surfaces are really walkable by sampling points on them
    // - create sample points across each walkable face (interior sampling)
    // - approach: build ordered 3D vertex list for the face, project to a local 2D basis
    // - grid-sample the face bounding box and keep points that lie inside the polygon
    for (const surface of walkableSurfaces) {
      const face = surface.face;
      const verts3: Vector[] = [];
      for (let i = 0; i < face.numedges; i++) {
        const vec = new Vector();
        const surfedge = this.worldmodel.surfedges[face.firstedge + i];

        if (surfedge > 0) {
          vec.set(this.worldmodel.vertexes[this.worldmodel.edges[surfedge][0]]);
        } else {
          vec.set(this.worldmodel.vertexes[this.worldmodel.edges[-surfedge][1]]);
        }

        verts3.push(vec);
      }

      /** face plane normal */
      const n = surface.normal.copy();

      /** pick arbitrary axis not parallel to normal */
      const arbitrary = Math.abs(n[2]) < 0.9 ? upwards : sidewards;

      // build local orthonormal basis (u, v) on the face plane
      const u = n.cross(arbitrary);
      const uLen = u.normalize();

      if (uLen === 0) {
        continue;
      }

      const v = n.cross(u);
      const vLen = v.normalize();

      if (vLen === 0) {
        continue;
      }

      const origin = verts3[0];

      // project verts to 2D coordinates in [u, v] basis
      const verts2 = verts3.map((p3): PlanePoint => {
        const rel = p3.copy().subtract(origin);
        return [rel.dot(u), rel.dot(v)];
      });

      // compute bounding box in 2D
      let minX = Infinity, minY = Infinity;
      let maxX = -Infinity, maxY = -Infinity;

      for (const p of verts2) {
        if (p[0] < minX) {
          minX = p[0];
        }
        if (p[0] > maxX) {
          maxX = p[0];
        }
        if (p[1] < minY) {
          minY = p[1];
        }
        if (p[1] > maxY) {
          maxY = p[1];
        }
      }

      /**
       * point-in-polygon (ray crossing)
       * @returns True when the point lies inside the polygon.
       */
      const pointInPoly = (pt: PlanePoint, poly: PlanePoint[]): boolean => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i][0];
          const yi = poly[i][1];
          const xj = poly[j][0];
          const yj = poly[j][1];
          const intersect = ((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi + 0.0) + xi);
          if (intersect) {
            inside = !inside;
          }
        }
        return inside;
      };

      // sample the actor center lane instead of the full polygon so narrow stairs and ledges
      // can still produce valid points without relying on later support pruning alone.

      // sampling resolution (units between samples on the face)
      const step = 8;

      const startX = Math.floor(minX / step) * step + (step * 0.5);
      const startY = Math.floor(minY / step) * step + (step * 0.5);

      // grid-sample the bounding box and test inclusion
      for (let sx = startX; sx <= Math.ceil(maxX); sx += step) {
        for (let sy = startY; sy <= Math.ceil(maxY); sy += step) {
          const pt2 = [sx, sy];
          if (!pointInPoly(pt2, verts2)) {
            continue;
          }

          // map 2D point back to 3D: origin + u * x + v * y, then lift to a player stand origin
          const worldPoint = origin.copy().add(u.copy().multiply(pt2[0])).add(v.copy().multiply(pt2[1]));
          const standOrigin = worldPoint.add(this.#newWalkerStandOffset());

          surface.waypoints.push(new Waypoint(standOrigin));
          sampledWaypointCount++;
        }
      }
    }

    // Pass 3: prune waypoints that do not have enough player-sized clearance
    const rr = this.requiredRadius;
    const sideOffsets = [
      [-rr * 1.4, -rr], [0.0, -rr], [rr * 1.4, -rr],
      [-rr, 0.0], [rr, 0.0],
      [-rr * 1.4, rr], [0.0, rr], [rr * 1.4, rr],
    ];
    const pruneStats = {
      invalidFit: 0,
      lowHeight: 0,
      unsupported: 0,
      retained: 0,
    };

    for (const surface of walkableSurfaces) {
      for (const wp of surface.waypoints) {
        if (!this.#isValidStandOrigin(wp.origin)) {
          wp.availableHeight = 0;
          wp.isClipping = true;
          pruneStats.invalidFit++;
          continue;
        }

        wp.availableHeight = this.#measureAvailableHeight(wp.origin);

        if (wp.availableHeight < this.requiredHeight) {
          wp.availableHeight = 0;
          pruneStats.lowHeight++;
          continue;
        }

        if (!this.#hasGroundSupport(wp.origin)) {
          wp.isFloating = true;
          pruneStats.unsupported++;
          continue;
        }

        for (const [x, y] of sideOffsets) {
          const sideOrigin = this.#offsetStandOrigin(wp.origin, surface, x, y);

          if (!this.#isValidStandOrigin(sideOrigin)) {
            continue;
          }

          if (!this.#hasGroundSupport(sideOrigin)) {
            wp.nearLedge = true;
            break;
          }
        }
      }
    }

    // Pass 4: filter out unsuitable waypoints and store the rest
    for (const surface of walkableSurfaces) {
      const suitableWaypoints: Waypoint[] = [];

      for (const wp of surface.waypoints) {
        if ((wp.availableHeight >= this.walkerMaxs[2] - this.walkerMins[2]) && !wp.isClipping && !wp.isFloating) {
          suitableWaypoints.push(wp);
          pruneStats.retained++;
        }
      }

      if (suitableWaypoints.length === 0) {
        continue;
      }

      surface.waypoints = suitableWaypoints;
      retainedWaypointCount += suitableWaypoints.length;

      this.geometry.walkableSurfaces.push(surface);
    }

    Con.DPrint(
      `Navigation: walkable surfaces=${walkableSurfaces.length}, sampled waypoints=${sampledWaypointCount}, retained waypoints=${retainedWaypointCount}, retained surfaces=${this.geometry.walkableSurfaces.length}, invalidFit=${pruneStats.invalidFit}, lowHeight=${pruneStats.lowHeight}, unsupported=${pruneStats.unsupported}\n`,
    );
  }

  #buildNavigationGraph(): void {
    // Build a simple navgraph from the extracted waypoints.
    // Steps:
    // 1) collect all waypoints
    // 2) merge nearby waypoints into graph nodes
    // 3) connect nodes with unobstructed links (trace check)

    const mergeRadius = 24; // units to merge nearby waypoints
    const linkRadius = 64; // max distance to attempt a link

    // 1) collect all waypoints into flat list
    const allWaypoints: Array<{ wp: Waypoint; surface: WalkableSurface }> = [];
    for (const surface of this.geometry.walkableSurfaces) {
      for (const wp of surface.waypoints) {
        allWaypoints.push({ wp, surface });
      }
    }

    // 2) merge nearby waypoints into nodes using surface-aware clustering
    const nodes = this.graph.nodes;
    nodes.length = 0;

    const distance = (a: Vector, b: Vector): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

    // Group waypoints that should be merged together
    const waypointGroups: WaypointGroup[] = [];

    for (let i = 0; i < allWaypoints.length; i++) {
      const current = allWaypoints[i];
      let bestGroup: WaypointGroup | null = null;
      let bestDistance = Infinity;

      for (const group of waypointGroups) {
        const d = distance(group.seedOrigin, current.wp.origin);
        const heightDiff = Math.abs(group.seedOrigin[2] - current.wp.origin[2]);

        if (d > mergeRadius || heightDiff > STEPSIZE) {
          continue;
        }

        if (d < bestDistance) {
          bestDistance = d;
          bestGroup = group;
        }
      }

      if (bestGroup === null) {
        waypointGroups.push({
          seedOrigin: current.wp.origin.copy(),
          items: [{ ...current, index: i }],
        });
        continue;
      }

      bestGroup.items.push({ ...current, index: i });
    }

    // Create nodes from waypoint groups
    for (const group of waypointGroups) {
      const id = nodes.length;

      // Compute centroid of all waypoints in the group
      const centroid = new Vector();
      let representativeOrigin: Vector | null = null;
      let representativeDistance = Infinity;
      let minAvailableHeight = Infinity;
      let nearLedge = false;
      let isClipping = false;
      let isFloating = false;
      const surfaces = new Set();

      for (const { wp, surface } of group.items) {
        centroid.add(wp.origin);
        minAvailableHeight = Math.min(minAvailableHeight, wp.availableHeight);
        nearLedge = nearLedge || wp.nearLedge;
        isClipping = isClipping || wp.isClipping;
        isFloating = isFloating || wp.isFloating;
        surfaces.add(surface);
      }

      centroid.multiply(1.0 / group.items.length);

      // If all waypoints are on the same surface, project centroid onto that surface
      if (surfaces.size === 1) {
        const surface = surfaces.values().next().value as WalkableSurface;
        centroid.set(this.#projectStandOriginOntoSurface(centroid, surface));
      }

      for (const { wp } of group.items) {
        const d = wp.origin.distanceTo(centroid);

        if (d < representativeDistance) {
          representativeDistance = d;
          representativeOrigin = wp.origin;
        }
      }

      const node = new Node(id, representativeOrigin ?? centroid);
      node.availableHeight = Number.isFinite(minAvailableHeight) ? minAvailableHeight : 0.0;
      node.nearLedge = nearLedge;
      node.isClipping = isClipping;
      node.isFloating = isFloating;
      node.surfaces = surfaces;

      nodes.push(node);
    }

    // 3) build spatial index before linking to accelerate neighbor search
    this.#buildOctree();

    // 4) connect nodes: attempt links between nearby, unobstructed node pairs
    const linkStats = {
      considered: 0,
      linked: 0,
      startFit: 0,
      endFit: 0,
      startSupport: 0,
      endSupport: 0,
      stepFit: 0,
      stepSupport: 0,
      heightMismatch: 0,
    };

    // track already-evaluated pairs to avoid duplicate work
    const evaluatedPairs = new Set();

    for (const a of nodes) {
      for (const b of this.#findNearestNodes(a.origin, linkRadius)) {
        if (a.id === b.id) {
          continue;
        }

        // ensure each pair is evaluated only once
        const lo = Math.min(a.id, b.id);
        const hi = Math.max(a.id, b.id);
        const pairKey = lo * nodes.length + hi;

        if (evaluatedPairs.has(pairKey)) {
          continue;
        }

        evaluatedPairs.add(pairKey);

        const dist = b.origin.distanceTo(a.origin);

        linkStats.considered++;

        const aToB = this.#evaluateTraversalBetween(a.origin, b.origin);
        const bToA = this.#evaluateTraversalBetween(b.origin, a.origin);

        if (!aToB.ok && !bToA.ok) {
          const reasons = [aToB.reason, bToA.reason];

          if (reasons.includes('start-fit')) {
            linkStats.startFit++;
          } else if (reasons.includes('end-fit')) {
            linkStats.endFit++;
          } else if (reasons.includes('start-support')) {
            linkStats.startSupport++;
          } else if (reasons.includes('end-support')) {
            linkStats.endSupport++;
          } else if (reasons.includes('step-fit')) {
            linkStats.stepFit++;
          } else if (reasons.includes('step-support')) {
            linkStats.stepSupport++;
          } else {
            linkStats.heightMismatch++;
          }

          continue;
        }

        if (aToB.ok) {
          let cost = dist + Math.max(0.0, b.origin[2] - a.origin[2]);

          if (a.nearLedge) {
            cost += 96;
          }

          if (b.nearLedge) {
            cost += 96;
          }

          a.neighbors.push([b.id, cost, 0]);
          linkStats.linked++;
        }

        if (bToA.ok) {
          let cost = dist + Math.max(0.0, a.origin[2] - b.origin[2]);

          if (b.nearLedge) {
            cost += 96;
          }

          if (a.nearLedge) {
            cost += 96;
          }

          b.neighbors.push([a.id, cost, 0]);
          linkStats.linked++;
        }
      }
    }

    Con.DPrint(
      `Navigation: merged ${allWaypoints.length} waypoints into ${waypointGroups.length} waypoint groups\n`,
    );
    Con.PrintWarning(
      `Navigation: link stats considered=${linkStats.considered} linked=${linkStats.linked} `
      + `startFit=${linkStats.startFit} endFit=${linkStats.endFit} `
      + `startSupport=${linkStats.startSupport} endSupport=${linkStats.endSupport} `
      + `stepFit=${linkStats.stepFit} stepSupport=${linkStats.stepSupport} heightMismatch=${linkStats.heightMismatch}\n`,
    );
  }

  /**
   * updates navigation links based on entity position
   */
  relinkEdict(edict: ServerEdict): void {
    const entity = edict.entity as ServerEntity | null;

    if (!entity) {
      return;
    }

    // only care about world and large static brushes for now
    if (entity.solid !== Def.solid.SOLID_BSP) {
      return;
    }

    // this edict got flagged as not interesting earlier
    if (this.relinkSkiplist.has(edict.num)) {
      return;
    }

    if (this.relinkEdictCooldown[edict.num]) {
      clearTimeout(this.relinkEdictCooldown[edict.num]);
    }

    this.relinkEdictCooldown[edict.num] = setTimeout(() => {
      delete this.relinkEdictCooldown[edict.num];
      this.#relinkEdict(edict);
    }, 1000);
  }

  /**
   * updates navigation links based on entity position
   */
  #relinkEdict(edict: ServerEdict): void {
    if (edict.isFree()) {
      return;
    }

    // TODO: adjust the nav graph accordingly
  }

  #relinkAll(): void {
    for (let i = 0; i < SV.server.num_edicts; i++) {
      const edict = SV.server.edicts[i];

      if (edict.isFree()) {
        continue;
      }

      this.#relinkEdict(edict);
    }
  }

  #buildSpecialConnections(): void {
    this.#buildTeleporterLinks();
    this.#buildDoorLinks();
    this.#relinkAll();
  }

  #buildTeleporterLinks(): void {
    // looking for teleporters
    for (const teleporterEdict of ServerEngineAPI.FindAllByFieldAndValue('classname', 'trigger_teleport')) {
      const source = teleporterEdict.entity as ServerEntity | null;

      if (!source) {
        continue;
      }

      if (!source.target) {
        continue;
      }

      const destinationEdict = Array.from(ServerEngineAPI.FindAllByFieldAndValue('targetname', source.target))[0];
  const destination = destinationEdict?.entity as ServerEntity | null;

      if (!destination) {
        Con.PrintWarning(`Navigation: teleporter without a valid target: ${source.classname}\n`);
        continue;
      }

      const sp = source.centerPoint.copy(), dp = destination.centerPoint.copy();

      Con.DPrint(`Navigation: found teleporter [${sp}] --> [${dp}]\n`);

      const destNode = this.#findNearestNode(dp, 96); // Just grab one in proximity of the destination

      if (!destNode) {
        Con.PrintWarning('Navigation: teleporter destination has no nearby navnode\n');
        continue;
      }

      const cost = 0; // no cost for teleporters, since traveling is instant

      // insert a new node here to smooth out the path to the teleporter trigger
      const sourceNode = new Node(this.graph.nodes.length, sp);
      sourceNode.availableHeight = source.maxs[2] - source.mins[2];
      this.graph.nodes.push(sourceNode);
      Con.DPrint(`Navigation: adding teleporter source node ${sourceNode.id}\n`);

      // link the new node to its neighbors
      for (const sourceNodeNeighbor of this.#findNearestNodes(sp, 64)) {
        Con.DPrint(`Navigation: linking teleporter nodes ${sourceNodeNeighbor.id} --> ${sourceNode.id}\n`);
        sourceNodeNeighbor.neighbors.push([sourceNode.id, cost, 0]); // one-way link
        // this.graph.edges.push([ sourceNodeNeighbor.id, sourceNode.id, cost ]);
      }

      // link the new node to the destination node
      Con.DPrint(`Navigation: linking teleporter nodes ${sourceNode.id} --> ${destNode.id}\n`);
      sourceNode.neighbors.push([destNode.id, cost, 0]); // one-way link
      // this.graph.edges.push([ sourceNode.id, destNode.id, cost ]);
    }
  }

  #buildDoorLinks(): void {
    // looking for simple doors
    for (const doorEdict of ServerEngineAPI.FindAllByFieldAndValue('classname', 'func_door')) {
      const door = doorEdict.entity as ServerEntity | null;

      if (!door) {
        continue;
      }

      if (door.targetname) { // remote controlled door, skip for now
        continue;
      }

      this.relinkSkiplist.add(doorEdict.num);
    }
  }

  #buildOctree(): void {
    if (this.graph.nodes.length === 0) {
      this.graph.octree = null;
      return;
    }

    // compute bounding box of node origins
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const n of this.graph.nodes) {
      const o = n.origin;
      if (o[0] < minX) { minX = o[0]; }
      if (o[1] < minY) { minY = o[1]; }
      if (o[2] < minZ) { minZ = o[2]; }
      if (o[0] > maxX) { maxX = o[0]; }
      if (o[1] > maxY) { maxY = o[1]; }
      if (o[2] > maxZ) { maxZ = o[2]; }
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    const halfSize = Math.max(extentX, extentY, extentZ) / 2 + 1;

    const center = new Vector(cx, cy, cz);
  this.graph.octree = new Octree<Node>(center, halfSize, 12, 8);

    for (const n of this.graph.nodes) {
      this.graph.octree.insert(n);
    }
  }

  /**
   * Find nearest graph node to a world position.
   * @returns The nearest node within the search radius, or null.
   */
    #findNearestNode(position: Vector, maxDist = 512): Node | null {
    if (this.graph.nodes.length === 0) {
      return null;
    }

    // first try octree lookup, if available (linking specials won’t have access to the Octree yet)
    if (this.graph.octree) {
      const n = this.graph.octree.nearest(position, maxDist);

      if (n) {
        return n;
      }
    }

    // fallthrough to full scan if nothing found within maxDist in octree
    Con.DPrint('Navigation: nearest node not found in octree, falling back to linear scan\n');

    let best = null;
    let bestDist = Infinity;

    for (const node of this.graph.nodes) {
      const d = position.distanceTo(node.origin);
      if (d < bestDist && d <= maxDist) {
        bestDist = d;
        best = node;
      }
    }

    return best;
  }

  /**
   * Find all graph nodes within maxDist of a world position.
   * Uses the octree when available, falls back to linear scan.
   * @yields Nodes within the requested radius.
   */
  *#findNearestNodes(position: Vector, maxDist = 512): Generator<Node, void, undefined> {
    if (this.graph.octree) {
      for (const [, node] of this.graph.octree.root.querySphere(position, maxDist)) {
        yield node;
      }
      return;
    }

    for (const node of this.graph.nodes) {
      const d = position.distanceTo(node.origin);
      if (d <= maxDist) {
        yield node;
      }
    }
  }

  /**
   * Find path between two world positions using A* over the navgraph.
   * Returns an array of Vector positions (node origins) or null if no path.
   * Using this async version will offload the pathfinding to another worker thread and it will not recover during save/load games!
   * @returns A promised path containing the start and goal positions, or null.
   */
  findPathAsync(startPos: Vector, goalPos: Vector): Promise<Vector[] | null> {
    return new Promise<Vector[] | null>((resolve) => {
      const id = Math.random().toString(36).substring(2, 10);

      this.#requests[id] = resolve;

      eventBus.publish('nav.path.request', id, startPos, goalPos);
    });
  }

  /**
   * Find path between two world positions using A* over the navgraph.
   * Returns an array of Vector positions (node origins) or null if no path.
   * @returns A path containing the start and goal positions, or null.
   */
    findPath(startPos: Vector, goalPos: Vector): Vector[] | null {
    if (!this.graph || !this.graph.nodes || this.graph.nodes.length === 0) {
      return null;
    }

    const startNode = this.#findNearestNode(startPos, 512);
    const goalNode = this.#findNearestNode(goalPos, 512);

    if (!startNode || !goalNode) {
      Con.DPrint('Navigation: no start or goal node found\n');
      return null;
    }

    if (startNode.id === goalNode.id) {
      const path = [startPos.copy(), goalPos.copy()];
      return path;
    }

    const nodeCount = this.graph.nodes.length;
    const gScore = new Float64Array(nodeCount).fill(Infinity);
    const cameFrom = new Int32Array(nodeCount).fill(-1);
    const openSet = new MinHeap(nodeCount);

    gScore[startNode.id] = 0;
    openSet.pushOrDecrease(startNode.id, startNode.origin.distanceTo(goalNode.origin));

    while (openSet.size > 0) {
      const currentId = openSet.pop();

      if (currentId === goalNode.id) {
        const path = [];
        let cur = currentId;

        while (cur !== -1) {
          path.push(this.graph.nodes[cur].origin.copy());
          cur = cameFrom[cur];
        }

        path.reverse();
        path[0] = startPos.copy();
        path.push(goalPos.copy());
        return path;
      }

      const currentG = gScore[currentId];

      for (const nb of this.graph.nodes[currentId].neighbors) {
        const nbId = nb[0];
        const tentativeG = currentG + nb[1] + nb[2];

        if (tentativeG < gScore[nbId]) {
          cameFrom[nbId] = currentId;
          gScore[nbId] = tentativeG;
          openSet.pushOrDecrease(nbId, tentativeG + this.graph.nodes[nbId].origin.distanceTo(goalNode.origin));
        }
      }
    }

    return null;
  }

  #emitDot(position: Vector, color = 15, ttl = Infinity): void {
    if (Number.isFinite(ttl)) {
      eventBus.publish('nav.debug.emit-dot.temporarily', position, color, ttl);
    } else {
      eventBus.publish('nav.debug.emit-dot.permanently', position, color);
    }
  }

  static #emitDotFrontend(position: Vector, color = 15, ttl = Infinity): void {
    if (!R) {
      return;
    }

    const pn = R.AllocParticles(1);

    if (pn.length !== 1) {
      Con.PrintWarning(`Navigation: failed to allocate particle for debug dot at [${position}]\n`);
      return;
    }

    const p = R.particles[pn[0]];
    p.die = CL.state.time + ttl;
    p.color = color;
    p.vel = new Vector(0, 0, 0);
    p.org = position.copy();
    p.type = R.ptype.tracer;
  }

  #debugNavigation(): void {
    if (!Navigation.nav_debug_graph.value) {
      return;
    }

    for (const node of this.graph.nodes) {
      let color = 144;

      if (node.nearLedge) {
        color = 251;
      }

      this.#emitDot(node.origin.copy().add(new Vector(0, 0, 16)), color);
    }
  }

  /**
   * Emits a short-lived dotted debug path in the renderer.
   */
  #debugPath(vectors: Vector[], color = 251): void {
    if (!vectors || vectors.length === 0) {
      return;
    }

    const viewOffset = new Vector(0, 0, 22);

    for (let i = 0; i < vectors.length - 1; i++) {
      const start = vectors[i].copy().add(viewOffset);
      const end = vectors[i + 1].copy().add(viewOffset);
      const diff = end.copy().subtract(start);
      const totalDistance = diff.len();
      const stepLength = 4;
      diff.normalize();

      // Sample along the segment every 5 units
      for (let dist = 0; dist <= totalDistance; dist += stepLength) {
        const samplePoint = start.copy().add(diff.copy().multiply(dist));
        this.#emitDot(samplePoint, color, 10);
      }
    }
  }

  #debugWaypoints(): void {
    if (!Navigation.nav_debug_waypoints.value) {
      return;
    }

    if (this.geometry.walkableSurfaces.length === 0) {
      Con.PrintWarning('Navigation: waypoint debug is only available immediately after a local nav build. Nav files do not include waypoint data.\n');
      return;
    }

    const debugPoints: DebugPoint[] = [];
    let waypoints = 0;

    for (const surface of this.geometry.walkableSurfaces) {
      for (const wp of surface.waypoints) {
        let color = 15;

        if (wp.nearLedge && surface.stability !== 1) {
          color = 47;
        } else if (wp.nearLedge) {
          color = 251;
        } else if (surface.stability !== 1) {
          color = 192;
        }

        debugPoints.push({ origin: wp.origin, color, surface });
        waypoints++;
      }
    }

    Con.DPrint(`Navigation: debug waypoints: ${waypoints}\n`);
    Con.DPrint(`Navigation: extracted walkable surfaces: ${this.geometry.walkableSurfaces.length}\n`);

    for (const { color, origin } of debugPoints) {
      this.#emitDot(origin, color);
    }
  }

  // #debugKnownTestNavMeshProbes() {
  //   if (SV.server.mapname !== 'test_nav_mesh') {
  //     return;
  //   }

  //   const probes = [
  //     ['knight-start', new Vector(-160.0, -112.0, -160.0)],
  //     ['player-start', new Vector(352.0, -120.0, 40.0)],
  //     ['tele-dest-1', new Vector(352.0, -24.0, 24.0)],
  //     ['tele-dest-2', new Vector(-168.0, -416.0, -168.0)],
  //   ];

  //   for (const [label, origin] of probes) {
  //     Con.PrintWarning(
  //       `Navigation: probe ${label} fit=${this.#isValidStandOrigin(origin)} support=${this.#hasGroundSupport(origin)} height=${this.#measureAvailableHeight(origin)}\n`,
  //     );
  //   }
  // }

  build(): void {
    console.assert(Boolean(this.worldmodel), 'Navigation: worldmodel is required');

    this.graph.octree = null;
    this.graph.nodes.length = 0;
    this.geometry.walkableSurfaces.length = 0;
    this.relinkSkiplist.clear();
    this.relinkEdictLinks = {};

    Con.PrintWarning('Navigation: node graph out of date, rebuilding...\n');

    // this.#debugKnownTestNavMeshProbes();

    this.#extractWalkableSurfaces();
    this.#buildNavigationGraph();
    this.#buildSpecialConnections();
    this.#buildOctree();

    Con.DPrint(`Navigation: node graph built with ${this.graph.nodes.length} nodes.\n`);

    void this.save()
      .then(() => {
        Con.PrintSuccess('Navigation: navigation graph saved!\n');
        if (Navigation.nav_build_process?.value) {
          void Cmd.ExecuteString('quit');
        }
      })
      .catch((err) => Con.PrintError(`Navigation: failed to save navigation graph: ${err}\n`));

    this.#scheduleDebugRefresh();
  }
}
