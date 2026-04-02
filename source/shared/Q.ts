import { EPSILON } from './Defs.ts';

type ByteArray = Uint8Array | number[];
type EnumValue = string | number | null;
type EnumRecord = Record<string, EnumValue>;

/**
 * Utility class for common engine functions.
 */
export default class Q {
  /**
   * Converts a Uint8Array or array of bytes to a string, stopping at the first zero byte.
   * @param src source byte array
   * @returns the resulting string
   */
  static memstr(src: ByteArray): string {
    const dest: string[] = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === 0) {
        break;
      }
      dest[i] = String.fromCharCode(src[i]);
    }
    return dest.join('');
  }

  /**
   * Converts a string to an ArrayBuffer of bytes (8-bit, zero-padded).
   * @param src source string
   * @returns the resulting ArrayBuffer
   */
  static strmem(src: string): ArrayBuffer {
    const buf = new ArrayBuffer(src.length);
    const dest = new Uint8Array(buf);
    for (let i = 0; i < src.length; i++) {
      dest[i] = src.charCodeAt(i) & 255;
    }
    return buf;
  }

  /**
   * Checks if a value is NaN.
   * @param value value to check
   * @returns true if value is NaN
   */
  static isNaN(value: number): boolean {
    return Number.isNaN(value);
  }

  /**
   * Converts a string to an integer.
   * NOTE: Use `+value|0` during regular use in the main/rendering loop.
   * @param value string to convert
   * @returns the integer value
   */
  static atoi(value: string): number {
    return parseInt(value);
  }

  /**
   * Converts a string to a float.
   * NOTE: Use `+value` during regular use in the main/rendering loop.
   * @param value string to convert
   * @returns the float value
   */
  static atof(value: string): number {
    return parseFloat(value);
  }

  /**
   * Encodes a byte array to a base64 string.
   * @param src source byte array
   * @returns base64-encoded string
   */
  static btoa(src: ByteArray): string {
    const str = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const val: string[] = [];
    const len = src.length - (src.length % 3);
    let c: number;
    let i: number;
    for (i = 0; i < len; i += 3) {
      c = (src[i] << 16) + (src[i + 1] << 8) + src[i + 2];
      val[val.length] = str.charAt(c >> 18) + str.charAt((c >> 12) & 63) + str.charAt((c >> 6) & 63) + str.charAt(c & 63);
    }
    if ((src.length - len) === 1) {
      c = src[len];
      val[val.length] = str.charAt(c >> 2) + str.charAt((c & 3) << 4) + '==';
    } else if ((src.length - len) === 2) {
      c = (src[len] << 8) + src[len + 1];
      val[val.length] = str.charAt(c >> 10) + str.charAt((c >> 4) & 63) + str.charAt((c & 15) << 2) + '=';
    }
    return val.join('');
  }

  /**
   * Turns seconds like 3692 into a string like "01:01:32".
   * @param secs seconds
   * @returns hours:mins:seconds
   */
  static secsToTime(secs: number): string {
    const negative = secs < 0;
    let seconds = Math.floor(Math.abs(secs));
    let minutes = Math.floor(seconds / 60);
    let hours = 0;
    if (minutes > 0) {
      seconds -= minutes * 60;
      hours = Math.floor(minutes / 60);
      if (hours !== 0) {
        minutes -= hours * 60;
      }
    }

    return `${negative ? '-' : ''}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  /**
   * Yields execution to the event loop (async).
   * @returns promise that resolves on next tick
   */
  static yield(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Sleeps for a given number of milliseconds (async).
   * @param msec milliseconds to sleep
   * @returns promise that resolves after the delay
   */
  static sleep(msec: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, msec));
  }

  /**
   * Compares two floating point numbers for near-equality.
   * @param a first number
   * @param b second number
   * @param epsilon tolerance for comparison, optional
   * @returns true if numbers are nearly equal
   */
  static compareFloat(a: number, b: number, epsilon = EPSILON): boolean {
    return Math.abs(a - b) < epsilon;
  }
}

/**
 * Helper functions for enums.
 * @readonly
 */
export const enumHelpers = Object.freeze({
  /**
   * @param val enum value
   * @returns enum key
   */
  toKey(this: EnumRecord, val: EnumValue): string {
    return Object.entries(this).find(([, value]) => value === val)?.[0] ?? `unknown (${val})`;
  },

  /**
   * @param name enum key
   * @returns enum value
   */
  fromKey(this: EnumRecord, name: string): EnumValue {
    return this[name] ?? null;
  },
});

export const AsyncFunction = (async function() {}).constructor;
