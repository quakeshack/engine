import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { MissingResourceError } from '../common/Errors.mjs';
import W, { translateIndexToRGBA, WadLumpTexture } from '../common/W.mjs';
import { eventBus, registry } from '../registry.mjs';
import VID from './VID.mjs';

const GL = {};

export default GL;

let { COM, Con } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

/** @type {{[key: string]: {min: number, max: number}}} */
const textureModes = {};

/** @type {string} */
let currentTextureMode = 'GL_LINEAR';

const ortho = [
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, -1.0, 0.0,
  -1.0, 1.0, 0.0, 1.0,
];

// recalculate the ortho matrix when the video size changes
eventBus.subscribe('vid.resize', ({width, height}) => {
  ortho[0] = 2.0 / width;
  ortho[5] = -2.0 / height;
});

/** @type {Map<string, GLTexture>} */
const textureCache = new Map();

class TextureListCommand extends ConsoleCommand {
  run() {
    for (const [identifier, texture] of textureCache.entries()) {
      if (!texture.ready) {
        Con.Print(`${identifier} - NOT ready\n`);
        continue;
      }

      Con.Print(`${identifier} (${texture.width} x ${texture.height})\n`);
    }
  }
};

/** @type {WebGLTexture[]} each index maps to a texture target and points to the texture being bound */
const currentTextureTargets = [];

/** @type {number} */
let currentTextureTarget = null;

export class GLTexture {
  /** @type {string} */
  identifier = null;

  /** @type {number} */
  width = 0;

  /** @type {number} */
  height = 0;

  /** @type {WebGLTexture|null} */
  #texnum = null;

  /** @type {string} */
  #textureMode = null;

  /** @type {Function} */
  #textureModeListener = null;

  /** @type {'repeat' | 'clamp'} */
  #textureWrap = 'repeat';

  /** @deprecated */
  get texnum() {
    return this.#texnum;
  }

  get ready() {
    return this.#texnum !== null;
  }

