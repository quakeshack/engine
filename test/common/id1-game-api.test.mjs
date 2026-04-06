import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ServerGameAPI } = await import('../../source/game/id1/GameAPI.ts');

function createMockCvar(initialValue) {
  const normalizedValue = Number(initialValue);

  return {
    value: normalizedValue,
    string: String(normalizedValue),
    set(nextValue) {
      this.value = Number(nextValue);
      this.string = String(this.value);
    },
    free() {
    },
  };
}

function createStaticCvars(overrides = {}) {
  return {
    nomonster: createMockCvar(0),
    fraglimit: createMockCvar(20),
    timelimit: createMockCvar(15),
    samelevel: createMockCvar(0),
    noexit: createMockCvar(0),
    skill: createMockCvar(1),
    deathmatch: createMockCvar(0),
    coop: createMockCvar(0),
    ...overrides,
  };
}

void describe('ServerGameAPI cvar access', () => {
  void test('getters read initialized cvars directly', () => {
    const originalCvars = ServerGameAPI._cvars;

    try {
      ServerGameAPI._cvars = createStaticCvars({
        skill: createMockCvar(3),
        deathmatch: createMockCvar(1),
      });

      const gameAPI = Object.create(ServerGameAPI.prototype);
      gameAPI.constructor = ServerGameAPI;
      gameAPI._cvars = {
        teamplay: createMockCvar(2),
        gravity: createMockCvar(900),
        nextmap: createMockCvar(0),
      };

      assert.equal(gameAPI.skill, 3);
      assert.equal(gameAPI.deathmatch, 1);
      assert.equal(gameAPI.teamplay, 2);
      assert.equal(gameAPI.gravity, 900);
    } finally {
      ServerGameAPI._cvars = originalCvars;
    }
  });

  void test('init normalizes guaranteed cvars in place', () => {
    const originalCvars = ServerGameAPI._cvars;
    let subscribedToEvents = false;
    let precachedResources = false;
    let initializedNextMap = false;

    try {
      const cvars = createStaticCvars({
        coop: createMockCvar(1),
        deathmatch: createMockCvar(1),
        skill: createMockCvar(9),
      });
      ServerGameAPI._cvars = cvars;

      const gameAPI = Object.create(ServerGameAPI.prototype);
      gameAPI.constructor = ServerGameAPI;
      gameAPI.mapname = null;
      gameAPI.serverflags = 0;
      gameAPI.stats = {
        subscribeToEvents() {
          subscribedToEvents = true;
        },
      };
      gameAPI._precacheResources = () => {
        precachedResources = true;
      };
      gameAPI._initNextMap = () => {
        initializedNextMap = true;
      };

      gameAPI.init('e1m1', 7);

      assert.equal(gameAPI.mapname, 'e1m1');
      assert.equal(gameAPI.serverflags, 7);
      assert.equal(cvars.coop.value, 1);
      assert.equal(cvars.deathmatch.value, 0);
      assert.equal(cvars.skill.value, 3);
      assert.equal(subscribedToEvents, true);
      assert.equal(precachedResources, true);
      assert.equal(initializedNextMap, true);
    } finally {
      ServerGameAPI._cvars = originalCvars;
    }
  });
});
