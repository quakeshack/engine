import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { ImageFormat, ImageHeaders } from '../../source/engine/common/model/sprite/ImageHeader.ts';

/**
 * @returns A fixture of `test/fixtures/sprites/` as an ArrayBuffer.
 */
function readFixture(name: string): ArrayBuffer {
  const bytes = readFileSync(new URL(`../fixtures/sprites/${name}`, import.meta.url));

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

void describe('ImageHeaders.detect', () => {
  void test('tells the formats apart by their signature', () => {
    assert.equal(ImageHeaders.detect(readFixture('anim.gif')), ImageFormat.gif);
    assert.equal(ImageHeaders.detect(readFixture('static.png')), ImageFormat.png);
    assert.equal(ImageHeaders.detect(readFixture('anim.apng')), ImageFormat.png);
    assert.equal(ImageHeaders.detect(readFixture('anim.webp')), ImageFormat.webp);
    assert.equal(ImageHeaders.detect(readFixture('static-lossy.webp')), ImageFormat.webp);
  });

  void test('does not take other files for images', () => {
    assert.equal(ImageHeaders.detect(new Uint8Array(64).buffer), null);
    assert.equal(ImageHeaders.detect(new ArrayBuffer(3)), null);
    assert.equal(ImageHeaders.detect(new TextEncoder().encode('RIFF....WAVEfmt  ................').buffer), null);
  });
});

void describe('GIF header', () => {
  void test('reads size, delays and a loop count of 0 as forever', () => {
    assert.deepEqual(ImageHeaders.parse(readFixture('anim.gif'), 'anim.gif'), {
      width: 8, height: 4, frameDurations: [50, 100, 200], repeat: 0, tags: [],
    });
  });

  void test('plays once without a NETSCAPE block', () => {
    assert.equal(ImageHeaders.parse(readFixture('anim-once.gif'), 'anim-once.gif').repeat, 1);
  });

  void test('a loop count of N plays N + 1 times, as browsers read it', () => {
    assert.equal(ImageHeaders.parse(readFixture('anim-loop3.gif'), 'anim-loop3.gif').repeat, 4);
  });

  void test('reports the delays as written, also zero', () => {
    assert.deepEqual(ImageHeaders.parse(readFixture('anim-zero-delay.gif'), 'anim-zero-delay.gif').frameDurations, [0, 10, 20]);
  });

  void test('skips the sub-blocks of an interlaced image', () => {
    const header = ImageHeaders.parse(readFixture('interlaced.gif'), 'interlaced.gif');

    assert.equal(header.width, 5);
    assert.equal(header.height, 20);
    assert.equal(header.frameDurations.length, 1);
  });

  void test('rejects a file with no image in it', () => {
    const bytes = new Uint8Array(readFixture('anim.gif'), 0, 13).slice();

    assert.throws(() => ImageHeaders.parse(new Uint8Array([...bytes, 0x3b]).buffer, 'empty.gif'), CorruptedResourceError);
  });

  void test('rejects a file that is cut short', () => {
    const file = readFixture('anim.gif');

    assert.throws(() => ImageHeaders.parse(file.slice(0, 40), 'cut.gif'), CorruptedResourceError);
  });
});

void describe('PNG header', () => {
  void test('a plain PNG is one image', () => {
    assert.deepEqual(ImageHeaders.parse(readFixture('static.png'), 'static.png'), {
      width: 8, height: 4, frameDurations: [0], repeat: 1, tags: [],
    });
  });

  void test('reads an APNG whose default image is its first frame', () => {
    assert.deepEqual(ImageHeaders.parse(readFixture('anim.apng'), 'anim.apng'), {
      width: 8, height: 4, frameDurations: [50, 100, 200], repeat: 0, tags: [],
    });
  });

  void test('leaves a default image that is not part of the animation out', () => {
    const header = ImageHeaders.parse(readFixture('anim-hidden-default.apng'), 'anim-hidden-default.apng');

    assert.deepEqual(header.frameDurations, [50, 100]);
    assert.equal(header.repeat, 2);
  });

  void test('rejects an animation without frame control chunks', () => {
    const file = new Uint8Array(readFixture('anim-hidden-default.apng'));
    const withoutFrames = file.slice(0, 33 + 20); // signature, IHDR (25) and acTL (20)
    const end = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

    assert.throws(() => ImageHeaders.parse(new Uint8Array([...withoutFrames, ...end]).buffer, 'broken.png'), CorruptedResourceError);
  });
});

void describe('WebP header', () => {
  void test('reads an animated file', () => {
    assert.deepEqual(ImageHeaders.parse(readFixture('anim.webp'), 'anim.webp'), {
      width: 8, height: 4, frameDurations: [50, 100, 200], repeat: 0, tags: [],
    });
  });

  void test('reads the loop count', () => {
    assert.equal(ImageHeaders.parse(readFixture('anim-loop2.webp'), 'anim-loop2.webp').repeat, 2);
  });

  void test('takes the size of a simple lossless file from its bitstream header', () => {
    assert.deepEqual(ImageHeaders.parse(readFixture('static-lossless.webp'), 'static-lossless.webp'), {
      width: 8, height: 4, frameDurations: [0], repeat: 1, tags: [],
    });
  });

  void test('takes the size of a simple lossy file from its bitstream header', () => {
    const header = ImageHeaders.parse(readFixture('static-lossy.webp'), 'static-lossy.webp');

    assert.equal(header.width, 8);
    assert.equal(header.height, 4);
    assert.equal(header.frameDurations.length, 1);
  });

  void test('takes the canvas size of an extended still file from VP8X', () => {
    const header = ImageHeaders.parse(readFixture('static-lossy-alpha.webp'), 'static-lossy-alpha.webp');

    assert.equal(header.width, 8);
    assert.equal(header.height, 4);
    assert.equal(header.frameDurations.length, 1);
  });
});

void describe('ImageHeaders.frameSeconds', () => {
  void test('plays 10 ms or less at 100 ms, as browsers do', () => {
    assert.equal(ImageHeaders.frameSeconds(0), 0.1);
    assert.equal(ImageHeaders.frameSeconds(10), 0.1);
  });

  void test('keeps longer durations', () => {
    assert.equal(ImageHeaders.frameSeconds(20), 0.02);
    assert.equal(ImageHeaders.frameSeconds(1500), 1.5);
  });
});
