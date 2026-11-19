'use strict';

// Sample company for trying the dashboard on the in-memory hub (SEED=1 node test/serve-fake.js).
// Made-up people, robots and bugs. Everyone's password is `nextup-demo`.
const crypto = require('crypto');
const { hashPassword } = require('../src/auth');
const D = require('../src/dates');
const { ROBOT_STAGES } = require('../src/production');

const TZ = 'Asia/Kolkata';
const PASSWORD = 'nextup-demo';
const PEOPLE = [
  ['Dhirendra', 'founder', 'Management', 'Founder and CEO', 'dhirendra'],
  ['Meena Kapoor', 'hr', 'People', 'HR Manager', 'meena'],
  ['Anil Yadav', 'lead', 'Production', 'Production Lead', 'anil'],
  ['Ravi Kumar', 'employee', 'Production', 'Assembly Technician', 'ravi'],
  ['Sanjay Verma', 'employee', 'Production', 'Assembly Technician', 'sanjay'],
  ['Pooja Sharma', 'employee', 'Production', 'Electrical Technician', 'pooja'],
  ['Imran Khan', 'employee', 'Production', 'Wiring Technician', 'imran'],
  ['Neha Gupta', 'lead', 'Software', 'Software Lead', 'neha'],
  ['Arjun Mehta', 'employee', 'Software', 'Controls Engineer', 'arjun'],
  ['Kavya Iyer', 'employee', 'Software', 'Software Engineer', 'kavya'],
  ['Rohit Singh', 'lead', 'Sales', 'Sales Lead', 'rohit'],
  ['Deepak Joshi', 'employee', 'Quality', 'QA Engineer', 'deepak'],
];

