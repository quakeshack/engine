import GL, { GLRenderTexture } from '../../GL.ts';
import PostProcess from './PostProcess.ts';
import RenderTarget from '../frame/RenderTarget.ts';
import RenderTargetPair from '../frame/RenderTargetPair.ts';
import VID from '../../VID.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import Vector from '../../../../shared/Vector.ts';
import Host from '../../../common/Host.ts';
import { eventBus } from '../../../common/EventBus.ts';
import { effect } from '../../../../shared/Defs.ts';
import Draw from '../../Draw.ts';
import rendererCvars from '../resources/RendererCvars.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/** Textures available for bloom debug preview rendering. */
interface BloomDebugTextures {
  emissiveTexture: GLRenderTexture | null;
  extractTexture: GLRenderTexture | null;
  blurTexture: GLRenderTexture | null;
}

/** A single item in the bloom debug preview list. */
interface BloomDebugPreviewItem {
  label: string;
  texture: GLRenderTexture;
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

  const previewItems: { label: string; texture: GLRenderTexture | null }[] = [];

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
  /** Bright-pass target, then the vertical blur's result: the bloom the composite reads. */
  static extractTarget: RenderTarget | null = null;

  /** Target of the horizontal blur. */
  static blurTarget: RenderTarget | null = null;

  /** 1x1 bloom metric target. */
  static metricTarget: RenderTarget | null = null;

  /**
   * 1x1 bloom adaptation history. The read side is what the previous frame measured, the write side is what this
   * frame produces; they swap once it is written.
   */
  static adaptation: RenderTargetPair | null = null;

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
    BloomEffect.extractTarget = new RenderTarget({ name: 'bloom-extract', color: [{ storage: 'texture', filter: 'linear' }], depth: null });
    BloomEffect.blurTarget = new RenderTarget({ name: 'bloom-blur', color: [{ storage: 'texture', filter: 'linear' }], depth: null });

    BloomEffect.metricTarget = new RenderTarget({ name: 'bloom-metric', color: [{ storage: 'texture', filter: 'nearest' }], depth: null });
    BloomEffect.#uploadSolidColor(BloomEffect.metricTarget.colorTexture(0), 0, 0, 0, 255);

    BloomEffect.adaptation = new RenderTargetPair({ name: 'bloom-adaptation', color: [{ storage: 'texture', filter: 'nearest' }], depth: null });
    BloomEffect.#uploadSolidColor(BloomEffect.adaptation.read.colorTexture(0), 255, 255, 255, 255);
    BloomEffect.#uploadSolidColor(BloomEffect.adaptation.write.colorTexture(0), 255, 255, 255, 255);

