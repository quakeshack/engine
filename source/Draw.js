/* global Draw, COM, Sys, Def, VID, W, gl, GL, Vector */

// eslint-disable-next-line no-global-assign
Draw = {};

Draw._loadingElem = null;
/** @type {W._WadFileInterface} */
Draw._gfxWad = null;
Draw._chars = null;
Draw._charTexture = null;
Draw._loading = null;
Draw._conback = {width: 0, height: 0, data: null, texnum: null};

Draw._CharToConback = function(num, dest) {
  let source = ((num >> 4) << 10) + ((num & 15) << 3);
  let drawline; let x;
  for (drawline = 0; drawline < 8; ++drawline) {
    for (x = 0; x < 8; ++x) {
      if (Draw._chars[source + x] !== 0) {
        Draw._conback.data[dest + x] = 0x60 + Draw._chars[source + x];
      }
    }
    source += 128;
    dest += 320;
  }
};

Draw._StringToConback = function(str, dest, alignRight) {
  for (let i = 0; i < str.length; ++i) {
    Draw._CharToConback(str.charCodeAt(i), dest + (alignRight ? ((str.length - i) * -8) : i * 8));
  }
};

Draw.Init = async function() {
  Draw._gfxWad = await W.LoadFile('gfx.wad');
  Draw._chars = new Uint8Array(Draw._gfxWad.getLump('CONCHARS'));
  Draw._charTexture = gl.createTexture();
  GL.Bind(0, Draw._charTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, VID.TranslateIndexToRGBA(Draw._chars, 128, 128, VID.d_8to24table_u8, 0));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const modernConback = await GL.LoadImageTexture('gfx/conback.webp');

  if (modernConback) {
    Draw._conback.texnum = modernConback;
  } else {
    const cb = await COM.LoadFileAsync('gfx/conback.lmp');
    if (cb === null) {
      Sys.Error('Couldn\'t load gfx/conback.lmp');
    }
    Draw._conback.width = 320;
    Draw._conback.height = 200;
    Draw._conback.data = new Uint8Array(cb, 8, Draw._conback.width * Draw._conback.height);
    Draw._StringToConback(document.title, Draw._conback.width * 8 + 8, false);
    Draw._StringToConback(Def.version, 59829, true);
    Draw._conback.texnum = GL.LoadPicTexture(Draw._conback);
  }

  Draw._loading = await Draw.CachePic('loading');
  Draw._loadingElem = document.getElementById('loading');

  if (Draw._loadingElem) {
    Draw._loadingElem.src = Draw.PicToDataURL(Draw._loading);
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
};

Draw.Char = function(x, y, num, scale = 1.0) {
  GL.StreamDrawTexturedQuad(x, y, 8 * scale, 8 * scale,
      (num & 15) * 0.0625, (num >> 4) * 0.0625,
      ((num & 15) + 1) * 0.0625, ((num >> 4) + 1) * 0.0625);
};

Draw.Character = function(x, y, num, scale = 1.0) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  GL.Bind(program.tTexture, Draw._charTexture, true);
  Draw.Char(x, y, num, scale);
  GL.StreamFlush();
};

Draw.String = function(x, y, str, scale = 1.0, color = new Vector(1.0, 1.0, 1.0)) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, ...color);
  GL.Bind(program.tTexture, Draw._charTexture, true);
  for (let i = 0; i < str.length; ++i) {
    Draw.Char(x, y, str.charCodeAt(i), scale, color);
    x += 8 * scale;
  }
  GL.StreamFlush();
};

Draw.StringWhite = function(x, y, str, scale = 1.0) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  GL.Bind(program.tTexture, Draw._charTexture, true);
  for (let i = 0; i < str.length; ++i) {
    Draw.Char(x, y, str.charCodeAt(i) + 128, scale);
    x += 8 * scale;
  }
  GL.StreamFlush();
};

Draw.PicFromWad = function(name) {
  const texdata = Draw._gfxWad.getLumpMipmap(name, 0);
  return GL.LoadTexture32(texdata.name, texdata.width, texdata.height, texdata.data);
};

