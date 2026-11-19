'use strict';

// The hidden super user: made from the environment, above Founder, invisible to everyone else.
const test = require('node:test');
const assert = require('node:assert');
const { startHub, stopAll } = require('./helpers');

test.after(stopAll);

const SU = { SUPERUSER_EMAIL: 'root@nextup.test', SUPERUSER_PASSWORD: 'quiet-owl-4471', SUPERUSER_NAME: 'Admin' };
const quiet = { log() {}, warn() {} };

test('super user: hidden, full access, cannot be changed from the dashboard', async () => {
  const hub = await startHub(SU);
  // It does not count as the first account: the hub still asks for setup.
  assert.strictEqual((await hub.call('GET', '/auth/status')).body.needsSetup, true);
  const founder = await hub.founder();
  const hr = await hub.person(founder, { name: 'Meena', email: 'meena@nextup.test', role: 'hr', team: 'People' });

  const login = await hub.call('POST', '/auth/login', { email: SU.SUPERUSER_EMAIL, password: SU.SUPERUSER_PASSWORD });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.user.role, 'superuser');
  assert.strictEqual(login.body.user.name, 'Admin');
  const su = login.body.token;
  const suId = login.body.user._id;
  assert.ok(login.body.permissions.includes('projects.delete') && login.body.permissions.includes('leave.approve_all'));

  // Nobody sees it, not even with ?all=true; not even itself.
  for (const token of [founder, hr.token, su]) {
    const list = await hub.call('GET', '/users?all=true', null, { token });
    assert.ok(!list.body.users.some((u) => u._id === suId || u.email === SU.SUPERUSER_EMAIL));
  }
  // Nobody can change it or reset its password; it looks like it does not exist.
  assert.strictEqual((await hub.call('PATCH', `/users/${suId}`, { active: false }, { token: founder })).status, 404);
  assert.strictEqual((await hub.call('POST', `/users/${suId}/password`, {}, { token: founder })).status, 404);
  // It cannot be put on a project team or given a build stage.
  const p = await hub.call('POST', '/projects', { name: 'X', team: [{ userId: suId }] }, { token: founder });
  assert.strictEqual(p.body.project.team.length, 0);

  // It can do what a founder can: change a founder, add a founder, delete a project.
  const founderId = (await hub.call('GET', '/auth/me', null, { token: founder })).body.user._id;
  assert.strictEqual((await hub.call('PATCH', `/users/${founderId}`, { title: 'MD' }, { token: su })).status, 200);
  assert.strictEqual((await hub.call('POST', '/users', { name: 'Second', email: 'f2@nextup.test', role: 'founder' }, { token: su })).status, 201);
  assert.strictEqual((await hub.call('DELETE', `/projects/${p.body.project._id}`, null, { token: su })).status, 200);
  // It cannot be made through the API.
  assert.strictEqual((await hub.call('POST', '/users', { name: 'Sneaky', email: 's@nextup.test', role: 'superuser' }, { token: su })).status, 400);
  // Its password lives on the server.
  assert.strictEqual((await hub.call('POST', '/auth/password', { current: SU.SUPERUSER_PASSWORD, password: 'another-pass-99' }, { token: su })).status, 400);
});

test('super user: changing or removing the variables on the server', async () => {
  const hub = await startHub(SU);
  const su = (await hub.call('POST', '/auth/login', { email: SU.SUPERUSER_EMAIL, password: SU.SUPERUSER_PASSWORD })).body.token;

  // A new password signs out the old sessions.
  Object.assign(hub.config, { SUPERUSER_PASSWORD: 'brand-new-pass-21' });
  await hub.app.locals.ensureSuperuser(quiet);
  assert.strictEqual((await hub.call('GET', '/auth/me', null, { token: su })).status, 401);
  assert.strictEqual((await hub.call('POST', '/auth/login', { email: SU.SUPERUSER_EMAIL, password: SU.SUPERUSER_PASSWORD })).status, 401);
  const again = await hub.call('POST', '/auth/login', { email: SU.SUPERUSER_EMAIL, password: 'brand-new-pass-21' });
  assert.strictEqual(again.status, 200);

  // Removing the variables switches it off.
  Object.assign(hub.config, { SUPERUSER_EMAIL: '', SUPERUSER_PASSWORD: '' });
  await hub.app.locals.ensureSuperuser(quiet);
  assert.strictEqual((await hub.call('GET', '/auth/me', null, { token: again.body.token })).status, 401);
  assert.strictEqual((await hub.call('POST', '/auth/login', { email: SU.SUPERUSER_EMAIL, password: 'brand-new-pass-21' })).status, 403);
});

test('super user: an email that belongs to a normal account is left alone', async () => {
  const hub = await startHub();
  const founder = await hub.founder();
  Object.assign(hub.config, { SUPERUSER_EMAIL: 'founder@nextup.test', SUPERUSER_PASSWORD: 'quiet-owl-4471' });
  assert.strictEqual(await hub.app.locals.ensureSuperuser(quiet), null);
  const me = await hub.call('GET', '/auth/me', null, { token: founder });
  assert.strictEqual(me.body.user.role, 'founder');
});
