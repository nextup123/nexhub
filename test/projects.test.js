'use strict';

// Projects: robots on a project, team, problems and solutions, site visits, search, and who sees what.
const test = require('node:test');
const assert = require('node:assert');
const { startHub, stopAll } = require('./helpers');

test.after(stopAll);

async function company() {
  const hub = await startHub();
  const founder = { token: await hub.founder() };
  const hr = await hub.person(founder.token, { name: 'Meena', email: 'meena@nextup.test', role: 'hr', team: 'People' });
  const lead = await hub.person(founder.token, { name: 'Anil', email: 'anil@nextup.test', role: 'lead', team: 'Production' });
  const emp = await hub.person(founder.token, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee', team: 'Production' });
  const other = await hub.person(founder.token, { name: 'Sara', email: 'sara@nextup.test', role: 'employee', team: 'Software' });
  const as = (who) => (method, path, body) => hub.call(method, path, body, { token: who.token });
  return { hub, founder, hr, lead, emp, other, as };
}

const CUSTOMER = { company: 'Verma CNC Works', city: 'Faridabad', site: 'Plot 12, Sector 24', contactName: 'Mr. Verma', contactPhone: '+91 98100 00000', contactEmail: 'ops@verma.example' };

test('projects: create, team, robots, and who sees the customer contact', async () => {
  const { lead, emp, other, hr, as } = await company();
  assert.strictEqual((await as(emp)('POST', '/projects', { name: 'X' })).status, 403, 'employees do not create projects');
  assert.strictEqual((await as(hr)('GET', '/projects')).status, 200, 'HR sees projects like a founder');

  const p = await as(lead)('POST', '/projects', { name: 'CNC machine tending', customer: CUSTOMER, application: 'Machine tending', team: [{ userId: emp.user._id, role: 'Site engineer' }] });
  assert.strictEqual(p.status, 201);
  assert.match(p.body.project.ref, /^PRJ-\d+$/);
  assert.strictEqual(p.body.project.team[0].name, 'Ravi');
  const id = p.body.project._id;

  // A robot from the build list goes onto the project, and only onto one.
  const u = await as(lead)('POST', '/units', { model: 'NexC5', customer: { company: 'Verma CNC Works' } });
  assert.strictEqual((await as(lead)('PUT', `/projects/${id}/units/${u.body.unit._id}`)).status, 200);
  const p2 = await as(lead)('POST', '/projects', { name: 'Second line' });
  const clash = await as(lead)('PUT', `/projects/${p2.body.project._id}/units/${u.body.unit._id}`);
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.error, /already on PRJ-/);
  assert.strictEqual((await as(emp)('PUT', `/projects/${id}/units/${u.body.unit._id}`)).status, 403);
  const unit = await as(emp)('GET', `/units/${u.body.unit._id}`);
  assert.strictEqual(unit.body.unit.project.ref, p.body.project.ref, 'the robot shows its project');

  // The team sees the site contact; someone not on the team does not.
  const mine = await as(emp)('GET', `/projects/${id}`);
  assert.strictEqual(mine.body.project.customer.contactPhone, CUSTOMER.contactPhone);
  assert.strictEqual(mine.body.units.length, 1);
  assert.strictEqual(mine.body.units[0].phase, 'planned');
  const notMine = await as(other)('GET', `/projects/${id}`);
  assert.strictEqual(notMine.status, 200, 'every engineer can read every project');
  assert.strictEqual(notMine.body.project.customer.contactPhone, undefined);
  assert.strictEqual(notMine.body.project.customer.company, 'Verma CNC Works');

  // Changing the team keeps the history.
  const ch = await as(lead)('PATCH', `/projects/${id}`, { status: 'commissioning', team: [{ userId: other.user._id, role: 'PLC' }] });
  assert.strictEqual(ch.body.project.status, 'commissioning');
  const full = await as(lead)('GET', `/projects/${id}`);
  assert.ok(full.body.project.history.some((h) => /Joined the team: Sara/.test(h.text) && /Left the team: Ravi/.test(h.text)));
  // Saving other fields without contact details does not wipe them.
  await as(lead)('PATCH', `/projects/${id}`, { customer: { company: 'Verma CNC Works', city: 'Faridabad' } });
  assert.strictEqual((await as(lead)('GET', `/projects/${id}`)).body.project.customer.contactPhone, CUSTOMER.contactPhone);

  const list = await as(other)('GET', '/projects?mine=true');
  assert.strictEqual(list.body.projects.length, 1);
  assert.strictEqual(list.body.projects[0].counts.robots, 1);
});

