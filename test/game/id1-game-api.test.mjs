import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ServerGameAPI } = await import('../../source/game/id1/GameAPI.ts');
const { default: BaseEntity } = await import('../../source/game/id1/entity/BaseEntity.ts');

/**
 * Create a mutable mock cvar.
 * @param {number|string} initialValue Initial cvar value.
 * @returns {object} Mock cvar.
 */
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

/**
 * Create the static cvar table used by ServerGameAPI tests.
 * @param {object} overrides Override values for selected cvars.
 * @returns {object} Mock static cvar registry.
 */
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

/**
 * Create the minimal server engine surface required by ServerGameAPI construction tests.
 * @param {object} overrides Optional engine overrides.
 * @returns {object} Mock server engine.
 */
function createMockServerEngine(overrides = {}) {
  const cvars = {
    teamplay: createMockCvar(0),
    sv_gravity: createMockCvar(800),
    sv_nextmap: createMockCvar(0),
  };

  return {
    GetCvar(name) {
      return cvars[name] ?? createMockCvar(0);
    },
    eventBus: {
      subscribe() {
        return () => {};
      },
    },
    maxplayers: 1,
    ...overrides,
  };
}

void describe('ServerGameAPI serialization', () => {
  void test('preserves the legacy serialized field set with decorator registration', () => {
    const gameAPI = new ServerGameAPI(createMockServerEngine());

    assert.deepEqual(ServerGameAPI.serializableFields, [
      'mapname',
      'force_retouch',
      'stats',
      'parm1',
      'parm2',
      'parm3',
      'parm4',
      'parm5',
      'parm6',
      'parm7',
      'parm8',
      'parm9',
      'parm10',
      'parm11',
      'parm12',
      'parm13',
      'parm14',
      'parm15',
      'parm16',
      'serverflags',
      'time',
      'framecount',
      'frametime',
      'worldspawn',
      'lastspawn',
      'gameover',
      'intermission_running',
      'intermission_exittime',
      'nextmap',
    ]);

    const serialized = gameAPI.serialize();

    assert.deepEqual(Object.keys(serialized), ServerGameAPI.serializableFields);
    assert.deepEqual(serialized.stats, ['S', {
      monsters_total: ['P', 0],
      monsters_killed: ['P', 0],
      secrets_total: ['P', 0],
      secrets_found: ['P', 0],
    }]);
    assert.equal(Object.hasOwn(serialized, 'gameAI'), false);
    assert.equal(Object.hasOwn(serialized, 'bodyque_head'), false);
  });
});

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

void describe('ServerGameAPI entity lifecycle', () => {
  void test('prepareEntity precaches after assigned initial data is applied', () => {
    class DeferredInitEntity extends BaseEntity {
      static classname = 'deferred_init_entity';

      constructor(edict, gameAPI) {
        super(edict, gameAPI);
        this.constructorValue = 3;
      }

      _declareFields() {
        super._declareFields();
        this._serializer.startFields();
        this.initializerReady = 0;
        this.constructorValue = 0;
        this.precacheObservedValue = -1;
        this._serializer.endFields();
      }

      _precache() {
        this.precacheObservedValue = this.initializerReady;
      }
    }

    const originalRegistry = ServerGameAPI._entityRegistry;
    const originalCvars = ServerGameAPI._cvars;

    try {
      ServerGameAPI._cvars = createStaticCvars();
      ServerGameAPI._entityRegistry = {
        has(classname) {
          return classname === DeferredInitEntity.classname;
        },
        get(classname) {
          return classname === DeferredInitEntity.classname ? DeferredInitEntity : null;
        },
      };

      const gameAPI = Object.create(ServerGameAPI.prototype);
      gameAPI.constructor = ServerGameAPI;
      gameAPI.engine = {
        ConsoleWarning() {},
        IsLoading() {
          return false;
        },
      };
      gameAPI._missingEntityClassStats = {};
      gameAPI._isPreparingEntityAllowed = () => true;

      const edict = { entity: null };

      const prepared = gameAPI.prepareEntity(edict, DeferredInitEntity.classname, {
        initializerReady: 7,
      });

      assert.equal(prepared, true);
      assert.equal(edict.entity.precacheObservedValue, 7);
      assert.equal(edict.entity.constructorValue, 0);
    } finally {
      ServerGameAPI._entityRegistry = originalRegistry;
      ServerGameAPI._cvars = originalCvars;
    }
  });
});
