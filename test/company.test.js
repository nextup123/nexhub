'use strict';

// Accounts, roles, HR (attendance, leave, holidays, calendar), production and bug access.
const test = require('node:test');
const assert = require('node:assert');
const { startHub, stopAll, SETUP_KEY, PASSWORD } = require('./helpers');
const D = require('../src/dates');
const { permissionsOf } = require('../src/permissions');

test.after(stopAll);

/** A hub with one person per role: founder, hr, a lead and an employee in Production, and an employee in Software. */
async function company(overrides) {
  const hub = await startHub(overrides);
  const founder = { token: await hub.founder() };
  const hr = await hub.person(founder.token, { name: 'Meena', email: 'meena@nextup.test', role: 'hr', team: 'People' });
  const lead = await hub.person(founder.token, { name: 'Anil', email: 'anil@nextup.test', role: 'lead', team: 'Production' });
  const emp = await hub.person(founder.token, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee', team: 'Production' });
  const other = await hub.person(founder.token, { name: 'Sara', email: 'sara@nextup.test', role: 'employee', team: 'Software' });
  const as = (who) => (method, path, body) => hub.call(method, path, body, { token: who.token });
  return { hub, founder, hr, lead, emp, other, as };
}
/** The next Monday at least `weeks` weeks ahead, so leave dates are always in the future and on working days. */
function monday(weeks = 1) {
  let d = D.addDays(D.todayIn('Asia/Kolkata'), 7 * weeks);
  while (D.weekday(d) !== 1) d = D.addDays(d, 1);
  return d;
}

// ── Accounts ──────────────────────────────────────────────────
test('setup makes the first founder once, with the setup key', async () => {
  const hub = await startHub();
  assert.strictEqual((await hub.call('GET', '/auth/status')).body.needsSetup, true);
  const wrong = await hub.call('POST', '/auth/setup', { setupKey: 'nope', name: 'X', email: 'x@nextup.test', password: PASSWORD });
  assert.strictEqual(wrong.status, 401);
  const weak = await hub.call('POST', '/auth/setup', { setupKey: SETUP_KEY, name: 'Dhirendra', email: 'd@nextup.test', password: 'short' });
  assert.strictEqual(weak.status, 400);
  const ok = await hub.call('POST', '/auth/setup', { setupKey: SETUP_KEY, name: 'Dhirendra', email: 'd@nextup.test', password: PASSWORD });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.user.role, 'founder');
  assert.ok(ok.body.token.length > 30);
  const again = await hub.call('POST', '/auth/setup', { setupKey: SETUP_KEY, name: 'Mallory', email: 'm@nextup.test', password: PASSWORD });
  assert.strictEqual(again.status, 409, 'setup only works while there are no accounts');
  assert.strictEqual((await hub.call('GET', '/auth/status')).body.needsSetup, false);
});

test('sign in, wrong passwords, temporary passwords and sign out', async () => {
  const hub = await startHub();
  const founder = await hub.founder();
  assert.strictEqual((await hub.call('POST', '/auth/login', { email: 'founder@nextup.test', password: 'wrong-password' })).status, 401);
  assert.strictEqual((await hub.call('POST', '/auth/login', { email: 'nobody@nextup.test', password: PASSWORD })).status, 401);
  const add = await hub.call('POST', '/users', { name: 'Ravi', email: 'Ravi@Nextup.test', role: 'employee', team: 'Production' }, { token: founder });
  assert.strictEqual(add.status, 201);
  assert.strictEqual(add.body.user.email, 'ravi@nextup.test');
  const first = await hub.call('POST', '/auth/login', { email: 'ravi@nextup.test', password: add.body.temporaryPassword }, { ip: '10.1.1.1' });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.user.mustChangePassword, true);
  // Nothing else works until the temporary password is changed.
  assert.strictEqual((await hub.call('GET', '/units', null, { token: first.body.token })).status, 403);
  const changed = await hub.call('POST', '/auth/password', { current: add.body.temporaryPassword, password: PASSWORD }, { token: first.body.token });
  assert.strictEqual(changed.status, 200);
  assert.strictEqual((await hub.call('GET', '/units', null, { token: first.body.token })).status, 200);
  assert.strictEqual((await hub.call('POST', '/auth/logout', null, { token: first.body.token })).status, 200);
  assert.strictEqual((await hub.call('GET', '/auth/me', null, { token: first.body.token })).status, 401);
});