    BloomEffect.historyValid = false;
  }

  /**
   * @param width New width in pixels.
   * @param height New height in pixels.
   */
  override resize(width: number, height: number): void {
    const downsample = rendererCvars.bloomDownsample ? rendererCvars.bloomDownsample.value : 4;
    const size = getBloomBufferSize(width, height, downsample);

    if (BloomEffect.width === size.width && BloomEffect.height === size.height) {
      return;
    }

    BloomEffect.width = size.width;
    BloomEffect.height = size.height;

    BloomEffect.extractTarget!.resize(size.width, size.height);
    BloomEffect.blurTarget!.resize(size.width, size.height);

    BloomEffect.historyValid = false;
  }

  /**
   * @param inputTexture Scene color texture.
   * @param x Output viewport x position.
   * @param y Output viewport y position.
   * @param width Output viewport width.
   * @param height Output viewport height.
   */
  override apply(inputTexture: GLRenderTexture, x: number, y: number, width: number, height: number): void {
    const extract = BloomEffect.extractTarget;
    const blur = BloomEffect.blurTarget;
    const metric = BloomEffect.metricTarget;
    const adaptation = BloomEffect.adaptation;

    if (!extract || !blur || !metric || !adaptation || BloomEffect.width === 0 || BloomEffect.height === 0) {
      return;
    }

    const firstFrame = !BloomEffect.historyValid;

    if (firstFrame) {
      BloomEffect.#resetAdaptationState();
    }

    const outputFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const outputViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    gl.disable(gl.BLEND);

    extract.bind();
    gl.viewport(0, 0, BloomEffect.width, BloomEffect.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#extract();

    blur.bind();
    gl.viewport(0, 0, BloomEffect.width, BloomEffect.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#blur(extract.colorTexture(0), 1.0 / BloomEffect.width, 0.0);

    extract.bind();
    gl.viewport(0, 0, BloomEffect.width, BloomEffect.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#blur(blur.colorTexture(0), 0.0, 1.0 / BloomEffect.height);

    metric.bind();
    gl.viewport(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#measure(extract.colorTexture(0));

    adaptation.write.bind();
    gl.viewport(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    BloomEffect.#adapt(adaptation.read.colorTexture(0), firstFrame);
    adaptation.swap();
    BloomEffect.historyValid = true;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFramebuffer);
    gl.viewport(outputViewport[0], outputViewport[1], outputViewport[2], outputViewport[3]);
    BloomEffect.#composite(inputTexture, x, y, width, height);
  }

  /** Clean up bloom GPU resources. */
  override shutdown(): void {
    BloomEffect.extractTarget?.free();
    BloomEffect.extractTarget = null;
    BloomEffect.blurTarget?.free();
    BloomEffect.blurTarget = null;
    BloomEffect.metricTarget?.free();
    BloomEffect.metricTarget = null;
    BloomEffect.adaptation?.free();
    BloomEffect.adaptation = null;

    BloomEffect.width = 0;
    BloomEffect.height = 0;
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
    const mode = resolveBloomDebugMode(rendererCvars.bloomDebug ? rendererCvars.bloomDebug.value : 0);

    if (mode === 0) {
      return;
    }

    const previewItems = getBloomDebugPreviewItems(mode, {
      emissiveTexture: PostProcess.emissiveTexture,
      extractTexture: BloomEffect.extractTarget?.colorTexture(0) ?? null,
      blurTexture: BloomEffect.blurTarget?.colorTexture(0) ?? null,
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
    const previews: Array<{ label: string; texture: GLRenderTexture; x: number }> = [];
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

  /**
   * Upload a solid color into a 1x1 texture.
   */
  static #uploadSolidColor(texture: GLRenderTexture, red: number, green: number, blue: number, alpha: number): void {
    texture.bind(0);
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
    if (BloomEffect.metricTarget) {
      BloomEffect.#uploadSolidColor(BloomEffect.metricTarget.colorTexture(0), 0, 0, 0, 255);
    }

    if (BloomEffect.adaptation) {
      BloomEffect.adaptation.reset();
      BloomEffect.#uploadSolidColor(BloomEffect.adaptation.read.colorTexture(0), 255, 255, 255, 255);
      BloomEffect.#uploadSolidColor(BloomEffect.adaptation.write.colorTexture(0), 255, 255, 255, 255);
    }

    BloomEffect.historyValid = false;
  }

  static #extract(): void {
    const program = GL.UseProgram('bloom-extract');
    PostProcess.emissiveTexture!.bind(program!.tTexture!);
    gl.uniform2f(program!.uTexelOffset!, 1.0 / BloomEffect.width, 1.0 / BloomEffect.height);
    GL.StreamDrawTexturedQuad(0, 0, VID.width, VID.height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * Measure bloom intensity and approximate screen coverage into a 1x1 texture.
   */
  static #measure(inputTexture: GLRenderTexture): void {
    const program = GL.UseProgram('bloom-metric');
    inputTexture.bind(program!.tTexture!);
    gl.uniform1f(program!.uCoverageThreshold!, BLOOM_METRIC_COVERAGE_THRESHOLD);
    GL.StreamDrawTexturedQuad(0, 0, VID.width, VID.height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * Advance the temporal bloom multiplier from the previous 1x1 state.
   */
  static #adapt(previousTexture: GLRenderTexture, firstFrame: boolean): void {
    const program = GL.UseProgram('bloom-adapt');
    BloomEffect.metricTarget!.colorTexture(0).bind(program!.tMetric!);
    previousTexture.bind(program!.tPrevious!);
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
  static #blur(inputTexture: GLRenderTexture, texelOffsetX: number, texelOffsetY: number): void {
    const program = GL.UseProgram('bloom-blur');
    inputTexture.bind(program!.tTexture!);
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
  static #composite(inputTexture: GLRenderTexture, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('bloom-composite');
    inputTexture.bind(program!.tScene!);
    BloomEffect.extractTarget!.colorTexture(0).bind(program!.tBloom!);
    BloomEffect.adaptation!.read.colorTexture(0).bind(program!.tAdaptation!);
    gl.uniform1f(program!.uStrength!, rendererCvars.bloomStrength.value);
    gl.uniform2f(program!.uBloomTexelOffset!, 1.0 / BloomEffect.width, 1.0 / BloomEffect.height);
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
  static #drawDebugTexture(texture: GLRenderTexture, x: number, y: number, width: number, height: number): void {
    const program = GL.UseProgram('pic');
    gl.uniform3f(program!.uColor!, 1.0, 1.0, 1.0);
    texture.bind(program!.tTexture!);
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
