'use strict';

/**
 * Production: every robot being built is a "unit" with its own serial number and a checklist
 * of build stages (base ready, wiring done, control panel ready …). The unit's phase follows
 * from the stages: planned → in build → testing → ready, then dispatched and installed by hand.
 *
 *   GET    /production/templates           the stage list each model starts with
 *   GET    /units?model=&phase=&q=&assignee=me
 *   GET    /units/summary                  counts for the board and the home page
 *   POST   /units                          { model, colour, customer, enquiryRef, orderedOn, targetDate, priority, notes }   (lead, founder)
 *   GET    /units/:id
 *   PATCH  /units/:id                      details, onHold, dispatchedOn, installedOn                                    (lead, founder)
 *   PATCH  /units/:id/stages/:key          { state, assigneeId, note }   lead/founder any stage; employees only stages given to them
 *   POST   /units/:id/stages               { label, after }  add a stage (lead, founder)
 *   DELETE /units/:id/stages/:key          (lead, founder)
 *   POST   /units/:id/notes                { text }
 *   DELETE /units/:id                      (founder)
 */

const crypto = require('crypto');
const express = require('express');
const { can } = require('./permissions');
const D = require('./dates');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

const MODELS = {
  NexC5: { prefix: 'C5', colours: ['White', 'Blue'] },
  NexR10: { prefix: 'R10', colours: [] },
  NexR20: { prefix: 'R20', colours: [] },
  Custom: { prefix: 'CU', colours: [] },
};
// The build of a Nextup robot, in order. Each unit gets its own copy, so a stage can be added
// or removed for one unit without touching the others.
const ROBOT_STAGES = [
  ['parts', 'Parts received', 'Purchase'],
  ['base', 'Base ready', 'Mechanical'],
  ['joints', 'Joints and gearboxes fitted', 'Mechanical'],
  ['arm', 'Arm assembled', 'Mechanical'],
  ['wiring', 'Wiring done', 'Electrical'],
  ['panel', 'Control panel ready', 'Electrical'],
  ['software', 'Software installed', 'Software'],
  ['calibration', 'Calibrated', 'Software'],
  ['testing', 'Tested (QA and burn-in)', 'Quality'],
  ['packing', 'Packed for dispatch', 'Logistics'],
];
const CUSTOM_STAGES = [
  ['design', 'Design approved', 'Engineering'],
  ...ROBOT_STAGES.slice(0, 1),
  ['fabrication', 'Frame and fixtures fabricated', 'Mechanical'],
  ...ROBOT_STAGES.slice(4),
];
const STAGE_STATES = ['pending', 'in_progress', 'done', 'blocked', 'skipped'];
const PRIORITIES = ['normal', 'high', 'urgent'];
const PHASES = ['planned', 'in_build', 'testing', 'ready', 'dispatched', 'installed'];

const templateFor = (model) => (model === 'Custom' ? CUSTOM_STAGES : ROBOT_STAGES);
const newStage = ([key, label, area]) => ({ key, label, area, state: 'pending', assigneeId: null, assignee: null, startedAt: null, doneAt: null, doneBy: null, note: '' });

/** planned / in_build / testing / ready, or dispatched / installed once those dates are set. */
function phaseOf(u) {
  if (u.installedOn) return 'installed';
  if (u.dispatchedOn) return 'dispatched';
  const st = (u.stages || []).filter((s) => s.state !== 'skipped');
  if (!st.length) return 'planned';
  if (st.every((s) => s.state === 'done')) return 'ready';
  if (st.every((s) => s.state === 'pending')) return 'planned';
  const testing = st.find((s) => s.key === 'testing');
  if (testing && testing.state !== 'pending') return 'testing';
  return 'in_build';
}
function progressOf(u) {
  const st = (u.stages || []).filter((s) => s.state !== 'skipped');
  const done = st.filter((s) => s.state === 'done').length;
  const current = st.find((s) => s.state === 'in_progress' || s.state === 'blocked') || st.find((s) => s.state === 'pending') || null;
  return { done, total: st.length, pct: st.length ? Math.round((done / st.length) * 100) : 0, current: current && { key: current.key, label: current.label, state: current.state, assignee: current.assignee }, blocked: st.some((s) => s.state === 'blocked') };
}