test('projects: a site visit logs the day\'s problems and how they were solved', async () => {
  const { lead, emp, other, as } = await company();
  const p = await as(lead)('POST', '/projects', { name: 'Press tending', customer: { company: 'Singh Plastics', city: 'Noida' }, team: [{ userId: emp.user._id }] });
  const id = p.body.project._id;
  const u = await as(lead)('POST', '/units', { model: 'NexR10' });
  await as(lead)('PUT', `/projects/${id}/units/${u.body.unit._id}`);

  const v = await as(emp)('POST', `/projects/${id}/entries`, {
    kind: 'visit', date: '2026-11-17', engineers: [emp.user._id, other.user._id], hours: 7.5,
    purpose: 'Commissioning, day 2', workDone: 'Taught 14 points, ran 2 hours dry cycle.', nextSteps: 'Interlock wiring with their electrician',
    problems: [
      { title: 'EtherCAT drive J3 drops off after 40 minutes', category: 'communication', severity: 'high', unitId: u.body.unit._id,
        rootCause: 'Cable shield not grounded at the cabinet', solution: 'Grounded the shield at both ends, ran 3 hours without a drop', status: 'solved' },
      { title: 'Gripper misses parts near the edge of the tray', category: 'gripper_tooling', status: 'open' },
    ],
  });
  assert.strictEqual(v.status, 201, JSON.stringify(v.body));
  assert.strictEqual(v.body.entry.kind, 'visit');
  assert.deepStrictEqual(v.body.entry.engineers.map((e) => e.name), ['Ravi', 'Sara']);
  assert.strictEqual(v.body.problems.length, 2);
  const [solved, open] = v.body.problems;
  assert.match(solved.ref, /^PRB-\d+$/);
  assert.strictEqual(solved.status, 'solved');
  assert.strictEqual(solved.serial, u.body.unit.serial);
  assert.strictEqual(solved.foundOn, '2026-11-17', 'a visit\'s problem is dated on the visit');
  assert.strictEqual(solved.visitId, v.body.entry._id);
  assert.strictEqual(open.status, 'open');

  // Anyone may write the solution of a problem; only the author or a lead may change the rest.
  assert.strictEqual((await as(other)('PATCH', `/project-entries/${open._id}`, { title: 'changed' })).status, 403);
  await as(other)('POST', `/project-entries/${open._id}/updates`, { text: 'Tray is warped by 2 mm on one side' });
  const fix = await as(other)('PATCH', `/project-entries/${open._id}`, { status: 'solved', rootCause: 'Warped tray', solution: 'Added a vision offset for the edge row' });
  assert.strictEqual(fix.status, 200);
  assert.strictEqual(fix.body.entry.solvedBy, 'Sara');
  assert.ok(fix.body.entry.updates.some((x) => x.text === 'Marked solved'));

  // A problem on a robot that is not on this project is refused.
  const stray = await as(lead)('POST', '/units', { model: 'NexR20' });
  assert.strictEqual((await as(emp)('POST', `/projects/${id}/entries`, { kind: 'issue', title: 'x', unitId: stray.body.unit._id })).status, 400);

  const full = await as(emp)('GET', `/projects/${id}`);
  assert.strictEqual(full.body.counts.visits, 1);
  assert.strictEqual(full.body.counts.issues, 2);
  assert.strictEqual(full.body.counts.openIssues, 0);

  // Site visits show on the calendar for people who see projects.
  const cal = await as(emp)('GET', '/calendar?from=2026-11-01&to=2026-11-30');
  assert.ok(cal.body.items.some((i) => i.type === 'visit' && i.date === '2026-11-17'));
});

