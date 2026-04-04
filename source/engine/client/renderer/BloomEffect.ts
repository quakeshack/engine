import GL from '../GL.ts';
import PostProcess from './PostProcess.ts';
import VID from '../VID.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import Vector from '../../../shared/Vector.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import { effect } from '../../../shared/Defs.ts';

let { Draw, R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Draw, R } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/** Textures available for bloom debug preview rendering. */
interface BloomDebugTextures {
  emissiveTexture: WebGLTexture | null;
  extractTexture: WebGLTexture | null;
  blurTexture: WebGLTexture | null;
}

/** A single item in the bloom debug preview list. */
interface BloomDebugPreviewItem {
  label: string;
  texture: WebGLTexture;
}

/**
 * @param downsample Requested downsample divisor.
 * @returns Clamped divisor for the bloom buffers.
 */
export function resolveBloomDownsample(downsample: number): number {
  const requested = downsample >> 0;

  if (requested <= 1) {
    return 1;
  }

  return Math.min(requested, 8);
}

/**
 * @param mode Requested debug preview mode.
 * @returns Clamped bloom debug mode.
 */
export function resolveBloomDebugMode(mode: number): number {
  const requested = mode >> 0;

  if (requested <= 0) {
    return 0;
  }

  return Math.min(requested, 4);
}

/**
 * @param mode Requested debug preview mode.
 * @param textures Preview textures.
 * @returns Preview items to render.
 */
export function getBloomDebugPreviewItems(mode: number, textures: BloomDebugTextures): BloomDebugPreviewItem[] {
  const resolvedMode = resolveBloomDebugMode(mode);

  if (resolvedMode === 0) {
    return [];
  }

  const previewItems: { label: string; texture: WebGLTexture | null }[] = [];

  if (resolvedMode === 1 || resolvedMode === 4) {
    previewItems.push({ label: 'emissive', texture: textures.emissiveTexture });
  }
  if (resolvedMode === 2 || resolvedMode === 4) {
    previewItems.push({ label: 'extract', texture: textures.extractTexture });
  }
  if (resolvedMode === 3 || resolvedMode === 4) {
    previewItems.push({ label: 'blur', texture: textures.blurTexture });
  }

  if (previewItems.length === 0 || previewItems.some((item) => item.texture === null)) {
    return [];
  }

  return previewItems as BloomDebugPreviewItem[];
}

/**
 * @param width Full-resolution width.
 * @param height Full-resolution height.
 * @param downsample Requested downsample divisor.
 * @returns Bloom buffer dimensions.
 */
export function getBloomBufferSize(width: number, height: number, downsample: number): { width: number; height: number } {
  const divisor = resolveBloomDownsample(downsample);

  return {
    width: Math.max(1, Math.floor(width / divisor)),
    height: Math.max(1, Math.floor(height / divisor)),
  };
}

/**
 * @param entityEffects Bitmask of entity effect flags.
 * @returns Emissive bloom scale for the entity.
 */
export function getEntityBloomEmissiveScale(entityEffects: number): number {
  return (entityEffects & (effect.EF_FULLBRIGHT | effect.EF_MUZZLEFLASH)) !== 0 ? 1.0 : 0.0;
}

/**
 * Emissive-driven bloom effect with quarter-resolution blur and additive composite.
 */
export default class BloomEffect extends PostProcessEffect {
  /** Bright-pass framebuffer. */
  static extractFBO: WebGLFramebuffer | null = null;

  /** Bright-pass texture. */
  static extractTexture: WebGLTexture | null = null;

  /** Blur framebuffer. */
  static blurFBO: WebGLFramebuffer | null = null;

  /** Blur texture. */
  static blurTexture: WebGLTexture | null = null;

  /** Current bloom buffer width. */
  static width = 0;

  /** Current bloom buffer height. */
  static height = 0;

  constructor() {
    super('bloom');
  }

