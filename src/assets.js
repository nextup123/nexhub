'use strict';

/**
 * Assets: every physical thing that goes into a project gets its own ID (a tag), down to a bag of bolts.
 *
 *   Project PRJ-4
 *   ├─ Panel           NX-000101-H   (assembly)
 *   │  ├─ Servo drive  NX-000102-K   (unit: one piece, its own tag; from stock line EE-3)
 *   │  ├─ Relay ×1     NX-000103-M   …one tag per relay
 *   │  └─ M4 screws    NX-000110-B   (lot: 40 pcs under one tag; from stock line MEC-7)
 *   ├─ Robot arm       NX-000120-C   (assembly)
 *   │  └─ Joint J1     NX-000121-E   (assembly inside an assembly)
 *   │     ├─ Servo motor  NX-000122-G
 *   │     └─ M6 bolts ×24 NX-000123-J
 *   └─ Computer        NX-000130-L   (assembly) → CPU, monitor, keyboard, mouse
 *
 * Tags: NX-<6 digits>-<check letter>. The letter catches a mistyped digit; a tag can be typed with or
 * without dashes, in any case, or by its number alone (123). Tags are never reused.
 *
 * Kinds: assembly (holds other assets: a panel, a robot arm, a computer, a joint), unit (one piece),
 * lot (a counted batch under one tag: nuts, bolts, cable, raw material).
 *
 * Stock: the inventory app keeps stock lines (EE-3 "Servo drive 750 W", 12 in the store). Taking parts
 * from stock into a project gives them tags and lowers the stock line; returning them puts the number back.
 * So the store count is what has no tag yet, and every tagged thing is accounted for in a project or the store.
 *
 *   GET    /assets?q=&projectId=none|<id>&kind=&status=&limit=   search (tag, name, make, model, serial, stock ref)
 *   GET    /assets/tag/:tag                       find by tag (scanner / typed)
 *   GET    /assets/:id                            the asset, the path above it, what is inside it, its history
 *   GET    /projects/:id/assets                   every asset of a project (the dashboard draws the tree) + totals
 *   GET    /projects/:id/assets/export.xlsx       bill of materials
 *   GET    /assets/labels.pdf?ids=a,b | projectId=  QR labels to print and stick on
 *   POST   /assets                                register: { kind, name, projectId, parentId, assemblyType, category, quantity,
 *                                                 unit, make, model, serial, location, notes,
 *                                                 fromStock: { itemId, quantity, mode: unit|lot, serials: [] } }
 *   PATCH  /assets/:id                            details, status (active, faulty, scrapped)
 *   GET    /inventory/projects                    projects with their assemblies (for "Assign to project")
 *   POST   /assets/assign                         many store items into a project at once:
 *                                                 { projectId, parentId?, assembly?: { name, assemblyType }, note?,
 *                                                   items: [{ itemId, quantity, mode?, serials? }] }  all or nothing
 *   POST   /assets/:id/move                       { projectId, parentId }  (the whole branch moves with it)
 *   POST   /assets/:id/return                     { quantity }  back to the store (an assembly: everything in it)
 *   DELETE /assets/:id                            a mistake: removed for good, stock put back       (assets.delete)
 */

const crypto = require('crypto');
const express = require('express');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const KINDS = { assembly: 'Assembly', unit: 'Single piece', lot: 'Lot' };
const STATUSES = { active: 'In use', faulty: 'Faulty', returned: 'Returned to store', scrapped: 'Scrapped' };
const ASSEMBLY_TYPES = ['Panel', 'Robot arm', 'Computer', 'Joint', 'Gripper', 'Conveyor', 'Fixture', 'Cabinet', 'Sub-assembly', 'Other'];
const MAX_UNITS = 200;

// ── Tags ────────────────────────────────────────────────────
const CHECK = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they read like 1 and 0
function checkLetter(seq) {
  const d = String(seq).padStart(6, '0');
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 7) + i;
  return CHECK[sum % CHECK.length];
}
const tagOf = (seq) => `NX-${String(seq).padStart(6, '0')}-${checkLetter(seq)}`;
/** "nx000123k", "NX-000123-K", "000123", "123" → { seq: 123, check: 'K' | '' }; null when it is not a tag. */
function parseTag(text) {
  const t = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = t.match(/^(?:NX)?(\d{1,7})([A-Z]?)$/);
  if (!m) return null;
  return { seq: Number(m[1]), check: m[2] };
}

