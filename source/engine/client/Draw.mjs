import Vector from '../../shared/Vector.ts';
import { MissingResourceError } from '../common/Errors.ts';

import VID from './VID.mjs';
import W, { WadFileInterface, WadLumpTexture } from '../common/W.ts';

import { eventBus, registry } from '../registry.mjs';
import GL, { GLTexture } from './GL.mjs';
import { ClientEngineAPI } from '../common/GameAPIs.mjs';

let { Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  Host = registry.Host;
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

const HIDPI_THRESHOLD = 1.0;

/**
 * Based on the old Draw.CharToConback function but in 32 bit, this function places conchars into the conback texture data.
 * @param {Uint8Array} conback conback texture data
 * @param {Uint8Array} chars chars texture data
 * @param {number} num character code ASCII
 * @param {number} dest destination offset in conback
 * @param {Vector} color color vector
 */
function charToConback(conback, chars, num, dest, color) {
  let source = ((num >> 4) << 10) + ((num & 15) << 3);
  for (let drawline = 0; drawline < 8; drawline++) {
    for (let x = 0; x < 8; x++) {
      if (chars[(source + x) * 4 + 3] > 0) {
        conback[(dest + x) * 4 + 0] = chars[(source + x) * 4 + 0] * color[0];
        conback[(dest + x) * 4 + 1] = chars[(source + x) * 4 + 1] * color[1];
        conback[(dest + x) * 4 + 2] = chars[(source + x) * 4 + 2] * color[2];
      }
    }
    source += 128;
    dest += 320;
  }
}

/**
 * Draw class provides static methods and properties for rendering UI elements and graphics.
 */
export default class Draw {
  /** @type {HTMLImageElement|null} */
  static #loadingElem = null;
  /** @type {WadFileInterface|null} */
  static #gfxWad = null;
  /** @type {GLTexture|null} */
  static #chars = null;
  /** @type {GLTexture|null} */
  static #charsLarge = null;
  /** @type {Record<string, number>} */
  static #charsLargeWidthTable = {};
  /** @type {WadLumpTexture|null} */
  static #loading = null;
  /** @type {GLTexture|null} */
  static #conback = null;
  /** @type {number} */
  static #loadingCounter = 0;
  /** @type {WebGLFramebuffer|null} */
  static #fbo = null;
  /** @type {GLTexture|null} */
  static #currentTexture = null;

  /**
   * Redirects all subsequent Draw calls to the specified texture.
   * @param {GLTexture} texture The texture to render to.
   */
  static BeginTexture(texture) {
    if (!texture.ready) {
      texture.upload(null);
    }

    Draw.#currentTexture = texture;

    GL.StreamFlush();

    gl.bindFramebuffer(gl.FRAMEBUFFER, Draw.#fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texnum, 0);
    gl.viewport(0, 0, texture.width, texture.height);

    // Calc ortho for this texture
    const ortho = [
      2.0 / texture.width, 0.0, 0.0, 0.0,
      0.0, 2.0 / texture.height, 0.0, 0.0,
      0.0, 0.0, -1.0, 0.0,
      -1.0, -1.0, 0.0, 1.0,
    ];

    for (const { program, uOrtho } of GL.programs) {
      if (!uOrtho) {
        continue;
      }
      gl.useProgram(program);
      gl.uniformMatrix4fv(uOrtho, false, ortho);
    }

    // Reset current program tracking so next UseProgram works correctly
    GL.UnbindProgram();
  }

  /**
   * Ends rendering to texture and restores screen output.
   */
  static EndTexture() {
    GL.StreamFlush();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (Draw.#currentTexture !== null) {
      Draw.#currentTexture.bind(0);
      gl.generateMipmap(gl.TEXTURE_2D);
      Draw.#currentTexture = null;
    }

    GL.Set2D();
  }

  /**
   * Generates a GLTexture from a given font string to be used as a replacement for ConChars.
   * NOTE: does not generate the special symbols, only ASCII 32-127
   * @param {string} font Font string (e.g. 'bold 30px monospace')
   * @param {number} size Texture size (default 512)
   * @param {Record<string, number>} widthTable Optional width table to fill
   * @returns {Promise<GLTexture>} A promise that resolves to the generated font texture.
   * @protected
   */
  static async CreateFontTexture(font, size = 512, widthTable = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2d context');
    }

    ctx.clearRect(0, 0, size, size);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font;

    const cellSize = size / 16;
    const halfCell = cellSize / 2;
    const shadowOffset = size / 512;

    const c = ClientEngineAPI.IndexToRGB(95);
    const r = Math.floor(c[0] * 255);
    const g = Math.floor(c[1] * 255);
    const b = Math.floor(c[2] * 255);
    const gold = `rgb(${r},${g},${b})`;
    const white = '#fff';

    const drawChar = (i, color) => {
      const charCode = i % 128; // splitting it in half
      if (charCode < 32) {
        return; // the font most likely does not have the Quake special symbols
      }

      const char = String.fromCharCode(charCode);
      const row = Math.floor(i / 16);
      const col = i % 16;

      const y = (row * cellSize) + halfCell;

      ctx.fillStyle = color;
      ctx.shadowColor = 'black';
      ctx.shadowOffsetX = shadowOffset;
      ctx.shadowOffsetY = shadowOffset;
      ctx.shadowBlur = 0;

      ctx.fillText(char, col * cellSize, y);

      const metrics = ctx.measureText(char);

      widthTable[char] = metrics.width;
    };

    for (let i = 0; i < 256; i++) {
      drawChar(i, i < 128 ? white : gold);
    }

    // console.log('widthTable:', widthTable);
    // window.open('', '_blank')?.document.write('<img src="' + canvas.toDataURL() + '">');

    const bitmap = await createImageBitmap(canvas);
    return GLTexture.Allocate('font:' + font, size, size, bitmap).lockTextureMode('GL_LINEAR');
  }

  /**
   * Initializes the Draw system, loads resources, and sets up event listeners.
   * @returns {Promise<void>}
   */
  static async Init() {
    // Load gfx.wad and essential lumps in parallel
    const [gfxWad, conback, loading, conback32, concharsLarge] = await Promise.all([
      W.LoadFile('gfx.wad'),
      W.LoadLump('gfx/conback.lmp'),
      W.LoadLump('gfx/loading.lmp'),
      GLTexture.FromImageFile('gfx/conback.png', true), // optional 32-bit conback
      GLTexture.FromImageFile('gfx/concharslarge.png', true), // optional large conchars

      // also load all shaders we need
      GL.CreateProgram('fill',
        ['uOrtho'],
        [['aPosition', gl.FLOAT, 2], ['aColor', gl.UNSIGNED_BYTE, 4, true]],
        []),
      GL.CreateProgram('pic',
        ['uOrtho', 'uColor'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture']),
      GL.CreateProgram('pic-translate',
        ['uOrtho', 'uTop', 'uBottom'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture', 'tTrans']),
    ]);

    Draw.#gfxWad = gfxWad;
    Draw.#loading = loading;

    const conchars = Draw.#gfxWad.getLumpMipmap('CONCHARS', 0);
    Draw.#chars = GLTexture.FromLumpTexture(conchars).lockTextureMode('GL_NEAREST');

    Draw.#conback = (() => {
      if (conback32 !== null) {
        return conback32.lockTextureMode('GL_LINEAR');
      }

      if (conback === null) {
        throw new MissingResourceError('gfx/conback.lmp');
      }

      // we are writing the version into the conback texture
      const version = Host.version.string;
      const color = ClientEngineAPI.IndexToRGB(95);
      for (let i = 0; i < version.length; i++) {
        charToConback(conback.data, conchars.data, version.charCodeAt(i), 59829 - ((version.length - i) * 8), color);
      }

      return GLTexture.FromLumpTexture(conback).lockTextureMode('GL_NEAREST');
    })();

    if (concharsLarge !== null) {
      Draw.#charsLarge = concharsLarge.lockTextureMode('GL_LINEAR');
      Draw.#charsLargeWidthTable = { '0': 17, '1': 17, '2': 17, '3': 17, '4': 17, '5': 17, '6': 17, '7': 17, '8': 17, '9': 17, ' ': 17, '!': 17, '"': 17, '#': 17, '$': 17, '%': 17, '&': 17, "'": 17, '(': 17, ')': 17, '*': 17, '+': 17, ',': 17, '-': 17, '.': 17, '/': 17, ':': 17, ';': 17, '<': 17, '=': 17, '>': 17, '?': 17, '@': 17, 'A': 17, 'B': 17, 'C': 17, 'D': 17, 'E': 17, 'F': 17, 'G': 17, 'H': 17, 'I': 17, 'J': 17, 'K': 17, 'L': 17, 'M': 17, 'N': 17, 'O': 17, 'P': 17, 'Q': 17, 'R': 17, 'S': 17, 'T': 17, 'U': 17, 'V': 17, 'W': 17, 'X': 17, 'Y': 17, 'Z': 17, '[': 17, '\\': 17, ']': 17, '^': 17, '_': 17, '`': 17, 'a': 17, 'b': 17, 'c': 17, 'd': 17, 'e': 17, 'f': 17, 'g': 17, 'h': 17, 'i': 17, 'j': 17, 'k': 17, 'l': 17, 'm': 17, 'n': 17, 'o': 17, 'p': 17, 'q': 17, 'r': 17, 's': 17, 't': 17, 'u': 17, 'v': 17, 'w': 17, 'x': 17, 'y': 17, 'z': 17, '{': 17, '|': 17, '}': 17, '~': 17, '\x7f': 0 };

    } else {
      Draw.#charsLarge = Draw.#chars; // fallback to normal chars
    }

    const elem = document.getElementById('loading');
    if (elem instanceof HTMLImageElement) {
      Draw.#loadingElem = /** @type {HTMLImageElement} */ (elem);
      Draw.#loadingElem.src = Draw.#loading.toDataURL();
    }

    eventBus.subscribe('com.fs.being', Draw.BeginDisc);
    eventBus.subscribe('com.fs.end', Draw.EndDisc);
    VID.mainwindow.style.backgroundImage = 'url("' + Draw.#gfxWad.getLumpMipmap('BACKTILE', 0).toDataURL() + '")';

    Draw.#fbo = gl.createFramebuffer(); // TODO: cleanup

    // await Draw.CreateFontTexture('bold 28px "monospace"', 512, Draw.#charsLargeWidthTable);


    // Draw.#charsLarge = await Draw.CreateFontTexture('bold 28px "Fira Code"', 512, Draw.#charsLargeWidthTable);
    // Draw.#charsLarge = Draw.#chars;
  }

  /**
   * Draws a single character at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {number} num The character code.
   * @param {number} scale The scale factor.
   */
  static Char(x, y, num, scale = 1.0) {
    GL.StreamDrawTexturedQuad(Math.floor(x), Math.floor(y), scale * 8, scale * 8,
      (num & 15) * 0.0625, (num >> 4) * 0.0625,
      ((num & 15) + 1) * 0.0625, ((num >> 4) + 1) * 0.0625);
  }

  /**
   * Draws a character using the loaded font texture.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {number} num The character code.
   * @param {number} scale The scale factor.
   */
  static Character(x, y, num, scale = 1.0) {
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
    if (scale > HIDPI_THRESHOLD) {
      Draw.#charsLarge.bind(program.tTexture, true);
    } else {
      Draw.#chars.bind(program.tTexture, true);
    }
    Draw.Char(x, y, num, scale);
  }

  /**
   * Draws a string at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {string} str The string to draw.
   * @param {number} scale The scale factor.
   * @param {Vector} color The color vector.
   * @returns {number} The new x position after drawing the string.
   */
  static String(x, y, str, scale = 1.0, color = new Vector(1.0, 1.0, 1.0)) {
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, color[0], color[1], color[2]);
    if (scale > HIDPI_THRESHOLD) {
      Draw.#charsLarge.bind(program.tTexture, true);
    } else {
      Draw.#chars.bind(program.tTexture, true);
    }
    for (let i = 0; i < str.length; i++) {
      Draw.Char(x, y, str.charCodeAt(i), scale);
      x += Math.floor((Draw.#charsLargeWidthTable[str.charAt(i)] || 32) * scale * 0.25);
    }
    GL.StreamFlush();
    return x;
  }

  /**
   * Draws a string in white color at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {string} str The string to draw.
   * @param {number} scale The scale factor.
   * @returns {number} The new x position after drawing the string.
   */
  static StringWhite(x, y, str, scale = 1.0) {
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
    if (scale > HIDPI_THRESHOLD) {
      Draw.#charsLarge.bind(program.tTexture, true);
    } else {
      Draw.#chars.bind(program.tTexture, true);
    }
    for (let i = 0; i < str.length; i++) {
      Draw.Char(x, y, str.charCodeAt(i) + 128, scale);
      x += Math.floor((Draw.#charsLargeWidthTable[str.charAt(i)] || 32) * scale * 0.25);
    }
    return x;
  }

  /**
   * Loads a picture from the WAD file.
   * @param {string} name The lump name.
   * @returns {GLTexture} The loaded GLTexture.
   */
  static LoadPicFromWad(name) {
    const texdata = Draw.#gfxWad.getLumpMipmap(name, 0);
    return GLTexture.FromLumpTexture(texdata).lockTextureMode('GL_NEAREST');
  }

  /**
   * Loads a picture from a lump file.
   * @param {string} name The lump name.
   * @returns {Promise<GLTexture>} A promise that resolves to the loaded GLTexture.
   */
  static async LoadPicFromLump(name) {
    return GLTexture.FromLumpTexture(await W.LoadLump('gfx/' + name + '.lmp')).lockTextureMode('GL_NEAREST');
  }

  /**
   * Loads a picture from a lump file in the background.
   * @param {string} name The lump name.
   * @returns {GLTexture} A promise that resolves to the loaded GLTexture.
   */
  static LoadPicFromLumpDeferred(name) {
    // TODO: do cache lookup

    const glt = GLTexture.Allocate(name, 1, 1, new Uint8Array([0, 0, 0, 0])).lockTextureMode('GL_NEAREST');

    if (glt.width > 1 && glt.height > 1) {
      return glt;
    }

    W.LoadLump('gfx/' + name + '.lmp').then((lump) => {
      if (lump === null) {
        // TODO: handle missing lump gracefully
        return;
      }

      glt.resize(lump.width, lump.height);
      glt.upload(lump.data);
    }).catch((err) => {
      console.error('LoadPicFromLumpDeferred(\'' + name + '\'): ' + err.message);
      // TODO: handle error here
    });

    return glt;
  }

  /**
   * Loads a picture from an image file.
   * @param {string} filename Filename of the image to load.
   * @returns {Promise<GLTexture>} A promise that resolves to the loaded GLTexture.
   */
  static async LoadPicFromFile(filename) {
    return (await GLTexture.FromImageFile(filename)).lockTextureMode('GL_NEAREST');
  }

  /**
   * Loads a picture from a lump file in the background.
   * @param {string} filename The lump name.
   * @returns {GLTexture} A promise that resolves to the loaded GLTexture.
   * @deprecated not implemented yet
   */
  static LoadPicFromFileDeferred(filename) {
    // TODO: do cache lookup

    const glt = GLTexture.Allocate(filename, 1, 1, new Uint8Array([0, 0, 0, 0])).lockTextureMode('GL_NEAREST');

    // TODO: implement this

    return glt;
  }

  /**
   * Draws a picture at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {GLTexture} pic The texture to draw.
   * @param {number} [scale] The scale factor for the picture.
   */
  static Pic(x, y, pic, scale = 1.0) {
    if (!pic.ready) {
      return;
    }
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
    pic.bind(program.tTexture, true);
    GL.StreamDrawTexturedQuad(x, y, pic.width * scale, pic.height * scale, 0.0, 0.0, 1.0, 1.0);
    GL.StreamFlush();
  }

  /**
   * Draws a translated picture at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {GLTexture} pic The texture to draw.
   * @param {number} top The top color index.
   * @param {number} bottom The bottom color index.
   * @param {number} [scale] The scale factor for the picture.
   */
  static PicTranslate(x, y, pic, top, bottom, scale = 1.0) {
    if (!pic.ready) {
      return;
    }
    GL.StreamFlush();
    const program = GL.UseProgram('pic-translate');
    gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
    pic.bind(program.tTexture);
    // @ts-ignore: translate may be dynamically added
    console.assert(pic.translate !== null, 'pic.translate must not be null');
    // @ts-ignore: translate may be dynamically added
    pic.translate && pic.translate.bind(program.tTrans);
    let p = W.d_8to24table[top];
    const uvscale = 1.0 / 191.25;
    gl.uniform3f(program.uTop, (p & 0xff) * uvscale, ((p >> 8) & 0xff) * uvscale, (p >> 16) * uvscale);
    p = W.d_8to24table[bottom];
    gl.uniform3f(program.uBottom, (p & 0xff) * uvscale, ((p >> 8) & 0xff) * uvscale, (p >> 16) * uvscale);
    GL.StreamDrawTexturedQuad(x, y, pic.width * scale, pic.height * scale, 0.0, 0.0, 1.0, 1.0);
    GL.StreamFlush();
  }

  /**
   * Draws the console background.
   * @param {number} lines The number of lines to show.
   */
  static ConsoleBackground(lines) {
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
    Draw.#conback.bind(program.tTexture, true);
    GL.StreamDrawTexturedQuad(0, lines - VID.height, VID.width, VID.height, 0.0, 0.0, 1.0, 1.0);
    GL.StreamFlush();
  }

  /**
   * Fills a rectangle with a solid color.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {number} w The width of the rectangle.
   * @param {number} h The height of the rectangle.
   * @param {number} c The color index.
   */
  static FillIndexed(x, y, w, h, c) {
    GL.UseProgram('fill', true);
    const color = W.d_8to24table[c];
    GL.StreamDrawColoredQuad(x, y, w, h, color & 0xff, (color >> 8) & 0xff, color >> 16, 255);
  }

  /**
   * Fills a rectangle with a solid color.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {number} w The width of the rectangle.
   * @param {number} h The height of the rectangle.
   * @param {Vector} c The color index.
   * @param {number} a Optional alpha value (default is 1.0).
   */
  static Fill(x, y, w, h, c, a = 1.0) {
    GL.UseProgram('fill', true);
    GL.StreamDrawColoredQuad(x, y, w, h, Math.floor(c[0] * 255.0), Math.floor(c[1] * 255.0), Math.floor(c[2] * 255.0), Math.floor(a * 255.0));
  }

  /**
   * Draws a faded screen overlay.
   */
  static FadeScreen() {
    GL.UseProgram('fill', true);
    GL.StreamDrawColoredQuad(0, 0, VID.width, VID.height, 0, 0, 0, 204);
  }

  /**
   * Draws a black screen overlay.
   */
  static BlackScreen() {
    GL.UseProgram('fill', true);
    GL.StreamDrawColoredQuad(0, 0, VID.width, VID.height, 0, 0, 0, 255);
  }

  /**
   * Begins showing the loading disc.
   */
  static BeginDisc() {
    Draw.#loadingCounter++;
    if (Draw.#loadingElem === null) {
      return;
    }
    Draw.UpdateDiscPosition();
    Draw.#loadingElem.style.display = 'inline-block';
  }

  /**
   * Ends showing the loading disc.
   */
  static EndDisc() {
    if (--Draw.#loadingCounter > 0) {
      return;
    }
    if (Draw.#loadingElem === null) {
      return;
    }
    Draw.#loadingElem.style.display = 'none';
  }

  /**
   * Updates the position of the loading disc.
   */
  static UpdateDiscPosition() {
    if (Draw.#loadingElem === null) {
      return;
    }
    Draw.#loadingElem.style.left = ((VID.width - Draw.#loading.width)) + 'px';
    Draw.#loadingElem.style.top = ((VID.height - Draw.#loading.height)) + 'px';
  }
}

eventBus.subscribe('vid.resize', () => Draw.UpdateDiscPosition());
