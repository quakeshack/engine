/** Which corner of a viewport to anchor drawn content against, see `MenuViewport.anchor()`. */
export type MenuViewportCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface MenuViewportConfig {
  readonly width: number;
  readonly height: number;
  /**
   * 'fixed': scale is the given constant, matching classic Quake's pixel-doubled behavior --
   * does not grow to fill a larger display, always leaves slack around a small, centered box.
   * 'contain': scale = min(vidWidth / width, vidHeight / height), i.e. grows/shrinks to fill as
   * much of the real canvas as possible while preserving the width:height ratio.
   */
  readonly fit: 'fixed' | 'contain';
  readonly scale?: number; // required when fit === 'fixed'
  readonly integerScale?: boolean; // 'contain' only -- floor to whole pixels for crisp nearest-neighbor art
}

export interface ResolvedMenuViewport {
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
}

/**
 * A virtual drawing-space size and scaling strategy for a menu page. `M`'s drawing primitives
 * resolve the current page's viewport against the real canvas size every time they draw, so a
 * page's own coordinates never need to know the actual screen resolution.
 */
export class MenuViewport {
  // Classic Quake's exact historical behavior (320x200, pixel-doubled, centered), kept as the
  // default for every page that doesn't declare its own viewport -- so id1's built-in pages
  // (and anything that doesn't opt in) render pixel-identical to before this class existed.
  static readonly classic = new MenuViewport({ width: 320, height: 200, fit: 'fixed', scale: 2 });

  readonly width: number;
  readonly height: number;
  readonly fit: 'fixed' | 'contain';
  readonly scale: number | null;
  readonly integerScale: boolean;

  constructor(config: MenuViewportConfig) {
    console.assert(config.fit !== 'fixed' || config.scale !== undefined, 'MenuViewport: fit "fixed" requires a scale');

    this.width = config.width;
    this.height = config.height;
    this.fit = config.fit;
    this.scale = config.scale ?? null;
    this.integerScale = config.integerScale ?? false;
  }

  /**
   * Resolve this viewport's scale and centering offset against the real canvas size.
   * @returns The resolved scale and origin.
   */
  resolve(vidWidth: number, vidHeight: number): ResolvedMenuViewport {
    const scale = this.fit === 'fixed' ? this.scale! : this.#containScale(vidWidth, vidHeight);

    return {
      scale,
      originX: Math.floor(vidWidth / 2) - (this.width * scale) / 2,
      originY: Math.floor(vidHeight / 2) - (this.height * scale) / 2,
    };
  }

  #containScale(vidWidth: number, vidHeight: number): number {
    const raw = Math.min(vidWidth / this.width, vidHeight / this.height);
    return this.integerScale ? Math.max(1, Math.floor(raw)) : raw;
  }

  /**
   * Convert a virtual-space point into a real screen pixel position, given an already-resolved
   * transform (see `resolve()`).
   * @returns The equivalent real screen position.
   */
  toScreen(resolved: ResolvedMenuViewport, x: number, y: number): { x: number; y: number } {
    return { x: x * resolved.scale + resolved.originX, y: y * resolved.scale + resolved.originY };
  }

  /**
   * Convert a real screen pixel position back into virtual-space coordinates, given an
   * already-resolved transform (see `resolve()`) -- the inverse of `toScreen()`.
   * @returns The equivalent virtual-space position.
   */
  fromScreen(resolved: ResolvedMenuViewport, x: number, y: number): { x: number; y: number } {
    return { x: (x - resolved.originX) / resolved.scale, y: (y - resolved.originY) / resolved.scale };
  }

  /**
   * The top-left virtual-space position to draw `contentWidth` x `contentHeight` content at so
   * it sits flush against the given corner with the given margin -- replaces hand-deriving
   * "edge minus margin minus content size" per page.
   * @returns The top-left position to draw at.
   */
  anchor(corner: MenuViewportCorner, contentWidth: number, contentHeight: number, marginX = 16, marginY = 16): { x: number; y: number } {
    return {
      x: corner.endsWith('left') ? marginX : this.width - marginX - contentWidth,
      y: corner.startsWith('top') ? marginY : this.height - marginY - contentHeight,
    };
  }
}
