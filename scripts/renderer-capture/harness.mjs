/**
 * What the scripts of this folder share: serving a build next to a running dedicated server and typing console
 * commands into the page. See docs/browser-verification.md, section 8.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const DEDICATED = { host: '127.0.0.1', port: Number(process.env.DEDICATED_PORT ?? 3000) };

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
 * Serves a build and forwards game files to the dedicated server.
 * @param {string} distDir Folder of the production browser build.
 * @param {number} port Port to listen on.
 * @returns {Promise<http.Server>} The listening server.
 */
export async function startServer(distDir, port) {
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
 * Makes the function that types console commands into a page.
 * @param {import('playwright').Page} page The page of the client.
 * @returns {(command: string) => Promise<void>} Types a console line and makes sure the whole line arrived: the first
 * character typed right after the drawer opens can be swallowed, which turns it into a different command.
 */
export function createConsole(page) {
  return async function enter(command) {
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
  };
}
