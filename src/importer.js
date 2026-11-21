'use strict';

/**
 * Bulk import from spreadsheets, for the super user (permission data.import).
 *
 *   GET  /import/templates                    the columns of each kind, with an example row
 *   POST /import/:kind  { rows: [{…}], dryRun }   kind: people | clients | projects | robots | equipment | problems
 *
 * Rows are objects keyed by column name; headers are matched loosely ("Email address", "E-mail" →
 * email). Each row is checked and saved on its own, in order, so a later row can use a client or a
 * project made by an earlier one. dryRun checks everything and saves nothing. Rows that already exist
 * are left alone (people, equipment, problems) or filled in (clients, projects, robots: empty fields
 * are never written over existing values).
 *
 * Dates: 2026-11-18, 18-11-2026, 18/11/2026 or 18.11.2026 (day first), or 18 Nov 2026.
 */

const crypto = require('crypto');
const express = require('express');
const { ROLES } = require('./permissions');
const { hashPassword, normaliseUser, passwordProblem } = require('./auth');
const { MODELS } = require('./production');
const { PROJECT_STATUSES, ISSUE_STATUSES, ISSUE_SEVERITIES, ISSUE_CATEGORIES, EQUIPMENT_KINDS } = require('./projects');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nameKey = (s) => str(s, 160).toLowerCase().replace(/\s+/g, ' ');
const MAX_ROWS = 3000;

const TEMPLATES = {
  people: {
    columns: ['name', 'email', 'role', 'team', 'title', 'phone', 'employeeId', 'joinedOn', 'birthday'],
    required: ['name', 'email', 'role'],
    example: { name: 'Ravi Kumar', email: 'ravi@nextuprobotics.com', role: 'Employee', team: 'Production', title: 'Assembly technician', phone: '+91 98100 00000', employeeId: 'NX-014', joinedOn: '2024-06-01', birthday: '' },
    help: 'Role: Founder, HR, Lead or Employee. Everyone gets a temporary password, shown once after the import; they choose their own at first sign-in. People already in the hub (same email) are skipped.',
  },
  clients: {
    columns: ['name', 'industry', 'city', 'address', 'gstin', 'website', 'contactName', 'contactRole', 'contactPhone', 'contactEmail', 'notes'],
    required: ['name'],
    example: { name: 'Verma CNC Works', industry: 'CNC machining', city: 'Faridabad', address: 'Plot 12, Sector 24', gstin: '', website: '', contactName: 'Mr. Verma', contactRole: 'Owner', contactPhone: '+91 98100 00000', contactEmail: 'ops@verma.example', notes: '' },
    help: 'One row per client, or several rows with the same name to add more contacts. An existing client (same name) gets the empty fields filled in and the new contacts added.',
  },
  projects: {
    columns: ['ref', 'name', 'client', 'status', 'application', 'city', 'site', 'startDate', 'goLiveDate', 'closedOn', 'description', 'team', 'siteContactName', 'siteContactPhone', 'siteContactEmail', 'tags'],
    required: ['name'],
    example: { ref: '', name: 'CNC machine tending cell', client: 'Verma CNC Works', status: 'Live', application: 'Machine tending', city: 'Faridabad', site: 'Plot 12, Sector 24', startDate: '2025-01-10', goLiveDate: '2025-03-02', closedOn: '', description: '2 lathes, 1 NexC5', team: 'ravi@nextuprobotics.com: Site engineer; anil@nextuprobotics.com', siteContactName: 'Mr. Verma', siteContactPhone: '+91 98100 00000', siteContactEmail: '', tags: 'machine tending, ethercat' },
    help: 'Status: Planning, In progress, Commissioning, Live, On hold or Closed. A client that does not exist yet is made. Team: emails separated by ; with an optional role after a colon. A project with the same ref, or the same name for the same client, is filled in, not doubled.',
  },
  robots: {
    columns: ['serial', 'model', 'client', 'project', 'status', 'colour', 'dispatchedOn', 'installedOn', 'softwareVersion', 'notes'],
    required: ['model'],
    example: { serial: 'NX-C5-0001', model: 'NexC5', client: 'Verma CNC Works', project: 'CNC machine tending cell', status: 'Installed', colour: 'White', dispatchedOn: '2025-02-20', installedOn: '2025-02-25', softwareVersion: '3.4.2', notes: '' },
    help: 'Model: NexC5, NexR10, NexR20 or Custom. Status: Installed, Dispatched or Built (all build stages done), or In build / Planned. Project: its ref (PRJ-3) or its name. A robot with the same serial gets its dates, project and software version updated.',
  },
  equipment: {
    columns: ['project', 'kind', 'name', 'make', 'model', 'serial', 'supplier', 'installedOn', 'notes'],
    required: ['project', 'name'],
    example: { project: 'PRJ-1', kind: 'Conveyor', name: 'Infeed conveyor', make: 'Kiran Conveyors', model: 'BC-600', serial: '', supplier: 'Kiran Conveyors, Faridabad', installedOn: '2025-02-25', notes: '600 mm belt, VFD on the PLC' },
    help: 'Kind: Conveyor, SPM (special purpose machine), Gripper, Vision, Fixture, Safety, PLC panel, Positioner, AGV or Other. The same name on the same project is skipped.',
  },
  problems: {
    columns: ['project', 'title', 'errorCodes', 'component', 'robot', 'equipment', 'softwareVersion', 'category', 'severity', 'status', 'foundOn', 'solvedOn', 'description', 'cause', 'solution', 'loggedBy'],
    required: ['project', 'title'],
    example: { project: 'PRJ-1', title: 'Drive J3 drops off EtherCAT after 40 minutes', errorCodes: 'E131', component: 'Servo drive J3', robot: 'NX-C5-0001', equipment: '', softwareVersion: '3.4.2', category: 'Communication', severity: 'High', status: 'Solved', foundOn: '2025-03-10', solvedOn: '2025-03-11', description: 'Alarm E131 on the drive, robot stops', cause: 'Cable shield not grounded at the cabinet', solution: 'Grounded the shield at both ends; ran 3 hours without a drop', loggedBy: 'Ravi Kumar' },
    help: 'Past problems and how they were solved, so the search finds them. Status: Open, Investigating, Workaround or Solved (Solved when a solution is given and no status). The same title on the same day on the same project is skipped.',
  },
};

