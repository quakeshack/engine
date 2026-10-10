#!/usr/bin/env node
/**
 * Renders a fixed scene through the real browser client and writes one PNG per view plus `views.json` (the
 * `r_speeds` lines of each view and the browser's console errors). Run it once per build and compare the folders
 * with `compare.mjs`. See docs/browser-verification.md, section 8.
 *
 * Usage:   node scripts/renderer-capture/capture.mjs <distDir> <outDir> [port]
 *
 * - `<distDir>` is a production browser build (`npx vite build --mode production --outDir <dir> --emptyOutDir`).
 * - It is served on `[port]` (default 3101) with `/qfs/*` proxied to a running dedicated server, which is left
 *   alone. `DEDICATED_PORT` overrides its port (default 3000). Both must run the same game (`id1`).
 * - `playwright` is not a dependency of this repo, see section 1 of the doc for how to make it importable.
 *
 * The scene is `e1m1`, paused, with the client clock pinned and the particle generator seeded, so that two
 * captures of one build differ only in what animates in real time (sky, liquids, the FPS counter).
 *
 * Which parts of the engine the script touches is collected in `installAdapter()`: when a refactor moves a
 * member, that is the one place to teach about its new home (and the member has to be exposed on `window.engine`
 * by `bootstrap/createBrowserClient.ts`). Every lookup tries the new home first and falls back to the old one, so
 * the same script can capture the build before and the build after a move.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

const [distDir, outDir, portArgument = '3101'] = process.argv.slice(2);

if (distDir === undefined || outDir === undefined) {
  console.error('usage: node scripts/renderer-capture/capture.mjs <distDir> <outDir> [port]');
  process.exit(2);
}

const DEDICATED = { host: '127.0.0.1', port: Number(process.env.DEDICATED_PORT ?? 3000) };
const VIEWPORT = { width: 960, height: 600 };

// a fixed point in time: where lightstyles and entity animation are read from while the game is paused
const PINNED_CLIENT_TIME = 5000.25;

// console notify lines and the drawer's slide animation run in real time and need to be gone before a screenshot
const SETTLE_MS = 4500;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
};

/**
 * Serves the build and forwards game files to the dedicated server.
 * @param {number} port Port to listen on.
 * @returns {Promise<http.Server>} The listening server.
 */
async function startServer(port) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (url.pathname.startsWith('/qfs/')) {
      const forwarded = http.request({ ...DEDICATED, path: request.url, method: request.method, headers: request.headers }, (upstream) => {
        response.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(response);
      });

      forwarded.on('error', () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(forwarded);

      return;
    }

    let file = path.join(distDir, decodeURIComponent(url.pathname));

    if (file.endsWith('/')) {
      file += 'index.html';
    }

    fs.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(404);
        response.end();

        return;
      }

      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] ?? 'application/octet-stream' });
      response.end(data);
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return server;
}

/**
 * Installs what the scene needs inside the page: the engine members it touches, a seeded `Math.random` and the
 * camera override. Runs in the page, so it cannot use anything of this file.
 */
function installAdapter() {
  const engine = window.engine;
  const R = engine.R;

  window.__capture = {
    engine,
    R,
    // each of these has a new home after the corresponding extraction from R.ts (plans/r-split.md); until then
    // `engine.X` is undefined and the member is still on R
    camera: engine.Camera ?? R,
    particles: engine.Particles ?? R,
    particleTypes: engine.ParticleType ?? R.ptype,
    stats: engine.RenderStats ?? R,
  };

  let seed = 0;

  window.__capture.reseed = () => {
    seed = 0x2545f491;
  };

  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // V.CalcRefdef runs before PreRenderScene, so setting the view here wins over it
  window.__capture.camera_override = null;

  const original = R.PreRenderScene;

  R.PreRenderScene = function () {
    const override = window.__capture.camera_override;

    if (override !== null) {
      window.__capture.camera.refdef.vieworg.setTo(...override.origin);
      window.__capture.camera.refdef.viewangles.setTo(...override.angles);
    }

    return original.call(R);
  };
}

