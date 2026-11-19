'use strict';

// Starts a hub on the in-memory database and gives tests a small HTTP client.
const { createFakeDb } = require('./fakeDb');
const { setup } = require('../src/db');
const { createApp } = require('../src/app');
const baseConfig = require('../src/config');

const SETUP_KEY = 'test-setup-key';
const PASSWORD = 'correct-horse-9';
const servers = [];

async function startHub(overrides = {}) {
  const db = createFakeDb();
  await setup(db);
  const config = {
    ...baseConfig, SETUP_KEY, ADMIN_KEY: '', CONTACT_ORIGINS: [], CONTACT_BURST: 3, CONTACT_DAILY: 10, CONTACT_PER_EMAIL_DAILY: 5,
    TRUST_PROXY: true, LOCK_BUG_ROUTES: false, RELEASE_TOKEN: '', ...overrides,
  };
  const app = createApp({ db, config });
  await app.locals.ensureSuperuser({ log() {}, warn() {} });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  // call(method, path, body, { ip, token, origin })
  async function call(method, path, body, { ip = '203.0.113.1', token, origin, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'X-Forwarded-For': ip,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  }

  /** Creates the founder through the setup screen; returns their token. */
  async function founder() {
    const r = await call('POST', '/auth/setup', { setupKey: SETUP_KEY, name: 'Dhirendra', email: 'founder@nextup.test', password: PASSWORD });
    if (r.status !== 201) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
    return r.body.token;
  }

  /** Adds a person as the founder, sets their own password, signs them in. */
  async function person(founderToken, { name, email, role, team = 'Production', title = '' }) {
    const add = await call('POST', '/users', { name, email, role, team, title }, { token: founderToken });
    if (add.status !== 201) throw new Error(`add failed: ${JSON.stringify(add.body)}`);
    const first = await call('POST', '/auth/login', { email, password: add.body.temporaryPassword }, { ip: `10.9.${servers.length}.${Math.floor(Math.random() * 250)}` });
    await call('POST', '/auth/password', { current: add.body.temporaryPassword, password: PASSWORD }, { token: first.body.token });
    const again = await call('POST', '/auth/login', { email, password: PASSWORD }, { ip: `10.8.${servers.length}.${Math.floor(Math.random() * 250)}` });
    return { token: again.body.token, user: again.body.user };
  }

  return { call, founder, person, db, config, app };
}

const stopAll = () => servers.forEach((s) => s.close());

module.exports = { startHub, stopAll, SETUP_KEY, PASSWORD };
