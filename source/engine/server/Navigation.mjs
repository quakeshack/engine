// import sampleBSpline from '../../shared/BSpline.mjs';
import * as Def from '../../shared/Defs.mjs';
import { Octree } from '../../shared/Octree.mjs';
import Vector from '../../shared/Vector.mjs';
import Cmd from '../common/Cmd.mjs';
// import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { CorruptedResourceError, MissingResourceError } from '../common/Errors.mjs';
import { ServerEngineAPI } from '../common/GameAPIs.mjs';
import { BrushModel } from '../common/Mod.mjs';
import { Face } from '../common/model/BaseModel.mjs';
import PlatformWorker from '../common/PlatformWorker.mjs';
import WorkerManager from '../common/WorkerManager.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ServerEdict } from './Edict.mjs';

/** @typedef {import('./Edict.mjs').BaseEntity} ServerEntity */

let { CL, COM, Con, R, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  R = registry.R;
  SV = registry.SV;
});

class Waypoint {
  origin = new Vector();
  /** available clearance on the Z-axis */
  availableHeight = Infinity; // space above the waypoint that is free
  /** whether waypoint is near a ledge */
  nearLedge = false;
  /** whether waypoint is intersection something solid */
  isClipping = false;
  /** whether the point is sitting in the air */
  isFloating = false;

  /** @param {Vector} origin waypoint’s position */
  constructor(origin) {
    this.origin.set(origin);
  }

  serialize() {
    return [
      [...this.origin],
      this.availableHeight,
      this.nearLedge,
      this.isClipping,
      this.isFloating,
    ];
  }

  static deserialize(data) {
    const wp = new Waypoint(new Vector(...data[0]));
    wp.availableHeight = data[1];
    wp.nearLedge = data[2];
    wp.isClipping = data[3];
    wp.isFloating = data[4];
    return wp;
  }
}

class WalkableSurface {
  /** @type {number} dot product of downwards and plane’s normal, e.g. 1 = flat, down to ~0.7 = slope */
  stability = 0;
  /** @type {Vector} surface’s normal vector */
  normal = new Vector();
  /** @type {Face} */
  face = null;
  /** @type {Waypoint[]} */
  waypoints = [];

  /**
   * @param {Face} face face
   * @param {number} index face index in the worldmodel
   */
  constructor(face, index) {
    this.face = face;
    this.faceIndex = index;
  }

  serialize() {
    return [
      this.stability,
      [...this.normal],
      this.faceIndex,
      this.waypoints.map((wp) => wp.serialize()),
    ];
  }

  static deserialize(data, navigation) {
    const faceIndex = data[2];
    const face = navigation.worldmodel.faces[faceIndex];
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
  origin = new Vector();
  absmin = /** @type {Vector} */(null);
  absmax = /** @type {Vector} */(null);
  octreeNode = null;
  availableHeight = 0; // average available height from all waypoints
  nearLedge = false;
  isClipping = false;
  isFloating = false;
  /** @type {?Set<WalkableSurface>} */
  surfaces = new Set();
  /** @type {number[][]} list of [id, cost, temporary cost adjustment] */
  neighbors = [];

  /**
   * @param {number} id node ID
   * @param {Vector} origin node position
   */
  constructor(id, origin) {
    this.id = id;
    this.origin.set(origin);
  }

  serialize() {
    return [
      this.id,
      [...this.origin],
      this.availableHeight,
      this.nearLedge,
      this.isClipping,
      this.isFloating,
      Array.from(this.surfaces).map((s) => s.serialize()),
      this.neighbors.slice(),
    ];
  }

  /**
   * @param {any[]} data serialized data
   * @param {Navigation} navigation navigation instance
   * @returns {Node} deserialized node
   */
  // eslint-disable-next-line no-unused-vars
  static deserialize(data, navigation) {
    const node = new Node(data[0], new Vector(...data[1]));

    node.availableHeight = data[2];
    node.nearLedge = data[3];
    node.isClipping = data[4];
    node.isFloating = data[5];
    // node.surfaces = new Set(data[6].map((id) => WalkableSurface.deserialize(id, navigation)));
    node.neighbors = data[7].slice();

    return node;
  }
};

export class NavMeshOutOfDateException extends CorruptedResourceError {};

const NAV_FILE_VERSION = 2;

export class Navigation {
  /** @type {Cvar} */
  static nav_save_waypoints = null;
  /** @type {Cvar} */
  static nav_debug_waypoints = null;
  /** @type {Cvar} */
  static nav_debug_graph = null;
  /** @type {Cvar} */
  static nav_debug_path = null;
  /** @type {Cvar|null} NOTE: unavailable outside of dedicated server */
  static nav_build_process = null;