test('sign-in attempts are rate limited', async () => {
  const hub = await startHub();
  await hub.founder();
  let last;
  for (let i = 0; i < 11; i += 1) last = await hub.call('POST', '/auth/login', { email: 'founder@nextup.test', password: `guess-${i}-xx` }, { ip: '192.0.2.9' });
  assert.strictEqual(last.status, 429);
});

test('HR has founder powers over people; switching someone off signs them out', async () => {
  const { hub, founder, hr, emp, as } = await company();
  assert.strictEqual((await as(hr)('POST', '/users', { name: 'New Founder', email: 'nf@nextup.test', role: 'founder' })).status, 201, 'HR can add a founder, like a founder can');
  const me = await as(founder)('GET', '/auth/me');
  assert.strictEqual((await as(hr)('PATCH', `/users/${me.body.user._id}`, { team: 'Management' })).status, 200);
  assert.strictEqual((await as(emp)('POST', '/users', { name: 'Y', email: 'y@nextup.test', role: 'employee' })).status, 403, 'employees cannot add people');
  // Directory: everyone sees names and roles; HR records only for founder, HR and the person.
  await as(hr)('PATCH', `/users/${emp.user._id}`, { hr: { employeeId: 'NX-014', joinedOn: '2025-06-02', emergencyContact: 'Sunita, +91 98100 00000' } });
  const seenByOther = (await as(hr)('GET', '/users')).body.users.find((u) => u._id === emp.user._id);
  assert.strictEqual(seenByOther.hr.employeeId, 'NX-014');
  const seenByEmployee = (await hub.call('GET', '/users', null, { token: (await hub.person(founder.token, { name: 'Kiran', email: 'kiran@nextup.test', role: 'employee' })).token })).body.users.find((u) => u._id === emp.user._id);
  assert.strictEqual(seenByEmployee.hr, undefined);
  assert.strictEqual(seenByEmployee.name, 'Ravi');
  // Switch off.
  assert.strictEqual((await as(hr)('PATCH', `/users/${emp.user._id}`, { active: false })).status, 200);
  assert.strictEqual((await as(emp)('GET', '/auth/me')).status, 401);
  // The last founder cannot be demoted.
  assert.strictEqual((await as(founder)('PATCH', `/users/${me.body.user._id}`, { role: 'lead' })).status, 400);
});

test('each role gets the permissions in the table', () => {
  assert.ok(permissionsOf('founder').includes('enquiries.delete'));
  for (const p of permissionsOf('founder')) assert.ok(permissionsOf('hr').includes(p), `HR should have ${p} like a founder`);
  assert.ok(permissionsOf('hr').includes('projects.delete'));
  assert.ok(!permissionsOf('lead').includes('users.grant_lead'));
  assert.ok(permissionsOf({ role: 'employee', leadPowers: { by: 'Meena' } }).includes('projects.manage'));
  assert.ok(!permissionsOf({ role: 'employee', leadPowers: { by: 'Meena' } }).includes('projects.delete'));
  assert.ok(permissionsOf('lead').includes('production.manage'));
  assert.ok(!permissionsOf('employee').includes('production.manage'));
  assert.ok(permissionsOf('employee').includes('leave.self'));
});

