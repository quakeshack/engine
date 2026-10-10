#!/usr/bin/env node
/**
 * Compares the output folders of `capture.mjs` of two builds: before and after a change that must not alter what
 * is drawn. See docs/browser-verification.md, section 8.
 *
 * Usage:   node scripts/renderer-capture/compare.mjs --before <dir>[,<dir>...] --after <dir>[,<dir>...]
 *
 * Give at least two captures on one side (more is better). Two captures of the same build are never identical,
 * the sky, liquids and the FPS counter animate in real time, so the difference between builds is only
 * meaningful relative to the difference between captures of one build. A view is flagged when even the closest
 * before/after pair is further apart than the furthest pair of captures taken of the same build.
 *
 * Two measures per view: the number of pixels that differ, and the largest difference between the average colors
 * of 120 px blocks (the animated full-screen views have a stable average, a missing pass does not). The
 * `r_speeds` lines (draw calls, triangles, vertices, texture binds) are compared exactly.
 *
 * Exit code: 0 when nothing differs beyond the noise, 1 otherwise, 2 for bad arguments.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

const PIXEL_THRESHOLD = 6;
const BLOCK_SIZE = 120;

// slack on top of the noise, so that two near-identical builds are not flagged by a handful of pixels
const PIXEL_SLACK = 500;
const BLOCK_SLACK = 3.0;
const NOISE_FACTOR = 2.0;

/**
 * Reads a list option.
 * @param {string} name Option name without dashes.
 * @returns {string[]} Folders, empty when the option is missing.
 */
function listOption(name) {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? [] : String(process.argv[index + 1] ?? '').split(',').filter((entry) => entry !== '');
}

const before = listOption('before');
const after = listOption('after');

if (before.length === 0 || after.length === 0 || (before.length < 2 && after.length < 2)) {
  console.error('usage: node scripts/renderer-capture/compare.mjs --before <dir>[,<dir>...] --after <dir>[,<dir>...]');
  console.error('at least two captures of one build are needed to know how much two captures of it differ');
  process.exit(2);
}

const runs = [...before.map((dir) => ({ dir, side: 'before' })), ...after.map((dir) => ({ dir, side: 'after' }))];
const names = fs.readdirSync(before[0]).filter((file) => file.endsWith('.png')).sort();

const speeds = new Map(runs.map((run) => [run.dir, JSON.parse(fs.readFileSync(path.join(run.dir, 'views.json'), 'utf8')).views]));

/**
 * Computes the difference of every pair of captures of a view. Runs in the page, where the canvas can decode PNGs.
 * @param {{ pngs: string[], threshold: number, block: number }} input Base64 PNGs of one view, one per run.
 * @returns {Promise<{ pixels: number[][], blocks: number[][] }>} Symmetric matrices indexed by run.
 */
async function measureView({ pngs, threshold, block }) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  const decode = async (base64) => {
    const image = new Image();

    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    canvas.width = image.width;
    canvas.height = image.height;
    context.drawImage(image, 0, 0);

    return context.getImageData(0, 0, image.width, image.height);
  };

  const blockMeans = (image) => {
    const columns = Math.floor(image.width / block);
    const rows = Math.floor(image.height / block);
    const means = new Float64Array(columns * rows * 3);

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const sum = [0, 0, 0];

        for (let y = row * block; y < (row + 1) * block; y++) {
          for (let x = column * block; x < (column + 1) * block; x++) {
            const offset = (y * image.width + x) * 4;

            sum[0] += image.data[offset];
            sum[1] += image.data[offset + 1];
            sum[2] += image.data[offset + 2];
          }
        }

        for (let channel = 0; channel < 3; channel++) {
          means[(row * columns + column) * 3 + channel] = sum[channel] / (block * block);
        }
      }
    }

    return means;
  };

  const images = [];

  for (const base64 of pngs) {
    images.push(await decode(base64));
  }

  const means = images.map(blockMeans);
  const count = images.length;
  const pixels = Array.from({ length: count }, () => new Array(count).fill(0));
  const blocks = Array.from({ length: count }, () => new Array(count).fill(0));

  for (let first = 0; first < count; first++) {
    for (let second = first + 1; second < count; second++) {
      const a = images[first].data;
      const b = images[second].data;
      let differing = 0;

      for (let offset = 0; offset < a.length; offset += 4) {
        const delta = Math.max(Math.abs(a[offset] - b[offset]), Math.abs(a[offset + 1] - b[offset + 1]), Math.abs(a[offset + 2] - b[offset + 2]));

        if (delta > threshold) {
          differing++;
        }
      }

      let largest = 0;

      for (let i = 0; i < means[first].length; i++) {
        largest = Math.max(largest, Math.abs(means[first][i] - means[second][i]));
      }

      pixels[first][second] = pixels[second][first] = differing;
      blocks[first][second] = blocks[second][first] = largest;
    }
  }

  return { pixels, blocks };
}

