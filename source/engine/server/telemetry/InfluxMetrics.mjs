import process from 'node:process';
import { eventBus, registry } from '../../registry.mjs';
import Cvar from '../../common/Cvar.mjs';

let { Con, Host, NET, SV } = registry;

const ENV = process.env;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Host = registry.Host;
  NET = registry.NET;
  SV = registry.SV;
});

/**
 * Dedicated-server metrics reporter for InfluxDB (line protocol).
 * Keeps integration modular by relying on event bus + periodic snapshots.
 */
export default class InfluxMetrics {
  static #initialized = false;
  static #timer = null;
  static #flushing = false;
  static #lastFrameCount = 0;
  static #lastSampleTsMs = 0;
  static #queue = [];

  static #enable = null;
  static #version = null;
  static #url = null;
  static #database = null;
  static #username = null;
  static #password = null;
  static #retentionPolicy = null;
  static #consistency = null;
  static #token = null;
  static #org = null;
  static #bucket = null;
  static #precision = null;
  static #tags = null;
  static #interval = null;
  static #batchSize = null;
  static #maxQueue = null;
  static #timeoutMs = null;
  static #measurementPrefix = null;

  static Install() {
    if (this.#initialized || !registry.isDedicatedServer) {
      return;
    }

    this.#initialized = true;

    eventBus.subscribe('host.ready', () => {
      this.#initCvars();
      this.#applyRuntimeConfig();
      this.#lastFrameCount = Host.framecount || 0;
      this.#lastSampleTsMs = Date.now();
    });

    eventBus.subscribe('host.shutting-down', () => {
      this.#stop();
      void this.#flushAll();
    });

    eventBus.subscribe('host.shutdown', () => {
      this.#stop();
    });

    eventBus.subscribe('host.crash', (error) => {
      this.#enqueueEventPoint('host_crash', { message: error?.message || 'unknown' });
      void this.#flushAll();
    });

    this.#subscribeEventPoints();

    eventBus.subscribe('cvar.changed', (name) => {
      if (!name.startsWith('influxdb_')) {
        return;
      }

      this.#applyRuntimeConfig();
    });
  }

  static #subscribeEventPoints() {
    const subscriptions = [
      {
        topic: 'server.spawning',
        point: 'server_spawning',
        toTags: ({ mapname }) => ({ mapname: mapname || 'unknown' }),
        flush: false,
      },
      {
        topic: 'server.spawned',
        point: 'server_spawned',
        toTags: ({ mapname }) => ({ mapname: mapname || 'unknown' }),
        flush: true,
      },
      {
        topic: 'server.client.connected',
        point: 'client_connected',
        toTags: (num, name) => ({ slot: String(num), client_name: name || 'unknown' }),
        flush: true,
      },
      {
        topic: 'server.client.disconnected',
        point: 'client_disconnected',
        toTags: (num, name) => ({ slot: String(num), client_name: name || 'unknown' }),
        flush: true,
      },
    ];

