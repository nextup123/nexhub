'use strict';

// The Redis cache: faster repeat reads, never a stale or wrongly-permitted answer, and no outage
// when Redis is down. Runs on the in-memory stand-in (or real Redis with TEST_REDIS_URL).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startHub, stopAll } = require('./helpers');
const { createCache, memoryStore } = require('../src/cache');

test.after(stopAll);

async function company(overrides) {
  const hub = await startHub(overrides);
  const founder = { token: await hub.founder() };
  const lead = await hub.person(founder.token, { name: 'Anil', email: 'anil@nextup.test', role: 'lead', team: 'Production' });
  const emp = await hub.person(founder.token, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee', team: 'Production' });
  const as = (who) => (method, path, body) => hub.call(method, path, body, { token: who.token });
  return { hub, founder, lead, emp, as };
}

test('cache: a repeat read is served from the cache, and a change shows at once', async (t) => {
  if (process.env.TEST_CACHE === 'off') return t.skip('cache is off');
  const { lead, as } = await company();
  const p = await as(lead)('POST', '/projects', { name: 'Press tending', customer: { company: 'Singh Plastics' } });
  const first = await as(lead)('GET', '/projects');
  assert.strictEqual(first.headers.get('x-cache'), 'miss');
  const again = await as(lead)('GET', '/projects');
  assert.strictEqual(again.headers.get('x-cache'), 'hit');
  assert.deepStrictEqual(again.body, first.body);

  await as(lead)('PATCH', `/projects/${p.body.project._id}`, { name: 'Bag palletiser' });
  const after = await as(lead)('GET', '/projects');
  assert.strictEqual(after.headers.get('x-cache'), 'miss');
  assert.strictEqual(after.body.projects[0].name, 'Bag palletiser');

  // The robots' frequent reports do not clear the dashboard's projects and people…
  await as(lead)('GET', '/projects');
  await as(lead)('GET', '/home');
  await as(lead)('POST', '/apps/ethercat_config_tool/machines/heartbeat', { machineId: crypto.randomUUID(), name: 'Cell 1' });
  assert.strictEqual((await as(lead)('GET', '/projects')).headers.get('x-cache'), 'hit');
  // …but a new bug report does change the home page's bug counts.
  await as(lead)('POST', '/apps/main_app/bugs', { title: 'Jog stops after 5 minutes', description: 'Happens on cell 2', severity: 'high', category: 'motion' });
  const home = await as(lead)('GET', '/home');
  assert.strictEqual(home.headers.get('x-cache'), 'miss');
});

test('cache: each person gets their own answer, and permission changes apply at once', async () => {
  const { hub, founder, lead, emp, as } = await company();
  const other = await hub.person(founder.token, { name: 'Sara', email: 'sara@nextup.test', role: 'employee', team: 'Software' });
  const p = await as(lead)('POST', '/projects', { name: 'CNC', customer: { company: 'Verma CNC', contactPhone: '+91 98100 00000' }, team: [{ userId: emp.user._id }] });
  const id = p.body.project._id;
  // Same address, different people: the team sees the site phone, someone else does not.
  for (let i = 0; i < 2; i++) {
    assert.strictEqual((await as(emp)('GET', `/projects/${id}`)).body.project.customer.contactPhone, '+91 98100 00000');
    assert.strictEqual((await as(other)('GET', `/projects/${id}`)).body.project.customer.contactPhone, undefined);
  }
  // A lead sees enquiries; demoted to employee, no longer, even though it was cached a moment ago.
  assert.strictEqual((await as(lead)('GET', '/contact-submissions')).status, 200);
  assert.strictEqual((await as(lead)('GET', '/contact-submissions')).status, 200);
  await as(founder)('PATCH', `/users/${lead.user._id}`, { role: 'employee' });
  assert.strictEqual((await as(lead)('GET', '/contact-submissions')).status, 403);
  // Switched off: the cached sign-in stops working at once.
  assert.strictEqual((await as(emp)('GET', '/auth/me')).status, 200);
  await as(founder)('PATCH', `/users/${emp.user._id}`, { active: false });
  assert.strictEqual((await as(emp)('GET', '/auth/me')).status, 401);
  assert.strictEqual((await as(emp)('GET', `/projects/${id}`)).status, 401);
  // Signing out ends the token at once too.
  assert.strictEqual((await as(other)('GET', '/projects')).status, 200);
  await as(other)('POST', '/auth/logout');
  assert.strictEqual((await as(other)('GET', '/projects')).status, 401);
});

test('cache: the hidden super user stays hidden and its changes on the server apply at once', async () => {
  const SU = { SUPERUSER_EMAIL: 'root@nextup.test', SUPERUSER_PASSWORD: 'quiet-owl-4471' };
  const hub = await startHub(SU);
  const founder = await hub.founder();
  const su = (await hub.call('POST', '/auth/login', { email: SU.SUPERUSER_EMAIL, password: SU.SUPERUSER_PASSWORD })).body.token;
  for (let i = 0; i < 2; i++) {
    const list = await hub.call('GET', '/users?all=true', null, { token: founder });
    assert.ok(!list.body.users.some((u) => u.email === SU.SUPERUSER_EMAIL));
    assert.strictEqual((await hub.call('GET', '/auth/me', null, { token: su })).status, 200);
    assert.strictEqual((await hub.call('GET', '/projects', null, { token: su })).status, 200);
  }
  Object.assign(hub.config, { SUPERUSER_EMAIL: '', SUPERUSER_PASSWORD: '' });
  await hub.app.locals.ensureSuperuser({ log() {}, warn() {} });
  assert.strictEqual((await hub.call('GET', '/projects', null, { token: su })).status, 401);
});

test('cache: with Redis down the hub works from MongoDB, and nothing stale comes back after', async () => {
  const mem = memoryStore();
  let down = false;
  const flaky = new Proxy(mem, {
    get(target, prop) {
      if (prop === 'isReady') return !down;
      const v = target[prop];
      return typeof v === 'function' ? (...a) => (down ? Promise.reject(new Error('connection lost')) : v(...a)) : v;
    },
  });
  const { lead, as } = await company({ cache: createCache({ store: flaky, ttl: 60 }) });
  const p = await as(lead)('POST', '/projects', { name: 'Welding cell' });
  await as(lead)('GET', '/projects');
  assert.strictEqual((await as(lead)('GET', '/projects')).headers.get('x-cache'), 'hit');

  down = true;
  const r = await as(lead)('PATCH', `/projects/${p.body.project._id}`, { name: 'Laser welding cell' });
  assert.strictEqual(r.status, 200, 'saving works without Redis');
  const during = await as(lead)('GET', '/projects');
  assert.strictEqual(during.status, 200);
  assert.strictEqual(during.body.projects[0].name, 'Laser welding cell');

  // Redis is back, still holding the answer from before the change: it must not be used.
  down = false;
  const after = await as(lead)('GET', '/projects');
  assert.strictEqual(after.body.projects[0].name, 'Laser welding cell');
});

test('cache: no REDIS_URL means no cache, and the hub works as before', async () => {
  const off = createCache();
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.status(), 'off');
  const { lead, as } = await company({ cache: off });
  assert.strictEqual((await as(lead)('GET', '/projects')).status, 200);
  assert.strictEqual((await as(lead)('GET', '/projects')).headers.get('x-cache'), null);
});
