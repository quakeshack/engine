import GL from '../GL.ts';
import PostProcess from './PostProcess.ts';
import VID from '../VID.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import Vector from '../../../shared/Vector.ts';
import Host from '../../common/Host.ts';
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

const BLOOM_ADAPTATION_DEFAULT_MULTIPLIER = 1.0;
const BLOOM_ADAPTATION_MIN_MULTIPLIER = 0.35;
const BLOOM_ADAPTATION_BRIGHTNESS_START = 0.025;
const BLOOM_ADAPTATION_BRIGHTNESS_END = 0.18;
const BLOOM_ADAPTATION_COVERAGE_START = 0.18;
const BLOOM_ADAPTATION_COVERAGE_END = 0.72;
const BLOOM_ADAPTATION_SETTLE_RATE = 2.8;
const BLOOM_ADAPTATION_RECOVER_RATE = 1.15;
const BLOOM_METRIC_COVERAGE_THRESHOLD = 0.06;

/**
 * Clamp a bloom metric into the unit interval.
 * @returns Clamped bloom metric.
 */
function clampBloomUnit(value: number, fallback = 0.0): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(1.0, Math.max(0.0, value));
}

/**
 * Ease a unit bloom metric with a smoothstep curve.
 * @returns Smoothed bloom metric.
 */
function smoothBloomUnit(value: number): number {
  const clamped = clampBloomUnit(value);

  return clamped * clamped * (3.0 - 2.0 * clamped);
}

/**
 * Remap a raw bloom metric between two thresholds.
 * @returns Unit-space bloom metric.
 */
function remapBloomMetric(value: number, start: number, end: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0.0;
  }

  return clampBloomUnit((value - start) / (end - start));
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
 * Resolve the steady-state bloom multiplier for the measured bloom footprint.
 * @returns Steady-state bloom multiplier.
 */
export function resolveBloomAdaptationTarget(averageLuminance: number, coverage: number): number {
  const brightnessPressure = smoothBloomUnit(remapBloomMetric(
    averageLuminance,
    BLOOM_ADAPTATION_BRIGHTNESS_START,
    BLOOM_ADAPTATION_BRIGHTNESS_END,
  ));
  const coveragePressure = smoothBloomUnit(remapBloomMetric(
    coverage,
    BLOOM_ADAPTATION_COVERAGE_START,
    BLOOM_ADAPTATION_COVERAGE_END,
  ));
  const suppression = brightnessPressure * coveragePressure;

  return BLOOM_ADAPTATION_DEFAULT_MULTIPLIER
    - (BLOOM_ADAPTATION_DEFAULT_MULTIPLIER - BLOOM_ADAPTATION_MIN_MULTIPLIER) * suppression;
}

/**
 * Advance the bloom multiplier toward its target over the current frame.
 * @returns Smoothed bloom multiplier for the current frame.
 */