// Loose header names → column.
const ALIASES = {
  emailaddress: 'email', mail: 'email', fullname: 'name', employeename: 'name', designation: 'title', jobtitle: 'title', department: 'team', mobile: 'phone', phonenumber: 'phone',
  employeeid: 'employeeId', empid: 'employeeId', empcode: 'employeeId', joiningdate: 'joinedOn', dateofjoining: 'joinedOn', joined: 'joinedOn', joinedon: 'joinedOn', dob: 'birthday', dateofbirth: 'birthday',
  company: 'name', clientname: 'name', companyname: 'name', customer: 'client', customername: 'client', contactperson: 'contactName', contactname: 'contactName', contactrole: 'contactRole', contactphone: 'contactPhone', contactemail: 'contactEmail', contactmobile: 'contactPhone', gst: 'gstin', gstno: 'gstin', gstnumber: 'gstin',
  projectname: 'name', projectref: 'ref', reference: 'ref', started: 'startDate', startdate: 'startDate', startedon: 'startDate', golive: 'goLiveDate', golivedate: 'goLiveDate', commissionedon: 'goLiveDate', closed: 'closedOn', closedon: 'closedOn', closeddate: 'closedOn', sitecontact: 'siteContactName', sitecontactname: 'siteContactName', sitecontactphone: 'siteContactPhone', sitecontactemail: 'siteContactEmail', siteaddress: 'site',
  serialno: 'serial', serialnumber: 'serial', robotserial: 'serial', robotmodel: 'model', software: 'softwareVersion', softwareversion: 'softwareVersion', version: 'softwareVersion', firmware: 'softwareVersion', dispatched: 'dispatchedOn', dispatchedon: 'dispatchedOn', dispatchdate: 'dispatchedOn', installed: 'installedOn', installedon: 'installedOn', installdate: 'installedOn', installationdate: 'installedOn', color: 'colour',
  type: 'kind', equipmenttype: 'kind', equipmentname: 'name', vendor: 'supplier', manufacturer: 'make', brand: 'make',
  problem: 'title', issue: 'title', errorcode: 'errorCodes', errorcodes: 'errorCodes', alarm: 'errorCodes', alarmcode: 'errorCodes', part: 'component', robotserialno: 'robot', founddate: 'foundOn', foundon: 'foundOn', date: 'foundOn', solveddate: 'solvedOn', solvedon: 'solvedOn', rootcause: 'cause', reason: 'cause', fix: 'solution', howitwassolved: 'solution', resolution: 'solution', loggedby: 'loggedBy', engineer: 'loggedBy', reportedby: 'loggedBy', details: 'description', type_: 'category',
};

