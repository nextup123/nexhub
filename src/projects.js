'use strict';

/**
 * Clients and projects.
 *
 * A client (CLI-n) is a company: it can have many projects. A project (PRJ-n) is one installation or
 * job for a client: the robots from the build list that go to it, other equipment around them
 * (conveyors, special purpose machines, grippers, vision, fixtures, safety…), the team, and its record:
 * problems and how they were solved, site visits and notes. Everything is searchable across all
 * projects, error codes included (E131, E-131 and "e 131" all find each other), so when a robot shows
 * an error at a site you can find where it happened before and how it was fixed.
 *
 *   GET    /clients                 list with counts               (everyone who sees projects)
 *   POST   /clients                 { name, industry, city, address, gstin, website, contacts[], notes } (lead, founder)
 *   GET    /clients/:id             the client, its projects, robots and equipment
 *   PATCH  /clients/:id             (lead, founder)
 *   DELETE /clients/:id             (founder) only without projects
 *
 *   GET    /projects?status=&mine=true&clientId=     list with counts
 *   POST   /projects                            { clientId | customer.company, … } (lead, founder)
 *   GET    /projects/search?q=&kind=&status=&category=&projectId=&clientId=&mode=similar
 *   GET    /projects/:id                        the project, its client, robots, equipment and whole record
 *   PATCH  /projects/:id                        details, client, status, team (lead, founder)
 *   DELETE /projects/:id                        (founder) its record goes too; the robots stay in the build list
 *   PUT    /projects/:id/units/:unitId          put a robot on this project (lead, founder)
 *   DELETE /projects/:id/units/:unitId          take it off
 *   POST   /projects/:id/equipment              { kind, name, make, model, serial, supplier, installedOn, notes } (lead, founder)
 *   PATCH  /projects/:id/equipment/:eid         DELETE the same
 *
 *   POST   /projects/:id/entries                { kind: issue|visit|note, … } (anyone who can see projects)
 *                                               a problem: title, description, errorCodes, component, unitId,
 *                                               equipmentId, softwareVersion, category, severity, cause, solution
 *                                               a visit can carry problems: [{ … }], each kept as its own problem
 *   PATCH  /project-entries/:id                 the author, a lead or a founder (anyone may write the solution)
 *   POST   /project-entries/:id/updates         { text } a progress note on a problem
 *   DELETE /project-entries/:id                 the author, a lead or a founder
 *
 * Who sees what: founders, leads and employees see every client and project and the whole record
 * (engineers learn from other sites' problems). HR does not. Contact details (the client's contacts and
 * a project's site contact) are shown to founders, leads and the team of a project of that client only.
 */

const crypto = require('crypto');
const express = require('express');
const { can } = require('./permissions');
const D = require('./dates');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PROJECT_STATUSES = ['planning', 'in_progress', 'commissioning', 'live', 'on_hold', 'closed'];
const OPEN_PROJECT_STATUSES = ['planning', 'in_progress', 'commissioning', 'live', 'on_hold'];
const ENTRY_KINDS = ['issue', 'visit', 'note'];
const ISSUE_STATUSES = ['open', 'investigating', 'workaround', 'solved'];
const OPEN_ISSUE_STATUSES = ['open', 'investigating', 'workaround'];
const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const ISSUE_CATEGORIES = ['mechanical', 'electrical', 'software', 'communication', 'gripper_tooling', 'safety', 'process', 'customer_side', 'other'];
const EQUIPMENT_KINDS = ['conveyor', 'spm', 'gripper', 'vision', 'fixture', 'safety', 'plc_panel', 'positioner', 'agv', 'other'];
const EQUIPMENT_STATUSES = ['planned', 'installed', 'removed'];

// ── search text ─────────────────────────────────────────────────
/**
 * Error and alarm codes, written however people write them: E131, E-131, e 131, AL-21, F0003, Err 41.
 * Each is also kept squeezed ("e131") so a search for any spelling finds the others.
 */
const CODE_RX = /\b([a-z]{1,4})[\s\-_:#.]?(\d{2,6})\b/gi;
function codesIn(...texts) {
  const out = new Set();
  for (const t of texts.flat(Infinity)) {
    if (!t) continue;
    for (const m of String(t).matchAll(CODE_RX)) out.add(`${m[1]}${m[2]}`.toLowerCase());
  }
  return [...out];
}
/** A searched word, squeezed the same way: "E-131" → "e131". */
const normWord = (w) => w.toLowerCase().replace(/^([a-z]{1,4})[\-_:#.]?(\d{2,6})$/, '$1$2');
/** Error codes typed into their own field: "E131, AL-21" → ['E131', 'AL-21']. */
const codeList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/)).map((x) => str(x, 30).toUpperCase()).filter(Boolean))].slice(0, 20);

/** Lower-case text of every field worth finding, kept on the document so search is one query. */
const textOf = (...parts) => {
  const flat = parts.flat(Infinity).filter((x) => x !== undefined && x !== null && x !== '').map(String);
  return [...flat, ...codesIn(flat)].join(' \n ').toLowerCase().slice(0, 60000);
};
const equipmentText = (list) => (list || []).map((q) => [q.kind === 'spm' ? 'spm special purpose machine' : q.kind, q.name, q.make, q.model, q.serial, q.supplier, q.notes]);
const projectText = (p, unitList) => textOf(p.ref, p.name, p.application, p.description, p.scope, p.tags, p.enquiryRef,
  Object.values(p.customer || {}), (p.team || []).map((m) => [m.name, m.role]), equipmentText(p.equipment),
  unitList.map((u) => [u.serial, u.model, u.software?.version, (u.softwareHistory || []).map((h) => h.version)]));
const entryText = (e, p) => textOf(p.ref, p.name, p.customer?.company, e.ref, e.title, e.description, e.rootCause, e.solution, e.category,
  e.errorCodes, e.component, e.softwareVersion, e.equipmentName, e.equipmentKind, e.serial, e.model,
  e.purpose, e.workDone, e.nextSteps, e.text, (e.engineers || []).map((x) => x.name), e.createdBy, e.solvedBy, (e.updates || []).map((x) => x.text));
const clientText = (c) => textOf(c.ref, c.name, c.industry, c.city, c.address, c.gstin, c.website, c.notes, (c.contacts || []).map((x) => [x.name, x.role]));
const nameKey = (s) => str(s, 160).toLowerCase().replace(/\s+/g, ' ');

const STOP = new Set(['the', 'and', 'for', 'with', 'not', 'when', 'after', 'from', 'are', 'was', 'its', 'has', 'have', 'does', 'did', 'this', 'that', 'into', 'out', 'off', 'on', 'at', 'of', 'to', 'in', 'is', 'it', 'a', 'an', 'or']);

