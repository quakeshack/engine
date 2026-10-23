import type { ConsoleOutput } from '../../Services.ts';
import { SpriteBlend, SpriteDirection, SpriteFilter, SpriteOrientation, SpritePhase, type SpriteRegion } from './SpriteTypes.ts';

/** A color that makes the pixels matching it transparent. */
export interface SpriteColorKey {
  /** Red, green and blue, 0 to 255. */
  readonly color: readonly [number, number, number];
  /** How far a channel may be from the key and still match, 0 to 255. */
  readonly tolerance: number;
}

/** A named range of images that a sidecar makes selectable with the entity's `frame`. */
export interface SpriteSidecarSequence {
  readonly name: string;
  /** Index of the first image, `null` for the first of the file. */
  readonly from: number | null;
  /** Index of the last image (included), `null` for the last of the file. */
  readonly to: number | null;
  readonly direction: SpriteDirection | null;
  /** Plays, 0 for forever, `null` for what the whole file does. */
  readonly repeat: number | null;
  /** Frames per second of this sequence, `null` for the timing of the file. */
  readonly fps: number | null;
}

/**
 * What a sprite's `<file>.json` says. Every setting is optional; `null` means "not set" and leaves it to the
 * defaults of the format. The reference is in `docs/sprites.md`.
 */
export interface SpriteSidecar {
  readonly orientation: SpriteOrientation | null;
  /** The pixel of the image that sits on the entity's origin, counted from the top left corner. */
  readonly origin: readonly [number, number] | null;
  /** World units per pixel. */
  readonly scale: number;
  readonly blend: SpriteBlend | null;
  readonly filter: SpriteFilter | null;
  readonly phase: SpritePhase | null;
  readonly interpolate: boolean | null;
  /** Whether the sprite is shaded by the light of the map at its origin. */
  readonly lit: boolean | null;
  /** Frames per second for every image, replacing the timing of the file. */
  readonly fps: number | null;
  /** Plays of the whole animation, 0 for forever, replacing the count of the file. */
  readonly repeat: number | null;
  readonly colorKey: SpriteColorKey | null;
  readonly sequences: readonly SpriteSidecarSequence[] | null;
  /** Named rectangles in pixels, for drawing a part of the image in 2D. They win over the file's own (Aseprite slices). */
  readonly regions: ReadonlyMap<string, SpriteRegion>;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const ORIENTATIONS: Readonly<Record<string, SpriteOrientation>> = {
  parallelUpright: SpriteOrientation.parallelUpright,
  facingUpright: SpriteOrientation.facingUpright,
  parallel: SpriteOrientation.parallel,
  oriented: SpriteOrientation.oriented,
  parallelOriented: SpriteOrientation.parallelOriented,
};

const SETTINGS = ['version', 'orientation', 'origin', 'scale', 'blend', 'filter', 'phase', 'interpolate', 'lit', 'fps', 'repeat', 'colorKey', 'sequences', 'regions'];
const SEQUENCE_SETTINGS = ['name', 'from', 'to', 'direction', 'repeat', 'fps'];
const COLOR_KEY_SETTINGS = ['color', 'tolerance'];

/**
 * Reads the optional `<file>.json` next to an image sprite. A file that does not parse, a value of the wrong
 * type and a setting nobody knows are reported on the console and left out; the sprite still loads.
 */
export class SpriteSidecars {
  /** No sidecar: every setting at the default of the format. */
  static readonly EMPTY: SpriteSidecar = Object.freeze({
    orientation: null,
    origin: null,
    scale: 1,
    blend: null,
    filter: null,
    phase: null,
    interpolate: null,
    lit: null,
    fps: null,
    repeat: null,
    colorKey: null,
    sequences: null,
    regions: new Map<string, SpriteRegion>(),
  });

  /**
   * @param text The content of the sidecar file.
   * @param name Name of the sidecar file, for messages.
   * @param con Where problems are reported.
   * @returns The settings that are valid.
   */
  static parse(text: string, name: string, con: ConsoleOutput): SpriteSidecar {
    let root: JsonValue;

    try {
      root = JSON.parse(text) as JsonValue;
    } catch (error) {
      con.PrintWarning(`${name}: not valid JSON (${error instanceof Error ? error.message : String(error)}), the sidecar is ignored\n`);
      return SpriteSidecars.EMPTY;
    }

    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      con.PrintWarning(`${name}: the sidecar has to be a JSON object, it is ignored\n`);
      return SpriteSidecars.EMPTY;
    }

