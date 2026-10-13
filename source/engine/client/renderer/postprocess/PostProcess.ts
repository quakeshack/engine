import GL, { GLRenderTexture } from '../../GL.ts';
import Cvar from '../../../common/Cvar.ts';
import VID from '../../VID.ts';
import Host from '../../../common/Host.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import PostProcessEntries, { type ResolvedPostProcessEntry } from './PostProcessEntries.ts';
import RenderTarget from '../frame/RenderTarget.ts';
import { eventBus } from '../../../common/EventBus.ts';
import type { PostProcessPulseDescriptor, PostProcessPulseOptions, PostProcessStack, PostProcessStackOptions } from '../../../../shared/GameInterfaces.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * Post-process rendering infrastructure with an effect pipeline.
 *
 * Manages a scene framebuffer with color and depth texture attachments,
 * enabling depth-aware effects like volumetric fog during scene rendering.
 *
 * After scene rendering, registered effects (warp, motion blur, flash, etc.)
 * are applied in order via a ping-pong FBO resolve chain. Each effect reads
 * from one texture and writes to another, with the final result blitted to
 * the default framebuffer (screen).
 *
 * Effects that need the depth buffer (e.g. fog volumes) are handled during
 * scene rendering via `beginDepthSampling`/`endDepthSampling`
 * and are NOT part of the post-resolve effect pipeline.
 */
export default class PostProcess {
  // ─── Scene target (depth-aware rendering) ────────────────────────

  /** The scene: color and emissive textures and a depth texture, drawn into when nothing is multisampled. */
  static scene: RenderTarget | null = null;

  /**
   * Scratch target that the scene depth is blitted into while the depth texture is sampled: its color attachment is
   * the scene color (to be complete), its depth renderbuffer takes the depth test over from the scene target.
   */
  static depthCopy: RenderTarget | null = null;

  /**
   * A 1x1 transparent texture. {@link PostProcess.endDepthSampling} binds it to the sampler units that were given
   * the depth texture, so the depth texture is no longer bound anywhere when it is attached to the FBO again.
   */
  static nullTexture: GLRenderTexture | null = null;

  /** The sampler units that {@link PostProcess.bindDepthForSampling} bound the depth texture to. */
  static readonly #sampledDepthUnits: number[] = [];

  /** Current scene FBO width in pixels. */
  static width = 0;

  /** Current scene FBO height in pixels. */
  static height = 0;

  /** Whether the PostProcess system is currently active (FBO bound). */
  static active = false;

  // ─── MSAA (multisampled scene FBO) ───────────────────────────────

  /** MSAA sample count (0 = off, 2/4/8). */
  static msaa: Cvar | null = null;

  /** Multisampled scene target: two color renderbuffers (color, emissive) and a depth renderbuffer. */
  static msaaTarget: RenderTarget | null = null;

  /** Current MSAA sample count (0 = disabled). */
  static msaaSamples = 0;

  /** Whether MSAA has been resolved to the texture FBO this frame. */
  static msaaResolved = false;

  // ─── Turbulent boundary depth FBO (underwater fog) ───────────────

  /**
   * Depth-only target for capturing turbulent surface depths before the main
   * scene render. Used by the underwater fog effect to determine where the
   * water surface boundary is per-pixel.
   */
  static turbulentBoundary: RenderTarget | null = null;

  // ─── Ping-pong targets for effect chaining ───────────────────────

  /** Ping target for effect chaining. */
  static ping: RenderTarget | null = null;

  /** Pong target for effect chaining. */
  static pong: RenderTarget | null = null;

  /** Ping-pong FBO width. */
  static ppWidth = 0;

  /** Ping-pong FBO height. */
  static ppHeight = 0;

  // ─── Effect pipeline ─────────────────────────────────────────────

  /** Registered effects, applied in order. */
  static effects: PostProcessEffect[] = [];

  /**
   * The gameplay-driven entries: the stack of each channel, with its fades, and the pulses. The entries name
   * effects of {@link PostProcess.effects} by id.
   */
  static readonly entries = new PostProcessEntries((id) => PostProcess.getEffect(id));

