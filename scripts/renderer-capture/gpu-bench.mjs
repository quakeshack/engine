#!/usr/bin/env node
/**
 * Measures the GPU time of the scene on the real GPU, at fixed views and under named settings, and counts the
 * full-screen copies each frame makes. Run it on a build before and after a change. See
 * docs/browser-verification.md, section 9.
 *
 * Usage:   node scripts/renderer-capture/gpu-bench.mjs <distDir> <benchFile> <outDir> [port]
 *
 * - `<distDir>` is a production browser build, `<benchFile>` a JSON file with the map, the settings to compare and the
 *   views (`views/hw_doom-glass.json` is an example), `<outDir>` receives `results.json` and one PNG per view.
 * - It is served on `[port]` (default 3121) with `/qfs/*` proxied to a running dedicated server, which is left alone.
 *   `DEDICATED_PORT` overrides its port (default 3000), `CAPTURE_GAME` names the mod, `id1` when left out.
 * - `BENCH_MSAA` is a comma-separated list of `gl_msaa` values (default `4`), `BENCH_ROUNDS` how often every setting is
 *   measured at a view (default 2): the spread between rounds is the noise a difference has to beat.
 *
 * The page runs its server in-thread (`?serverthread`) because the player has to stand at the view: the server sends
 * the entities around the player, so a camera moved on the client alone sees the map without its brush entities.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

import { createConsole, startServer } from './harness.mjs';

const [distDir, benchFile, outDir, portArgument = '3121'] = process.argv.slice(2);

if (distDir === undefined || benchFile === undefined || outDir === undefined) {
  console.error('usage: node scripts/renderer-capture/gpu-bench.mjs <distDir> <benchFile> <outDir> [port]');
  process.exit(2);
}

const VIEWPORT = { width: 1920, height: 1080 };
const GAME = process.env.CAPTURE_GAME ?? 'id1';
const MSAA_VALUES = (process.env.BENCH_MSAA ?? '4').split(',');
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 2);

// frames that are left out after a change of setting or view, and frames a sample is the median of
const SETTLE_FRAMES = 12;
const SAMPLE_FRAMES = 120;

const bench = JSON.parse(fs.readFileSync(benchFile, 'utf8'));

/**
 * Hooks the frame inside the page: a timer query from `PostProcess.begin` to `end`, the copies in between, and the
 * camera. Runs in the page, so it cannot use anything of this file.
 */
function installBench() {
  const { Camera, PostProcess } = window.engine;
  const gl = document.getElementById('mainwindow').getContext('webgl2');
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const state = {
    renderer: debug !== null ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown',
    timer: timer !== null,
    camera: null,
    frames: [],
    current: { colorCopies: 0, depthCopies: 0 },
  };

  window.__bench = state;

  if (timer === null) {
    return;
  }

  const hookOwner = Camera;
  const updateViewVectors = hookOwner.UpdateViewVectors;

  // FirstPersonView.CalcRefdef runs before the view vectors are derived, so setting the view here wins over it
  hookOwner.UpdateViewVectors = function () {
    if (state.camera !== null) {
      Camera.refdef.vieworg.setTo(...state.camera.origin);
      Camera.refdef.viewangles.setTo(...state.camera.angles);
    }

    return updateViewVectors.call(hookOwner);
  };

  const begin = PostProcess.begin;
  const end = PostProcess.end;
  const copySceneColor = PostProcess.copySceneColor;
  const copySceneDepth = PostProcess.copySceneDepth;
  const pending = [];
  let active = null;

  PostProcess.copySceneColor = function (...args) {
    state.current.colorCopies++;

    return copySceneColor.apply(PostProcess, args);
  };

  PostProcess.copySceneDepth = function (...args) {
    state.current.depthCopies++;

    return copySceneDepth.apply(PostProcess, args);
  };

  PostProcess.begin = function () {
    state.current = { colorCopies: 0, depthCopies: 0 };
    state.frameStart = performance.now();

    if (active === null) {
      active = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, active);
    }

    return begin.call(PostProcess);
  };

  PostProcess.end = function () {
    const result = end.call(PostProcess);

    if (active !== null) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push({ query: active, frame: { ...state.current, cpu: performance.now() - state.frameStart } });
      active = null;
    }

    // results arrive some frames later; a query that overlapped a disjoint event is not worth anything
    while (pending.length > 0 && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const { query, frame } = pending.shift();
      const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);

      if (!disjoint) {
        state.frames.push({ ...frame, gpu: gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 });
      }

      gl.deleteQuery(query);
    }

    return result;
  };
}

/**
 * Puts the player at a view, so the server sends what is there, and pins the camera to it. Noclip keeps the player
 * from falling away. Runs in the page.
 * @param {{ origin: number[], angles: number[] }} view Where to look from.
 */
function placePlayer(view) {
  const edict = window.engine.SV.server.edicts[1];
  const { entity } = edict;

  entity.velocity.setTo(0, 0, 0);
  edict.setOrigin(entity.origin.copy().setTo(view.origin[0] - entity.view_ofs[0], view.origin[1] - entity.view_ofs[1], view.origin[2] - entity.view_ofs[2]));
  window.__bench.camera = view;
}

