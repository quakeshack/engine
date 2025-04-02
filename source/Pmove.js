/* global Mod, Pmove, Protocol, SV, Vector */

/**
 * Pmove is a reimplementation of the QuakeWorld’s player movement code.
 * Original sources are: pmove.c, pmovetst.c
 */
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
    /** @type {?number} edict number the surface is on, if applicable */
    this.ent = null;
    /** true if the surface is in a open area */
    this.inopen = false;
    /** true if the surface is in water */
    this.inwater = false;
  }

  /**
   * Sets this trace to the other trace.
   * @param {Pmove.Trace} other other trace
   * @returns {Pmove.Trace} this
   */
  set(other) {
    console.assert(other instanceof Pmove.Trace, 'other must be a Trace');

    this.allsolid = other.allsolid;
    this.startsolid = other.startsolid;
    this.fraction = other.fraction;
    this.endpos.set(other.endpos);
    this.plane.normal.set(other.plane.normal);
    this.plane.dist = other.plane.dist;
    this.ent = other.ent;
    this.inopen = other.inopen;
    this.inwater = other.inwater;

    return this;
  }

  /**
   * Creates a copy.
   * @returns {Pmove.Trace} copy of this trace
   */
  copy() {
    const trace = new Pmove.Trace();
    trace.set(this);
    return trace;
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

  static fromModelHull(hull) {
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
  /** @type {Pmove.Pmove} */
  constructor(pmove) {
    /** only for bsp models @type {Pmove.Hulls[]} */
    this.hulls = [];
    /** origin */
    this.origin = new Vector();
    /** only for non-bsp models */
    this.mins = new Vector();
    /** only for non-bsp models */
    this.maxs = new Vector();
    /** actual edict index, used to map back to edicts @type {?number} */
    this.edictId = null;

    /** @private */
    this._pmove_wf = new WeakRef(pmove);
  }

  /** @returns {Pmove.Pmove} pmove @private */
  get _pmove() {
    return this._pmove_wf.deref();
  }

  /**
   * Returns clipping hull for this entity.
   * NOTE: This is not async/wait safe, since it will modify pmove’s boxHull in-place.
   * @returns {Pmove.Hull} hull
   */
  getClippingHull() {
    if (this.hulls.length > 0) {
      return this.hulls[Mod.hull.player];
    }

    const mins = this.mins.copy().subtract(Pmove.Pmove.PLAYER_MAXS);
    const maxs = this.maxs.copy().subtract(Pmove.Pmove.PLAYER_MINS);

    return this._pmove.boxHull.setSize(mins, maxs);
  }

  // CR: we can add getClippingHullCrouch() for BSP30 hulls here later
};

Pmove.PmovePlayer = class PlayerMovePlayer { // pmove_t (player state only)
  constructor(pmove) {
    // former global vars
    this.frametime = 0;
    this.waterlevel = 0;
    this.watertype = 0;

    /** @type {?number} ground edict number. null, if not applicable */
    this.onground = null;

    // player vars
    this.origin = new Vector();
    this.velocity = new Vector();
    this.angles = new Vector();
    this.oldbuttons = 0;
    this.waterjumptime = 0.0;
    this.spectator = 0;
    this.dead = false;

    /** @type {?Protocol.UserCmd} */
    this.cmd = null;

    /** @type {number[]} list of touched edict numbers */
    this.touchindices = [];

    /** @type {Vector.DirectionalVectors} @private */
    this._angleVectors = null;

    /** @private */
    this._pmove_wf = new WeakRef(pmove);
  }

  /** @returns {Pmove.Pmove} pmove @private */
  get _pmove() {
    return this._pmove_wf.deref();
  }

  move() { // pmove.c/PlayerMove
    console.assert(this.cmd instanceof Protocol.UserCmd, 'valid cmd');
    this.frametime = this.cmd.msec / 1000.0;
    this.touchindices = [];

    this._angleVectors = this.angles.angleVectors();

    if (this.spectator) {
      this._spectatorMove();
      return;
    }

    this._nudgePosition();

    // take angles directly from command
    this.angles.set(this.cmd.angles);

    // set onground, watertype, and waterlevel
    this._categorizePosition();

    if (this.waterlevel == 2) {
      this._checkWaterJump();
    }

    if (this.velocity[2] < 0) {
      this.waterjumptime = 0;
    }

    if (this.cmd.buttons & Protocol.button.jump) {
      this._jumpButton();
    } else {
      this.oldbuttons &= ~Protocol.button.jump;
    }

    this._friction();

    if (this.waterlevel >= 2) {
      this._waterMove();
    } else {
      this._airMove();
    }

    // set onground, watertype, and waterlevel for final spot
    this._categorizePosition();
  }

  _jumpButton() { // pmove.c/JumpButton
    if (this.dead) {
      this.oldbuttons |= Protocol.button.jump; // do not jump again until released
      return;
    }

    if (this.waterjumptime) {
      this.waterjumptime -= this.frametime;

      if (this.waterjumptime < 0) {
        this.waterjumptime = 0;
      }

      return;
    }

    if (this.waterlevel >= 2) {
      this.onground = null;

      switch (this.watertype) {
        case Mod.contents.water:
          this.velocity[2] = 100;
          break;

        case Mod.contents.slime:
          this.velocity[2] = 80;
          break;

        default:
          this.velocity[2] = 50;
      }
    }

    if (this.onground === null) {
      return; // in air or water, no effect
    }

    if (this.oldbuttons & Protocol.button.jump) {
      return; // already jumping
    }

    this.onground = null;
    this.velocity[2] += 270; // jump height

    this.oldbuttons |= Protocol.button.jump; // do not jump again until released
  }

  _checkWaterJump() { // pmove.c/CheckWaterJump
    if (this.waterjumptime) {
      return;
    }

    if (this.velocity[2] < -180) {
      // only hop out if we are moving up
      return;
    }

    // see if near an edge
    const flatforward = new Vector(this._angleVectors.forward[0], this._angleVectors.forward[1], 0);
    flatforward.normalize();

    const spot = this.origin.copy().add(flatforward.copy().multiply(24));

    spot[2] += 8.0;

    let contents = this._pmove.pointContents(spot);

    if (contents !== Mod.contents.solid) {
      return;
    }

    spot[2] += 24.0;

    contents = this._pmove.pointContents(spot);

    if (contents !== Mod.contents.empty) {
      return;
    }

    // jump out of water
    this.velocity.set(flatforward).multiply(50);
    this.velocity[2] = 310;
    this.waterjumptime = 2; // safety net
    this.oldbuttons |= Protocol.button.jump; // don't jump again until released
  }

  _categorizePosition() { // pmove.c/PM_CatagorizePosition
    const point = new Vector();

    // if the player hull point one unit down is solid, the player is on ground
    // see if standing on something solid

    point.set(this.origin);
    point[2] -= 1.0;

    if (this.velocity[2] > 180) {
      this.onground = null;
    } else {
      const trace = this._pmove.clipPlayerMove(this.origin, point);

      if (trace.plane.normal[2] < 0.7) {
        this.onground = null; // too steep
      } else {
        this.onground = trace.ent;
      }

      if (this.onground !== null) {
        this.waterjumptime = 0.0;

        if (!trace.startsolid && !trace.allsolid) {
          this.origin.set(trace.endpos);
        }
      }

      if (trace.ent !== null) {
        this.touchindices.push(trace.ent);
      }
    }

    // determine water level

    this.waterlevel = 0;
    this.watertype = Mod.contents.empty;

    point[2] = this.origin[2] + Pmove.Pmove.PLAYER_MINS[2] + 1.0;

    let contents = this._pmove.pointContents(point);

    if (contents <= Mod.contents.water) {
      this.watertype = contents;
      this.waterlevel = 1;

      point[2] = this.origin[2] + (Pmove.Pmove.PLAYER_MINS[2] + Pmove.Pmove.PLAYER_MAXS[2]) / 2.0;

      contents = this._pmove.pointContents(point);

      if (contents <= Mod.contents.water) {
        this.waterlevel = 2;

        point[2] = this.origin[2] + 22; // CR: 22 is z component of view_ofs, FIXME

        contents = this._pmove.pointContents(point);

        if (contents <= Mod.contents.water) {
          this.waterlevel = 3;
        }
      }
    }
  }

  /**
   * If pmove.origin is in a solid position,
   * try nudging slightly on all axis to
   * allow for the cut precision of the net coordinates
   */
  _nudgePosition() { // pmove.c/NudgePosition
    const sign = new Vector(0, -1, 1);
    const base = this.origin.copy();

    for (let i = 0; i < 3; i++) {
      this.origin[i] = Math.floor(this.origin[i] * 8.0) / 8.0;
    }

    for (let z = 0; z < 3; z++) {
      for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
          this.origin[0] = base[0] + sign[x] * (1.0 / 8.0);
          this.origin[1] = base[1] + sign[y] * (1.0 / 8.0);
          this.origin[2] = base[2] + sign[z] * (1.0 / 8.0);

          if (this._pmove.isValidPlayerPosition(this.origin)) {
            return;
          }
        }
      }
    }

    this.origin.set(base);
  }

  /**
   * Player is on ground, with no upwards velocity
   */
  _groundMove() { // pmove.c/PM_GroundMove
    this.velocity[2] = 0.0;

    if (this.velocity.isOrigin()) {
      // no momentum
      return;
    }

    // straight move on the ground
    const dest = this.origin.copy();
    dest[0] += this.velocity[0] * this.frametime;
    dest[1] += this.velocity[1] * this.frametime;

    const trace = this._pmove.clipPlayerMove(this.origin, dest);

    if (trace.fraction === 1.0) {
      // moved the entire distance without clipping
      this.origin.set(trace.endpos);
      return;
    }

    // try sliding along the ground and up 16 units
    const originalOrigin = this.origin.copy();
    const originalVelocity = this.velocity.copy();

    // slide move
    this._flyMove();

    const downPos = this.origin.copy();
    const downVelo = this.velocity.copy();

    this.origin.set(originalOrigin);
    this.velocity.set(originalVelocity);

    // move up a step
    dest.set(this.origin);
    dest[2] += Pmove.Pmove.STEPSIZE;

    const upTrace = this._pmove.clipPlayerMove(this.origin, dest);

    if (!upTrace.startsolid && !upTrace.allsolid) {
      // moved up a step
      this.origin.set(upTrace.endpos);
    }

    // slide move again
    this._flyMove();

    // correct step height
    dest.set(this.origin);
    dest[2] -= Pmove.Pmove.STEPSIZE;

    const stepTrace = this._pmove.clipPlayerMove(this.origin, dest);

    if (stepTrace.plane.normal[2] < 0.7) { // 0.7 ~ 45 degrees
      // not too steep
      this.origin.set(downPos);
      this.velocity.set(downVelo);
      return;
    }

    if (!stepTrace.startsolid && !stepTrace.allsolid) {
      // moved down a step
      this.origin.set(stepTrace.endpos);
    }

    const upPos = this.origin.copy();

    const downDist = downPos.copy().subtract(originalOrigin).len();
    const upDist = upPos.copy().subtract(originalOrigin).len();

    // sliding down
    if (downDist > upDist) {
      this.origin.set(downPos);
      this.velocity.set(downVelo);
      return;
    }

    // only look at the z-axis of the sliding down movement
    this.velocity[2] = downVelo[2];
  }

  _friction() { // pmove.c/PM_Friction
    if (this.waterjumptime) {
      return;
    }

    const speed = this.velocity.len();

    if (speed < 1) {
      this.velocity[0] = 0;
      this.velocity[1] = 0;
      return;
    }

    let friction = this._pmove.movevars.friction;

    // if the leading edge is over a dropoff, increase friction
    if (this.onground !== null) {
      const start = new Vector();
      const end = new Vector();
      start[0] = end[0] = this.origin[0] + this.velocity[0] / speed * 16;
      start[1] = end[1] = this.origin[1] + this.velocity[1] / speed * 16;
      start[2] = this.origin[2] + Pmove.Pmove.PLAYER_MINS[2];
      stop[2] = start[2] - 34; // CR: absolutely no clue where 34 is coming from

      const trace = this._pmove.clipPlayerMove(start, end);

      if (trace.fraction === 1.0) {
        friction *= 2;
      }
    }

    let drop = 0;

    if (this.waterlevel >= 2) { // apply water friction
      drop += speed * this._pmove.movevars.waterfriction * this.waterlevel * this.frametime;
    } else if (this.onground !== null) { // apply ground friction
      const control = Math.max(this._pmove.movevars.stopspeed, speed); // CR: inaccurate porting
      drop += control * friction * this.frametime;
    }

    // scale the velocity
    const newspeed = Math.max(speed - drop, 0) / speed;

    this.velocity.multiply(newspeed);
  }

  _clipVelocity(veloIn, normal, veloOut, overbounce) { // pmove.c/PM_ClipVelocity
    let blocked = 0;

    if (normal[2] > 0) {
      blocked |= 1; // floor
    } else if (normal[2] === 0) {
      blocked |= 2; // step
    }

    const backoff = veloIn.dot(normal) * (overbounce ? 1 : 1.0);

    let change = 0;

    for (let i = 0; i < 3; i++) {
      change = normal[i] * backoff;
      veloOut[i] = veloIn[i] - change;
      if (Math.abs(veloOut[i]) < Pmove.Pmove.STOP_EPSILON) { // CR: inaccurate porting
        veloOut[i] = 0;
      }
    }

    return blocked;
  }

  _accelerate(wishdir, wishspeed, accel) { // pmove.c/PM_Accelerate
    if (this.dead || this.waterjumptime) {
      return;
    }

    const currentspeed = this.velocity.dot(wishdir);

    let addspeed = wishspeed - currentspeed;

    if (addspeed <= 0) {
      return;
    }

    const accelspeed = Math.min(accel * this.frametime * wishspeed, addspeed); // CR: inaccurate porting

    this.velocity.add(wishdir.copy().multiply(accelspeed));
  }

  _airAccelerate(wishdir, wishspeed, accel) { // pmove.c/PM_AirAccelerate
    // CR:  this is basically like _accelerate but has a wishspeed limit of 30,
    //      funny enough this function leads to a bug where you can still
    //      accelerate faster in air, Quake 2 has it fixed

    if (this.dead || this.waterjumptime) {
      return;
    }

    const wishspeed2 = Math.min(wishspeed, 30);

    const currentspeed = this.velocity.dot(wishdir);

    let addspeed = wishspeed2 - currentspeed;

    if (addspeed <= 0) {
      return;
    }

    const accelspeed = Math.min(accel * this.frametime * wishspeed, addspeed); // CR: inaccurate porting

    this.velocity.add(wishdir.copy().multiply(accelspeed));
  }

  /**
   * The basic solid body movement clip that slides along multiple planes
   * @returns {number} bitmap: 1 = floor, 2 = step
   */
  _flyMove() { // pmove.c/PM_FlyMove
    const bumps = 4;
    let blocked = 0;

    const velocityOriginal = this.velocity.copy();
    const velocityPrimal = this.velocity.copy();

    let planes = [];
    let timeLeft = this.frametime;

    for (let i = 0; i < bumps; i++) {
      const end = this.origin.copy().add(this.velocity.copy().multiply(timeLeft));

      const trace = this._pmove.clipPlayerMove(this.origin, end);

      // hard stop
      if (trace.allsolid || trace.startsolid) {
        this.velocity.clear();
        return 3;
      }

      if (trace.fraction > 0) {
        this.origin.set(trace.endpos);
        planes = [];
      }

      if (trace.fraction === 1) {
        break; // moved the entire distance
      }

      this.touchindices.push(trace.ent);

      if (trace.plane.normal[2] > 0.7) {
        blocked |= 1; // floor
      }

      if (trace.plane.normal[2] === 0) {
        blocked |= 2; // step
      }

      timeLeft -= timeLeft * trace.fraction;

      if (planes.length >= Pmove.Pmove.MAX_CLIP_PLANES) {
        console.warn('PlayerMovePlayer._flyMove: exceeded max planes', planes.length);
        this.velocity.clear();
        break; // too many planes
      }

      planes.push(trace.plane.normal.copy());

      // modify original_velocity so it parallels all of the clip planes
      let j;
      for (j = 0; j < planes.length; j++) {
        this._clipVelocity(velocityOriginal, planes[i], this.velocity, 1.0);

        let k;
        for (k = 0; k < planes.length; k++) {
          if (k !== j) {
            if (this.velocity.dot(planes[k]) < 0) {
              break; // not okay
            }
          }
        }

        if (k === planes.length) {
          break; // okay
        }
      }

      if (j === planes.length) {
        // go along this plane
        // CR: no code
      } else {
        // go along the crease
        if (planes.length !== 2) {
          this.velocity.clear();
          return;
        }
      }

      // if original velocity is against the original velocity, stop dead
      // to avoid tiny occilations in sloping corners
      if (velocityPrimal.dot(this.velocity) <= 0) {
        this.velocity.clear();
        break;
      }
    }

    if (this.waterjumptime) {
      this.velocity.set(velocityPrimal);
    }

    return blocked;
  }

  _waterMove() { // pmove.c/PM_WaterMove
    const wishvel = new Vector();

    // user intentions
    for (let i = 0; i < 3; i++) {
      wishvel[i] = this._angleVectors.forward[i] * this.cmd.forwardmove + this._angleVectors.right[i] * this.cmd.sidemove;
    }

    if (!this.cmd.forwardmove && !this.cmd.sidemove && !this.cmd.upmove) {
      wishvel[2] -= 60;
    } else {
      wishvel[2] += this.cmd.upmove;
    }

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.len();

    // clamp to server defined max speed
    if (wishspeed > this._pmove.movevars.maxspeed) {
      wishvel.multiply(this._pmove.movevars.maxspeed / wishspeed);
      wishspeed = this._pmove.movevars.maxspeed;
    }

    wishspeed *= 0.7;

    // water acceleration
    this._accelerate(wishdir, wishspeed, this._pmove.movevars.wateraccelerate);

    // assume it is a stair or a slope, so press down from stepheight above
    const dest = this.velocity.copy().multiply(this.frametime).add(this.origin);
    const start = dest.copy();

    start[2] += Pmove.Pmove.STEPSIZE + 1;

    const trace = this._pmove.clipPlayerMove(start, dest);

    if (!trace.allsolid && !trace.startsolid) { // FIXME: check steep slope?
      this.origin.set(trace.endpos);
      return;
    }

    this._flyMove();
  }

  _airMove() { // pmove.c/PM_AirMove
    const fmove = this.cmd.forwardmove;
    const smove = this.cmd.sidemove;

    this._angleVectors.forward[2] = 0;
    this._angleVectors.right[2] = 0;

    this._angleVectors.forward.normalize();
    this._angleVectors.right.normalize();

    const wishvel = new Vector(
      this._angleVectors.forward[0] * fmove + this._angleVectors.right[0] * smove,
      this._angleVectors.forward[1] * fmove + this._angleVectors.right[1] * smove,
      0,
    );

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.len();

    // clamp to server defined max speed
    if (wishspeed > this._pmove.movevars.maxspeed) {
      wishvel.multiply(this._pmove.movevars.maxspeed / wishspeed);
      wishspeed = this._pmove.movevars.maxspeed;
    }

    if (this.onground !== null) {
      this.velocity[2] = 0;
      this._accelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);
      this.velocity[2] -= this._pmove.movevars.entgravity * this._pmove.movevars.gravity * this.frametime;
      this._groundMove();
    } else {
      // not on ground, so little effect on velocity
      this._airAccelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);

      // add gravity
      this.velocity[2] -= this._pmove.movevars.entgravity * this._pmove.movevars.gravity * this.frametime;

      this._flyMove();
    }
  }

  _spectatorMove() { // pmove.c/SpectatorMove
    // TODO
  }
}

