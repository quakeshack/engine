/**
 * Utility class for common engine functions.
 */
export default class Q {
  /**
   * Converts a Uint8Array or array of bytes to a string, stopping at the first zero byte.
   * @param {Uint8Array|number[]} src - Source byte array.
   * @returns {string} The resulting string.
   */
  static memstr(src) {
    const dest = [];
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
   * @param {string} src - Source string.
   * @returns {ArrayBuffer} The resulting ArrayBuffer.
   */
  static strmem(src) {
    const buf = new ArrayBuffer(src.length);
    const dest = new Uint8Array(buf);
    for (let i = 0; i < src.length; i++) {
      dest[i] = src.charCodeAt(i) & 255;
    }
    return buf;
  }

  /**
   * Checks if a value is NaN.
   * @param {number} value - Value to check.
   * @returns {boolean} True if value is NaN.
   */
  static isNaN(value) {
    return Number.isNaN ? Number.isNaN(value) : isNaN(value);
  }

  /**
   * Converts a string to an integer.
   * @param {string} value - String to convert.
   * @returns {number} The integer value.
   */
  static atoi(value) {
    return parseInt(value);
  }

  /**
   * Converts a string to a float.
   * @param {string} value - String to convert.
   * @returns {number} The float value.
   */
  static atof(value) {
    return parseFloat(value);
  }

  /**
   * Encodes a byte array to a base64 string.
   * @param {Uint8Array|number[]} src - Source byte array.
   * @returns {string} Base64-encoded string.
   */
  static btoa(src) {
    const str = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const val = [];
    const len = src.length - (src.length % 3);
    let c; let i;
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
   * Yields execution to the event loop (async).
   * @returns {Promise<void>} Promise that resolves on next tick.
   */
  static yield() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * Sleeps for a given number of milliseconds (async).
   * @param {number} msec - Milliseconds to sleep.
   * @returns {Promise<void>} Promise that resolves after the delay.
   */
  static sleep(msec) {
    return new Promise(resolve => setTimeout(resolve, msec));
  }
};