function createProduction({ db, config, requireUser }) {
  const units = db.collection('production_units');
  const users = db.collection('users');
  const counters = db.collection('counters');
  const router = express.Router();
  const today = () => D.todayIn(config.COMPANY_TZ);

  const view = (u) => {
    const out = { ...u, phase: phaseOf(u), progress: progressOf(u) };
    out.late = !!(u.targetDate && !u.dispatchedOn && u.targetDate < today() && out.phase !== 'ready');
    return out;
  };
  const listView = (u) => { const v = view(u); delete v.history; delete v.notes; return v; };

  async function nextSerial(model) {
    const prefix = MODELS[model].prefix;
    const r = await counters.findOneAndUpdate({ _id: `unit:${prefix}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    return `NX-${prefix}-${String(r.seq).padStart(4, '0')}`;
  }
  const event = (req, text) => ({ at: new Date(), by: req.user.name, text });

  function normaliseUnit(b, partial) {
    const out = {};
    if (!partial || b.model !== undefined) {
      if (!MODELS[b.model]) return { error: `model must be one of ${Object.keys(MODELS).join(', ')}` };
      out.model = b.model;
    }
    if (b.colour !== undefined) out.colour = str(b.colour, 30);
    if (b.customer !== undefined) {
      const c = b.customer && typeof b.customer === 'object' ? b.customer : { company: b.customer };
      out.customer = { company: str(c.company, 120), city: str(c.city, 80) };
    }
    if (b.enquiryRef !== undefined) out.enquiryRef = /^ENQ-\d+$/i.test(str(b.enquiryRef, 20)) ? str(b.enquiryRef, 20).toUpperCase() : '';
    for (const k of ['orderedOn', 'targetDate', 'dispatchedOn', 'installedOn']) {
      if (b[k] !== undefined) {
        const v = str(b[k], 10);
        if (v && !D.isDate(v)) return { error: `${k} must look like 2026-11-18` };
        out[k] = v || null;
      }
    }
    if (b.priority !== undefined) out.priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
    if (b.onHold !== undefined) out.onHold = b.onHold === true;
    if (b.holdReason !== undefined) out.holdReason = str(b.holdReason, 300);
    if (b.description !== undefined) out.description = str(b.description, 2000);
    return { value: out };
  }

  router.get('/production/templates', requireUser('production.view'), (req, res) => {
    res.json({
      models: Object.entries(MODELS).map(([name, m]) => ({ name, prefix: m.prefix, colours: m.colours, stages: templateFor(name).map(([key, label, area]) => ({ key, label, area })) })),
      states: STAGE_STATES, priorities: PRIORITIES, phases: PHASES,
    });
  });

  router.get('/units', requireUser('production.view'), wrap(async (req, res) => {
    const filter = {};
    if (req.query.model) filter.model = String(req.query.model);
    let list = (await units.find(filter).sort({ createdAt: -1 }).limit(1000).toArray()).map(listView);
    if (req.query.project === 'none') list = list.filter((u) => !u.projectId);
    if (req.query.phase) { const p = String(req.query.phase).split(','); list = list.filter((u) => p.includes(u.phase)); }
    if (req.query.assignee === 'me') list = list.filter((u) => u.stages.some((s) => s.assigneeId === req.user._id && s.state !== 'done' && s.state !== 'skipped'));
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((u) => [u.serial, u.model, u.customer?.company, u.customer?.city, u.enquiryRef].some((x) => String(x || '').toLowerCase().includes(q)));
    }
    res.json({ units: list });
  }));

  router.get('/units/summary', requireUser('production.view'), wrap(async (req, res) => {
    const list = (await units.find({}).toArray()).map(listView);
    const byPhase = Object.fromEntries(PHASES.map((p) => [p, 0]));
    const byStage = {};
    for (const u of list) {
      byPhase[u.phase] += 1;
      if (['in_build', 'testing', 'planned'].includes(u.phase) && u.progress.current) byStage[u.progress.current.label] = (byStage[u.progress.current.label] || 0) + 1;
    }
    const month = today().slice(0, 7);
    const mine = list.flatMap((u) => u.stages.filter((s) => s.assigneeId === req.user._id && !['done', 'skipped'].includes(s.state)).map((s) => ({ unitId: u._id, serial: u.serial, model: u.model, key: s.key, label: s.label, state: s.state, targetDate: u.targetDate })));
    res.json({
      total: list.length,
      inProgress: byPhase.planned + byPhase.in_build + byPhase.testing,
      byPhase, byStage,
      late: list.filter((u) => u.late).map((u) => ({ _id: u._id, serial: u.serial, model: u.model, targetDate: u.targetDate, progress: u.progress })),
      blocked: list.filter((u) => u.progress.blocked).length,
      onHold: list.filter((u) => u.onHold).length,
      dispatchedThisMonth: list.filter((u) => (u.dispatchedOn || '').startsWith(month)).length,
      myStages: mine,
    });
  }));

  router.post('/units', requireUser('production.manage'), wrap(async (req, res) => {
    const { value, error } = normaliseUnit(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    const now = new Date();
    const doc = {
      _id: crypto.randomUUID(), serial: await nextSerial(value.model), colour: '', customer: { company: '', city: '' }, enquiryRef: '',
      orderedOn: today(), targetDate: null, dispatchedOn: null, installedOn: null, priority: 'normal', onHold: false, holdReason: '', description: '',
      ...value,
      stages: templateFor(value.model).map(newStage),
      notes: [], history: [{ at: now, by: req.user.name, text: 'Unit added' }], createdBy: req.user.name, createdAt: now, updatedAt: now,
    };
    if (value.model === 'NexC5' && !doc.colour) doc.colour = 'White';
    await units.insertOne(doc);
    res.status(201).json({ unit: view(doc) });
  }));

  const load = async (id) => units.findOne({ _id: String(id) });

  router.get('/units/:id', requireUser('production.view'), wrap(async (req, res) => {
    const u = await load(req.params.id);
    if (!u) return res.status(404).json({ error: 'Unit not found' });
    const project = u.projectId ? await db.collection('projects').findOne({ _id: u.projectId }, { projection: { ref: 1, name: 1, status: 1 } }) : null;
    res.json({ unit: { ...view(u), project } });
  }));

  router.patch('/units/:id', requireUser('production.manage'), wrap(async (req, res) => {
    const u = await load(req.params.id);
    if (!u) return res.status(404).json({ error: 'Unit not found' });
    const { value, error } = normaliseUnit(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    delete value.model; // the serial number belongs to the model
    const changes = [];
    if (value.onHold !== undefined && value.onHold !== !!u.onHold) changes.push(value.onHold ? `Put on hold${value.holdReason ? `: ${value.holdReason}` : ''}` : 'Taken off hold');
    if (value.dispatchedOn !== undefined && value.dispatchedOn !== u.dispatchedOn) changes.push(value.dispatchedOn ? `Dispatched on ${value.dispatchedOn}` : 'Dispatch date removed');
    if (value.installedOn !== undefined && value.installedOn !== u.installedOn) changes.push(value.installedOn ? `Installed on ${value.installedOn}` : 'Install date removed');
    if (value.targetDate !== undefined && value.targetDate !== u.targetDate) changes.push(`Target date ${value.targetDate || 'removed'}`);
    const update = { $set: { ...value, updatedAt: new Date() } };
    if (changes.length) update.$push = { history: event(req, changes.join(' · ')) };
    await units.updateOne({ _id: u._id }, update);
    res.json({ unit: view(await load(u._id)) });
  }));

  router.patch('/units/:id/stages/:key', requireUser('production.update_assigned'), wrap(async (req, res) => {
    const u = await load(req.params.id);
    if (!u) return res.status(404).json({ error: 'Unit not found' });
    const i = u.stages.findIndex((s) => s.key === req.params.key);
    if (i < 0) return res.status(404).json({ error: 'Stage not found' });
    const s = u.stages[i];
    const manager = can(req.user, 'production.manage');
    if (!manager && s.assigneeId !== req.user._id) return res.status(403).json({ error: 'Only the person this stage is given to, a lead or a founder can change it' });
    const b = req.body || {};
    const next = { ...s };
    const notes = [];
    if (b.state !== undefined) {
      if (!STAGE_STATES.includes(b.state)) return res.status(400).json({ error: `state must be one of ${STAGE_STATES.join(', ')}` });
      if (!manager && b.state === 'skipped') return res.status(403).json({ error: 'Only a lead can skip a stage' });
      if (b.state !== s.state) {
        next.state = b.state;
        if (b.state === 'in_progress' && !s.startedAt) next.startedAt = new Date();
        next.doneAt = b.state === 'done' ? new Date() : null;
        next.doneBy = b.state === 'done' ? req.user.name : null;
        notes.push({ done: `${s.label}: done`, in_progress: `${s.label}: started`, blocked: `${s.label}: blocked`, pending: `${s.label}: back to not started`, skipped: `${s.label}: skipped` }[b.state]);
      }
    }
    if (b.assigneeId !== undefined) {
      if (!manager) return res.status(403).json({ error: 'Only a lead or a founder can give a stage to someone' });
      if (b.assigneeId) {
        const a = await users.findOne({ _id: String(b.assigneeId), hidden: { $ne: true } });
        if (!a || a.active === false) return res.status(400).json({ error: 'That person was not found' });
        next.assigneeId = a._id; next.assignee = a.name;
        if (a._id !== s.assigneeId) notes.push(`${s.label}: given to ${a.name}`);
      } else { next.assigneeId = null; next.assignee = null; }
    }
    if (b.note !== undefined) { next.note = str(b.note, 500); if (next.state === 'blocked' && next.note) notes.push(`Blocked because: ${next.note}`); }
    const stages = [...u.stages];
    stages[i] = next;
    const update = { $set: { stages, updatedAt: new Date() } };
    if (notes.length) update.$push = { history: event(req, notes.join(' · ')) };
    await units.updateOne({ _id: u._id }, update);
    res.json({ unit: view(await load(u._id)) });
  }));

  router.post('/units/:id/stages', requireUser('production.manage'), wrap(async (req, res) => {
    const u = await load(req.params.id);
    if (!u) return res.status(404).json({ error: 'Unit not found' });
    const label = str(req.body?.label, 80);
    if (!label) return res.status(400).json({ error: 'A stage name is required' });
    const key = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'stage'}-${crypto.randomBytes(2).toString('hex')}`;
    const after = u.stages.findIndex((s) => s.key === req.body.after);
    const stages = [...u.stages];
    stages.splice(after < 0 ? stages.length : after + 1, 0, newStage([key, label, str(req.body.area, 40) || 'Other']));
    await units.updateOne({ _id: u._id }, { $set: { stages, updatedAt: new Date() }, $push: { history: event(req, `Stage added: ${label}`) } });
    res.status(201).json({ unit: view(await load(u._id)) });
  }));

  router.delete('/units/:id/stages/:key', requireUser('production.manage'), wrap(async (req, res) => {
    const u = await load(req.params.id);
    if (!u) return res.status(404).json({ error: 'Unit not found' });
    const s = u.stages.find((x) => x.key === req.params.key);
    if (!s) return res.status(404).json({ error: 'Stage not found' });
    await units.updateOne({ _id: u._id }, { $set: { stages: u.stages.filter((x) => x.key !== s.key), updatedAt: new Date() }, $push: { history: event(req, `Stage removed: ${s.label}`) } });
    res.json({ unit: view(await load(u._id)) });
  }));

  router.post('/units/:id/notes', requireUser('production.view'), wrap(async (req, res) => {
    const text = str(req.body?.text, 2000);
    if (!text) return res.status(400).json({ error: 'text is required' });
    const note = { id: crypto.randomUUID(), author: req.user.name, text, at: new Date() };
    const r = await units.updateOne({ _id: String(req.params.id) }, { $push: { notes: note }, $set: { updatedAt: note.at } });
    if (!r.matchedCount) return res.status(404).json({ error: 'Unit not found' });
    res.status(201).json({ note });
  }));

  router.delete('/units/:id', requireUser('production.delete'), wrap(async (req, res) => {
    const r = await units.deleteOne({ _id: String(req.params.id) });
    if (!r.deletedCount) return res.status(404).json({ error: 'Unit not found' });
    res.json({ ok: true });
  }));

  return { router, phaseOf, progressOf };
}

module.exports = { createProduction, MODELS, ROBOT_STAGES, STAGE_STATES, PHASES, phaseOf, progressOf };