    const reader = new SettingsReader(root, name, con);

    reader.reportUnknown(SETTINGS);

    if (root['version'] !== undefined && root['version'] !== 1) {
      con.PrintWarning(`${name}: unknown version ${JSON.stringify(root['version'])}, reading it as version 1\n`);
    }

    return {
      orientation: reader.choice('orientation', ORIENTATIONS),
      origin: SpriteSidecars.#readOrigin(reader),
      scale: reader.number('scale', { min: 0, exclusiveMin: true }) ?? 1,
      blend: reader.choice('blend', SpriteBlend),
      filter: reader.choice('filter', SpriteFilter),
      phase: reader.choice('phase', SpritePhase),
      interpolate: reader.boolean('interpolate'),
      lit: reader.boolean('lit'),
      fps: reader.number('fps', { min: 0, exclusiveMin: true }),
      repeat: reader.number('repeat', { min: 0, integer: true }),
      colorKey: SpriteSidecars.#readColorKey(reader, name, con),
      sequences: SpriteSidecars.#readSequences(root['sequences'], name, con),
      regions: SpriteSidecars.#readRegions(reader, name, con),
    };
  }

  /**
   * Reads `"regions": { "number_0": [x, y, width, height] }`.
   * @returns The regions that are valid, by name.
   */
  static #readRegions(reader: SettingsReader, name: string, con: ConsoleOutput): Map<string, SpriteRegion> {
    const regions = new Map<string, SpriteRegion>();
    const entries = reader.object('regions');

    if (entries === null) {
      return regions;
    }

    const entryReader = new SettingsReader(entries, `${name} regions`, con);

    for (const regionName of Object.keys(entries)) {
      const rectangle = entryReader.numbers(regionName, 4, { min: 0, integer: true });

      if (rectangle === null) {
        continue;
      }

      if (rectangle[2] === 0 || rectangle[3] === 0) {
        con.PrintWarning(`${name}: region "${regionName}" has no area, it is left out\n`);
        continue;
      }

      regions.set(regionName, { x: rectangle[0], y: rectangle[1], width: rectangle[2], height: rectangle[3] });
    }

    return regions;
  }

  static #readOrigin(reader: SettingsReader): readonly [number, number] | null {
    const origin = reader.numbers('origin', 2);

    return origin === null ? null : [origin[0], origin[1]];
  }

  static #readColorKey(reader: SettingsReader, name: string, con: ConsoleOutput): SpriteColorKey | null {
    const value = reader.object('colorKey');

    if (value === null) {
      return null;
    }

    const keyReader = new SettingsReader(value, `${name} colorKey`, con);

    keyReader.reportUnknown(COLOR_KEY_SETTINGS);

    const color = keyReader.numbers('color', 3, { min: 0, max: 255, integer: true });

    if (color === null) {
      con.PrintWarning(`${name}: colorKey needs a "color": [red, green, blue], it is ignored\n`);
      return null;
    }

    return { color: [color[0], color[1], color[2]], tolerance: keyReader.number('tolerance', { min: 0, max: 255 }) ?? 0 };
  }

  static #readSequences(value: JsonValue | undefined, name: string, con: ConsoleOutput): readonly SpriteSidecarSequence[] | null {
    if (value === undefined) {
      return null;
    }

    if (!Array.isArray(value)) {
      con.PrintWarning(`${name}: sequences has to be a list, it is ignored\n`);
      return null;
    }

    const sequences: SpriteSidecarSequence[] = [];

    value.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        con.PrintWarning(`${name}: sequence ${index} has to be an object, it is left out\n`);
        return;
      }

      const reader = new SettingsReader(entry, `${name} sequence ${index}`, con);

      reader.reportUnknown(SEQUENCE_SETTINGS);

      sequences.push({
        name: reader.string('name') ?? '',
        from: reader.number('from', { min: 0, integer: true }),
        to: reader.number('to', { min: 0, integer: true }),
        direction: reader.choice('direction', SpriteDirection),
        repeat: reader.number('repeat', { min: 0, integer: true }),
        fps: reader.number('fps', { min: 0, exclusiveMin: true }),
      });
    });

    return sequences.length > 0 ? sequences : null;
  }
}