test('lead powers: founders, HR and the super user give an employee lead powers and take them back', async () => {
  const { hub, founder, hr, lead, emp, other, as } = await company({ SUPERUSER_EMAIL: 'root@nextup.test', SUPERUSER_PASSWORD: 'super-secret-9' });
  const grant = (who, target, g) => as(who)('POST', `/users/${target.user._id}/lead-powers`, { grant: g });
  // Before: an employee cannot create a project or a client.
  assert.strictEqual((await as(emp)('POST', '/projects', { name: 'Line 4', customer: { company: 'Tata' } })).status, 403);
  // Only founders, HR and the super user may grant.
  assert.strictEqual((await grant(lead, emp, true)).status, 403, 'a lead cannot grant');
  assert.strictEqual((await grant(other, emp, true)).status, 403, 'an employee cannot grant');
  assert.strictEqual((await grant(founder, lead, true)).status, 400, 'only employees get lead powers');
  assert.strictEqual((await as(hr)('POST', `/users/${emp.user._id}/lead-powers`, {})).status, 400);
  const g = await grant(hr, emp, true);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.body.user.leadPowers.by, 'Meena');
  assert.strictEqual(g.body.user.role, 'employee', 'the role stays Employee');
  // Now they have every lead permission, but not founder-only ones.
  const me = (await as(emp)('GET', '/auth/me')).body;
  for (const p of ['projects.manage', 'clients.manage', 'production.manage', 'assets.manage', 'attendance.team', 'leave.approve_team', 'bugs.triage', 'enquiries.view']) assert.ok(me.permissions.includes(p), p);
  assert.ok(!me.permissions.includes('projects.delete'));
  assert.ok(!me.permissions.includes('users.grant_lead'));
  assert.ok(me.user.leadPowers);
  const made = await as(emp)('POST', '/projects', { name: 'Line 4', customer: { company: 'Tata' } });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  // Everyone sees who has lead powers in the directory.
  assert.ok((await as(other)('GET', '/users')).body.users.find((u) => u._id === emp.user._id).leadPowers);
  // Take back: the next request is refused again.
  assert.strictEqual((await grant(founder, emp, false)).status, 200);
  assert.strictEqual((await as(emp)('POST', '/projects', { name: 'Line 5', customer: { company: 'Tata' } })).status, 403);
  assert.ok(!(await as(emp)('GET', '/auth/me')).body.user.leadPowers);
  // The super user can grant too; a role change away from Employee drops the powers.
  const root = await hub.call('POST', '/auth/login', { email: 'root@nextup.test', password: 'super-secret-9' });
  assert.strictEqual(root.status, 200);
  assert.strictEqual((await grant({ token: root.body.token }, other, true)).status, 200);
  assert.strictEqual((await as(founder)('PATCH', `/users/${other.user._id}`, { role: 'lead' })).status, 200);
  assert.strictEqual((await as(founder)('PATCH', `/users/${other.user._id}`, { role: 'employee' })).status, 200);
  assert.ok(!(await as(other)('GET', '/auth/me')).body.user.leadPowers);
});

test('HR can delete like a founder', async () => {
  const { founder, hr, as } = await company();
  const p = await as(founder)('POST', '/projects', { name: 'Old line', customer: { company: 'Acme' } });
  assert.strictEqual(p.status, 201, JSON.stringify(p.body));
  assert.strictEqual((await as(hr)('DELETE', `/projects/${p.body.project._id}`)).status, 200);
});

// ── Attendance ────────────────────────────────────────────────
test('check in and out once a day; leads see their team, HR sees everyone', async () => {
  const { emp, other, lead, hr, as } = await company();
  const inn = await as(emp)('POST', '/attendance/check-in', { mode: 'office' });
  assert.strictEqual(inn.status, 201);
  assert.strictEqual((await as(emp)('POST', '/attendance/check-in', {})).status, 409);
  const out = await as(emp)('POST', '/attendance/check-out', {});
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.record.status, 'half_day', 'a few seconds is less than half a day');
  assert.strictEqual((await as(emp)('POST', '/attendance/check-out', {})).status, 409);

  const leadView = await as(lead)('GET', '/attendance/today');
  const names = leadView.body.board.map((b) => b.user.name);
  assert.ok(names.includes('Ravi') && !names.includes('Sara'), 'a lead sees only their own team');
  const hrView = await as(hr)('GET', '/attendance/today');
  assert.ok(hrView.body.board.map((b) => b.user.name).includes('Sara'));
  const empView = await as(other)('GET', '/attendance/today');
  assert.strictEqual(empView.body.board.length, 0, 'employees see only themselves');

  const month = await as(hr)('GET', '/attendance/month');
  const ravi = month.body.people.find((p) => p.user.name === 'Ravi');
  assert.strictEqual(ravi.days[month.body.today].status, 'half_day');
  assert.ok(month.body.canEdit);
  // HR corrects a day; an employee cannot.
  const day = D.addDays(month.body.today, -1);
  assert.strictEqual((await as(hr)('PUT', `/attendance/${emp.user._id}/${day}`, { status: 'present', checkIn: '09:30', checkOut: '18:00' })).body.record.hours, 8.5);
  assert.strictEqual((await as(emp)('PUT', `/attendance/${emp.user._id}/${day}`, { status: 'present' })).status, 403);
});

