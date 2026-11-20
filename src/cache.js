'use strict';

/**
 * Optional Redis cache (REDIS_URL). Without it, or while Redis is unreachable, every request goes
 * to MongoDB exactly as before: the cache can make the hub faster, never wrong or unavailable.
 *
 * What is cached (src/app.js):
 *   - sign-ins: the session and its person, so a request does not need two MongoDB reads first;
 *   - GET answers of the dashboard, per person and per address, for CACHE_TTL seconds (default 60).
 *
 * How it stays correct: every key includes a "generation". Any change (POST, PUT, PATCH, DELETE,
 * or the super user being set up at start) moves the generation on before its answer is sent, so
 * the next read can only find answers made after the change. Two generations, so the robots'
 * frequent reports (heartbeats, bug reports) do not throw away the dashboard's people and projects:
 *   main  : everything except bug reports, releases and machines
 *   robot : bug reports, releases, machines, update records (and /home, which counts bugs)
 * An answer is cached per person, after their own permission checks passed, so roles apply exactly
 * as without the cache; a role change, a switched-off account or a sign-out is a change too.
 */

const crypto = require('crypto');

const OP_TIMEOUT_MS = 300;
const fresh = () => `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('cache timeout')), OP_TIMEOUT_MS).unref())]);

/** A tiny in-memory store with the same few commands, for tests and `CACHE=memory`. */
function memoryStore() {
  const m = new Map();
  const live = (k) => { const e = m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { m.delete(k); return null; } return e.v; };
  return {
    isReady: true,
    get: async (k) => live(k),
    mGet: async (ks) => ks.map(live),
    set: async (k, v, opt = {}) => {
      if (opt.NX && live(k) !== null) return null;
      m.set(k, { v: String(v), exp: opt.EX ? Date.now() + opt.EX * 1000 : 0 });
      return 'OK';
    },
    del: async (ks) => { [].concat(ks).forEach((k) => m.delete(k)); },
    quit: async () => {},
    size: () => m.size,
  };
}

function createCache({ url = '', ttl = 60, log = console, store, prefix = 'nx:' } = {}) {
  const PREFIX = prefix;
  let client = store || null;
  let kind = store ? 'memory' : 'off';
  let lastError = '';
  // Set when a generation could not be moved on (Redis was down): no cached answer is used
  // until it has been, so nothing from before the change can come back.
  let dirty = false;

  if (!client && url) {
    kind = 'redis';
    const { createClient } = require('redis');
    client = createClient({
      url,
      disableOfflineQueue: true, // fail at once while disconnected, and fall back to MongoDB
      socket: { connectTimeout: 5000, reconnectStrategy: (n) => Math.min(500 * n, 10000) },
    });
    client.on('error', (err) => {
      const m = String(err && err.message || err);
      if (m !== lastError) log.warn(`[cache] Redis: ${m}. Using MongoDB directly until it is back.`);
      lastError = m;
    });
    client.on('ready', () => {
      lastError = '';
      log.log('[cache] Redis connected');
      // Writes may have happened while it was away (here or on another instance): start afresh.
      bumpAll().catch(() => {});
    });
    client.connect().catch(() => { /* the 'error' handler logs; reconnecting continues */ });
  }

  const ready = () => !!client && client.isReady !== false;

  async function bump(name) {
    if (!client) return;
    try { await withTimeout(client.set(PREFIX + 'gen:' + name, fresh())); }
    catch { dirty = true; }
  }
  async function bumpAll() {
    if (!client) return;
    try {
      await withTimeout(Promise.all([client.set(PREFIX + 'gen:main', fresh()), client.set(PREFIX + 'gen:robot', fresh())]));
      dirty = false;
    } catch { dirty = true; }
  }

  /** The current generations, or null when the cache must not be used right now. */
  async function generations() {
    if (!ready()) return null;
    if (dirty) { await bumpAll(); if (dirty) return null; }
    try {
      let [main, robot] = await withTimeout(client.mGet([PREFIX + 'gen:main', PREFIX + 'gen:robot']));
      // A generation that was lost (Redis restarted or evicted it) gets a new value, never an old one.
      if (!main) { await withTimeout(client.set(PREFIX + 'gen:main', fresh(), { NX: true })); main = await withTimeout(client.get(PREFIX + 'gen:main')); }
      if (!robot) { await withTimeout(client.set(PREFIX + 'gen:robot', fresh(), { NX: true })); robot = await withTimeout(client.get(PREFIX + 'gen:robot')); }
      return main && robot ? { main, robot } : null;
    } catch { return null; }
  }

  async function get(key) {
    if (!ready()) return null;
    try { return await withTimeout(client.get(PREFIX + key)); } catch { return null; }
  }
  async function set(key, value, seconds = ttl) {
    if (!ready() || seconds <= 0) return;
    try { await withTimeout(client.set(PREFIX + key, value, { EX: Math.max(1, Math.floor(seconds)) })); } catch { /* not cached, that's all */ }
  }

  return {
    get kind() { return kind; },
    enabled: kind !== 'off',
    ttl,
    status: () => (kind === 'off' ? 'off' : ready() ? `${kind} connected` : `${kind} not connected${lastError ? `: ${lastError}` : ''}`),
    generations, bump, bumpAll, get, set,
    close: async () => { if (client && kind === 'redis') await client.quit().catch(() => {}); },
  };
}

module.exports = { createCache, memoryStore };
