import Vector from '../../../../shared/Vector.mjs';

import BaseEntity from '../BaseEntity.mjs';
import { Sub } from '../Subs.mjs';

/**
 * used in this.state
 */
export const state = {
  /**
   * end state: open
   */
  STATE_TOP: 0,

  /**
   * end state: closed
   */
  STATE_BOTTOM: 1,

  /**
   * transitioning state: opening
   */
  STATE_UP: 2,

  /**
   * transitioning state closing
   */
  STATE_DOWN: 3,

  /**
   * no action taken in think
   */
  STATE_DONE: -1,
};

export default class BasePropEntity extends BaseEntity {
  _declareFields() {
    super._declareFields();

    this._serializer.startFields();

    /** @type {number} either a cd track number or sound number */
    this.sounds = 0;
    /** @type {?string} contains filename to play */
    this.noise = null;
    /** @type {?string} contains filename to play */
    this.noise1 = null;
    /** @type {?string} contains filename to play */
    this.noise2 = null;
    /** @type {?string} contains filename to play */
    this.noise3 = null;

    // top and bottom positions
    this.pos1 = new Vector();
    this.pos2 = new Vector();

    /** @type {number} @see {state} */
    this.state = state.STATE_TOP;
    /** @type {number} lip size in units */
    this.lip = 0;
    /** @type {number} height in units */
    this.height = 0;

    /** @type {number} time in seconds from firing to restarting */
    this.wait = 0;
    /** @type {number} time in seconds from activation to firing */
    this.delay = 0;
    /** @type {number} speed in units */
    this.speed = 0;

    this._serializer.endFields();

    // we need sub for movement stuff
    this._sub = new Sub(this);
  }

  spawn() {
    console.assert(false, 'Missing spawn implementation');
  }
};