/**
 * Puts two lights, a burst of particles and a decal in front of the view, and freezes the particles.
 * Runs in the page.
 */
function placeEffects() {
  const { engine, camera, particles, particleTypes } = window.__capture;
  const { CL } = engine;

  // frames that ran since the generator was installed would otherwise decide where the particles are
  window.__capture.reseed();

  const time = CL.state.time;
  const lights = CL.state.clientEntities.dlights;
  const ahead = (distance) => camera.refdef.vieworg.copy().add(camera.vpn.copy().multiply(distance));
  const place = (index, origin, radius, color) => {
    const light = lights[index];

    light.radius = radius;
    light.minlight = 0;
    light.decay = 0;
    light.entity = 0;
    light.bornTime = time;
    light.origin.set(origin);
    light.color.setTo(...color);
    light.die = time + 1e6;
  };

  place(0, ahead(120), 300, [1.0, 0.5, 0.2]);
  place(1, ahead(60).add(camera.vright.copy().multiply(80)), 200, [0.2, 0.4, 1.0]);

  particles.ParticleExplosion(ahead(200));
  particles.RunParticleEffect(ahead(150), camera.vright.copy(), 73, 40);
  particles.LavaSplash(ahead(250));

  // gravity and color ramps would otherwise move them between two captures
  for (let i = 0; i < particles.numparticles; i++) {
    const particle = particles.particles[i];

    if (particle.die > time) {
      particle.type = particleTypes.tracer;
      particle.vel.setTo(0, 0, 0);
      particle.die = time + 1e6;
    }
  }
}

/**
 * Finds the largest horizontal sky or liquid face of the loaded map. Runs in the page.
 * @param {'sky' | 'water'} wanted Which kind of face to look for.
 * @returns {{ center: number[], normal: number[] } | null} Where it is, or null when the map has none.
 */
function findFace(wanted) {
  const model = window.__capture.engine.CL.state.worldmodel;
  const centroid = (face) => {
    const sum = [0, 0, 0];

    for (let i = 0; i < face.numedges; i++) {
      const edge = model.surfedges[face.firstedge + i];
      const vertex = edge >= 0 ? model.vertexes[model.edges[edge][0]] : model.vertexes[model.edges[-edge][1]];

      sum[0] += vertex[0];
      sum[1] += vertex[1];
      sum[2] += vertex[2];
    }

    return sum.map((value) => value / face.numedges);
  };

  let best = null;

  for (const face of model.faces) {
    if (face.submodel || (wanted === 'sky' ? !face.sky : !face.turbulent)) {
      continue;
    }

    // a sky face seen from below and a liquid surface seen from above
    const facing = wanted === 'sky' ? face.normal[2] < -0.9 : face.normal[2] > 0.9;

    if (!facing) {
      continue;
    }

    // the largest face wins, so the choice does not depend on map details
    const size = (face.extents[0] + 1) * (face.extents[1] + 1);

    if (best === null || size > best.size) {
      best = { size, center: centroid(face), normal: [face.normal[0], face.normal[1], face.normal[2]] };
    }
  }

  return best;
}

fs.mkdirSync(outDir, { recursive: true });

const server = await startServer(Number(portArgument));
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: VIEWPORT });
const consoleLog = [];

page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleLog.push(`[${message.type()}] ${message.text()}`);
  }
});
page.on('pageerror', (error) => consoleLog.push(`[pageerror] ${error.message}`));

/**
 * Types a console command and makes sure the whole line arrived: the first character typed right after the
 * drawer opens can be swallowed, which turns it into a different command.
 * @param {string} command The console line.
 */