  /** The clock reading of the last {@link PostProcess.advance}, `null` before the first. */
  static #lastAdvanceTime: number | null = null;

  /**
   * Color texture of the scene.
   * @returns The texture, `null` before {@link PostProcess.init}.
   */
  static get colorTexture(): GLRenderTexture | null {
    return PostProcess.scene?.colorTexture(0) ?? null;
  }

  /**
   * Emissive texture of the scene, the second color attachment.
   * @returns The texture, `null` before {@link PostProcess.init}.
   */
  static get emissiveTexture(): GLRenderTexture | null {
    return PostProcess.scene?.colorTexture(1) ?? null;
  }

  /**
   * Depth texture of the scene.
   * @returns The texture, `null` before {@link PostProcess.init}.
   */
  static get depthTexture(): GLRenderTexture | null {
    return PostProcess.scene?.depthTexture ?? null;
  }

  /**
   * Depth texture of the turbulent boundary pass.
   * @returns The texture, `null` before {@link PostProcess.init}.
   */
  static get turbulentBoundaryDepthTexture(): GLRenderTexture | null {
    return PostProcess.turbulentBoundary?.depthTexture ?? null;
  }

  /**
   * Register a post-process effect. Effects are applied in the order
   * they are added. Each effect's {@link PostProcessEffect.init} is
   * called during registration.
   */
  static addEffect(effect: PostProcessEffect): void {
    effect.init();
    PostProcess.effects.push(effect);
  }

  /**
   * Replaces the stack of a channel. It is applied from the next rendered frame on.
   * @param stack The entries in the order they are applied.
   * @param options The channel, and the seconds to cross-fade from the previous stack of that channel.
   */
  static setStack(stack: PostProcessStack, options?: PostProcessStackOptions): void {
    PostProcess.entries.setStack(stack, options);
  }

  /**
   * Removes the stack of a channel at once; pulses that are running end on their own.
   * @param channel The channel, every channel when left out.
   */
  static clearStack(channel?: string): void {
    PostProcess.entries.clearStack(channel);
  }

  /**
   * Starts an entry that lives for the time its timing says and then removes itself. A pulse that is running
   * under the same key starts over.
   * @param descriptor The entry and its timing.
   * @param options The channel it is composed with.
   */
  static pulse(descriptor: PostProcessPulseDescriptor, options?: PostProcessPulseOptions): void {
    PostProcess.entries.pulse(descriptor, options);
  }

  /**
   * Whether a game has set a stack that is meant to stay.
   * @param channel The channel, any channel when left out.
   * @returns True when there is such an entry. Pulses and entries that fade out do not count.
   */
  static hasStack(channel?: string): boolean {
    return PostProcess.entries.hasStack(channel);
  }

  /**
   * Whether the game drives anything this frame: a stack, an entry that fades out, or a pulse.
   * @returns True when {@link PostProcess.resolveGameplayStack} or the resolve have something to apply.
   */
  static hasGameplayStack(): boolean {
    return PostProcess.entries.hasEntries();
  }

  /**
   * Lets the time since the previous call pass for the fades and pulses. Called once per rendered frame, on the
   * real clock: a fade keeps going over a paused game, where a menu blur is wanted most. A stalled frame moves
   * time by at most 0.1 s, so it does not skip a fade.
   */
  static advance(): void {
    const now = Host.realtime;
    const elapsed = PostProcess.#lastAdvanceTime === null ? 0 : now - PostProcess.#lastAdvanceTime;

    PostProcess.#lastAdvanceTime = now;
    PostProcess.entries.advance(elapsed);
  }

  /**
   * Get a registered effect by name.
   * @returns The effect with the given name, or undefined if not registered.
   */
  static getEffect(name: string): PostProcessEffect | undefined {
    return PostProcess.effects.find((e) => e.name === name);
  }

  /**
   * Whether any post-process effect is currently active.
   * @returns True when at least one registered effect is active.
   */
  static hasActiveEffects(): boolean {
    return PostProcess.effects.some((e) => e.active) || PostProcess.entries.hasEntries();
  }

  /** Whether the frame preparation asked for the scene to be captured, see {@link PostProcess.requestSceneCapture}. */
  static #sceneCaptureRequested = false;