export function advanceBloomAdaptation(currentMultiplier: number, targetMultiplier: number, frameTime: number): number {
  const current = clampBloomUnit(currentMultiplier, BLOOM_ADAPTATION_DEFAULT_MULTIPLIER);
  const target = clampBloomUnit(targetMultiplier, BLOOM_ADAPTATION_DEFAULT_MULTIPLIER);
  const deltaTime = Number.isFinite(frameTime) ? Math.max(0.0, frameTime) : 0.0;

  if (deltaTime === 0.0 || current === target) {
    return current;
  }

  const rate = target < current ? BLOOM_ADAPTATION_SETTLE_RATE : BLOOM_ADAPTATION_RECOVER_RATE;
  const blend = 1.0 - Math.exp(-deltaTime * rate);

  return current + (target - current) * blend;
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

  /** 1x1 bloom metric framebuffer. */
  static metricFBO: WebGLFramebuffer | null = null;

  /** 1x1 bloom metric texture. */
  static metricTexture: WebGLTexture | null = null;

  /** 1x1 bloom adaptation framebuffers. */
  static adaptationFBOs: Array<WebGLFramebuffer | null> = [null, null];

  /** 1x1 bloom adaptation textures. */
  static adaptationTextures: Array<WebGLTexture | null> = [null, null];

  /** Index of the latest adaptation texture. */
  static adaptationReadIndex = 0;

  /** Whether the adaptation history is valid for the next frame. */
  static historyValid = false;

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

    BloomEffect.metricFBO = gl.createFramebuffer();
    BloomEffect.metricTexture = BloomEffect.#createColorTexture(gl.NEAREST);
    BloomEffect.#uploadSolidColor(BloomEffect.metricTexture, 0, 0, 0, 255);
    gl.bindFramebuffer(gl.FRAMEBUFFER, BloomEffect.metricFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, BloomEffect.metricTexture, 0);

    for (let i = 0; i < BloomEffect.adaptationFBOs.length; ++i) {
      const adaptationFBO = gl.createFramebuffer();
      const adaptationTexture = BloomEffect.#createColorTexture(gl.NEAREST);

      BloomEffect.adaptationFBOs[i] = adaptationFBO;
      BloomEffect.adaptationTextures[i] = adaptationTexture;
      BloomEffect.#uploadSolidColor(adaptationTexture, 255, 255, 255, 255);
      gl.bindFramebuffer(gl.FRAMEBUFFER, adaptationFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, adaptationTexture, 0);
    }

    BloomEffect.adaptationReadIndex = 0;
    BloomEffect.historyValid = false;
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

    BloomEffect.historyValid = false;
  }

  /**
   * @param inputTexture Scene color texture.
   * @param x Output viewport x position.
   * @param y Output viewport y position.
   * @param width Output viewport width.
   * @param height Output viewport height.
   */
  override apply(inputTexture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    if (!BloomEffect.extractFBO || !BloomEffect.blurFBO || !BloomEffect.metricFBO || BloomEffect.width === 0 || BloomEffect.height === 0) {
      return;
    }

    const firstFrame = !BloomEffect.historyValid;

    if (firstFrame) {
      BloomEffect.#resetAdaptationState();
    }

    const previousAdaptationTexture = BloomEffect.adaptationTextures[BloomEffect.adaptationReadIndex];
    const nextAdaptationIndex = (BloomEffect.adaptationReadIndex + 1) % BloomEffect.adaptationTextures.length;
    const nextAdaptationFBO = BloomEffect.adaptationFBOs[nextAdaptationIndex];

    if (!previousAdaptationTexture || !nextAdaptationFBO) {
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

    gl.bindFramebuffer(gl.FRAMEBUFFER, BloomEffect.metricFBO);
    gl.viewport(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#measure(BloomEffect.extractTexture!);

    gl.bindFramebuffer(gl.FRAMEBUFFER, nextAdaptationFBO);
    gl.viewport(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#adapt(previousAdaptationTexture, firstFrame);
    BloomEffect.adaptationReadIndex = nextAdaptationIndex;
    BloomEffect.historyValid = true;

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
    if (BloomEffect.metricFBO) {
      gl.deleteFramebuffer(BloomEffect.metricFBO);
      BloomEffect.metricFBO = null;
    }
    if (BloomEffect.metricTexture) {
      gl.deleteTexture(BloomEffect.metricTexture);
      BloomEffect.metricTexture = null;
    }
    for (let i = 0; i < BloomEffect.adaptationFBOs.length; ++i) {
      const adaptationFBO = BloomEffect.adaptationFBOs[i];
      const adaptationTexture = BloomEffect.adaptationTextures[i];

      if (adaptationFBO) {
        gl.deleteFramebuffer(adaptationFBO);
      }
      if (adaptationTexture) {
        gl.deleteTexture(adaptationTexture);
      }

      BloomEffect.adaptationFBOs[i] = null;
      BloomEffect.adaptationTextures[i] = null;
    }

    BloomEffect.width = 0;
    BloomEffect.height = 0;
    BloomEffect.adaptationReadIndex = 0;
    BloomEffect.historyValid = false;
    this.active = false;
  }

  /**
   * Invalidate the temporal bloom history so the next active frame reseeds it.
   */
  static invalidateHistory(): void {
    BloomEffect.historyValid = false;
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
  static #createColorTexture(filter: number = gl.LINEAR): WebGLTexture {
    const texture = gl.createTexture()!;
    GL.Bind(0, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return texture;
  }

  /**
   * Upload a solid color into a 1x1 texture.
   */
  static #uploadSolidColor(texture: WebGLTexture, red: number, green: number, blue: number, alpha: number): void {
    GL.Bind(0, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([red, green, blue, alpha]),
    );
  }

  /**
   * Reset the adaptation history to the unattenuated bloom state.
   */
  static #resetAdaptationState(): void {
    if (BloomEffect.metricTexture) {
      BloomEffect.#uploadSolidColor(BloomEffect.metricTexture, 0, 0, 0, 255);
    }

    for (const texture of BloomEffect.adaptationTextures) {
      if (texture) {
        BloomEffect.#uploadSolidColor(texture, 255, 255, 255, 255);
      }
    }

    BloomEffect.adaptationReadIndex = 0;
    BloomEffect.historyValid = false;
  }

  static #extract(): void {
    const program = GL.UseProgram('bloom-extract');
    GL.Bind(program!.tTexture!, PostProcess.emissiveTexture);
    GL.StreamDrawTexturedQuad(0, 0, VID.width, VID.height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * Measure bloom intensity and approximate screen coverage into a 1x1 texture.
   */
  static #measure(inputTexture: WebGLTexture): void {
    const program = GL.UseProgram('bloom-metric');
    GL.Bind(program!.tTexture!, inputTexture);
    gl.uniform1f(program!.uCoverageThreshold!, BLOOM_METRIC_COVERAGE_THRESHOLD);
    GL.StreamDrawTexturedQuad(0, 0, VID.width, VID.height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * Advance the temporal bloom multiplier from the previous 1x1 state.
   */
  static #adapt(previousTexture: WebGLTexture, firstFrame: boolean): void {
    const program = GL.UseProgram('bloom-adapt');
    GL.Bind(program!.tMetric!, BloomEffect.metricTexture);
    GL.Bind(program!.tPrevious!, previousTexture);
    gl.uniform1f(program!.uFrameTime!, Host.frametime);
    gl.uniform1f(program!.uSettleRate!, BLOOM_ADAPTATION_SETTLE_RATE);
    gl.uniform1f(program!.uRecoverRate!, BLOOM_ADAPTATION_RECOVER_RATE);
    gl.uniform1f(program!.uMinMultiplier!, BLOOM_ADAPTATION_MIN_MULTIPLIER);
    gl.uniform1f(program!.uBrightnessStart!, BLOOM_ADAPTATION_BRIGHTNESS_START);
    gl.uniform1f(program!.uBrightnessEnd!, BLOOM_ADAPTATION_BRIGHTNESS_END);
    gl.uniform1f(program!.uCoverageStart!, BLOOM_ADAPTATION_COVERAGE_START);
    gl.uniform1f(program!.uCoverageEnd!, BLOOM_ADAPTATION_COVERAGE_END);
    gl.uniform1f(program!.uFirstFrame!, firstFrame ? 1.0 : 0.0);
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
    GL.Bind(program!.tAdaptation!, BloomEffect.adaptationTextures[BloomEffect.adaptationReadIndex]);
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
