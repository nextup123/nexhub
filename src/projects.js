'use strict';

/**
 * Projects: one per customer installation (or internal job). A project holds the robots from the
 * build list that go to it, the team working on it, and its record: problems and how they were
 * solved, site visits (what the engineers found and fixed that day) and notes. Everything is
 * searchable, so when a project has a problem you can find where it, or something like it, happened before.
 *
 *   GET    /projects?status=&mine=true          list with counts
 *   POST   /projects                            (lead, founder)
 *   GET    /projects/search?q=&kind=&status=&category=&projectId=   projects, problems, solutions, visits, notes
 *   GET    /projects/:id                        the project, its robots and its whole record
 *   PATCH  /projects/:id                        details, status, team (lead, founder)
 *   DELETE /projects/:id                        (founder) its record goes too; the robots stay in the build list
 *   PUT    /projects/:id/units/:unitId          put a robot on this project (lead, founder)
 *   DELETE /projects/:id/units/:unitId          take it off
 *
 *   POST   /projects/:id/entries                { kind: issue|visit|note, … } (anyone who can see projects)
 *                                               a visit can carry problems: [{ title, solution, status, unitId }],
 *                                               each kept as its own problem, linked to the visit
 *   PATCH  /project-entries/:id                 the author, a lead or a founder
 *   POST   /project-entries/:id/updates         { text } a progress note on a problem
 *   DELETE /project-entries/:id                 the author, a lead or a founder
 *
 * Who sees what: founders, leads and employees see every project and its record (engineers learn
 * from other sites' problems). HR does not (customer and production work). Customer contact
 * details (name, phone, email) are shown to founders, leads and the project's own team only.
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

/** Lower-case text of every field worth finding, kept on the document so search is one query. */
const textOf = (...parts) => parts.flat(Infinity).filter((x) => x !== undefined && x !== null && x !== '').map(String).join(' \n ').toLowerCase().slice(0, 60000);

const projectText = (p, unitList) => textOf(p.ref, p.name, p.application, p.description, p.scope, p.tags, p.enquiryRef,
  Object.values(p.customer || {}), (p.team || []).map((m) => [m.name, m.role]), unitList.map((u) => [u.serial, u.model]));
const entryText = (e, p) => textOf(p.ref, p.name, p.customer?.company, e.ref, e.title, e.description, e.rootCause, e.solution, e.category,
  e.serial, e.purpose, e.workDone, e.nextSteps, e.text, (e.engineers || []).map((x) => x.name), e.createdBy, e.solvedBy, (e.updates || []).map((x) => x.text));