Draw.CachePic = async function(path) {
  path = 'gfx/' + path + '.lmp';
  const buf = await COM.LoadFileAsync(path);
  if (buf === null) {
    Sys.Error('Draw.CachePic: failed to load ' + path);
  }
  const dat = {};
  const view = new DataView(buf, 0, 8);
  dat.width = view.getUint32(0, true);
  dat.height = view.getUint32(4, true);
  dat.data = new Uint8Array(buf, 8, dat.width * dat.height);
  dat.texnum = GL.LoadPicTexture(dat);
  dat.ready = true;
  return dat;
};

Draw.CachePicDeferred = function(path) {
  path = 'gfx/' + path + '.lmp';

  const dat = {
    width: null,
    height: null,
    data: null,
    texnum: null,
    ready: false
  };

  COM.LoadFileAsync(path).then((buf) => {
    if (buf == null) {
      throw new Error('buf == null');
    }

    const view = new DataView(buf, 0, 8);
    dat.width = view.getUint32(0, true);
    dat.height = view.getUint32(4, true);
    dat.data = new Uint8Array(buf, 8, dat.width * dat.height);
    dat.texnum = GL.LoadPicTexture(dat);
    dat.ready = true;
  }).catch((err) => {
    Sys.Error(`Draw.CachePic: failed to load ${path}, ${err.message}`);
  });
  return dat;
};

Draw.Pic = function(x, y, pic) {
  if (!pic.ready) {
    return;
  }

  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  GL.Bind(program.tTexture, pic.texnum, true);
  GL.StreamDrawTexturedQuad(x, y, pic.width, pic.height, 0.0, 0.0, 1.0, 1.0);
};

Draw.PicTranslate = function(x, y, pic, top, bottom) {
  if (!pic.ready) {
    return;
  }

  GL.StreamFlush();
  const program = GL.UseProgram('pic-translate');
  GL.Bind(program.tTexture, pic.texnum);
  GL.Bind(program.tTrans, pic.translate);

  let p = VID.d_8to24table[top];
  const scale = 1.0 / 191.25;
  gl.uniform3f(program.uTop, (p & 0xff) * scale, ((p >> 8) & 0xff) * scale, (p >> 16) * scale);
  p = VID.d_8to24table[bottom];
  gl.uniform3f(program.uBottom, (p & 0xff) * scale, ((p >> 8) & 0xff) * scale, (p >> 16) * scale);

  GL.StreamDrawTexturedQuad(x, y, pic.width, pic.height, 0.0, 0.0, 1.0, 1.0);

  GL.StreamFlush();
};

Draw.ConsoleBackground = function(lines) {
  const program = GL.UseProgram('pic', true);
  gl.uniform3f(program.uColor, 1.0, 1.0, 1.0);
  GL.Bind(program.tTexture, Draw._conback.texnum, true);
  GL.StreamDrawTexturedQuad(0, lines - VID.height, VID.width, VID.height, 0.0, 0.0, 1.0, 1.0);
  GL.StreamFlush();
};

Draw.Fill = function(x, y, w, h, c) {
  GL.UseProgram('fill', true);
  const color = VID.d_8to24table[c];
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

Draw.BeginDisc = function() {
  if (Draw._loadingElem == null) {
    return;
  }
  Draw._loadingElem.style.left = ((VID.width - Draw._loading.width)) + 'px';
  Draw._loadingElem.style.top = ((VID.height - Draw._loading.height)) + 'px';
  Draw._loadingElem.style.display = 'inline-block';
};

Draw.EndDisc = function() {
  if (Draw._loadingElem != null) {
    Draw._loadingElem.style.display = 'none';
  }
};

Draw.PicToDataURL = function(pic) {
  const canvas = document.createElement('canvas');
  canvas.width = pic.width;
  canvas.height = pic.height;
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(pic.width, pic.height);
  const trans = new ArrayBuffer(data.data.length);
  const trans32 = new Uint32Array(trans);
  for (let i = 0; i < pic.data.length; ++i) {
    trans32[i] = COM.LittleLong(VID.d_8to24table[pic.data[i]] + 0xff000000);
  }
  data.data.set(new Uint8Array(trans));
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL();
};

Draw.Pic32ToDataURL = function(pic) {
  const canvas = document.createElement('canvas');
  canvas.width = pic.width;
  canvas.height = pic.height;
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(pic.width, pic.height);
  data.data.set(new Uint8Array(pic.data));
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL();
};
