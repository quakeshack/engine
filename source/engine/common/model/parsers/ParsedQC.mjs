import Q from '../../../../shared/Q.ts';
import Vector from '../../../../shared/Vector.ts';

/** @typedef {import('../../../../shared/GameInterfaces').ParsedQC} IParsedQC */
/** @augments IParsedQC */
export default class ParsedQC {
  /** @type {string} */
  cd = null;
  origin = new Vector();
  /** @type {string} */
  base = null;
  /** @type {string} */
  skin = null;
  /** @type {string[]} */
  frames = [];
  /** @type {Record<string, number[]>} */
  animations = {};
  /** @type {number} */
  scale = 1.0;

  /**
   * @param {string} qcContent qc model source
   * @returns {this} this
   */
  parseQC(qcContent) {
    console.assert(typeof qcContent === 'string', 'qcContent must be a string');

    const lines = qcContent.trim().split('\n');

    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }

      const parts = line.split(/\s+/);
      const [key, value] = [parts.shift(), parts.join(' ')];

      switch (key) {
        case '$cd':
          this.cd = value;
          break;

        case '$origin':
          this.origin = new Vector(...value.split(/\s+/).map((n) => Q.atof(n)));
          break;

        case '$base':
          this.base = value;
          break;

        case '$skin':
          this.skin = value;
          break;

        case '$scale':
          this.scale = +value;
          break;

        case '$frame': {
          const frames = value.split(/\s+/);

          this.frames.push(...frames);

          for (const frame of frames) {
            const matches = frame.match(/^([^0-9]+)([0-9]+)$/);

            if (matches) {
              if (!this.animations[matches[1]]) {
                this.animations[matches[1]] = [];
              }

              this.animations[matches[1]].push(this.frames.indexOf(matches[0]));
            }
          }
        }
          break;

        default:
          console.assert(false, 'QC field unknown', key);
      }
    }

    return this;
  }
};