function createAssets({ db, requireUser, open = false }) {
  // With INVENTORY_OPEN, the inventory app may list projects and assign stock without a login.
  const openUser = (perm) => (req, res, next) => (open && !req.user ? next() : requireUser(perm)(req, res, next));
  const assets = db.collection('assets');
  const items = db.collection('inventory_items');
  const projects = db.collection('projects');
  const counters = db.collection('counters');
  const router = express.Router();
  const who = (req) => (req.user && req.user.name) || str(req.get('x-user-name'), 60) || (open ? 'Inventory app' : 'hub');

  async function nextSeqs(n) {
    const r = await counters.findOneAndUpdate({ _id: 'asset' }, { $inc: { seq: n } }, { upsert: true, returnDocument: 'after' });
    return Array.from({ length: n }, (_, i) => r.seq - n + 1 + i);
  }
  const textOf = (a) => [a.tag, a.tag.replace(/-/g, ''), String(a.seq), a.name, a.assemblyType, a.make, a.model, a.serial, a.itemRef, a.location, a.notes].filter(Boolean).join(' ').toLowerCase();
  const PUBLIC = { searchText: 0 };
  const strip = (a) => { if (!a) return a; const { searchText, ...rest } = a; return rest; };
  const projectBrief = async (id) => (id ? projects.findOne({ _id: id }, { projection: { _id: 1, ref: 1, name: 1, status: 1 } }) : null);

  /** Every asset of the same project (or of the store), as a map, to walk branches in memory. */
  async function family(projectId) {
    const list = await assets.find({ projectId: projectId || null, status: { $in: ['active', 'faulty'] } }, { projection: PUBLIC }).toArray();
    return list;
  }
  function descendants(all, id) {
    const kids = new Map();
    all.forEach((a) => { if (a.parentId) { if (!kids.has(a.parentId)) kids.set(a.parentId, []); kids.get(a.parentId).push(a); } });
    const out = [];
    const walk = (pid) => (kids.get(pid) || []).forEach((c) => { out.push(c); walk(c._id); });
    walk(id);
    return out;
  }
  async function ancestorsOf(a) {
    const path = [];
    let cur = a;
    for (let i = 0; cur && cur.parentId && i < 30; i++) {
      cur = await assets.findOne({ _id: cur.parentId }, { projection: { _id: 1, tag: 1, name: 1, kind: 1, assemblyType: 1, parentId: 1 } });
      if (cur) path.unshift({ _id: cur._id, tag: cur.tag, name: cur.name, kind: cur.kind, assemblyType: cur.assemblyType });
    }
    return path;
  }
  const findAsset = async (id) => {
    let a = await assets.findOne({ _id: String(id) }, { projection: PUBLIC });
    if (!a) { const t = parseTag(id); if (t) a = await assets.findOne({ seq: t.seq }, { projection: PUBLIC }); }
    return a;
  };
  const where = async (a, project) => {
    const p = project === undefined ? await projectBrief(a.projectId) : project;
    const parent = a.parentId ? await assets.findOne({ _id: a.parentId }, { projection: { tag: 1, name: 1 } }) : null;
    return [p ? p.ref : 'store', parent ? `${parent.name} ${parent.tag}` : ''].filter(Boolean).join(' › ');
  };

  /** Where a new asset goes: a project, and maybe inside an assembly (which must be in the same project). */
  async function placeOf(body, selfId) {
    let parent = null;
    let projectId = body.projectId ? String(body.projectId) : null;
    if (body.parentId) {
      parent = await assets.findOne({ _id: String(body.parentId) });
      if (!parent) return { error: 'The assembly it goes into was not found' };
      if (parent.kind !== 'assembly') return { error: `${parent.tag} is a ${KINDS[parent.kind].toLowerCase()}, not an assembly: only assemblies hold other parts` };
      if (!['active', 'faulty'].includes(parent.status)) return { error: `${parent.tag} has been returned or scrapped` };
      if (selfId && (parent._id === selfId || (await ancestorsOf(parent)).some((x) => x._id === selfId))) return { error: 'An assembly cannot go inside itself' };
      projectId = parent.projectId || null;
    }
    let project = null;
    if (projectId) {
      project = await projectBrief(projectId);
      if (!project) return { error: 'Project not found' };
    }
    return { parent, project, projectId: project ? project._id : null, parentId: parent ? parent._id : null };
  }

  /** Check one line of a "take from stock" request against the store. */
  function planFromStock(item, line) {
    const n = Number(line.quantity);
    if (!Number.isInteger(n) || n < 1) return { error: `${item.name}: how many? A whole number, 1 or more` };
    if (n > item.quantity) return { error: `Only ${item.quantity} ${item.unit || 'pcs'} of ${item.name} in the store` };
    const mode = line.mode === 'lot' || line.mode === 'unit' ? line.mode : (item.tracking || 'unit');
    if (mode === 'unit' && n > MAX_UNITS) return { error: `${item.name}: up to ${MAX_UNITS} pieces with their own tags at a time; use one lot tag for more` };
    const serials = Array.isArray(line.serials) ? line.serials.map((x) => str(x, 80)) : String(line.serials || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
    return { n, mode, serials };
  }
  /** Take parts out of the store and make their tags (not saved yet). Fails if someone took the last ones first. */
  async function takeFromStock(item, { n, mode, serials }, base, placeNote, by, now) {
    const common = { ...base, category: item.category, itemId: item._id, itemRef: item.ref, name: base.name || item.name, unit: item.unit || 'pcs', make: base.make || item.make || '', model: base.model || item.model || '' };
    const seqs = await nextSeqs(mode === 'unit' ? n : 1);
    const docs = mode === 'unit'
      ? seqs.map((seq, i) => ({ ...common, seq, kind: 'unit', quantity: 1, serial: serials[i] || '' }))
      : [{ ...common, seq: seqs[0], kind: 'lot', quantity: n, serial: '' }];
    const took = await items.updateOne({ _id: item._id, quantity: { $gte: n } }, {
      $inc: { quantity: -n },
      $set: { updatedAt: now, updatedBy: by },
      $push: { history: { at: now, by, change: -n, quantity: item.quantity - n, note: `To ${placeNote} (${mode === 'unit' ? `${n} tag${n === 1 ? '' : 's'}` : `lot ${tagOf(seqs[0])}`})` } },
    });
    if (took.matchedCount === 0) return { error: `${item.name}: not enough left in the store. Reload and try again.` };
    return { docs };
  }
  async function saveNew(docs, by, now, placeNote) {
    for (const d of docs) {
      d._id = crypto.randomUUID();
      d.tag = tagOf(d.seq);
      d.history = [{ at: now, by, action: 'registered', note: d.itemRef ? `Moved from the store (${d.itemRef}) to ${placeNote}` : `Registered in ${placeNote}` }];
      d.searchText = textOf(d);
      await assets.insertOne(d);
    }
    return docs.map(strip);
  }

  // ── Assign to a project (many store items at once) ────────
  // The inventory app uses these too, so with INVENTORY_OPEN they work without a login (as "Inventory app").
  router.get('/inventory/projects', openUser('assets.view'), wrap(async (req, res) => {
    const list = await projects.find({}, { projection: { _id: 1, ref: 1, name: 1, status: 1, clientName: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(2000).toArray();
    const asm = await assets.find({ kind: 'assembly', status: { $in: ['active', 'faulty'] } }, { projection: { _id: 1, seq: 1, tag: 1, name: 1, assemblyType: 1, projectId: 1, parentId: 1 } }).toArray();
    const byProject = new Map();
    asm.filter((a) => a.projectId).sort((a, b) => a.seq - b.seq).forEach((a) => { if (!byProject.has(a.projectId)) byProject.set(a.projectId, []); byProject.get(a.projectId).push({ _id: a._id, tag: a.tag, name: a.name, assemblyType: a.assemblyType, parentId: a.parentId }); });
    res.json({ projects: list.map((p) => ({ _id: p._id, ref: p.ref, name: p.name, status: p.status, clientName: p.clientName || '', assemblies: byProject.get(p._id) || [] })) });
  }));

  router.post('/assets/assign', openUser('assets.manage'), wrap(async (req, res) => {
    const b = req.body || {};
    const lines = Array.isArray(b.items) ? b.items.filter((l) => l && l.itemId && Number(l.quantity) > 0) : [];
    if (!lines.length) return res.status(400).json({ error: 'Pick at least one item and how many' });
    if (lines.length > 300) return res.status(400).json({ error: 'Up to 300 items at a time' });
    if (!b.projectId && !b.parentId) return res.status(400).json({ error: 'Which project?' });
    const by = who(req);
    const now = new Date();
    // Check everything before anything leaves the store.
    const plans = [];
    const errors = [];
    const want = new Map();
    for (const l of lines) {
      const item = await items.findOne({ _id: String(l.itemId) });
      if (!item) { errors.push(`Item ${l.itemId} was not found`); continue; }
      want.set(item._id, (want.get(item._id) || 0) + Number(l.quantity));
      const plan = planFromStock(item, l);
      if (plan.error) errors.push(plan.error);
      else if (want.get(item._id) > item.quantity) errors.push(`Only ${item.quantity} ${item.unit || 'pcs'} of ${item.name} in the store`);
      else plans.push({ item, plan });
    }
    if (errors.length) return res.status(400).json({ error: errors.join('. '), errors });
    let place = await placeOf({ projectId: b.projectId, parentId: b.parentId });
    if (place.error) return res.status(400).json({ error: place.error });
    if (!place.project) return res.status(400).json({ error: 'Which project?' });
    // Optionally a new assembly to hold them (a panel, a computer…).
    const created = [];
    const asmName = str(b.assembly && b.assembly.name, 120);
    if (asmName) {
      const [seq] = await nextSeqs(1);
      const pn = [place.project.ref, place.parent ? `${place.parent.name} ${place.parent.tag}` : ''].filter(Boolean).join(' › ');
      const doc = { seq, kind: 'assembly', name: asmName, assemblyType: str(b.assembly.assemblyType, 40) || 'Other', quantity: 1, unit: 'pcs', serial: '', category: '', itemId: null, itemRef: '', projectId: place.projectId, parentId: place.parentId, status: 'active', make: '', model: '', location: '', notes: '', createdBy: by, createdAt: now, updatedBy: by, updatedAt: now };
      created.push(...await saveNew([doc], by, now, pn));
      place = { ...place, parent: { _id: doc._id, name: doc.name, tag: doc.tag }, parentId: doc._id };
    }
    const placeNote = [place.project.ref, place.parent ? `${place.parent.name} ${place.parent.tag}` : ''].filter(Boolean).join(' › ');
    const base = { projectId: place.projectId, parentId: place.parentId, status: 'active', make: '', model: '', location: '', notes: str(b.note, 2000), name: '', createdBy: by, createdAt: now, updatedBy: by, updatedAt: now };
    const done = [];
    for (const { item, plan } of plans) {
      const r = await takeFromStock(item, plan, base, placeNote, by, now);
      if (r.error) {
        // Someone took the last ones in the meantime: put back what this request already took.
        for (const d of done) await giveBack(d, d.quantity || 1, by, now, 'a cancelled assignment');
        if (done.length) await assets.deleteMany({ _id: { $in: done.map((d) => d._id) } });
        if (created.length) await assets.deleteMany({ _id: { $in: created.map((d) => d._id) } });
        return res.status(409).json({ error: r.error });
      }
      done.push(...await saveNew(r.docs, by, now, placeNote));
    }
    res.status(201).json({ project: place.project, parent: place.parent || null, assets: [...created, ...done], items: plans.length, pieces: plans.reduce((a, p) => a + p.plan.n, 0) });
  }));

  // ── Read ──────────────────────────────────────────────────
  router.get('/assets', requireUser('assets.view'), wrap(async (req, res) => {
    const f = {};
    if (req.query.projectId === 'none') f.projectId = null;
    else if (req.query.projectId) f.projectId = String(req.query.projectId);
    if (req.query.kind && KINDS[req.query.kind]) f.kind = req.query.kind;
    if (req.query.status && STATUSES[req.query.status]) f.status = req.query.status;
    else if (req.query.status !== 'all') f.status = { $in: ['active', 'faulty'] };
    if (req.query.itemId) f.itemId = String(req.query.itemId);
    const q = str(req.query.q, 80);
    const t = parseTag(q);
    let list;
    if (t && /\d/.test(q) && /^[\sa-z0-9-]*$/i.test(q) && (t.check || /^nx/i.test(q.trim()))) {
      list = await assets.find({ seq: t.seq }, { projection: PUBLIC }).toArray();
    } else {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      if (words.length) f.$and = words.map((w) => ({ searchText: { $regex: escapeRegex(w) } }));
      list = await assets.find(f, { projection: PUBLIC }).sort({ seq: -1 }).limit(Math.min(Number(req.query.limit) || 200, 2000)).toArray();
    }
    const pids = [...new Set(list.map((a) => a.projectId).filter(Boolean))];
    const ps = await Promise.all(pids.map(projectBrief));
    const pmap = new Map(ps.filter(Boolean).map((p) => [p._id, p]));
    res.json({ assets: list.map((a) => ({ ...a, project: pmap.get(a.projectId) || null })) });
  }));

  router.get('/assets/tag/:tag', requireUser('assets.view'), wrap(async (req, res) => {
    const t = parseTag(req.params.tag);
    if (!t) return res.status(400).json({ error: 'That does not look like a tag (NX-000123-K)' });
    if (t.check && t.check !== checkLetter(t.seq)) return res.status(400).json({ error: `The check letter does not match: ${tagOf(t.seq)} is the tag with number ${t.seq}. Is a digit mistyped?`, suggestion: tagOf(t.seq) });
    const a = await assets.findOne({ seq: t.seq }, { projection: { _id: 1, tag: 1 } });
    if (!a) return res.status(404).json({ error: `No asset with tag ${tagOf(t.seq)}` });
    res.json({ asset: a });
  }));

  router.get('/assets/labels.pdf', requireUser('assets.view'), wrap(async (req, res) => {
    let list;
    if (req.query.projectId) list = await assets.find({ projectId: String(req.query.projectId), status: { $in: ['active', 'faulty'] } }, { projection: PUBLIC }).toArray();
    else {
      const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2000);
      list = (await Promise.all(ids.map(findAsset))).filter(Boolean);
    }
    if (!list.length) return res.status(400).json({ error: 'Nothing to print' });
    list.sort((a, b) => a.seq - b.seq);
    const pids = [...new Set(list.map((a) => a.projectId).filter(Boolean))];
    const pmap = new Map((await Promise.all(pids.map(projectBrief))).filter(Boolean).map((p) => [p._id, p]));
    const buf = await labelsPdf(list, pmap);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="nextup-asset-labels-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(buf);
  }));

  router.get('/assets/:id', requireUser('assets.view'), wrap(async (req, res) => {
    const a = await findAsset(req.params.id);
    if (!a) return res.status(404).json({ error: 'Asset not found' });
    const [project, path, children, item] = await Promise.all([
      projectBrief(a.projectId),
      ancestorsOf(a),
      a.kind === 'assembly' ? assets.find({ parentId: a._id, status: { $in: ['active', 'faulty'] } }, { projection: PUBLIC }).sort({ seq: 1 }).toArray() : [],
      a.itemId ? items.findOne({ _id: a.itemId }, { projection: { _id: 1, ref: 1, name: 1, category: 1, quantity: 1, unit: 1 } }) : null,
    ]);
    let inside = 0;
    if (a.kind === 'assembly') inside = descendants(await family(a.projectId), a._id).length;
    res.json({ asset: a, project, path, children, inside, item });
  }));

  router.get('/projects/:id/assets', requireUser('assets.view'), wrap(async (req, res) => {
    const project = await projectBrief(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const list = await assets.find({ projectId: project._id, status: { $in: ['active', 'faulty'] } }, { projection: PUBLIC }).sort({ seq: 1 }).toArray();
    const totals = { assemblies: 0, units: 0, lots: 0, pieces: 0, tags: list.length };
    list.forEach((a) => { if (a.kind === 'assembly') totals.assemblies++; else if (a.kind === 'unit') { totals.units++; totals.pieces++; } else { totals.lots++; totals.pieces += a.quantity || 0; } });
    res.json({ project, assets: list, totals });
  }));

  router.get('/projects/:id/assets/export.xlsx', requireUser('assets.view'), wrap(async (req, res) => {
    const project = await projects.findOne({ _id: req.params.id }, { projection: { _id: 1, ref: 1, name: 1 } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const list = await assets.find({ projectId: project._id, status: { $in: ['active', 'faulty'] } }, { projection: PUBLIC }).sort({ seq: 1 }).toArray();
    const buf = await bomExcel(project, list, who(req));
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${project.ref}-bill-of-materials-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  }));

  // ── Register ──────────────────────────────────────────────
  router.post('/assets', requireUser('assets.manage'), wrap(async (req, res) => {
    const b = req.body || {};
    const place = await placeOf(b);
    if (place.error) return res.status(400).json({ error: place.error });
    const by = who(req);
    const now = new Date();
    const base = {
      projectId: place.projectId, parentId: place.parentId, status: 'active',
      make: str(b.make, 60), model: str(b.model, 60), location: str(b.location, 80), notes: str(b.notes, 2000),
      createdBy: by, createdAt: now, updatedBy: by, updatedAt: now,
    };
    const placeNote = [place.project ? place.project.ref : 'store', place.parent ? `${place.parent.name} ${place.parent.tag}` : ''].filter(Boolean).join(' › ');
    let docs = [];

    if (b.fromStock && b.fromStock.itemId) {
      const item = await items.findOne({ _id: String(b.fromStock.itemId) });
      if (!item) return res.status(404).json({ error: 'Stock item not found' });
      const plan = planFromStock(item, b.fromStock);
      if (plan.error) return res.status(400).json({ error: plan.error });
      const r = await takeFromStock(item, plan, { ...base, name: str(b.name, 120) }, placeNote, by, now);
      if (r.error) return res.status(409).json({ error: r.error });
      docs = r.docs;
    } else {
      const kind = KINDS[b.kind] ? b.kind : 'unit';
      const name = str(b.name, 120);
      if (!name) return res.status(400).json({ error: 'Name is required' });
      let quantity = 1;
      if (kind === 'lot') {
        quantity = Number(b.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'A lot needs a quantity' });
      }
      const [seq] = await nextSeqs(1);
      docs = [{
        ...base, seq, kind, name, quantity, unit: str(b.unit, 20) || 'pcs', serial: str(b.serial, 80),
        assemblyType: kind === 'assembly' ? (str(b.assemblyType, 40) || 'Other') : '', category: str(b.category, 30), itemId: null, itemRef: '',
      }];
    }
    res.status(201).json({ assets: await saveNew(docs, by, now, placeNote) });
  }));

  // ── Change ────────────────────────────────────────────────
  router.patch('/assets/:id', requireUser('assets.manage'), wrap(async (req, res) => {
    const a = await findAsset(req.params.id);
    if (!a) return res.status(404).json({ error: 'Asset not found' });
    const b = req.body || {};
    const set = {};
    for (const [k, max] of Object.entries({ name: 120, make: 60, model: 60, serial: 80, location: 80, notes: 2000, assemblyType: 40, unit: 20 })) if (b[k] !== undefined) set[k] = str(b[k], max);
    if (set.name === '') return res.status(400).json({ error: 'Name is required' });
    if (b.status !== undefined) {
      if (!['active', 'faulty', 'scrapped'].includes(b.status)) return res.status(400).json({ error: 'Status: active, faulty or scrapped (use Return to put it back in the store)' });
      set.status = b.status;
    }
    if (b.quantity !== undefined && a.kind === 'lot' && !a.itemId) {
      const q = Number(b.quantity);
      if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: 'Quantity must be more than 0' });
      set.quantity = q;
    }
    const now = new Date();
    const changed = Object.keys(set).filter((k) => String(set[k]) !== String(a[k] ?? ''));
    if (!changed.length) return res.json({ asset: a });
    const note = set.status && set.status !== a.status ? `Marked ${STATUSES[set.status].toLowerCase()}${b.note ? `: ${str(b.note, 200)}` : ''}` : `Changed ${changed.join(', ')}`;
    await assets.updateOne({ _id: a._id }, { $set: { ...set, searchText: textOf({ ...a, ...set }), updatedAt: now, updatedBy: who(req) }, $push: { history: { at: now, by: who(req), action: set.status && set.status !== a.status ? set.status : 'edited', note } } });
    res.json({ asset: await findAsset(a._id) });
  }));

  router.post('/assets/:id/move', requireUser('assets.manage'), wrap(async (req, res) => {
    const a = await findAsset(req.params.id);
    if (!a) return res.status(404).json({ error: 'Asset not found' });
    if (!['active', 'faulty'].includes(a.status)) return res.status(400).json({ error: `${a.tag} is ${STATUSES[a.status].toLowerCase()}` });
    const place = await placeOf(req.body || {}, a._id);
    if (place.error) return res.status(400).json({ error: place.error });
    const now = new Date();
    const by = who(req);
    const from = await where(a);
    const to = [place.project ? place.project.ref : 'store', place.parent ? `${place.parent.name} ${place.parent.tag}` : ''].filter(Boolean).join(' › ');
    const branch = a.kind === 'assembly' ? descendants(await family(a.projectId), a._id) : [];
    await assets.updateOne({ _id: a._id }, { $set: { projectId: place.projectId, parentId: place.parentId, updatedAt: now, updatedBy: by }, $push: { history: { at: now, by, action: 'moved', note: `${from} → ${to}` } } });
    // Everything inside goes with it.
    for (const d of branch) {
      if (d.projectId === place.projectId) continue;
      await assets.updateOne({ _id: d._id }, { $set: { projectId: place.projectId, updatedAt: now, updatedBy: by }, $push: { history: { at: now, by, action: 'moved', note: `With ${a.name} ${a.tag} → ${to}` } } });
    }
    res.json({ asset: await findAsset(a._id), moved: 1 + branch.length });
  }));

  /** Back to the store. Parts from a stock line go back into its count (the tag is retired, kept in the history). */
  async function giveBack(a, qty, by, now, why) {
    if (a.itemId) {
      const item = await items.findOne({ _id: a.itemId });
      if (item) {
        await items.updateOne({ _id: item._id }, { $inc: { quantity: qty }, $set: { updatedAt: now, updatedBy: by }, $push: { history: { at: now, by, change: qty, quantity: item.quantity + qty, note: `Back from ${why} (${a.tag})` } } });
      }
    }
  }
  router.post('/assets/:id/return', requireUser('assets.manage'), wrap(async (req, res) => {
    const a = await findAsset(req.params.id);
    if (!a) return res.status(404).json({ error: 'Asset not found' });
    if (!['active', 'faulty'].includes(a.status)) return res.status(400).json({ error: `${a.tag} is already ${STATUSES[a.status].toLowerCase()}` });
    const now = new Date();
    const by = who(req);
    const from = await where(a);
    const note = str(req.body?.note, 200);
    // Part of a lot.
    if (a.kind === 'lot' && req.body?.quantity !== undefined && Number(req.body.quantity) < a.quantity) {
      const q = Number(req.body.quantity);
      if (!(q > 0)) return res.status(400).json({ error: 'How many to return' });
      await giveBack(a, q, by, now, from);
      await assets.updateOne({ _id: a._id }, { $inc: { quantity: -q }, $set: { updatedAt: now, updatedBy: by }, $push: { history: { at: now, by, action: 'returned', note: `${q} ${a.unit} back to the store${note ? `: ${note}` : ''}` } } });
      return res.json({ asset: await findAsset(a._id), returned: 1 });
    }
    const branch = a.kind === 'assembly' ? descendants(await family(a.projectId), a._id) : [];
    for (const d of [...branch.reverse(), a]) {
      await giveBack(d, d.quantity || 1, by, now, from);
      // A part with a stock line goes back into the count; a thing registered on its own (a machine, a PC
      // bought for the project) stays registered, in the store, with its tag.
      const keep = !d.itemId && d.kind !== 'assembly';
      const set = keep ? { projectId: null, parentId: null, updatedAt: now, updatedBy: by } : { status: 'returned', returnedFrom: from, updatedAt: now, updatedBy: by };
      await assets.updateOne({ _id: d._id }, { $set: set, $push: { history: { at: now, by, action: 'returned', note: `${d === a ? '' : `With ${a.name} ${a.tag}: `}back to the store from ${from}${note ? `: ${note}` : ''}` } } });
    }
    res.json({ asset: await findAsset(a._id), returned: 1 + branch.length });
  }));

  router.delete('/assets/:id', requireUser('assets.delete'), wrap(async (req, res) => {
    const a = await findAsset(req.params.id);
    if (!a) return res.status(404).json({ error: 'Asset not found' });
    if (a.kind === 'assembly' && descendants(await family(a.projectId), a._id).length) return res.status(400).json({ error: 'Take the parts out first (return them, or move them)' });
    if (['active', 'faulty'].includes(a.status)) await giveBack(a, a.quantity || 1, who(req), new Date(), `deleted ${a.tag}`);
    await assets.deleteOne({ _id: a._id });
    res.json({ ok: true });
  }));

  return { router };
}

// ── Files ───────────────────────────────────────────────────
/** Bill of materials: the tree, one row per tag, indented by level, with totals per stock line. */
async function bomExcel(project, list, by) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = `Nextup hub (${by})`;
  const thin = { style: 'thin', color: { argb: 'FFDFE3EA' } };
  const head = (ws) => ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FF5B6576' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1F6' } }; c.border = { bottom: thin }; });

  const ws = wb.addWorksheet('Tree', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  ws.columns = [
    { header: 'Level', key: 'level', width: 7 }, { header: 'Tag', key: 'tag', width: 15 }, { header: 'Name', key: 'name', width: 40 },
    { header: 'Kind', key: 'kind', width: 13 }, { header: 'Quantity', key: 'quantity', width: 10 }, { header: 'Unit', key: 'unit', width: 7 },
    { header: 'Stock ref', key: 'itemRef', width: 10 }, { header: 'Make', key: 'make', width: 16 }, { header: 'Model', key: 'model', width: 18 },
    { header: 'Serial', key: 'serial', width: 18 }, { header: 'Status', key: 'status', width: 12 }, { header: 'Inside', key: 'parent', width: 16 },
  ];
  const kids = new Map();
  const ids = new Set(list.map((a) => a._id));
  list.forEach((a) => { const p = a.parentId && ids.has(a.parentId) ? a.parentId : ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(a); });
  const byId = new Map(list.map((a) => [a._id, a]));
  const walk = (pid, level) => (kids.get(pid) || []).forEach((a) => {
    const r = ws.addRow({ ...a, level, name: `${'    '.repeat(level - 1)}${a.name}`, kind: a.kind === 'assembly' ? (a.assemblyType || 'Assembly') : KINDS[a.kind], status: STATUSES[a.status], parent: a.parentId ? byId.get(a.parentId)?.tag || '' : '' });
    if (a.kind === 'assembly') r.font = { bold: true };
    r.eachCell((c) => { c.border = { bottom: thin }; });
    walk(a._id, level + 1);
  });
  walk('', 1);
  head(ws);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 12 } };

  const sum = wb.addWorksheet('Totals by part', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  sum.columns = [{ header: 'Stock ref', key: 'ref', width: 10 }, { header: 'Part', key: 'name', width: 40 }, { header: 'Quantity', key: 'q', width: 10 }, { header: 'Unit', key: 'unit', width: 7 }, { header: 'Tags', key: 'tags', width: 8 }];
  const g = new Map();
  list.filter((a) => a.kind !== 'assembly').forEach((a) => {
    const k = a.itemRef || `~${a.name}`;
    const x = g.get(k) || { ref: a.itemRef || '', name: a.name, q: 0, unit: a.unit, tags: 0 };
    x.q += a.quantity || 1; x.tags += 1; g.set(k, x);
  });
  [...g.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((x) => sum.addRow(x).eachCell((c) => { c.border = { bottom: thin }; }));
  head(sum);
  return wb.xlsx.writeBuffer();
}

/** A4 sheet of 3 × 8 labels: QR code of the tag, the tag, the name, where it is. */
async function labelsPdf(list, pmap) {
  const PDFDocument = require('pdfkit');
  const QR = require('qrcode');
  const qrs = await Promise.all(list.map((a) => QR.toBuffer(a.tag, { margin: 0, scale: 6, errorCorrectionLevel: 'M', color: { dark: '#1f2733', light: '#ffffff' } })));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Nextup asset labels' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const mm = 72 / 25.4;
    const cols = 3; const rows = 8;
    const W = 70 * mm; const H = 37 * mm;
    const left = (doc.page.width - cols * W) / 2; const top = (doc.page.height - rows * H) / 2;
    list.forEach((a, i) => {
      const n = i % (cols * rows);
      if (i && n === 0) doc.addPage();
      const x = left + (n % cols) * W; const y = top + Math.floor(n / cols) * H;
      doc.rect(x + 2, y + 2, W - 4, H - 4).lineWidth(0.4).dash(2, { space: 2 }).strokeColor('#c9ced8').stroke().undash();
      const q = H - 16;
      doc.image(qrs[i], x + 8, y + 8, { width: q, height: q });
      const tx = x + 14 + q; const tw = W - q - 22;
      doc.font('Courier-Bold').fontSize(11).fillColor('#1f2733').text(a.tag, tx, y + 10, { width: tw, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#2a3240').text(a.name, tx, y + 26, { width: tw, height: 22, ellipsis: true });
      const p = pmap.get(a.projectId);
      const meta = [a.kind === 'lot' ? `${a.quantity} ${a.unit}` : a.kind === 'assembly' ? a.assemblyType : a.serial ? `S/N ${a.serial}` : '', p ? p.ref : 'Store', a.itemRef].filter(Boolean).join(' · ');
      doc.font('Helvetica').fontSize(7).fillColor('#6b7383').text(meta, tx, y + H - 20, { width: tw, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(6).fillColor('#9aa1ad').text('Nextup Robotics', tx, y + H - 12, { width: tw, lineBreak: false });
    });
    doc.end();
  });
}

module.exports = { createAssets, tagOf, parseTag, checkLetter, KINDS, STATUSES, ASSEMBLY_TYPES };