function createProjects({ db, config, requireUser }) {
  const projects = db.collection('projects');
  const entries = db.collection('project_entries');
  const units = db.collection('production_units');
  const users = db.collection('users');
  const clients = db.collection('clients');
  const counters = db.collection('counters');
  const router = express.Router();
  const today = () => D.todayIn(config.COMPANY_TZ);
  const event = (req, text) => ({ at: new Date(), by: req.user.name, text });

  const isManager = (u) => can(u, 'projects.manage');
  const onTeam = (p, u) => (p.team || []).some((m) => m.userId === u._id);
  const seesContact = (p, u) => isManager(u) || onTeam(p, u);
  const canEditEntry = (e, u) => isManager(u) || e.createdById === u._id;

  async function nextRef(name, prefix) {
    const r = await counters.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    return `${prefix}-${r.seq}`;
  }

  // ── shape and checks ─────────────────────────────────────────
  function projectView(p, u) {
    const out = { ...p, equipment: p.equipment || [], clientId: p.clientId || null };
    delete out.searchText;
    if (!seesContact(p, u)) out.customer = { company: p.customer?.company || '', city: p.customer?.city || '', site: p.customer?.site || '' };
    out.canEdit = isManager(u);
    return out;
  }
  function entryView(e, u) {
    const out = { ...e };
    delete out.searchText;
    out.canEdit = canEditEntry(e, u);
    return out;
  }
  /** A client's contacts: for managers and the team of any of its projects. */
  async function clientView(c, u, projs) {
    const out = { ...c };
    delete out.searchText; delete out.nameKey;
    const list = projs || await projects.find({ clientId: c._id }, { projection: { team: 1 } }).toArray();
    out.canSeeContacts = isManager(u) || list.some((p) => onTeam(p, u));
    if (!out.canSeeContacts) out.contacts = (c.contacts || []).map((x) => ({ name: x.name, role: x.role }));
    out.canEdit = can(u, 'clients.manage');
    return out;
  }

  function normaliseClient(b, partial) {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = str(b.name, 140).replace(/\s+/g, ' ');
      if (!out.name) return { error: 'The client’s name is required' };
      out.nameKey = nameKey(out.name);
    }
    for (const [k, max] of [['industry', 80], ['city', 80], ['address', 500], ['gstin', 20], ['website', 200], ['notes', 5000]]) if (b[k] !== undefined) out[k] = str(b[k], max);
    if (b.contacts !== undefined) {
      if (!Array.isArray(b.contacts)) return { error: 'contacts must be a list' };
      out.contacts = b.contacts.filter((x) => x && (str(x.name, 80) || str(x.phone, 40) || str(x.email, 120)))
        .map((x) => ({ name: str(x.name, 80), role: str(x.role, 80), phone: str(x.phone, 40), email: str(x.email, 120).toLowerCase() })).slice(0, 30);
    }
    return { value: out };
  }

  function normaliseProject(b, partial) {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = str(b.name, 140);
      if (!out.name) return { error: 'A project name is required' };
    }
    if (b.customer !== undefined) {
      const c = b.customer && typeof b.customer === 'object' ? b.customer : { company: b.customer };
      out.customer = {
        company: str(c.company, 140), city: str(c.city, 80), site: str(c.site, 300),
        contactName: str(c.contactName, 80), contactPhone: str(c.contactPhone, 40), contactEmail: str(c.contactEmail, 120),
      };
    }
    if (b.status !== undefined) {
      if (!PROJECT_STATUSES.includes(b.status)) return { error: `status must be one of ${PROJECT_STATUSES.join(', ')}` };
      out.status = b.status;
    }
    for (const k of ['startDate', 'goLiveDate', 'closedOn']) {
      if (b[k] !== undefined) {
        const v = str(b[k], 10);
        if (v && !D.isDate(v)) return { error: `${k} must look like 2026-11-18` };
        out[k] = v || null;
      }
    }
    for (const [k, max] of [['description', 5000], ['application', 200], ['scope', 5000], ['enquiryRef', 20]]) if (b[k] !== undefined) out[k] = str(b[k], max);
    if (out.enquiryRef !== undefined) out.enquiryRef = /^ENQ-\d+$/i.test(out.enquiryRef) ? out.enquiryRef.toUpperCase() : '';
    if (b.tags !== undefined) out.tags = [...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t) => str(t, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
    return { value: out };
  }

  function normaliseEquipment(b, partial) {
    const out = {};
    if (!partial || b.kind !== undefined) out.kind = EQUIPMENT_KINDS.includes(b.kind) ? b.kind : 'other';
    if (!partial || b.name !== undefined) {
      out.name = str(b.name, 140);
      if (!out.name) return { error: 'Give the equipment a name, e.g. Infeed conveyor' };
    }
    for (const [k, max] of [['make', 80], ['model', 80], ['serial', 60], ['supplier', 120], ['notes', 3000]]) if (b[k] !== undefined) out[k] = str(b[k], max);
    if (b.status !== undefined) out.status = EQUIPMENT_STATUSES.includes(b.status) ? b.status : 'installed';
    if (b.installedOn !== undefined) {
      const v = str(b.installedOn, 10);
      if (v && !D.isDate(v)) return { error: 'installedOn must look like 2026-11-18' };
      out.installedOn = v || null;
    }
    return { value: out };
  }

  /** team: [{ userId, role }] → [{ userId, name, role }], only real, active people. */
  async function normaliseTeam(list) {
    if (!Array.isArray(list)) return { error: 'team must be a list' };
    const ids = [...new Set(list.map((m) => str(m && m.userId, 60)).filter(Boolean))];
    const found = new Map((await users.find({ _id: { $in: ids }, hidden: { $ne: true } }).toArray()).filter((x) => x.active !== false).map((x) => [x._id, x]));
    const team = [];
    for (const m of list) {
      const p = found.get(str(m && m.userId, 60));
      if (p && !team.some((t) => t.userId === p._id)) team.push({ userId: p._id, name: p.name, role: str(m.role, 60) });
    }
    return { value: team.slice(0, 50) };
  }

  async function unitsOf(projectId) {
    return units.find({ projectId }, { projection: { serial: 1, model: 1, colour: 1, stages: 1, dispatchedOn: 1, installedOn: 1, targetDate: 1, onHold: 1, software: 1, softwareHistory: 1, projectId: 1 } }).toArray();
  }
  async function reindexProject(id) {
    const p = await projects.findOne({ _id: id });
    if (!p) return;
    await projects.updateOne({ _id: id }, { $set: { searchText: projectText(p, await unitsOf(id)) } });
  }
  async function reindexEntries(projectId) {
    const p = await projects.findOne({ _id: projectId });
    if (!p) return;
    for (const e of await entries.find({ projectId }).toArray()) await entries.updateOne({ _id: e._id }, { $set: { searchText: entryText(e, p) } });
  }

  // ── clients ──────────────────────────────────────────────────
  async function findClientByName(name) {
    const k = nameKey(name);
    return k ? clients.findOne({ nameKey: k }) : null;
  }
  async function createClient(value, actor) {
    const now = new Date();
    const doc = { _id: crypto.randomUUID(), ref: await nextRef('client', 'CLI'), industry: '', city: '', address: '', gstin: '', website: '', notes: '', contacts: [], ...value, createdBy: actor.name, createdAt: now, updatedAt: now };
    doc.searchText = clientText(doc);
    try { await clients.insertOne(doc); } catch (err) {
      // Two people adding the same client at the same moment: use the one that won.
      const again = await findClientByName(value.name);
      if (again) return again;
      throw err;
    }
    return doc;
  }
  /** The client with this name, made if it does not exist yet. */
  async function findOrCreateClient(name, actor, extra = {}) {
    const found = await findClientByName(name);
    if (found) return found;
    const { value, error } = normaliseClient({ name, ...extra }, false);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    return createClient(value, actor);
  }
  /** After a client is renamed: its projects show and find the new name. */
  async function syncClientName(c) {
    for (const p of await projects.find({ clientId: c._id }).toArray()) {
      if (p.customer?.company === c.name) continue;
      await projects.updateOne({ _id: p._id }, { $set: { 'customer.company': c.name } });
      await reindexProject(p._id);
      await reindexEntries(p._id);
    }
  }

  async function updateClient(c, value) {
    await clients.updateOne({ _id: c._id }, { $set: { ...value, updatedAt: new Date() } });
    const next = await clients.findOne({ _id: c._id });
    await clients.updateOne({ _id: c._id }, { $set: { searchText: clientText(next) } });
    if (value.name && value.name !== c.name) await syncClientName(next);
    return next;
  }

  /** clientId, or a company name (found or made), for a project. null: an internal project. */
  async function resolveClient(b, actor) {
    if (b.clientId !== undefined && b.clientId) {
      const c = await clients.findOne({ _id: str(b.clientId, 60) });
      if (!c) return { error: 'That client was not found' };
      return { client: c };
    }
    const company = str(b.customer && typeof b.customer === 'object' ? b.customer.company : b.customer, 140);
    if (b.clientId === null || b.clientId === '') return { client: company ? await findOrCreateClient(company, actor, { city: str(b.customer?.city, 80) }) : null };
    if (b.customer === undefined) return { unchanged: true };
    return { client: company ? await findOrCreateClient(company, actor, { city: str(b.customer?.city, 80) }) : null };
  }

  async function clientCounts(ids) {
    const ps = await projects.find({ clientId: { $in: ids } }, { projection: { clientId: 1, status: 1 } }).toArray();
    const robotList = ps.length ? await units.find({ projectId: { $in: ps.map((p) => p._id) } }, { projection: { projectId: 1 } }).toArray() : [];
    const byProject = new Map(ps.map((p) => [p._id, p.clientId]));
    const out = new Map(ids.map((id) => [id, { projects: 0, active: 0, robots: 0 }]));
    for (const p of ps) { const c = out.get(p.clientId); c.projects += 1; if (p.status !== 'closed') c.active += 1; }
    for (const u of robotList) { const c = out.get(byProject.get(u.projectId)); if (c) c.robots += 1; }
    return out;
  }

  router.get('/clients', requireUser('clients.view'), wrap(async (req, res) => {
    const list = await clients.find({}).sort({ name: 1 }).limit(2000).toArray();
    const c = await clientCounts(list.map((x) => x._id));
    const teams = await projects.find({ clientId: { $in: list.map((x) => x._id) } }, { projection: { clientId: 1, team: 1 } }).toArray();
    const out = [];
    for (const x of list) out.push({ ...(await clientView(x, req.user, teams.filter((p) => p.clientId === x._id))), counts: c.get(x._id) });
    res.json({ clients: out });
  }));

  router.post('/clients', requireUser('clients.manage'), wrap(async (req, res) => {
    const { value, error } = normaliseClient(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    const same = await findClientByName(value.name);
    if (same) return res.status(409).json({ error: `${same.name} is already a client (${same.ref})`, clientId: same._id });
    const doc = await createClient(value, req.user);
    res.status(201).json({ client: await clientView(doc, req.user, []) });
  }));

  router.get('/clients/:id', requireUser('clients.view'), wrap(async (req, res) => {
    const c = await clients.findOne({ _id: String(req.params.id) });
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const { phaseOf } = require('./production');
    const ps = await projects.find({ clientId: c._id }).sort({ updatedAt: -1 }).toArray();
    const pc = await counts(ps.map((p) => p._id));
    const robotList = ps.length ? await units.find({ projectId: { $in: ps.map((p) => p._id) } }).toArray() : [];
    const byId = new Map(ps.map((p) => [p._id, p]));
    res.json({
      client: await clientView(c, req.user, ps),
      projects: ps.map((p) => { const v = projectView(p, req.user); delete v.history; return { ...v, counts: pc.get(p._id) }; }),
      units: robotList.map((u) => ({ _id: u._id, serial: u.serial, model: u.model, colour: u.colour, phase: phaseOf(u), installedOn: u.installedOn, software: u.software || null, project: { _id: u.projectId, ref: byId.get(u.projectId)?.ref, name: byId.get(u.projectId)?.name } })),
      equipment: ps.flatMap((p) => (p.equipment || []).map((q) => ({ ...q, project: { _id: p._id, ref: p.ref, name: p.name } }))),
    });
  }));

  router.patch('/clients/:id', requireUser('clients.manage'), wrap(async (req, res) => {
    const c = await clients.findOne({ _id: String(req.params.id) });
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const b = req.body || {};
    const { value, error } = normaliseClient(b, true);
    if (error) return res.status(400).json({ error });
    if (value.nameKey && value.nameKey !== c.nameKey) {
      const same = await findClientByName(value.name);
      if (same && same._id !== c._id) return res.status(409).json({ error: `${same.name} is already a client (${same.ref})` });
    }
    // Someone who cannot see contact details must not wipe them by saving the rest.
    if (value.contacts && !isManager(req.user)) delete value.contacts;
    const next = await updateClient(c, value);
    res.json({ client: await clientView(next, req.user) });
  }));

  router.delete('/clients/:id', requireUser('clients.delete'), wrap(async (req, res) => {
    const c = await clients.findOne({ _id: String(req.params.id) });
    if (!c) return res.status(404).json({ error: 'Client not found' });
    const n = await projects.countDocuments({ clientId: c._id });
    if (n) return res.status(409).json({ error: `${c.name} still has ${n} project${n === 1 ? '' : 's'}. Move or delete them first.` });
    await clients.deleteOne({ _id: c._id });
    res.json({ ok: true });
  }));

  // ── entries ──────────────────────────────────────────────────
  async function normaliseEntryBody(b, kind, partial, project) {
    const out = {};
    const date = (k) => {
      if (b[k] === undefined) return null;
      const v = str(b[k], 10);
      if (v && !D.isDate(v)) return `${k} must look like 2026-11-18`;
      out[k] = v || null;
      return null;
    };
    if (kind === 'issue') {
      if (!partial || b.title !== undefined) { out.title = str(b.title, 200); if (!out.title) return { error: 'Say what the problem is' }; }
      for (const [k, max] of [['description', 5000], ['rootCause', 3000], ['solution', 5000], ['component', 120], ['softwareVersion', 40]]) if (b[k] !== undefined) out[k] = str(b[k], max);
      if (b.errorCodes !== undefined) out.errorCodes = codeList(b.errorCodes);
      if (b.severity !== undefined) out.severity = ISSUE_SEVERITIES.includes(b.severity) ? b.severity : 'medium';
      if (b.category !== undefined) out.category = ISSUE_CATEGORIES.includes(b.category) ? b.category : 'other';
      if (b.status !== undefined) {
        if (!ISSUE_STATUSES.includes(b.status)) return { error: `status must be one of ${ISSUE_STATUSES.join(', ')}` };
        out.status = b.status;
      }
      const err = date('foundOn') || date('solvedOn');
      if (err) return { error: err };
      if (b.unitId !== undefined) {
        if (b.unitId) {
          const u = await units.findOne({ _id: str(b.unitId, 60) });
          if (!u || u.projectId !== project._id) return { error: 'That robot is not on this project' };
          out.unitId = u._id; out.serial = u.serial; out.model = u.model;
          // The robot's software version at the time, unless one was typed.
          if (!out.softwareVersion && b.softwareVersion === undefined && u.software?.version) out.softwareVersion = u.software.version;
        } else { out.unitId = null; out.serial = ''; out.model = ''; }
      }
      if (b.equipmentId !== undefined) {
        if (b.equipmentId) {
          const q = (project.equipment || []).find((x) => x._id === str(b.equipmentId, 60));
          if (!q) return { error: 'That equipment is not on this project' };
          out.equipmentId = q._id; out.equipmentName = q.name; out.equipmentKind = q.kind;
        } else { out.equipmentId = null; out.equipmentName = ''; out.equipmentKind = ''; }
      }
    } else if (kind === 'visit') {
      const err = date('date') || date('endDate');
      if (err) return { error: err };
      if (!partial && !out.date) out.date = today();
      for (const [k, max] of [['purpose', 300], ['workDone', 8000], ['nextSteps', 3000]]) if (b[k] !== undefined) out[k] = str(b[k], max);
      if (b.hours !== undefined) { const h = Number(b.hours); out.hours = Number.isFinite(h) && h >= 0 && h <= 500 ? Math.round(h * 10) / 10 : null; }
      if (b.engineers !== undefined) {
        const t = await normaliseTeam((Array.isArray(b.engineers) ? b.engineers : []).map((x) => (typeof x === 'string' ? { userId: x } : x)));
        if (t.error) return t;
        out.engineers = t.value.map(({ userId, name }) => ({ userId, name }));
      }
      if (!partial && !out.purpose && !out.workDone && !(Array.isArray(b.problems) && b.problems.length)) return { error: 'Write what was done on the visit, or log a problem' };
    } else {
      if (!partial || b.text !== undefined) { out.text = str(b.text, 8000); if (!out.text) return { error: 'The note is empty' }; }
      if (b.title !== undefined) out.title = str(b.title, 200);
    }
    return { value: out };
  }

  async function insertEntry(req, project, kind, value, extra = {}) {
    const now = new Date();
    const doc = { _id: crypto.randomUUID(), projectId: project._id, kind, ...value, ...extra, updates: [], createdBy: req.user.name, createdById: req.user._id || null, createdAt: now, updatedAt: now };
    if (kind === 'issue') {
      doc.ref = await nextRef('project-issue', 'PRB');
      doc.status = doc.status || (doc.solution ? 'solved' : 'open');
      doc.severity = doc.severity || 'medium';
      doc.category = doc.category || 'other';
      doc.errorCodes = doc.errorCodes || [];
      doc.foundOn = doc.foundOn || today();
      if (doc.status === 'solved') { doc.solvedOn = doc.solvedOn || doc.foundOn; doc.solvedBy = doc.solvedBy || req.user.name; }
    }
    doc.searchText = entryText(doc, project);
    await entries.insertOne(doc);
    return doc;
  }

  async function loadProject(id) { return projects.findOne({ _id: String(id) }); }

  async function counts(ids) {
    const all = await entries.find({ projectId: { $in: ids } }, { projection: { projectId: 1, kind: 1, status: 1, date: 1, severity: 1 } }).toArray();
    const unitList = await units.find({ projectId: { $in: ids } }, { projection: { projectId: 1, serial: 1 } }).toArray();
    const out = new Map(ids.map((id) => [id, { robots: 0, serials: [], equipment: 0, openIssues: 0, criticalOpen: 0, issues: 0, visits: 0, lastVisit: null }]));
    for (const e of all) {
      const c = out.get(e.projectId);
      if (e.kind === 'issue') { c.issues += 1; if (OPEN_ISSUE_STATUSES.includes(e.status)) { c.openIssues += 1; if (['high', 'critical'].includes(e.severity)) c.criticalOpen += 1; } }
      if (e.kind === 'visit') { c.visits += 1; if (!c.lastVisit || e.date > c.lastVisit) c.lastVisit = e.date; }
    }
    for (const u of unitList) { const c = out.get(u.projectId); if (c) { c.robots += 1; c.serials.push(u.serial); } }
    return out;
  }

  /** A new project (also used by the bulk import). */
  async function createProject(value, team, client, actor) {
    const now = new Date();
    const doc = {
      _id: crypto.randomUUID(), ref: await nextRef('project', 'PRJ'), status: 'planning',
      customer: { company: '', city: '', site: '', contactName: '', contactPhone: '', contactEmail: '' },
      startDate: today(), goLiveDate: null, closedOn: null, description: '', application: '', scope: '', enquiryRef: '', tags: [], equipment: [],
      ...value, clientId: client ? client._id : null, team, history: [{ at: now, by: actor.name, text: 'Project created' }], createdBy: actor.name, createdAt: now, updatedAt: now,
    };
    doc.customer = { ...doc.customer, company: client ? client.name : '' };
    if (client && !doc.customer.city && client.city) doc.customer.city = client.city;
    doc.searchText = projectText(doc, []);
    await projects.insertOne(doc);
    return doc;
  }

  async function addEquipment(p, value, actor) {
    const item = { _id: crypto.randomUUID(), kind: 'other', name: '', make: '', model: '', serial: '', supplier: '', status: 'installed', installedOn: null, notes: '', ...value, addedBy: actor.name, addedAt: new Date() };
    await projects.updateOne({ _id: p._id }, { $set: { equipment: [...(p.equipment || []), item], updatedAt: new Date() }, $push: { history: { at: new Date(), by: actor.name, text: `Equipment added: ${item.name}` } } });
    await reindexProject(p._id);
    return item;
  }

  // ── projects ─────────────────────────────────────────────────
  router.get('/projects/meta', requireUser('projects.view'), (req, res) => {
    res.json({ statuses: PROJECT_STATUSES, openStatuses: OPEN_PROJECT_STATUSES, issueStatuses: ISSUE_STATUSES, severities: ISSUE_SEVERITIES, categories: ISSUE_CATEGORIES, kinds: ENTRY_KINDS, equipmentKinds: EQUIPMENT_KINDS });
  });

  router.get('/projects', requireUser('projects.view'), wrap(async (req, res) => {
    const filter = {};
    if (req.query.status === 'open') filter.status = { $in: OPEN_PROJECT_STATUSES };
    else if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
    if (req.query.clientId) filter.clientId = String(req.query.clientId);
    let list = await projects.find(filter, { projection: { searchText: 0 } }).sort({ updatedAt: -1 }).limit(2000).toArray();
    if (req.query.mine === 'true') list = list.filter((p) => onTeam(p, req.user));
    const c = await counts(list.map((p) => p._id));
    res.json({ projects: list.map((p) => { const v = projectView(p, req.user); delete v.history; return { ...v, counts: { ...c.get(p._id), equipment: (p.equipment || []).length } }; }) });
  }));

  router.post('/projects', requireUser('projects.manage'), wrap(async (req, res) => {
    const b = req.body || {};
    const { value, error } = normaliseProject(b, false);
    if (error) return res.status(400).json({ error });
    let team = [];
    if (b.team !== undefined) { const t = await normaliseTeam(b.team); if (t.error) return res.status(400).json({ error: t.error }); team = t.value; }
    const r = await resolveClient(b, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    if (value.status === 'closed' && !value.closedOn) value.closedOn = value.goLiveDate || today();
    const doc = await createProject(value, team, r.client || null, req.user);
    res.status(201).json({ project: projectView(doc, req.user) });
  }));

  // Search before /projects/:id so "search" is not read as an id.
  router.get('/projects/search', requireUser('projects.view'), wrap(async (req, res) => {
    const q = str(req.query.q, 300);
    const similar = req.query.mode === 'similar';
    const raw = [...new Set(q.toLowerCase().split(/[\s,;]+/).filter(Boolean))];
    // "Seen before": any of the problem's error codes or main words; the more match, the higher.
    const codes = codesIn(q);
    const words = similar
      ? [...new Set([...codes, ...raw.map((w) => w.replace(/[^\p{L}\p{N}\-_.]/gu, '')).filter((w) => w.length >= 3 && !STOP.has(w))])].slice(0, 12)
      : [...new Set(raw.map(normWord))].slice(0, 8);
    if (!words.length) return res.status(similar ? 200 : 400).json(similar ? { q, words: [], total: 0, hits: [] } : { error: 'Type something to search for' });
    const rx = (w) => ({ searchText: { $regex: escapeRegex(w) } });
    const wordFilter = similar ? [{ $or: words.map(rx) }] : words.map(rx);
    const kinds = req.query.kind ? String(req.query.kind).split(',') : ['project', ...ENTRY_KINDS];
    const ef = { $and: [...wordFilter, { kind: { $in: kinds.filter((k) => ENTRY_KINDS.includes(k)) } }] };
    if (req.query.projectId) ef.$and.push({ projectId: String(req.query.projectId) });
    if (req.query.status === 'open') ef.$and.push({ status: { $in: OPEN_ISSUE_STATUSES } });
    else if (req.query.status) ef.$and.push({ status: String(req.query.status) });
    if (req.query.category) ef.$and.push({ category: String(req.query.category) });
    if (req.query.exclude) ef.$and.push({ _id: { $ne: String(req.query.exclude) } });
    let clientProjects = null;
    if (req.query.clientId) {
      clientProjects = (await projects.find({ clientId: String(req.query.clientId) }, { projection: { _id: 1 } }).toArray()).map((p) => p._id);
      ef.$and.push({ projectId: { $in: clientProjects } });
    }
    const projectFilter = { $and: [...wordFilter] };
    if (req.query.projectId) projectFilter.$and.push({ _id: String(req.query.projectId) });
    if (clientProjects) projectFilter.$and.push({ _id: { $in: clientProjects } });
    const wantProjects = !similar && kinds.includes('project') && !req.query.status && !req.query.category;
    const wantClients = !similar && kinds.includes('client') && !req.query.status && !req.query.category && !req.query.projectId && !req.query.clientId;
    const [ps, es, cs] = await Promise.all([
      wantProjects ? projects.find(projectFilter).sort({ updatedAt: -1 }).limit(50).toArray() : [],
      entries.find(ef).sort({ createdAt: -1 }).limit(similar ? 300 : 400).toArray(),
      wantClients || (!req.query.kind && !similar && !req.query.status && !req.query.category && !req.query.projectId && !req.query.clientId)
        ? clients.find({ $and: wordFilter }).limit(20).toArray() : [],
    ]);
    const projIds = [...new Set(es.map((e) => e.projectId))].filter((id) => !ps.some((p) => p._id === id));
    const parents = new Map([...ps, ...(projIds.length ? await projects.find({ _id: { $in: projIds } }).toArray() : [])].map((p) => [p._id, p]));
    const short = (p) => p && { _id: p._id, ref: p.ref, name: p.name, company: p.customer?.company || '', clientId: p.clientId || null, status: p.status };

    // How well an entry matches: an error code or the title counts most; solved problems hold the answer.
    const has = (v, w) => !!v && String(v).toLowerCase().includes(w);
    const codeHit = (e, w) => (e.errorCodes || []).some((c) => normWord(c) === w || c.toLowerCase().includes(w)) || codesIn(e.title, e.description, e.rootCause, e.solution).includes(w);
    function score(e) {
      let s = 0;
      let matched = 0;
      for (const w of words) {
        let best = 0;
        if (codeHit(e, w)) best = 8;
        else if (has(e.title, w) || has(e.purpose, w)) best = 4;
        else if (has(e.component, w) || has(e.serial, w) || has(e.equipmentName, w) || has(e.softwareVersion, w)) best = 3;
        else if (has(e.solution, w) || has(e.rootCause, w) || has(e.workDone, w)) best = 2;
        else if (has(e.searchText, w)) best = 1;
        if (best) matched += 1;
        s += best;
      }
      if (e.kind === 'issue' && e.status === 'solved') s += 3;
      return { s, matched };
    }
    let scored = es.filter((e) => parents.has(e.projectId)).map((e) => ({ e, ...score(e) }));
    if (similar) scored = scored.filter((x) => x.s >= 8 || x.matched >= Math.min(2, words.length));
    scored.sort((a, b) => b.s - a.s || (a.e.createdAt < b.e.createdAt ? 1 : -1));
    if (similar) scored = scored.slice(0, Math.min(Number(req.query.limit) || 6, 20));
    else scored = scored.slice(0, 200);
    const hits = [
      ...ps.map((p) => ({ type: 'project', project: short(p), item: projectView(p, req.user) })),
      ...cs.map((c) => ({ type: 'client', client: { _id: c._id, ref: c.ref, name: c.name }, item: { _id: c._id, ref: c.ref, name: c.name, industry: c.industry, city: c.city } })),
      ...scored.map(({ e, s }) => ({ type: e.kind, score: s, project: short(parents.get(e.projectId)), item: entryView(e, req.user) })),
    ];
    res.json({ q, words, total: hits.length, hits });
  }));

  router.get('/projects/:id', requireUser('projects.view'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const { phaseOf, progressOf } = require('./production');
    const [list, record, client] = await Promise.all([unitsOf(p._id), entries.find({ projectId: p._id }).sort({ createdAt: -1 }).toArray(), p.clientId ? clients.findOne({ _id: p.clientId }) : null]);
    res.json({
      project: projectView(p, req.user),
      client: client ? { _id: client._id, ref: client.ref, name: client.name, city: client.city, industry: client.industry } : null,
      units: list.map((u) => { const o = { ...u, phase: phaseOf(u), progress: progressOf(u) }; delete o.stages; return o; }),
      entries: record.map((e) => entryView(e, req.user)),
      counts: { ...(await counts([p._id])).get(p._id), equipment: (p.equipment || []).length },
    });
  }));

  router.patch('/projects/:id', requireUser('projects.manage'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const b = req.body || {};
    const { value, error } = normaliseProject(b, true);
    if (error) return res.status(400).json({ error });
    if (b.team !== undefined) { const t = await normaliseTeam(b.team); if (t.error) return res.status(400).json({ error: t.error }); value.team = t.value; }
    if (value.customer) {
      // Someone who cannot see the contact details must not wipe them by saving the rest.
      for (const k of ['contactName', 'contactPhone', 'contactEmail']) if (b.customer[k] === undefined) value.customer[k] = p.customer?.[k] || '';
    }
    const changes = [];
    const r = await resolveClient(b, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    if (!r.unchanged) {
      const nextId = r.client ? r.client._id : null;
      value.customer = { ...(p.customer || {}), ...(value.customer || {}), company: r.client ? r.client.name : '' };
      if (nextId !== (p.clientId || null)) { value.clientId = nextId; changes.push(r.client ? `Client: ${r.client.name}` : 'Now an internal project'); }
    }
    if (value.status && value.status !== p.status) {
      changes.push(`Status: ${value.status.replace('_', ' ')}`);
      if (value.status === 'closed' && !p.closedOn && value.closedOn === undefined) value.closedOn = today();
    }
    if (value.name && value.name !== p.name) changes.push(`Renamed to ${value.name}`);
    if (value.goLiveDate !== undefined && value.goLiveDate !== p.goLiveDate) changes.push(`Go-live date ${value.goLiveDate || 'removed'}`);
    if (value.team) {
      const before = new Set((p.team || []).map((m) => m.userId));
      const after = new Set(value.team.map((m) => m.userId));
      const added = value.team.filter((m) => !before.has(m.userId)).map((m) => m.name);
      const removed = (p.team || []).filter((m) => !after.has(m.userId)).map((m) => m.name);
      if (added.length) changes.push(`Joined the team: ${added.join(', ')}`);
      if (removed.length) changes.push(`Left the team: ${removed.join(', ')}`);
    }
    const update = { $set: { ...value, updatedAt: new Date() } };
    if (changes.length) update.$push = { history: event(req, changes.join(' · ')) };
    await projects.updateOne({ _id: p._id }, update);
    await reindexProject(p._id);
    // The project's name and customer are part of every entry's search text.
    if (value.name || value.customer) await reindexEntries(p._id);
    res.json({ project: projectView(await loadProject(p._id), req.user) });
  }));

  router.delete('/projects/:id', requireUser('projects.delete'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    for (const u of await unitsOf(p._id)) await units.updateOne({ _id: u._id }, { $set: { projectId: null } });
    await entries.deleteMany({ projectId: p._id });
    await projects.deleteOne({ _id: p._id });
    res.json({ ok: true });
  }));

  router.put('/projects/:id/units/:unitId', requireUser('projects.manage'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const u = await units.findOne({ _id: String(req.params.unitId) });
    if (!u) return res.status(404).json({ error: 'Robot not found' });
    if (u.projectId && u.projectId !== p._id) {
      const other = await loadProject(u.projectId);
      if (other && req.body?.move !== true) return res.status(409).json({ error: `${u.serial} is already on ${other.ref} (${other.name}). Take it off there first.`, projectId: other._id });
      if (other) {
        await projects.updateOne({ _id: other._id }, { $push: { history: event(req, `Robot ${u.serial} moved to ${p.ref}`) }, $set: { updatedAt: new Date() } });
        await reindexProject(other._id);
      }
    }
    if (u.projectId !== p._id) {
      await units.updateOne({ _id: u._id }, { $set: { projectId: p._id, updatedAt: new Date() }, $push: { history: event(req, `Put on project ${p.ref} (${p.name})`) } });
      await projects.updateOne({ _id: p._id }, { $push: { history: event(req, `Robot ${u.serial} added`) }, $set: { updatedAt: new Date() } });
      await reindexProject(p._id);
    }
    res.json({ ok: true });
  }));

  router.delete('/projects/:id/units/:unitId', requireUser('projects.manage'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const u = await units.findOne({ _id: String(req.params.unitId) });
    if (!u || u.projectId !== p._id) return res.status(404).json({ error: 'That robot is not on this project' });
    await units.updateOne({ _id: u._id }, { $set: { projectId: null, updatedAt: new Date() }, $push: { history: event(req, `Taken off project ${p.ref}`) } });
    await projects.updateOne({ _id: p._id }, { $push: { history: event(req, `Robot ${u.serial} taken off`) }, $set: { updatedAt: new Date() } });
    await reindexProject(p._id);
    res.json({ ok: true });
  }));

  // ── equipment around the robots ──────────────────────────────
  router.post('/projects/:id/equipment', requireUser('projects.manage'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if ((p.equipment || []).length >= 200) return res.status(400).json({ error: 'A project can list up to 200 pieces of equipment' });
    const { value, error } = normaliseEquipment(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    const item = await addEquipment(p, value, req.user);
    res.status(201).json({ equipment: item, project: projectView(await loadProject(p._id), req.user) });
  }));

  router.patch('/projects/:id/equipment/:eid', requireUser('projects.manage'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const list = p.equipment || [];
    const i = list.findIndex((q) => q._id === req.params.eid);
    if (i < 0) return res.status(404).json({ error: 'Equipment not found' });
    const { value, error } = normaliseEquipment(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    const next = [...list];
    next[i] = { ...list[i], ...value };
    await projects.updateOne({ _id: p._id }, { $set: { equipment: next, updatedAt: new Date() } });
    if (value.name && value.name !== list[i].name) {
      for (const e of await entries.find({ projectId: p._id, equipmentId: list[i]._id }).toArray()) await entries.updateOne({ _id: e._id }, { $set: { equipmentName: value.name } });
      await reindexEntries(p._id);
    }
    await reindexProject(p._id);
    res.json({ equipment: next[i], project: projectView(await loadProject(p._id), req.user) });
  }));

  router.delete('/projects/:id/equipment/:eid', requireUser('projects.manage'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const item = (p.equipment || []).find((q) => q._id === req.params.eid);
    if (!item) return res.status(404).json({ error: 'Equipment not found' });
    await projects.updateOne({ _id: p._id }, { $set: { equipment: p.equipment.filter((q) => q._id !== item._id), updatedAt: new Date() }, $push: { history: event(req, `Equipment removed: ${item.name}`) } });
    // Problems logged on it keep its name.
    await reindexProject(p._id);
    res.json({ ok: true });
  }));

  // ── the record: problems, site visits, notes ─────────────────
  router.post('/projects/:id/entries', requireUser('projects.log'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const b = req.body || {};
    if (!ENTRY_KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of ${ENTRY_KINDS.join(', ')}` });
    const { value, error } = await normaliseEntryBody(b, b.kind, false, p);
    if (error) return res.status(400).json({ error });
    // Check every problem of a visit before saving anything.
    const problems = [];
    if (b.kind === 'visit' && Array.isArray(b.problems)) {
      for (const raw of b.problems.slice(0, 30)) {
        if (!raw || !str(raw.title, 200)) continue;
        const pr = await normaliseEntryBody({ severity: 'medium', category: 'other', ...raw, foundOn: raw.foundOn || value.date }, 'issue', false, p);
        if (pr.error) return res.status(400).json({ error: `Problem "${str(raw.title, 60)}": ${pr.error}` });
        problems.push(pr.value);
      }
    }
    if (b.kind === 'visit' && !value.engineers) value.engineers = [{ userId: req.user._id, name: req.user.name }];
    const doc = await insertEntry(req, p, b.kind, value);
    const created = [];
    for (const pr of problems) created.push(await insertEntry(req, p, 'issue', pr, { visitId: doc._id }));
    if (created.length) {
      doc.problemIds = created.map((c) => c._id);
      await entries.updateOne({ _id: doc._id }, { $set: { problemIds: doc.problemIds } });
    }
    const label = b.kind === 'issue' ? `Problem ${doc.ref} logged: ${doc.title}` : b.kind === 'visit' ? `Site visit on ${doc.date} logged${created.length ? ` with ${created.length} problem${created.length === 1 ? '' : 's'}` : ''}` : 'Note added';
    await projects.updateOne({ _id: p._id }, { $push: { history: event(req, label) }, $set: { updatedAt: new Date() } });
    res.status(201).json({ entry: entryView(doc, req.user), problems: created.map((c) => entryView(c, req.user)) });
  }));

  async function loadEntry(req, res) {
    const e = await entries.findOne({ _id: String(req.params.id) });
    if (!e) { res.status(404).json({ error: 'Not found' }); return null; }
    const p = await loadProject(e.projectId);
    if (!p) { res.status(404).json({ error: 'Project not found' }); return null; }
    return { e, p };
  }

  router.patch('/project-entries/:id', requireUser('projects.log'), wrap(async (req, res) => {
    const found = await loadEntry(req, res);
    if (!found) return undefined;
    const { e, p } = found;
    const b = req.body || {};
    // Anyone on the record may mark a problem solved and write the solution (that is the point);
    // other changes belong to whoever wrote it, a lead or a founder.
    const solvingOnly = e.kind === 'issue' && Object.keys(b).every((k) => ['status', 'solution', 'rootCause', 'solvedOn'].includes(k));
    if (!canEditEntry(e, req.user) && !solvingOnly) return res.status(403).json({ error: 'Only the person who wrote this, a lead or a founder can change it' });
    const { value, error } = await normaliseEntryBody(b, e.kind, true, p);
    if (error) return res.status(400).json({ error });
    const set = { ...value, updatedAt: new Date() };
    const notes = [];
    if (e.kind === 'issue' && value.status && value.status !== e.status) {
      notes.push({ at: new Date(), by: req.user.name, text: `Marked ${value.status}`, status: value.status });
      if (value.status === 'solved') { set.solvedBy = req.user.name; set.solvedOn = value.solvedOn || today(); } else { set.solvedOn = null; set.solvedBy = null; }
    }
    const next = { ...e, ...set, updates: [...(e.updates || []), ...notes] };
    set.searchText = entryText(next, p);
    const update = { $set: set };
    if (notes.length) update.$set.updates = next.updates;
    await entries.updateOne({ _id: e._id }, update);
    if (e.kind === 'issue' && value.status === 'solved' && e.status !== 'solved') {
      await projects.updateOne({ _id: p._id }, { $push: { history: event(req, `Problem ${e.ref} solved`) }, $set: { updatedAt: new Date() } });
    }
    res.json({ entry: entryView(await entries.findOne({ _id: e._id }), req.user) });
  }));

  router.post('/project-entries/:id/updates', requireUser('projects.log'), wrap(async (req, res) => {
    const found = await loadEntry(req, res);
    if (!found) return undefined;
    const { e, p } = found;
    const text = str(req.body?.text, 3000);
    if (!text) return res.status(400).json({ error: 'text is required' });
    const note = { at: new Date(), by: req.user.name, text };
    const next = { ...e, updates: [...(e.updates || []), note] };
    await entries.updateOne({ _id: e._id }, { $push: { updates: note }, $set: { updatedAt: note.at, searchText: entryText(next, p) } });
    res.status(201).json({ entry: entryView(await entries.findOne({ _id: e._id }), req.user) });
  }));

  router.delete('/project-entries/:id', requireUser('projects.log'), wrap(async (req, res) => {
    const found = await loadEntry(req, res);
    if (!found) return undefined;
    const { e, p } = found;
    if (!canEditEntry(e, req.user)) return res.status(403).json({ error: 'Only the person who wrote this, a lead or a founder can delete it' });
    await entries.deleteOne({ _id: e._id });
    // Problems logged on a visit stay; they just lose the link.
    if (e.kind === 'visit') for (const id of e.problemIds || []) await entries.updateOne({ _id: id }, { $set: { visitId: null } });
    await projects.updateOne({ _id: p._id }, { $push: { history: event(req, `${e.kind === 'issue' ? `Problem ${e.ref}` : e.kind === 'visit' ? `Site visit of ${e.date}` : 'A note'} deleted`) } });
    res.json({ ok: true });
  }));

  /** For the calendar and the home page. */
  async function visitsBetween(from, to) {
    const list = await entries.find({ kind: 'visit', date: { $gte: from, $lte: to } }).toArray();
    const ps = new Map((await projects.find({ _id: { $in: [...new Set(list.map((v) => v.projectId))] } }, { projection: { ref: 1, name: 1 } }).toArray()).map((p) => [p._id, p]));
    return list.filter((v) => ps.has(v.projectId)).map((v) => ({ ...v, project: ps.get(v.projectId) }));
  }
  async function homeCounts(u) {
    const open = await projects.find({ status: { $in: OPEN_PROJECT_STATUSES } }, { projection: { _id: 1, team: 1 } }).toArray();
    const ids = open.map((p) => p._id);
    const issues = await entries.find({ kind: 'issue', status: { $in: OPEN_ISSUE_STATUSES }, projectId: { $in: ids } }, { projection: { severity: 1, projectId: 1 } }).toArray();
    return { active: open.length, mine: open.filter((p) => onTeam(p, u)).length, openIssues: issues.length, serious: issues.filter((i) => ['high', 'critical'].includes(i.severity)).length };
  }

  // What the bulk import (src/importer.js) and the robots' software updates use.
  const svc = {
    normaliseClient, normaliseProject, normaliseEquipment, normaliseEntryBody, normaliseTeam,
    findClientByName, findOrCreateClient, createClient, updateClient, createProject, addEquipment, insertEntry,
    reindexProject, reindexEntries, loadProject,
    async logToProject(projectId, actor, text) {
      if (!projectId) return;
      await projects.updateOne({ _id: projectId }, { $push: { history: { at: new Date(), by: actor.name, text } }, $set: { updatedAt: new Date() } });
      await reindexProject(projectId);
    },
  };
  return { router, visitsBetween, homeCounts, svc };
}

/**
 * Projects from before clients existed: each customer company becomes a client (one per name),
 * linked to its projects. Safe to run on every start.
 */
async function migrateClients(db, log = console) {
  const projects = db.collection('projects');
  const clients = db.collection('clients');
  const counters = db.collection('counters');
  const todo = (await projects.find({}, { projection: { clientId: 1, customer: 1, equipment: 1 } }).toArray()).filter((p) => p.clientId === undefined || p.equipment === undefined);
  let made = 0;
  for (const p of todo) {
    const set = {};
    if (p.equipment === undefined) set.equipment = [];
    if (p.clientId === undefined) {
      const name = str(p.customer?.company, 140).replace(/\s+/g, ' ');
      let c = null;
      if (name) {
        c = await clients.findOne({ nameKey: nameKey(name) });
        if (!c) {
          const r = await counters.findOneAndUpdate({ _id: 'client' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
          const now = new Date();
          c = { _id: crypto.randomUUID(), ref: `CLI-${r.seq}`, name, nameKey: nameKey(name), industry: '', city: str(p.customer?.city, 80), address: '', gstin: '', website: '', notes: '', contacts: [], createdBy: 'Hub update', createdAt: now, updatedAt: now };
          c.searchText = clientText(c);
          await clients.insertOne(c);
          made += 1;
        }
      }
      set.clientId = c ? c._id : null;
      // The project's site contact becomes one of the client's contacts (once).
      const cu = p.customer || {};
      const contact = { name: str(cu.contactName, 80), role: 'Site contact', phone: str(cu.contactPhone, 40), email: str(cu.contactEmail, 120).toLowerCase() };
      if (c && (contact.name || contact.phone || contact.email)) {
        const fresh = await clients.findOne({ _id: c._id });
        const same = (fresh.contacts || []).some((x) => (contact.name && x.name === contact.name) || (contact.phone && x.phone === contact.phone) || (contact.email && x.email === contact.email));
        if (!same) {
          const contacts = [...(fresh.contacts || []), contact].slice(0, 30);
          await clients.updateOne({ _id: c._id }, { $set: { contacts, searchText: clientText({ ...fresh, contacts }) } });
        }
      }
    }
    await projects.updateOne({ _id: p._id }, { $set: set });
  }
  if (made) log.log(`[HUB] made ${made} client${made === 1 ? '' : 's'} from the customers of existing projects`);
  return made;
}

module.exports = {
  createProjects, migrateClients, projectText, entryText, codesIn, normWord,
  PROJECT_STATUSES, ISSUE_STATUSES, ISSUE_SEVERITIES, ISSUE_CATEGORIES, ENTRY_KINDS, EQUIPMENT_KINDS,
};