async function seedCompany(db) {
  const now = new Date();
  const today = D.todayIn(TZ);
  const hash = hashPassword(PASSWORD);
  const users = PEOPLE.map(([name, role, team, title, handle], i) => ({
    _id: crypto.randomUUID(), name, email: `${handle}@nextup.demo`, phone: `+91 98${String(11000000 + i * 1234567).slice(0, 3)} ${String(40000 + i * 4321).slice(0, 5)}`,
    role, team, title, active: true, passwordHash: hash, mustChangePassword: false,
    hr: { employeeId: `NX-${String(i + 1).padStart(3, '0')}`, joinedOn: D.addDays(today, -(900 - i * 60)), emergencyContact: '', birthday: null, address: '' },
    createdAt: now, updatedAt: now,
  }));
  for (const u of users) await db.collection('users').insertOne(u);
  const by = Object.fromEntries(users.map((u) => [u.email.split('@')[0], u]));

  // Holidays (sample list).
  const y = today.slice(0, 4);
  const hol = [[`${y}-01-26`, 'Republic Day', 'national'], [`${y}-03-04`, 'Holi', 'festival'], [`${y}-08-15`, 'Independence Day', 'national'], [`${y}-10-02`, 'Gandhi Jayanti', 'national'],
    [`${y}-10-20`, 'Dussehra', 'festival'], [`${y}-11-09`, 'Diwali (Govardhan Puja)', 'festival'], [`${y}-11-24`, 'Guru Nanak Jayanti', 'optional'], [`${y}-12-25`, 'Christmas', 'festival']];
  for (const [date, name, kind] of hol) await db.collection('holidays').insertOne({ _id: crypto.randomUUID(), date, name, kind, createdBy: 'Meena Kapoor', createdAt: now });
  const holSet = new Set(hol.filter((h) => h[2] !== 'optional').map((h) => h[0]));

  // Leave: some approved, some waiting.
  const leaves = [
    ['ravi', 'casual', D.addDays(today, -6), D.addDays(today, -5), 'approved', 'Family function'],
    ['kavya', 'sick', today, today, 'approved', 'Fever'],
    ['sanjay', 'earned', D.addDays(today, 6), D.addDays(today, 10), 'pending', 'Going home to Varanasi'],
    ['imran', 'casual', D.addDays(today, 3), D.addDays(today, 3), 'pending', 'Bank work'],
    ['arjun', 'casual', D.addDays(today, 9), D.addDays(today, 9), 'pending', 'Exam'],
    ['deepak', 'casual', D.addDays(today, 1), D.addDays(today, 2), 'approved', 'Wedding'],
  ];
  for (const [h, type, from, to, status, reason] of leaves) {
    const days = D.eachDay(from, to).filter((d) => D.weekday(d) !== 0 && !holSet.has(d)).length;
    await db.collection('leave_requests').insertOne({ _id: crypto.randomUUID(), userId: by[h]._id, type, from, to, halfDay: false, days, reason, status, decidedBy: status === 'approved' ? 'Meena Kapoor' : null, decidedAt: status === 'approved' ? now : null, comment: '', createdAt: new Date(now - 4 * 864e5), updatedAt: now });
  }
  const onLeave = (u, d) => leaves.some(([h, , from, to, status]) => by[h]._id === u._id && status === 'approved' && from <= d && to >= d);

  // Attendance for this month up to yesterday, and this morning for most people.
  const at = (date, hhmm) => new Date(new Date(`${date}T${hhmm}:00Z`).getTime() - 330 * 60000);
  const monthStart = `${today.slice(0, 7)}-01`;
  let n = 0;
  for (const date of D.eachDay(monthStart, today)) {
    if (D.weekday(date) === 0 || holSet.has(date)) continue;
    for (const u of users) {
      n += 1;
      if (onLeave(u, date)) continue;
      if (n % 37 === 0 && date !== today) continue; // the odd absence
      if (date === today && ['sanjay', 'kavya', 'rohit'].includes(u.email.split('@')[0])) continue; // not in yet
      const lateMin = n % 9 === 0 ? 35 : n % 5;
      const inT = `09:${String(20 + lateMin).padStart(2, '0')}`.replace(/:(\d)(\d)$/, (m) => m);
      const inMin = 9 * 60 + 20 + lateMin;
      const ci = `${String(Math.floor(inMin / 60)).padStart(2, '0')}:${String(inMin % 60).padStart(2, '0')}`;
      const co = n % 11 === 0 ? '13:40' : `18:${String(5 + (n % 40)).padStart(2, '0')}`;
      const checkIn = at(date, ci);
      const checkOut = date === today ? null : at(date, co);
      const hours = checkOut ? Math.round(((checkOut - checkIn) / 3600000) * 100) / 100 : null;
      await db.collection('attendance').insertOne({
        _id: `${u._id}:${date}`, userId: u._id, date, checkIn, checkOut, hours, mode: u.team === 'Software' && n % 4 === 0 ? 'wfh' : u.team === 'Sales' && n % 3 === 0 ? 'site' : 'office',
        status: hours !== null && hours < 4.5 ? 'half_day' : 'present', late: inMin > 9 * 60 + 45, note: '', source: 'self', updatedAt: now,
      });
      void inT;
    }
  }

  // Events.
  const ev = [[D.addDays(today, 1), 'Demo: NexC5 machine tending for Verma CNC', 'demo', '11:00', 'Ghaziabad shop floor'], [D.addDays(today, 2), 'Weekly production review', 'meeting', '10:00', 'Meeting room'],
    [D.addDays(today, 7), 'Safety training (all production staff)', 'training', '15:00', 'Shop floor'], [D.addDays(today, 4), 'Customer visit: Deccan Motors', 'visit', '14:30', ''], [D.addDays(today, 9), 'Weekly production review', 'meeting', '10:00', 'Meeting room']];
  for (const [date, title, kind, time, location] of ev) await db.collection('events').insertOne({ _id: crypto.randomUUID(), title, date, endDate: null, time, kind, location, description: '', createdBy: 'Anil Yadav', createdById: by.anil._id, createdAt: now });

  // Robots in the build.
  const techs = [by.ravi, by.sanjay, by.pooja, by.imran, by.arjun, by.deepak];
  const areaTech = { Purchase: by.anil, Mechanical: by.ravi, Electrical: by.imran, Software: by.arjun, Quality: by.deepak, Logistics: by.sanjay };
  const plan = [
    ['NexR20', 'Deccan Motors', 'Hyderabad', 10, 3, 'ENQ-8', 'high'], ['NexR20', 'Deccan Motors', 'Hyderabad', 10, 1, 'ENQ-8', 'high'],
    ['NexC5', 'Verma CNC Works', 'Faridabad', 10, 10, 'ENQ-3', 'normal'], ['NexC5', 'Singh Plastics', 'Noida', 10, 6, 'ENQ-7', 'normal'],
    ['NexR10', 'Kerala Precision Castings', 'Kochi', 10, 4, 'ENQ-2', 'normal'], ['NexR10', 'Irfan Powder Coaters', 'Ghaziabad', 10, 8, 'ENQ-5', 'urgent'],
    ['NexC5', 'Chennai Auto Stampings', 'Chennai', 10, 0, 'ENQ-10', 'normal'], ['NexR20', 'Mehta Fabricators', 'Ludhiana', 10, 10, 'ENQ-6', 'normal'],
    ['NexC5', 'Rao Electricals', 'Bengaluru', 10, 9, 'ENQ-17', 'normal'],
  ];
  const seq = {};
  for (const [i, [model, company, city, , doneCount, enq, priority]] of plan.entries()) {
    const prefix = { NexC5: 'C5', NexR10: 'R10', NexR20: 'R20' }[model];
    seq[prefix] = (seq[prefix] || 0) + 1;
    const ordered = D.addDays(today, -(40 - i * 3));
    const target = D.addDays(today, i === 4 ? -2 : 6 + i * 4);
    const stages = ROBOT_STAGES.map(([key, label, area], j) => {
      const state = j < doneCount ? 'done' : j === doneCount ? (i === 1 ? 'blocked' : 'in_progress') : 'pending';
      const who = areaTech[area] || techs[j % techs.length];
      return { key, label, area, state, assigneeId: who._id, assignee: who.name, startedAt: state !== 'pending' ? new Date(now - (12 - j) * 864e5) : null, doneAt: state === 'done' ? new Date(now - (10 - j) * 864e5) : null, doneBy: state === 'done' ? who.name : null, note: state === 'blocked' ? 'J3 gearbox delayed by the supplier, expected Friday' : '' };
    });
    if (doneCount === 0) stages.forEach((s) => { s.state = 'pending'; s.startedAt = null; });
    const history = stages.filter((s) => s.doneAt).map((s) => ({ at: s.doneAt, by: s.doneBy, text: `${s.label}: done` }));
    await db.collection('production_units').insertOne({
      _id: crypto.randomUUID(), serial: `NX-${prefix}-${String(seq[prefix]).padStart(4, '0')}`, model, colour: model === 'NexC5' ? (i % 2 ? 'Blue' : 'White') : '',
      customer: { company, city }, enquiryRef: enq, orderedOn: ordered, targetDate: target,
      dispatchedOn: i === 7 ? D.addDays(today, -3) : null, installedOn: null, priority, onHold: false, holdReason: '', description: '',
      stages, notes: i === 1 ? [{ id: crypto.randomUUID(), author: 'Anil Yadav', text: 'Called the supplier, the gearbox ships Thursday.', at: new Date(now - 864e5) }] : [],
      history: [{ at: new Date(`${ordered}T05:00:00Z`), by: 'Anil Yadav', text: 'Unit added' }, ...history], createdBy: 'Anil Yadav', createdAt: new Date(now - (40 - i * 3) * 864e5), updatedAt: now,
    });
  }
  for (const [p, n2] of Object.entries(seq)) await db.collection('counters').updateOne({ _id: `unit:${p}` }, { $set: { seq: n2 } }, { upsert: true });

  // A few bug reports from the machines.
  const bugs = [
    ['ethercat_config_tool', 'ECT', 'Homing stops at step 4 on J3', 'high', 'in_progress', 'drive_communication', 'Acme Automation'],
    ['ethercat_config_tool', 'ECT', 'Drive list empty after reconnecting the cable', 'critical', 'new', 'drive_communication', 'Sharma Auto Components'],
    ['ethercat_config_tool', 'ECT', 'Recipe names cut off on the Recipes page', 'low', 'triaged', 'screen_problem', 'Verma CNC Works'],
    ['main_app', 'MAIN', 'Login screen freezes after 10 minutes idle', 'medium', 'new', 'crash', 'Singh Plastics'],
    ['main_app', 'MAIN', 'Pallet pattern preview shows wrong layer count', 'medium', 'fixed', 'wrong_result', 'Deccan Motors'],
    ['ethercat_config_tool', 'ECT', 'Update stuck at "build" step', 'high', 'need_info', 'update', 'Mehta Fabricators'],
  ];
  const bseq = {};
  for (const [i, [appId, prefix, title, severity, status, category, company]] of bugs.entries()) {
    bseq[appId] = (bseq[appId] || 0) + 1;
    const created = new Date(now - (i * 2 + 1) * 864e5);
    await db.collection('bug_reports').insertOne({
      appId, seq: bseq[appId], number: `${prefix}-${bseq[appId]}`, clientReportId: null, appVersion: '3.5.0', title, description: `${title}. Seen on the customer's cell; happens after a restart.`, stepsToReproduce: '1. Power on the cell\n2. Open the page\n3. Run the sequence',
      expected: '', actual: '', category, severity, frequency: i % 2 ? 'sometimes' : 'always', area: '', reporter: { name: 'Operator', company, phone: '+91 90000 0000' + i, email: '' },
      machine: { machineId: null, name: `${company.split(' ')[0]} cell 1`, site: company, hostname: '', os: 'Ubuntu 22.04' }, context: {}, attachments: [], reportedAt: created,
      status, priority: severity === 'critical' ? 'critical' : null, assignee: status === 'in_progress' ? 'Arjun Mehta' : null, labels: [], duplicateOf: null, fixedInVersion: status === 'fixed' ? '3.5.1' : null,
      comments: i === 0 ? [{ author: 'Arjun Mehta', text: 'Reproduced on the bench with an SV660N. Looking at the timeout.', internal: true, at: new Date(now - 864e5) }] : [],
      statusHistory: [{ status: 'new', by: 'Operator', at: created, note: '' }], submittedBy: 'Operator', createdAt: created, updatedAt: created,
    });
  }
  for (const [appId, s] of Object.entries(bseq)) await db.collection('counters').updateOne({ _id: `bug:${appId}` }, { $set: { seq: s } }, { upsert: true });
}

module.exports = { seedCompany, PASSWORD };
