import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SpriteImageDecoder } from '../../source/engine/client/renderer/sprite/SpriteImageDecoder.ts';
import { SpriteImageDecoding } from '../../source/engine/client/renderer/sprite/SpriteImageDecoding.ts';
import { SpriteImageLimits, type SpriteImageLimitValues } from '../../source/engine/client/renderer/sprite/SpriteImageLimits.ts';
import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { ImageFormat, type ImageHeader } from '../../source/engine/common/model/sprite/ImageHeader.ts';
import type { DecodedSpriteImages } from '../../source/engine/common/model/sprite/SpriteImageDecoding.ts';
import { createSilentConsole } from '../support/modelContext.ts';

const HEADER: ImageHeader = { width: 2, height: 2, frameDurations: [100, 100, 100], repeat: 0, tags: [], origins: null };
const ROOMY: SpriteImageLimitValues = { maxTextureSize: 4096, maxLayers: 256, maxBytes: 64 * 1048576 };

/**
 * @returns Frames of the given size, each filled with its own number.
 */
function createFrames(width: number, height: number, count: number): DecodedSpriteImages {
  return { width, height, frames: Array.from({ length: count }, (_value, index) => new Uint8Array(width * height * 4).fill(index + 1)) };
}

/** A decoder that answers with what it was given, for the order in which the registry asks. */
class FakeDecoder extends SpriteImageDecoder {
  calls = 0;
  readonly #name: string;
  readonly #accepts: boolean;
  readonly #result: DecodedSpriteImages | Error;

  constructor(name: string, accepts: boolean, result: DecodedSpriteImages | Error) {
    super();
    this.#name = name;
    this.#accepts = accepts;
    this.#result = result;
  }

  override getName(): string {
    return this.#name;
  }

  override canDecode(): boolean {
    return this.#accepts;
  }

  override decode(): Promise<DecodedSpriteImages> {
    this.calls++;

    return this.#result instanceof Error ? Promise.reject(this.#result) : Promise.resolve(this.#result);
  }
}

void describe('SpriteImageDecoding', () => {
  void test('uses the first decoder that takes the file', async () => {
    const skipped = new FakeDecoder('skipped', false, createFrames(2, 2, 3));
    const first = new FakeDecoder('first', true, createFrames(2, 2, 3));
    const second = new FakeDecoder('second', true, createFrames(2, 2, 3));
    const decoding = new SpriteImageDecoding(createSilentConsole(), () => ROOMY, [skipped, first, second]);

    await decoding.decode(new ArrayBuffer(0), ImageFormat.gif, HEADER, 'a.gif');

    assert.deepEqual([skipped.calls, first.calls, second.calls], [0, 1, 0]);
  });

  void test('hands over to the next decoder when one fails, and says so', async () => {
    const warnings: string[] = [];
    const failing = new FakeDecoder('broken', true, new Error('no codec'));
    const fallback = new FakeDecoder('fallback', true, createFrames(2, 2, 3));
    const decoding = new SpriteImageDecoding(createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }), () => ROOMY, [failing, fallback]);

    const decoded = await decoding.decode(new ArrayBuffer(0), ImageFormat.webp, HEADER, 'a.webp');

    assert.equal(decoded.frames.length, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /broken.*no codec/);
  });

  void test('fails when no decoder can decode the file', async () => {
    const decoding = new SpriteImageDecoding(createSilentConsole(), () => ROOMY, [new FakeDecoder('broken', true, new Error('no'))]);

    await assert.rejects(decoding.decode(new ArrayBuffer(0), ImageFormat.gif, HEADER, 'a.gif'), CorruptedResourceError);
  });

  void test('warns when a decoder gives fewer frames than the file has', async () => {
    const warnings: string[] = [];
    const still = new FakeDecoder('still image', true, createFrames(2, 2, 1));
    const decoding = new SpriteImageDecoding(createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }), () => ROOMY, [still]);

    const decoded = await decoding.decode(new ArrayBuffer(0), ImageFormat.webp, HEADER, 'a.webp');

    assert.equal(decoded.frames.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /1 of 3 frames/);
  });

  void test('reads the limits at each decode', async () => {
    let maxBytes = 64 * 1048576;
    const decoding = new SpriteImageDecoding(createSilentConsole(), () => ({ ...ROOMY, maxBytes }), [new FakeDecoder('fake', true, createFrames(64, 64, 4))]);

    assert.equal((await decoding.decode(new ArrayBuffer(0), ImageFormat.gif, HEADER, 'a.gif')).width, 64);

    maxBytes = 64 * 64 * 4 * 4;

    assert.ok((await decoding.decode(new ArrayBuffer(0), ImageFormat.gif, HEADER, 'a.gif')).width < 64);
  });
});

void describe('SpriteImageLimits', () => {
  void test('leaves what fits alone', () => {
    const decoded = createFrames(8, 8, 4);

    assert.equal(SpriteImageLimits.fit(decoded, ROOMY, createSilentConsole(), 'a.gif'), decoded);
  });

  void test('counts the mip chain in the size', () => {
    assert.equal(SpriteImageLimits.textureBytes(16, 16, 2), Math.ceil(16 * 16 * 4 * 2 * 4 / 3));
  });

  void test('halves the images until they fit the budget, and says so once', () => {
    const warnings: string[] = [];
    const decoded = createFrames(64, 64, 8);
    const budget = SpriteImageLimits.textureBytes(32, 32, 8);

    const fitted = SpriteImageLimits.fit(decoded, { ...ROOMY, maxBytes: budget }, createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }), 'big.gif');

    assert.deepEqual([fitted.width, fitted.height], [32, 32]);
    assert.equal(fitted.frames.length, 8);
    assert.ok(fitted.frames.every((frame) => frame.length === 32 * 32 * 4));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /64x64.*32x32/);
  });

  void test('averages the pixels when it halves', () => {
    const decoded: DecodedSpriteImages = { width: 2, height: 2, frames: [new Uint8Array([0, 0, 0, 0, 100, 100, 100, 100, 100, 100, 100, 100, 200, 200, 200, 200])] };

    const fitted = SpriteImageLimits.fit(decoded, { ...ROOMY, maxTextureSize: 1 }, createSilentConsole(), 'a.gif');

    assert.deepEqual([...fitted.frames[0]], [100, 100, 100, 100]);
  });

  void test('shrinks an image that is larger than the hardware takes', () => {
    const fitted = SpriteImageLimits.fit(createFrames(300, 100, 1), { ...ROOMY, maxTextureSize: 128 }, createSilentConsole(), 'wide.gif');

    assert.deepEqual([fitted.width, fitted.height], [75, 25]);
  });

  void test('drops the frames over the layer limit, and says so', () => {
    const warnings: string[] = [];

    const fitted = SpriteImageLimits.fit(createFrames(4, 4, 10), { ...ROOMY, maxLayers: 6 }, createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }), 'long.gif');

    assert.equal(fitted.frames.length, 6);
    assert.equal(warnings.length, 1);
  });

  void test('stops at a single pixel when the budget cannot be met', () => {
    const fitted = SpriteImageLimits.fit(createFrames(4, 4, 2), { ...ROOMY, maxBytes: 1 }, createSilentConsole(), 'a.gif');

    assert.deepEqual([fitted.width, fitted.height], [1, 1]);
  });
});
