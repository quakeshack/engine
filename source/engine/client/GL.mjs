/* globalss gl, Con, COM, Cmd, Cvar, SCR, Sys, VID */

import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import W, { translateIndexToRGBA } from '../common/W.mjs';
import { eventBus, registry } from '../registry.mjs';
import VID from './VID.mjs';

const GL = {};

export default GL;

let { COM, Con, SCR } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  SCR = registry.SCR;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

GL.textures = [];
GL.currenttextures = [];
GL.programs = [];

GL.Bind = function(target, texnum, flushStream) {
  if (GL.currenttextures[target] !== texnum) {
    if (flushStream === true) {
      GL.StreamFlush();
    }
    if (GL.activetexture !== target) {
      GL.activetexture = target;
      gl.activeTexture(gl.TEXTURE0 + target);
    }
    GL.currenttextures[target] = texnum;
    gl.bindTexture(gl.TEXTURE_2D, texnum);
  }
};

GL.TextureMode_f = function(name) {
  let i;
  if (name === undefined) {
    for (i = 0; i < GL.modes.length; ++i) {
      if (GL.filter_min === GL.modes[i][1]) {
        Con.Print(GL.modes[i][0] + '\n');
        return;
      }
    }
    Con.Print('current filter is unknown???\n');
    return;
  }
  name = name.toUpperCase();
  for (i = 0; i < GL.modes.length; ++i) {
    if (GL.modes[i][0] === name) {
      break;
    }
  }
  if (i === GL.modes.length) {
    Con.Print('bad filter name\n');
    return;
  }
  GL.filter_min = GL.modes[i][1];
  GL.filter_max = GL.modes[i][2];
  for (i = 0; i < GL.textures.length; ++i) {
    GL.Bind(0, GL.textures[i].texnum);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, GL.filter_min);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, GL.filter_max);
  }
};

GL.ortho = [
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, -1.0, 0.0,
  -1.0, 1.0, 0.0, 1.0,
];

GL.Set2D = function() {
  gl.viewport(0, 0, (VID.width * SCR.devicePixelRatio) >> 0, (VID.height * SCR.devicePixelRatio) >> 0);
  GL.UnbindProgram();
  let i; let program;
  for (i = 0; i < GL.programs.length; ++i) {
    program = GL.programs[i];
    if (program.uOrtho == null) {
      continue;
    }
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.uOrtho, false, GL.ortho);
  }
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
};

/**
 * Determines the scaled dimensions of a texture based on the input width and height.
 * @param {number} width input texture width
 * @param {number} height input texture height
 * @returns {{scaledWidth: number, scaledHeight: number, resampleRequired: boolean}} new dimensions and whether resampling is required
 */
GL.ScaleTextureDimensions = function(width, height) {
  let scaledWidth = width;
  let scaledHeight = height;

  if (((width & (width - 1)) !== 0) || ((height & (height - 1)) !== 0)) {
    --scaledWidth;
    scaledWidth |= (scaledWidth >> 1);
    scaledWidth |= (scaledWidth >> 2);
    scaledWidth |= (scaledWidth >> 4);
    scaledWidth |= (scaledWidth >> 8);
    scaledWidth |= (scaledWidth >> 16);
    ++scaledWidth;
    --scaledHeight;
    scaledHeight |= (scaledHeight >> 1);
    scaledHeight |= (scaledHeight >> 2);
    scaledHeight |= (scaledHeight >> 4);
    scaledHeight |= (scaledHeight >> 8);
    scaledHeight |= (scaledHeight >> 16);
    ++scaledHeight;
  }

  if (scaledWidth > GL.maxtexturesize) {
    scaledWidth = GL.maxtexturesize;
  }

  if (scaledHeight > GL.maxtexturesize) {
    scaledHeight = GL.maxtexturesize;
  }

  return {
    scaledWidth: scaledWidth,
    scaledHeight: scaledHeight,
    resampleRequired: (scaledWidth !== width) || (scaledHeight !== height),
  };
};