/**
 * PlayerMove class.
 * This class is used to move the player in the world and also predict movement on the client side.
 */
Pmove.Pmove = class PlayerMove { // pmove_t
  static DIST_EPSILON = 0.03125;
  static STOP_EPSILON = 0.1;

  static STEPSIZE = 18.0;

  static MAX_CLIP_PLANES = 5;

  static PLAYER_MINS = new Vector(-16.0, -16.0, -24.0);
  static PLAYER_MAXS = new Vector(16.0, 16.0, 32.0);

  static MAX_PHYSENTS = 32;

  constructor() {
    // world state
    /** @type {Pmove.PhysEnt[]} 0 - world */
    this.physents = [];

    /** @private */
    this.boxHull = new Pmove.BoxHull();
  }

  pointContents(point) {
    console.assert(this.physents[0] instanceof Pmove.PhysEnt, 'world physent');

    const hull = this.physents[0].hulls[Mod.hull.normal]; // world
    console.assert(hull instanceof Pmove.Hull, 'world hull');

    return hull.pointContents(point);
  }

  /**
   * @param {Vector} position player’s origin
   * @returns {boolean} Returns false if the given player position is not valid (in solid)
   */
  isValidPlayerPosition(position) {
    for (const pe of this.physents) {
      const hull = pe.getClippingHull();
      console.assert(hull instanceof Pmove.Hull, 'physent hull');

      const test = position.copy().subtract(pe.origin);

      if (hull.pointContents(test) === Mod.contents.solid) {
        return false;
      }
    }

    return true;
  }

  /**
   * Attempts to move the player from start to end.
   * @param {Vector} start starting point
   * @param {Vector} end end point (e.g. start + velocity * frametime)
   * @returns {Pmove.Trace} trace object
   */
  clipPlayerMove(start, end) {
    const totalTrace = new Pmove.Trace();

    totalTrace.endpos.set(end);

    for (let i = 0; i < this.physents.length; i++) {
      const pe = this.physents[i];
      const hull = pe.getClippingHull();
      console.assert(hull instanceof Pmove.Hull, 'physent hull');

      const offset = pe.origin.copy();

      const start_l = start.copy().subtract(offset);
      const end_l = end.copy().subtract(offset);

      // fill in a default trace
      const trace = new Pmove.Trace();
      trace.endpos.set(end);

      // trace a line through the apropriate clipping hull
      hull.check(0.0, 1.0, start_l, end_l, trace);

      if (trace.allsolid) {
        trace.startsolid = true;
      }

      if (trace.startsolid) {
        trace.fraction = 0.0;
      }

      // did we clip the move?
      if (trace.fraction < totalTrace.fraction) {
        // fix trace up by the offset
        trace.endpos.add(offset);
        totalTrace.set(trace);
        totalTrace.ent = i;
      }
    }

    return totalTrace;
  }

  /**
   * Sets worldmodel.
   * This will automatically reset all physents.
   * @param {*} model worldmodel
   * @returns {Pmove.Pmove} this
   */
  setWorldmodel(model) {
    console.assert(model, 'model');
    console.assert(model.hulls instanceof Array, 'model hulls');

    this.physents = [];

    const pe = new Pmove.PhysEnt(this);

    for (const modelHull of model.hulls) {
      pe.hulls.push(Pmove.Hull.fromModelHull(modelHull));
    }

    this.physents.push(pe);

    return this;
  }

  /**
   * Adds an entity (client or server) to physents.
   * @param {EntityInterface} entity actual entity
   * @param {?Model} model model must be provided when entity is SOLID_BSP
   * @returns {Pmove.Pmove} this
   */
  addEntity(entity, model = null) {
    const pe = new Pmove.PhysEnt(this);

    console.assert(entity.origin instanceof Vector, 'valid entity origin', entity.origin);

    pe.origin.set(entity.origin);

    if (model !== null) {
      for (const modelHull of model.hulls) {
        pe.hulls.push(Pmove.Hull.fromModelHull(modelHull));
      }
    } else {
      console.assert(entity.mins instanceof Vector, 'valid entity mins', entity.mins);
      console.assert(entity.maxs instanceof Vector, 'valid entity maxs', entity.maxs);

      pe.mins.set(entity.mins);
      pe.maxs.set(entity.maxs);
    }

    if (entity.edictId !== undefined) {
      pe.edictId = entity.edictId;
    }

    this.physents.push(pe);

    return this;
  }

  newPlayerMove() {
    return new Pmove.PmovePlayer(this);
  }
};

