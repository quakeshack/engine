/* global Mod, Pmove, Protocol, Vector */

// eslint-disable-next-line no-global-assign
Pmove = {};

Pmove.MoveVars = class MoveVars { // movevars_t
  constructor() {
    this.gravity = 0;
    this.stopspeed = 0;
    this.maxspeed = 0;
    this.spectatormaxspeed = 0;
    this.accelerate = 0;
    this.airaccelerate = 0;
    this.wateraccelerate = 0;
    this.friction = 0;
    this.waterfriction = 0;
    this.entgravity = 0;
  }
}

Pmove.Trace = class Trace { // pmtrace_t
  constructor() {
    /** if true, plane is not valid */
    this.allsolid = true;
    /** if true, the initial point was in a solid area */
    this.startsolid = false;
    /** time completed, 1.0 = didn't hit anything */
    this.fraction = 1.0;
    /** final position */
    this.endpos = new Vector();
    /** surface normal at impact */
    this.plane = new Pmove.Plane();
    /** edict number the surface is on */
    this.ent = null;
    /** true if the surface is in a open area */
    this.inopen = false;
    /** true if the surface is in water */
    this.inwater = false;
  }
};

Pmove.ClipNode = class ClipNode { // dclipnode_t
  constructor(planeNum = 0) {
    this.planeNum = planeNum;
    this.children = [0, 0];
  }
};

Pmove.Plane = class Plane { // mplane_t
  constructor() {
    this.normal = new Vector();
    this.dist = 0;
    /** @type {number} for texture axis selection and fast side tests */
    this.type = 0;
    /** @type {number} signx + signy<<1 + signz<<1 */
    this.signBits = 0;
  }
};