  /**
   * @param {string} identifier unique name of the texture
   * @param {number} width width
   * @param {number} height height
   * @param {Uint8Array|ImageBitmap|null} data optional texture data in RGBA format
   */
  constructor(identifier, width, height, data = null) {
    this.identifier = identifier;
    this.width = width;
    this.height = height;
    this.#texnum = null;
    this.#textureMode = currentTextureMode;

    console.assert(this.width > 0 && this.height > 0, 'Texture width and height must be greater than zero');
    console.assert(textureCache.has(identifier) === false, 'Texture must not already exist in the cache');

    textureCache.set(identifier, this);

    if (data !== null) {
      this.upload(data);
    }

    this.#textureModeListener = eventBus.subscribe('gl.texturemode', (name) => {
      if (this.#textureMode !== name) {
        this._setTextureMode(name);
      }
    });
  }

  /**
   * Allocates a new texture or returns an existing one from the cache.
   * @param {string} identifier unique name of the texture
   * @param {number} width width
   * @param {number} height height
   * @param {Uint8Array|ImageBitmap|null} data optional texture data in RGBA format or as ImageBitmap
   * @returns {GLTexture} texture instance
   */
  static Allocate(identifier, width, height, data = null) {
    if (textureCache.has(identifier)) {
      const texture = textureCache.get(identifier);

      console.assert(texture.width !== null && texture.width === width && texture.height !== null && texture.height === height, 'Texture dimensions must match');

      return texture;
    }

    return new GLTexture(identifier, width, height, data);
  }

  /**
   * Returns an existing texture from the cache.
   * @param {string} identifier unique name of the texture
   * @param {number} width width
   * @param {number} height height
   * @returns {GLTexture} texture instance
   */
  static FromCache(identifier, width, height) {
    if (!textureCache.has(identifier)) {
      return null;
    }

    const texture = textureCache.get(identifier);

    console.assert(texture.width !== null && texture.width === width && texture.height !== null && texture.height === height, 'Texture dimensions must match');

    return texture;
  }

  /**
   * Allocates a new texture from a lump or returns an existing one from the cache.
   * @param {WadLumpTexture} lump lump containing texture data
   * @returns {GLTexture} texture instance
   */
  static FromLumpTexture(lump) {
    return this.Allocate(lump.name, lump.width, lump.height, lump.data);
  }

  /**
   * Allocates a new texture from an image file or returns an existing one from the cache.
   * @param {string} filename filename an any image
   * @returns {Promise<GLTexture>} texture instance
   */
  static async FromImageFile(filename) {
    // shortcut if the texture is already cached, ignore texture dimensions check
    if (textureCache.has(filename)) {
      return textureCache.get(filename);
    }

    const data = await COM.LoadFileAsync(filename);

    if (data === null) {
      throw new MissingResourceError(filename);
    }

    const image = await createImageBitmap(new Blob([data]));

    return this.Allocate(filename, image.width, image.height, image);
  }

  /**
   * @protected
   * @param {string} name texture mode
   */
  _setTextureMode(name) {
    this.#textureMode = name;

    if (!this.ready) {
      return;
    }

    const { min, max } = textureModes[this.#textureMode];
    this.bind(0);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, max);

    switch (this.#textureWrap) {
    case 'clamp':
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      break;

    case 'repeat':
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      break;
    }
  }

  /**
   * Will lock the texture mode to the specified name.
   * @param {string} name texture mode name
   * @returns {GLTexture} this
   */
  lockTextureMode(name) {
    console.assert(textureModes[name] !== undefined, 'Valid texture mode required');

    this.#textureModeListener();
    this.#textureModeListener = null;

    if (this.#textureMode !== name) {
      this._setTextureMode(name);
    }

    return this;
  }

  wrapClamped() {
    this.#textureWrap = 'clamp';

    if (this.ready) {
      this._setTextureMode(this.#textureMode);
    }

    return this;
  }

  wrapRepeat() {
    this.#textureWrap = 'repeat';

    if (this.ready) {
      this._setTextureMode(this.#textureMode);
    }

    return this;
  }

  resize(width, height) {
    console.assert(width > 0 && height > 0, 'Texture width and height must be greater than zero');

    this.width = width;
    this.height = height;

    this.upload(null);

    return this;
  }

  /**
   * Binds the texture.
   * @param {number} target texture target (0-7)
   * @param {boolean} flushStream flush the stream before binding
   * @returns {GLTexture} this
   */
  bind(target = 0, flushStream = false) {
    if (!this.ready) {
      missingPicTexture.bind(target, flushStream);
      return this;
    }

    if (currentTextureTargets[target] === this.#texnum) {
      // already bound
      return this;
    }

    if (flushStream) {
      GL.StreamFlush();
    }

    if (currentTextureTarget !== target) {
      currentTextureTarget = target;
      gl.activeTexture(gl.TEXTURE0 + target);
    }

    currentTextureTargets[target] = this.#texnum;
    gl.bindTexture(gl.TEXTURE_2D, this.#texnum);

    return this;
  }

  /**
   * Uploads texture data.
   * @param {Uint8Array|ImageBitmap|null} data texture data in RGBA format or as ImageBitmap
   * @returns {GLTexture} this
   */
  upload(data) {
    if (this.#texnum === null) {
      this.#texnum = gl.createTexture();
    }

    this.bind(0);

    if (data instanceof ImageBitmap) {
      this.width = data.width;
      this.height = data.height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
    } else if (data instanceof Uint8Array) {
      console.assert(data.length === this.width * this.height * 4, 'Texture data length must match width and height');

      const { scaledWidth, scaledHeight, resampleRequired } = scaleTextureDimensions(this.width, this.height);

      if (resampleRequired) {
        data = resampleTexture32(data, this.width, this.height, scaledWidth, scaledHeight);
      }

      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, scaledWidth, scaledHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else if (data === null) {
      const { scaledWidth, scaledHeight } = scaleTextureDimensions(this.width, this.height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, scaledWidth, scaledHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    this._setTextureMode(this.#textureMode);

    eventBus.publish('gl.texture.ready', this.identifier);

    return this;
  }

  free() {
    if (this.#textureModeListener !== null) {
      this.#textureModeListener();
      this.#textureModeListener = null;
    }

    if (this.#texnum !== null) {
      gl.deleteTexture(this.#texnum);
      this.#texnum = null;
    }

    textureCache.delete(this.identifier);
  }

  [Symbol.dispose]() {
    this.free();
  }

  toString() {
    return `${this.identifier} (${this.width} x ${this.height}, ${this.ready ? 'ready' : 'not ready'})`;
  }
};

/** @type {GLTexture} */
const missingPicTexture = GLTexture.Allocate('gl_missingpic', 32, 32);

GL.programs = [];

/**
 * @param target
 * @param texnum
 * @param flushStream
 * @deprecated
 */
GL.Bind = function(target, texnum, flushStream) {
  if (currentTextureTargets[target] === texnum) {
    // already bound
    return;
  }

  if (flushStream) {
    GL.StreamFlush();
  }

  if (currentTextureTarget !== target) {
    currentTextureTarget = target;
    gl.activeTexture(gl.TEXTURE0 + target);
  }

  currentTextureTargets[target] = texnum;
  gl.bindTexture(gl.TEXTURE_2D, texnum);
};

class TextureModeCommand extends ConsoleCommand  {
  /** @param {string} name texture filter mode name */
  // @ts-ignore
  run(name) {
    console.assert(currentTextureMode !== null, 'GL.TextureMode_f: currentTextureMode must be set');

    if (name === undefined) {
      Con.Print('Current texture mode: ' + currentTextureMode + '\n');
      return;
    }

    name = name.toUpperCase();

    if (textureModes[name] === undefined) {
      Con.Print('Unknown texture mode: ' + name + '\n');
      return;
    }

    currentTextureMode = name;

    const { min, max } = textureModes[currentTextureMode];

    eventBus.publish('gl.texturemode', name, { min, max });

    Con.Print('Texture mode set to: ' + name + '\n');
  }
};

GL.Set2D = function() {
  gl.viewport(0, 0, Math.floor(VID.width * VID.pixelRatio), Math.floor(VID.height * VID.pixelRatio));
  GL.UnbindProgram();

  for (const { program, uOrtho } of GL.programs) {
    if (!uOrtho) {
      continue;
    }

    gl.useProgram(program);
    gl.uniformMatrix4fv(uOrtho, false, ortho);
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
function scaleTextureDimensions(width, height) {
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

/**
 * @param {Uint8Array} data 8-bit texture data
 * @param {number} inwidth source texture width
 * @param {number} inheight source texture height
 * @param {number} outwidth target texture width
 * @param {number} outheight target texture height
 * @returns {Uint8Array} resampled texture data
 */
export function resampleTexture8(data, inwidth, inheight, outwidth, outheight) {
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

/**
 * @param {Uint8Array} data RGBA texture data
 * @param {number} inwidth source texture width
 * @param {number} inheight source texture height
 * @param {number} outwidth target texture width
 * @param {number} outheight target texture height
 * @returns {Uint8Array} resampled texture data
 */
export function resampleTexture32(data, inwidth, inheight, outwidth, outheight) {
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

/**
 * Initializes the WebGL context and sets up the default state.
 */
function GL_Init() {
  try {
    const options = {
      preserveDrawingBuffer: true,
    };

    // @ts-ignore
    gl = VID.mainwindow.getContext('webgl', options) || VID.mainwindow.getContext('experimental-webgl', options);
  } catch (e) {
    throw new Error(`Unable to initialize WebGL. ${e.message}`);
  }
  if (!gl) {
    throw new Error('Unable to initialize WebGL. Your browser may not support it.');
  }

  GL.maxtexturesize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.cullFace(gl.FRONT);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);

  textureModes['GL_NEAREST'] = { min: gl.NEAREST, max: gl.NEAREST },
  textureModes['GL_LINEAR'] = { min: gl.LINEAR, max: gl.LINEAR },
  textureModes['GL_NEAREST_MIPMAP_NEAREST'] = { min: gl.NEAREST_MIPMAP_NEAREST, max: gl.NEAREST },
  textureModes['GL_LINEAR_MIPMAP_NEAREST'] = { min: gl.LINEAR_MIPMAP_NEAREST, max: gl.LINEAR },
  textureModes['GL_NEAREST_MIPMAP_LINEAR'] = { min: gl.NEAREST_MIPMAP_LINEAR, max: gl.NEAREST },
  textureModes['GL_LINEAR_MIPMAP_LINEAR'] = { min: gl.LINEAR_MIPMAP_LINEAR, max: gl.LINEAR },

  currentTextureMode = 'GL_LINEAR_MIPMAP_LINEAR';

  GL.picmip = new Cvar('gl_picmip', '0');
  Cmd.AddCommand('gl_texturemode', TextureModeCommand);
  Cmd.AddCommand('gl_texturelist', TextureListCommand);

  GL.streamArray = new ArrayBuffer(8192); // Increasing even a little bit ruins all performance on Mali.
  GL.streamArrayBytes = new Uint8Array(GL.streamArray);
  GL.streamArrayPosition = 0;
  GL.streamArrayVertexCount = 0;
  GL.streamArrayView = new DataView(GL.streamArray);
  GL.streamBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, GL.streamBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, GL.streamArray.byteLength, gl.DYNAMIC_DRAW);
  GL.streamBufferPosition = 0;

  // upload a checkerboard (red/black) texture for missing pics
  missingPicTexture.upload((() => {
    const l = 32;
    const data = new Uint8Array(l * l * 4);
    for (let i = 0; i < data.length; i += 4) {
      const unevenRow = Math.floor(i / (l * 4)) % 2 === 1;
      data[i] = ((unevenRow ? 1 : 0) + Math.floor(i / 4)) % 2 === 0 ? 255 : 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
    return data;
  })());

  GL.gl = gl;
  eventBus.publish('gl.ready', gl);
};

/**
 * Cleans up the WebGL context and releases resources.
 */
function GL_Shutdown() {
  for (const { program } of GL.programs) {
    gl.deleteProgram(program);
  }

  currentTextureTargets.length = 0;
  currentTextureTarget = null;

  for (const texture of textureCache.values()) {
    texture.free();
  }

  textureCache.clear();

  GL.programs = [];
  GL.currentProgram = null;

  gl = null;
  eventBus.publish('gl.shutdown');
};

eventBus.subscribe('vid.ready', () => GL_Init());
eventBus.subscribe('vid.shutdown', () => GL_Shutdown());