// ── Leave ─────────────────────────────────────────────────────
test('leave: working days are counted, the team lead approves, balances update', async () => {
  const { emp, lead, other, hr, founder, as } = await company();
  const mon = monday(2);
  const sat = D.addDays(mon, 5);
  const sun = D.addDays(mon, 6);
  // Mon to Sun is 6 working days (Sunday is the weekly off).
  const req = await as(emp)('POST', '/leave', { type: 'casual', from: mon, to: sun, reason: 'Family wedding in Jaipur' });
  assert.strictEqual(req.status, 201);
  assert.strictEqual(req.body.leave.days, 6);
  assert.strictEqual((await as(emp)('POST', '/leave', { type: 'sick', from: sat, to: sat })).status, 409, 'overlapping leave is refused');

  // A holiday inside the range is not counted.
  await as(hr)('POST', '/holidays', { date: D.addDays(mon, 14), name: 'Diwali', kind: 'festival' });
  const two = await as(emp)('POST', '/leave', { type: 'earned', from: D.addDays(mon, 14), to: D.addDays(mon, 15) });
  assert.strictEqual(two.body.leave.days, 1);

  // Who may decide: the lead of the same team, HR, founders; not another employee, not the person.
  assert.strictEqual((await as(other)('POST', `/leave/${req.body.leave._id}/decision`, { decision: 'approve' })).status, 403);
  assert.strictEqual((await as(emp)('POST', `/leave/${req.body.leave._id}/decision`, { decision: 'approve' })).status, 403);
  const approvals = await as(lead)('GET', '/leave?scope=approvals');
  assert.strictEqual(approvals.body.leave.length, 2);
  assert.strictEqual(approvals.body.leave[0].reason !== undefined, true, 'the approver sees the reason');
  const ok = await as(lead)('POST', `/leave/${req.body.leave._id}/decision`, { decision: 'approve', comment: 'Enjoy' });
  assert.strictEqual(ok.body.leave.status, 'approved');
  assert.strictEqual((await as(hr)('POST', `/leave/${req.body.leave._id}/decision`, { decision: 'reject' })).status, 409);

  const bal = await as(emp)('GET', `/leave/balance?year=${mon.slice(0, 4)}`);
  if (D.addDays(mon, 6).slice(0, 4) === mon.slice(0, 4)) assert.strictEqual(bal.body.balance.casual.used, 6);
  assert.strictEqual((await as(other)('GET', `/leave/balance?userId=${emp.user._id}`)).status, 403);

  // Too much leave is refused.
  assert.strictEqual((await as(other)('POST', '/leave', { type: 'sick', from: monday(10), to: D.addDays(monday(10), 13) })).status, 400);

  // The calendar shows who is away to everyone, but not why.
  const cal = await as(other)('GET', `/calendar?from=${mon}&to=${sun}`);
  const away = cal.body.items.find((i) => i.type === 'leave');
  assert.strictEqual(away.title, 'Ravi');
  assert.strictEqual(away.kind, undefined);
  // Cancel your own pending request.
  assert.strictEqual((await as(emp)('POST', `/leave/${two.body.leave._id}/cancel`)).status, 200);
  assert.ok(founder);
});

test('a lead cannot approve their own leave or another team; HR can', async () => {
  const { lead, other, hr, as } = await company();
  const own = await as(lead)('POST', '/leave', { type: 'casual', from: monday(3), to: monday(3) });
  assert.strictEqual((await as(lead)('POST', `/leave/${own.body.leave._id}/decision`, { decision: 'approve' })).status, 403);
  const sara = await as(other)('POST', '/leave', { type: 'casual', from: monday(3), to: monday(3) });
  assert.strictEqual((await as(lead)('POST', `/leave/${sara.body.leave._id}/decision`, { decision: 'approve' })).status, 403, 'Sara is in Software');
  assert.strictEqual((await as(hr)('POST', `/leave/${own.body.leave._id}/decision`, { decision: 'approve' })).status, 200);
});

