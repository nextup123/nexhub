'use strict';

/**
 * Inventory: what the company owns, in three groups.
 *
 *   it      IT gadgets: CPUs, monitors, keyboards, laptops, printers, routers…
 *   panel   panel items: SMPS, drives, motors, PLCs, relays, contactors, MCBs, sensors…
 *   robot   robot items: whole robots (20 kg payload robot, 6 Nos), controllers, pendants, spares…
 *
 * Each item has a name and a quantity, and optionally type, make, model, specs, unit, location,
 * condition, minimum stock (low-stock flag), assigned to, payload (robots), serial numbers,
 * supplier, purchase date, unit price and notes. Every quantity change is kept in `history`.
 *
 *   GET    /inventory/meta                     groups, type suggestions, conditions, CSV columns
 *   GET    /inventory/summary                  per group: items, total quantity, low stock
 *   GET    /inventory?category=&q=&type=&condition=&low=1&sort=name|quantity|updated|type
 *   POST   /inventory                          { category, name, quantity, … }                   (inventory.manage)
 *   GET    /inventory/:id
 *   PATCH  /inventory/:id                      any of the fields                                 (inventory.manage)
 *   POST   /inventory/:id/adjust               { delta, note }  stock in (+) or out (−)          (inventory.manage)
 *   DELETE /inventory/:id                                                                        (inventory.delete)
 *   POST   /inventory/bulk-delete              { ids: [...] }                                    (inventory.delete)
 *   GET    /inventory/template.csv?category=   an empty CSV with the columns and one example row
 *   POST   /inventory/import                   { category, csv | rows, dryRun, onExisting }      (inventory.manage)
 *                                              onExisting: update (default: quantity and filled fields from the file),
 *                                              add (file quantity added to the stock), skip
 *   GET    /inventory/export.xlsx?category=&q=…   Excel: a summary sheet and one sheet per group
 *   GET    /inventory/export.pdf?category=&q=…    PDF: A4 landscape, a table per group
 *
 * Collection inventory_items. Refs: IT-12, PNL-4, RBT-3 (counters inventory_it / _panel / _robot).
 */

const crypto = require('crypto');
const express = require('express');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nameKey = (s) => str(s, 160).toLowerCase().replace(/\s+/g, ' ');

const CATEGORIES = {
  it: {
    label: 'IT gadgets', short: 'IT', prefix: 'IT',
    types: ['CPU', 'Monitor', 'Keyboard', 'Mouse', 'Laptop', 'Printer', 'Router / switch', 'UPS', 'Webcam', 'Headset', 'Hard disk', 'Cable', 'Other'],
    example: { name: 'Dell 24" monitor', quantity: '5', type: 'Monitor', make: 'Dell', model: 'P2422H', specs: '24 inch, 1080p', location: 'Office, first floor', assignedTo: '' },
  },
  panel: {
    label: 'Panel items', short: 'Panel', prefix: 'PNL',
    types: ['SMPS', 'Servo drive', 'Stepper driver', 'VFD', 'Servo motor', 'Stepper motor', 'Motor', 'PLC', 'HMI', 'Relay', 'Contactor', 'MCB', 'Sensor', 'Terminal block', 'Cable', 'Other'],
    example: { name: '24 V 10 A SMPS', quantity: '12', type: 'SMPS', make: 'Mean Well', model: 'LRS-250-24', specs: '24 V DC, 10.4 A', location: 'Store, rack B2', assignedTo: '' },
  },
  robot: {
    label: 'Robot items', short: 'Robot', prefix: 'RBT',
    types: ['Robot', 'Controller', 'Teach pendant', 'Gripper', 'Joint module', 'Spare part', 'Other'],
    example: { name: '20 kg payload robot', quantity: '6', type: 'Robot', make: 'Nextup', model: 'NexR20', payloadKg: '20', specs: '1.8 m reach', location: 'Assembly bay', assignedTo: '' },
  },
};
const CATEGORY_KEYS = Object.keys(CATEGORIES);
const CONDITIONS = { new: 'New', working: 'Working', needs_repair: 'Needs repair', faulty: 'Faulty', scrapped: 'Scrapped' };

