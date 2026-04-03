import type { SerializableType } from '../../shared/GameInterfaces.ts';

import Vector from '../../shared/Vector.ts';

/**
 * Stores the per-entity network state used for delta compression.
 */
export class ServerEntityState {
  num: number | null;
  flags: number;
  readonly origin: Vector;
  readonly angles: Vector;
  modelindex: number;
  frame: number;
  colormap: number;
  skin: number;
  effects: number;
  alpha: number;
  solid: number;
  free: boolean;
  classname: string | null;
  readonly mins: Vector;
  readonly maxs: Vector;
  readonly velocity: Vector;
  nextthink: number;
  readonly extended: Record<string, SerializableType>;

  constructor(num: number | null = null) {
    this.num = num;
    this.flags = 0;
    this.origin = new Vector(Infinity, Infinity, Infinity);
    this.angles = new Vector(Infinity, Infinity, Infinity);
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.alpha = 1.0;
    this.solid = 0;
    this.free = false;
    this.classname = null;
    this.mins = new Vector();
    this.maxs = new Vector();
    this.velocity = new Vector(0, 0, 0);
    this.nextthink = 0;
    this.extended = {};
  }

  /**
   * Copies the full state from another entity snapshot.
   */
  set(other: ServerEntityState): void {
    this.num = other.num;
    this.flags = other.flags;
    this.origin.set(other.origin);
    this.angles.set(other.angles);
    this.velocity.set(other.velocity);
    this.modelindex = other.modelindex;
    this.frame = other.frame;
    this.colormap = other.colormap;
    this.skin = other.skin;
    this.effects = other.effects;
    this.alpha = other.alpha;
    this.solid = other.solid;
    this.free = other.free;
    this.classname = other.classname;
    this.mins.set(other.mins);
    this.maxs.set(other.maxs);
    this.nextthink = other.nextthink;

    for (const [key, value] of Object.entries(other.extended)) {
      this.extended[key] = value;
    }
  }

  /**
   * Marks the state as free and restores the default baseline values.
   */
  freeEdict(): void {
    this.free = true;
    this.flags = 0;
    this.angles.setTo(Infinity, Infinity, Infinity);
    this.origin.setTo(Infinity, Infinity, Infinity);
    this.velocity.setTo(0, 0, 0);
    this.nextthink = 0;
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.alpha = 1.0;
    this.solid = 0;
    this.classname = null;
  }
}
