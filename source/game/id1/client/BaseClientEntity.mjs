import Vector from '../../../shared/Vector.mjs';

export class BaseClientEntity {
  static classname = 'BaseClientEntity';

  get classname() {
    return this.constructor.classname;
  }

  constructor() {
    this.flags = 0; // nolerp, etc.
    this.frame = 0;
    this.modelindex = 0;
    this.colormap = 0;
    this.skinnum = 0;
    this.effects = 0;

    this.origin = new Vector();
    this.angles = new Vector();
  }

  think() {

  }

  emit() {

  }
};