// The columns of a CSV file (import, template). `category` is only needed when one file has several groups.
const COLUMNS = ['category', 'ref', 'name', 'quantity', 'unit', 'type', 'make', 'model', 'payloadKg', 'specs', 'location', 'condition', 'minQuantity', 'assignedTo', 'serials', 'supplier', 'purchasedOn', 'unitPrice', 'notes'];
const ALIASES = {
  item: 'name', itemname: 'name', assetname: 'name', asset: 'name', description: 'name', product: 'name', particulars: 'name',
  qty: 'quantity', quantity: 'quantity', nos: 'quantity', no: 'quantity', count: 'quantity', stock: 'quantity', units: 'quantity',
  uom: 'unit', unitofmeasure: 'unit',
  kind: 'type', itemtype: 'type', subcategory: 'type',
  brand: 'make', manufacturer: 'make', company: 'make', modelno: 'model', modelnumber: 'model', partno: 'model', partnumber: 'model',
  payload: 'payloadKg', payloadkg: 'payloadKg',
  specification: 'specs', specifications: 'specs', spec: 'specs', rating: 'specs',
  place: 'location', storedat: 'location', rack: 'location', store: 'location',
  status: 'condition', state: 'condition',
  min: 'minQuantity', minqty: 'minQuantity', minimum: 'minQuantity', minquantity: 'minQuantity', reorderlevel: 'minQuantity', minstock: 'minQuantity',
  assigned: 'assignedTo', assignedto: 'assignedTo', user: 'assignedTo', owner: 'assignedTo', issuedto: 'assignedTo',
  serial: 'serials', serialno: 'serials', serialnumber: 'serials', serialnumbers: 'serials',
  vendor: 'supplier', purchasedate: 'purchasedOn', purchasedon: 'purchasedOn', dateofpurchase: 'purchasedOn', boughton: 'purchasedOn',
  price: 'unitPrice', rate: 'unitPrice', cost: 'unitPrice', unitprice: 'unitPrice', unitcost: 'unitPrice',
  remarks: 'notes', remark: 'notes', comment: 'notes', comments: 'notes', note: 'notes',
  group: 'category', section: 'category', categoryname: 'category', id: 'ref', code: 'ref', assetcode: 'ref', assetid: 'ref',
};
const MAX_ROWS = 5000;

function columnFor(header) {
  const k = key(header);
  return COLUMNS.find((c) => key(c) === k) || ALIASES[k] || null;
}

