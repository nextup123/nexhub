'use strict';

// Sample projects for the in-memory hub (SEED=1 node test/serve-fake.js), on top of seedCompany:
// robots from the build list put on projects, teams, site visits and problems with their solutions.
const crypto = require('crypto');
const D = require('../src/dates');
const { projectText, entryText } = require('../src/projects');

async function seedProjects(db) {
  const today = D.todayIn('Asia/Kolkata');
  const day = (n) => D.addDays(today, n);
  const at = (n, h = 6) => new Date(`${day(n)}T${String(h).padStart(2, '0')}:30:00Z`);
  const users = await db.collection('users').find({}).toArray();
  const by = Object.fromEntries(users.map((u) => [u.email.split('@')[0], u]));
  const units = await db.collection('production_units').find({}).toArray();
  const unit = (serial) => units.find((u) => u.serial === serial);
  const member = (h, role) => ({ userId: by[h]._id, name: by[h].name, role });
  let pSeq = 0;
  let iSeq = 0;

  const PROJECTS = [
    {
      name: 'CNC machine tending cell', status: 'live', application: 'Machine tending (2 CNC lathes)', enquiryRef: 'ENQ-3', start: -75, goLive: -20,
      customer: { company: 'Verma CNC Works', city: 'Faridabad', site: 'Plot 12, Sector 24, Faridabad', contactName: 'Rajesh Verma', contactPhone: '+91 98110 22334', contactEmail: 'rajesh@vermacnc.example' },
      description: 'One NexC5 loads and unloads two CNC lathes from a 40-slot tray. Two shifts, 6 days a week.',
      equipment: [['fixture', 'Part tray stacker (40 slots)', 'In-house', ''], ['safety', 'Light curtain, robot side', 'Sick', 'deTec4']],
      tags: ['machine tending', 'cnc', 'ethercat'], team: [member('anil', 'Project lead'), member('arjun', 'Controls / PLC'), member('ravi', 'Site engineer')], units: ['NX-C5-0001'],
      visits: [
        { d: -24, who: ['ravi', 'arjun'], hours: 9, purpose: 'Installation and first power-on', workDone: 'Robot fixed on the base plate, cabinet wired to the CNC interlocks, first motion test.', nextSteps: 'Teach the load points next visit.',
          problems: [
            { title: 'EtherCAT drive J3 drops off the bus after about 40 minutes', codes: ['E131'], component: 'Servo drive J3', category: 'communication', severity: 'high', unit: true, rootCause: 'Cable shield not grounded at the cabinet end, noise from the CNC spindle drive.', solution: 'Grounded the shield at both ends with a 360° clamp. Ran 3 hours without a single drop.', status: 'solved' },
            { title: 'Base plate holes 4 mm off the drawing', category: 'mechanical', severity: 'medium', rootCause: 'Customer drilled from an old drawing revision.', solution: 'Made slotted adapter plate on site; sent rev C of the drawing to the customer.', status: 'solved' },
          ] },
        { d: -21, who: ['ravi'], hours: 8, purpose: 'Teaching and dry runs', workDone: 'Taught 14 points for both lathes, ran 2 hours of dry cycles.',
          problems: [
            { title: 'Vacuum gripper drops blanks at high speed', component: 'Vacuum gripper', category: 'gripper_tooling', severity: 'high', unit: true, rootCause: 'Suction cup cracked and the vacuum hose kinked behind joint 5.', solution: 'Replaced the suction cup with a 2-bellows cup, re-routed the hose with a spring guide. Speed back to 100%.', status: 'solved' },
          ] },
        { d: -19, who: ['arjun'], hours: 6, purpose: 'Interlocks with the CNC', workDone: 'Door, chuck open/close and cycle start handshake tested on both machines.',
          problems: [
            { title: 'Robot enters before the CNC door is fully open', category: 'software', severity: 'critical', unit: true, rootCause: 'Door-open signal comes on at 80% travel on lathe 2.', solution: 'Added a 500 ms wait after door-open in the PLC handshake, and a second sensor on lathe 2 at full open.', status: 'solved' },
          ] },
        { d: -3, who: ['ravi'], hours: 4, purpose: 'Service call: robot stopped on night shift', workDone: 'Read the logs, found an emergency stop from the light curtain at 02:14. Showed the operator how to reset.',
          problems: [
            { title: 'Light curtain trips when the forklift passes', component: 'Light curtain', category: 'safety', severity: 'medium', rootCause: 'Curtain mounted too close to the aisle; forklift mast enters the beam.', solution: '', status: 'workaround', updates: ['Customer asked to mark a no-go line on the floor until we move the curtain.'] },
          ] },
      ],
      notes: ['Customer is happy with output: 420 parts per shift against 380 by hand. Possible second cell in Q2.'],
    },
    {
      name: 'Robotic MIG welding cell', status: 'commissioning', application: 'MIG welding of chassis brackets', enquiryRef: 'ENQ-6', start: -40, goLive: 10,
      customer: { company: 'Mehta Fabricators', city: 'Ludhiana', site: 'Focal Point, Phase 8, Ludhiana', contactName: 'Harpreet Mehta', contactPhone: '+91 98150 77881', contactEmail: '' },
      description: 'NexR20 with a 400 A MIG torch and a two-station turntable.',
      equipment: [['spm', 'Two-station welding turntable', 'In-house', 'TT-2'], ['other', 'MIG power source 400 A', 'Fronius', 'TPS 400i']],
      tags: ['welding', 'mig'], team: [member('neha', 'Project lead'), member('arjun', 'Welding programs'), member('sanjay', 'Mechanical')], units: ['NX-R20-0003'],
      visits: [
        { d: -2, who: ['sanjay', 'arjun'], hours: 10, purpose: 'Installation', workDone: 'Robot and turntable placed, torch and wire feeder fitted, first test welds on scrap.',
          problems: [
            { title: 'Following error on J2 when welding the far seam', codes: ['AL-21'], component: 'Joint 2', category: 'mechanical', severity: 'high', unit: true, rootCause: 'Torch cable pulled tight at full reach and dragged the arm.', solution: 'Re-routed the torch cable through the dress pack and added 300 mm of slack. No following errors in 50 test welds.', status: 'solved' },
            { title: 'Mains voltage dips to 190 V when the press next door starts', category: 'electrical', severity: 'high', rootCause: 'Shared supply with the 200 t press.', solution: 'Online UPS for the controller as a stopgap; customer to run a separate feeder.', status: 'workaround' },
          ] },
        { d: -1, who: ['arjun'], hours: 8, purpose: 'Welding programs', workDone: 'Programs for 3 bracket types, seam tracking set up.',
          problems: [
            { title: 'Weld seam 1.5 mm off on the second station', category: 'process', severity: 'medium', rootCause: '', solution: '', status: 'investigating', updates: ['Fixture clamp on station B looks worn, measuring tomorrow.'] },
          ] },
      ],
      notes: ['Go-live depends on the customer\'s separate power feeder.'],
    },
    {
      name: 'Engine block handling line', status: 'in_progress', application: 'Loading engine blocks on a washing machine', enquiryRef: 'ENQ-8', start: -30, goLive: 45,
      customer: { company: 'Deccan Motors', city: 'Hyderabad', site: 'Patancheru industrial area, Hyderabad', contactName: 'S. Reddy', contactPhone: '+91 99890 11223', contactEmail: 'reddy@deccanmotors.example' },
      description: 'Two NexR20 robots move 38 kg engine blocks from the conveyor to the washer and back.',
      tags: ['handling', 'heavy payload'], team: [member('anil', 'Project lead'), member('pooja', 'Electrical'), member('imran', 'Wiring')], units: ['NX-R20-0001', 'NX-R20-0002'],
      visits: [
        { d: -26, who: ['anil', 'pooja'], hours: 5, purpose: 'Site survey', workDone: 'Measured the floor, conveyor height and washer opening. Took photos of the power panel.',
          problems: [
            { title: 'Floor not level at the robot position (12 mm over 2 m)', category: 'customer_side', severity: 'medium', rootCause: 'Old floor, never levelled.', solution: '', status: 'open' },
          ] },
      ],
      notes: ['Gripper design approved by the customer on ' + day(-12) + '.'],
    },
    {
      name: 'Injection moulding take-out', status: 'in_progress', application: 'Part take-out from a 250 t moulding machine', enquiryRef: 'ENQ-7', start: -20, goLive: 25,
      customer: { company: 'Singh Plastics', city: 'Noida', site: 'Sector 63, Noida', contactName: 'Gurpreet Singh', contactPhone: '+91 98730 55667', contactEmail: '' },
      description: 'NexC5 (blue) takes parts out of the mould and drops them on the conveyor.',
      tags: ['moulding'], team: [member('neha', 'Project lead'), member('kavya', 'Software')], units: ['NX-C5-0002'],
      visits: [
        { d: -14, who: ['kavya'], hours: 4, purpose: 'Signals survey', workDone: 'Listed the Euromap 67 signals on the moulding machine.',
          problems: [
            { title: 'Moulding machine has no Euromap 67 port, only relay contacts', category: 'electrical', severity: 'medium', rootCause: 'Older machine model.', solution: 'Use a relay interface board on the robot side; ordered.', status: 'solved' },
          ] },
      ],
      notes: [],
    },
    {
      name: 'Carton palletising line', status: 'planning', application: 'Palletising cartons, 4 patterns', enquiryRef: 'ENQ-17', start: -5, goLive: 60,
      customer: { company: 'Rao Electricals', city: 'Bengaluru', site: 'Peenya 2nd stage, Bengaluru', contactName: 'Anand Rao', contactPhone: '+91 98450 33445', contactEmail: 'anand@raoelec.example' },
      description: 'NexC5 palletises cartons from the end of the packing line.',
      equipment: [['conveyor', 'Infeed roller conveyor', 'Kiran Conveyors', 'RC-600'], ['conveyor', 'Pallet conveyor', 'Kiran Conveyors', 'PC-1200']],
      tags: ['palletising'], team: [member('rohit', 'Customer contact'), member('kavya', 'Software')], units: ['NX-C5-0004'],
      visits: [], notes: ['Customer will send carton sizes and pallet patterns by next week.'],
    },
  ];

  for (const P of PROJECTS) {
    pSeq += 1;
    const pid = crypto.randomUUID();
    const unitList = P.units.map(unit).filter(Boolean);
    const project = {
      _id: pid, ref: `PRJ-${pSeq}`, name: P.name, status: P.status, customer: P.customer, startDate: day(P.start), goLiveDate: day(P.goLive), closedOn: null,
      description: P.description, application: P.application, scope: '', enquiryRef: P.enquiryRef, tags: P.tags, team: P.team,
      equipment: (P.equipment || []).map(([kind, name, make, model]) => ({ _id: crypto.randomUUID(), kind, name, make, model, serial: '', supplier: make, status: 'installed', installedOn: day(P.start + 20), notes: '', addedBy: P.team[0].name, addedAt: at(P.start + 2) })),
      history: [{ at: at(P.start), by: P.team[0].name, text: 'Project created' }, ...unitList.map((u) => ({ at: at(P.start + 1), by: P.team[0].name, text: `Robot ${u.serial} added` }))],
      createdBy: P.team[0].name, createdAt: at(P.start), updatedAt: at(-1),
    };
    for (const u of unitList) {
      // Robots that have shipped carry the software version they run.
      const sw = u.dispatchedOn || u.installedOn || P.status === 'live' ? { version: P.status === 'live' ? '3.4.2' : '3.5.0', since: u.installedOn || day(P.goLive) } : null;
      u.software = sw;
      await db.collection('production_units').updateOne({ _id: u._id }, { $set: { projectId: pid, software: sw, softwareHistory: sw ? [{ version: P.status === 'live' ? '3.3.0' : sw.version, on: day(P.start + 30), by: P.team[0].name, note: '' }, ...(P.status === 'live' ? [{ version: '3.4.2', on: day(-3), by: 'Ravi Kumar', note: 'Fix for E131 drive drop-outs' }] : [])] : [] } });
    }
    project.searchText = projectText(project, unitList);
    await db.collection('projects').insertOne(project);

    const add = async (doc) => { doc.searchText = entryText(doc, project); await db.collection('project_entries').insertOne(doc); };
    for (const v of P.visits) {
      const vid = crypto.randomUUID();
      const author = by[v.who[0]];
      const problemIds = [];
      for (const pr of v.problems) {
        iSeq += 1;
        const id = crypto.randomUUID();
        problemIds.push(id);
        const u = pr.unit ? unitList[0] : null;
        await add({
          _id: id, projectId: pid, kind: 'issue', ref: `PRB-${iSeq}`, visitId: vid, title: pr.title, description: '', category: pr.category, severity: pr.severity,
          status: pr.status, rootCause: pr.rootCause, solution: pr.solution, unitId: u ? u._id : null, serial: u ? u.serial : '', model: u ? u.model : '', foundOn: day(v.d),
          errorCodes: pr.codes || [], component: pr.component || '', softwareVersion: u?.software?.version || '',
          solvedOn: pr.status === 'solved' ? day(v.d) : null, solvedBy: pr.status === 'solved' ? author.name : null,
          updates: [...(pr.status === 'solved' ? [{ at: at(v.d, 11), by: author.name, text: 'Marked solved', status: 'solved' }] : []), ...(pr.updates || []).map((t) => ({ at: at(v.d, 12), by: author.name, text: t }))],
          createdBy: author.name, createdById: author._id, createdAt: at(v.d, 10), updatedAt: at(v.d, 12),
        });
      }
      await add({
        _id: vid, projectId: pid, kind: 'visit', date: day(v.d), endDate: null, engineers: v.who.map((h) => ({ userId: by[h]._id, name: by[h].name })),
        purpose: v.purpose, workDone: v.workDone, nextSteps: v.nextSteps || '', hours: v.hours, problemIds, updates: [],
        createdBy: author.name, createdById: author._id, createdAt: at(v.d, 13), updatedAt: at(v.d, 13),
      });
    }
    for (const [i, text] of P.notes.entries()) {
      const author = by[P.team[0].name.split(' ')[0].toLowerCase()] || by.anil;
      await add({ _id: crypto.randomUUID(), projectId: pid, kind: 'note', title: '', text, updates: [], createdBy: author.name, createdById: author._id, createdAt: at(-1 - i, 9), updatedAt: at(-1 - i, 9) });
    }
  }
  // A finished project from before the hub, for the same client as the first: a robot with its own serial and old software.
  {
    pSeq += 1; iSeq += 1;
    const pid = crypto.randomUUID();
    const { ROBOT_STAGES } = require('../src/production');
    const robot = {
      _id: crypto.randomUUID(), serial: 'NX-C5-0101', model: 'NexC5', colour: 'White', customer: { company: 'Verma CNC Works', city: 'Faridabad' }, enquiryRef: '', orderedOn: null, targetDate: null,
      dispatchedOn: '2024-02-10', installedOn: '2024-02-16', priority: 'normal', onHold: false, holdReason: '', description: '', projectId: pid,
      software: { version: '2.9.1', since: '2024-02-16' }, softwareHistory: [{ version: '2.9.1', on: '2024-02-16', by: 'Anil Yadav', note: 'Recorded when the robot was added' }],
      stages: ROBOT_STAGES.map(([key, label, area]) => ({ key, label, area, state: 'done', assigneeId: null, assignee: null, startedAt: null, doneAt: new Date('2024-02-01T12:00:00Z'), doneBy: 'Before the hub', note: '' })),
      notes: [], history: [{ at: at(-200), by: 'Anil Yadav', text: 'Added as a robot built before the hub' }], createdBy: 'Anil Yadav', createdAt: at(-200), updatedAt: at(-200),
    };
    await db.collection('production_units').insertOne(robot);
    const project = {
      _id: pid, ref: `PRJ-${pSeq}`, name: 'Bar feeding for the old lathe', status: 'closed', customer: { company: 'Verma CNC Works', city: 'Faridabad', site: 'Plot 12, Sector 24, Faridabad', contactName: 'Rajesh Verma', contactPhone: '+91 98110 22334', contactEmail: '' },
      startDate: '2023-11-20', goLiveDate: '2024-02-16', closedOn: '2024-03-01', description: 'First Nextup robot at Verma: a NexC5 feeding bar stock to the old lathe.', application: 'Bar feeding', scope: '', enquiryRef: '', tags: ['cnc'],
      team: [member('anil', 'Project lead')], equipment: [], history: [{ at: at(-200), by: 'Anil Yadav', text: 'Project created' }], createdBy: 'Anil Yadav', createdAt: at(-200), updatedAt: at(-150),
    };
    project.searchText = projectText(project, [robot]);
    await db.collection('projects').insertOne(project);
    const doc = {
      _id: crypto.randomUUID(), projectId: pid, kind: 'issue', ref: `PRB-${iSeq}`, title: 'Robot stops with E131 during the bar push', description: 'Drive alarm E-131 on J3, only when the lathe spindle is running.', category: 'communication', severity: 'high',
      status: 'solved', rootCause: 'Drive cable run next to the spindle motor cable.', solution: 'Moved the drive cable to its own tray, 300 mm from the motor cable, and fitted ferrites on both ends.', unitId: robot._id, serial: robot.serial, model: 'NexC5',
      errorCodes: ['E131'], component: 'Servo drive J3', softwareVersion: '2.9.1', foundOn: '2024-02-20', solvedOn: '2024-02-21', solvedBy: 'Anil Yadav', updates: [], createdBy: 'Anil Yadav', createdById: by.anil._id, createdAt: at(-190), updatedAt: at(-189),
    };
    doc.searchText = entryText(doc, project);
    await db.collection('project_entries').insertOne(doc);
  }
  await db.collection('counters').updateOne({ _id: 'project' }, { $set: { seq: pSeq } }, { upsert: true });
  await db.collection('counters').updateOne({ _id: 'project-issue' }, { $set: { seq: iSeq } }, { upsert: true });
}

module.exports = { seedProjects };