/** Limits for a number setting. */
interface NumberRules {
  readonly min?: number;
  readonly max?: number;
  /** The value has to be larger than `min`, not equal to it. */
  readonly exclusiveMin?: boolean;
  readonly integer?: boolean;
}

/**
 * Reads typed settings out of one JSON object and reports what does not fit instead of throwing.
 */
class SettingsReader {
  readonly #values: { [key: string]: JsonValue };
  readonly #where: string;
  readonly #con: ConsoleOutput;

  constructor(values: { [key: string]: JsonValue }, where: string, con: ConsoleOutput) {
    this.#values = values;
    this.#where = where;
    this.#con = con;
  }

  /**
   * Warns about every key that is not a setting, which is usually a typo.
   */
  reportUnknown(known: readonly string[]): void {
    for (const key of Object.keys(this.#values)) {
      if (!known.includes(key)) {
        this.#con.PrintWarning(`${this.#where}: unknown setting "${key}" (known: ${known.join(', ')})\n`);
      }
    }
  }

  string(key: string): string | null {
    const value = this.#values[key];

    if (value === undefined) {
      return null;
    }

    if (typeof value !== 'string') {
      this.#reject(key, 'a string');
      return null;
    }

    return value;
  }

  boolean(key: string): boolean | null {
    const value = this.#values[key];

    if (value === undefined) {
      return null;
    }

    if (typeof value !== 'boolean') {
      this.#reject(key, 'true or false');
      return null;
    }

    return value;
  }

  number(key: string, rules: NumberRules = {}): number | null {
    const value = this.#values[key];

    return value === undefined ? null : this.#checkNumber(key, value, rules);
  }

  /**
   * @returns A list of exactly `length` numbers, `null` when the setting is not there or does not fit.
   */
  numbers(key: string, length: number, rules: NumberRules = {}): number[] | null {
    const value = this.#values[key];

    if (value === undefined) {
      return null;
    }

    if (!Array.isArray(value) || value.length !== length) {
      this.#reject(key, `a list of ${length} numbers`);
      return null;
    }

    const numbers = value.map((entry) => this.#checkNumber(key, entry, rules));

    return numbers.every((entry): entry is number => entry !== null) ? numbers : null;
  }

  object(key: string): { [key: string]: JsonValue } | null {
    const value = this.#values[key];

    if (value === undefined) {
      return null;
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.#reject(key, 'an object');
      return null;
    }

    return value;
  }

  /**
   * @param choices The accepted words, as the keys of a record or an enum object.
   * @returns The value the word stands for.
   */
  choice<T extends string | number>(key: string, choices: Readonly<Record<string, T>>): T | null {
    const value = this.#values[key];

    if (value === undefined) {
      return null;
    }

    const words = Object.keys(choices).filter((word) => Number.isNaN(Number(word)));

    if (typeof value !== 'string' || !words.includes(value)) {
      this.#reject(key, `one of ${words.join(', ')}`);
      return null;
    }

    return choices[value];
  }

  #checkNumber(key: string, value: JsonValue, rules: NumberRules): number | null {
    const { min, max, exclusiveMin, integer } = rules;

    if (typeof value !== 'number' || !Number.isFinite(value)
      || (integer === true && !Number.isInteger(value))
      || (min !== undefined && (exclusiveMin === true ? value <= min : value < min))
      || (max !== undefined && value > max)) {
      this.#reject(key, `${integer === true ? 'a whole' : 'a'} number${min === undefined ? '' : ` ${exclusiveMin === true ? 'above' : 'from'} ${min}`}${max === undefined ? '' : ` up to ${max}`}`);
      return null;
    }

    return value;
  }

  #reject(key: string, expected: string): void {
    this.#con.PrintWarning(`${this.#where}: "${key}" has to be ${expected}, it is left out (got ${JSON.stringify(this.#values[key])})\n`);
  }
}