GL.ResampleTexture = function(data, inwidth, inheight, outwidth, outheight) {
  const outdata = new ArrayBuffer(outwidth * outheight);
  const out = new Uint8Array(outdata);
  const xstep = inwidth / outwidth; const ystep = inheight / outheight;
  let src; let dest = 0;
  let i; let j;
  for (i = 0; i < outheight; ++i) {
    src = Math.floor(i * ystep) * inwidth;
    for (j = 0; j < outwidth; ++j) {
      out[dest + j] = data[src + Math.floor(j * xstep)];
    }
    dest += outwidth;
  }
  return out;
};

GL.Upload = function(data, width, height) {
  const { scaledWidth, scaledHeight, resampleRequired } = GL.ScaleTextureDimensions(width, height);

  if (resampleRequired) {
    data = GL.ResampleTexture(data, width, height, scaledWidth, scaledHeight);
  }

  data = translateIndexToRGBA(data, scaledWidth, scaledHeight, W.d_8to24table_u8, 255);

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, scaledWidth, scaledHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, GL.filter_min);
  gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, GL.filter_max);
};

GL.ResampleTexture32 = function(data, inwidth, inheight, outwidth, outheight) {
  const outdata = new ArrayBuffer(outwidth * outheight * 4);
  const out = new Uint8Array(outdata);
  const xstep = inwidth / outwidth;
  const ystep = inheight / outheight;
  for (let i = 0; i < outheight; i++) {
    const src_y = Math.floor(i * ystep);
    for (let j = 0; j < outwidth; j++) {
      const src_x = Math.floor(j * xstep);
      const srcIndex = (src_y * inwidth + src_x) * 4;
      const destIndex = (i * outwidth + j) * 4;
      out[destIndex + 0] = data[srcIndex + 0];
      out[destIndex + 1] = data[srcIndex + 1];
      out[destIndex + 2] = data[srcIndex + 2];
      out[destIndex + 3] = data[srcIndex + 3];
    }
  }
  return out;
};

GL.Upload32 = function(data, width, height) {
  const { scaledWidth, scaledHeight, resampleRequired } = GL.ScaleTextureDimensions(width, height);

  if (resampleRequired) {
    data = GL.ResampleTexture32(data, width, height, scaledWidth, scaledHeight);
  }

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, scaledWidth, scaledHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, GL.filter_min);
  gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, GL.filter_max);
};

GL.LoadTexture = function(identifier, width, height, data) {
  let glt; let i;
  if (identifier.length !== 0) {
    for (i = 0; i < GL.textures.length; ++i) {
      glt = GL.textures[i];
      if (glt.identifier === identifier) {
        if ((width !== glt.width) || (height !== glt.height)) {
          throw new Error('GL.LoadTexture: cache mismatch');
        }
        return glt;
      }
    }
  }

  const { scaledWidth, scaledHeight, resampleRequired } = GL.ScaleTextureDimensions(width, height);

  if (resampleRequired) {
    data = GL.ResampleTexture(data, width, height, scaledWidth, scaledHeight);
  }

  glt = { texnum: gl.createTexture(), identifier: identifier, width: width, height: height, ready: true };
  GL.Bind(0, glt.texnum);
  GL.Upload(data, scaledWidth, scaledHeight);
  GL.textures[GL.textures.length] = glt;
  return glt;
};

GL.LoadTexture32 = function(identifier, width, height, data) {
  let glt; let i;
  if (identifier.length !== 0) {
    for (i = 0; i < GL.textures.length; ++i) {
      glt = GL.textures[i];
      if (glt.identifier === identifier) {
        if ((width !== glt.width) || (height !== glt.height)) {
          throw new Error('GL.LoadTexture: cache mismatch');
        }
        return glt;
      }
    }
  }

  glt = { texnum: gl.createTexture(), identifier: identifier, width: width, height: height, ready: true };
  GL.Bind(0, glt.texnum);
  GL.Upload32(data, width, height);
  GL.textures[GL.textures.length] = glt;
  return glt;
};

/**
 * @param pic
 * @deprecated use WadFileInterface.getLumpMipmap() instead
 */
