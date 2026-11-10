// import sampleBSpline from '../../shared/BSpline.ts';
import * as Def from '../../shared/Defs.ts';
import type { EventPath } from '../../shared/EngineEvents.ts';
import { Octree, type OctreeNode } from '../../shared/Octree.ts';
import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.ts';
// import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { CorruptedResourceError, MissingResourceError } from '../common/Errors.ts';
import type { BrushModel } from '../common/Mod.ts';
import { MIN_STEP_NORMAL, STEPSIZE } from '../common/Pmove.ts';
import type { Face } from '../common/model/BaseModel.ts';
import type PlatformWorker from '../common/PlatformWorker.ts';
import WorkerManager from '../common/WorkerManager.ts';
import { eventBus } from '../common/EventBus.ts';
import type { BaseEntity, ServerEdict } from './Edict.ts';
import type { CollisionTrace } from './physics/ServerCollisionSupport.ts';
import { GroundSupport, type GroundProbe } from './physics/GroundSupport.ts';
import type Server from './Server.ts';
import type { ConsoleOutput } from '../common/Services.ts';

type VectorTuple = [number, number, number];
type PlanePoint = [number, number];
type NeighborLink = [id: number, cost: number, temporaryCostAdjustment: number, flags: number];
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
  /** Somewhere along the way the floor drops by more than a step: a player falls, a monster won't step off. */
  readonly drop: boolean;
  /** Ground under the whole box ({@link GroundSupport}) at every step up to a drop; false when not checked. */
  readonly supported: boolean;
}

/** How much of a walking monster's rules a traversal checks besides the walker's. */
const enum GroundRule {
  /** Only the walker's: a player's way, drops allowed. */
  IGNORE = 0,
  /** Also checks the ground under the whole box at every step, for {@link TraversalResult.supported}. */
  CHECK = 1,
  /** Fails at the first drop or unsupported step: only whether a monster walks it matters. */
  REQUIRE = 2,
}

/** A box relative to its origin. */
export interface NavigationBox {
  readonly mins: Vector;
  readonly maxs: Vector;
}

/** Which links a path may use, and which node origins it passes through. */
export enum NavigationHull {
  /** Every link, drops included: someone who falls off a ledge, such as a player. */
  PLAYER = 0,
  /** Links a monster of the walker's size (Quake's hull 1, 32 wide) walks, no drops. */
  SMALL = 1,
  /** Links a monster of Quake's hull 2 (64 wide) walks, through the nodes' large-hull origins. */
  LARGE = 2,
}

/** Bits of a link's flags. */
const enum LinkFlag {
  WALKABLE_SMALL = 1,
  WALKABLE_LARGE = 2,
  DROP = 4,
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
  spawnflags?: number;
}

/** Quake's `trigger_teleport` spawnflag that leaves everyone but players where they are. */
const TELEPORT_PLAYER_ONLY = 1;

/**
 * Converts a vector to a serializable tuple.
 * @returns The vector components as a tuple.
 */
function vectorToTuple(vector: Vector): VectorTuple {
  return [vector[0], vector[1], vector[2]];
}

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

    const surface = new WalkableSurface(face!, faceIndex);
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
  /** list of [id, cost, temporary cost adjustment, link flags]. */
  neighbors: NeighborLink[] = [];
  /** Where a 64-wide monster stands at this node, up to 16 units from `origin`, or `null` when it doesn't fit. */
  largeOrigin: Vector | null = null;
  /** The flags of every link to and from this node, ORed, to pick start and goal nodes a hull can use. */
  linkFlags = 0;

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

export class NavMeshOutOfDateException extends CorruptedResourceError { }

// TODO: in future we could build graphs per entity type (e.g. monster navmesh with tighter clearances, flying monster navmesh that ignores ground support, etc.)

/**
 * Version of the `.nav` file. Raise it whenever the binary layout changes and also whenever the
 * generator produces a different graph for the same map (link rules, costs, clearances): a mesh of
 * another version counts as out of date and is rebuilt, the ones that ship with a game included.
 */
const NAV_FILE_VERSION = 4;
const NAV_MONSTER_MINS = new Vector(-16.0, -16.0, -24.0);
const NAV_MONSTER_MAXS = new Vector(16.0, 16.0, 40.0);
/** Quake's hull 2: Shambler, Ogre, Fiend, Vore, Dog. */
const NAV_LARGE_MONSTER_BOX: NavigationBox = { mins: new Vector(-32.0, -32.0, -24.0), maxs: new Vector(32.0, 32.0, 64.0) };
/** How far a node's large-hull origin may be from the node, 16 for a node beside one wall. */
const NAV_LARGE_ORIGIN_NUDGES = [8.0, 16.0];
const NAV_LINK_STEP_DISTANCE = 8.0;
const NAV_DEFAULT_LINK_RADIUS = 96.0;
const NAV_TRANSITION_LINK_RADIUS = 128.0;
const NAV_LONG_LINK_COST_SCALE = 2.0;
const NAV_BLOCKED_LONG_LINK_COST = 1024.0;
// Maximum downward search distance per traversal step — large enough to cover typical Quake ledge drops.
const NAV_TRAVERSAL_DROP_LIMIT = 256.0;