Pmove.Hull = class Hull { // hull_t
  constructor() {
    this.clipMins = new Vector();
    this.clipMaxs = new Vector();
    this.firstClipNode = 0;
    this.lastClipNode = 0;
    /** @type {Pmove.ClipNode[]} */
    this.clipNodes = [];
    /** @type {Pmove.Plane[]} */
    this.planes = [];
  }

  static fromDeprecated(hull) {
    const newHull = new Pmove.Hull();
    newHull.clipMins = hull.clip_mins.copy();
    newHull.clipMaxs = hull.clip_maxs.copy();
    newHull.firstClipNode = hull.firstclipnode;
    newHull.lastClipNode = hull.lastclipnode;
    newHull.clipNodes = hull.clipnodes.map((clipnode) => {
      const node = new Pmove.ClipNode(clipnode.planenum);
      node.children[0] = clipnode.children[0];
      node.children[1] = clipnode.children[1];
      return node;
    });
    newHull.planes = hull.planes.map((plane) => {
      const newPlane = new Pmove.Plane();
      newPlane.normal = plane.normal.copy();
      newPlane.dist = plane.dist;
      newPlane.type = plane.type;
      newPlane.signBits = plane.signbits;
      return newPlane;
    });

    return newHull;
  }

  /**
   * Determine if a point is inside the hull and if so, return the content type.
   * @param {Vector} point point to test
   * @param {number} num clip node to start
   * @returns {number} content type
   */
  pointContents(point, num = this.firstClipNode) {
    // as long as num is a valid node, keep going down the tree
    while (num >= 0) {
      console.assert(num >= this.firstClipNode && num <= this.lastClipNode, 'valid hull node', num);

      console.assert(this.clipNodes[num], 'valid hull node', num);
      const node = this.clipNodes[num];

      console.assert(this.planes[node.planeNum], 'valid hull plane', node.planeNum);
      const plane = this.planes[node.planeNum];

      let d = 0;

      if (plane.type < 3) {
        d = point[plane.type] - plane.dist;
      } else {
        d = plane.normal.dot(point) - plane.dist;
      }

      num = node.children[d > 0 ? 0 : 1];
    }

    return num;
  }

  /**
   * Check against hull.
   * @param {number} p1f fraction at p1 (usually 0.0)
   * @param {number} p2f fraction at p2 (usually 1.0)
   * @param {Vector} p1 start point
   * @param {Vector} p2 end point
   * @param {object} trace object to store trace results
   * @param {number} num starting clipnode number (typically hull.firstclipnode)
   * @returns {boolean} true means going down, false means going up
   */
  check(p1f, p2f, p1, p2, trace, num = this.firstClipNode) {
    // check for empty
    if (num < 0) {
      if (num !== Mod.contents.solid) {
        trace.allsolid = false;
        if (num === Mod.contents.empty) {
          trace.inopen = true;
        } else {
          trace.inwater = true;
        }
      } else {
        trace.startsolid = true;
      }
      return true; // going down the tree
    }

    console.assert(num >= this.firstClipNode && num <= this.lastClipNode, 'valid node number', num);

    // find the point distances
    const node = this.clipNodes[num];
    const plane = this.planes[node.planeNum];
    const t1 = (plane.type < 3 ? p1[plane.type] : plane.normal[0] * p1[0] + plane.normal[1] * p1[1] + plane.normal[2] * p1[2]) - plane.dist;
    const t2 = (plane.type < 3 ? p2[plane.type] : plane.normal[0] * p2[0] + plane.normal[1] * p2[1] + plane.normal[2] * p2[2]) - plane.dist;

    // checking children on side 1
    if (t1 >= 0.0 && t2 >= 0.0) {
      return this.check(p1f, p2f, p1, p2, trace, node.children[0]);
    }

    // checking children on side 2
    if (t1 < 0.0 && t2 < 0.0) {
      return this.check(p1f, p2f, p1, p2, trace, node.children[1]);
    }

    // put the crosspoint DIST_EPSILON pixels on the near side
    let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? Pmove.Pmove.DIST_EPSILON : -Pmove.Pmove.DIST_EPSILON)) / (t1 - t2))); // epsilon value of 0.03125 = 1/32
    let midf = p1f + (p2f - p1f) * frac;
    const mid = new Vector(p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2]));
    const side = t1 < 0.0 ? 1 : 0;

    // move up to the node
    if (!this.check(p1f, midf, p1, mid, trace, node.children[side])) {
      return false;
    }

    // go past the node
    if (this.pointContents(mid, node.children[1 - side]) !== Mod.contents.solid) {
      return this.check(midf, p2f, mid, p2, trace, node.children[1 - side]);
    }

    // never got out of the solid area
    if (trace.allsolid) {
      return false;
    }

    // the other side of the node is solid, this is the impact point
    if (side === 0) {
      trace.plane.normal = plane.normal.copy();
      trace.plane.dist = plane.dist;
    } else {
      trace.plane.normal = plane.normal.copy().multiply(-1);
      trace.plane.dist = -plane.dist;
    }

    while (this.pointContents(mid) === Mod.contents.solid) {
      // shouldn't really happen, but does occasionally
      frac -= 0.1;
      if (frac < 0.0) {
        trace.fraction = midf;
        trace.endpos = mid.copy();
        console.warn('fraction < 0.0', frac, trace);
        return;
      }
      midf = p1f + (p2f - p1f) * frac;
      mid[0] = p1[0] + frac * (p2[0] - p1[0]);
      mid[1] = p1[1] + frac * (p2[1] - p1[1]);
      mid[2] = p1[2] + frac * (p2[2] - p1[2]);
    }

    trace.fraction = midf;
    trace.endpos = mid.copy();

    return false;
  }
};

/**
 * Set up the planes and clipnodes so that the six floats of a bounding box
 * can just be stored out and get a proper hull_t structure.
 * To keep everything totally uniform, bounding boxes are turned into small
 * BSP trees instead of being compared directly.
 * Use setSize() to set the box size.
 */