GL.LoadPicTexture = function(pic) {
  const { scaledWidth, scaledHeight, resampleRequired } = GL.ScaleTextureDimensions(pic.width, pic.height);

  let data = pic.data;

  if (resampleRequired) {
    data = GL.ResampleTexture(data, pic.width, pic.height, scaledWidth, scaledHeight);
  }

  data = translateIndexToRGBA(data, scaledWidth, scaledHeight, W.d_8to24table_u8, 255);

  const texnum = gl.createTexture();
  GL.Bind(0, texnum);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, scaledWidth, scaledHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texnum;
};

/**
 * Loads any image file as a texture.
 * @param {string} filename image filename
 * @returns {Promise<WebGLTexture|null>} texture number, null if the image could not be loaded
 */
GL.LoadImageTexture = async function(filename) {
  const data = await COM.LoadFileAsync(filename);

  if (data === null) {
    Con.DPrint(`GL.LoadImageTexture: Could not load image: ${filename}\n`);
    return null;
  }

  const imgblob = new Blob([data]);

  const texnum = gl.createTexture();
  GL.Bind(0, texnum);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, await createImageBitmap(imgblob));
  gl.generateMipmap(gl.TEXTURE_2D);

  return texnum;
};

GL.CreateProgram = async function(identifier, uniforms, attribs, textures) {
  const p = gl.createProgram();
  const program =
  {
    identifier: identifier,
    program: p,
    attribs: [],
  };

  let source = null;

  const vsh = gl.createShader(gl.VERTEX_SHADER);
  source = await COM.LoadTextFileAsync(`shaders/${identifier}.vert`);
  gl.shaderSource(vsh, source);
  gl.compileShader(vsh);
  if (gl.getShaderParameter(vsh, gl.COMPILE_STATUS) !== true) {
    throw new Error('Error compiling shader: ' + gl.getShaderInfoLog(vsh));
  }

  const fsh = gl.createShader(gl.FRAGMENT_SHADER);
  source = await COM.LoadTextFileAsync(`shaders/${identifier}.frag`);
  gl.shaderSource(fsh, source);
  gl.compileShader(fsh);
  if (gl.getShaderParameter(fsh, gl.COMPILE_STATUS) !== true) {
    throw new Error('Error compiling shader: ' + gl.getShaderInfoLog(fsh));
  }

  gl.attachShader(p, vsh);
  gl.attachShader(p, fsh);

  gl.linkProgram(p);
  if (gl.getProgramParameter(p, gl.LINK_STATUS) !== true) {
    throw new Error('Error linking program: ' + gl.getProgramInfoLog(p));
  }

  gl.useProgram(p);

  for (let i = 0; i < uniforms.length; ++i) {
    program[uniforms[i]] = gl.getUniformLocation(p, uniforms[i]);
  }

  program.vertexSize = 0;
  program.attribBits = 0;
  for (let i = 0; i < attribs.length; ++i) {
    const attribParameters = attribs[i];
    const attrib =
    {
      name: attribParameters[0],
      location: gl.getAttribLocation(p, attribParameters[0]),
      type: attribParameters[1],
      components: attribParameters[2],
      normalized: (attribParameters[3] === true),
      offset: program.vertexSize,
    };
    program.attribs[i] = attrib;
    program[attrib.name] = attrib;
    if (attrib.type === gl.FLOAT) {
      program.vertexSize += attrib.components * 4;
    } else if (attrib.type === gl.BYTE || attrib.type === gl.UNSIGNED_BYTE) {
      program.vertexSize += 4;
    } else {
      throw new Error('Unknown vertex attribute type');
    }
    program.attribBits |= 1 << attrib.location;
  }

  for (let i = 0; i < textures.length; ++i) {
    program[textures[i]] = i;
    gl.uniform1i(gl.getUniformLocation(p, textures[i]), i);
  }

  GL.programs[GL.programs.length] = program;
  return program;
};

