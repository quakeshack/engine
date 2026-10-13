/** The WebGL constants a test of the render targets needs, by name. */
const CONSTANTS: Readonly<Record<string, number>> = {
  NONE: 0,
  FRAMEBUFFER: 0x8D40,
  READ_FRAMEBUFFER: 0x8CA8,
  DRAW_FRAMEBUFFER: 0x8CA9,
  RENDERBUFFER: 0x8D41,
  COLOR_ATTACHMENT0: 0x8CE0,
  COLOR_ATTACHMENT1: 0x8CE1,
  COLOR_ATTACHMENT2: 0x8CE2,
  COLOR_ATTACHMENT3: 0x8CE3,
  DEPTH_ATTACHMENT: 0x8D00,
  TEXTURE_2D: 0x0DE1,
  TEXTURE0: 0x84C0,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  LINEAR: 0x2601,
  NEAREST: 0x2600,
  CLAMP_TO_EDGE: 0x812F,
  RGBA: 0x1908,
  RGBA8: 0x8058,
  DEPTH_COMPONENT: 0x1902,
  DEPTH_COMPONENT24: 0x81A6,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_INT: 0x1405,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
  MAX_COLOR_ATTACHMENTS: 0x8CDF,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_SAMPLES: 0x8D57,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
};

/** What `createRecordingContext` returns. */
export interface RecordingContext {
  /** The stand-in for the context. */
  readonly gl: WebGL2RenderingContext;

  /** Every call made on it, in order, as `name(arguments)`. */
  readonly log: string[];

  /**
   * The recorded calls of one method.
   * @param method The method name.
   * @returns The calls, in order.
   */
  calls(method: string): string[];
}

/**
 * A stand-in for a WebGL context that records the calls made on it and hands out numbered objects (`texture 1`,
 * `framebuffer 2`, ...) for the `create*` methods. It answers `getParameter` for the three capability limits (8
 * attachments, 8 draw buffers, 4 samples) and throws on a constant that is not in its table, so a test that needs one
 * has to add it.
 * @returns The context and its record.
 */
export function createRecordingContext(): RecordingContext {
  const log: string[] = [];
  const counters = new Map<string, number>();
  const names = new Map<number, string>();

  for (const [name, value] of Object.entries(CONSTANTS)) {
    // NONE is 0, which is a size or an index nearly everywhere; see `noneMethods`
    if (name !== 'NONE') {
      names.set(value, name);
    }
  }

  const limits = new Map<number, number>([
    [CONSTANTS.MAX_COLOR_ATTACHMENTS, 8],
    [CONSTANTS.MAX_DRAW_BUFFERS, 8],
    [CONSTANTS.MAX_SAMPLES, 4],
  ]);

  // GL_NONE is 0, which is also a size or an index everywhere else; only these two methods mean the constant by it
  const noneMethods = new Set(['drawBuffers', 'readBuffer']);

  const describeValue = (value: unknown, zeroIsNone = false): string => {
    if (typeof value === 'number') {
      return zeroIsNone && value === 0 ? 'NONE' : (names.get(value) ?? String(value));
    }

    if (Array.isArray(value)) {
      return `[${value.map((element) => describeValue(element, zeroIsNone)).join(', ')}]`;
    }

    if (typeof value === 'object' && value !== null && 'label' in value) {
      return String((value as { label: unknown }).label);
    }

    return String(value);
  };

  const create = (kind: string) => () => {
    const next = (counters.get(kind) ?? 0) + 1;

    counters.set(kind, next);

    return { label: `${kind} ${next}` };
  };

  const creators: Record<string, () => { label: string }> = {
    createFramebuffer: create('framebuffer'),
    createRenderbuffer: create('renderbuffer'),
    createTexture: create('texture'),
  };

  const gl = new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== 'string') {
        return undefined;
      }

      if (property in CONSTANTS) {
        return CONSTANTS[property];
      }

      if (/^[A-Z][A-Z_0-9]*$/.test(property)) {
        throw new Error(`the recording context does not know the constant ${property}`);
      }

      if (property in creators) {
        return creators[property];
      }

      if (property === 'getParameter') {
        return (parameter: number) => {
          log.push(`getParameter(${describeValue(parameter)})`);

          return limits.get(parameter);
        };
      }

      return (...args: unknown[]) => {
        log.push(`${property}(${args.map((argument) => describeValue(argument, noneMethods.has(property))).join(', ')})`);
      };
    },
  }) as unknown as WebGL2RenderingContext;

  return {
    gl,
    log,
    calls: (method: string) => log.filter((line) => line.startsWith(`${method}(`)),
  };
}