async function enter(command) {
  const isOpen = () => page.evaluate(() => window.engine.ConsoleOverlay.isOpen);
  const echoed = () => page.evaluate((wanted) => window.engine.Con.text
    .filter((line) => line && line.text)
    .slice(-6)
    .some((line) => line.text.trim().toLowerCase().endsWith(wanted.toLowerCase())), command);

  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await isOpen())) {
      await page.keyboard.press('Backquote');
      await page.waitForTimeout(900);
    }

    await page.keyboard.type(command, { delay: 15 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const arrived = await echoed();

    if (await isOpen()) {
      await page.keyboard.press('Backquote');
      await page.waitForTimeout(300);
    }

    if (arrived) {
      return;
    }
  }

  throw new Error(`could not enter: ${command}`);
}

const views = {};

/**
 * Takes the screenshot of a view and records its `r_speeds` lines.
 * @param {string} name File name without extension.
 */
async function capture(name) {
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });

  const speeds = await page.evaluate(() => window.__capture.stats._speeds.slice(0, 4).map((line) => String(line).trim()));

  views[name] = { speeds };
}

/**
 * Overrides the camera until the next call.
 * @param {{ origin: number[], angles: number[] }} view Where to look from, `null` for the game's own view.
 */
async function setCamera(view) {
  await page.evaluate((value) => {
    window.__capture.camera_override = value;
  }, view);
}

await page.goto(`http://127.0.0.1:${portArgument}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.engine?.CL?.cls?.serverController, null, { timeout: 60000 });
await page.waitForTimeout(3000);

// main menu: Single Player, New Game
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.engine.CL.cls.signon === 4 && window.engine.CL.cls.serverController.state.active, null, { timeout: 90000 });
await page.waitForTimeout(3000);

await enter('r_speeds 1');
await enter('pause');
await page.waitForTimeout(1000);

await page.evaluate(installAdapter);

// where the clock stood depends on how long loading took, and lightstyles read it
await page.evaluate((time) => {
  window.engine.CL.state.time = time;
}, PINNED_CLIENT_TIME);
await page.waitForTimeout(1000);

const spawn = await page.evaluate(() => {
  const { refdef } = window.__capture.camera;

  return { origin: [...refdef.vieworg], angles: [...refdef.viewangles] };
});

// 1. the world as spawned: view model, lightmaps, entities in the PVS
await capture('01-spawn');

// 2. dynamic lights, particles and a decal
await page.evaluate(placeEffects);
await enter('test_decal');
await capture('02-effects');
await page.evaluate(() => {
  for (const light of window.engine.CL.state.clientEntities.dlights) {
    light.radius = 0;
    light.die = 0;
  }
});

// 3. the player model in chase view: alias renderer, entity lighting, shadows
await enter('chase_active 1');
await enter('chase_back 80');
await enter('chase_up 20');
await capture('03-chase');
await enter('chase_active 0');

// 4. bloom, then fog, on the spawn view
await enter('r_bloom 1');
await capture('04-bloom');
await enter('r_bloom 0');
await enter('r_fog_mode 1');
await enter('r_fog_density 0.004');
await enter('r_fog_color "40 60 90"');
await capture('05-fog');
await enter('r_fog_mode -1');

// 5. sky, and liquid from above and from inside, found in the map rather than guessed
const sky = await page.evaluate(findFace, 'sky');

if (sky !== null) {
  await setCamera({ origin: [sky.center[0], sky.center[1], sky.center[2] + sky.normal[2] * 64], angles: [-70, 0, 0] });
  await capture('06-sky');
}

const water = await page.evaluate(findFace, 'water');

if (water !== null) {
  await setCamera({ origin: [water.center[0], water.center[1], water.center[2] + 48], angles: [60, 30, 0] });
  await capture('07-water-above');
  await setCamera({ origin: [water.center[0], water.center[1], water.center[2] - 24], angles: [-30, 30, 0] });
  await capture('08-water-below');
}

// the game does not recompute the view while paused, so the spawn view has to be put back explicitly
await setCamera(spawn);
await capture('09-spawn-again');

fs.writeFileSync(path.join(outDir, 'views.json'), JSON.stringify({ views, found: { sky: sky !== null, water: water !== null }, log: consoleLog.slice(0, 40) }, null, 2));
console.log(`${Object.keys(views).length} views written to ${outDir}`);

await browser.close();
server.close();