function createProjects({ db, config, requireUser }) {
  const projects = db.collection('projects');
  const entries = db.collection('project_entries');
  const units = db.collection('production_units');
  const users = db.collection('users');
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
    const out = { ...p };
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

  function normaliseProject(b, partial) {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = str(b.name, 140);
      if (!out.name) return { error: 'A project name is required' };
    }
    if (b.customer !== undefined) {
      const c = b.customer && typeof b.customer === 'object' ? b.customer : { company: b.customer };
      out.customer = {
        company: str(c.company, 120), city: str(c.city, 80), site: str(c.site, 300),
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
    return units.find({ projectId }, { projection: { serial: 1, model: 1, colour: 1, stages: 1, dispatchedOn: 1, installedOn: 1, targetDate: 1, onHold: 1 } }).toArray();
  }
  async function reindexProject(id) {
    const p = await projects.findOne({ _id: id });
    if (!p) return;
    await projects.updateOne({ _id: id }, { $set: { searchText: projectText(p, await unitsOf(id)) } });
  }

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
      for (const [k, max] of [['description', 5000], ['rootCause', 3000], ['solution', 5000]]) if (b[k] !== undefined) out[k] = str(b[k], max);
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
          out.unitId = u._id; out.serial = u.serial;
        } else { out.unitId = null; out.serial = ''; }
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
    const doc = { _id: crypto.randomUUID(), projectId: project._id, kind, ...value, ...extra, updates: [], createdBy: req.user.name, createdById: req.user._id, createdAt: now, updatedAt: now };
    if (kind === 'issue') {
      doc.ref = await nextRef('project-issue', 'PRB');
      doc.status = doc.status || (doc.solution ? 'solved' : 'open');
      doc.severity = doc.severity || 'medium';
      doc.category = doc.category || 'other';
      doc.foundOn = doc.foundOn || today();
      if (doc.status === 'solved') { doc.solvedOn = doc.solvedOn || doc.foundOn; doc.solvedBy = req.user.name; }
    }
    doc.searchText = entryText(doc, project);
    await entries.insertOne(doc);
    return doc;
  }

  async function loadProject(id) { return projects.findOne({ _id: String(id) }); }

  async function counts(ids) {
    const all = await entries.find({ projectId: { $in: ids } }, { projection: { projectId: 1, kind: 1, status: 1, date: 1, severity: 1 } }).toArray();
    const unitList = await units.find({ projectId: { $in: ids } }, { projection: { projectId: 1, serial: 1 } }).toArray();
    const out = new Map(ids.map((id) => [id, { robots: 0, serials: [], openIssues: 0, criticalOpen: 0, issues: 0, visits: 0, lastVisit: null }]));
    for (const e of all) {
      const c = out.get(e.projectId);
      if (e.kind === 'issue') { c.issues += 1; if (OPEN_ISSUE_STATUSES.includes(e.status)) { c.openIssues += 1; if (['high', 'critical'].includes(e.severity)) c.criticalOpen += 1; } }
      if (e.kind === 'visit') { c.visits += 1; if (!c.lastVisit || e.date > c.lastVisit) c.lastVisit = e.date; }
    }
    for (const u of unitList) { const c = out.get(u.projectId); if (c) { c.robots += 1; c.serials.push(u.serial); } }
    return out;
  }

  // ── projects ─────────────────────────────────────────────────
  router.get('/projects/meta', requireUser('projects.view'), (req, res) => {
    res.json({ statuses: PROJECT_STATUSES, openStatuses: OPEN_PROJECT_STATUSES, issueStatuses: ISSUE_STATUSES, severities: ISSUE_SEVERITIES, categories: ISSUE_CATEGORIES, kinds: ENTRY_KINDS });
  });

  router.get('/projects', requireUser('projects.view'), wrap(async (req, res) => {
    const filter = {};
    if (req.query.status === 'open') filter.status = { $in: OPEN_PROJECT_STATUSES };
    else if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
    let list = await projects.find(filter, { projection: { searchText: 0 } }).sort({ updatedAt: -1 }).limit(1000).toArray();
    if (req.query.mine === 'true') list = list.filter((p) => onTeam(p, req.user));
    const c = await counts(list.map((p) => p._id));
    res.json({ projects: list.map((p) => { const v = projectView(p, req.user); delete v.history; return { ...v, counts: c.get(p._id) }; }) });
  }));

  router.post('/projects', requireUser('projects.manage'), wrap(async (req, res) => {
    const b = req.body || {};
    const { value, error } = normaliseProject(b, false);
    if (error) return res.status(400).json({ error });
    let team = [];
    if (b.team !== undefined) { const t = await normaliseTeam(b.team); if (t.error) return res.status(400).json({ error: t.error }); team = t.value; }
    const now = new Date();
    const doc = {
      _id: crypto.randomUUID(), ref: await nextRef('project', 'PRJ'), status: 'planning',
      customer: { company: '', city: '', site: '', contactName: '', contactPhone: '', contactEmail: '' },
      startDate: today(), goLiveDate: null, closedOn: null, description: '', application: '', scope: '', enquiryRef: '', tags: [],
      ...value, team, history: [{ at: now, by: req.user.name, text: 'Project created' }], createdBy: req.user.name, createdAt: now, updatedAt: now,
    };
    doc.searchText = projectText(doc, []);
    await projects.insertOne(doc);
    res.status(201).json({ project: projectView(doc, req.user) });
  }));

  // Search before /projects/:id so "search" is not read as an id.
  router.get('/projects/search', requireUser('projects.view'), wrap(async (req, res) => {
    const q = str(req.query.q, 200).toLowerCase();
    const words = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 8);
    if (!words.length) return res.status(400).json({ error: 'Type something to search for' });
    const wordFilter = words.map((w) => ({ searchText: { $regex: escapeRegex(w) } }));
    const kinds = req.query.kind ? String(req.query.kind).split(',') : ['project', ...ENTRY_KINDS];
    const ef = { $and: [...wordFilter] };
    ef.$and.push({ kind: { $in: kinds.filter((k) => ENTRY_KINDS.includes(k)) } });
    if (req.query.projectId) ef.$and.push({ projectId: String(req.query.projectId) });
    if (req.query.status === 'open') ef.$and.push({ status: { $in: OPEN_ISSUE_STATUSES } });
    else if (req.query.status) ef.$and.push({ status: String(req.query.status) });
    if (req.query.category) ef.$and.push({ category: String(req.query.category) });
    const [ps, es] = await Promise.all([
      kinds.includes('project') && !req.query.status && !req.query.category
        ? projects.find({ $and: [...wordFilter, ...(req.query.projectId ? [{ _id: String(req.query.projectId) }] : [])] }).sort({ updatedAt: -1 }).limit(50).toArray()
        : [],
      entries.find(ef).sort({ createdAt: -1 }).limit(200).toArray(),
    ]);
    const projIds = [...new Set(es.map((e) => e.projectId))].filter((id) => !ps.some((p) => p._id === id));
    const parents = new Map([...ps, ...(projIds.length ? await projects.find({ _id: { $in: projIds } }).toArray() : [])].map((p) => [p._id, p]));
    const short = (p) => p && { _id: p._id, ref: p.ref, name: p.name, company: p.customer?.company || '', status: p.status };
    // Solved problems first: they hold the answer.
    const rank = (e) => (e.kind === 'issue' ? (e.status === 'solved' ? 0 : 1) : e.kind === 'visit' ? 2 : 3);
    const hits = [
      ...ps.map((p) => ({ type: 'project', project: short(p), item: projectView(p, req.user) })),
      ...es.filter((e) => parents.has(e.projectId)).sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1)).map((e) => ({ type: e.kind, project: short(parents.get(e.projectId)), item: entryView(e, req.user) })),
    ];
    res.json({ q, words, total: hits.length, hits });
  }));

  router.get('/projects/:id', requireUser('projects.view'), wrap(async (req, res) => {
    const p = await loadProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    const { phaseOf, progressOf } = require('./production');
    const [list, record] = await Promise.all([unitsOf(p._id), entries.find({ projectId: p._id }).sort({ createdAt: -1 }).toArray()]);
    res.json({
      project: projectView(p, req.user),
      units: list.map((u) => { const o = { ...u, phase: phaseOf(u), progress: progressOf(u) }; delete o.stages; return o; }),
      entries: record.map((e) => entryView(e, req.user)),
      counts: (await counts([p._id])).get(p._id),
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
    if (value.name || value.customer) {
      const np = await loadProject(p._id);
      for (const e of await entries.find({ projectId: p._id }).toArray()) await entries.updateOne({ _id: e._id }, { $set: { searchText: entryText(e, np) } });
    }
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

  return { router, visitsBetween, homeCounts };
}

module.exports = { createProjects, projectText, entryText, PROJECT_STATUSES, ISSUE_STATUSES, ISSUE_SEVERITIES, ISSUE_CATEGORIES, ENTRY_KINDS };