/**
 * Splits the pairs of a symmetric matrix into those taken of one build and those across the two.
 * @param {number[][]} matrix Pairwise values indexed by run.
 * @returns {{ within: number[], between: number[] }} The values of both groups.
 */
function splitPairs(matrix) {
  const within = [];
  const between = [];

  for (let first = 0; first < runs.length; first++) {
    for (let second = first + 1; second < runs.length; second++) {
      (runs[first].side === runs[second].side ? within : between).push(matrix[first][second]);
    }
  }

  return { within, between };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const flagged = [];

console.log(`${'view'.padEnd(20)} ${'pixels: noise'.padStart(14)} ${'closest'.padStart(9)}   ${'blocks: noise'.padStart(14)} ${'closest'.padStart(9)}`);

for (const name of names) {
  const pngs = runs.map((run) => fs.readFileSync(path.join(run.dir, name)).toString('base64'));
  const { pixels, blocks } = await page.evaluate(measureView, { pngs, threshold: PIXEL_THRESHOLD, block: BLOCK_SIZE });
  const pixelPairs = splitPairs(pixels);
  const blockPairs = splitPairs(blocks);
  const pixelNoise = Math.max(...pixelPairs.within);
  const blockNoise = Math.max(...blockPairs.within);
  const pixelClosest = Math.min(...pixelPairs.between);
  const blockClosest = Math.min(...blockPairs.between);
  const differs = pixelClosest > pixelNoise * NOISE_FACTOR + PIXEL_SLACK || blockClosest > blockNoise * NOISE_FACTOR + BLOCK_SLACK;

  if (differs) {
    flagged.push(name);
  }

  console.log(`${name.padEnd(20)} ${String(pixelNoise).padStart(14)} ${String(pixelClosest).padStart(9)}   ${blockNoise.toFixed(1).padStart(14)} ${blockClosest.toFixed(1).padStart(9)}${differs ? '   <-- differs' : ''}`);
}

await browser.close();

// r_speeds: every run of a build has to agree, and the builds have to agree with each other
const mismatched = [];

for (const name of names) {
  const view = name.replace(/\.png$/, '');
  const lines = new Map(runs.map((run) => [run.dir, JSON.stringify((speeds.get(run.dir)[view]?.speeds ?? []).slice(0, 3))]));
  const distinct = new Set(lines.values());

  if (distinct.size > 1) {
    mismatched.push(view);
  }
}

console.log('');
console.log(mismatched.length === 0 ? 'r_speeds: identical in every view and every run' : `r_speeds: differs in ${mismatched.join(', ')}`);
console.log(flagged.length === 0 ? 'pixels: nothing differs beyond the noise between captures of one build' : `pixels: differs beyond the noise in ${flagged.join(', ')}`);

process.exit(flagged.length === 0 && mismatched.length === 0 ? 0 : 1);