Pmove.BoxHull = class BoxHull extends Pmove.Hull {
  constructor() {
    super();

    this.clipNodes = [
      new Pmove.ClipNode(0),
      new Pmove.ClipNode(1),
      new Pmove.ClipNode(2),
      new Pmove.ClipNode(3),
      new Pmove.ClipNode(4),
      new Pmove.ClipNode(5),
    ];

    this.firstClipNode = 0;
    this.lastClipNode = 5;

    this.planes = [
      new Pmove.Plane(), // 0
      new Pmove.Plane(), // 1
      new Pmove.Plane(), // 2
      new Pmove.Plane(), // 3
      new Pmove.Plane(), // 4
      new Pmove.Plane(), // 5
    ];

    for (let i = 0; i < 6; i++) {
      const side = i & 1;

      this.clipNodes[i].children[side] = Mod.contents.empty;

      this.clipNodes[i].children[side ^ 1] = i !== 5 ? i + 1 : Mod.contents.solid;

      this.planes[i].type = i >> 1;
      this.planes[i].normal = new Vector(1, 1, 1);
    }
  }

  /**
   * @param {Vector} mins mins
   * @param {Vector} maxs maxs
   * @returns {Pmove.BoxHull} this
   */
  setSize(mins, maxs) {
    console.assert(mins instanceof Vector, 'mins must be a Vector');
    console.assert(maxs instanceof Vector, 'maxs must be a Vector');

    for (let i = 0; i < 6; i++) {
      this.planes[i].dist = maxs[i >> 1];
    }

    return this;
  }
}

Pmove.PhysEnt = class PhysEnt { // physent_t
  constructor() {
    /** only for bsp models */
    this.model = null;
    this.origin = new Vector();
    this.mins = new Vector();
    this.maxs = new Vector();
  }
};

Pmove.Pmove = class PlayerMove { // pmove_t
  static DIST_EPSILON = 0.03125;
  static STOP_EPSILON = 0.1;

  static STEPSIZE = 18.0;

  static MAX_CLIP_PLANES = 5;

  static PLAYER_MINS = new Vector(-16.0, -16.0, -24.0);
  static PLAYER_MAXS = new Vector(16.0, 16.0, 32.0);

  constructor() {
    // former global vars
    this.frametime = 0;
    this.waterlevel = 0;
    this.watertype = 0;
    this.onground = 0;

    // player state
    this.origin = new Vector();
    this.velocity = new Vector();
    this.angles = new Vector();
    this.oldbuttons = 0;
    this.waterjumptime = 0.0;
    this.spectator = 0;
    this.dead = false;

    // world state
    /** @type {Pmove.PhysEnt[]} 0 - world */
    this.physents = [];

    // input
    /** @type {?Protocol.UserCmd} */
    this.cmd = null;

    /** @private */
    this.boxHull = new Pmove.Hull().makeBoxHull();
  }

  pointContents(point) {
    console.assert(this.physents[0], 'world');

    const hull = this.physents[0].model.hulls[0]; // world

    console.assert(hull, 'world hull');

    return hull.pointContents(point);
  }

  /**
   * @param {Vector} position player’s origin
   * @returns {boolean} Returns false if the given player position is not valid (in solid)
   */
  testPlayerPosition(position) {
    for (const pe of this.physents) {
      let hull = null;

      if (pe.model && pe.model.hulls) {
        // NOTE: hull 1 is the player hull
        hull = pe.model.hulls[1];
      } else {
        const mins = pe.mins.copy().subtract(Pmove.PlayerMove.PLAYER_MAXS);
        const maxs = pe.maxs.copy().subtract(Pmove.PlayerMove.PLAYER_MINS);
        hull = this.boxHull.setSize(mins, maxs);
      }

      const test = position.copy().subtract(pe.origin);

      if (hull.pointContents(test) === Mod.contents.solid) {
        return false;
      }
    }

    return true;
  }
};


