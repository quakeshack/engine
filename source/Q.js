/* global Q */

// eslint-disable-next-line no-global-assign
Q = {};

Q.memstr = function(src) {
  const dest = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0) {
      break;
    }
    dest[i] = String.fromCharCode(src[i]);
  }
  return dest.join('');
};

Q.strmem = function(src) {
  const buf = new ArrayBuffer(src.length);
  const dest = new Uint8Array(buf);
  for (let i = 0; i < src.length; i++) {
    dest[i] = src.charCodeAt(i) & 255;
  }
  return buf;
};

Q.isNaN = Number.isNaN || isNaN;
Q.atoi = parseInt;
Q.atof = parseFloat;

Q.btoa = function(src) {
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
};

Q.yield = () => new Promise(resolve => setTimeout(resolve, 0));
Q.sleep = (msec) => new Promise(resolve => setTimeout(resolve, msec));
