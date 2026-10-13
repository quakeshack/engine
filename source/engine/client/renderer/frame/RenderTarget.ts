import GL, { GLRenderTexture } from '../../GL.ts';
import { eventBus } from '../../../common/EventBus.ts';

let gl: WebGL2RenderingContext = null!;

/** What the context of the page supports, read on first use after `gl.ready`. */
let cachedLimits: RenderTargetLimits | null = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
  cachedLimits = null;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
  cachedLimits = null;
});

/** How a texture attachment is sampled. */
export type TextureFilter = 'linear' | 'nearest';

/** An attachment the target creates and owns, backed by a texture a pass can sample. */
export interface TextureAttachmentDescriptor {
  readonly storage: 'texture';

  /** Defaults to `linear` for a color attachment and `nearest` for depth. */
  readonly filter?: TextureFilter;
}

/** An attachment the target creates and owns, backed by a renderbuffer: not sampled, and multisampled on request. */
export interface RenderbufferAttachmentDescriptor {
  readonly storage: 'renderbuffer';
}

/** A texture that belongs to someone else: it is attached, but never allocated, resized or freed by the target. */
export interface ExternalAttachmentDescriptor {
  readonly storage: 'external';
  readonly texture: GLRenderTexture;
}

/** Where one attachment of a target comes from. */
export type AttachmentDescriptor = TextureAttachmentDescriptor | RenderbufferAttachmentDescriptor | ExternalAttachmentDescriptor;

/** What a render target is made of. */
export interface RenderTargetDescriptor {
  /** Names the target in logs and assertions. */
  readonly name: string;

  /** The color attachments in order; none for a depth-only target. */
  readonly color: readonly AttachmentDescriptor[];

  /** The depth attachment, `null` when the pass that draws into it brings its own (a cube face, say). */
  readonly depth: AttachmentDescriptor | null;
}

/** The limits of the context that decide what a target can have. */
export interface RenderTargetLimits {
  readonly maxColorAttachments: number;
  readonly maxDrawBuffers: number;
  readonly maxSamples: number;
}

/** One attachment of a target. */
interface AttachmentSlot {
  readonly texture: GLRenderTexture | null;
  readonly renderbuffer: WebGLRenderbuffer | null;
  readonly owned: boolean;
}

/**
 * A framebuffer with the attachments it owns: creates them from a descriptor, resizes them together (with a sample
 * count for renderbuffers), binds, and frees. Every offscreen surface of the renderer (the scene, the post-process
 * chain, the shadow maps) is one of these, so that allocation lives in one place and a pass is handed a target
 * instead of reaching for a global framebuffer.
 */
export default class RenderTarget {
  /**
   * The context's limits; reads them from the context the first time after it became ready.
   * @returns The limits.
   */
  static get limits(): RenderTargetLimits {
    if (cachedLimits === null) {
      cachedLimits = {
        maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number,
        maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
        maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
      };
    }

    return cachedLimits;
  }

  /** Names the target in logs and assertions. */
  readonly name: string;

  /** The framebuffer object. */
  readonly framebuffer: WebGLFramebuffer;

  /** Width of the attachments in pixels, 0 before the first {@link RenderTarget.resize}. */
  width = 0;

  /** Height of the attachments in pixels, 0 before the first {@link RenderTarget.resize}. */
  height = 0;

  /** Sample count of the renderbuffers, 0 for single-sampled. */
  samples = 0;

  readonly #colors: AttachmentSlot[] = [];
  readonly #depth: AttachmentSlot | null;

  /**
   * Creates the framebuffer and its attachments. The framebuffer binding is left on the default framebuffer, as
   * every creation in the renderer did.
   * @param descriptor What the target is made of.
   */
  constructor(descriptor: RenderTargetDescriptor) {
    console.assert(descriptor.color.length <= RenderTarget.limits.maxDrawBuffers, `render target ${descriptor.name} has more color attachments than the context draws to`);

    this.name = descriptor.name;
    this.framebuffer = gl.createFramebuffer();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);

    for (let i = 0; i < descriptor.color.length; i++) {
      const slot = RenderTarget.#createSlot(descriptor.color[i], 'linear');

      this.#colors.push(slot);
      RenderTarget.#attach(slot, gl.COLOR_ATTACHMENT0 + i);
    }

    if (descriptor.depth !== null) {
      this.#depth = RenderTarget.#createSlot(descriptor.depth, 'nearest');
      RenderTarget.#attach(this.#depth, gl.DEPTH_ATTACHMENT);
    } else {
      this.#depth = null;
    }