/** One row with its keys turned into the template's column names. */
/** The template column a header in the file goes to, or null when it is not used. */
function columnFor(kind, header) {
  const cols = TEMPLATES[kind].columns;
  const kk = key(header);
  let col = cols.find((c) => key(c) === kk) || ALIASES[kk];
  if (kind === 'robots' && kk === 'project') col = 'project';
  // In a projects or robots file, the company is the client, not the row's name.
  if ((kind === 'projects' || kind === 'robots') && ['company', 'companyname', 'clientname', 'customer', 'customername'].includes(kk)) col = 'client';
  if (kind === 'problems' && kk === 'type') col = 'category';
  if (kind === 'equipment' && kk === 'name') col = 'name';
  return col && cols.includes(col) ? col : null;
}

function mapRow(kind, raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const col = columnFor(kind, k);
    if (col && out[col] === undefined) out[col] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** '' → '', a date → 'YYYY-MM-DD', anything else → null (an error). Day first, as in India. */
function parseDate(v) {
  const s = str(v, 40);
  if (!s) return '';
  let y; let m; let d;
  let r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (r) [, y, m, d] = r.map(Number);
  else if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) { [, d, m, y] = r.map(Number); if (y < 100) y += 2000; }
  else if ((r = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})$/))) { d = Number(r[1]); m = MONTHS[r[2].toLowerCase()]; y = Number(r[3]); }
  else if ((r = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/))) { m = MONTHS[r[1].toLowerCase()]; d = Number(r[2]); y = Number(r[3]); }
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;
  return t.toISOString().slice(0, 10);
}
const pick = (v, list, labels = {}) => {
  const k = key(v);
  if (!k) return '';
  return list.find((x) => key(x) === k || key(labels[x]) === k) || null;
};
const STATUS_LABELS = { in_progress: 'In progress', on_hold: 'On hold', plc_panel: 'PLC panel', gripper_tooling: 'Gripper / tooling', customer_side: 'Customer side', spm: 'Special purpose machine' };

