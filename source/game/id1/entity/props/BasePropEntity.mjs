/* global Vector */

import BaseEntity from "../BaseEntity.mjs";

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
  STATE_DONE: -1
};

export default class BasePropEntity extends BaseEntity {
  _declareFields() {
    this.sounds = 0; // either a cd track number or sound number
    this.noise = null; // contains names of wavs to play
    this.noise1 = null; // contains names of wavs to play
    this.noise2 = null; // contains names of wavs to play
    this.noise3 = null; // contains names of wavs to play

    // top and bottom positions
    this.pos1 = new Vector();
    this.pos2 = new Vector();

    /** @type {state} */
    this.state = state.STATE_TOP;
    this.nextstate = state.STATE_DONE;
    this.lip = 0;
    this.height = 0;

    this.wait = 0; // time from firing to restarting
    this.delay = 0; // time from activation to firing
  }

  spawn() {
    this.engine.ConsolePrint(`BasePropEntity: implement me on ${this}, removing entity\n`);
    this.remove();
  }
};
