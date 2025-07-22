import Vector from '../../shared/Vector.mjs';
import { MissingResourceError } from '../common/Errors.mjs';

import VID from './VID.mjs';
import W, { WadFileInterface, WadLumpTexture } from '../common/W.mjs';

import { eventBus } from '../registry.mjs';
import GL, { GLTexture } from './GL.mjs';

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

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
  /** @type {WadLumpTexture|null} */
  static #loading = null;
  /** @type {GLTexture|null} */
  static #conback = null;
  /** @type {number} */
  static #loadingCounter = 0;

  /**
   * Initializes the Draw system, loads resources, and sets up event listeners.
   * @returns {Promise<void>}
   */
  static async Init() {
    Draw.#gfxWad = await W.LoadFile('gfx.wad');
    Draw.#chars = GLTexture.FromLumpTexture(Draw.#gfxWad.getLumpMipmap('CONCHARS', 0)).lockTextureMode('GL_NEAREST');
    Draw.#conback = await (async () => {
      try {
        return await GLTexture.FromImageFile('gfx/conback.webp');
      } catch (err) {
        if (err instanceof MissingResourceError) {
          const lump = await W.LoadLump('gfx/conback.lmp');
          if (lump === null) {
            throw new MissingResourceError('gfx/conback.lmp');
          }
          return GLTexture.FromLumpTexture(lump).lockTextureMode('GL_NEAREST');
        }
        throw err;
      }
    })();
    Draw.#loading = await W.LoadLump('gfx/loading.lmp');
    const elem = document.getElementById('loading');
    if (elem) {
      Draw.#loadingElem = /** @type {HTMLImageElement} */ (elem);
      Draw.#loadingElem.src = Draw.#loading.toDataURL();
    }
    await Promise.all([
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
    eventBus.subscribe('com.fs.being', Draw.BeginDisc);
    eventBus.subscribe('com.fs.end', Draw.EndDisc);
    VID.mainwindow.style.backgroundImage = 'url("' + Draw.#gfxWad.getLumpMipmap('BACKTILE', 0).toDataURL() + '")';
  }

  /**
   * Draws a single character at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {number} num The character code.
   * @param {number} scale The scale factor.
   */
  static Char(x, y, num, scale = 1.0) {
    GL.StreamDrawTexturedQuad(x, y, 8 * scale, 8 * scale,
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
    Draw.#chars.bind(program.tTexture, true);
    Draw.Char(x, y, num, scale);
  }

  /**
   * Draws a string at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {string} str The string to draw.
   * @param {number} scale The scale factor.
   * @param {Vector} color The color vector.
   */
  static String(x, y, str, scale = 1.0, color = new Vector(1.0, 1.0, 1.0)) {
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, color[0], color[1], color[2]);
    Draw.#chars.bind(program.tTexture, true);
    for (let i = 0; i < str.length; ++i) {
      Draw.Char(x, y, str.charCodeAt(i), scale);
      x += 8 * scale;
    }
    GL.StreamFlush();
  }

  /**
   * Draws a string in white color at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {string} str The string to draw.
   * @param {number} scale The scale factor.
   */
  static StringWhite(x, y, str, scale = 1.0) {
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
    Draw.#chars.bind(program.tTexture);
    for (let i = 0; i < str.length; ++i) {
      Draw.Char(x, y, str.charCodeAt(i) + 128, scale);
      x += 8 * scale;
    }
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

    W.LoadLump('gfx/' + name + '.lmp').then((lump) => {
      if (lump === null) {
        // TODO: handle missing lump gracefully
        return;
      }

      glt.resize(lump.width, lump.height);
      glt.upload(lump.data);
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
   */
  static Pic(x, y, pic) {
    if (!pic.ready) {
      return;
    }
    const program = GL.UseProgram('pic', true);
    gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
    pic.bind(program.tTexture, true);
    GL.StreamDrawTexturedQuad(x, y, pic.width, pic.height, 0.0, 0.0, 1.0, 1.0);
  }

  /**
   * Draws a translated picture at the specified position.
   * @param {number} x The x position.
   * @param {number} y The y position.
   * @param {GLTexture} pic The texture to draw.
   * @param {number} top The top color index.
   * @param {number} bottom The bottom color index.
   */
  static PicTranslate(x, y, pic, top, bottom) {
    if (!pic.ready) {
      return;
    }
    GL.StreamFlush();
    const program = GL.UseProgram('pic-translate');
    pic.bind(program.tTexture);
    // @ts-ignore: translate may be dynamically added
    console.assert(pic.translate !== null, 'pic.translate must not be null');
    // @ts-ignore: translate may be dynamically added
    pic.translate && pic.translate.bind(program.tTrans);
    let p = W.d_8to24table[top];
    const scale = 1.0 / 191.25;
    gl.uniform3f(program.uTop, (p & 0xff) * scale, ((p >> 8) & 0xff) * scale, (p >> 16) * scale);
    p = W.d_8to24table[bottom];
    gl.uniform3f(program.uBottom, (p & 0xff) * scale, ((p >> 8) & 0xff) * scale, (p >> 16) * scale);
    GL.StreamDrawTexturedQuad(x, y, pic.width, pic.height, 0.0, 0.0, 1.0, 1.0);
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