    for (const { topic, point, toTags, flush } of subscriptions) {
      eventBus.subscribe(topic, (...args) => {
        this.#enqueueEventPoint(point, toTags(...args));
        if (flush) {
          void this.#flush();
        }
      });
    }
  }

  static #initCvars() {
    if (this.#enable) {
      return;
    }

    this.#enable = new Cvar('influxdb_enable', ENV.INFLUXDB_ENABLE || '0', Cvar.FLAG.ARCHIVE, 'Enable InfluxDB metrics exporter (dedicated server).');
    this.#version = new Cvar('influxdb_version', ENV.INFLUXDB_VERSION || 'auto', Cvar.FLAG.ARCHIVE, 'InfluxDB API version: auto|1|2.');
    this.#url = new Cvar('influxdb_url', ENV.INFLUXDB_URL || '', Cvar.FLAG.ARCHIVE, 'InfluxDB base URL.');
    this.#database = new Cvar('influxdb_database', ENV.INFLUXDB_DATABASE || ENV.INFLUXDB_DB || '', Cvar.FLAG.ARCHIVE, 'InfluxDB database (v1).');
    this.#username = new Cvar('influxdb_username', ENV.INFLUXDB_USERNAME || '', Cvar.FLAG.ARCHIVE, 'InfluxDB username (v1).');
    this.#password = new Cvar('influxdb_password', ENV.INFLUXDB_PASSWORD || '', Cvar.FLAG.SECRET, 'InfluxDB password (v1).');
    this.#retentionPolicy = new Cvar('influxdb_retention_policy', ENV.INFLUXDB_RETENTION_POLICY || ENV.INFLUXDB_RP || '', Cvar.FLAG.ARCHIVE, 'InfluxDB retention policy (v1).');
    this.#consistency = new Cvar('influxdb_consistency', ENV.INFLUXDB_CONSISTENCY || '', Cvar.FLAG.ARCHIVE, 'InfluxDB consistency level (v1, optional).');
    this.#token = new Cvar('influxdb_token', ENV.INFLUXDB_TOKEN || '', Cvar.FLAG.SECRET, 'InfluxDB API token.');
    this.#org = new Cvar('influxdb_org', ENV.INFLUXDB_ORG || '', Cvar.FLAG.ARCHIVE, 'InfluxDB org (v2 API).');
    this.#bucket = new Cvar('influxdb_bucket', ENV.INFLUXDB_BUCKET || '', Cvar.FLAG.ARCHIVE, 'InfluxDB bucket (v2 API).');
    this.#precision = new Cvar('influxdb_precision', ENV.INFLUXDB_PRECISION || 'ms', Cvar.FLAG.ARCHIVE, 'Timestamp precision for writes: ns|us|ms|s.');
    this.#tags = new Cvar('influxdb_tags', ENV.INFLUXDB_TAGS || '', Cvar.FLAG.ARCHIVE, 'Global tags: key=value,key=value');
    this.#interval = new Cvar('influxdb_interval', ENV.INFLUXDB_INTERVAL || '10', Cvar.FLAG.ARCHIVE, 'Periodic metrics interval in seconds.');
    this.#batchSize = new Cvar('influxdb_batch_size', ENV.INFLUXDB_BATCH_SIZE || '250', Cvar.FLAG.ARCHIVE, 'Maximum points per write request.');
    this.#maxQueue = new Cvar('influxdb_max_queue', ENV.INFLUXDB_MAX_QUEUE || '5000', Cvar.FLAG.ARCHIVE, 'Maximum queued points before dropping oldest.');
    this.#timeoutMs = new Cvar('influxdb_timeout_ms', ENV.INFLUXDB_TIMEOUT_MS || '5000', Cvar.FLAG.ARCHIVE, 'HTTP timeout in milliseconds.');
    this.#measurementPrefix = new Cvar('influxdb_measurement_prefix', ENV.INFLUXDB_MEASUREMENT_PREFIX || 'quakeshack', Cvar.FLAG.ARCHIVE, 'Measurement prefix.');
  }

  static #applyRuntimeConfig() {
    this.#stop();

    if (!this.#isEnabledAndConfigured()) {
      return;
    }

    const intervalMs = Math.max(1000, Math.floor(this.#interval.value * 1000));

    this.#timer = setInterval(() => {
      this.#collectPeriodicPoint();
      void this.#flush();
    }, intervalMs);

    this.#collectPeriodicPoint();
    void this.#flush();
  }

  static #stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  static #isEnabledAndConfigured() {
    if (!this.#enable || this.#enable.value === 0 || !this.#hasValue(this.#url)) {
      return false;
    }

    const apiVersion = this.#resolveVersion();
    const required = {
      1: [this.#database],
      2: [this.#org, this.#bucket],
    };

    return required[apiVersion].every((cvar) => this.#hasValue(cvar));
  }

  static #collectPeriodicPoint() {
    if (!this.#isEnabledAndConfigured()) {
      return;
    }

    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const elapsedSec = Math.max(0.001, (nowMs - this.#lastSampleTsMs) / 1000);
    const currentFrameCount = Host.framecount || 0;
    const frameDelta = Math.max(0, currentFrameCount - this.#lastFrameCount);
    const fps = frameDelta / elapsedSec;

    this.#lastFrameCount = currentFrameCount;
    this.#lastSampleTsMs = nowMs;

    this.#enqueuePoint(
      `${this.#measurementPrefix.string}_runtime`,
      this.#buildTags(),
      {
        // Use process uptime (monotonic, seconds) instead of wall-clock epoch time
        uptime_s: process.uptime(),
        framecount: currentFrameCount,
        frametime_ms: (Host.frametime || 0) * 1000,
        fps,
        active_connections: NET.activeconnections || 0,
        server_active: SV.server.active ? 1 : 0,
        server_time: SV.server.time || 0,
        used_edicts: SV.server.num_edicts || 0,
        scheduled_callbacks: Host._scheduledForNextFrame?.length || 0,
      },
      nowMs,
    );
  }

  static #enqueueEventPoint(eventName, extraTags = {}) {
    if (!this.#isEnabledAndConfigured()) {
      return;
    }

    this.#enqueuePoint(
      `${this.#measurementPrefix.string}_events`,
      {
        ...this.#buildTags(),
        event: eventName,
        ...extraTags,
      },
      { value: 1 },
      Date.now(),
    );
  }

  static #buildTags() {
    const tags = {
      mode: 'dedicated',
      map: SV.server.active ? (SV.server.mapname || 'unknown') : 'inactive',
      game: SV.server.active ? (SV.server.gameName || 'unknown') : 'inactive',
    };

    const raw = this.#tags?.string?.trim();
    if (!raw) {
      return tags;
    }

    for (const pair of raw.split(',')) {
      const [key, ...valueParts] = pair.split('=');
      if (!key || valueParts.length === 0) {
        continue;
      }

      const value = valueParts.join('=').trim();
      if (!value) {
        continue;
      }

      tags[key.trim()] = value;
    }

    return tags;
  }

  static #enqueuePoint(measurement, tags, fields, tsMs) {
    const line = this.#toLineProtocol(measurement, tags, fields, tsMs);
    if (!line) {
      return;
    }

    this.#queue.push(line);

    const maxQueue = Math.max(100, Math.floor(this.#maxQueue.value));
    if (this.#queue.length > maxQueue) {
      this.#queue.splice(0, this.#queue.length - maxQueue);
    }
  }

  static #toLineProtocol(measurement, tags, fields, tsMs) {
    const escapedMeasurement = this.#escapeKey(measurement);
    const tagPart = Object.entries(tags)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${this.#escapeKey(k)}=${this.#escapeKey(String(v))}`)
        .join(',');

    const fieldPart = Object.entries(fields)
        .filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => `${this.#escapeKey(k)}=${Number(v)}`)
        .join(',');

    if (fieldPart.length === 0) {
      return '';
    }

    const timestamp = this.#timestampForPrecision(tsMs);
    const head = tagPart ? `${escapedMeasurement},${tagPart}` : escapedMeasurement;

    return `${head} ${fieldPart} ${timestamp}`;
  }

  static #timestampForPrecision(tsMs) {
    const factors = {
      s: 1 / 1000,
      ms: 1,
      us: 1000,
      ns: 1000000,
    };

    const precision = this.#precision.string in factors ? this.#precision.string : 'ms';
    return Math.floor(tsMs * factors[precision]);
  }

  static #escapeKey(value) {
    return value.replaceAll('\\', '\\\\').replaceAll(' ', '\\ ').replaceAll(',', '\\,').replaceAll('=', '\\=');
  }

  static #resolveVersion() {
    const configured = (this.#version?.string || 'auto').trim().toLowerCase();
    const explicit = {
      '1': 1,
      v1: 1,
      '2': 2,
      v2: 2,
    };
    if (explicit[configured]) {
      return explicit[configured];
    }

    const url = this.#url?.string || '';
    if (url.includes('/api/v2/write')) {
      return 2;
    }

    if (this.#hasValue(this.#org) && this.#hasValue(this.#bucket)) {
      return 2;
    }

    return 1;
  }

  static #appendSearchParam(url, key, cvar) {
    if (!url.searchParams.has(key) && this.#hasValue(cvar)) {
      url.searchParams.set(key, cvar.string.trim());
    }
  }

  static #buildRequestV2(baseInput, headers) {
    const hasWritePath = baseInput.includes('/api/v2/write');
    const url = new URL(hasWritePath ? baseInput : `${baseInput.replace(/\/+$/, '')}/api/v2/write`);

    this.#appendSearchParam(url, 'org', this.#org);
    this.#appendSearchParam(url, 'bucket', this.#bucket);

    if (this.#hasValue(this.#token)) {
      headers.Authorization = `Token ${this.#token.string.trim()}`;
    }

    return { version: 2, url, headers };
  }

  static #buildRequestV1(baseInput, headers) {
    const hasWritePath = baseInput.endsWith('/write') || baseInput.includes('/write?');
    const url = new URL(hasWritePath ? baseInput : `${baseInput.replace(/\/+$/, '')}/write`);

    this.#appendSearchParam(url, 'db', this.#database);
    this.#appendSearchParam(url, 'u', this.#username);
    this.#appendSearchParam(url, 'p', this.#password);
    this.#appendSearchParam(url, 'rp', this.#retentionPolicy);
    this.#appendSearchParam(url, 'consistency', this.#consistency);

    return { version: 1, url, headers };
  }

  static #buildWriteRequest() {
    const version = this.#resolveVersion();
    const baseInput = this.#url.string.trim();
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
    };
    const request = version === 2 ? this.#buildRequestV2(baseInput, headers) : this.#buildRequestV1(baseInput, headers);

    this.#appendSearchParam(request.url, 'precision', this.#precision);

    return {
      version: request.version,
      url: request.url.toString(),
      headers: request.headers,
    };
  }

  static #hasValue(cvar) {
    return !!cvar && cvar.string.trim().length > 0;
  }

  static async #flush() {
    if (this.#flushing || this.#queue.length === 0 || !this.#isEnabledAndConfigured()) {
      return;
    }

    this.#flushing = true;

    const batchSize = Math.max(1, Math.floor(this.#batchSize.value));
    const lines = this.#queue.splice(0, batchSize);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(500, Math.floor(this.#timeoutMs.value)));

    try {
      const request = this.#buildWriteRequest();

      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: lines.join('\n'),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`InfluxDB v${request.version} write failed: HTTP ${response.status}`);
      }
    } catch (error) {
      this.#queue.unshift(...lines);
      if (Con) {
        Con.PrintWarning(`InfluxMetrics: ${error.message}\n`);
      } else {
        console.warn('InfluxMetrics:', error.message);
      }
    } finally {
      clearTimeout(timeout);
      this.#flushing = false;
    }
  }

  static async #flushAll() {
    while (this.#queue.length > 0 && this.#isEnabledAndConfigured()) {
      // eslint-disable-next-line no-await-in-loop
      await this.#flush();
      if (this.#flushing) {
        break;
      }
    }
  }
}
