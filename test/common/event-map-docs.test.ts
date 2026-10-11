import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { clientGameEventNames, documentedEngineEventNames, engineEventTable, forwardedServerEventNames } from '../../source/shared/EngineEvents.ts';
import { forwardedServerEvents } from '../../source/engine/common/ServerWorkerProtocol.ts';
import { clientGameEvents } from '../../source/engine/client/ClientState.ts';

// `engineEventTable` is the one place that says which events the engine has, whether a game sees them and whether
// they cross the worker boundary. `docs/events.md` is written by hand, so these tests are what keeps the two equal.

const eventsDoc = readFileSync(new URL('../../docs/events.md', import.meta.url), 'utf8');

/**
 * Cuts the part of the document from one `## ` heading to the next.
 * @param heading The heading's text.
 * @returns The lines under it.
 */
function section(heading: string): string[] {
  const lines = eventsDoc.split('\n');
  const start = lines.findIndex((line) => line === `## ${heading}`);

  assert.notEqual(start, -1, `docs/events.md has no "${heading}" section`);

  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));

  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/**
 * Reads the names the event tables of a section document: the first cell of every row.
 * @param lines The lines of the section.
 * @returns The documented event names, in the order of the document.
 */
function documentedNames(lines: string[]): string[] {
  const names: string[] = [];

  for (const line of lines) {
    const match = /^\|\s*([a-z][a-z0-9.<>-]*)\s*\|/.exec(line);

    if (match !== null && match[1] !== 'event') {
      names.push(match[1]);
    }
  }

  return names;
}

/**
 * Reads the event names a prose or table cell puts in backticks.
 * @param text The text to read.
 * @returns The dotted lowercase names, which is what an event name looks like.
 */
function backtickedNames(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9-]*(?:\.[a-z0-9<>-]+)+)`/g)].map((match) => match[1]);
}

void describe('docs/events.md', () => {
  void test('documents every event of the engine event table, and nothing else', () => {
    const documented = documentedNames(section('Engine Events'));

    assert.equal(new Set(documented).size, documented.length, 'an event is documented twice');
    assert.deepEqual([...documented].sort(), [...documentedEngineEventNames].sort());
  });

  void test('lists the events the server worker forwards', () => {
    const listed = backtickedNames(section('Events across a server worker').join('\n'));

    assert.deepEqual([...listed].sort(), [...forwardedServerEvents].sort());
  });

  void test('lists the events a client game receives', () => {
    const row = section('Event buses and lifetimes').find((line) => line.startsWith('| Client game bus'));

    assert.ok(row !== undefined, 'the client game bus row is missing');

    const received = row.split('|')[4];

    assert.deepEqual([...backtickedNames(received)].sort(), [...clientGameEvents].sort());
  });

  void test('lists the events a server game receives', () => {
    const row = section('Event buses and lifetimes').find((line) => line.startsWith('| Server game bus'));

    assert.ok(row !== undefined, 'the server game bus row is missing');

    const received = row.split('|')[4];
    const flagged = Object.entries(engineEventTable).filter(([, meta]) => meta.serverGame).map(([name]) => name);

    assert.deepEqual([...backtickedNames(received)].sort(), flagged.sort());
  });
});

void describe('engineEventTable', () => {
  void test('derives the client game events from its flags', () => {
    const flagged = Object.entries(engineEventTable).filter(([, meta]) => meta.clientGame).map(([name]) => name);

    assert.deepEqual([...clientGameEventNames], flagged);
    assert.deepEqual([...clientGameEvents], flagged);
  });

  void test('derives the forwarded server events from its flags', () => {
    const flagged = Object.entries(engineEventTable).filter(([, meta]) => meta.crossesWorker).map(([name]) => name);

    assert.deepEqual([...forwardedServerEventNames], flagged);
    assert.deepEqual([...forwardedServerEvents], flagged);
  });

  void test('does not forward a parameterized name to a client game', () => {
    // The whitelist forwards fixed names; `cvar.changed.<cvar-name>` is only delivered to the server game.
    for (const name of clientGameEventNames) {
      assert.equal(name.includes('<'), false, `${name} is a parameterized name`);
    }
  });
});