  /**
   * Tells the post-process system whether something in the scene needs to sample the captured color or depth
   * (turbulent surfaces, fog volumes, underwater fog), independent of whether a screen-space effect is active.
   * The frame preparation calls it every frame; the request stays until it is called again.
   */
  static requestSceneCapture(required: boolean): void {
    PostProcess.#sceneCaptureRequested = required;
  }

  /**
   * Whether the scene is rendered into the capture FBO this frame and resolved from it afterwards: something
   * asked for it with {@link PostProcess.requestSceneCapture}, or a screen-space effect needs the capture.
   * The single predicate for `R.SetupGL` (begin) and `ScreenFrame` (end and resolve).
   * @returns True when the frame goes through the capture FBO.
   */
  static needsSceneCapture(): boolean {
    return PostProcess.#sceneCaptureRequested || PostProcess.hasActiveEffects();
  }

  /**
   * Initialize the post-process system.
   * Creates the scene target, the MSAA target (storage is allocated when it is enabled), and ping-pong targets.
   */
  static init(): void {
    PostProcess.msaa = new Cvar('gl_msaa', '4', Cvar.FLAG.ARCHIVE, ' MSAA sample count (0 = off, 2/4/8)');

    PostProcess.scene = new RenderTarget({
      name: 'scene',
      color: [{ storage: 'texture', filter: 'linear' }, { storage: 'texture', filter: 'linear' }],
      depth: { storage: 'texture', filter: 'nearest' },
    });

    // Scratch target for depth blits: the color attachment keeps it complete, the depth renderbuffer receives the
    // copied scene depth for subsequent depth tests.
    PostProcess.depthCopy = new RenderTarget({
      name: 'scene-depth-copy',
      color: [{ storage: 'external', texture: PostProcess.scene.colorTexture(0) }],
      depth: { storage: 'renderbuffer' },
    });

    // What the depth texture's sampler units are reset to after depth sampling.
    PostProcess.nullTexture = new GLRenderTexture();
    PostProcess.nullTexture.bind(0);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Turbulent boundary depth target — depth-only, resized in resize().
    PostProcess.turbulentBoundary = new RenderTarget({
      name: 'turbulent-boundary',
      color: [],
      depth: { storage: 'texture', filter: 'nearest' },
    });

    // MSAA target with multisampled renderbuffers (storage allocated in resize()).
    PostProcess.msaaTarget = new RenderTarget({
      name: 'scene-msaa',
      color: [{ storage: 'renderbuffer' }, { storage: 'renderbuffer' }],
      depth: { storage: 'renderbuffer' },
    });

    // Ping-pong targets for effect chaining
    PostProcess.ping = new RenderTarget({ name: 'post-process-ping', color: [{ storage: 'texture', filter: 'linear' }], depth: null });
    PostProcess.pong = new RenderTarget({ name: 'post-process-pong', color: [{ storage: 'texture', filter: 'linear' }], depth: null });
  }

  /**
   * Resize the scene targets to match the viewport dimensions, and follow `gl_msaa`: a change of the variable is
   * taken up here, the next time the scene is captured.
   */
  static resize(width: number, height: number): void {
    PostProcess.width = width;
    PostProcess.height = height;

    PostProcess.scene!.resize(width, height);
    PostProcess.depthCopy!.resize(width, height);
    PostProcess.turbulentBoundary!.resize(width, height);

    // Multisampled renderbuffers (if enabled)
    const requested = PostProcess.msaa!.value >> 0;
    const samples = requested > 0 ? Math.min(requested, RenderTarget.limits.maxSamples) : 0;

    PostProcess.msaaSamples = samples;

    if (samples > 0) {
      PostProcess.msaaTarget!.resize(width, height, samples);
    } else {
      // nothing is drawn into it, so it does not keep the memory
      PostProcess.msaaTarget!.resize(0, 0, 0);
    }
  }

