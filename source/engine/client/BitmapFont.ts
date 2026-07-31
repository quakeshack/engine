import { eventBus } from '../registry.ts';
import GL, { GLTexture } from './GL.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * Normalized UV rectangle of a single glyph cell within a `BitmapFont`'s texture.
 */
export interface BitmapFontGlyphRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * Describes a fixed-grid glyph atlas: `charset[i]` occupies the `cellWidth`-wide, `cellHeight`-tall
 * cell starting at `(i * cellWidth, variant * cellHeight)` in `texture`, with the visible glyph
 * itself only `glyphWidth`x`glyphHeight` (top-left aligned within that cell -- any remainder is
 * inter-glyph/inter-row padding already baked into the atlas image).
 */
export interface BitmapFontConfig {
  readonly texture: GLTexture;
  readonly charset: string;
  readonly glyphWidth: number;
  readonly glyphHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly variants?: number;
}

/**
 * A fixed-grid bitmap font: every glyph advances by the same `cellWidth`, and characters outside
 * `charset` (after uppercasing) are skipped but still advance the cursor, so unsupported
 * punctuation or spacing still reads as a gap rather than collapsing the string. Intended for
 * stylized headers/menu items where the standard conchars font is too small or the wrong style
 * (e.g. LibreQuake's `gfx/header-font.png`, an uppercase-only atlas with a white row and a gold
 * row stacked for a normal/highlighted look).
 */
export class BitmapFont {
  readonly texture: GLTexture;
  readonly charset: string;
  readonly glyphWidth: number;
  readonly glyphHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly variants: number;

  constructor(config: BitmapFontConfig) {
    this.texture = config.texture;
    this.charset = config.charset;
    this.glyphWidth = config.glyphWidth;
    this.glyphHeight = config.glyphHeight;
    this.cellWidth = config.cellWidth;
    this.cellHeight = config.cellHeight;
    this.variants = config.variants ?? 1;
  }

  /**
   * Loads the atlas image and wraps it as a `BitmapFont`, locking it to nearest-neighbor
   * filtering -- pixel-art glyph edges shouldn't get mipmapped/bilinear blur between cells.
   * @returns The loaded font.
   */
  static async FromImageFile(filename: string, config: Omit<BitmapFontConfig, 'texture'>): Promise<BitmapFont> {
    const texture = await GLTexture.FromImageFile(filename);
    console.assert(texture !== null, `Missing bitmap font image: ${filename}`);
    texture!.lockTextureMode('GL_NEAREST');

    return new BitmapFont({ ...config, texture: texture! });
  }

  /**
   * Width, in virtual menu-space units, a string occupies -- every character, supported or not,
   * advances by `cellWidth`. Pass the same `scale` `draw()` will actually be called with (e.g.
   * the current page's resolved `MenuViewport` scale, `ClientEngineAPI.Menu.viewportScale`) so
   * the returned width accounts for `draw()`'s whole-pixel scale snapping -- at a fractional
   * (non-integer) viewport scale, `draw()` still renders each glyph at a snapped, integer real
   * pixel size (see `draw()`'s own doc comment), so a width computed from the raw scale would
   * over- or under-estimate what actually gets drawn. Left at the default (`scale = 1`), the
   * result is unaffected by snapping, same as before this parameter existed.
   * @returns The advance width, in virtual menu-space units.
   */
  measure(str: string, scale = 1): number {
    return str.length * this.cellWidth * (GL.SnapPixelScale(scale) / scale);
  }

  /**
   * UV rectangle for `char` in the given `variant`, or `null` if `char` (uppercased) isn't part of
   * the atlas. Kept separate from `draw()` so the glyph-lookup math can be unit-tested without a
   * WebGL context.
   * @returns The glyph's UV rectangle, or `null` if unsupported.
   */
  getGlyphRect(char: string, variant = 0): BitmapFontGlyphRect | null {
    console.assert(variant >= 0 && variant < this.variants, 'BitmapFont: variant out of range');

    const index = this.charset.indexOf(char.toUpperCase());
    if (index === -1) {
      return null;
    }

    const u0 = (index * this.cellWidth) / this.texture.width;
    const v0 = (variant * this.cellHeight) / this.texture.height;

    return {
      u0,
      v0,
      u1: u0 + (this.glyphWidth / this.texture.width),
      v1: v0 + (this.glyphHeight / this.texture.height),
    };
  }

  /**
   * Draws `str` glyph by glyph in the given color variant. Unsupported characters (after
   * uppercasing) are skipped but still advance the cursor. `scale` is snapped to the nearest
   * whole pixel multiple (see `GL.SnapPixelScale`) -- this atlas is nearest-filtered pixel art
   * with fine (single-texel) alternating detail (e.g. the header font's diagonal hazard
   * stripes), and magnifying that by a fractional factor beats against the stripe period and
   * shows up as uneven/moiré banding instead of a clean scaled copy.
   * @returns The x position just past the last character.
   */
  draw(x: number, y: number, str: string, variant = 0, scale = 1): number {
    const program = GL.UseProgram('pic', true)!;
    gl.uniform3f(program.uColor!, 1.0, 1.0, 1.0);
    this.texture.bind(program.tTexture, true);

    const pixelScale = GL.SnapPixelScale(scale);

    let cx = x;

    for (const char of str) {
      const rect = this.getGlyphRect(char, variant);

      if (rect !== null) {
        GL.StreamDrawTexturedQuad(
          Math.floor(cx), Math.floor(y),
          this.glyphWidth * pixelScale, this.glyphHeight * pixelScale,
          rect.u0, rect.v0, rect.u1, rect.v1,
        );
      }

      cx += this.cellWidth * pixelScale;
    }

    GL.StreamFlush();

    return cx;
  }
}