    if (descriptor.color.length > 0) {
      gl.drawBuffers(descriptor.color.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    } else {
      // a depth-only target draws no color, and has no color buffer to read either
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Creates one attachment from its descriptor.
   * @param descriptor Where the attachment comes from.
   * @param defaultFilter The filter of a texture whose descriptor does not say.
   * @returns The attachment.
   */
  static #createSlot(descriptor: AttachmentDescriptor, defaultFilter: TextureFilter): AttachmentSlot {
    switch (descriptor.storage) {
      case 'texture': {
        const filter = (descriptor.filter ?? defaultFilter) === 'linear' ? gl.LINEAR : gl.NEAREST;
        const texture = new GLRenderTexture();

        texture.bind(0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        return { texture, renderbuffer: null, owned: true };
      }

      case 'renderbuffer': {
        const renderbuffer = gl.createRenderbuffer();

        // Some drivers require a renderbuffer to be bound at least once before attaching it with
        // framebufferRenderbuffer.
        gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);

        return { texture: null, renderbuffer, owned: true };
      }

      case 'external':
      default:
        return { texture: descriptor.texture, renderbuffer: null, owned: false };
    }
  }

  /**
   * Attaches a slot to the framebuffer that is bound.
   * @param slot The attachment.
   * @param attachmentPoint `COLOR_ATTACHMENTn` or `DEPTH_ATTACHMENT`.
   */
  static #attach(slot: AttachmentSlot, attachmentPoint: GLenum): void {
    if (slot.texture !== null) {
      slot.texture.attachToFramebuffer(attachmentPoint);
      return;
    }

    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachmentPoint, gl.RENDERBUFFER, slot.renderbuffer);
  }

  /**
   * (Re)allocates the storage of an attachment the target owns.
   * @param slot The attachment.
   * @param isDepth Whether it is the depth attachment.
   */
  #allocate(slot: AttachmentSlot, isDepth: boolean): void {
    if (!slot.owned) {
      return;
    }

    if (slot.texture !== null) {
      slot.texture.bind(0);

      if (isDepth) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.width, this.height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }

      return;
    }

    const format = isDepth ? gl.DEPTH_COMPONENT24 : gl.RGBA8;

    gl.bindRenderbuffer(gl.RENDERBUFFER, slot.renderbuffer);

    if (this.samples > 0) {
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, format, this.width, this.height);
    } else {
      gl.renderbufferStorage(gl.RENDERBUFFER, format, this.width, this.height);
    }

    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  /**
   * Gives the attachments the target owns a new size and sample count, and does nothing when neither changed. A
   * size of 0 by 0 releases the storage.
   * @param width Width in pixels.
   * @param height Height in pixels.
   * @param samples Sample count of the renderbuffers (textures are never multisampled), 0 for single-sampled.
   */
  resize(width: number, height: number, samples = 0): void {
    if (width === this.width && height === this.height && samples === this.samples) {
      return;
    }

    this.width = width;
    this.height = height;
    this.samples = samples;

    for (const slot of this.#colors) {
      this.#allocate(slot, false);
    }

    if (this.#depth !== null) {
      this.#allocate(this.#depth, true);
    }
  }

  /**
   * The texture behind a color attachment.
   * @param index The attachment, the first when left out.
   * @returns The texture; the attachment has to be texture-backed.
   */
  colorTexture(index = 0): GLRenderTexture {
    const texture = this.#colors[index]?.texture ?? null;

    console.assert(texture !== null, `render target ${this.name} has no color texture at ${index}`);

    return texture!;
  }

  /**
   * The depth texture of the target.
   * @returns The texture, `null` when the depth attachment is a renderbuffer or there is none.
   */
  get depthTexture(): GLRenderTexture | null {
    return this.#depth?.texture ?? null;
  }

  /**
   * The depth renderbuffer of the target.
   * @returns The renderbuffer, `null` when the depth attachment is a texture or there is none.
   */
  get depthRenderbuffer(): WebGLRenderbuffer | null {
    return this.#depth?.renderbuffer ?? null;
  }

  /** Binds the framebuffer for reading and drawing. */
  bind(): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
  }

  /** Binds the framebuffer as the source of a blit. */
  bindForRead(): void {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
  }

  /** Binds the framebuffer as the destination of a blit. */
  bindForDraw(): void {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
  }

  /**
   * Attaches one face of a cube texture as the depth attachment, for a pass that draws six faces in turn. The
   * framebuffer has to be bound.
   * @param texture The cube texture.
   * @param face The face, 0 to 5 in `POSITIVE_X` to `NEGATIVE_Z` order.
   */
  attachDepthCubeFace(texture: WebGLTexture, face: number): void {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, 0);
  }

  /**
   * Takes the depth texture off the framebuffer and puts a renderbuffer in its place, so that the texture can be
   * sampled while the framebuffer is drawn to. Binds the framebuffer.
   * @param renderbuffer What keeps the depth test going meanwhile.
   */
  swapDepthToRenderbuffer(renderbuffer: WebGLRenderbuffer): void {
    this.bind();
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);
  }

  /**
   * Undoes {@link RenderTarget.swapDepthToRenderbuffer}: the depth texture is the depth attachment again. Binds the
   * framebuffer.
   */
  restoreDepthTexture(): void {
    console.assert(this.#depth?.texture !== null && this.#depth?.texture !== undefined, `render target ${this.name} has no depth texture`);

    this.bind();
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
    this.#depth!.texture!.attachToFramebuffer(gl.DEPTH_ATTACHMENT);
  }

  /** Deletes the framebuffer and the attachments the target owns. */
  free(): void {
    gl.deleteFramebuffer(this.framebuffer);

    const slots = this.#depth !== null ? [...this.#colors, this.#depth] : this.#colors;

    for (const slot of slots) {
      if (!slot.owned) {
        continue;
      }

      if (slot.texture !== null) {
        slot.texture.free();
      } else if (slot.renderbuffer !== null) {
        gl.deleteRenderbuffer(slot.renderbuffer);
      }
    }

    this.width = 0;
    this.height = 0;
    this.samples = 0;
  }
}