  /**
   * Begin the turbulent boundary depth pre-pass.
   * Binds the depth-only boundary FBO, clears it to the far plane, and sets
   * the GL state needed to capture turbulent surface depths from both faces.
   * Call endTurbulentBoundaryPass when the pass is complete.
   */
  static beginTurbulentBoundaryPass(): void {
    PostProcess.turbulentBoundary!.bind();
    gl.viewport(0, 0, PostProcess.width, PostProcess.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  /**
   * End the turbulent boundary depth pre-pass and restore the scene FBO.
   */
  static endTurbulentBoundaryPass(): void {
    gl.enable(gl.CULL_FACE);
    // Restore whichever scene FBO was active before the pre-pass.
    (PostProcess.msaaSamples > 0 ? PostProcess.msaaTarget! : PostProcess.scene!).bind();
    gl.viewport(0, 0, PostProcess.width, PostProcess.height);
  }

  /**
   * Resize the ping-pong FBOs used for effect chaining.
   */
  static resizePingPong(width: number, height: number): void {
    if (PostProcess.ppWidth === width && PostProcess.ppHeight === height) {
      return;
    }

    PostProcess.ppWidth = width;
    PostProcess.ppHeight = height;

    PostProcess.ping!.resize(width, height);
    PostProcess.pong!.resize(width, height);

    // Notify effects of the new dimensions
    for (const effect of PostProcess.effects) {
      effect.resize(width, height);
    }
  }

  /**
   * Begin rendering the scene to the post-process FBO.
   * When MSAA is enabled, binds the multisampled FBO instead so the scene
   * is rendered with anti-aliasing. The MSAA FBO is resolved to the
   * texture FBO before depth sampling or at `end()`.
   */
  static begin(): void {
    if (PostProcess.msaaSamples > 0) {
      PostProcess.msaaTarget!.bind();
      PostProcess.msaaResolved = false;
    } else {
      PostProcess.scene!.bind();
    }
    gl.viewport(0, 0, PostProcess.width, PostProcess.height);
    gl.clearBufferfv(gl.COLOR, 0, [0.0, 0.0, 0.0, 0.0]);
    gl.clearBufferfv(gl.COLOR, 1, [0.0, 0.0, 0.0, 0.0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    PostProcess.active = true;
  }

  /**
   * Detach the depth texture from the FBO so it can be sampled in shaders.
   * Attaches a depth renderbuffer instead to keep the FBO complete.
   * If MSAA is active, resolves to the texture FBO first so the depth
   * texture contains valid data.
   *
   * Callers bind the depth texture with {@link PostProcess.bindDepthForSampling},
   * and `endDepthSampling()` takes it off those sampler units again. WebGL
   * flags a feedback loop when a texture is simultaneously an FBO attachment
   * and bound to any sampler unit — even one a later draw's material doesn't
   * touch — so a unit must never keep it after the pass.
   */
  static beginDepthSampling(): void {
    if (PostProcess.msaaSamples > 0 && !PostProcess.msaaResolved) {
      PostProcess.resolveMSAA();
    }

    // Keep depth testing valid for geometry passes that sample depth by first
    // copying the current scene depth texture into the temporary depth renderbuffer.
    PostProcess.scene!.bindForRead();
    PostProcess.depthCopy!.bindForDraw();
    gl.blitFramebuffer(
      0,
      0,
      PostProcess.width,
      PostProcess.height,
      0,
      0,
      PostProcess.width,
      PostProcess.height,
      gl.DEPTH_BUFFER_BIT,
      gl.NEAREST,
    );

    PostProcess.scene!.swapDepthToRenderbuffer(PostProcess.depthCopy!.depthRenderbuffer!);
  }

  /**
   * Binds the scene depth texture to a sampler unit for the pass between
   * `beginDepthSampling()` and `endDepthSampling()`, and remembers the unit so
   * that `endDepthSampling()` can release it.
   * @param unit The sampler unit the shader reads the depth from (e.g. `program.tDepth`).
   */
  static bindDepthForSampling(unit: number): void {
    console.assert(PostProcess.depthTexture !== null, 'depth texture required');
    PostProcess.depthTexture!.bind(unit);
    PostProcess.#sampledDepthUnits.push(unit);
  }

  /**
   * Ends depth sampling: takes the depth texture off the sampler units it was
   * bound to by {@link PostProcess.bindDepthForSampling} and attaches it to the
   * FBO again.
   */
  static endDepthSampling(): void {
    for (const unit of PostProcess.#sampledDepthUnits) {
      PostProcess.nullTexture!.bind(unit);
    }

    PostProcess.#sampledDepthUnits.length = 0;

    PostProcess.scene!.restoreDepthTexture();
  }

  /**
   * Resolve one multisampled color attachment into a texture-backed attachment 0.
   * Some browsers reject `drawBuffers([COLOR_ATTACHMENT1])` during blits, so the
   * destination attachment is temporarily rebound to slot 0 for the resolve.
   * @param readAttachment Source MSAA color attachment.
   * @param targetTexture Destination texture.
   * @param width Resolve width in pixels.
   * @param height Resolve height in pixels.
   */
  static _resolveMSAAColorAttachment(readAttachment: GLenum, targetTexture: GLRenderTexture, width: number, height: number): void {
    gl.readBuffer(readAttachment);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    targetTexture.attachToFramebuffer(gl.COLOR_ATTACHMENT0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  /**
   * Resolve the multisampled FBO to the texture-backed scene FBO.
   * Blits both color and depth so the texture FBO has valid data for
   * depth sampling and the effect pipeline. After this call, the
   * texture FBO is bound as the active FRAMEBUFFER.
   */
  static resolveMSAA(): void {
    const w = PostProcess.width;
    const h = PostProcess.height;
    const scene = PostProcess.scene!;

    PostProcess.msaaTarget!.bindForRead();
    scene.bindForDraw();

    PostProcess._resolveMSAAColorAttachment(gl.COLOR_ATTACHMENT0, scene.colorTexture(0), w, h);
    PostProcess._resolveMSAAColorAttachment(gl.COLOR_ATTACHMENT1, scene.colorTexture(1), w, h);

    scene.colorTexture(0).attachToFramebuffer(gl.COLOR_ATTACHMENT0);
    scene.colorTexture(1).attachToFramebuffer(gl.COLOR_ATTACHMENT1);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    scene.bind();
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    PostProcess.msaaResolved = true;
  }

  /**
   * End scene rendering. If MSAA is active and hasn't been resolved yet
   * (no-fog path), resolves to the texture FBO first so the color texture
   * is available for the effect pipeline. Then unbinds the FBO.
   */
  static end(): void {
    if (PostProcess.msaaSamples > 0 && !PostProcess.msaaResolved) {
      PostProcess.resolveMSAA();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    PostProcess.active = false;
  }

  /**
   * Resolve the scene to the screen, applying all active effects in order.
   * When no effects are active, performs a simple blit. When effects are
   * active, chains them using ping-pong FBOs.
   */
  static resolve(x: number, y: number, width: number, height: number, sceneTexture: GLRenderTexture): void {
    // the renderer's own effects in registration order, then what the game put in the final stage
    const activeEffects: Array<{ effect: PostProcessEffect; settings: object | null }> = PostProcess.effects
      .filter((e) => e.active)
      .map((effect) => ({ effect, settings: null }));

    for (const entry of PostProcess.entries.collect('final')) {
      const effect = PostProcess.getEffect(entry.id);

      if (effect !== undefined) {
        activeEffects.push({ effect, settings: entry.settings });
      }
    }

    if (activeEffects.length === 0) {
      // No effects — simple blit to screen
      PostProcess._blitToScreen(sceneTexture, x, y, width, height);
      return;
    }

    // Ensure ping-pong FBOs are sized correctly
    const pixelWidth = (width * VID.pixelRatio) >> 0;
    const pixelHeight = (height * VID.pixelRatio) >> 0;
    PostProcess.resizePingPong(pixelWidth, pixelHeight);

    // Save the current viewport (GL.Set2D has already set up 2D rendering)
    const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    gl.disable(gl.BLEND);

    let inputTexture = sceneTexture;
    const targets = [PostProcess.ping!, PostProcess.pong!];

    for (let i = 0; i < activeEffects.length; i++) {
      const isLast = (i === activeEffects.length - 1);

      if (isLast) {
        // Last effect renders directly to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
        activeEffects[i].effect.apply(inputTexture, x, y, width, height, activeEffects[i].settings);
      } else {
        // Intermediate effects render to the next ping-pong FBO
        const target = targets[i % 2];
        target.bind();
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        // Draw at ortho-space dimensions (VID.width/height) so the ortho matrix works
        activeEffects[i].effect.apply(inputTexture, 0, 0, VID.width, VID.height, activeEffects[i].settings);
        inputTexture = target.colorTexture(0);
      }
    }

    gl.enable(gl.BLEND);
  }

  /**
   * Apply the game-driven effect stack to the scene texture.
   * Chains each effect through ping-pong FBOs, then writes the final
   * result back into {@link PostProcess.colorTexture} so {@link PostProcess.resolve} can use
   * it without an FBO read/write hazard.
   */
  static resolveGameplayStack(): void {
    const entries: Array<{ effect: PostProcessEffect; settings: ResolvedPostProcessEntry['settings'] }> = [];

    for (const entry of PostProcess.entries.collect('scene')) {
      const effect = PostProcess.getEffect(entry.id);

      if (effect !== undefined) {
        entries.push({ effect, settings: entry.settings });
      }
    }

    if (entries.length === 0) {
      return;
    }

    const w = PostProcess.width;
    const h = PostProcess.height;
    PostProcess.resizePingPong(w, h);

    // the caller draws to the screen next, at the viewport it set up before
    const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    gl.disable(gl.BLEND);

    let input: GLRenderTexture = PostProcess.colorTexture!;
    const targets = [PostProcess.ping!, PostProcess.pong!];

    for (let i = 0; i < entries.length; i++) {
      const target = targets[i % 2];
      target.bind();
      gl.viewport(0, 0, w, h);
      entries[i].effect.apply(input, 0, 0, VID.width, VID.height, entries[i].settings);
      input = target.colorTexture(0);
    }

    // Write the final result back into COLOR_ATTACHMENT0 of the scene FBO so
    // that PostProcess.resolve() reads from colorTexture without a ping-pong
    // read/write hazard.
    PostProcess.scene!.bind();
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, w, h);
    PostProcess._blitToScreen(input, 0, 0, VID.width, VID.height);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    // Back to the screen, as `end()` left it. `resolve()` without an effect of the renderer blits to whatever is
    // bound, which was the scene FBO: nothing reached the screen and the HUD was drawn into the FBO.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);

    gl.enable(gl.BLEND);
  }

  /**
   * Blit a texture to the screen using the 'pic' shader.
   */
  static _blitToScreen(texture: GLRenderTexture, x: number, y: number, width: number, height: number): void {
    gl.disable(gl.BLEND);

    const program = GL.UseProgram('pic')!;
    gl.uniform3f(program!.uColor!, 1.0, 1.0, 1.0);
    texture.bind(program!.tTexture!);
    // FBO texture has (0,0) at bottom-left; 2D screen has (0,0) at top-left.
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();

    gl.enable(gl.BLEND);
  }

  /**
   * Clean up all GPU resources.
   */
  static shutdown(): void {
    PostProcess.entries.reset();
    PostProcess.#lastAdvanceTime = null;

    // Shut down all effects
    for (const effect of PostProcess.effects) {
      effect.shutdown();
    }
    PostProcess.effects.length = 0;

    // Scene targets
    PostProcess.depthCopy?.free();
    PostProcess.depthCopy = null;
    PostProcess.scene?.free();
    PostProcess.scene = null;

    if (PostProcess.nullTexture) {
      PostProcess.nullTexture.free();
      PostProcess.nullTexture = null;
    }

    PostProcess.turbulentBoundary?.free();
    PostProcess.turbulentBoundary = null;

    PostProcess.msaaTarget?.free();
    PostProcess.msaaTarget = null;
    PostProcess.msaaSamples = 0;
    PostProcess.msaaResolved = false;

    // Ping-pong targets
    PostProcess.ping?.free();
    PostProcess.ping = null;
    PostProcess.pong?.free();
    PostProcess.pong = null;

    PostProcess.width = 0;
    PostProcess.height = 0;
    PostProcess.ppWidth = 0;
    PostProcess.ppHeight = 0;
    PostProcess.active = false;
  }
}
