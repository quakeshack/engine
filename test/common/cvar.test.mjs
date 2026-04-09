import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Cvar from '../../source/engine/common/Cvar.ts';
import { defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

/** @returns {{ prints: string[], warnings: string[], dprints: string[], Print: (message: string) => void, PrintWarning: (message: string) => void, DPrint: (message: string) => void }} captured console methods */
function createConsoleCapture() {
  return {
    prints: [],
    warnings: [],
    dprints: [],
    Print(message) {
      this.prints.push(message);
    },
    PrintWarning(message) {
      this.warnings.push(message);
    },
    DPrint(message) {
      this.dprints.push(message);
    },
  };
}

/**
 * Reset the global Cvar registry between tests.
 */
function resetCvarState() {
  Cvar.Shutdown();
}

void describe('Cvar', () => {
  void test('coerces values and completes variable names', async () => {
    const consoleCapture = createConsoleCapture();

    await withMockRegistry({
      ...defaultMockRegistry({ server: { active: false } }, null),
      Con: consoleCapture,
    }, () => {
      resetCvarState();

      try {
        const skill = new Cvar('skill', '1');
        new Cvar('deathmatch', '0');

        skill.set(' 2 ');
        assert.equal(skill.string, '2');
        assert.equal(skill.value, 2);

        skill.set(true);
        assert.equal(skill.string, '1');
        assert.equal(skill.value, 1);

        assert.deepEqual(Cvar.GetVariableNames(), ['skill', 'deathmatch']);
        assert.equal(Cvar.CompleteVariable('dea'), 'deathmatch');
      } finally {
        resetCvarState();
      }
    });
  });

  void test('reports variable metadata and blocks readonly changes', async () => {
    const consoleCapture = createConsoleCapture();

    await withMockRegistry({
      ...defaultMockRegistry({ server: { active: false } }, null),
      Con: consoleCapture,
    }, () => {
      resetCvarState();

      try {
        const registered = new Cvar('registered', '0', Cvar.FLAG.READONLY | Cvar.FLAG.ARCHIVE, 'Shareware marker.');

        assert.equal(Cvar.Command_f('registered'), true);
        assert.deepEqual(consoleCapture.prints, [
          '"registered" is "0"\n',
          '> Shareware marker.\n',
          '- Cannot be changed.\n',
          '- Will be saved to the configuration file.\n',
        ]);

        assert.equal(Cvar.Command_f('registered', '1'), true);
        assert.equal(registered.string, '0');
        assert.deepEqual(consoleCapture.warnings, ['"registered" is read-only\n']);
      } finally {
        resetCvarState();
      }
    });
  });

  void test('marks archive variables and serializes them to config commands', async () => {
    const consoleCapture = createConsoleCapture();

    await withMockRegistry({
      ...defaultMockRegistry({ server: { active: false } }, null),
      Con: consoleCapture,
    }, () => {
      resetCvarState();

      try {
        const crosshair = new Cvar('crosshair', '0');
        new Cvar('name', 'player');

        Cvar.Seta_f('crosshair', '1');

        assert.equal((crosshair.flags & Cvar.FLAG.ARCHIVE) !== 0, true);
        assert.equal(crosshair.string, '1');
        assert.equal(Cvar.WriteVariables(), 'seta "crosshair" "1"\n');
      } finally {
        resetCvarState();
      }
    });
  });
});
