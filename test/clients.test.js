'use strict';

// Clients with many projects, equipment around the robots, error-code search, robots from before
// the hub with their software versions, the bulk import, and projects from older versions.
const test = require('node:test');
const assert = require('node:assert');
const { startHub, stopAll } = require('./helpers');
const { parseDate } = require('../src/importer');
const { codesIn } = require('../src/projects');

test.after(stopAll);

const SU = { SUPERUSER_EMAIL: 'root@nextup.test', SUPERUSER_PASSWORD: 'quiet-owl-4471' };

async function company(overrides) {
  const hub = await startHub(overrides);
  const founder = { token: await hub.founder() };
  const lead = await hub.person(founder.token, { name: 'Anil', email: 'anil@nextup.test', role: 'lead' });
  const emp = await hub.person(founder.token, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee' });
  const other = await hub.person(founder.token, { name: 'Sara', email: 'sara@nextup.test', role: 'employee', team: 'Software' });
  const hr = await hub.person(founder.token, { name: 'Meena', email: 'meena@nextup.test', role: 'hr', team: 'People' });
  const as = (who) => (method, path, body) => hub.call(method, path, body, { token: who.token });
  return { hub, founder, lead, emp, other, hr, as };
}

test('clients: one client, many projects; contacts only for its project teams', async () => {
  const { lead, emp, other, hr, as } = await company();
  const a = await as(lead)('POST', '/projects', { name: 'Lathe tending', customer: { company: 'Verma CNC Works', city: 'Faridabad' }, team: [{ userId: emp.user._id }] });
  const b = await as(lead)('POST', '/projects', { name: 'Deburring cell', customer: { company: '  verma cnc   works ' } });
  assert.strictEqual(a.body.project.clientId, b.body.project.clientId, 'the same company is one client');
  const cid = a.body.project.clientId;
  assert.strictEqual(b.body.project.customer.company, 'Verma CNC Works');
  assert.strictEqual((await as(hr)('GET', '/clients')).status, 200, 'HR sees clients like a founder');
  assert.strictEqual((await as(emp)('POST', '/clients', { name: 'X' })).status, 403);

  await as(lead)('PATCH', `/clients/${cid}`, { industry: 'CNC machining', contacts: [{ name: 'Mr. Verma', role: 'Owner', phone: '+91 98100 00000' }] });
  const list = await as(emp)('GET', '/clients');
  assert.deepStrictEqual(list.body.clients[0].counts, { projects: 2, active: 2, robots: 0 });
  assert.strictEqual(list.body.clients[0].contacts[0].phone, '+91 98100 00000', 'on the team of one of its projects');
  const notTeam = await as(other)('GET', `/clients/${cid}`);
  assert.strictEqual(notTeam.body.client.contacts[0].phone, undefined);
  assert.strictEqual(notTeam.body.client.contacts[0].name, 'Mr. Verma');
  assert.strictEqual(notTeam.body.projects.length, 2);

  // A second client with the same name is refused; renaming shows everywhere.
  assert.strictEqual((await as(lead)('POST', '/clients', { name: 'VERMA CNC WORKS' })).status, 409);
  await as(lead)('PATCH', `/clients/${cid}`, { name: 'Verma Precision' });
  assert.strictEqual((await as(emp)('GET', `/projects/${a.body.project._id}`)).body.project.customer.company, 'Verma Precision');
  assert.strictEqual((await as(emp)('GET', '/projects/search?q=precision%20deburring')).body.hits.length, 1);
  // A client with projects cannot be deleted.
  assert.strictEqual((await as(lead)('DELETE', `/clients/${cid}`)).status, 403);
});

test('equipment and smart problems: error codes in any spelling, and "seen before"', async () => {
  const { lead, emp, as } = await company();
  const p = await as(lead)('POST', '/projects', { name: 'Press line', customer: { company: 'Singh Plastics' } });
  const id = p.body.project._id;
  const q = await as(lead)('POST', `/projects/${id}/equipment`, { kind: 'conveyor', name: 'Infeed conveyor', make: 'Kiran', model: 'BC-600' });
  assert.strictEqual(q.status, 201);
  await as(lead)('POST', `/projects/${id}/equipment`, { kind: 'spm', name: 'Deflashing station' });
  assert.strictEqual((await as(emp)('POST', `/projects/${id}/equipment`, { name: 'x' })).status, 403);
  const u = await as(lead)('POST', '/units', { model: 'NexC5', projectId: id, alreadyBuilt: true, installedOn: '2025-02-25', softwareVersion: 'v3.4.2' });

  const solved = await as(emp)('POST', `/projects/${id}/entries`, {
    kind: 'issue', title: 'Drive J3 drops off EtherCAT', errorCodes: 'e131, AL-21', component: 'Servo drive J3', unitId: u.body.unit._id,
    rootCause: 'Shield not grounded', solution: 'Grounded the shield at both ends', status: 'solved', category: 'communication',
  });
  assert.strictEqual(solved.status, 201, JSON.stringify(solved.body));
  assert.deepStrictEqual(solved.body.entry.errorCodes, ['E131', 'AL-21']);
  assert.strictEqual(solved.body.entry.softwareVersion, '3.4.2', 'the robot’s software at the time');
  const onConveyor = await as(emp)('POST', `/projects/${id}/entries`, { kind: 'issue', title: 'Belt slips at high speed', description: 'VFD shows F 0003', equipmentId: q.body.equipment._id });
  assert.strictEqual(onConveyor.body.entry.equipmentName, 'Infeed conveyor');

  for (const term of ['E131', 'e-131', 'e131', 'al21', 'AL-21']) {
    const r = await as(emp)('GET', `/projects/search?q=${encodeURIComponent(term)}`);
    assert.ok(r.body.hits.some((h) => h.item._id === solved.body.entry._id), `${term} finds it`);
  }
  assert.ok((await as(emp)('GET', '/projects/search?q=F0003')).body.hits.some((h) => h.item._id === onConveyor.body.entry._id), 'a code written with a space');
  assert.ok((await as(emp)('GET', '/projects/search?q=conveyor%20belt')).body.hits.length >= 1);
  assert.ok((await as(emp)('GET', '/projects/search?q=special%20purpose%20machine')).body.hits.some((h) => h.type === 'project'));
  assert.ok((await as(emp)('GET', '/projects/search?q=3.4.2')).body.hits.length >= 1, 'a software version');

  // Logging the same alarm on another project: the solved one shows up first.
  const p2 = await as(lead)('POST', '/projects', { name: 'Palletiser', customer: { company: 'Rao Electricals' } });
  await as(emp)('POST', `/projects/${p2.body.project._id}/entries`, { kind: 'issue', title: 'Gripper vacuum low' });
  const seen = await as(emp)('GET', `/projects/search?mode=similar&kind=issue&q=${encodeURIComponent('Robot stops, drive shows E-131 on J3')}`);
  assert.strictEqual(seen.body.hits[0].item._id, solved.body.entry._id);
  assert.ok(!seen.body.hits.some((h) => h.item.title === 'Gripper vacuum low'));
  // Removing equipment keeps the problems logged on it.
  await as(lead)('DELETE', `/projects/${id}/equipment/${q.body.equipment._id}`);
  const full = await as(emp)('GET', `/projects/${id}`);
  assert.strictEqual(full.body.project.equipment.length, 1);
  assert.ok(full.body.entries.some((e) => e.equipmentName === 'Infeed conveyor'));
  assert.deepStrictEqual(codesIn('alarm E 131 and AL-21, fault F0003, J3'), ['e131', 'al21', 'f0003']);
});

test('robots from before the hub, with their software versions', async () => {
  const { lead, emp, as } = await company();
  const p = await as(lead)('POST', '/projects', { name: 'Old cell', status: 'closed', startDate: '2023-01-05', goLiveDate: '2023-04-01', customer: { company: 'Mehta Fabricators' } });
  assert.strictEqual(p.body.project.status, 'closed');
  assert.strictEqual(p.body.project.closedOn, '2023-04-01');
  const id = p.body.project._id;
  const u = await as(lead)('POST', '/units', { model: 'NexR10', serial: 'nx-r10-0001', alreadyBuilt: true, projectId: id, installedOn: '2023-03-20', softwareVersion: '2.1.0' });
  assert.strictEqual(u.status, 201, JSON.stringify(u.body));
  assert.strictEqual(u.body.unit.serial, 'NX-R10-0001');
  assert.strictEqual(u.body.unit.phase, 'installed');
  assert.ok(u.body.unit.stages.every((s) => s.state === 'done'));
  assert.deepStrictEqual(u.body.unit.software, { version: '2.1.0', since: '2023-03-20' });
  assert.strictEqual((await as(lead)('POST', '/units', { model: 'NexR10', serial: 'NX-R10-0001' })).status, 409);
  // A new robot's serial does not clash with one typed in.
  const next = await as(lead)('POST', '/units', { model: 'NexR10' });
  assert.strictEqual(next.status, 201);
  assert.strictEqual(next.body.unit.serial, 'NX-R10-0002');

  // The site engineer updates the software; every version is kept.
  const up = await as(emp)('POST', `/units/${u.body.unit._id}/software`, { version: 'v2.3.1', on: '2024-06-10', note: 'Fix for E131' });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  assert.deepStrictEqual(up.body.unit.softwareHistory.map((h) => h.version), ['2.1.0', '2.3.1']);
  const proj = await as(emp)('GET', `/projects/${id}`);
  assert.strictEqual(proj.body.units[0].software.version, '2.3.1');
  assert.ok(proj.body.project.history.some((h) => /software 2\.1\.0 → 2\.3\.1/.test(h.text)));
  // A robot not on a project is the build team's.
  const free = await as(lead)('POST', '/units', { model: 'NexC5' });
  assert.strictEqual((await as(emp)('POST', `/units/${free.body.unit._id}/software`, { version: '1.0' })).status, 403);
  assert.strictEqual((await as(lead)('PATCH', `/units/${free.body.unit._id}`, { softwareVersion: '3.5.0' })).body.unit.software.version, '3.5.0');
  assert.ok((await as(lead)('GET', '/units?q=3.5.0')).body.units.length === 1);
});

test('import: super user only; checks first, then saves; a second run changes nothing', async () => {
  const { hub, founder, as } = await company(SU);
  const su = { token: (await hub.call('POST', '/auth/login', { email: SU.SUPERUSER_EMAIL, password: SU.SUPERUSER_PASSWORD })).body.token };
  assert.strictEqual((await as(founder)('POST', '/import/people', { rows: [{ name: 'x' }] })).status, 403);
  assert.strictEqual((await as(founder)('GET', '/import/templates')).status, 403);
  assert.ok((await as(su)('GET', '/import/templates')).body.templates.robots.columns.includes('softwareVersion'));
  const imp = (kind, rows, dryRun = false) => as(su)('POST', `/import/${kind}`, { rows, dryRun });

  // People: headers matched loosely; bad rows reported, good rows saved.
  const people = [
    { 'Full name': 'Imran Khan', 'Email address': 'IMRAN@nextup.test', Role: 'employee', Department: 'Production', 'Date of joining': '01/06/2024' },
    { 'Full name': 'Pooja', 'Email address': 'pooja@nextup.test', Role: 'Intern' },
    { 'Full name': 'Ravi again', 'Email address': 'ravi@nextup.test', Role: 'Employee' },
  ];
  const check = await imp('people', people, true);
  assert.deepStrictEqual(check.body.summary, { create: 1, update: 0, skip: 1, error: 1 });
  // The dashboard shows where each header went.
  assert.deepStrictEqual(check.body.columns.find((c) => c.header === 'Department'), { header: 'Department', column: 'team' });
  const { columnFor } = require('../src/importer');
  assert.strictEqual(columnFor('projects', 'Company'), 'client', 'a company in a projects file is the client');
  assert.strictEqual(columnFor('clients', 'Company'), 'name');
  assert.strictEqual(columnFor('people', 'Favourite colour'), null);
  assert.strictEqual((await as(founder)('GET', '/users')).body.users.some((u) => u.email === 'imran@nextup.test'), false, 'a check saves nothing');
  const done = await imp('people', people);
  assert.ok(done.body.results[0].temporaryPassword);
  assert.strictEqual(done.body.results[0].ref, 'Imran Khan');
  const imran = (await as(founder)('GET', '/users')).body.users.find((u) => u.email === 'imran@nextup.test');
  assert.strictEqual(imran.hr.joinedOn, '2024-06-01', 'day first');
  const login = await hub.call('POST', '/auth/login', { email: 'imran@nextup.test', password: done.body.results[0].temporaryPassword });
  assert.strictEqual(login.body.user.mustChangePassword, true);

  // Clients: two rows of one client add two contacts.
  const cl = await imp('clients', [
    { Company: 'Gupta Auto Parts', City: 'Pune', 'Contact person': 'Mr. Gupta', 'Contact phone': '+91 90000 00001' },
    { Company: 'gupta auto parts', 'Contact person': 'Mr. Shah', 'Contact role': 'Maintenance', 'Contact phone': '+91 90000 00002' },
  ]);
  assert.deepStrictEqual(cl.body.summary, { create: 1, update: 1, skip: 0, error: 0 });

  // Projects (with a new client and a team), robots on them, equipment and past problems, in one go each.
  const pr = await imp('projects', [
    { name: 'Spot welding line', client: 'Gupta Auto Parts', status: 'Live', goLiveDate: '12-03-2025', team: 'anil@nextup.test: Lead engineer; ravi@nextup.test' },
    { name: 'Glass handling', client: 'Sharma Glass', status: 'Closed', startDate: '5 Jan 2023', closedOn: '2023-06-30' },
    { name: 'Bad', status: 'Finished' },
  ]);
  assert.deepStrictEqual(pr.body.summary, { create: 2, update: 0, skip: 0, error: 1 }, JSON.stringify(pr.body.results));
  const ref1 = pr.body.results[0].ref;
  const rb = await imp('robots', [
    { 'Serial no': 'NX-R20-0007', Model: 'nexr20', Project: 'Spot welding line', Status: 'Installed', Software: 'v4.0.1' },
    { 'Serial no': 'NX-C5-0042', Model: 'NexC5', Project: 'Glass handling', Status: 'Installed', 'Install date': '2023-06-01', Software: '3.0.0' },
    { Model: 'NexC5', Status: 'In build' },
  ]);
  assert.deepStrictEqual(rb.body.summary, { create: 3, update: 0, skip: 0, error: 0 }, JSON.stringify(rb.body.results));
  const eq = await imp('equipment', [{ project: ref1, kind: 'SPM', name: 'Fixture turntable', make: 'In-house' }, { project: ref1, kind: 'Conveyor', name: 'Outfeed conveyor' }]);
  assert.strictEqual(eq.body.summary.create, 2);
  const pb = await imp('problems', [
    { project: ref1, problem: 'Weld gun tip sticks', 'Error code': 'E-131', robot: 'NX-R20-0007', equipment: 'Fixture turntable', fix: 'Raised the tip-dress frequency to every 40 welds', 'Found date': '20/03/2025', engineer: 'Ravi' },
  ]);
  assert.strictEqual(pb.body.summary.create, 1, JSON.stringify(pb.body.results));

  const c = (await as(founder)('GET', '/clients')).body.clients;
  assert.deepStrictEqual(c.map((x) => x.name).sort(), ['Gupta Auto Parts', 'Sharma Glass']);
  assert.strictEqual(c.find((x) => x.name === 'Gupta Auto Parts').contacts.length, 2);
  const proj = await as(founder)('GET', `/projects/${(await as(founder)('GET', '/projects?status=live')).body.projects[0]._id}`);
  assert.strictEqual(proj.body.project.goLiveDate, '2025-03-12');
  assert.deepStrictEqual(proj.body.project.team.map((m) => [m.name, m.role]), [['Anil', 'Lead engineer'], ['Ravi', '']]);
  assert.strictEqual(proj.body.units[0].phase, 'installed');
  assert.strictEqual(proj.body.units[0].installedOn, '2025-03-12', 'the go-live date when none is given');
  assert.strictEqual(proj.body.units[0].software.version, '4.0.1');
  assert.strictEqual(proj.body.project.equipment.length, 2);
  const issue = proj.body.entries.find((e) => e.kind === 'issue');
  assert.strictEqual(issue.status, 'solved');
  assert.strictEqual(issue.createdBy, 'Ravi');
  assert.strictEqual(issue.equipmentName, 'Fixture turntable');
  assert.ok((await as(founder)('GET', '/projects/search?q=e131')).body.hits.some((h) => h.item._id === issue._id));

  // Running the same files again adds nothing.
  for (const [kind, rows] of [['people', people], ['projects', pr.body.results.length && [{ name: 'Spot welding line', client: 'Gupta Auto Parts' }]], ['robots', [{ serial: 'NX-R20-0007', model: 'NexR20' }]], ['equipment', [{ project: ref1, name: 'Outfeed conveyor' }]],
    ['problems', [{ project: ref1, title: 'Weld gun tip sticks', foundOn: '2025-03-20' }]]]) {
    const again = await imp(kind, rows);
    assert.strictEqual(again.body.summary.create + again.body.summary.update, 0, `${kind}: ${JSON.stringify(again.body.results)}`);
  }
  // A newer software version for a robot already in the hub is recorded.
  const sw = await imp('robots', [{ serial: 'NX-R20-0007', model: 'NexR20', softwareVersion: '4.1.0' }]);
  assert.strictEqual(sw.body.summary.update, 1);
  assert.deepStrictEqual(parseDate('18.11.2026'), '2026-11-18');
  assert.strictEqual(parseDate('31/02/2026'), null);
});

test('projects from an older version get clients when the hub starts', async () => {
  const hub = await startHub();
  const founder = await hub.founder();
  const now = new Date();
  for (const [i, company] of [[1, 'Deccan Motors'], [2, 'deccan motors'], [3, '']]) {
    await hub.db.collection('projects').insertOne({ _id: `old-${i}`, ref: `PRJ-${90 + i}`, name: `Old ${i}`, status: 'live', customer: { company, city: 'Hyderabad', contactName: i === 3 ? '' : 'Rao', contactPhone: '+91 90000 11111' }, team: [], history: [], createdAt: now, updatedAt: now });
  }
  assert.strictEqual(await hub.app.locals.migrate({ log() {} }), undefined);
  const list = (await hub.call('GET', '/clients', null, { token: founder })).body.clients;
  assert.deepStrictEqual(list.map((c) => [c.name, c.counts.projects]), [['Deccan Motors', 2]]);
  assert.deepStrictEqual(list[0].contacts, [{ name: 'Rao', role: 'Site contact', phone: '+91 90000 11111', email: '' }], 'the site contact is kept once');
  assert.strictEqual(await hub.app.locals.migrate({ log() {} }), undefined);
  assert.strictEqual((await hub.call('GET', '/clients', null, { token: founder })).body.clients.length, 1, 'running again changes nothing');
  const p3 = (await hub.call('GET', '/projects/old-3', null, { token: founder })).body.project;
  assert.strictEqual(p3.clientId, null);
  assert.deepStrictEqual(p3.equipment, []);
});
