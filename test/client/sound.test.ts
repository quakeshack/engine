import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import clientCvars from '../../source/engine/client/ClientCvars.ts';
import Host from '../../source/engine/common/Host.ts';
import Sound, { SFX } from '../../source/engine/client/Sound.ts';
import Vector from '../../source/shared/Vector.ts';
import { createTreeModel } from '../support/bspTree.ts';
import { patchMembers } from '../support/clientState.ts';
import { createCvarStub } from '../support/cvarStub.ts';
import { installEngineMocks } from '../support/withEngineMocks.ts';

void describe('Sound.IsPositionAudible', () => {
  /**
   * Builds a minimal BrushModel where every point is in the source leaf (cluster 0), the tree splits so far out that
   * no test point reaches the other side. The listener sits in leaf 0 (cluster 5).
   * @param sourceReveals whether the source leaf's PHS row reveals the listener's cluster
   * @returns fixture.
   */
  function buildSingleLeafFixture(sourceReveals: boolean): { model: BrushModel, listenerLeaf: number } {
    const model = createTreeModel(
      [{ normal: [1, 0, 0], dist: 1e8, type: 0 }],
      [{ planeNum: 0, children: [~1, ~1] }],
      [{ contents: -1, cluster: 5 }, { contents: -1, cluster: 0 }], // CONTENT_EMPTY leafs: the listener's, then the source's
    );
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([sourceReveals ? 0x20 : 0x00]); // cluster 0's row; bit5 = listener's cluster

    return { model, listenerLeaf: 0 };
  }

  /**
   * Installs a minimal client registry context for IsPositionAudible tests.
   * @param options fixture overrides
   * @returns context handle
   */
  function installClientContext({ worldmodel = null }: { worldmodel?: BrushModel | null } = {}): { restore: () => void } {
    const previousListenerLeaf = Sound._listenerLeaf;

    const restoreEngineMocks = installEngineMocks({ CL: { state: { worldmodel } } });

    return {
      restore() {
        restoreEngineMocks();
        Sound._listenerLeaf = previousListenerLeaf;
      },
    };
  }

  void test('returns true when the source position\'s PHS reveals the listener\'s cluster', () => {
    const { model, listenerLeaf } = buildSingleLeafFixture(true);
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('returns false when the source position\'s PHS does not reveal the listener\'s cluster', () => {
    const { model, listenerLeaf } = buildSingleLeafFixture(false);
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), false);
    } finally {
      context.restore();
    }
  });

  void test('resolves audibility via the fat-point PHS when the source sits inside solid content near a wall (e.g. an explosion impact)', () => {
    // leaf 0 is the listener's (cluster 5), leaf 1 the solid one, which must never contribute, leaf 2 the open room beside the wall
    const model = createTreeModel(
      [{ normal: [1, 0, 0], dist: 0, type: 0 }],
      [{ planeNum: 0, children: [~1, ~2] }],
      [{ contents: -1, cluster: 5 }, { contents: -2, cluster: -1 }, { contents: -1, cluster: 0 }],
    );
    model.numclusters = 8;
    model.visdata = new Uint8Array(0);
    model.clusterPhsOffsets = [0];
    model.phsdata = new Uint8Array([0x20]); // cluster 0's row reveals cluster 5 (the listener's cluster)

    const listenerLeaf = 0;

    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      // 2 units past the plane on the solid side: a strict single-path descent (as plain
      // getLeafForPoint would do) lands in the solid leaf and reads as inaudible. Within the
      // 8-unit fat-point fudge both sides are merged, and the open-air leaf's PHS correctly
      // reveals the listener — matching a real explosion's impact point against geometry.
      assert.equal(Sound.IsPositionAudible(new Vector(2, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('defaults to audible when there is no worldmodel loaded', () => {
    const context = installClientContext({ worldmodel: null });

    try {
      Sound._listenerLeaf = null;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('defaults to audible when the listener leaf has not been established yet', () => {
    const { model } = buildSingleLeafFixture(true);
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = null;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });

  void test('defaults to audible when the worldmodel has no compiled PHS data', () => {
    const { model, listenerLeaf } = buildSingleLeafFixture(false);
    model.phsdata = null;
    const context = installClientContext({ worldmodel: model });

    try {
      Sound._listenerLeaf = listenerLeaf;

      assert.equal(Sound.IsPositionAudible(new Vector(0, 0, 0)), true);
    } finally {
      context.restore();
    }
  });
});

void describe('Sound playback', () => {
  /** An `AudioParam` that counts how often its value is written. */
  interface CountingParam {
    value: number;
    readonly writes: number[];
  }

  /** What a buffer source of the fake context was asked to do. */
  interface RecordedSource {
    loop: boolean;
    started: boolean;
  }

  /**
   * Makes a parameter that records every value written to it.
   * @param initial The value it starts with.
   * @returns The parameter.
   */
  function countingParam(initial: number): CountingParam {
    let current = initial;
    const writes: number[] = [];

    return {
      writes,
      get value() {
        return current;
      },
      set value(next: number) {
        current = next;
        writes.push(next);
      },
    };
  }

  const pans: CountingParam[] = [];
  const gains: CountingParam[] = [];
  const sources: RecordedSource[] = [];
  const files = new Map<string, (data: ArrayBuffer | null) => void>();
  let state: AudioContextState = 'running';
  let restore: () => void = () => {};

  /** A context with what Channel and LoadSound use: panner and gain nodes, buffer sources, decoding. */
  const context = {
    get state() {
      return state;
    },
    createStereoPanner() {
      const pan = countingParam(0);
      pans.push(pan);
      return { pan, connect() {}, disconnect() {} };
    },
    createGain() {
      const gain = countingParam(1);
      gains.push(gain);
      return { gain, connect() {}, disconnect() {} };
    },
    createBufferSource() {
      const source: RecordedSource & Record<string, unknown> = {
        loop: false,
        started: false,
        connect() {},
        disconnect() {},
        start() {
          source.started = true;
        },
        stop() {
          source.started = false;
        },
      };
      sources.push(source);
      return source;
    },
    decodeAudioData(_data: ArrayBuffer) {
      return Promise.resolve({ duration: 1 } as AudioBuffer);
    },
  };

  /**
   * A sound that is loaded already.
   * @param name Its name.
   * @param loopstart Where it loops, `null` for a sound without a loop marker.
   * @returns The sound.
   */
  function loadedSound(name: string, loopstart: number | null): SFX {
    const sfx = new SFX(name);
    sfx.state = SFX.STATE.AVAILABLE;
    sfx.cache = { data: { duration: 1 } as AudioBuffer, length: 1, loopstart, size: 0 };
    return sfx;
  }

  /**
   * Starts loading a sound whose file arrives when the test says so, see {@link deliver}.
   * @param name Its name.
   * @returns The sound, loading.
   */
  function loadingSound(name: string): SFX {
    const sfx = new SFX(name);
    void Sound.LoadSound(sfx);
    return sfx;
  }

  /**
   * Lets the file of a loading sound arrive and waits until it is decoded and whoever waited for it ran.
   * @param name The sound.
   */
  async function deliver(name: string): Promise<void> {
    files.get(`sound/${name}`)!(new ArrayBuffer(4));
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  /** Runs the update of one frame with the listener at the origin, looking along +x, with +y to its right. */
  function update(): void {
    Sound.Update(new Vector(0, 0, 0), new Vector(1, 0, 0), new Vector(0, 1, 0), new Vector(0, 0, 1), false);
  }

  beforeEach(() => {
    pans.length = 0;
    gains.length = 0;
    sources.length = 0;
    files.clear();
    state = 'running';

    const restoreEngineMocks = installEngineMocks({
      CL: { state: { worldmodel: null, viewentity: 1 } },
      COM: {
        LoadFile: (name: string) => new Promise<ArrayBuffer | null>((resolve) => {
          files.set(name, resolve);
        }),
      },
    });
    const restoreSound = patchMembers(Sound, {
      _started: true,
      _context: context as unknown as AudioContext,
      _masterGain: {} as GainNode,
      _underwaterFilter: null,
      _staticChannels: [],
      _channels: [],
      _ambientChannels: [],
      _nosound: createCvarStub(0),
      volume: createCvarStub(1),
      _ambientLevel: createCvarStub(0.3),
      _ambientFade: createCvarStub(100),
    });
    const restoreCvars = patchMembers(clientCvars, { areaportals: createCvarStub(0) });
    const restoreHost = patchMembers(Host, { realtime: 0 });

    restore = () => {
      restoreHost();
      restoreCvars();
      restoreSound();
      restoreEngineMocks();
    };
  });

  afterEach(() => {
    restore();
  });

  void describe('writing to the audio graph', () => {
    void test('writes an unchanged pan and volume once, not every frame', () => {
      // the listener is known before the sound starts, as in a running game
      update();
      Sound.StaticSound(loadedSound('ambience/fire1.wav', 0), new Vector(0, 100, 0), 1, 1);
      update();
      update();
      update();

      assert.equal(pans[0].writes.length, 1);
      assert.equal(gains[0].writes.length, 1);
    });

    // In Chrome every write to a suspended context stays queued and makes the next one slower: after twenty minutes
    // of a paused game the static sounds took half a frame.
    void test('writes nothing while the context is suspended, and what changed once it runs again', () => {
      update();
      state = 'suspended';
      Sound.StaticSound(loadedSound('ambience/fire1.wav', 0), new Vector(0, 100, 0), 1, 1);
      update();
      update();

      assert.deepEqual(pans[0].writes, []);
      assert.deepEqual(gains[0].writes, []);

      state = 'running';
      update();

      // the source is straight to the right of the listener
      assert.deepEqual(pans[0].writes, [1]);
      assert.equal(gains[0].writes.length, 1);
    });
  });

  void describe('a sound that loads after the sounds were stopped', () => {
    // a static sound started a looping source on its disposed channel, which nothing could stop any more
    void test('does not start a static sound of the map before', async () => {
      const sfx = loadingSound('ambience/fire1.wav');

      Sound.StaticSound(sfx, new Vector(0, 100, 0), 1, 1);
      Sound.StopAllSounds();
      await deliver('ambience/fire1.wav');

      assert.equal(sfx.state, SFX.STATE.AVAILABLE);
      assert.deepEqual(sources, []);
    });

    void test('does not start a sound that was asked for before', async () => {
      const sfx = loadingSound('weapons/pkup.wav');

      Sound.StartSound(5, 1, sfx, new Vector(0, 100, 0), 1, 1);
      Sound.StopAllSounds();
      await deliver('weapons/pkup.wav');

      assert.deepEqual(sources, []);
    });

    void test('still starts a sound that was asked for after', async () => {
      const sfx = loadingSound('weapons/pkup.wav');

      Sound.StopAllSounds();
      Sound.StartSound(5, 1, sfx, new Vector(0, 100, 0), 1, 1);
      await deliver('weapons/pkup.wav');

      assert.equal(sources.length, 1);
      assert.equal(sources[0].started, true);
    });
  });

  void describe('a static sound without a loop marker', () => {
    // the static sound used to write a loop start into the sound's shared data, so every later play of it looped
    void test('loops on its own channel and leaves other plays of the sound alone', () => {
      const sfx = loadedSound('misc/hum.wav', null);

      Sound.StaticSound(sfx, new Vector(0, 100, 0), 1, 1);
      Sound.StartSound(5, 1, sfx, new Vector(0, 100, 0), 1, 1);

      assert.deepEqual(sources.map((source) => source.loop), [true, false]);
      assert.equal(sfx.cache!.loopstart, null);
    });
  });

  void describe('a dynamic channel', () => {
    // `cache?.loopstart !== null` took a sound without data for a looping one, so its channel was never freed
    void test('is free again at its end when its sound has no data', () => {
      const sfx = new SFX('misc/broken.wav');
      sfx.state = SFX.STATE.AVAILABLE;

      Sound.StartSound(5, 1, sfx, new Vector(0, 100, 0), 1, 1);
      const channels = pans.length;

      Host.realtime = 10;
      update();
      Sound.StartSound(6, 1, loadedSound('weapons/pkup.wav', null), new Vector(0, 100, 0), 1, 1);

      assert.equal(pans.length, channels, 'the second sound took the freed channel instead of a new one');
    });

    void test('keeps a looping sound past its end', () => {
      Sound.StartSound(5, 1, loadedSound('misc/hum.wav', 0), new Vector(0, 100, 0), 1, 1);

      Host.realtime = 10;
      update();

      assert.equal(sources[0].started, true);
    });
  });
});