  /** maximum slope that is passable */
  maxSlope = 0.7; // ~45 degrees
  /** units of headroom required above waypoint */
  requiredHeight = -Def.hull[0][0][2] + Def.hull[0][1][2]; // hull 1
  requiredRadius = (-Def.hull[0][0][0] + Def.hull[0][1][0]) / 2; // hull 1 (radius, not diameter)

  /** @type {Record<string,(path:Vector[]|null)=>(void)>} holds pending requests for the worker thread */
  #requests = {};

  /** @type {PlatformWorker} worker thread handling navigation lookups */
  #worker = null;

  /** @type {Function?} unsubscribe from nav.path.request */
  #pathRequestEventListener = null;

  /** @type {Function?} unsubscribe from nav.path.response */
  #pathResponseEventListener = null;

  constructor(worldmodel) {
    /** @type {BrushModel?} */
    this.worldmodel = worldmodel;
    this.graph = {
      /** @type {Node[]} */
      nodes: [],
      /** @type {?Octree<Node>} */
      octree: null,
    };

    this.geometry = {
      /** @type {WalkableSurface[]} */
      walkableSurfaces: [],
    };
  }

  static Init() {
    if (registry.isDedicatedServer) {
      this.nav_build_process = new Cvar('nav_build_process', '0', Cvar.FLAG.NONE, 'if set to 1, it will force build the nav mesh and quit');
    }

    this.nav_save_waypoints = new Cvar('nav_save_waypoints', '0', Cvar.FLAG.NONE, 'if set to 1, will save all extracted waypoints to nav file');
    this.nav_debug_graph = new Cvar('nav_debug_graph', '0', Cvar.FLAG.NONE, 'if set to 1, will render the navigation graph for debugging');
    this.nav_debug_waypoints = new Cvar('nav_debug_waypoints', '0', Cvar.FLAG.NONE, 'if set to 1, will render all waypoints for debugging');
    this.nav_debug_path = new Cvar('nav_debug_path', '0', Cvar.FLAG.NONE | Cvar.FLAG.CHEAT, 'if set to 1, will render the last computed path for debugging');

    // worker thread -> main thread: mesh probably out of date
    eventBus.subscribe('nav.build', () => {
      if (SV.server.navigation) {
        SV.server.navigation.build();
      }
    });
  }