/**
 * Measures the frames that follow. Runs in the page.
 * @param {{ settle: number, frames: number }} counts How many frames to leave out and how many to take.
 * @returns {Promise<{ gpu: number, cpu: number, colorCopies: number, depthCopies: number }>} The median of each.
 */
async function sample({ settle, frames }) {
  const state = window.__bench;
  const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
  const waitUntil = (done) => new Promise((resolve) => {
    const step = () => {
      if (done()) {
        resolve();
      } else {
        requestAnimationFrame(step);
      }
    };

    step();
  });
  let left = settle;

  await waitUntil(() => left-- <= 0);
  state.frames.length = 0;
  await waitUntil(() => state.frames.length >= frames);

  const taken = state.frames.slice();

  return {
    gpu: median(taken.map((frame) => frame.gpu)),
    cpu: median(taken.map((frame) => frame.cpu)),
    colorCopies: median(taken.map((frame) => frame.colorCopies)),
    depthCopies: median(taken.map((frame) => frame.depthCopies)),
  };
}

/**
 * Formats a list of timings as a range when the rounds differ.
 * @param {number[]} values Milliseconds per round.
 * @returns {string} The range with two decimals.
 */
function formatRange(values) {
  const low = Math.min(...values).toFixed(2);
  const high = Math.max(...values).toFixed(2);

  return low === high ? low : `${low}–${high}`;
}

fs.mkdirSync(outDir, { recursive: true });

const server = await startServer(distDir, Number(portArgument));
const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: VIEWPORT });
const enter = createConsole(page);
const pageErrors = [];

page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto(`http://127.0.0.1:${portArgument}/?${GAME === 'id1' ? '' : `game=${GAME}&`}serverthread`, { waitUntil: 'load' });
await page.waitForFunction(() => window.engine?.CL?.cls !== undefined, null, { timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(installBench);

const { renderer, timer } = await page.evaluate(() => ({ renderer: window.__bench.renderer, timer: window.__bench.timer }));

console.log(`renderer: ${renderer}`);

if (!timer) {
  throw new Error('EXT_disjoint_timer_query_webgl2 is not available, nothing can be measured');
}

if (/swiftshader|llvmpipe/i.test(renderer)) {
  console.warn('software GL: these numbers say nothing about a GPU');
}

await enter(`map ${bench.map}`);
await page.waitForFunction(() => window.engine.CL.cls.signon === 4, null, { timeout: 90000, polling: 500 });
await page.waitForTimeout(5000);
await enter('sv_cheats 1');
await enter('god');
await enter('notarget');
await enter('noclip');

const results = [];

for (const msaa of MSAA_VALUES) {
  await enter(`gl_msaa ${msaa}`);
  await page.waitForTimeout(1000);

  for (const view of bench.views) {
    await page.evaluate(placePlayer, view);
    await page.waitForTimeout(1500);

    // a running game changes the scene under the measurement: waves start, monsters walk in, tints come and go
    await enter('pause');
    await page.waitForTimeout(500);

    const row = { msaa, view: view.name, settings: {} };

    for (const setting of bench.settings) {
      row.settings[setting.name] = { gpu: [], cpu: [], colorCopies: 0, depthCopies: 0 };
    }

    for (let round = 0; round < ROUNDS; round++) {
      for (const setting of bench.settings) {
        for (const command of setting.commands) {
          await enter(command);
        }

        const measured = await page.evaluate(sample, { settle: SETTLE_FRAMES, frames: SAMPLE_FRAMES });
        const entry = row.settings[setting.name];

        entry.gpu.push(measured.gpu);
        entry.cpu.push(measured.cpu);
        entry.colorCopies = measured.colorCopies;
        entry.depthCopies = measured.depthCopies;
      }
    }

    await page.screenshot({ path: path.join(outDir, `msaa${msaa}-${view.name}.png`) });
    await enter('pause');

    // a view that looks right can still lack what it is meant to measure, and then every number in its row is wrong
    if (Object.values(row.settings).every((entry) => entry.colorCopies === 0)) {
      console.warn(`${view.name}: no setting made a color copy, is what should be measured in the view?`);
    }

    results.push(row);
  }
}

const samples = await page.evaluate(() => window.engine.PostProcess.msaaSamples);

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ renderer, map: bench.map, viewport: VIEWPORT, rounds: ROUNDS, msaaSamples: samples, results, pageErrors: pageErrors.slice(0, 20) }, null, 2));

const names = bench.settings.map((setting) => setting.name);

console.log(`\n| gl_msaa | View | ${names.join(' | ')} |`);
console.log(`|---|---|${names.map(() => '---:').join('|')}|`);

for (const row of results) {
  const cells = names.map((name) => {
    const entry = row.settings[name];

    return `${formatRange(entry.gpu)} (${entry.colorCopies}c ${entry.depthCopies}d)`;
  });

  console.log(`| ${row.msaa} | ${row.view} | ${cells.join(' | ')} |`);
}

console.log('\nScene GPU ms, range over the rounds; (color copies, depth copies) per frame.');

if (pageErrors.length > 0) {
  console.warn(`page errors: ${pageErrors.slice(0, 5).join('; ')}`);
}

await browser.close();
server.close();