GL.UseProgram = function(identifier, flushStream) {
  const currentProgram = GL.currentProgram;
  if (currentProgram != null) {
    if (currentProgram.identifier === identifier) {
      return currentProgram;
    }
    if (flushStream === true) {
      GL.StreamFlush();
    }
  }

  let program = null;
  for (let i = 0; i < GL.programs.length; ++i) {
    if (GL.programs[i].identifier === identifier) {
      program = GL.programs[i];
      break;
    }
  }
  if (program == null) {
    return null;
  }

  let enableAttribs = program.attribBits; let disableAttribs = 0;
  if (currentProgram != null) {
    enableAttribs &= ~currentProgram.attribBits;
    disableAttribs = currentProgram.attribBits & ~program.attribBits;
  }
  GL.currentProgram = program;
  gl.useProgram(program.program);
  for (let attrib = 0; enableAttribs !== 0 || disableAttribs !== 0; ++attrib) {
    const mask = 1 << attrib;
    if ((enableAttribs & mask) !== 0) {
      gl.enableVertexAttribArray(attrib);
    } else if ((disableAttribs & mask) !== 0) {
      gl.disableVertexAttribArray(attrib);
    }
    enableAttribs &= ~mask;
    disableAttribs &= ~mask;
  }

  return program;
};

GL.UnbindProgram = function() {
  if (GL.currentProgram == null) {
    return;
  }
  GL.StreamFlush();
  let i;
  for (i = 0; i < GL.currentProgram.attribs.length; ++i) {
    gl.disableVertexAttribArray(GL.currentProgram.attribs[i].location);
  }
  GL.currentProgram = null;
};

GL.identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

GL.RotationMatrix = function(pitch, yaw, roll) {
  pitch *= Math.PI / -180.0;
  yaw *= Math.PI / 180.0;
  roll *= Math.PI / 180.0;
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  return [
    cy * cp,					sy * cp,					-sp,
    -sy * cr + cy * sp * sr,	cy * cr + sy * sp * sr,		cp * sr,
    -sy * -sr + cy * sp * cr,	cy * -sr + sy * sp * cr,	cp * cr,
  ];
};

GL.StreamFlush = function() {
  if (GL.streamArrayVertexCount === 0) {
    return;
  }
  const program = GL.currentProgram;
  if (program != null) {
    gl.bindBuffer(gl.ARRAY_BUFFER, GL.streamBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, GL.streamBufferPosition,
        GL.streamArrayBytes.subarray(0, GL.streamArrayPosition));
    const attribs = program.attribs;
    for (let i = 0; i < attribs.length; ++i) {
      const attrib = attribs[i];
      gl.vertexAttribPointer(attrib.location,
          attrib.components, attrib.type, attrib.normalized,
          program.vertexSize, GL.streamBufferPosition + attrib.offset);
    }
    gl.drawArrays(gl.TRIANGLES, 0, GL.streamArrayVertexCount);
    GL.streamBufferPosition += GL.streamArrayPosition;
  }
  GL.streamArrayPosition = 0;
  GL.streamArrayVertexCount = 0;
};

GL.StreamGetSpace = function(vertexCount) {
  const program = GL.currentProgram;
  if (program == null) {
    return;
  }
  const length = vertexCount * program.vertexSize;
  if ((GL.streamBufferPosition + GL.streamArrayPosition + length) > GL.streamArray.byteLength) {
    GL.StreamFlush();
    GL.streamBufferPosition = 0;
  }
  GL.streamArrayVertexCount += vertexCount;
};

GL.StreamWriteFloat = function(x) {
  GL.streamArrayView.setFloat32(GL.streamArrayPosition, x, true);
  GL.streamArrayPosition += 4;
};

GL.StreamWriteFloat2 = function(x, y) {
  const view = GL.streamArrayView;
  const position = GL.streamArrayPosition;
  view.setFloat32(position, x, true);
  view.setFloat32(position + 4, y, true);
  GL.streamArrayPosition += 8;
};

GL.StreamWriteFloat3 = function(x, y, z) {
  const view = GL.streamArrayView;
  const position = GL.streamArrayPosition;
  view.setFloat32(position, x, true);
  view.setFloat32(position + 4, y, true);
  view.setFloat32(position + 8, z, true);
  GL.streamArrayPosition += 12;
};

GL.StreamWriteFloat4 = function(x, y, z, w) {
  const view = GL.streamArrayView;
  const position = GL.streamArrayPosition;
  view.setFloat32(position, x, true);
  view.setFloat32(position + 4, y, true);
  view.setFloat32(position + 8, z, true);
  view.setFloat32(position + 12, w, true);
  GL.streamArrayPosition += 16;
};