Pmove.TestServerside = function() {
  const pm = new Pmove.Pmove();

  pm.setWorldmodel(SV.server.worldmodel);

  console.assert(pm.physents[0] instanceof Pmove.PhysEnt, 'world physent is present');
  console.assert(pm.physents[0].hulls.length === SV.server.worldmodel.hulls.length, 'all hulls copied');

  // we add entities and check if they have been added properly
  for (let i = 1; i < SV.server.num_edicts; i++) {
    const entity = SV.server.edicts[i].entity;

    pm.addEntity(entity, entity.solid === SV.solid.bsp ? SV.server.models[entity.modelindex] : null);

    console.assert(pm.physents[i].origin.equals(entity.origin), 'origin must match');
    console.assert(pm.physents[i].edictId === i, 'edictId must match');
  }

  // we added all entities (for testing purposes)
  console.assert(pm.physents.length === SV.server.num_edicts, 'all entities plus world are added');

  const origin = SV.server.edicts[1].entity.origin;
  console.assert(pm.isValidPlayerPosition(origin), 'current player position must be asserted as valid');

  // Test PlayerMove 64 units into the void
  const playerMoveTraceIntoSpace = pm.clipPlayerMove(origin, new Vector(origin[0], origin[1], 999999));
  console.assert(playerMoveTraceIntoSpace instanceof Pmove.Trace, 'playerMoveTrace is a Trace');
  console.assert(playerMoveTraceIntoSpace.ent === 0, 'trace stopped at world');
  console.assert(playerMoveTraceIntoSpace.fraction < 1.0, 'fraction cannot be 1.0');

  // Test PlayerMove 64 units above the player
  const playerMoveTraceHigher = pm.clipPlayerMove(origin, new Vector(origin[0], origin[1], origin[2] + 64.0));
  console.assert(playerMoveTraceHigher instanceof Pmove.Trace, 'playerMoveTrace is a Trace');
  console.assert(playerMoveTraceHigher.ent === null, 'trace stopped in air');
  console.assert(playerMoveTraceHigher.fraction === 1.0, 'fraction must be 1.0');

  return pm;
};