// ── Holidays and events ───────────────────────────────────────
test('holidays and events: HR manages, leads add events, employees only read', async () => {
  const { hr, lead, emp, as } = await company();
  const y = D.todayIn('Asia/Kolkata').slice(0, 4);
  assert.strictEqual((await as(hr)('POST', '/holidays', { date: `${y}-08-15`, name: 'Independence Day', kind: 'national' })).status, 201);
  assert.strictEqual((await as(hr)('POST', '/holidays', { date: `${y}-08-15`, name: 'Again' })).status, 409);
  assert.strictEqual((await as(emp)('POST', '/holidays', { date: `${y}-10-02`, name: 'Gandhi Jayanti' })).status, 403);
  assert.strictEqual((await as(emp)('GET', `/holidays?year=${y}`)).body.holidays.length, 1);
  const ev = await as(lead)('POST', '/events', { title: 'Demo for Sharma Auto', date: `${y}-08-20`, kind: 'demo', time: '11:00' });
  assert.strictEqual(ev.status, 201);
  assert.strictEqual((await as(emp)('POST', '/events', { title: 'x', date: `${y}-08-20` })).status, 403);
  const cal = await as(emp)('GET', `/calendar?from=${y}-08-01&to=${y}-08-31`);
  assert.deepStrictEqual(cal.body.items.map((i) => i.type), ['holiday', 'event']);
});

// ── Production ────────────────────────────────────────────────
test('production: units get serials and stages; employees tick off only their own stages', async () => {
  const { lead, emp, other, hr, founder, as } = await company();
  const a = await as(lead)('POST', '/units', { model: 'NexC5', colour: 'Blue', customer: { company: 'Sharma Auto', city: 'Pune' }, targetDate: '2030-01-15' });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.body.unit.serial, 'NX-C5-0001');
  assert.strictEqual(a.body.unit.phase, 'planned');
  assert.strictEqual(a.body.unit.stages[1].label, 'Base ready');
  const b = await as(lead)('POST', '/units', { model: 'NexC5' });
  assert.strictEqual(b.body.unit.serial, 'NX-C5-0002');
  assert.strictEqual(b.body.unit.colour, 'White');
  assert.strictEqual((await as(emp)('POST', '/units', { model: 'NexR10' })).status, 403);
  assert.strictEqual((await as(hr)('GET', '/units')).status, 200, 'HR sees production like a founder');

  const id = a.body.unit._id;
  // Employees cannot change a stage that is not theirs.
  assert.strictEqual((await as(emp)('PATCH', `/units/${id}/stages/base`, { state: 'done' })).status, 403);
  await as(lead)('PATCH', `/units/${id}/stages/base`, { assigneeId: emp.user._id });
  await as(lead)('PATCH', `/units/${id}/stages/parts`, { state: 'done' });
  const started = await as(emp)('PATCH', `/units/${id}/stages/base`, { state: 'in_progress' });
  assert.strictEqual(started.body.unit.phase, 'in_build');
  assert.strictEqual(started.body.unit.progress.current.label, 'Base ready');
  const done = await as(emp)('PATCH', `/units/${id}/stages/base`, { state: 'done' });
  assert.strictEqual(done.body.unit.progress.done, 2);
  assert.strictEqual(done.body.unit.progress.pct, 20);
  assert.strictEqual((await as(emp)('PATCH', `/units/${id}/stages/base`, { assigneeId: other.user._id })).status, 403, 'only leads assign');
  assert.strictEqual((await as(emp)('PATCH', `/units/${id}/stages/base`, { state: 'skipped' })).status, 403);

  // My stages on the summary
  await as(lead)('PATCH', `/units/${id}/stages/wiring`, { assigneeId: emp.user._id });
  const sum = await as(emp)('GET', '/units/summary');
  assert.deepStrictEqual(sum.body.myStages.map((s) => s.label), ['Wiring done']);
  assert.strictEqual((await as(emp)('GET', '/units?assignee=me')).body.units.length, 1);

  // Blocked, add a stage, finish everything, dispatch.
  const blocked = await as(lead)('PATCH', `/units/${id}/stages/joints`, { state: 'blocked', note: 'J3 gearbox delayed by supplier' });
  assert.strictEqual(blocked.body.unit.progress.blocked, true);
  const added = await as(lead)('POST', `/units/${id}/stages`, { label: 'Customer acceptance test', after: 'testing' });
  assert.strictEqual(added.body.unit.stages.length, 11);
  let u = added.body.unit;
  for (const s of u.stages) u = (await as(lead)('PATCH', `/units/${id}/stages/${s.key}`, { state: 'done' })).body.unit;
  assert.strictEqual(u.phase, 'ready');
  const shipped = await as(lead)('PATCH', `/units/${id}`, { dispatchedOn: '2030-01-10' });
  assert.strictEqual(shipped.body.unit.phase, 'dispatched');
  assert.ok(shipped.body.unit.history.some((h) => /Dispatched/.test(h.text)));
  assert.ok(shipped.body.unit.history.some((h) => /Base ready: done/.test(h.text) && h.by === 'Ravi'));

  // Notes from anyone in production; delete only by a founder.
  assert.strictEqual((await as(emp)('POST', `/units/${id}/notes`, { text: 'Torque values logged in the QA sheet' })).status, 201);
  assert.strictEqual((await as(lead)('DELETE', `/units/${b.body.unit._id}`)).status, 403);
  assert.strictEqual((await as(founder)('DELETE', `/units/${b.body.unit._id}`)).status, 200);
});