function createImporter({ db, projectsSvc: P, productionSvc: U }) {
  const users = db.collection('users');
  const projects = db.collection('projects');
  const units = db.collection('production_units');
  const entries = db.collection('project_entries');
  const router = express.Router();

  /** Finds a project by ref or name (within a client if given), in the database or made earlier in this import. */
  async function findProject(ctx, ref, clientName) {
    const v = str(ref, 160);
    if (!v) return null;
    if (/^PRJ-\d+$/i.test(v)) return (await projects.findOne({ ref: v.toUpperCase() })) || ctx.projects.get(`ref:${v.toUpperCase()}`) || null;
    const nk = nameKey(v);
    const fromDb = (await projects.find({}, { projection: { name: 1, ref: 1, clientId: 1, customer: 1, equipment: 1, team: 1, goLiveDate: 1 } }).toArray()).filter((p) => nameKey(p.name) === nk);
    const cands = [...fromDb, ...[...ctx.projects.values()].filter((p) => nameKey(p.name) === nk && !fromDb.some((x) => x.ref === p.ref))];
    if (!cands.length) return null;
    if (clientName) {
      const ck = nameKey(clientName);
      const inClient = cands.filter((p) => nameKey(p.customer?.company) === ck);
      if (inClient.length) return inClient[0];
    }
    return cands.length === 1 ? cands[0] : { ambiguous: cands.map((p) => p.ref).join(', ') };
  }
  const fillOnly = (current, incoming) => Object.fromEntries(Object.entries(incoming).filter(([k, v]) => v !== '' && v !== null && v !== undefined && (current[k] === undefined || current[k] === null || current[k] === '' || (Array.isArray(current[k]) && !current[k].length))));

  const RUN = {
    async people(r, ctx) {
      const role = pick(r.role, ROLES, { founder: 'Founder', hr: 'HR', lead: 'Lead', employee: 'Employee' });
      if (!role) return { status: 'error', message: `Role must be Founder, HR, Lead or Employee (got "${str(r.role, 30)}")` };
      const joinedOn = parseDate(r.joinedOn); const birthday = parseDate(r.birthday);
      if (joinedOn === null) return { status: 'error', message: 'Joining date is not a date' };
      if (birthday === null) return { status: 'error', message: 'Birthday is not a date' };
      const { value, error } = normaliseUser({ name: r.name, email: r.email, role, team: r.team, title: r.title, phone: r.phone, hr: { employeeId: r.employeeId, joinedOn, birthday } });
      if (error) return { status: 'error', message: error };
      if (ctx.seen.has(value.email)) return { status: 'skip', message: 'Same email twice in this file' };
      ctx.seen.add(value.email);
      if (await users.findOne({ email: value.email })) return { status: 'skip', message: 'Already in the hub' };
      if (ctx.dryRun) return { status: 'create', message: `${value.name}, ${role}` };
      let temp = crypto.randomBytes(6).toString('base64url');
      while (passwordProblem(temp)) temp = crypto.randomBytes(6).toString('base64url');
      const now = new Date();
      await users.insertOne({ _id: crypto.randomUUID(), team: '', title: '', phone: '', hr: {}, ...value, active: true, passwordHash: hashPassword(temp), mustChangePassword: true, createdAt: now, updatedAt: now, createdBy: ctx.actor._id, importedAt: now });
      return { status: 'create', message: `${value.name}, ${role}`, ref: value.name, temporaryPassword: temp, email: value.email };
    },

    async clients(r, ctx) {
      const contact = { name: str(r.contactName, 80), role: str(r.contactRole, 80), phone: str(r.contactPhone, 40), email: str(r.contactEmail, 120).toLowerCase() };
      const { value, error } = P.normaliseClient({ name: r.name, industry: r.industry, city: r.city, address: r.address, gstin: r.gstin, website: r.website, notes: r.notes, contacts: [contact] }, false);
      if (error) return { status: 'error', message: error };
      const existing = (await P.findClientByName(value.name)) || ctx.clients.get(value.nameKey);
      const same = (a, b) => (a.name && a.name.toLowerCase() === b.name.toLowerCase()) || (a.phone && a.phone === b.phone) || (a.email && a.email === b.email);
      if (!existing) {
        ctx.clients.set(value.nameKey, { ...value, ref: '(new)' });
        if (ctx.dryRun) return { status: 'create', message: value.name };
        const c = await P.createClient(value, ctx.actor);
        ctx.clients.set(value.nameKey, c);
        return { status: 'create', message: value.name, ref: c.ref };
      }
      const fill = fillOnly(existing, { industry: value.industry, city: value.city, address: value.address, gstin: value.gstin, website: value.website, notes: value.notes });
      const newContacts = value.contacts.filter((c) => !(existing.contacts || []).some((x) => same(x, c)));
      if (!Object.keys(fill).length && !newContacts.length) return { status: 'skip', message: 'Already in the hub, nothing new', ref: existing.ref };
      const what = [...Object.keys(fill), ...(newContacts.length ? [`${newContacts.length} contact${newContacts.length === 1 ? '' : 's'}`] : [])].join(', ');
      if (ctx.dryRun || !existing._id) { if (existing.contacts) existing.contacts = [...existing.contacts, ...newContacts]; Object.assign(existing, fill); return { status: 'update', message: `Adds ${what}`, ref: existing.ref }; }
      const next = await P.updateClient(existing, { ...fill, contacts: [...(existing.contacts || []), ...newContacts] });
      ctx.clients.set(value.nameKey, next);
      return { status: 'update', message: `Added ${what}`, ref: next.ref };
    },

    async projects(r, ctx) {
      const status = r.status ? pick(r.status, PROJECT_STATUSES, STATUS_LABELS) : 'planning';
      if (!status) return { status: 'error', message: `Status must be one of Planning, In progress, Commissioning, Live, On hold, Closed (got "${str(r.status, 30)}")` };
      const dates = {};
      for (const k of ['startDate', 'goLiveDate', 'closedOn']) { const d = parseDate(r[k]); if (d === null) return { status: 'error', message: `${k} is not a date` }; if (d) dates[k] = d; }
      const team = [];
      for (const part of String(r.team || '').split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)) {
        const [email, ...role] = part.split(':');
        const u = await users.findOne({ email: email.trim().toLowerCase(), hidden: { $ne: true } });
        if (!u) return { status: 'error', message: `Team: nobody with the email ${email.trim()}` };
        team.push({ userId: u._id, role: role.join(':').trim() });
      }
      const { value, error } = P.normaliseProject({
        name: r.name, status, application: r.application, description: r.description, tags: r.tags || [], ...dates,
        customer: { company: r.client, city: r.city, site: r.site, contactName: r.siteContactName, contactPhone: r.siteContactPhone, contactEmail: r.siteContactEmail },
      }, false);
      if (error) return { status: 'error', message: error };
      if (value.status === 'closed' && !value.closedOn) value.closedOn = value.goLiveDate || null;
      const ref = str(r.ref, 20).toUpperCase();
      let existing = ref ? await findProject(ctx, ref) : null;
      if (ref && !/^PRJ-\d+$/.test(ref)) return { status: 'error', message: 'ref looks like PRJ-12 (leave it empty for a new project)' };
      if (ref && !existing) return { status: 'error', message: `No project ${ref} (leave ref empty to make a new project)` };
      if (!existing) {
        const f = await findProject(ctx, value.name, r.client);
        if (f && !f.ambiguous && nameKey(f.customer?.company) === nameKey(r.client)) existing = f;
      }
      const t = await P.normaliseTeam(team);
      const clientNew = r.client && !(await P.findClientByName(r.client)) && !ctx.clients.has(nameKey(r.client));
      if (!existing) {
        const label = `${value.name}${r.client ? ` for ${str(r.client, 140)}${clientNew ? ' (new client)' : ''}` : ''}`;
        if (ctx.dryRun) { ctx.projects.set(`name:${nameKey(value.name)}`, { name: value.name, ref: '(new)', customer: { company: str(r.client, 140) }, equipment: [] }); if (clientNew) ctx.clients.set(nameKey(r.client), { name: r.client }); return { status: 'create', message: label }; }
        const client = r.client ? await P.findOrCreateClient(str(r.client, 140), ctx.actor, { city: str(r.city, 80) }) : null;
        const doc = await P.createProject(value, t.value, client, ctx.actor);
        ctx.projects.set(`ref:${doc.ref}`, doc);
        return { status: 'create', message: label, ref: doc.ref };
      }
      if (existing.ref === '(new)') return { status: 'skip', message: 'Same project twice in this file' };
      const full = await P.loadProject(existing._id);
      const fill = fillOnly(full, { application: value.application, description: value.description, startDate: value.startDate, goLiveDate: value.goLiveDate, closedOn: value.closedOn });
      const cust = fillOnly(full.customer || {}, { city: value.customer.city, site: value.customer.site, contactName: value.customer.contactName, contactPhone: value.customer.contactPhone, contactEmail: value.customer.contactEmail });
      const addTeam = t.value.filter((m) => !(full.team || []).some((x) => x.userId === m.userId));
      const statusChange = r.status && status !== full.status;
      const parts = [...Object.keys(fill), ...Object.keys(cust), ...(addTeam.length ? [`${addTeam.length} in the team`] : []), ...(statusChange ? [`status ${status}`] : [])];
      if (!parts.length) return { status: 'skip', message: 'Already in the hub, nothing new', ref: full.ref };
      if (ctx.dryRun) return { status: 'update', message: `Adds ${parts.join(', ')}`, ref: full.ref };
      await projects.updateOne({ _id: full._id }, { $set: { ...fill, ...(statusChange ? { status } : {}), customer: { ...full.customer, ...cust }, team: [...(full.team || []), ...addTeam], updatedAt: new Date() }, $push: { history: { at: new Date(), by: ctx.actor.name, text: `Filled in by import: ${parts.join(', ')}` } } });
      await P.reindexProject(full._id);
      return { status: 'update', message: `Added ${parts.join(', ')}`, ref: full.ref };
    },

    async robots(r, ctx) {
      const model = pick(r.model, Object.keys(MODELS));
      if (!model) return { status: 'error', message: `Model must be ${Object.keys(MODELS).join(', ')} (got "${str(r.model, 30)}")` };
      const dates = {};
      for (const k of ['dispatchedOn', 'installedOn']) { const d = parseDate(r[k]); if (d === null) return { status: 'error', message: `${k} is not a date` }; if (d) dates[k] = d; }
      const st = key(r.status);
      const BUILT = ['installed', 'dispatched', 'built', 'ready', 'delivered', 'done', 'live'];
      if (st && ![...BUILT, 'inbuild', 'building', 'planned', 'new'].includes(st)) return { status: 'error', message: 'Status must be Installed, Dispatched, Built, In build or Planned' };
      const built = BUILT.includes(st) || (!st && !!(dates.installedOn || dates.dispatchedOn));
      let project = null;
      if (r.project) {
        project = await findProject(ctx, r.project, r.client);
        if (!project) return { status: 'error', message: `No project "${str(r.project, 80)}"` };
        if (project.ambiguous) return { status: 'error', message: `Several projects are called "${str(r.project, 80)}" (${project.ambiguous}): use the ref` };
      }
      // Installed without a date: the project's go-live date, else the dispatch date.
      if (['installed', 'live'].includes(st) && !dates.installedOn) dates.installedOn = project?.goLiveDate || dates.dispatchedOn || '';
      if (['installed', 'live'].includes(st) && !dates.installedOn) return { status: 'error', message: 'An installed robot needs installedOn (the date), or a project with a go-live date' };
      const { value, error } = U.normaliseUnit({ model, colour: r.colour, description: r.notes, softwareVersion: r.softwareVersion, customer: { company: r.client || project?.customer?.company || '' }, ...dates }, false);
      if (error) return { status: 'error', message: error };
      const serial = str(r.serial, 40).toUpperCase();
      const existing = serial ? (await units.findOne({ serial })) || ctx.serials.get(serial) : null;
      if (serial && !existing && !/^[A-Z0-9][A-Z0-9\-_/.]{1,39}$/.test(serial)) return { status: 'error', message: 'A serial number has 2 to 40 letters, digits and - _ / .' };
      if (!existing) {
        if (serial) ctx.serials.set(serial, { serial, ref: '(new)' });
        const label = `${serial || `new ${model} serial`}${project ? ` on ${project.ref === '(new)' ? str(r.project, 80) : project.ref}` : ''}${value.softwareVersion ? `, software ${value.softwareVersion}` : ''}`;
        if (ctx.dryRun) return { status: 'create', message: label };
        if (project && project.ref === '(new)') return { status: 'error', message: 'Project not saved' };
        const doc = await U.createUnit(value, ctx.actor, { serial: serial || undefined, alreadyBuilt: !!built, projectId: project?._id });
        if (project) { await P.logToProject(project._id, ctx.actor, `Robot ${doc.serial} added by import`); }
        return { status: 'create', message: label.replace(`new ${model} serial`, doc.serial), ref: doc.serial };
      }
      if (existing.ref === '(new)') return { status: 'skip', message: 'Same serial twice in this file' };
      if (existing.model !== model) return { status: 'error', message: `${serial} is a ${existing.model} in the hub, not a ${model}` };
      const set = fillOnly(existing, { colour: value.colour, description: value.description, dispatchedOn: value.dispatchedOn, installedOn: value.installedOn });
      const parts = Object.keys(set);
      const moveTo = project && project._id && existing.projectId !== project._id ? project : null;
      if (moveTo && existing.projectId) return { status: 'error', message: `${serial} is on another project in the hub; move it there first` };
      if (moveTo) parts.push(`project ${moveTo.ref}`);
      const sw = value.softwareVersion && value.softwareVersion !== existing.software?.version;
      if (sw) parts.push(`software ${value.softwareVersion}`);
      if (!parts.length) return { status: 'skip', message: 'Already in the hub, nothing new', ref: serial };
      if (ctx.dryRun) return { status: 'update', message: `Adds ${parts.join(', ')}`, ref: serial };
      if (Object.keys(set).length || moveTo) await units.updateOne({ _id: existing._id }, { $set: { ...set, ...(moveTo ? { projectId: moveTo._id } : {}), updatedAt: new Date() }, $push: { history: { at: new Date(), by: ctx.actor.name, text: `Filled in by import: ${parts.join(', ')}` } } });
      if (sw) await U.setSoftware(await units.findOne({ _id: existing._id }), value.softwareVersion, value.installedOn || dates.installedOn || '', 'From import', ctx.actor);
      if (moveTo) await P.logToProject(moveTo._id, ctx.actor, `Robot ${serial} added by import`);
      return { status: 'update', message: `Added ${parts.join(', ')}`, ref: serial };
    },

    async equipment(r, ctx) {
      const project = await findProject(ctx, r.project);
      if (!project) return { status: 'error', message: `No project "${str(r.project, 80)}"` };
      if (project.ambiguous) return { status: 'error', message: `Several projects are called "${str(r.project, 80)}" (${project.ambiguous}): use the ref` };
      const kind = r.kind ? pick(r.kind === 'SPM' ? 'spm' : r.kind, EQUIPMENT_KINDS, STATUS_LABELS) : 'other';
      if (!kind) return { status: 'error', message: 'Kind must be Conveyor, SPM, Gripper, Vision, Fixture, Safety, PLC panel, Positioner, AGV or Other' };
      const installedOn = parseDate(r.installedOn);
      if (installedOn === null) return { status: 'error', message: 'installedOn is not a date' };
      const { value, error } = P.normaliseEquipment({ kind, name: r.name, make: r.make, model: r.model, serial: r.serial, supplier: r.supplier, notes: r.notes, installedOn }, false);
      if (error) return { status: 'error', message: error };
      const k = `${project._id || project.name}|${nameKey(value.name)}`;
      if (ctx.seen.has(k) || (project.equipment || []).some((q) => nameKey(q.name) === nameKey(value.name))) return { status: 'skip', message: `${project.ref} already has ${value.name}` };
      ctx.seen.add(k);
      if (ctx.dryRun) return { status: 'create', message: `${value.name} on ${project.ref}` };
      const full = await P.loadProject(project._id);
      await P.addEquipment(full, value, ctx.actor);
      return { status: 'create', message: `${value.name} on ${full.ref}`, ref: full.ref };
    },

    async problems(r, ctx) {
      const project = await findProject(ctx, r.project);
      if (!project) return { status: 'error', message: `No project "${str(r.project, 80)}"` };
      if (project.ambiguous) return { status: 'error', message: `Several projects are called "${str(r.project, 80)}" (${project.ambiguous}): use the ref` };
      const foundOn = parseDate(r.foundOn); const solvedOn = parseDate(r.solvedOn);
      if (foundOn === null || solvedOn === null) return { status: 'error', message: 'foundOn / solvedOn is not a date' };
      const status = r.status ? pick(r.status, ISSUE_STATUSES) : (str(r.solution) ? 'solved' : 'open');
      if (!status) return { status: 'error', message: 'Status must be Open, Investigating, Workaround or Solved' };
      const category = r.category ? pick(r.category, ISSUE_CATEGORIES, { ...STATUS_LABELS, communication: 'Communication / EtherCAT' }) || 'other' : 'other';
      const severity = r.severity ? pick(r.severity, ISSUE_SEVERITIES) || 'medium' : 'medium';
      const full = project._id ? await P.loadProject(project._id) : project;
      let unitId; let equipmentId;
      if (r.robot) {
        const u = await units.findOne({ serial: str(r.robot, 40).toUpperCase() });
        if (!u && !ctx.dryRun) return { status: 'error', message: `No robot ${str(r.robot, 40)}` };
        if (u && full._id && u.projectId !== full._id) return { status: 'error', message: `${u.serial} is not on ${full.ref}` };
        unitId = u?._id;
      }
      if (r.equipment) {
        const q = (full.equipment || []).find((x) => nameKey(x.name) === nameKey(r.equipment));
        if (!q && !ctx.dryRun) return { status: 'error', message: `${full.ref} has no equipment called "${str(r.equipment, 80)}"` };
        equipmentId = q?._id;
      }
      const body = { title: r.title, description: r.description, errorCodes: r.errorCodes, component: r.component, softwareVersion: r.softwareVersion, category, severity, status, foundOn, solvedOn, rootCause: r.cause, solution: r.solution, ...(unitId ? { unitId } : {}), ...(equipmentId ? { equipmentId } : {}) };
      const { value, error } = await P.normaliseEntryBody(body, 'issue', false, full);
      if (error) return { status: 'error', message: error };
      const day = value.foundOn || '';
      const k = `${full._id || full.name}|${nameKey(value.title)}|${day}`;
      if (ctx.seen.has(k)) return { status: 'skip', message: 'Same problem twice in this file' };
      ctx.seen.add(k);
      if (full._id && day && (await entries.find({ projectId: full._id, kind: 'issue', foundOn: day }).toArray()).some((e) => nameKey(e.title) === nameKey(value.title))) return { status: 'skip', message: `Already on ${full.ref}` };
      if (ctx.dryRun) return { status: 'create', message: `${value.title.slice(0, 60)} on ${full.ref}` };
      const by = str(r.loggedBy, 80) || ctx.actor.name;
      const doc = await P.insertEntry({ user: { name: by, _id: null } }, full, 'issue', value, { importedBy: ctx.actor.name });
      await P.logToProject(full._id, ctx.actor, `Problem ${doc.ref} added by import`);
      return { status: 'create', message: `${doc.ref}: ${value.title.slice(0, 60)}`, ref: doc.ref };
    },
  };

  async function run(kind, rows, { dryRun, actor }) {
    const ctx = { dryRun, actor, clients: new Map(), projects: new Map(), serials: new Map(), seen: new Set() };
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const r = mapRow(kind, rows[i]);
      const missing = TEMPLATES[kind].required.filter((c) => !str(r[c]));
      if (Object.values(r).every((v) => !str(v))) { results.push({ row: i + 1, status: 'skip', message: 'Empty row' }); continue; }
      if (missing.length) { results.push({ row: i + 1, status: 'error', message: `Missing ${missing.join(', ')}` }); continue; }
      try { results.push({ row: i + 1, ...(await RUN[kind](r, ctx)) }); } catch (err) { results.push({ row: i + 1, status: 'error', message: err.status ? err.message : `Could not save: ${err.message}` }); }
    }
    const summary = { create: 0, update: 0, skip: 0, error: 0 };
    for (const x of results) summary[x.status] += 1;
    const headers = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r || {})))];
    return { kind, dryRun, summary, columns: headers.map((h) => ({ header: h, column: columnFor(kind, h) })), results };
  }

  return { run, TEMPLATES, router };
}

function importRoutes({ requireUser, importer }) {
  const router = express.Router();
  router.get('/import/templates', requireUser('data.import'), (req, res) => res.json({ templates: TEMPLATES }));
  router.post('/import/:kind', requireUser('data.import'), wrap(async (req, res) => {
    const kind = String(req.params.kind);
    if (!TEMPLATES[kind]) return res.status(404).json({ error: `Import one of: ${Object.keys(TEMPLATES).join(', ')}` });
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows to import' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ error: `Up to ${MAX_ROWS} rows at a time: split the file` });
    res.json(await importer.run(kind, rows, { dryRun: req.body.dryRun !== false, actor: req.user }));
  }));
  return router;
}

module.exports = { createImporter, importRoutes, parseDate, mapRow, columnFor, TEMPLATES };