/** What a `Navigation` depends on. */
export interface NavigationServices {
  readonly con: ConsoleOutput;
  /** Where meshes are read from, and where a rebuilt one is kept (`COM.WriteGeneratedFile`, never the user files). */
  readonly files: {
    LoadFile(filename: string): Promise<ArrayBuffer | null>;
    WriteGeneratedFile(filename: string, data: Uint8Array): Promise<boolean>;
  };
  /** The server whose world is navigated, `null` inside the worker that only searches paths. */
  readonly sv: Server | null;
}

export class Navigation {
  static nav_debug_waypoints: Cvar | null = null;
  static nav_debug_graph: Cvar | null = null;
  static nav_debug_path: Cvar | null = null;
  static nav_enabled: Cvar | null = null;
  /** unavailable outside of the dedicated server. */
  static nav_build_process: Cvar | null = null;

  /** maximum slope that is passable */
  readonly maxSlope = MIN_STEP_NORMAL;
  readonly walkerMins: Vector = NAV_MONSTER_MINS.copy();
  readonly walkerMaxs: Vector = NAV_MONSTER_MAXS.copy();
  /** The walker as a box: the graph is sampled with it, and it is the small hull. */
  readonly #walkerBox: NavigationBox = { mins: this.walkerMins, maxs: this.walkerMaxs };
  /** The static world under a box, for {@link GroundSupport} while building. */
  readonly #groundProbe: GroundProbe = {
    traceLine: (start: Vector, end: Vector): CollisionTrace => this.sv.collision.traceStaticWorld(start, Vector.origin, Vector.origin, end),
    pointContents: (point: Vector): Def.content => this.sv.collision.pointContents(point),
  };
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

  /** unsubscribe from nav.path.response. */
  #pathResponseEventListener: EventUnsubscribe = null;

  /** unsubscribe from nav_debug_graph changes. */
  #debugGraphEventListener: EventUnsubscribe = null;

  /** unsubscribe from nav_debug_waypoints changes. */
  #debugWaypointsEventListener: EventUnsubscribe = null;

  /** Whether the worker already reported this map's mesh as out of date, see {@link Navigation#rebuildOutdated}. */
  #outdatedRebuildRequested = false;

  worldmodel: BrushModel | null;
  graph: NavigationGraph;
  geometry: NavigationGeometry;

  relinkEdictCooldown: Record<number, TimeoutHandle> = {};
  relinkEdictLinks: Record<number, Node> = {};
  relinkSkiplist: Set<number> = new Set();

  readonly con: ConsoleOutput;
  readonly files: NavigationServices['files'];
  readonly #sv: Server | null;

  /**
   * Creates a navigation graph builder/runtime for a worldmodel.
   */
  constructor(worldmodel: BrushModel | null, services: NavigationServices) {
    this.worldmodel = worldmodel;
    this.con = services.con;
    this.files = services.files;
    this.#sv = services.sv;
    this.graph = {
      nodes: [],
      octree: null,
    };

    this.geometry = {
      walkableSurfaces: [],
    };
  }

  /**
   * The server whose world is navigated. Only the navigation that serves a server has one, the
   * worker that searches paths never does and must not ask for it.
   * @returns The server this navigation serves.
   */
  get sv(): Server {
    console.assert(this.#sv !== null, 'this navigation does not belong to a server');

    return this.#sv!;
  }

  static Init(sv: Server, dedicated: boolean): void {
    if (dedicated) {
      this.nav_build_process = new Cvar('nav_build_process', '0', Cvar.FLAG.NONE, 'if set to 1, it will force build the nav mesh and quit');
    }

    this.nav_debug_graph = new Cvar('nav_debug_graph', '0', Cvar.FLAG.NONE, 'if set to 1, will render the navigation graph for debugging');
    this.nav_debug_waypoints = new Cvar('nav_debug_waypoints', '0', Cvar.FLAG.NONE, 'if set to 1, will render all waypoints for debugging');
    this.nav_debug_path = new Cvar('nav_debug_path', '0', Cvar.FLAG.NONE | Cvar.FLAG.CHEAT, 'if set to 1, will render the last computed path for debugging');
    this.nav_enabled = new Cvar('nav_enabled', '1', Cvar.FLAG.NONE, 'if set to 1, navigation is enabled');

    // worker thread -> main thread: mesh probably out of date
    eventBus.subscribe('nav.build', (): void => {
      sv.server.navigation?.rebuildOutdated();
    });
  }

  /**
   * Rebuilds the mesh the worker found out of date. Only once per map: should the rebuilt mesh not
   * reach the worker (a full quota, a failing write), it would report it again and again otherwise.
   */
  rebuildOutdated(): void {
    if (this.#outdatedRebuildRequested) {
      this.con.DPrint('Navigation: mesh is still out of date after a rebuild, not trying again\n');
      return;
    }

    this.#outdatedRebuildRequested = true;
    this.build();
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
        this.con.PrintError(`Failed to shutdown the navigation worker: ${err}\n`);
      });

      this.#worker = null;
    }
  }

  #subscribePathResponse(): void {
    this.#pathResponseEventListener = eventBus.subscribe('nav.path.response', (id: string, path: EventPath): void => {
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

  /**
   * Schedules the debug dots to be emitted again. The navigation of the worker thread has no server, no debug variables
   * (`Init` runs only on the server's thread) and nobody to show dots to, so it does nothing there.
   */
  #scheduleDebugRefresh(): void {
    if (this.#sv === null) {
      return;
    }

    setTimeout((): void => {
      this.#debugWaypoints();
      this.#debugNavigation();
    }, 1000);
  }

  init(): void {
    this.con.DPrint('Navigation: initializing navigation graph...\n');

    if (Navigation.nav_build_process?.value) {
      this.build();
    }

    console.assert(this.sv.server.mapname, 'SV.server.mapname is required for navigation initialization');
    console.assert(this.sv.server.worldmodel, 'SV.server.worldmodel is required for navigation initialization');

    this.#initWorker();
    this.#subscribePathResponse();
    this.#subscribeDebugCvars();
    eventBus.publish('nav.load', this.sv.server.mapname!, this.sv.server.worldmodel!.checksum);
  }

  shutdown(): void {
    for (const timeout of Object.values(this.relinkEdictCooldown)) {
      clearTimeout(timeout);
    }

    this.#shutdownWorker();

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

    this.con.DPrint('Navigation: shutdown complete.\n');
  }

  async load(mapname: string, expectedChecksum: number | null = null): Promise<void> {
    console.assert(this.worldmodel || expectedChecksum, 'Navigation: worldmodel or expectedChecksum is required');

    const filename = `maps/${mapname}.nav`;

    this.graph.nodes.length = 0;
    this.graph.octree = null;
    this.relinkSkiplist.clear();

    // Try to load binary file first (ArrayBuffer). Fallback to text JSON for older files.
    const buf = await this.files.LoadFile(filename);

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

    // Another version is either another layout or another generator: rebuild it either way.
    const version = readUint32();
    if (version !== NAV_FILE_VERSION) {
      throw new NavMeshOutOfDateException(filename, `version ${version}, expected ${NAV_FILE_VERSION}`);
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
    } else if (checksum !== this.worldmodel!.checksum) {
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

      if (readUint8()) {
        node.largeOrigin = new Vector(readFloat32(), readFloat32(), readFloat32());
      }

      // neighbors
      const nbCount = readUint32();
      const nbs: NeighborLink[] = [];
      for (let k = 0; k < nbCount; k++) {
        const nid = readInt32();
        const cost = readFloat32();
        const adj = readFloat32();
        const linkFlags = readUint8();
        nbs.push([nid, cost, adj, linkFlags]);
      }
      node.neighbors = nbs;

      this.graph.nodes.push(node);
    }

    this.#gatherLinkFlags();
    this.#buildOctree();
    this.#scheduleDebugRefresh();
  }

  async save(): Promise<void> {
    console.assert(this.worldmodel !== null, 'Navigation: worldmodel is required');
    console.assert(this.sv.server.mapname, 'SV.server.mapname is required');

    const filename = `maps/${this.sv.server.mapname}.nav`;

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
    const pushInt32 = (value: number): void => { pushUint32(value >>> 0); };
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
    const nameBytes = new TextEncoder().encode(this.sv.server.mapname!);
    pushUint16(nameBytes.length);
    pushBytes(nameBytes);

    pushUint32(this.worldmodel!.checksum);
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

      pushUint8(n.largeOrigin !== null ? 1 : 0);
      if (n.largeOrigin !== null) {
        pushFloat32(n.largeOrigin[0]); pushFloat32(n.largeOrigin[1]); pushFloat32(n.largeOrigin[2]);
      }

      // neighbors
      pushUint32(n.neighbors.length);
      for (const nb of n.neighbors) {
        pushInt32(nb[0]);
        pushFloat32(nb[1]);
        pushFloat32(nb[2]);
        pushUint8(nb[3]);
      }
    }

    if (!await this.files.WriteGeneratedFile(filename, new Uint8Array(bytes))) {
      throw new Error(`could not write ${filename}`);
    }

    // Keep the worker in sync after every successful rebuild, including listen-server sessions.
    eventBus.publish('nav.load', this.sv.server.mapname!, this.worldmodel!.checksum);
  }

  #newWalkerStandOffset(): Vector {
    return new Vector(0, 0, -this.walkerMins[2]);
  }

  /**
   * Returns whether the player-sized walker fits at the given stand origin.
   * @returns True when the walker box does not start in solid.
   */
  #isValidStandOrigin(position: Vector, box: NavigationBox = this.#walkerBox): boolean {
    const trace = this.sv.collision.traceStaticWorld(
      position.copy(),
      box.mins,
      box.maxs,
      position.copy(),
    );

    return !trace.startsolid && !trace.allsolid;
  }

  /**
   * Traces the player-sized walker through the static world.
   * @returns The resulting static-world collision trace.
   */
  #traceWalkerStatic(startpos: Vector, endpos: Vector): CollisionTrace {
    return this.sv.collision.traceStaticWorld(
      startpos.copy(),
      this.walkerMins,
      this.walkerMaxs,
      endpos.copy(),
    );
  }

  /**
   * Returns whether a box standing at the origin has the floor support a walking monster needs.
   * @returns True when the box can stand on the sampled floor.
   */
  #hasGroundSupport(position: Vector, box: NavigationBox = this.#walkerBox): boolean {
    return GroundSupport.check(this.#groundProbe, position, box.mins, box.maxs);
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
    console.assert(this.worldmodel, 'Navigation: worldmodel is required for surface point retrieval');

    const surfedge = this.worldmodel!.surfedges[surface.face.firstedge];

    if (surfedge > 0) {
      return new Vector().set(this.worldmodel!.vertexes[this.worldmodel!.edges[surfedge][0]]);
    }

    return new Vector().set(this.worldmodel!.vertexes[this.worldmodel!.edges[-surfedge][1]]);
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
   * Walks from one stand origin to another in 8-unit steps the way a monster's `movestep` does: each step finds the
   * floor below a step up, and climbing more than a step fails. Dropping off a ledge is allowed (a player falls), but
   * marks the traversal as a drop, which a monster won't walk. A monster also needs ground under its whole box at
   * every step ({@link GroundSupport}), or it refuses to step there.
   * @param box The box that walks.
   * @param groundRule Whether to check the ground a monster needs at every step, and whether to fail without it.
   * @returns The traversal decision, its failure reason, and what a monster would make of it.
   */
  #evaluateTraversalBetween(startOrigin: Vector, endOrigin: Vector, box: NavigationBox = this.#walkerBox, groundRule = GroundRule.IGNORE): TraversalResult {
    if (!this.#isValidStandOrigin(startOrigin, box)) {
      return Navigation.#blocked('start-fit');
    }

    if (!this.#isValidStandOrigin(endOrigin, box)) {
      return Navigation.#blocked('end-fit');
    }

    if (!this.#hasGroundSupport(startOrigin, box)) {
      return Navigation.#blocked('start-support');
    }

    if (!this.#hasGroundSupport(endOrigin, box)) {
      return Navigation.#blocked('end-support');
    }

    const delta = endOrigin.copy().subtract(startOrigin);
    delta[2] = 0.0;

    const totalDistance = delta.len();

    if (totalDistance === 0.0) {
      const zDiff = endOrigin[2] - startOrigin[2];
      const drop = zDiff < -STEPSIZE;

      if (drop && groundRule === GroundRule.REQUIRE) {
        return Navigation.#blocked('drop');
      }

      // Dropping down is always traversable; climbing is limited to one step height. Both ends have ground.
      return { ok: zDiff <= STEPSIZE, reason: 'same-spot', drop, supported: groundRule !== GroundRule.IGNORE };
    }

    const stepDistance = Math.min(NAV_LINK_STEP_DISTANCE, totalDistance);
    const direction = delta.copy().multiply(1.0 / totalDistance);
    let previousOrigin = startOrigin;
    let drop = false;
    let supported = groundRule !== GroundRule.IGNORE;

    for (let travelled = stepDistance; travelled < totalDistance; travelled += stepDistance) {
      const sampleXY = startOrigin.copy().add(direction.copy().multiply(travelled));

      // Trace DOWN from slightly above the previous stand origin to find the actual floor at
      // this horizontal position. This correctly handles ledges, ramps, and stairs instead of
      // relying on linearly interpolated z which can pass through solid geometry or miss drops.
      const searchStart = new Vector(sampleXY[0], sampleXY[1], previousOrigin[2] + STEPSIZE);
      const searchEnd = new Vector(sampleXY[0], sampleXY[1], previousOrigin[2] - NAV_TRAVERSAL_DROP_LIMIT);
      const groundTrace = this.sv.collision.traceStaticWorld(searchStart, box.mins, box.maxs, searchEnd);

      if (groundTrace.fraction === 1.0) {
        return Navigation.#blocked('step-no-floor');
      }

      const sampleOrigin = new Vector(sampleXY[0], sampleXY[1], groundTrace.endpos[2]);

      // Block upward steps that exceed what the AI can physically climb; downward drops are allowed.
      if (sampleOrigin[2] > previousOrigin[2] + STEPSIZE) {
        return Navigation.#blocked('height-mismatch');
      }

      if (!this.#isValidStandOrigin(sampleOrigin, box)) {
        return Navigation.#blocked('step-fit');
      }

      if (sampleOrigin[2] < previousOrigin[2] - STEPSIZE) {
        drop = true;
      } else if (supported && !drop && !this.#hasGroundSupport(sampleOrigin, box)) {
        supported = false;
      }

      if (groundRule === GroundRule.REQUIRE && (drop || !supported)) {
        return Navigation.#blocked(drop ? 'drop' : 'step-support');
      }

      previousOrigin = sampleOrigin;
    }

    // Final step: end must not be above what the AI can climb from the last sample.
    // Downward drops to the goal are allowed (AI can fall/step off ledges).
    if (endOrigin[2] > previousOrigin[2] + STEPSIZE) {
      return Navigation.#blocked('height-mismatch');
    }

    drop ||= endOrigin[2] < previousOrigin[2] - STEPSIZE;

    if (groundRule === GroundRule.REQUIRE && drop) {
      return Navigation.#blocked('drop');
    }

    return { ok: true, reason: 'ok', drop, supported };
  }

  /**
   * A traversal nobody walks.
   * @returns The failed traversal.
   */
  static #blocked(reason: string): TraversalResult {
    return { ok: false, reason, drop: false, supported: false };
  }

  /**
   * Finds where a 64-wide monster stands at a node: the node's origin when the box fits there, else the nearest spot
   * up to 16 units away on the plane, on the floor within a step and with ground under the whole box. A node beside a
   * wall is only 16 units from it, which the walker needs, half of what the large box does.
   * @returns The large-hull origin, or `null` when the large box doesn't stand anywhere near the node.
   */
  #findLargeOrigin(origin: Vector): Vector | null {
    const candidates = [origin];

    for (const distance of NAV_LARGE_ORIGIN_NUDGES) {
      for (let direction = 0; direction < 8; direction++) {
        const radians = direction * Math.PI / 4.0;
        candidates.push(new Vector(
          origin[0] + Math.round(Math.cos(radians) * distance),
          origin[1] + Math.round(Math.sin(radians) * distance),
          origin[2],
        ));
      }
    }

    for (const candidate of candidates) {
      const top = new Vector(candidate[0], candidate[1], candidate[2] + STEPSIZE);
      const bottom = new Vector(candidate[0], candidate[1], candidate[2] - STEPSIZE);
      const trace = this.sv.collision.traceStaticWorld(top, NAV_LARGE_MONSTER_BOX.mins, NAV_LARGE_MONSTER_BOX.maxs, bottom);

      if (trace.startsolid || trace.allsolid || trace.fraction === 1.0) {
        continue;
      }

      if (this.#hasGroundSupport(trace.endpos, NAV_LARGE_MONSTER_BOX)) {
        return trace.endpos.copy();
      }
    }

    return null;
  }

  /**
   * Returns whether a long horizontal link appears blocked by a wall.
   * @returns True when the link is blocked by a wall.
   */
  #isLongLinkWallBlocked(startOrigin: Vector, endOrigin: Vector): boolean {
    const horizontalDistance = Math.hypot(endOrigin[0] - startOrigin[0], endOrigin[1] - startOrigin[1]);

    if (horizontalDistance <= NAV_DEFAULT_LINK_RADIUS) {
      return false;
    }

    const sweepEnd = new Vector(endOrigin[0], endOrigin[1], startOrigin[2]);
    const trace = this.#traceWalkerStatic(startOrigin, sweepEnd);

    if (trace.startsolid || trace.allsolid) {
      return true;
    }

    return trace.fraction < 1.0 && trace.plane.normal[2] < this.maxSlope;
  }

  #extractWalkableSurfaces(): void {
    const walkableSurfaces = [];
    let sampledWaypointCount = 0;
    let retainedWaypointCount = 0;

    const upwards = new Vector(0, 0, 1);
    const sidewards = new Vector(0, 1, 0);

    console.assert(this.worldmodel, 'Navigation: worldmodel is required for walkable surface extraction');

    // Pass 1: collect all potentially walkable surfaces
    for (let i = 0; i < this.worldmodel!.faces.length; i++) {
      const face = this.worldmodel!.faces[i];

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
      if (face.turbulent || face.sky || face.submodel) {
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
        const surfedge = this.worldmodel!.surfedges[face.firstedge + i];

        if (surfedge > 0) {
          vec.set(this.worldmodel!.vertexes[this.worldmodel!.edges[surfedge][0]]);
        } else {
          vec.set(this.worldmodel!.vertexes[this.worldmodel!.edges[-surfedge][1]]);
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
          const pt2: PlanePoint = [sx, sy];
          if (!pointInPoly(pt2, verts2)) {
            continue;
          }

          // Map 2D point back to 3D position on the surface plane.
          const worldPoint = origin.copy().add(u.copy().multiply(pt2[0])).add(v.copy().multiply(pt2[1]));

          // Trace down from above the surface point to find the actual stand origin.
          // A fixed +Z offset (walkerMins offset) fails on slopes: the walker AABB clips into
          // the tilted geometry on the uphill side, causing #isValidStandOrigin to reject
          // every slope waypoint. The downward trace lets the BSP clip hull solve the height.
          //
          // The start height must be above the expanded BSP hull on the uphill side. For a slope
          // with stability s (= face normal z component), the uphill edge of the walker box
          // rises requiredRadius × tan(arccos(s)) = requiredRadius × √(1−s²)/s above the face
          // center. Using this formula for the trace start means flat floors barely exceed the
          // floor plane (entity top ≈ worldPoint.z + 66 for a 72-unit corridor, fits fine)
          // while steep slopes get a proportionally higher start — avoiding the ceiling-piercing
          // bug that occurred with the previous fixed +82 offset.
          const slopeTilt = Math.sqrt(1 - surface.stability * surface.stability) / surface.stability;
          const searchStartZ = worldPoint[2] + (-this.walkerMins[2]) + this.requiredRadius * slopeTilt + 2;
          const searchStart = new Vector(worldPoint[0], worldPoint[1], searchStartZ);
          const searchEnd = new Vector(worldPoint[0], worldPoint[1], worldPoint[2] - STEPSIZE);
          const groundTrace = this.sv.collision.traceStaticWorld(searchStart, this.walkerMins, this.walkerMaxs, searchEnd);

          if (groundTrace.fraction >= 1.0 || groundTrace.startsolid) {
            continue;
          }

          surface.waypoints.push(new Waypoint(groundTrace.endpos.copy()));
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

        // Note: we intentionally do NOT prune on availableHeight < requiredHeight here.
        // #isValidStandOrigin above already ensures the walker fits without clipping the ceiling.
        // Requiring a full extra body-height of clearance above the walker center would incorrectly
        // prune valid staircase waypoints that sit beneath an overhang (e.g. a staircase going
        // under the ledge of the upper floor). The available-height value is still stored for
        // debugging and potential future use.

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
        if (!wp.isClipping && !wp.isFloating) {
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

    this.con.DPrint(
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
    // The default radius keeps local links tight. A larger transition radius is allowed
    // only when there is a meaningful vertical transition or ledge context.
    // This avoids creating implausible long-range links on flat/open areas.
    const linkRadius = NAV_TRANSITION_LINK_RADIUS;

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
      const surfaces = new Set<WalkableSurface>();

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

    for (const node of nodes) {
      node.largeOrigin = this.#findLargeOrigin(node.origin);
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

        const aToB = this.#evaluateTraversalBetween(a.origin, b.origin, this.#walkerBox, GroundRule.CHECK);
        // The ground under the line is the same both ways: when a→b checked all of it, b→a doesn't again.
        const lineChecked = aToB.ok && !aToB.drop;
        const bToA = this.#evaluateTraversalBetween(b.origin, a.origin, this.#walkerBox, lineChecked ? GroundRule.IGNORE : GroundRule.CHECK);

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

        const smallAToB = lineChecked && aToB.supported;
        const smallBToA = bToA.ok && !bToA.drop && (lineChecked ? aToB.supported : bToA.supported);
        const large = (smallAToB || smallBToA) && dist <= NAV_DEFAULT_LINK_RADIUS && this.#largeWalks(smallAToB ? a : b, smallAToB ? b : a);

        if (aToB.ok) {
          a.neighbors.push([b.id, this.#linkCost(a, b, dist), 0, Navigation.#linkFlags(aToB.drop, smallAToB, large)]);
          linkStats.linked++;
        }

        if (bToA.ok) {
          b.neighbors.push([a.id, this.#linkCost(b, a, dist), 0, Navigation.#linkFlags(bToA.drop, smallBToA, large)]);
          linkStats.linked++;
        }
      }
    }

    this.con.DPrint(
      `Navigation: merged ${allWaypoints.length} waypoints into ${waypointGroups.length} waypoint groups\n`,
    );
    this.con.PrintWarning(
      `Navigation: link stats considered=${linkStats.considered} linked=${linkStats.linked} `
      + `startFit=${linkStats.startFit} endFit=${linkStats.endFit} `
      + `startSupport=${linkStats.startSupport} endSupport=${linkStats.endSupport} `
      + `stepFit=${linkStats.stepFit} stepSupport=${linkStats.stepSupport} `
      + `heightMismatch=${linkStats.heightMismatch}\n`,
    );
  }

  /**
   * What a link from `from` to `to` costs: its length, plus climbing, plus a penalty for a long link (more for one a
   * wall seems to block) and for every end near a ledge.
   * @returns The link cost.
   */
  #linkCost(from: Node, to: Node, distance: number): number {
    let cost = distance + Math.max(0.0, to.origin[2] - from.origin[2]);

    if (distance > NAV_DEFAULT_LINK_RADIUS) {
      cost += (distance - NAV_DEFAULT_LINK_RADIUS) * NAV_LONG_LINK_COST_SCALE;

      if (this.#isLongLinkWallBlocked(from.origin, to.origin)) {
        cost += NAV_BLOCKED_LONG_LINK_COST;
      }
    }

    if (from.nearLedge) {
      cost += 96;
    }

    if (to.nearLedge) {
      cost += 96;
    }

    return cost;
  }

  /**
   * Whether a 64-wide monster walks between two nodes' large-hull origins. Only one way: on a link without a drop
   * the walk back is the same steps, up and down swapped. Links longer than 96 units aren't walked for it, which
   * spares half the build time; long links cost extra and the graph has shorter ones around them.
   * @returns True when the large monster walks it.
   */
  #largeWalks(from: Node, to: Node): boolean {
    if (from.largeOrigin === null || to.largeOrigin === null) {
      return false;
    }

    return this.#evaluateTraversalBetween(from.largeOrigin, to.largeOrigin, NAV_LARGE_MONSTER_BOX, GroundRule.REQUIRE).ok;
  }

  /**
   * The flags of a link the walker traverses.
   * @param drop The floor drops by more than a step somewhere along it.
   * @param small A monster of the walker's size walks it.
   * @param large A 64-wide monster walks it too.
   * @returns The link flags.
   */
  static #linkFlags(drop: boolean, small: boolean, large: boolean): number {
    if (drop) {
      return LinkFlag.DROP;
    }

    if (!small) {
      return 0;
    }

    return large ? LinkFlag.WALKABLE_SMALL | LinkFlag.WALKABLE_LARGE : LinkFlag.WALKABLE_SMALL;
  }

  /**
   * Gathers into every node the flags of the links to and from it.
   */
  #gatherLinkFlags(): void {
    const nodes = this.graph.nodes;

    for (const node of nodes) {
      node.linkFlags = 0;
    }

    for (const node of nodes) {
      for (const link of node.neighbors) {
        node.linkFlags |= link[3];
        nodes[link[0]].linkFlags |= link[3];
      }
    }
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
    for (let i = 0; i < this.sv.server.num_edicts; i++) {
      const edict = this.sv.server.edicts[i];

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
    for (const teleporterEdict of this.sv.engineAPI.FindAllByFieldAndValue('classname', 'trigger_teleport')) {
      const source = teleporterEdict.entity as ServerEntity | null;

      if (!source) {
        continue;
      }

      if (!source.target) {
        continue;
      }

      const destinationEdict = Array.from(this.sv.engineAPI.FindAllByFieldAndValue('targetname', source.target))[0];
      const destination = destinationEdict?.entity as ServerEntity | null;

      if (!destination) {
        this.con.PrintWarning(`Navigation: teleporter without a valid target: ${source.classname}\n`);
        continue;
      }

      const sp = source.centerPoint.copy(), dp = destination.centerPoint.copy();

      this.con.DPrint(`Navigation: found teleporter [${sp}] --> [${dp}]\n`);

      const destNode = this.#findNearestNode(dp, 96); // Just grab one in proximity of the destination

      if (!destNode) {
        this.con.PrintWarning('Navigation: teleporter destination has no nearby navnode\n');
        continue;
      }

      const cost = 0; // no cost for teleporters, since traveling is instant
      // A player-only teleporter ignores monsters, and one with a targetname only teleports once it was fired, which
      // a monster can't know: monster paths into either end in front of a trigger that does nothing.
      const monstersUse = ((source.spawnflags ?? 0) & TELEPORT_PLAYER_ONLY) === 0 && !source.targetname;

      // insert a new node here to smooth out the path to the teleporter trigger
      const sourceNode = new Node(this.graph.nodes.length, sp);
      sourceNode.availableHeight = source.maxs[2] - source.mins[2];
      sourceNode.largeOrigin = sp;
      this.graph.nodes.push(sourceNode);
      this.con.DPrint(`Navigation: adding teleporter source node ${sourceNode.id}\n`);

      // link the new node to its neighbors
      for (const sourceNodeNeighbor of this.#findNearestNodes(sp, 64)) {
        this.con.DPrint(`Navigation: linking teleporter nodes ${sourceNodeNeighbor.id} --> ${sourceNode.id}\n`);
        sourceNodeNeighbor.neighbors.push([sourceNode.id, cost, 0, Navigation.#teleporterLinkFlags(sourceNodeNeighbor, monstersUse)]); // one-way link
        // this.graph.edges.push([ sourceNodeNeighbor.id, sourceNode.id, cost ]);
      }

      // link the new node to the destination node
      this.con.DPrint(`Navigation: linking teleporter nodes ${sourceNode.id} --> ${destNode.id}\n`);
      sourceNode.neighbors.push([destNode.id, cost, 0, Navigation.#teleporterLinkFlags(destNode, monstersUse)]); // one-way link
      // this.graph.edges.push([ sourceNode.id, destNode.id, cost ]);
    }
  }

  /**
   * Players use every teleporter. Monsters use one that teleports them, with the hulls the node at the other end of
   * the link has room for.
   * @param monstersUse Whether the teleporter takes monsters.
   * @returns The flags of a link between a teleporter and `node`.
   */
  static #teleporterLinkFlags(node: Node, monstersUse: boolean): number {
    if (!monstersUse) {
      return 0;
    }

    return node.largeOrigin !== null ? LinkFlag.WALKABLE_SMALL | LinkFlag.WALKABLE_LARGE : LinkFlag.WALKABLE_SMALL;
  }

  #buildDoorLinks(): void {
    // looking for simple doors
    for (const doorEdict of this.sv.engineAPI.FindAllByFieldAndValue('classname', 'func_door')) {
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
      if (o[0] < minX) {
        minX = o[0];
      }
      if (o[1] < minY) {
        minY = o[1];
      }
      if (o[2] < minZ) {
        minZ = o[2];
      }
      if (o[0] > maxX) {
        maxX = o[0];
      }
      if (o[1] > maxY) {
        maxY = o[1];
      }
      if (o[2] > maxZ) {
        maxZ = o[2];
      }
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
    this.con.DPrint('Navigation: nearest node not found in octree, falling back to linear scan\n');

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
   * The link flag a hull's path needs on every link, 0 for the player, who takes them all.
   * @returns The required link flag.
   */
  static #requiredLinkFlag(hull: NavigationHull): number {
    switch (hull) {
      case NavigationHull.SMALL:
        return LinkFlag.WALKABLE_SMALL;
      case NavigationHull.LARGE:
        return LinkFlag.WALKABLE_LARGE;
      default:
        return 0;
    }
  }

  /**
   * Finds the graph node nearest to a position that has a link with the required flag, within 512 units.
   * @returns The nearest such node, or null.
   */
  #findNearestNodeWith(position: Vector, requiredFlag: number): Node | null {
    if (requiredFlag === 0) {
      return this.#findNearestNode(position, 512);
    }

    let best: Node | null = null;
    let bestDistance = Infinity;

    for (const node of this.#findNearestNodes(position, 512)) {
      if ((node.linkFlags & requiredFlag) === 0) {
        continue;
      }

      const distance = position.distanceTo(node.origin);

      if (distance < bestDistance) {
        bestDistance = distance;
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
   * The smallest hull whose box encloses `box`; without a box, {@link NavigationHull.PLAYER}.
   * @returns The hull to search paths for.
   */
  static hullFor(box: NavigationBox | null): NavigationHull {
    if (box === null) {
      return NavigationHull.PLAYER;
    }

    const fitsWalker = box.mins[0] >= NAV_MONSTER_MINS[0] && box.mins[1] >= NAV_MONSTER_MINS[1]
      && box.maxs[0] <= NAV_MONSTER_MAXS[0] && box.maxs[1] <= NAV_MONSTER_MAXS[1]
      && box.maxs[2] - box.mins[2] <= NAV_MONSTER_MAXS[2] - NAV_MONSTER_MINS[2];

    return fitsWalker ? NavigationHull.SMALL : NavigationHull.LARGE;
  }

  /**
   * Find path between two world positions using A* over the navgraph.
   * Returns an array of Vector positions (node origins) or null if no path.
   * Using this async version will offload the pathfinding to another worker thread and it will not recover during save/load games!
   * @param hull Which links the path may use, see {@link Navigation#findPath}.
   * @returns A promised path containing the start and goal positions, or null.
   */
  findPathAsync(startPos: Vector, goalPos: Vector, hull = NavigationHull.PLAYER): Promise<Vector[] | null> {
    if (!Navigation.nav_enabled!.value) {
      return Promise.resolve(null);
    }

    return new Promise<Vector[] | null>((resolve) => {
      const id = Math.random().toString(36).substring(2, 10);

      this.#requests[id] = resolve;

      eventBus.publish('nav.path.request', id, startPos, goalPos, hull);
    });
  }

  /**
   * Find path between two world positions using A* over the navgraph.
   * Returns an array of Vector positions (node origins) or null if no path.
   * A monster hull only takes links a monster of its size walks (no drops) and nodes that have such links; the large
   * hull's path passes through the nodes' large-hull origins.
   * @param hull Which links the path may use; {@link NavigationHull.PLAYER} takes every link.
   * @returns A path containing the start and goal positions, or null.
   */
  findPath(startPos: Vector, goalPos: Vector, hull = NavigationHull.PLAYER): Vector[] | null {
    if (!this.graph || !this.graph.nodes || this.graph.nodes.length === 0) {
      return null;
    }

    const requiredFlag = Navigation.#requiredLinkFlag(hull);
    const startNode = this.#findNearestNodeWith(startPos, requiredFlag);
    const goalNode = this.#findNearestNodeWith(goalPos, requiredFlag);

    if (!startNode || !goalNode) {
      this.con.DPrint('Navigation: no start or goal node found\n');
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
          const node = this.graph.nodes[cur];
          path.push((hull === NavigationHull.LARGE ? node.largeOrigin ?? node.origin : node.origin).copy());
          cur = cameFrom[cur];
        }

        path.reverse();
        path[0] = startPos.copy();
        path.push(goalPos.copy());
        return path;
      }

      const currentG = gScore[currentId];

      for (const nb of this.graph.nodes[currentId].neighbors) {
        if (requiredFlag !== 0 && (nb[3] & requiredFlag) === 0) {
          continue;
        }

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

  #debugNavigation(): void {
    if (!Navigation.nav_debug_graph!.value) {
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
    if (!Navigation.nav_debug_waypoints!.value) {
      return;
    }

    if (this.geometry.walkableSurfaces.length === 0) {
      this.con.PrintWarning('Navigation: waypoint debug is only available immediately after a local nav build. Nav files do not include waypoint data.\n');
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

    this.con.DPrint(`Navigation: debug waypoints: ${waypoints}\n`);
    this.con.DPrint(`Navigation: extracted walkable surfaces: ${this.geometry.walkableSurfaces.length}\n`);

    for (const { color, origin } of debugPoints) {
      this.#emitDot(origin, color);
    }
  }

  // #debugKnownTestNavMeshProbes() {
  //   if (this.sv.server.mapname !== 'test_nav_mesh') {
  //     return;
  //   }

  //   const probes = [
  //     ['knight-start', new Vector(-160.0, -112.0, -160.0)],
  //     ['player-start', new Vector(352.0, -120.0, 40.0)],
  //     ['tele-dest-1', new Vector(352.0, -24.0, 24.0)],
  //     ['tele-dest-2', new Vector(-168.0, -416.0, -168.0)],
  //   ];

  //   for (const [label, origin] of probes) {
  //     this.con.PrintWarning(
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

    this.con.PrintWarning('Navigation: node graph out of date, rebuilding...\n');

    // this.#debugKnownTestNavMeshProbes();

    this.#extractWalkableSurfaces();
    this.#buildNavigationGraph();
    this.#buildSpecialConnections();
    this.#gatherLinkFlags();
    this.#buildOctree();

    this.con.DPrint(`Navigation: node graph built with ${this.graph.nodes.length} nodes.\n`);

    void this.save()
      .then(() => {
        this.con.PrintSuccess('Navigation: navigation graph saved!\n');
        if (Navigation.nav_build_process?.value) {
          void Cmd.ExecuteString('quit');
        }
      })
      .catch((err) => { this.con.PrintError(`Navigation: failed to save navigation graph: ${err}\n`); });

    this.#scheduleDebugRefresh();
  }
}