test('a late unit is flagged, and target dates show on the calendar for production roles only', async () => {
  const { lead, hr, as } = await company();
  const yesterday = D.addDays(D.todayIn('Asia/Kolkata'), -1);
  await as(lead)('POST', '/units', { model: 'NexR20', targetDate: yesterday });
  const sum = await as(lead)('GET', '/units/summary');
  assert.strictEqual(sum.body.late.length, 1);
  const leadCal = await as(lead)('GET', `/calendar?from=${yesterday}&to=${yesterday}`);
  assert.ok(leadCal.body.items.some((i) => i.type === 'unit'));
  const hrCal = await as(hr)('GET', `/calendar?from=${yesterday}&to=${yesterday}`);
  assert.ok(hrCal.body.items.some((i) => i.type === 'unit'));
});

// ── Bug reports ───────────────────────────────────────────────
test('bugs: robots still report without signing in; roles decide who reads and triages', async () => {
  const { hub, emp, lead, hr, as } = await company();
  const r = await hub.call('POST', '/apps/ethercat_config_tool/bugs', { title: 'Homing stops on J3', description: 'x', reporter: { name: 'Vendor', phone: '+91 90000 00000', email: 'v@example.com' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await as(hr)('GET', '/bugs')).status, 200, 'HR reads bugs like a founder');
  const empList = await as(emp)('GET', '/bugs');
  assert.strictEqual(empList.body.total, 1);
  assert.strictEqual(empList.body.bugs[0].reporter.phone, undefined, 'employees do not get customer phone numbers');
  assert.strictEqual((await as(lead)('GET', '/bugs')).body.bugs[0].reporter.phone, '+91 90000 00000');
  assert.strictEqual((await as(emp)('PATCH', '/bugs/ECT-1', { status: 'in_progress' })).status, 403);
  assert.strictEqual((await as(emp)('POST', '/bugs/ECT-1/comments', { text: 'I can reproduce it' })).status, 201);
  const p = await as(lead)('PATCH', '/bugs/ECT-1', { status: 'in_progress' });
  assert.strictEqual(p.body.bug.statusHistory[1].by, 'Anil', 'the signed-in name is recorded');
  const home = await as(emp)('GET', '/home');
  assert.strictEqual(home.body.bugs.ethercat_config_tool.open, 1);
  assert.strictEqual(home.body.enquiries, undefined);
});

test('LOCK_BUG_ROUTES closes the maintainer routes to anyone not signed in, but not the robots', async () => {
  const hub = await startHub({ LOCK_BUG_ROUTES: true, RELEASE_TOKEN: 'release-secret-123' });
  await hub.founder();
  assert.strictEqual((await hub.call('POST', '/apps/main_app/bugs', { title: 'Freeze', description: 'x' })).status, 201);
  assert.strictEqual((await hub.call('GET', '/apps/main_app/bugs')).status, 401);
  assert.strictEqual((await hub.call('PUT', '/apps/main_app/releases/1.0.0', { title: 'x', status: 'draft' })).status, 401);
  assert.strictEqual((await hub.call('PUT', '/apps/main_app/releases/1.0.0', { title: 'x', status: 'draft' }, { token: 'release-secret-123' })).status, 200);
  assert.strictEqual((await hub.call('GET', '/apps/main_app/releases?status=published')).status, 200, 'machines still read releases');
});