  #initWorker() {
    this.#worker = WorkerManager.SpawnWorker('server/NavigationWorker.mjs', [
      'nav.load',
      'nav.path.request',
    ]);
  }

  #shutdownWorker() {
    if (this.#worker) {
      this.#worker.shutdown().catch((err) => {
        Con.PrintError(`Failed to shutdown the navigation worker: ${err}\n`);
      });

      this.#worker = null;
    }
  }

  #subscribePathResponse() {
    this.#pathResponseEventListener = eventBus.subscribe('nav.path.response', (/** @type {string} */ id, /** @type {Vector[]} */ path) => {
      const vecpath = path ? path.map((p) => new Vector(...p)) : null;

      // since all events are global, we need to check what’s intended for us
      if (id in this.#requests) {
        this.#requests[id](vecpath);
        delete this.#requests[id];
      }
    });
  }

  init() {
    Con.DPrint('Navigation: initializing navigation graph...\n');

    if (Navigation.nav_build_process?.value) {
      this.build();
    }

    this.#initWorker();
    this.#subscribePathResponse();
    eventBus.publish('nav.load', SV.server.mapname, SV.server.worldmodel.checksum);
  }

  shutdown() {
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

    Con.DPrint('Navigation: shutdown complete.\n');
  }

  async load(mapname, expectedChecksum = null) {
    console.assert(this.worldmodel || expectedChecksum, 'Navigation: worldmodel or expectedChecksum is required');

    const filename = `maps/${mapname}.nav`;

    // Try to load binary file first (ArrayBuffer). Fallback to text JSON for older files.
    const buf = await COM.LoadFile(filename);

    if (!buf) {
      throw new MissingResourceError(filename);
    }

    const dv = new DataView(buf);
    let off = 0;

    const readBytes = (/** @type {number} */ n) => {
      const out = new Uint8Array(buf, off, n);
      off += n;
      return out;
    };

    const readUint8 = () => dv.getUint8(off++);
    const readUint32 = () => { const v = dv.getUint32(off, true); off += 4; return v; };
    const readInt32 = () => { const v = dv.getInt32(off, true); off += 4; return v; };
    const readFloat32 = () => { const v = dv.getFloat32(off, true); off += 4; return v; };

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
      this.relinkSkiplist.push(readUint32());
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
        const surfData = [];
        for (let si = 0; si < surfCount; si++) {
          const stability = readFloat32();
          const nx = readFloat32(); const ny = readFloat32(); const nz = readFloat32();
          const faceIndex = readUint32();
          const wpCount = readUint32();
          const wps = [];
          for (let wi = 0; wi < wpCount; wi++) {
            const wx = readFloat32(); const wy = readFloat32(); const wz = readFloat32();
            const avail = readFloat32();
            const near = !!readUint8();
            const clip = !!readUint8();
            const floating = !!readUint8();
            wps.push([[wx, wy, wz], avail, near, clip, floating]);
          }
          surfData.push([stability, [nx, ny, nz], faceIndex, wps]);
        }
        if (this.worldmodel) {
          node.surfaces = new Set(surfData.map((sd) => WalkableSurface.deserialize(sd, this)));
        }
      }

      // neighbors
      const nbCount = readUint32();
      const nbs = [];
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
  }

  async save() {
    console.assert(this.worldmodel, 'Navigation: worldmodel is required');

    const filename = `maps/${SV.server.mapname}.nav`;

    const bytes = [];
    const tmp = new ArrayBuffer(8);
    const tdv = new DataView(tmp);

    const pushUint8 = (v) => { bytes.push(v & 0xff); };
    const pushUint16 = (v) => { bytes.push(v & 0xff); bytes.push((v >>> 8) & 0xff); };
    const pushUint32 = (v) => {
      bytes.push(v & 0xff);
      bytes.push((v >>> 8) & 0xff);
      bytes.push((v >>> 16) & 0xff);
      bytes.push((v >>> 24) & 0xff);
    };
    const pushInt32 = (v) => pushUint32(v >>> 0);
    const pushFloat32 = (f) => { tdv.setFloat32(0, f, true); const bv = new Uint8Array(tmp, 0, 4); bytes.push(bv[0], bv[1], bv[2], bv[3]); };
    const pushBytes = (arr) => { for (let i = 0; i < arr.length; i++) { bytes.push(arr[i]); } };

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
    pushUint32(this.relinkSkiplist.length);
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

      // surfaces
      if (Navigation.nav_save_waypoints.value !== 0) {
        const surfaces = Array.from(n.surfaces);
        pushUint32(surfaces.length);
        for (const s of surfaces) {
          pushFloat32(s.stability);
          pushFloat32(s.normal[0]); pushFloat32(s.normal[1]); pushFloat32(s.normal[2]);
          pushUint32(s.faceIndex);
          pushUint32(s.waypoints.length);
          for (const wp of s.waypoints) {
            pushFloat32(wp.origin[0]); pushFloat32(wp.origin[1]); pushFloat32(wp.origin[2]);
            pushFloat32(wp.availableHeight);
            pushUint8(wp.nearLedge ? 1 : 0);
            pushUint8(wp.isClipping ? 1 : 0);
            pushUint8(wp.isFloating ? 1 : 0);
          }
        }
      } else {
        // simply write 0 here
        pushUint32(0);
      }

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

    if (registry.isDedicatedServer) {
      // tell the worker thread to reload the data
      eventBus.publish('nav.load', SV.server.mapname);
    }
  }

  /**
   * @param {Vector} startpos start position (waypoint)
   * @param {Vector} endpos end position (waypoint), will overwrite!
   * @param {number} hullNum hull number
   * @returns {number} fraction of unobstructed trace, 0 = completely blocked, 1 = fully clear
   */
  #testTraceStatic(startpos, endpos, hullNum) {
    const trace = SV.collision.traceWorldLine(startpos.copy(), endpos.copy(), hullNum);
    endpos.set(trace.endpos);
    if (trace.allsolid) {
      return -1;
    }
    return trace.fraction;
  }

  #extractWalkableSurfaces() {
    const walkableSurfaces = [];

    const downwards = new Vector(0, 0, -1);
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
      walkableSurface.stability = face.normal.dot(downwards);

      if (walkableSurface.stability < this.maxSlope) {
        continue;
      }

      // Ignore special surfaces, also submodel faces
      if (face.turbulent === true || face.sky === true || face.submodel === true) {
        continue;
      }

      walkableSurface.normal.set(face.normal);

      walkableSurfaces.push(walkableSurface);
    }

    // Pass 2: check if the walkable surfaces are really walkable by sampling points on them
    // - create sample points across each walkable face (interior sampling)
    // - approach: build ordered 3D vertex list for the face, project to a local 2D basis
    // - grid-sample the face bounding box and keep points that lie inside the polygon
    for (const surface of walkableSurfaces) {
      const face = surface.face;
      /** @type {Vector[]} collect ordered vertices for this face */
      const verts3 = [];
      for (let i = 0; i < face.numedges; i++) {
        const vec = new Vector();
        const surfedge = this.worldmodel.surfedges[face.firstedge + i];

        if (surfedge > 0) {
          vec.set(this.worldmodel.vertexes[this.worldmodel.edges[surfedge][0]]);
        } else {
          vec.set(this.worldmodel.vertexes[this.worldmodel.edges[-surfedge][1]]);
        }

        // triangulate on the fly, absolutely cursed
        if (i >= 3) {
          verts3.push(verts3[0]);
          verts3.push(verts3[verts3.length - 2]);
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
      const verts2 = verts3.map((p3) => {
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
       * @param {number[]} pt 2D point
       * @param {number[][]} poly polygon
       * @returns {boolean} true if inside
       */
      const pointInPoly = (pt, poly) => {
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

      /**
       * helper: distance from point to segment in 2D
       * @param {number[]} p 2D point, point to measure
       * @param {number[]} a 2D point, edge start
       * @param {number[]} b 2D point, edge end
       * @returns {number} distance
       */
      const distPointToSeg = (p, a, b) => {
        // p, a, b are [x,y]
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const wx = p[0] - a[0];
        const wy = p[1] - a[1];
        const c1 = vx * wx + vy * wy;
        if (c1 <= 0) {
          const dx = p[0] - a[0];
          const dy = p[1] - a[1];
          return Math.hypot(dx, dy);
        }
        const c2 = vx * vx + vy * vy;
        if (c2 <= c1) {
          const dx = p[0] - b[0];
          const dy = p[1] - b[1];
          return Math.hypot(dx, dy);
        }
        const t = c1 / c2;
        const projx = a[0] + t * vx;
        const projy = a[1] + t * vy;
        const dx = p[0] - projx;
        const dy = p[1] - projy;
        return Math.hypot(dx, dy);
      };

      // margin inside polygon to avoid sampling near edges (in world units projected to local 2D)
      const innerMargin = 0;

      // sampling resolution (units between samples on the face)
      const step = 12;

      // grid-sample the bounding box and test inclusion
      for (let sx = Math.floor(minX); sx <= Math.ceil(maxX); sx += step) {
        for (let sy = Math.floor(minY); sy <= Math.ceil(maxY); sy += step) {
          const pt2 = [sx, sy];
          if (!pointInPoly(pt2, verts2)) {
            continue;
          }

          // ensure sample is at least `innerMargin` units away from any polygon edge
          let minEdgeDist = Infinity;

          for (let ei = 0, ej = verts2.length - 1; ei < verts2.length; ej = ei++) {
            const a = verts2[ej];
            const b = verts2[ei];
            const d = innerMargin > 0 ? distPointToSeg(pt2, a, b) : 0;
            if (d < minEdgeDist) {
              minEdgeDist = d;
            }
            if (minEdgeDist < innerMargin) {
              break;
            }
          }

          if (minEdgeDist < innerMargin) {
            continue;
          }

          // map 2D point back to 3D: origin + u * x + v * y
          const worldPoint = origin.copy().add(u.copy().multiply(pt2[0])).add(v.copy().multiply(pt2[1]));

          surface.waypoints.push(new Waypoint(worldPoint));
        }
      }
    }

    // Pass 3: prune waypoints that do not have enough headroom
    // - for each waypoint, trace upwards to see how much free space is above it
    const rr = this.requiredRadius;
    const hull2Height = new Vector(0, 0, -Def.hull[1][0][2] + Def.hull[1][1][2]);

    for (const surface of walkableSurfaces) {
      for (const wp of surface.waypoints) {
        const startpos = wp.origin.copy();
        const endpos = startpos.copy();

        // trace up hull2 height, will modify endpos to the actual endpoint
        this.#testTraceStatic(startpos, endpos.add(hull2Height), 0);

        wp.availableHeight = endpos[2] - startpos[2];

        if (wp.availableHeight <= 24.0) { // immediately disqualify
          wp.availableHeight = 0;
          continue;
        }

        if (surface.stability < 1) {
          continue; // skip special checks for sloped surfaces for the time being
        }

        // trace around, taking surface.normal into account to follow the slope
        for (const baseDir of [
          new Vector(rr, 0, 0),
          new Vector(-rr, 0, 0),
          new Vector(0, 0, 0),
          new Vector(0, rr, 0),
          new Vector(0, -rr, 0),
        ]) {
          // FIXME: this does not work correctly on the other direction (E1M1 stairs)
          // project baseDir onto the plane by removing the component along surface.normal
          const dir = baseDir.copy().subtract(
            surface.normal.copy().multiply(baseDir.dot(surface.normal)),
          );
          if (dir.len() === 0) {
            continue;
          }
          dir.normalize();
          dir.multiply(this.requiredRadius);
          const sideStart = wp.origin.copy();
          const sideEnd = sideStart.copy().add(dir);
          const frac = this.#testTraceStatic(sideStart, sideEnd, 0);
          if (frac < 1) {
            wp.isClipping = true;
            break;
          }
        }

        const ledgeCheckHeight = 18.0 * 2; // 2 step sizes

        // trace around downwards to detect ledges
        for (const dir of [
          new Vector(-rr * 1.4, -rr, -ledgeCheckHeight), new Vector(0, -rr, -ledgeCheckHeight), new Vector(rr * 1.4, -rr, -ledgeCheckHeight),
          new Vector(-rr, 0, -ledgeCheckHeight), new Vector(0, 0, -ledgeCheckHeight), new Vector(rr, 0, -ledgeCheckHeight),
          new Vector(-rr * 1.4, rr, -ledgeCheckHeight), new Vector(0, rr, -ledgeCheckHeight), new Vector(rr * 1.4, rr, -ledgeCheckHeight),
        ]) {
          // TODO: apply normal vector to dir to follow slope
          const sideStart = wp.origin.copy().add(new Vector(dir[0], dir[1], 0));
          const sideEnd = sideStart.copy().add(new Vector(0, 0, dir[2]));
          const frac = this.#testTraceStatic(sideStart, sideEnd, 0);
          if (frac === -1 && sideEnd[2] === sideStart[2]) { // still on solid ground
            if (sideEnd[0] !== sideStart[0] || sideEnd[1] !== sideStart[1]) { // found a wall
              // TODO: but what if it’s a small protrusion, e.g. stairs?
              wp.isClipping = true;
            }
            continue;
          }

          if (frac > 0 && dir[0] === 0 && dir[1] === 0) {
            wp.isFloating = true;
          }

          if (sideStart[2] - sideEnd[2] >= ledgeCheckHeight) {
            wp.nearLedge = true;
            break;
          }
        }
      }
    }

    // Pass 4: filter out unsuitable waypoints and store the rest
    for (const surface of walkableSurfaces) {
      /** @type {Waypoint[]} */
      const suitableWaypoints = [];

      for (const wp of surface.waypoints) {
        if (wp.availableHeight >= 56 && !wp.isClipping && !wp.isFloating) {
          suitableWaypoints.push(wp);
        }
      }

      if (suitableWaypoints.length === 0) {
        continue;
      }

      surface.waypoints = suitableWaypoints;

      this.geometry.walkableSurfaces.push(surface);
    }
  }

  #buildNavigationGraph() {
    // Build a simple navgraph from the extracted waypoints.
    // Steps:
    // 1) collect all waypoints
    // 2) merge nearby waypoints into graph nodes
    // 3) connect nodes with unobstructed links (trace check)

    const mergeRadius = 24; // units to merge nearby waypoints
    const linkRadius = 64; // max distance to attempt a link

    // 1) collect all waypoints into flat list
    const allWaypoints = [];
    for (const surface of this.geometry.walkableSurfaces) {
      for (const wp of surface.waypoints) {
        allWaypoints.push({ wp, surface });
      }
    }

    // 2) merge nearby waypoints into nodes using surface-aware clustering
    /** @type {Node[]} */
    const nodes = this.graph.nodes;
    nodes.length = 0;

    const distance = (/** @type {Vector} */ a, /** @type {Vector} */ b) => Math.hypot(a[0] - b[0], a[1] - b[1]); // CR: z ignored, since they are coplanar anyway

    // Helper function to project a point onto a surface plane
    const projectOntoSurface = (/** @type {Vector} */ point, /** @type {WalkableSurface} */ surface) => {
      const normal = surface.normal;
      const face = surface.face;

      // Get a point on the surface plane (use first vertex of the face)
      let surfacePoint = null;
      const surfedge = this.worldmodel.surfedges[face.firstedge];
      if (surfedge > 0) {
        surfacePoint = new Vector().set(this.worldmodel.vertexes[this.worldmodel.edges[surfedge][0]]);
      } else {
        surfacePoint = new Vector().set(this.worldmodel.vertexes[this.worldmodel.edges[-surfedge][1]]);
      }

      // Project point onto the plane: p' = p - ((p - surfacePoint) · n) * n
      const pointToSurface = point.copy().subtract(surfacePoint);
      const distanceToPlane = pointToSurface.dot(normal);
      return point.copy().subtract(normal.copy().multiply(distanceToPlane));
    };

    // Group waypoints that should be merged together
    const waypointGroups = [];
    const processed = new Set();

    for (let i = 0; i < allWaypoints.length; i++) {
      if (processed.has(i)) {
        continue;
      }

      const { wp: seedWp, surface: seedSurface } = allWaypoints[i];
      const group = [{ wp: seedWp, surface: seedSurface, index: i }];
      processed.add(i);

      // Find all nearby waypoints that should merge with this one
      for (let j = i + 1; j < allWaypoints.length; j++) {
        if (processed.has(j)) {
          continue;
        }

        const { wp: otherWp, surface: otherSurface } = allWaypoints[j];

        // Check if waypoints are close enough and on compatible surfaces
        const d = distance(seedWp.origin, otherWp.origin);
        const heightDiff = Math.abs(seedWp.origin[2] - otherWp.origin[2]);

        if (d <= mergeRadius && heightDiff <= 8) { // allow small height differences for slopes
          group.push({ wp: otherWp, surface: otherSurface, index: j });
          processed.add(j);
        }
      }

      waypointGroups.push(group);
    }

    // Create nodes from waypoint groups
    for (const group of waypointGroups) {
      const id = nodes.length;

      // Compute centroid of all waypoints in the group
      const centroid = new Vector();
      let availableHeight = 0;
      let nearLedge = false;
      let isClipping = false;
      let isFloating = false;
      /** @type {Set<WalkableSurface>} */
      const surfaces = new Set();

      for (const { wp, surface } of group) {
        centroid.add(wp.origin);
        availableHeight = Math.min(availableHeight, wp.availableHeight);
        nearLedge = nearLedge || wp.nearLedge;
        isClipping = isClipping || wp.isClipping;
        isFloating = isFloating || wp.isFloating;
        surfaces.add(surface);
      }

      centroid.multiply(1.0 / group.length);

      // If all waypoints are on the same surface, project centroid onto that surface
      if (surfaces.size === 1) {
        const surface = surfaces.values().next().value;
        centroid.set(projectOntoSurface(centroid, surface));
      }

      const node = new Node(id, centroid);
      node.availableHeight = availableHeight;
      node.nearLedge = nearLedge;
      node.isClipping = isClipping;
      node.isFloating = isFloating;
      node.surfaces = surfaces;

      nodes.push(node);
    }

    // 3) connect nodes: attempt links between node pairs if close and unobstructed
    const stepOffset = new Vector(0, 0, 18); // maximum allowance to climb steps (FIXME: STEPSIZE)

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dist = b.origin.distanceTo(a.origin);

        if (dist > linkRadius) {
          continue;
        }

        // perform a trace between the two node origins to ensure unobstructed path
        const start = a.origin;
        const end = b.origin;
        const startStepped = start.copy().add(stepOffset);

        const frac = this.#testTraceStatic(start.copy(), end.copy(), 1);
        const fracStep = this.#testTraceStatic(startStepped, end.copy(), 0);

        if (frac < 1.0 && fracStep < 1.0) {
          // blocked or partially blocked
          continue;
        }

        let costBasis = dist; // simple cost metric: distance
        let costA = 0, costB = 0;

        // add penalties for being near a ledge, twice the sum of two merge radii

        if (a.nearLedge) {
          costA += 96;
        }

        if (b.nearLedge) {
          costB += 96;
        }

        costBasis += Math.max(0, end[2] - start[2]); // prefer lower paths

        a.neighbors.push([b.id, costBasis + costA, 0]);
        b.neighbors.push([a.id, costBasis + costB, 0]);
      }
    }
  }

  /** @type {Record<number,*>} edict number to timeout, we cool down incoming updates here */
  relinkEdictCooldown = {};

  /** @type {Record<number,Node>} */
  relinkEdictLinks = {};

  /** @type {number[]} list of edict numbers that we are not interested in, since it’s dynamic, e.g. func_door */
  relinkSkiplist = [];

  /**
   * updates navigation links based on entity position
   * @param {ServerEdict} edict edict to relink
   */
  relinkEdict(edict) {
    /** @type {?ServerEntity} */
    const entity = edict.entity;

    if (!entity) {
      return;
    }

    // only care about world and large static brushes for now
    if (entity.solid !== Def.solid.SOLID_BSP) {
      return;
    }

    // this edict got flagged as not interesting earlier
    if (this.relinkSkiplist.includes(edict.num)) {
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
   * @param {ServerEdict} edict edict to relink
   */
  #relinkEdict(edict) {
    if (edict.isFree()) {
      return;
    }

    // TODO: adjust the nav graph accordingly
  }

  #relinkAll() {
    for (let i = 0; i < SV.server.num_edicts; i++) {
      const edict = SV.server.edicts[i];

      if (edict.isFree()) {
        continue;
      }

      this.#relinkEdict(edict);
    }
  }

  #buildSpecialConnections() {
    this.#buildTeleporterLinks();
    this.#buildDoorLinks();
    this.#relinkAll();
  }

  #buildTeleporterLinks() {
    // looking for teleporters
    for (const teleporterEdict of ServerEngineAPI.FindAllByFieldAndValue('classname', 'trigger_teleport')) {
      /** @type {?ServerEntity} */
      const source = teleporterEdict.entity;

      if (!source) {
        continue;
      }

      if (!source.target) {
        continue;
      }

      const destinationEdict = Array.from(ServerEngineAPI.FindAllByFieldAndValue('targetname', source.target))[0];
      /** @type {?ServerEntity} */
      const destination = destinationEdict?.entity ?? null;

      if (!destination) {
        console.warn('Navigation: teleporter without a valid target', source);
        continue;
      }

      const sp = source.centerPoint.copy(), dp = destination.centerPoint.copy();

      console.debug('Navigation: found teleporter', sp, '-->', dp);

      const destNode = this.#findNearestNode(dp, 96); // Just grab one in proximity of the destination

      if (!destNode) {
        console.warn('Navigation: teleporter destination has no nearby navnode', destination);
        continue;
      }

      const cost = 0; // no cost for teleporters, since traveling is instant

      // insert a new node here to smooth out the path to the teleporter trigger
      const sourceNode = new Node(this.graph.nodes.length, sp);
      sourceNode.availableHeight = source.maxs[2] - source.mins[2];
      this.graph.nodes.push(sourceNode);
      console.debug('Navigation: adding teleporter source node', sourceNode);

      // link the new node to its neighbors
      for (const sourceNodeNeighbor of this.#findNearestNodes(sp, 64)) {
        console.debug('Navigation: linking teleporter nodes', sourceNodeNeighbor.id, '-->', sourceNode.id);
        sourceNodeNeighbor.neighbors.push([sourceNode.id, cost, 0]); // one-way link
        // this.graph.edges.push([ sourceNodeNeighbor.id, sourceNode.id, cost ]);
      }

      // link the new node to the destination node
      console.debug('Navigation: linking teleporter nodes', sourceNode.id, '-->', destNode.id);
      sourceNode.neighbors.push([destNode.id, cost, 0]); // one-way link
      // this.graph.edges.push([ sourceNode.id, destNode.id, cost ]);
    }
  }

  #buildDoorLinks() {
    // looking for simple doors
    for (const doorEdict of ServerEngineAPI.FindAllByFieldAndValue('classname', 'func_door')) {
      /** @type {?ServerEntity} */
      const door = doorEdict.entity;

      if (!door) {
        continue;
      }

      if (door.targetname) { // remote controlled door, skip for now
        continue;
      }

      this.relinkSkiplist.push(doorEdict.num);
    }
  }

  #buildOctree() {
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
    this.graph.octree = /** @type {Octree<Node>} */(new Octree(center, halfSize, 12, 8));

    for (const n of this.graph.nodes) {
      this.graph.octree.insert(n);
    }
  }

  /**
   * Find nearest graph node to a world position.
   * @param {Vector} position world-space position to query
   * @param {number} maxDist maximum search distance in world units
   * @returns {Node|null} node if found, null if none within maxDist or graph is empty
   */
  #findNearestNode(position, maxDist = 512) {
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
    console.warn('Navigation: nearest node not found in octree, falling back to linear scan', this, position, maxDist);

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
   * Find nearest graph node to a world position. Not using the Octree.
   * @param {Vector} position world-space position to query
   * @param {number} maxDist maximum search distance in world units
   * @yields {Node} node if found, null if none within maxDist or graph is empty
   */
  *#findNearestNodes(position, maxDist = 512) {
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
   * @param {Vector} startPos start position
   * @param {Vector} goalPos goal position
   * @returns {Promise<Vector[]|null>} path made out of waypoints, or null if no path found, it will include start and end positions
   */
  findPathAsync(startPos, goalPos) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).substring(2, 10);

      this.#requests[id] = resolve;

      eventBus.publish('nav.path.request', id, startPos, goalPos);
    });
  }

  /**
   * Find path between two world positions using A* over the navgraph.
   * Returns an array of Vector positions (node origins) or null if no path.
   * @param {Vector} startPos start position
   * @param {Vector} goalPos goal position
   * @returns {Vector[]|null} path made out of waypoints, or null if no path found, it will include start and end positions
   */
  findPath(startPos, goalPos) {
    if (!this.graph || !this.graph.nodes || this.graph.nodes.length === 0) {
      return null;
    }

    const startNode = this.#findNearestNode(startPos, 512);
    const goalNode = this.#findNearestNode(goalPos, 512);

    if (!startNode || !goalNode) {
      console.warn('Navigation: no start or goal node found', startPos, goalPos);
      return null;
    }

    if (startNode.id === goalNode.id) {
      const path = [startPos.copy(), goalPos.copy()];
      this.#debugPath(path);
      return path;
    }

    // A* structures
    const openSet = new Set([startNode.id]);
    const cameFrom = {}; // id -> id
    const gScore = {}; // id -> cost
    const fScore = {}; // id -> estimated total

    const heuristic = (/** @type {Vector} */ a, /** @type {Vector} */ b) => a.distanceTo(b);

    for (const n of this.graph.nodes) {
      gScore[n.id] = Infinity;
      fScore[n.id] = Infinity;
    }

    gScore[startNode.id] = 0;
    fScore[startNode.id] = heuristic(startNode.origin, goalNode.origin);

    // TODO: limit the size, since the graph can be huge and things are moving around anyway all the time
    //       the AI code already knows to refresh the path after some time or distance traveled, so this is fine

    while (openSet.size > 0) {
      // pick node in openSet with lowest fScore
      let currentId = null;
      let currentF = Infinity;
      for (const id of openSet) {
        if (fScore[id] < currentF) {
          currentF = fScore[id];
          currentId = id;
        }
      }

      if (currentId === goalNode.id) {
        // reconstruct path
        const path = [];
        let cur = currentId;
        while (cur !== undefined) {
          const node = this.graph.nodes[cur];
          path.push(node.origin.copy());
          cur = cameFrom[cur];
        }
        path.reverse();
        // prepend exact start and append exact goal for precision
        path[0] = startPos.copy();
        path.push(goalPos.copy());
        // CR: not smoothing for now, there are some issues with NPCs following the lines (movestep, unable to step over gaps)
        const bspath = path; // sampleBSpline(path, Math.min(200, path.length * 4));
        this.#debugPath(bspath);
        return bspath;
      }

      openSet.delete(currentId);

      for (const nb of this.graph.nodes[currentId].neighbors) {
        const tentativeG = gScore[currentId] + nb[1] + nb[2];

        const nbId = nb[0];
        if (tentativeG < gScore[nbId]) {
          cameFrom[nbId] = currentId;
          gScore[nbId] = tentativeG;
          fScore[nbId] = tentativeG + heuristic(this.graph.nodes[nbId].origin, goalNode.origin);
          if (!openSet.has(nbId)) {
            openSet.add(nbId);
          }
        }
      }
    }

    // no path found
    return null;
  }

  #emitDot(position, color = 15, ttl = Infinity) {
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

  #debugNavigation() {
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
   * @param {Vector[]} vectors waypoints
   * @param {number} color indexed color
   */
  #debugPath(vectors, color = 251) {
    if (!Navigation.nav_debug_path?.value) {
      return;
    }

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

  #debugWaypoints() {
    if (!Navigation.nav_debug_waypoints.value) {
      return;
    }

    /** @type {{origin: Vector, color: number, surface: WalkableSurface}[]} */
    const debugPoints = [];
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

    console.debug('waypoints: ', waypoints);
    console.debug('extracted walkable surfaces:', this.geometry.walkableSurfaces);

    for (const { color, origin } of debugPoints) {
      this.#emitDot(origin, color);
    }
  }

  build() {
    console.assert(this.worldmodel, 'Navigation: worldmodel is required');

    this.graph.octree = null;
    this.graph.nodes.length = 0;

    Con.PrintWarning('Navigation: node graph out of date, rebuilding...\n');

    this.#extractWalkableSurfaces();
    this.#buildNavigationGraph();
    this.#buildSpecialConnections();
    this.#buildOctree();

    Con.DPrint('Navigation: node graph built with ' + this.graph.nodes.length + ' nodes.\n');

    this.save()
      .then(() => {
        Con.PrintSuccess('Navigation: navigation graph saved!\n');
        if (Navigation.nav_build_process?.value) {
          Cmd.ExecuteString('quit');
        }
      })
      .catch((err) => Con.PrintError('Navigation: failed to save navigation graph: ' + err + '\n'));

    if (R) {
      setTimeout(() => {
        this.#debugWaypoints();
        this.#debugNavigation();
      }, 1000); // wait a bit for renderer to initialize
    }
  }
};