/** "it", "IT gadgets", "Panel", "robot specific" → it | panel | robot. */
function categoryOf(v) {
  const k = key(v);
  if (!k) return '';
  if (CATEGORY_KEYS.includes(k)) return k;
  if (/^(it|itgadget|gadget|computer|office)/.test(k)) return 'it';
  if (/^(panel|pnl|electrical|electric)/.test(k)) return 'panel';
  if (/^(robot|rbt)/.test(k)) return 'robot';
  return '';
}
function conditionOf(v) {
  const k = key(v);
  if (!k) return '';
  if (CONDITIONS[v]) return v;
  if (/^new/.test(k)) return 'new';
  if (/^(working|good|ok|inuse|used|fine)/.test(k)) return 'working';
  if (/(repair|service)/.test(k)) return 'needs_repair';
  if (/^(faulty|broken|dead|damaged|notworking)/.test(k)) return 'faulty';
  if (/^(scrap|retired|disposed)/.test(k)) return 'scrapped';
  return null;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** 2026-11-18, 18-11-2026, 18/11/2026, 18.11.2026 (day first) or 18 Nov 2026 → 2026-11-18. */
function dateOf(v) {
  const s = str(v, 40);
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, mo, y] = m;
  else if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/))) { d = m[1]; mo = MONTHS.indexOf(m[2].toLowerCase()) + 1; y = m[3]; }
  else return null;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (Number.isNaN(dt.getTime()) || dt.getUTCDate() !== +d) return null;
  return dt.toISOString().slice(0, 10);
}
const numOf = (v) => {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(String(v).replace(/[,₹\s]/g, '').replace(/^rs\.?/i, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Checks and cleans an item. `partial`: only the fields given (PATCH). Returns { value, error }.
 * Numbers may arrive as text (forms, CSV).
 */
function normaliseItem(input = {}, { partial = false } = {}) {
  const v = {};
  const has = (k) => input[k] !== undefined;
  if (!partial || has('category')) {
    v.category = categoryOf(input.category);
    if (!v.category) return { error: 'category must be it, panel or robot' };
  }
  if (!partial || has('name')) {
    v.name = str(input.name, 120);
    if (!v.name) return { error: 'Name is required' };
  }
  if (!partial || has('quantity')) {
    const q = numOf(input.quantity);
    if (q === '' || q === null || !Number.isInteger(q) || q < 0 || q > 1e7) return { error: 'Quantity must be a whole number, 0 or more' };
    v.quantity = q;
  }
  const texts = { unit: 20, type: 60, make: 60, model: 60, specs: 300, location: 80, assignedTo: 80, serials: 2000, supplier: 120, notes: 2000 };
  for (const [k, max] of Object.entries(texts)) if (!partial || has(k)) v[k] = str(input[k], max);
  if (!partial && !v.unit) v.unit = 'pcs';
  if (partial && has('unit') && !v.unit) v.unit = 'pcs';
  if (!partial || has('condition')) {
    const c = conditionOf(input.condition);
    if (c === null) return { error: `Condition must be one of: ${Object.values(CONDITIONS).join(', ')}` };
    v.condition = c || 'working';
  }
  if (!partial || has('minQuantity')) {
    const n = numOf(input.minQuantity);
    if (n === null || (n !== '' && (!Number.isInteger(n) || n < 0))) return { error: 'Minimum stock must be a whole number' };
    v.minQuantity = n === '' ? null : n;
  }
  if (!partial || has('payloadKg')) {
    const n = numOf(input.payloadKg);
    if (n === null || (n !== '' && (n < 0 || n > 5000))) return { error: 'Payload must be a number of kg' };
    v.payloadKg = n === '' ? null : n;
  }
  if (!partial || has('unitPrice')) {
    const n = numOf(input.unitPrice);
    if (n === null || (n !== '' && n < 0)) return { error: 'Unit price must be a number' };
    v.unitPrice = n === '' ? null : Math.round(n * 100) / 100;
  }
  if (!partial || has('purchasedOn')) {
    const d = dateOf(input.purchasedOn);
    if (d === null) return { error: 'Purchase date: use 2026-11-27 or 27/11/2026' };
    v.purchasedOn = d;
  }
  return { value: v };
}

const searchTextOf = (d) => [d.ref, d.name, d.type, d.make, d.model, d.specs, d.location, d.assignedTo, d.serials, d.supplier, d.notes, d.payloadKg ? `${d.payloadKg} kg` : '']
  .filter(Boolean).join(' ').toLowerCase();
const isLow = (d) => d.minQuantity != null && d.quantity <= d.minQuantity;

// ── CSV ─────────────────────────────────────────────────────
/** Reads CSV text (comma, semicolon or tab; quotes; Excel's BOM) into an array of rows (arrays). */
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}
/** CSV text → objects keyed by column (loose headers matched), plus the headers that were not understood. */
function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], unknown: [] };
  const headers = rows[0].map((h) => columnFor(h));
  const unknown = rows[0].filter((h, i) => !headers[i] && String(h).trim());
  return {
    unknown,
    rows: rows.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => { if (h && r[i] !== undefined && String(r[i]).trim() !== '') o[h] = String(r[i]).trim(); });
      return o;
    }),
  };
}
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── Router ──────────────────────────────────────────────────
function createInventory({ db, requireUser: requireLogin, open = false }) {
  // INVENTORY_OPEN: nobody signed in may still use the inventory (as "Inventory app"). Someone signed in
  // is checked against their role as usual. Turn it off with INVENTORY_OPEN=false on Render.
  const requireUser = (perm) => (req, res, next) => {
    if (open && !req.user) { res.set('Cache-Control', 'no-store'); return next(); }
    return requireLogin(perm)(req, res, next);
  };
  const items = db.collection('inventory_items');
  const counters = db.collection('counters');
  const router = express.Router();
  const who = (req) => (req.user && req.user.name) || str(req.get('x-user-name'), 60) || 'Inventory app';

  async function nextRef(category) {
    const r = await counters.findOneAndUpdate({ _id: `inventory_${category}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    return `${CATEGORIES[category].prefix}-${r.seq}`;
  }

  function listFilter(q) {
    const f = {};
    const cat = categoryOf(q.category);
    if (cat) f.category = cat;
    if (q.type) f.type = str(q.type, 60);
    if (q.condition && CONDITIONS[q.condition]) f.condition = q.condition;
    const words = str(q.q, 120).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (words.length) f.$and = words.map((w) => ({ searchText: { $regex: escapeRegex(w) } }));
    return f;
  }
  const SORTS = {
    name: (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }),
    quantity: (a, b) => b.quantity - a.quantity || SORTS.name(a, b),
    updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    type: (a, b) => (a.type || '~').localeCompare(b.type || '~') || SORTS.name(a, b),
    ref: (a, b) => a.category.localeCompare(b.category) || (a.seq || 0) - (b.seq || 0),
  };
  async function list(q) {
    let docs = await items.find(listFilter(q), { projection: { history: 0, searchText: 0, nameKey: 0 } }).limit(20000).toArray();
    if (q.low === '1' || q.low === 'true') docs = docs.filter(isLow);
    docs.sort(SORTS[q.sort] || SORTS.name);
    return docs.map((d) => ({ ...d, low: isLow(d) }));
  }

  const PUBLIC = { searchText: 0, nameKey: 0 };
  const findItem = (id) => items.findOne({ $or: [{ _id: String(id) }, { ref: String(id).toUpperCase() }] }, { projection: PUBLIC });

  async function create(value, by) {
    const now = new Date();
    const ref = await nextRef(value.category);
    const doc = { _id: crypto.randomUUID(), ref, seq: Number(ref.split('-')[1]), ...value, nameKey: nameKey(value.name), createdBy: by, createdAt: now, updatedBy: by, updatedAt: now, history: [{ at: now, by, change: value.quantity, quantity: value.quantity, note: 'Added' }] };
    doc.searchText = searchTextOf(doc);
    await items.insertOne(doc);
    const { searchText, nameKey: _n, ...out } = doc;
    return { ...out, low: isLow(doc) };
  }

  router.get('/inventory/meta', requireUser('inventory.view'), (req, res) => {
    res.json({
      categories: CATEGORY_KEYS.map((k) => ({ key: k, label: CATEGORIES[k].label, short: CATEGORIES[k].short, prefix: CATEGORIES[k].prefix, types: CATEGORIES[k].types, example: CATEGORIES[k].example })),
      conditions: Object.entries(CONDITIONS).map(([k, label]) => ({ key: k, label })),
      columns: COLUMNS,
      maxRows: MAX_ROWS,
    });
  });

  router.get('/inventory/summary', requireUser('inventory.view'), wrap(async (req, res) => {
    const docs = await items.find({}, { projection: { category: 1, quantity: 1, minQuantity: 1, condition: 1, unitPrice: 1, updatedAt: 1 } }).toArray();
    const out = {};
    for (const k of CATEGORY_KEYS) out[k] = { key: k, label: CATEGORIES[k].label, items: 0, quantity: 0, low: 0, needsAttention: 0, value: 0, lastUpdated: null };
    for (const d of docs) {
      const s = out[d.category];
      if (!s) continue;
      s.items += 1;
      s.quantity += d.quantity || 0;
      if (isLow(d)) s.low += 1;
      if (d.condition === 'needs_repair' || d.condition === 'faulty') s.needsAttention += 1;
      if (d.unitPrice) s.value += d.unitPrice * (d.quantity || 0);
      if (!s.lastUpdated || new Date(d.updatedAt) > new Date(s.lastUpdated)) s.lastUpdated = d.updatedAt;
    }
    res.json({ categories: CATEGORY_KEYS.map((k) => out[k]) });
  }));

  router.get('/inventory/template.csv', requireUser('inventory.view'), (req, res) => {
    const cat = categoryOf(req.query.category);
    const cols = COLUMNS.filter((c) => c !== 'ref' && (cat ? c !== 'category' : true) && (cat === 'robot' || c !== 'payloadKg' || !cat));
    const examples = cat ? [{ ...CATEGORIES[cat].example }] : CATEGORY_KEYS.map((k) => ({ category: k, ...CATEGORIES[k].example }));
    const lines = [cols.join(','), ...examples.map((e) => cols.map((c) => csvCell(c === 'unit' ? 'pcs' : c === 'condition' ? 'Working' : e[c])).join(','))];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="nextup-inventory-${cat || 'all'}-template.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  router.get('/inventory/export.xlsx', requireUser('inventory.view'), wrap(async (req, res) => {
    const docs = await list(req.query);
    const buf = await excelOf(docs, { by: who(req), category: categoryOf(req.query.category) });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${fileName(req.query, 'xlsx')}"`);
    res.send(Buffer.from(buf));
  }));

  router.get('/inventory/export.pdf', requireUser('inventory.view'), wrap(async (req, res) => {
    const docs = await list(req.query);
    const buf = await pdfOf(docs, { by: who(req), category: categoryOf(req.query.category), q: str(req.query.q, 120) });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${fileName(req.query, 'pdf')}"`);
    res.send(buf);
  }));

  router.get('/inventory', requireUser('inventory.view'), wrap(async (req, res) => {
    const docs = await list(req.query);
    res.json({ items: docs, total: docs.length, quantity: docs.reduce((a, d) => a + (d.quantity || 0), 0) });
  }));

  router.post('/inventory', requireUser('inventory.manage'), wrap(async (req, res) => {
    const { value, error } = normaliseItem(req.body || {});
    if (error) return res.status(400).json({ error });
    res.status(201).json({ item: await create(value, who(req)) });
  }));

  router.post('/inventory/bulk-delete', requireUser('inventory.delete'), wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 5000) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids is required' });
    const r = await items.deleteMany({ _id: { $in: ids } });
    res.json({ deleted: r.deletedCount });
  }));

  router.post('/inventory/import', requireUser('inventory.manage'), wrap(async (req, res) => {
    const body = req.body || {};
    const pageCat = categoryOf(body.category);
    let rows = Array.isArray(body.rows) ? body.rows : null;
    let unknown = [];
    if (!rows) {
      if (typeof body.csv !== 'string' || !body.csv.trim()) return res.status(400).json({ error: 'Send the CSV file (csv) or rows' });
      ({ rows, unknown } = csvToObjects(body.csv));
    } else {
      rows = rows.map((r) => {
        const o = {};
        Object.entries(r || {}).forEach(([h, v]) => { const c = columnFor(h); if (c && v !== undefined && v !== null && String(v).trim() !== '') o[c] = String(v).trim(); });
        return o;
      });
    }
    if (!rows.length) return res.status(400).json({ error: 'The file has no rows under the header' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ error: `Up to ${MAX_ROWS} rows at a time` });
    const onExisting = ['update', 'add', 'skip'].includes(body.onExisting) ? body.onExisting : 'update';
    const dryRun = body.dryRun !== false && body.dryRun !== 'false';
    const by = who(req);

    const results = [];
    const counts = { added: 0, updated: 0, skipped: 0, failed: 0 };
    // Items already in the hub, by ref and by group + name + model (so a re-import does not double them).
    const existing = await items.find({}, { projection: { _id: 1, ref: 1, category: 1, nameKey: 1, model: 1, quantity: 1 } }).toArray();
    const byRef = new Map(existing.map((d) => [d.ref, d]));
    const sameKey = (c, n, m) => `${c}|${nameKey(n)}|${nameKey(m)}`;
    const byName = new Map(existing.map((d) => [sameKey(d.category, d.nameKey, d.model || ''), d]));
    const seenInFile = new Map();

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const line = i + 2;
      const fileCat = categoryOf(raw.category);
      if (raw.category && !fileCat) { counts.failed++; results.push({ line, name: raw.name || '', outcome: 'failed', message: `Unknown category "${raw.category}" (use IT, Panel or Robot)` }); continue; }
      const category = fileCat || pageCat;
      if (!category) { counts.failed++; results.push({ line, name: raw.name || '', outcome: 'failed', message: 'No category: add a category column, or import from one of the three pages' }); continue; }
      if (pageCat && fileCat && fileCat !== pageCat) { counts.failed++; results.push({ line, name: raw.name || '', outcome: 'failed', message: `This row is for ${CATEGORIES[fileCat].label}, not ${CATEGORIES[pageCat].label}` }); continue; }

      const ref = str(raw.ref, 20).toUpperCase();
      const found = (ref && byRef.get(ref)) || byName.get(sameKey(category, raw.name || '', raw.model || '')) || seenInFile.get(sameKey(category, raw.name || '', raw.model || ''));
      if (found && found.category !== category) { counts.failed++; results.push({ line, name: raw.name || '', outcome: 'failed', message: `${ref} is in ${CATEGORIES[found.category].label}` }); continue; }

      if (found) {
        if (onExisting === 'skip') { counts.skipped++; results.push({ line, name: raw.name || found.ref, ref: found.ref, outcome: 'skipped', message: 'Already in the inventory' }); continue; }
        // Only the columns that have a value change the item.
        const given = { ...raw };
        delete given.category; delete given.ref;
        const { value, error } = normaliseItem(given, { partial: true });
        if (error) { counts.failed++; results.push({ line, name: raw.name || found.ref, outcome: 'failed', message: error }); continue; }
        const before = found.quantity || 0;
        if ('quantity' in value && onExisting === 'add') value.quantity = before + value.quantity;
        const change = 'quantity' in value ? value.quantity - before : 0;
        if (!dryRun) {
          const now = new Date();
          const cur = await items.findOne({ _id: found._id });
          const next = { ...cur, ...value };
          const update = { $set: { ...value, nameKey: nameKey(next.name), searchText: searchTextOf(next), updatedAt: now, updatedBy: by } };
          if (change) update.$push = { history: { at: now, by, change, quantity: value.quantity, note: 'CSV import' } };
          await items.updateOne({ _id: found._id }, update);
        }
        found.quantity = 'quantity' in value ? value.quantity : before;
        counts.updated++;
        results.push({ line, name: raw.name || found.ref, ref: found.ref, outcome: 'updated', message: change ? `Quantity ${before} → ${found.quantity}` : 'Details updated' });
        continue;
      }

      const { value, error } = normaliseItem({ ...raw, category });
      if (error) { counts.failed++; results.push({ line, name: raw.name || '', outcome: 'failed', message: error }); continue; }
      let refOut = '';
      if (!dryRun) {
        const item = await create(value, by);
        refOut = item.ref;
        seenInFile.set(sameKey(category, value.name, value.model), { _id: item._id, ref: item.ref, category, quantity: item.quantity });
      } else seenInFile.set(sameKey(category, value.name, value.model), { _id: `new${i}`, ref: '(new)', category, quantity: value.quantity });
      counts.added++;
      results.push({ line, name: value.name, ref: refOut, outcome: 'added', message: `${value.quantity} ${value.unit} · ${CATEGORIES[category].label}` });
    }
    res.json({ dryRun, onExisting, counts, results, unknownColumns: unknown });
  }));

  router.get('/inventory/:id', requireUser('inventory.view'), wrap(async (req, res) => {
    const item = await findItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: { ...item, low: isLow(item) } });
  }));

  router.patch('/inventory/:id', requireUser('inventory.manage'), wrap(async (req, res) => {
    const cur = await items.findOne({ $or: [{ _id: String(req.params.id) }, { ref: String(req.params.id).toUpperCase() }] });
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    const body = { ...(req.body || {}) };
    delete body.ref; delete body._id; delete body.history;
    const { value, error } = normaliseItem(body, { partial: true });
    if (error) return res.status(400).json({ error });
    if (value.category && value.category !== cur.category) return res.status(400).json({ error: 'An item cannot move to another group; delete it and add it there' });
    const now = new Date();
    const by = who(req);
    const next = { ...cur, ...value };
    const update = { $set: { ...value, nameKey: nameKey(next.name), searchText: searchTextOf(next), updatedAt: now, updatedBy: by } };
    if ('quantity' in value && value.quantity !== cur.quantity) {
      update.$push = { history: { at: now, by, change: value.quantity - cur.quantity, quantity: value.quantity, note: str(req.body?.note, 200) || 'Edited' } };
    }
    await items.updateOne({ _id: cur._id }, update);
    const item = await findItem(cur._id);
    res.json({ item: { ...item, low: isLow(item) } });
  }));

  router.post('/inventory/:id/adjust', requireUser('inventory.manage'), wrap(async (req, res) => {
    const delta = Number(req.body?.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1e7) return res.status(400).json({ error: 'delta must be a whole number, not 0' });
    const cur = await items.findOne({ $or: [{ _id: String(req.params.id) }, { ref: String(req.params.id).toUpperCase() }] });
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    const quantity = cur.quantity + delta;
    if (quantity < 0) return res.status(400).json({ error: `Only ${cur.quantity} in stock` });
    const now = new Date();
    const by = who(req);
    await items.updateOne({ _id: cur._id }, {
      $set: { quantity, updatedAt: now, updatedBy: by },
      $push: { history: { at: now, by, change: delta, quantity, note: str(req.body?.note, 200) || (delta > 0 ? 'Stock in' : 'Stock out') } },
    });
    const item = await findItem(cur._id);
    res.json({ item: { ...item, low: isLow(item) } });
  }));

  router.delete('/inventory/:id', requireUser('inventory.delete'), wrap(async (req, res) => {
    const r = await items.deleteOne({ $or: [{ _id: String(req.params.id) }, { ref: String(req.params.id).toUpperCase() }] });
    if (!r.deletedCount) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  }));

  return { router };
}

