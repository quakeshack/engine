/* global Vector */

import BaseEntity from "../BaseEntity.mjs";

export const state = {
  STATE_TOP: 0,
  STATE_BOTTOM: 1,
  STATE_UP: 2,
  STATE_DOWN: 3,
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

    this.state = state.STATE_TOP;
    this.lip = 0;
    this.height = 0;
  }

  spawn() {
    this.engine.ConsolePrint(`BasePropEntity: implement me on ${this}, removing entity\n`);
    this.remove();
  }
};
