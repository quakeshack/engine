import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BitmapFont } from '../../source/engine/client/BitmapFont.ts';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A minimal texture stand-in -- `measure`/`getGlyphRect` only read `width`/`height`, so a real
 * `GLTexture` (which needs a live WebGL context to construct) isn't required here.
 * @param {number} width texture width in px
 * @param {number} height texture height in px
 * @returns {{ width: number, height: number }} mock texture
 */
function createMockTexture(width, height) {
  return { width, height };
}

/**
 * Builds a font matching `data/hellwave/gfx/header-font.png`'s actual grid (26 uppercase glyphs,
 * two stacked color rows) for use across the tests below.
 * @returns {BitmapFont} the header font
 */
function createHeaderFont() {
  return new BitmapFont({
    texture: createMockTexture(362, 34),
    charset: CHARSET,
    glyphWidth: 12,
    glyphHeight: 16,
    cellWidth: 14,
    cellHeight: 18,
    variants: 2,
  });
}

void describe('BitmapFont', () => {
  void describe('constructor', () => {
    void test('defaults variants to 1 when not specified', () => {
      const font = new BitmapFont({
        texture: createMockTexture(362, 16),
        charset: CHARSET,
        glyphWidth: 12,
        glyphHeight: 16,
        cellWidth: 14,
        cellHeight: 16,
      });

      assert.equal(font.variants, 1);
    });
  });

  void describe('measure', () => {
    void test('advances by cellWidth for every character, supported or not', () => {
      const font = createHeaderFont();

      assert.equal(font.measure('ABC'), 3 * 14);
      assert.equal(font.measure('NEW GAME'), 8 * 14);
      assert.equal(font.measure(''), 0);
    });
  });

  void describe('getGlyphRect', () => {
    void test('maps the first glyph to the top-left of variant 0', () => {
      const font = createHeaderFont();

      assert.deepEqual(font.getGlyphRect('A', 0), {
        u0: 0,
        v0: 0,
        u1: 12 / 362,
        v1: 16 / 34,
      });
    });

    void test('uppercases lowercase input to find the glyph', () => {
      const font = createHeaderFont();

      assert.deepEqual(font.getGlyphRect('a', 0), font.getGlyphRect('A', 0));
    });

    void test('offsets horizontally by index * cellWidth', () => {
      const font = createHeaderFont();
      const rect = font.getGlyphRect('C', 0);

      assert.equal(rect.u0, (2 * 14) / 362);
      assert.equal(rect.u1, ((2 * 14) + 12) / 362);
    });

    void test('offsets vertically by variant * cellHeight', () => {
      const font = createHeaderFont();
      const rect = font.getGlyphRect('A', 1);

      assert.equal(rect.v0, 18 / 34);
      assert.equal(rect.v1, (18 + 16) / 34);
    });

    void test('returns null for characters outside the charset, including digits and space', () => {
      const font = createHeaderFont();

      assert.equal(font.getGlyphRect('1', 0), null);
      assert.equal(font.getGlyphRect(' ', 0), null);
      assert.equal(font.getGlyphRect('!', 0), null);
    });

    void test('defaults to variant 0 when omitted', () => {
      const font = createHeaderFont();

      assert.deepEqual(font.getGlyphRect('A'), font.getGlyphRect('A', 0));
    });
  });
});