test('projects: search finds problems, solutions and visits across projects', async () => {
  const { lead, emp, hr, as } = await company();
  const a = await as(lead)('POST', '/projects', { name: 'Welding cell', customer: { company: 'Mehta Fabricators', city: 'Ludhiana' } });
  const b = await as(lead)('POST', '/projects', { name: 'Palletising line', customer: { company: 'Rao Electricals', city: 'Bengaluru' } });
  await as(emp)('POST', `/projects/${a.body.project._id}/entries`, { kind: 'issue', title: 'Robot stops with following error on J2', description: 'Happens when the torch cable is pulled tight', solution: 'Re-routed the torch cable through the dress pack', status: 'solved', category: 'mechanical' });
  await as(emp)('POST', `/projects/${b.body.project._id}/entries`, { kind: 'issue', title: 'Following error on J2 at full speed', category: 'software' });
  await as(emp)('POST', `/projects/${b.body.project._id}/entries`, { kind: 'visit', date: '2026-11-10', workDone: 'Checked J2 gearbox backlash, within spec' });
  await as(emp)('POST', `/projects/${b.body.project._id}/entries`, { kind: 'note', text: 'Customer wants a second shift from January' });

  const r = await as(emp)('GET', '/projects/search?q=following%20error%20J2');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.hits.length, 2, 'every word must match');
  assert.strictEqual(r.body.hits[0].item.status, 'solved', 'solved problems come first: they hold the answer');
  assert.strictEqual(r.body.hits[0].project.name, 'Welding cell');

  // Words from the solution, the project and the customer all count.
  assert.strictEqual((await as(emp)('GET', '/projects/search?q=dress%20pack')).body.hits.length, 1);
  const byCustomer = await as(emp)('GET', '/projects/search?q=rao%20j2');
  assert.deepStrictEqual(byCustomer.body.hits.map((h) => h.type).sort(), ['issue', 'visit']);
  assert.strictEqual((await as(emp)('GET', '/projects/search?q=ludhiana')).body.hits[0].type, 'project');
  // Filters: only open problems.
  const open = await as(emp)('GET', '/projects/search?q=j2&status=open');
  assert.deepStrictEqual(open.body.hits.map((h) => h.item.title), ['Following error on J2 at full speed']);
  // A regular-expression character is just a character.
  assert.strictEqual((await as(emp)('GET', '/projects/search?q=(j2')).status, 200);
  assert.strictEqual((await as(emp)('GET', '/projects/search?q=')).status, 400);
  assert.strictEqual((await as(hr)('GET', '/projects/search?q=j2')).status, 200);

  // Renaming a project keeps its record findable under the new name.
  await as(lead)('PATCH', `/projects/${b.body.project._id}`, { name: 'Bag palletiser' });
  assert.strictEqual((await as(emp)('GET', '/projects/search?q=palletiser%20second%20shift')).body.hits.length, 1);
});

test('projects: deleting', async () => {
  const { founder, lead, emp, as } = await company();
  const p = await as(lead)('POST', '/projects', { name: 'Trial' });
  const id = p.body.project._id;
  const u = await as(lead)('POST', '/units', { model: 'NexC5' });
  await as(lead)('PUT', `/projects/${id}/units/${u.body.unit._id}`);
  const n = await as(emp)('POST', `/projects/${id}/entries`, { kind: 'note', text: 'hello' });
  assert.strictEqual((await as(lead)('DELETE', `/project-entries/${n.body.entry._id}`)).status, 200, 'a lead may delete any entry');
  assert.strictEqual((await as(lead)('DELETE', `/projects/${id}`)).status, 403, 'only founders delete projects');
  assert.strictEqual((await as(founder)('DELETE', `/projects/${id}`)).status, 200);
  const unit = await as(lead)('GET', `/units/${u.body.unit._id}`);
  assert.strictEqual(unit.status, 200, 'the robot stays in the build list');
  assert.strictEqual(unit.body.unit.projectId, null);
});
