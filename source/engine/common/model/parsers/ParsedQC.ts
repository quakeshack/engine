import type { ParsedQC as ParsedQCShape } from '../../../../shared/GameInterfaces.ts';

import Q from '../../../../shared/Q.ts';
import Vector from '../../../../shared/Vector.ts';

/**
 * Parsed representation of a QuakeC model `.qc` source file.
 */
export default class ParsedQC implements ParsedQCShape {
  cd = '';
  origin = new Vector();
  base: string | null = null;
  skin: string | null = null;
  frames: string[] = [];
  animations: Record<string, number[]> = {};
  scale = 1.0;

  /**
   * Parse QC model source into a structured representation.
   * @returns This parsed QC instance.
   */
  parseQC(qcContent: string): this {
    console.assert(typeof qcContent === 'string', 'qcContent must be a string');

    const lines = qcContent.trim().split('\n');

    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }

      const parts = line.split(/\s+/);
      const key = parts.shift();
      const value = parts.join(' ');

      switch (key) {
        case '$cd':
          this.cd = value;
          break;

        case '$origin':
          this.origin = new Vector(...value.split(/\s+/).map((component) => Q.atof(component)));
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
}
