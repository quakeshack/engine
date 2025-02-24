/* global Vector */

import BaseEntity from "./BaseEntity.mjs";

/**
 * QUAKED info_intermission (1 0.5 0.5) (-16 -16 -16) (16 16 16)
 * This is the camera point for the intermission.
 * Use mangle instead of angle, so you can set pitch or roll as well as yaw.  'pitch roll yaw'
 */
export class IntermissionCameraEntity extends BaseEntity {
  static classname = 'info_intermission';

  _declareFields() {
    this.mangle = new Vector();
  }
};
