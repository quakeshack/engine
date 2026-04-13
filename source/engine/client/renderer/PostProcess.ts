import GL from '../GL.ts';
import Cvar from '../../common/Cvar.ts';
import VID from '../VID.ts';
import PostProcessEffect from './PostProcessEffect.ts';
import { eventBus } from '../../registry.ts';
import type { PostProcessStack, PostProcessEffectDescriptor } from '../../../shared/GameInterfaces.ts';

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
  // ─── Scene FBO (depth-aware rendering) ───────────────────────────

  /** Scene framebuffer object. */
  static fbo: WebGLFramebuffer | null = null;

  /** Color texture attachment (RGBA). */
  static colorTexture: WebGLTexture | null = null;

  /** Emissive texture attachment (RGBA). */
  static emissiveTexture: WebGLTexture | null = null;

  /** Depth texture attachment (DEPTH_COMPONENT24). */
  static depthTexture: WebGLTexture | null = null;

  /** Depth renderbuffer used temporarily during depth sampling. */
  static depthRenderbuffer: WebGLRenderbuffer | null = null;

  /** Current scene FBO width in pixels. */
  static width = 0;

  /** Current scene FBO height in pixels. */
  static height = 0;

  /** Whether the PostProcess system is currently active (FBO bound). */
  static active = false;

  // ─── MSAA (multisampled scene FBO) ───────────────────────────────

  /** MSAA sample count (0 = off, 2/4/8). */
  static msaa: Cvar | null = null;

  /** Multisampled FBO for scene rendering. */
  static msaaFBO: WebGLFramebuffer | null = null;

  /** Multisampled color renderbuffer. */
  static msaaColorRB: WebGLRenderbuffer | null = null;

  /** Multisampled emissive renderbuffer. */
  static msaaEmissiveRB: WebGLRenderbuffer | null = null;

  /** Multisampled depth renderbuffer. */
  static msaaDepthRB: WebGLRenderbuffer | null = null;

  /** Current MSAA sample count (0 = disabled). */
  static msaaSamples = 0;

  /** Current MSAA FBO width. */
  static msaaWidth = 0;

  /** Current MSAA FBO height. */
  static msaaHeight = 0;

  /** Whether MSAA has been resolved to the texture FBO this frame. */
  static msaaResolved = false;

  // ─── Ping-pong FBOs for effect chaining ──────────────────────────

  /** Ping FBO for effect chaining. */
  static pingFBO: WebGLFramebuffer | null = null;

  /** Ping color texture. */
  static pingTexture: WebGLTexture | null = null;

  /** Pong FBO for effect chaining. */
  static pongFBO: WebGLFramebuffer | null = null;

  /** Pong color texture. */
  static pongTexture: WebGLTexture | null = null;

  /** Ping-pong FBO width. */
  static ppWidth = 0;

  /** Ping-pong FBO height. */
  static ppHeight = 0;

  // ─── Effect pipeline ─────────────────────────────────────────────

  /** Registered effects, applied in order. */
  static effects: PostProcessEffect[] = [];

  /** Active gameplay-driven post-process stack. */
  static stack: PostProcessStack = [];

  /**
   * Register a post-process effect. Effects are applied in the order
   * they are added. Each effect's {@link PostProcessEffect.init} is
   * called during registration.
   */
  static addEffect(effect: PostProcessEffect): void {
    effect.init();
    PostProcess.effects.push(effect);
  }

  static setStack(stack: PostProcessStack): void {
    PostProcess.stack = stack.filter((entry): entry is PostProcessEffectDescriptor => entry !== null && entry !== undefined);
  }

  static getStackEntry<T extends PostProcessEffectDescriptor['id']>(effectName: T): Extract<PostProcessEffectDescriptor, { id: T }>['settings'] | undefined {
    const entry = PostProcess.stack.find((stackEntry) => stackEntry.id === effectName) as Extract<PostProcessEffectDescriptor, { id: T }> | undefined;

    return entry?.settings;
  }

  static clearStack(): void {
    PostProcess.stack = [];
  }

  static hasGameplayStack(): boolean {
    return PostProcess.stack.length > 0;
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
    return PostProcess.effects.some((e) => e.active) || PostProcess.stack.length > 0;
  }

  /**
   * Initialize the post-process system.
   * Creates scene FBO, MSAA FBO (if enabled), and ping-pong FBOs.
   */
  static init(): void {
    PostProcess.msaa = new Cvar('gl_msaa', '4', Cvar.FLAG.ARCHIVE, ' MSAA sample count (0 = off, 2/4/8)');

    PostProcess.fbo = gl.createFramebuffer();
    {
      // Color texture
      PostProcess.colorTexture = gl.createTexture();
      GL.Bind(0, PostProcess.colorTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Emissive texture
      PostProcess.emissiveTexture = gl.createTexture();
      GL.Bind(0, PostProcess.emissiveTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Depth texture
      PostProcess.depthTexture = gl.createTexture();
      GL.Bind(0, PostProcess.depthTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Depth renderbuffer (temporary during depth sampling)
      PostProcess.depthRenderbuffer = gl.createRenderbuffer();

      // Assemble scene FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, PostProcess.colorTexture, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, PostProcess.emissiveTexture, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, PostProcess.depthTexture, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // MSAA FBO with multisampled renderbuffers (storage allocated in _resizeMSAA).
    // Each renderbuffer must be bound at least once before framebufferRenderbuffer.
    PostProcess.msaaFBO = gl.createFramebuffer();
    PostProcess.msaaColorRB = gl.createRenderbuffer();
    PostProcess.msaaEmissiveRB = gl.createRenderbuffer();
    PostProcess.msaaDepthRB = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, PostProcess.msaaColorRB);
    gl.bindRenderbuffer(gl.RENDERBUFFER, PostProcess.msaaEmissiveRB);
    gl.bindRenderbuffer(gl.RENDERBUFFER, PostProcess.msaaDepthRB);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.msaaFBO);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, PostProcess.msaaColorRB);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, PostProcess.msaaEmissiveRB);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, PostProcess.msaaDepthRB);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Ping-pong FBOs for effect chaining
    PostProcess.pingFBO = gl.createFramebuffer();
    PostProcess.pingTexture = gl.createTexture();
    GL.Bind(0, PostProcess.pingTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.pingFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, PostProcess.pingTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    PostProcess.pongFBO = gl.createFramebuffer();
    PostProcess.pongTexture = gl.createTexture();
    GL.Bind(0, PostProcess.pongTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.pongFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, PostProcess.pongTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Resize the scene FBO textures to match the viewport dimensions.
   */
  static resize(width: number, height: number): void {
    if (PostProcess.width === width && PostProcess.height === height) {
      return;
    }

    PostProcess.width = width;
    PostProcess.height = height;

    // Resize color texture
    GL.Bind(0, PostProcess.colorTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Resize emissive texture
    GL.Bind(0, PostProcess.emissiveTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Resize depth texture
    GL.Bind(0, PostProcess.depthTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);

    // Resize depth renderbuffer
    gl.bindRenderbuffer(gl.RENDERBUFFER, PostProcess.depthRenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    // Resize MSAA renderbuffers (if enabled)
    PostProcess._resizeMSAA(width, height);
  }

  /**
   * Allocate (or deallocate) multisampled renderbuffer storage.
   * Called from `resize()` whenever the scene dimensions change.
   */
  static _resizeMSAA(width: number, height: number): void {
    const requested = PostProcess.msaa!.value >> 0;
    if (requested <= 0) {
      PostProcess.msaaSamples = 0;
      PostProcess.msaaWidth = 0;
      PostProcess.msaaHeight = 0;
      return;
    }

    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    const samples = Math.min(requested, maxSamples);

    if (PostProcess.msaaWidth === width && PostProcess.msaaHeight === height
      && PostProcess.msaaSamples === samples) {
      return;
    }

    PostProcess.msaaSamples = samples;
    PostProcess.msaaWidth = width;
    PostProcess.msaaHeight = height;

    // Multisampled color renderbuffer (RGBA8)
    gl.bindRenderbuffer(gl.RENDERBUFFER, PostProcess.msaaColorRB);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);

    // Multisampled emissive renderbuffer (RGBA8)
    gl.bindRenderbuffer(gl.RENDERBUFFER, PostProcess.msaaEmissiveRB);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);

    // Multisampled depth renderbuffer (DEPTH_COMPONENT24)
    gl.bindRenderbuffer(gl.RENDERBUFFER, PostProcess.msaaDepthRB);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
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

    GL.Bind(0, PostProcess.pingTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    GL.Bind(0, PostProcess.pongTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

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
      gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.msaaFBO);
      PostProcess.msaaResolved = false;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.fbo);
    }
    gl.viewport(0, 0, PostProcess.width, PostProcess.height);
    gl.clearBufferfv(gl.COLOR, 0, [0.0, 0.0, 0.0, 0.0]);
    gl.clearBufferfv(gl.COLOR, 1, [0.0, 0.0, 0.0, 0.0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    PostProcess.active = true;
  }

  /**
   * Begin rendering the scene to an effect's own FBO.
   * Used when only pipeline effects are active (no depth-texture scene FBO needed).
   */
  static beginToEffectFBO(fbo: WebGLFramebuffer, width: number, height: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, 0, width, height);
    PostProcess.active = true;
  }

  /**
   * Detach the depth texture from the FBO so it can be sampled in shaders.
   * Attaches a depth renderbuffer instead to keep the FBO complete.
   * If MSAA is active, resolves to the texture FBO first so the depth
   * texture contains valid data.
   */
  static beginDepthSampling(): void {
    if (PostProcess.msaaSamples > 0 && !PostProcess.msaaResolved) {
      PostProcess.resolveMSAA();
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, PostProcess.depthRenderbuffer);
  }

  /**
   * Reattach the depth texture to the FBO after depth sampling is done.
   */
  static endDepthSampling(): void {
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, PostProcess.depthTexture, 0);
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
  static _resolveMSAAColorAttachment(readAttachment: GLenum, targetTexture: WebGLTexture, width: number, height: number): void {
    gl.readBuffer(readAttachment);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0);
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

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, PostProcess.msaaFBO);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, PostProcess.fbo);

    PostProcess._resolveMSAAColorAttachment(gl.COLOR_ATTACHMENT0, PostProcess.colorTexture!, w, h);
    PostProcess._resolveMSAAColorAttachment(gl.COLOR_ATTACHMENT1, PostProcess.emissiveTexture!, w, h);

    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, PostProcess.colorTexture, 0);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, PostProcess.emissiveTexture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.fbo);
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
  static resolve(x: number, y: number, width: number, height: number, sceneTexture: WebGLTexture): void {
    const activeEffects = PostProcess.effects.filter((e) => e.active);

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
    const fbos = [PostProcess.pingFBO, PostProcess.pongFBO];
    const textures = [PostProcess.pingTexture, PostProcess.pongTexture];

    for (let i = 0; i < activeEffects.length; i++) {
      const isLast = (i === activeEffects.length - 1);

      if (isLast) {
        // Last effect renders directly to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
        activeEffects[i].apply(inputTexture, x, y, width, height);
      } else {
        // Intermediate effects render to the next ping-pong FBO
        const targetFBO = fbos[i % 2];
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        // Draw at ortho-space dimensions (VID.width/height) so the ortho matrix works
        activeEffects[i].apply(inputTexture, 0, 0, VID.width, VID.height);
        inputTexture = textures[i % 2]!;
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
    if (PostProcess.stack.length === 0) {
      return;
    }

    const activeEffects = PostProcess.stack
      .map((entry) => PostProcess.getEffect(entry.id))
      .filter((effect): effect is PostProcessEffect => effect !== undefined);

    if (activeEffects.length === 0) {
      return;
    }

    const w = PostProcess.width;
    const h = PostProcess.height;
    PostProcess.resizePingPong(w, h);

    gl.disable(gl.BLEND);

    let input: WebGLTexture = PostProcess.colorTexture!;
    const fbos = [PostProcess.pingFBO, PostProcess.pongFBO];
    const textures = [PostProcess.pingTexture!, PostProcess.pongTexture!];

    for (let i = 0; i < activeEffects.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i % 2]);
      gl.viewport(0, 0, w, h);
      activeEffects[i].apply(input, 0, 0, VID.width, VID.height);
      input = textures[i % 2];
    }

    // Write the final result back into COLOR_ATTACHMENT0 of the scene FBO so
    // that PostProcess.resolve() reads from colorTexture without a ping-pong
    // read/write hazard.
    gl.bindFramebuffer(gl.FRAMEBUFFER, PostProcess.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, w, h);
    PostProcess._blitToScreen(input, 0, 0, VID.width, VID.height);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    gl.enable(gl.BLEND);
  }

  /**
   * Blit a texture to the screen using the 'pic' shader.
   */
  static _blitToScreen(texture: WebGLTexture, x: number, y: number, width: number, height: number): void {
    gl.disable(gl.BLEND);

    const program = GL.UseProgram('pic')!;
    gl.uniform3f(program!.uColor!, 1.0, 1.0, 1.0);
    GL.Bind(program!.tTexture!, texture);
    // FBO texture has (0,0) at bottom-left; 2D screen has (0,0) at top-left.
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();

    gl.enable(gl.BLEND);
  }

  /**
   * Clean up all GPU resources.
   */
  static shutdown(): void {
    // Shut down all effects
    for (const effect of PostProcess.effects) {
      effect.shutdown();
    }
    PostProcess.effects.length = 0;

    // Scene FBO
    if (PostProcess.fbo) {
      gl.deleteFramebuffer(PostProcess.fbo);
      PostProcess.fbo = null;
    }
    if (PostProcess.colorTexture) {
      gl.deleteTexture(PostProcess.colorTexture);
      PostProcess.colorTexture = null;
    }
    if (PostProcess.emissiveTexture) {
      gl.deleteTexture(PostProcess.emissiveTexture);
      PostProcess.emissiveTexture = null;
    }
    if (PostProcess.depthTexture) {
      gl.deleteTexture(PostProcess.depthTexture);
      PostProcess.depthTexture = null;
    }
    if (PostProcess.depthRenderbuffer) {
      gl.deleteRenderbuffer(PostProcess.depthRenderbuffer);
      PostProcess.depthRenderbuffer = null;
    }

    // MSAA FBO
    if (PostProcess.msaaFBO) {
      gl.deleteFramebuffer(PostProcess.msaaFBO);
      PostProcess.msaaFBO = null;
    }
    if (PostProcess.msaaColorRB) {
      gl.deleteRenderbuffer(PostProcess.msaaColorRB);
      PostProcess.msaaColorRB = null;
    }
    if (PostProcess.msaaEmissiveRB) {
      gl.deleteRenderbuffer(PostProcess.msaaEmissiveRB);
      PostProcess.msaaEmissiveRB = null;
    }
    if (PostProcess.msaaDepthRB) {
      gl.deleteRenderbuffer(PostProcess.msaaDepthRB);
      PostProcess.msaaDepthRB = null;
    }
    PostProcess.msaaSamples = 0;
    PostProcess.msaaWidth = 0;
    PostProcess.msaaHeight = 0;
    PostProcess.msaaResolved = false;

    // Ping-pong FBOs
    if (PostProcess.pingFBO) {
      gl.deleteFramebuffer(PostProcess.pingFBO);
      PostProcess.pingFBO = null;
    }
    if (PostProcess.pingTexture) {
      gl.deleteTexture(PostProcess.pingTexture);
      PostProcess.pingTexture = null;
    }
    if (PostProcess.pongFBO) {
      gl.deleteFramebuffer(PostProcess.pongFBO);
      PostProcess.pongFBO = null;
    }
    if (PostProcess.pongTexture) {
      gl.deleteTexture(PostProcess.pongTexture);
      PostProcess.pongTexture = null;
    }

    PostProcess.width = 0;
    PostProcess.height = 0;
    PostProcess.ppWidth = 0;
    PostProcess.ppHeight = 0;
    PostProcess.active = false;
  }
}
