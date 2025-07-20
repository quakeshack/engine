/* globaxl Draw, COM, Sys, Def, VID, W, gl, GL, Vector */
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

const Draw = {};

export default Draw;

Draw._loadingElem = null;
/** @type {WadFileInterface} */
Draw._gfxWad = null;
/** @type {GLTexture} */
Draw._chars = null;
/** @type {WadLumpTexture} */
Draw._loading = null;
/** @type {GLTexture} */
Draw._conback = null;

Draw.Init = async function() {
  Draw._gfxWad = await W.LoadFile('gfx.wad');

  const conchars = Draw._gfxWad.getLumpMipmap('CONCHARS', 0);

  Draw._chars = GLTexture.FromLumpTexture(conchars).lockTextureMode('GL_NEAREST');

  Draw._conback = await (async() => {
    try {
      return await GLTexture.FromImageFile('gfx/conback.webp');
    } catch (err) {
      // fallback to the old conback.lmp
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

  Draw._loading = await W.LoadLump('gfx/loading.lmp');
  Draw._loadingElem = document.getElementById('loading');

  if (Draw._loadingElem) {
    Draw._loadingElem.src = Draw._loading.toDataURL();
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

  VID.mainwindow.style.backgroundImage = 'url("' + Draw._gfxWad.getLumpMipmap('BACKTILE', 0).toDataURL() + '")';
};

Draw.Char = function(x, y, num, scale = 1.0) {
  GL.StreamDrawTexturedQuad(x, y, 8 * scale, 8 * scale,
      (num & 15) * 0.0625, (num >> 4) * 0.0625,
      ((num & 15) + 1) * 0.0625, ((num >> 4) + 1) * 0.0625);
};

Draw.Character = function(x, y, num, scale = 1.0) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  Draw._chars.bind(program.tTexture, true);
  Draw.Char(x, y, num, scale);
  GL.StreamFlush();
};

Draw.String = function(x, y, str, scale = 1.0, color = new Vector(1.0, 1.0, 1.0)) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, color[0], color[1], color[2]);
  Draw._chars.bind(program.tTexture, true);
  for (let i = 0; i < str.length; ++i) {
    Draw.Char(x, y, str.charCodeAt(i), scale);
    x += 8 * scale;
  }
  GL.StreamFlush();
};

Draw.StringWhite = function(x, y, str, scale = 1.0) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  Draw._chars.bind(program.tTexture);
  for (let i = 0; i < str.length; ++i) {
    Draw.Char(x, y, str.charCodeAt(i) + 128, scale);
    x += 8 * scale;
  }
  GL.StreamFlush();
};

Draw.PicFromWad = function(name) {
  const texdata = Draw._gfxWad.getLumpMipmap(name, 0);

  return GLTexture.FromLumpTexture(texdata).lockTextureMode('GL_NEAREST');
};

Draw.CachePic = async function(name) {
  return GLTexture.FromLumpTexture(await W.LoadLump('gfx/' + name + '.lmp')).lockTextureMode('GL_NEAREST');
};

Draw.Pic = function(x, y, pic) {
  if (!pic.ready) {
    return;
  }

  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  pic.bind(program.tTexture, true);
  GL.StreamDrawTexturedQuad(x, y, pic.width, pic.height, 0.0, 0.0, 1.0, 1.0);
};

Draw.PicTranslate = function(x, y, pic, top, bottom) {
  if (!pic.ready) {
    return;
  }

  GL.StreamFlush();
  const program = GL.UseProgram('pic-translate');

  pic.bind(program.tTexture);
  console.assert(pic.translate !== null, 'pic.translate must not be null');
  pic.translate.bind(program.tTrans);

  let p = W.d_8to24table[top];
  const scale = 1.0 / 191.25;
  gl.uniform3f(program.uTop, (p & 0xff) * scale, ((p >> 8) & 0xff) * scale, (p >> 16) * scale);
  p = W.d_8to24table[bottom];
  gl.uniform3f(program.uBottom, (p & 0xff) * scale, ((p >> 8) & 0xff) * scale, (p >> 16) * scale);

  GL.StreamDrawTexturedQuad(x, y, pic.width, pic.height, 0.0, 0.0, 1.0, 1.0);

  GL.StreamFlush();
};

Draw.ConsoleBackground = function(lines) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  Draw._conback.bind(program.tTexture, true);
  GL.StreamDrawTexturedQuad(0, lines - VID.height, VID.width, VID.height, 0.0, 0.0, 1.0, 1.0);
  GL.StreamFlush();
};

Draw.Fill = function(x, y, w, h, c) {
  GL.UseProgram('fill', true);
  const color = W.d_8to24table[c];
  GL.StreamDrawColoredQuad(x, y, w, h, color & 0xff, (color >> 8) & 0xff, color >> 16, 255);
};

Draw.FadeScreen = function() {
  GL.UseProgram('fill', true);
  GL.StreamDrawColoredQuad(0, 0, VID.width, VID.height, 0, 0, 0, 204);
};

Draw.BlackScreen = function() {
  GL.UseProgram('fill', true);
  GL.StreamDrawColoredQuad(0, 0, VID.width, VID.height, 0, 0, 0, 255);
};

let loadingCounter = 0;

Draw.BeginDisc = function() {
  loadingCounter++;

  if (Draw._loadingElem === null) {
    return;
  }

  Draw.UpdateDiscPosition();
  Draw._loadingElem.style.display = 'inline-block';
};

Draw.EndDisc = function() {
  if (--loadingCounter > 0) {
    return;
  }
  if (Draw._loadingElem === null) {
    return;
  }

  Draw._loadingElem.style.display = 'none';
};

Draw.UpdateDiscPosition = function() {
  if (Draw._loadingElem === null) {
    return;
  }

  Draw._loadingElem.style.left = ((VID.width - Draw._loading.width)) + 'px';
  Draw._loadingElem.style.top = ((VID.height - Draw._loading.height)) + 'px';
};

eventBus.subscribe('vid.resize', () => Draw.UpdateDiscPosition());