  /** Create bloom framebuffers and textures. */
  override init(): void {
    BloomEffect.extractFBO = gl.createFramebuffer();
    BloomEffect.extractTexture = BloomEffect.#createColorTexture();
    gl.bindFramebuffer(gl.FRAMEBUFFER, BloomEffect.extractFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, BloomEffect.extractTexture, 0);

    BloomEffect.blurFBO = gl.createFramebuffer();
    BloomEffect.blurTexture = BloomEffect.#createColorTexture();
    gl.bindFramebuffer(gl.FRAMEBUFFER, BloomEffect.blurFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, BloomEffect.blurTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * @param width New width in pixels.
   * @param height New height in pixels.
   */
  override resize(width: number, height: number): void {
    const downsample = R.bloomDownsample ? R.bloomDownsample.value : 4;
    const size = getBloomBufferSize(width, height, downsample);

    if (BloomEffect.width === size.width && BloomEffect.height === size.height) {
      return;
    }

    BloomEffect.width = size.width;
    BloomEffect.height = size.height;

    GL.Bind(0, BloomEffect.extractTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size.width, size.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    GL.Bind(0, BloomEffect.blurTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size.width, size.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /**
   * @param inputTexture Scene color texture.
   * @param x Output viewport x position.
   * @param y Output viewport y position.
   * @param width Output viewport width.
   * @param height Output viewport height.
   */
  override apply(inputTexture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    if (!BloomEffect.extractFBO || !BloomEffect.blurFBO || BloomEffect.width === 0 || BloomEffect.height === 0) {
      return;
    }

    const outputFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const outputViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, BloomEffect.extractFBO);
    gl.viewport(0, 0, BloomEffect.width, BloomEffect.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#extract();

    gl.bindFramebuffer(gl.FRAMEBUFFER, BloomEffect.blurFBO);
    gl.viewport(0, 0, BloomEffect.width, BloomEffect.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#blur(BloomEffect.extractTexture!, 1.0 / BloomEffect.width, 0.0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, BloomEffect.extractFBO);
    gl.viewport(0, 0, BloomEffect.width, BloomEffect.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#blur(BloomEffect.blurTexture!, 0.0, 1.0 / BloomEffect.height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFramebuffer);
    gl.viewport(outputViewport[0], outputViewport[1], outputViewport[2], outputViewport[3]);
    BloomEffect.#composite(inputTexture, x, y, width, height);
  }

  /** Clean up bloom GPU resources. */
  override shutdown(): void {
    if (BloomEffect.extractFBO) {
      gl.deleteFramebuffer(BloomEffect.extractFBO);
      BloomEffect.extractFBO = null;
    }
    if (BloomEffect.extractTexture) {
      gl.deleteTexture(BloomEffect.extractTexture);
      BloomEffect.extractTexture = null;
    }
    if (BloomEffect.blurFBO) {
      gl.deleteFramebuffer(BloomEffect.blurFBO);
      BloomEffect.blurFBO = null;
    }
    if (BloomEffect.blurTexture) {
      gl.deleteTexture(BloomEffect.blurTexture);
      BloomEffect.blurTexture = null;
    }

    BloomEffect.width = 0;
    BloomEffect.height = 0;
    this.active = false;
  }

  /** Draw an on-screen bloom debug preview. */
  override drawDebugPreview(): void {
    const mode = resolveBloomDebugMode(R.bloomDebug ? R.bloomDebug.value : 0);

    if (mode === 0) {
      return;
    }

    const previewItems = getBloomDebugPreviewItems(mode, {
      emissiveTexture: PostProcess.emissiveTexture,
      extractTexture: BloomEffect.extractTexture,
      blurTexture: BloomEffect.blurTexture,
    });

    if (previewItems.length === 0) {
      return;
    }

    const margin = 16;
    const labelScale = 1.0;
    const labelHeight = 12;
    const availableWidth = Math.max(96, VID.width - margin * (previewItems.length + 1));
    const previewWidth = Math.max(96, Math.min(256, Math.floor(availableWidth / previewItems.length)));
    const previewHeight = Math.max(54, Math.floor(previewWidth * 9 / 16));
    const previews: Array<{ label: string; texture: WebGLTexture; x: number }> = [];
    let x = margin;

    for (const item of previewItems) {
      previews.push({ label: item.label, texture: item.texture, x });
      x += previewWidth + margin;
    }

    gl.disable(gl.BLEND);
    for (const item of previews) {
      BloomEffect.#drawDebugTexture(item.texture, item.x, margin, previewWidth, previewHeight);
      BloomEffect.#drawDebugFrame(item.x, margin, previewWidth, previewHeight);
      GL.StreamFlush();
    }

    gl.enable(gl.BLEND);
    for (const item of previews) {
      Draw.Fill(item.x, margin + previewHeight, previewWidth, labelHeight, new Vector(0.0, 0.0, 0.0), 0.8);
      Draw.StringWhite(item.x + 4, margin + previewHeight + 2, item.label, labelScale);
      GL.StreamFlush();
    }
  }

  /** @returns Newly configured bloom texture. */
  static #createColorTexture(): WebGLTexture {
    const texture = gl.createTexture()!;
    GL.Bind(0, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return texture;
  }

  static #extract(): void {
    const program = GL.UseProgram('bloom-extract');
    GL.Bind(program!.tTexture!, PostProcess.emissiveTexture);
    GL.StreamDrawTexturedQuad(0, 0, VID.width, VID.height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * @param inputTexture Texture to blur.
   * @param texelOffsetX Horizontal texel offset.
   * @param texelOffsetY Vertical texel offset.
   */
  static #blur(inputTexture: WebGLTexture, texelOffsetX: number, texelOffsetY: number): void {
    const program = GL.UseProgram('bloom-blur');
    GL.Bind(program!.tTexture!, inputTexture);
    gl.uniform2f(program!.uTexelOffset!, texelOffsetX, texelOffsetY);
    GL.StreamDrawTexturedQuad(0, 0, VID.width, VID.height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * @param inputTexture Scene color texture.
   * @param x Output viewport x position.
   * @param y Output viewport y position.
   * @param width Output viewport width.
   * @param height Output viewport height.
   */
  static #composite(inputTexture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('bloom-composite');
    GL.Bind(program!.tScene!, inputTexture);
    GL.Bind(program!.tBloom!, BloomEffect.extractTexture);
    gl.uniform1f(program!.uStrength!, R.bloomStrength.value);
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * @param texture Texture to preview.
   * @param x Screen x position.
   * @param y Screen y position.
   * @param width Preview width.
   * @param height Preview height.
   */
  static #drawDebugTexture(texture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('pic');
    gl.uniform3f(program!.uColor!, 1.0, 1.0, 1.0);
    GL.Bind(program!.tTexture!, texture);
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * @param x Frame x position.
   * @param y Frame y position.
   * @param width Frame width.
   * @param height Frame height.
   */
  static #drawDebugFrame(x: number, y: number, width: number, height: number): void {
    const frameColor = new Vector(1.0, 1.0, 1.0);
    Draw.Fill(x - 1, y - 1, width + 2, 1, frameColor);
    Draw.Fill(x - 1, y + height, width + 2, 1, frameColor);
    Draw.Fill(x - 1, y, 1, height, frameColor);
    Draw.Fill(x + width, y, 1, height, frameColor);
  }
}