GL.StreamWriteUByte4 = function(x, y, z, w) {
  const view = GL.streamArrayView;
  const position = GL.streamArrayPosition;
  view.setUint8(position, x);
  view.setUint8(position + 1, y);
  view.setUint8(position + 2, z);
  view.setUint8(position + 3, w);
  GL.streamArrayPosition += 4;
};

GL.StreamDrawTexturedQuad = function(x, y, w, h, u, v, u2, v2) {
  const x2 = x + w; const y2 = y + h;
  GL.StreamGetSpace(6);
  GL.StreamWriteFloat4(x, y, u, v);
  GL.StreamWriteFloat4(x, y2, u, v2);
  GL.StreamWriteFloat4(x2, y, u2, v);
  GL.StreamWriteFloat4(x2, y, u2, v);
  GL.StreamWriteFloat4(x, y2, u, v2);
  GL.StreamWriteFloat4(x2, y2, u2, v2);
};

GL.StreamDrawColoredQuad = function(x, y, w, h, r, g, b, a) {
  const x2 = x + w; const y2 = y + h;
  GL.StreamGetSpace(6);
  GL.StreamWriteFloat2(x, y);
  GL.StreamWriteUByte4(r, g, b, a);
  GL.StreamWriteFloat2(x, y2);
  GL.StreamWriteUByte4(r, g, b, a);
  GL.StreamWriteFloat2(x2, y);
  GL.StreamWriteUByte4(r, g, b, a);
  GL.StreamWriteFloat2(x2, y);
  GL.StreamWriteUByte4(r, g, b, a);
  GL.StreamWriteFloat2(x, y2);
  GL.StreamWriteUByte4(r, g, b, a);
  GL.StreamWriteFloat2(x2, y2);
  GL.StreamWriteUByte4(r, g, b, a);
};

GL.Init = function() {
  try {
    const options = {
      preserveDrawingBuffer: true,
    };

    gl = VID.mainwindow.getContext('webgl', options) || VID.mainwindow.getContext('experimental-webgl', options);
  } catch (e) {
    throw new Error(`Unable to initialize WebGL. ${e.message}`);
  }
  if (gl == null) {
    throw new Error('Unable to initialize WebGL. Your browser may not support it.');
  }

  GL.maxtexturesize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.cullFace(gl.FRONT);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);

  GL.modes = [
    ['GL_NEAREST', gl.NEAREST, gl.NEAREST],
    ['GL_LINEAR', gl.LINEAR, gl.LINEAR],
    ['GL_NEAREST_MIPMAP_NEAREST', gl.NEAREST_MIPMAP_NEAREST, gl.NEAREST],
    ['GL_LINEAR_MIPMAP_NEAREST', gl.LINEAR_MIPMAP_NEAREST, gl.LINEAR],
    ['GL_NEAREST_MIPMAP_LINEAR', gl.NEAREST_MIPMAP_LINEAR, gl.NEAREST],
    ['GL_LINEAR_MIPMAP_LINEAR', gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR],
  ];
  GL.filter_min = gl.LINEAR_MIPMAP_NEAREST;
  GL.filter_max = gl.LINEAR;

  GL.picmip = new Cvar('gl_picmip', '0');
  Cmd.AddCommand('gl_texturemode', GL.TextureMode_f);

  GL.streamArray = new ArrayBuffer(8192); // Increasing even a little bit ruins all performance on Mali.
  GL.streamArrayBytes = new Uint8Array(GL.streamArray);
  GL.streamArrayPosition = 0;
  GL.streamArrayVertexCount = 0;
  GL.streamArrayView = new DataView(GL.streamArray);
  GL.streamBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, GL.streamBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, GL.streamArray.byteLength, gl.DYNAMIC_DRAW);
  GL.streamBufferPosition = 0;

  VID.mainwindow.style.display = 'inline-block';
  // VID.mainwindow.style.backgroundImage = 'url("' + Draw.PicToDataURL(Draw.PicFromWad('BACKTILE')) + '")';

  GL.gl = gl;
  eventBus.publish('gl.ready');
};

GL.Shutdown = function() {

  gl = null;
  VID.mainwindow.style.display = 'none';
};