// ── Exports ─────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
function fileName(q, ext) {
  const cat = categoryOf(q.category);
  return `nextup-inventory-${cat ? CATEGORIES[cat].short.toLowerCase() : 'all'}-${today()}.${ext}`;
}
const makeModel = (d) => [d.make, d.model].filter(Boolean).join(' ');
const fmtDate = (d) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};
const groupsOf = (docs, only) => (only ? [only] : CATEGORY_KEYS).map((k) => ({ key: k, ...CATEGORIES[k], docs: docs.filter((d) => d.category === k) })).filter((g) => only || g.docs.length);

// Soft palette for the files, the same quiet slate and logo blue as the apps.
const INK = '#2a3240';
const INK_2 = '#5b6576';
const INK_3 = '#8a93a1';
const LINE = '#dfe3ea';
const HEAD_BG = '#eef1f6';
const ACCENT = '#2f6fd1';

async function excelOf(docs, { by, category }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = `Nextup hub (${by})`;
  wb.created = new Date();
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1F6' } };
  const thin = { style: 'thin', color: { argb: 'FFDFE3EA' } };
  const groups = groupsOf(docs, category);

  const summary = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  summary.columns = [{ width: 22 }, { width: 12 }, { width: 16 }, { width: 14 }, { width: 18 }];
  summary.addRow(['Nextup Robotics · Inventory']).font = { bold: true, size: 14, color: { argb: 'FF2A3240' } };
  summary.addRow([`Exported ${fmtDate(new Date())} by ${by}`]).font = { color: { argb: 'FF8A93A1' } };
  summary.addRow([]);
  const sh = summary.addRow(['Group', 'Items', 'Total quantity', 'Low stock', 'Value (Rs)']);
  sh.eachCell((c) => { c.font = { bold: true, color: { argb: 'FF5B6576' } }; c.fill = headFill; c.border = { bottom: thin }; });
  let tItems = 0; let tQty = 0; let tLow = 0; let tVal = 0;
  for (const g of groups) {
    const qty = g.docs.reduce((a, d) => a + d.quantity, 0);
    const low = g.docs.filter((d) => d.low).length;
    const val = g.docs.reduce((a, d) => a + (d.unitPrice || 0) * d.quantity, 0);
    tItems += g.docs.length; tQty += qty; tLow += low; tVal += val;
    const r = summary.addRow([g.label, g.docs.length, qty, low, val || null]);
    r.getCell(5).numFmt = '#,##0.00';
    r.eachCell((c) => { c.border = { bottom: thin }; });
  }
  const tr = summary.addRow(['Total', tItems, tQty, tLow, tVal || null]);
  tr.font = { bold: true };
  tr.getCell(5).numFmt = '#,##0.00';

  const cols = [
    { header: 'Ref', key: 'ref', width: 9 },
    { header: 'Name', key: 'name', width: 32 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Make', key: 'make', width: 16 },
    { header: 'Model', key: 'model', width: 16 },
    { header: 'Payload (kg)', key: 'payloadKg', width: 12, only: 'robot' },
    { header: 'Specs', key: 'specs', width: 28 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Min stock', key: 'minQuantity', width: 10 },
    { header: 'Condition', key: 'conditionLabel', width: 14 },
    { header: 'Location', key: 'location', width: 20 },
    { header: 'Assigned to', key: 'assignedTo', width: 18 },
    { header: 'Serial numbers', key: 'serials', width: 24 },
    { header: 'Supplier', key: 'supplier', width: 20 },
    { header: 'Purchased on', key: 'purchasedOn', width: 13 },
    { header: 'Unit price (Rs)', key: 'unitPrice', width: 14 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Updated', key: 'updated', width: 13 },
  ];
  for (const g of groups) {
    const ws = wb.addWorksheet(g.label, { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
    ws.columns = cols.filter((c) => !c.only || c.only === g.key).map(({ only, ...c }) => c);
    g.docs.forEach((d) => {
      const r = ws.addRow({ ...d, conditionLabel: CONDITIONS[d.condition] || '', updated: fmtDate(d.updatedAt) });
      r.alignment = { vertical: 'top', wrapText: true };
      r.eachCell({ includeEmpty: true }, (c) => { c.border = { bottom: thin }; c.font = { color: { argb: 'FF2A3240' } }; });
      if (d.low) r.getCell('quantity').font = { bold: true, color: { argb: 'FFB0563F' } };
    });
    const head = ws.getRow(1);
    head.height = 20;
    head.eachCell((c) => { c.font = { bold: true, color: { argb: 'FF5B6576' } }; c.fill = headFill; c.border = { bottom: thin }; c.alignment = { vertical: 'middle' }; });
    ws.getColumn('unitPrice').numFmt = '#,##0.00';
    if (g.docs.length) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
      const total = ws.addRow({ name: `Total (${g.docs.length} items)`, quantity: g.docs.reduce((a, d) => a + d.quantity, 0) });
      total.font = { bold: true, color: { argb: 'FF2A3240' } };
    }
  }
  return wb.xlsx.writeBuffer();
}

function pdfOf(docs, { by, category, q }) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 }, bufferPages: true, info: { Title: 'Nextup inventory', Author: 'Nextup hub' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 18;
    const groups = groupsOf(docs, category);

    // Title
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text('Nextup Robotics', left, 40, { continued: true }).font('Helvetica').fillColor(INK_3).text('  Inventory');
    const sub = [`Exported ${fmtDate(new Date())} by ${by}`, category ? CATEGORIES[category].label : 'All groups', q ? `Search: "${q}"` : ''].filter(Boolean).join('   ·   ');
    doc.moveDown(0.2).fontSize(9).fillColor(INK_3).text(sub);
    doc.moveDown(0.8);

    // Summary chips
    let x = left;
    const y0 = doc.y;
    for (const g of groups) {
      const qty = g.docs.reduce((a, d) => a + d.quantity, 0);
      const low = g.docs.filter((d) => d.low).length;
      doc.roundedRect(x, y0, 180, 46, 6).fillAndStroke('#f5f7fa', LINE);
      doc.fillColor(INK_3).font('Helvetica').fontSize(8).text(g.label.toUpperCase(), x + 12, y0 + 9, { characterSpacing: 0.6 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(`${qty}`, x + 12, y0 + 22, { continued: true }).font('Helvetica').fontSize(9).fillColor(INK_2).text(`  in ${g.docs.length} items${low ? ` · ${low} low` : ''}`);
      x += 192;
    }
    doc.y = y0 + 64;

    const COLS = [
      { label: 'Ref', w: 46, get: (d) => d.ref },
      { label: 'Name', w: 150, get: (d) => d.name, bold: true },
      { label: 'Type', w: 74, get: (d) => d.type },
      { label: 'Make / model', w: 104, get: makeModel },
      { label: 'Specs', w: 120, get: (d) => [d.payloadKg ? `${d.payloadKg} kg payload` : '', d.specs].filter(Boolean).join(', ') },
      { label: 'Location', w: 86, get: (d) => d.location },
      { label: 'Condition', w: 62, get: (d) => CONDITIONS[d.condition] || '' },
      { label: 'Assigned', w: 66, get: (d) => d.assignedTo },
      { label: 'Qty', w: 54, get: (d) => `${d.quantity} ${d.unit || ''}`.trim(), right: true },
    ];
    const scale = width / COLS.reduce((a, c) => a + c.w, 0);
    COLS.forEach((c) => { c.w *= scale; });
    const pad = 5;

    const header = () => {
      const y = doc.y;
      doc.rect(left, y, width, 18).fill(HEAD_BG);
      let cx = left;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK_2);
      COLS.forEach((c) => { doc.text(c.label.toUpperCase(), cx + pad, y + 6, { width: c.w - pad * 2, align: c.right ? 'right' : 'left', characterSpacing: 0.4, lineBreak: false }); cx += c.w; });
      doc.y = y + 18;
    };

    for (const g of groups) {
      if (doc.y + 70 > bottom()) doc.addPage();
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(g.label, left, doc.y, { continued: true }).font('Helvetica').fontSize(9).fillColor(INK_3).text(`   ${g.docs.length} items · ${g.docs.reduce((a, d) => a + d.quantity, 0)} in total`);
      doc.moveDown(0.35);
      if (!g.docs.length) { doc.fontSize(9).fillColor(INK_3).text('Nothing here yet.'); continue; }
      header();
      g.docs.forEach((d, i) => {
        doc.font('Helvetica').fontSize(8.5);
        const hs = COLS.map((c) => doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').heightOfString(String(c.get(d) || '–'), { width: c.w - pad * 2 }));
        const h = Math.max(...hs) + 10;
        if (doc.y + h > bottom()) { doc.addPage(); header(); }
        const y = doc.y;
        if (i % 2 === 1) doc.rect(left, y, width, h).fill('#fafbfc');
        let cx = left;
        COLS.forEach((c) => {
          const v = String(c.get(d) || '');
          const color = c.label === 'Qty' && d.low ? '#b0563f' : v ? (c.bold ? INK : INK_2) : INK_3;
          doc.font(c.bold || (c.label === 'Qty') ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color).text(v || '–', cx + pad, y + 5, { width: c.w - pad * 2, align: c.right ? 'right' : 'left' });
          cx += c.w;
        });
        doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor(LINE).stroke();
        doc.y = y + h;
      });
      const lows = g.docs.filter((d) => d.low).length;
      if (lows) doc.moveDown(0.3).font('Helvetica').fontSize(8).fillColor('#b0563f').text(`Quantity in red: at or below the minimum stock (${lows} item${lows > 1 ? 's' : ''}).`, left);
    }
    if (!groups.length || !docs.length) doc.moveDown().font('Helvetica').fontSize(10).fillColor(INK_3).text('No items match.', left);

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // the footer sits below the margin; without this pdfkit starts a new page
      const y = doc.page.height - 30;
      doc.font('Helvetica').fontSize(7.5).fillColor(INK_3);
      doc.text('Nextup hub · inventory', left, y, { width: width / 2, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
      doc.fillColor(ACCENT);
    }
    doc.end();
  });
}

module.exports = { createInventory, normaliseItem, parseCsv, csvToObjects, categoryOf, CATEGORIES, CONDITIONS, COLUMNS };
