'use strict';

// Assets (1.11): tags, project › assembly › part tree, parts from stock, return, move, labels, BOM, migration.
const test = require('node:test');
const assert = require('node:assert');
const { startHub, stopAll } = require('./helpers');
const { tagOf, parseTag, checkLetter } = require('../src/assets');
const { migrateInventory } = require('../src/inventory');

test.after(stopAll);

test('tags: check letter catches a mistyped digit; loose spelling works', () => {
  assert.match(tagOf(123), /^NX-000123-[A-Z]$/);
  let caught = 0;
  for (let n = 1; n < 500; n++) {
    const d = String(n).padStart(6, '0');
    for (let i = 0; i < 6; i++) {
      const other = d.slice(0, i) + ((Number(d[i]) + 1) % 10) + d.slice(i + 1);
      if (checkLetter(Number(other)) !== checkLetter(n)) caught++;
    }
  }
  assert.ok(caught / (499 * 6) > 0.9, `catches ${caught}`);
  const t = tagOf(42);
  assert.deepStrictEqual(parseTag(t.toLowerCase().replace(/-/g, '')), { seq: 42, check: t.slice(-1) });
  assert.deepStrictEqual(parseTag('42'), { seq: 42, check: '' });
  assert.strictEqual(parseTag('hello'), null);
});

test('assets: a project tree down to the bolts, from stock and back', async () => {
  const hub = await startHub();
  const founder = await hub.founder();
  const emp = await hub.person(founder, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee' });
  const hr = await hub.person(founder, { name: 'Meena', email: 'meena@nextup.test', role: 'hr', team: 'People' });
  const prj = (await hub.call('POST', '/projects', { name: 'Welding cell' }, { token: founder })).body.project;
  const stock = async (category, name, quantity, extra = {}) => (await hub.call('POST', '/inventory', { category, name, quantity, ...extra }, { token: founder })).body.item;
  const drive = await stock('electrical', 'Servo drive 750 W', 10);
  const relay = await stock('electrical', 'Relay 24 V', 30);
  const bolts = await stock('mechanical', 'M6 x 20 hex bolt', 500);
  assert.strictEqual(bolts.tracking, 'lot');
  assert.strictEqual(drive.tracking, 'unit');

  // HR cannot; employees can.
  assert.strictEqual((await hub.call('POST', '/assets', { kind: 'assembly', name: 'Panel', projectId: prj._id }, { token: hr.token })).status, 403);
  const panel = (await hub.call('POST', '/assets', { kind: 'assembly', assemblyType: 'Panel', name: 'Main panel', projectId: prj._id }, { token: emp.token })).body.assets[0];
  assert.match(panel.tag, /^NX-000001-[A-Z]$/);
  const arm = (await hub.call('POST', '/assets', { kind: 'assembly', assemblyType: 'Robot arm', name: 'Robot arm', projectId: prj._id }, { token: emp.token })).body.assets[0];
  const joint = (await hub.call('POST', '/assets', { kind: 'assembly', assemblyType: 'Joint', name: 'Joint J1', parentId: arm._id }, { token: emp.token })).body.assets[0];
  assert.strictEqual(joint.projectId, prj._id);

  // 3 drives: three tags, serials kept. 4 relays: four tags. 24 bolts: one lot tag.
  const d = await hub.call('POST', '/assets', { parentId: panel._id, fromStock: { itemId: drive._id, quantity: 3, serials: 'SD-1\nSD-2\nSD-3' } }, { token: emp.token });
  assert.strictEqual(d.status, 201);
  assert.deepStrictEqual(d.body.assets.map((a) => [a.kind, a.quantity, a.serial]), [['unit', 1, 'SD-1'], ['unit', 1, 'SD-2'], ['unit', 1, 'SD-3']]);
  assert.strictEqual(new Set(d.body.assets.map((a) => a.tag)).size, 3);
  await hub.call('POST', '/assets', { parentId: panel._id, fromStock: { itemId: relay._id, quantity: 4 } }, { token: emp.token });
  const lot = (await hub.call('POST', '/assets', { parentId: joint._id, fromStock: { itemId: bolts._id, quantity: 24 } }, { token: emp.token })).body.assets;
  assert.deepStrictEqual(lot.map((a) => [a.kind, a.quantity, a.itemRef]), [['lot', 24, bolts.ref]]);
  // Stock went down.
  const after = async (it) => (await hub.call('GET', `/inventory/${it._id}`, null, { token: founder })).body.item;
  assert.strictEqual((await after(drive)).quantity, 7);
  assert.strictEqual((await after(bolts)).quantity, 476);
  assert.deepStrictEqual((await after(bolts)).allocations, [{ project: { ref: prj.ref, name: 'Welding cell' }, quantity: 24, tags: 1 }]);
  // Not more than the store has; a part cannot go inside a part.
  assert.strictEqual((await hub.call('POST', '/assets', { parentId: panel._id, fromStock: { itemId: drive._id, quantity: 8 } }, { token: emp.token })).status, 400);
  assert.strictEqual((await hub.call('POST', '/assets', { kind: 'unit', name: 'x', parentId: lot[0]._id }, { token: emp.token })).status, 400);

  // The tree.
  const tree = await hub.call('GET', `/projects/${prj._id}/assets`, null, { token: emp.token });
  assert.deepStrictEqual(tree.body.totals, { assemblies: 3, units: 7, lots: 1, pieces: 31, tags: 11 });
  // Find a bolt lot by its tag, typed loosely; the path shows where it is.
  const loose = lot[0].tag.toLowerCase().replace(/-/g, ' ');
  const found = await hub.call('GET', `/assets/tag/${encodeURIComponent(loose)}`, null, { token: emp.token });
  assert.strictEqual(found.body.asset._id, lot[0]._id);
  const wrongCheck = lot[0].tag.slice(0, -1) + (lot[0].tag.endsWith('A') ? 'B' : 'A');
  assert.strictEqual((await hub.call('GET', `/assets/tag/${wrongCheck}`, null, { token: emp.token })).status, 400);
  const detail = await hub.call('GET', `/assets/${lot[0]._id}`, null, { token: emp.token });
  assert.deepStrictEqual(detail.body.path.map((x) => x.name), ['Robot arm', 'Joint J1']);
  assert.strictEqual(detail.body.project.ref, prj.ref);
  const armDetail = await hub.call('GET', `/assets/${arm._id}`, null, { token: emp.token });
  assert.strictEqual(armDetail.body.inside, 2);
  const search = await hub.call('GET', '/assets?q=SD-2', null, { token: emp.token });
  assert.strictEqual(search.body.assets.length, 1);

  // Part of the lot back to the store, then the whole panel (its drives and relays go back into stock).
  await hub.call('POST', `/assets/${lot[0]._id}/return`, { quantity: 4 }, { token: emp.token });
  assert.strictEqual((await after(bolts)).quantity, 480);
  const ret = await hub.call('POST', `/assets/${panel._id}/return`, {}, { token: emp.token });
  assert.strictEqual(ret.body.returned, 8);
  assert.strictEqual((await after(drive)).quantity, 10);
  assert.strictEqual((await after(relay)).quantity, 30);
  // Returned tags are kept, with their history.
  const old = await hub.call('GET', `/assets/${d.body.assets[0]._id}`, null, { token: emp.token });
  assert.strictEqual(old.body.asset.status, 'returned');
  assert.match(old.body.asset.history.at(-1).note, /back to the store/);
  assert.strictEqual((await hub.call('GET', `/projects/${prj._id}/assets`, null, { token: emp.token })).body.totals.tags, 3);

  // Move the arm (and everything in it) to another project; an assembly cannot go inside itself.
  const prj2 = (await hub.call('POST', '/projects', { name: 'Second cell' }, { token: founder })).body.project;
  assert.strictEqual((await hub.call('POST', `/assets/${arm._id}/move`, { parentId: joint._id }, { token: emp.token })).status, 400);
  const mv = await hub.call('POST', `/assets/${arm._id}/move`, { projectId: prj2._id }, { token: emp.token });
  assert.strictEqual(mv.body.moved, 3);
  assert.strictEqual((await hub.call('GET', `/projects/${prj2._id}/assets`, null, { token: emp.token })).body.totals.tags, 3);

  // Labels and bill of materials.
  const labels = await fetch(`${hub.base}/assets/labels.pdf?projectId=${prj2._id}`, { headers: { Authorization: `Bearer ${emp.token}` } });
  assert.strictEqual(labels.status, 200);
  assert.strictEqual(Buffer.from(await labels.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const bom = await fetch(`${hub.base}/projects/${prj2._id}/assets/export.xlsx`, { headers: { Authorization: `Bearer ${emp.token}` } });
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await bom.arrayBuffer()));
  assert.deepStrictEqual(wb.getWorksheet('Tree').getColumn(1).values.slice(2), [1, 2, 3]);

  // Delete: founder only, and not an assembly with parts in it. Deleting puts the stock back.
  assert.strictEqual((await hub.call('DELETE', `/assets/${lot[0]._id}`, null, { token: emp.token })).status, 403);
  assert.strictEqual((await hub.call('DELETE', `/assets/${joint._id}`, null, { token: founder })).status, 400);
  assert.strictEqual((await hub.call('DELETE', `/assets/${lot[0]._id}`, null, { token: founder })).status, 200);
  assert.strictEqual((await after(bolts)).quantity, 500);
});

test('inventory migration: panel → electrical, robot → mechanical (controllers → electrical), refs kept', async () => {
  const hub = await startHub();
  const items = hub.db.collection('inventory_items');
  await items.insertOne({ _id: 'a', ref: 'PNL-1', category: 'panel', name: 'SMPS', quantity: 3 });
  await items.insertOne({ _id: 'b', ref: 'RBT-1', category: 'robot', name: 'Joint module', type: 'Joint module', quantity: 2 });
  await items.insertOne({ _id: 'c', ref: 'RBT-2', category: 'robot', name: 'Robot controller', type: 'Controller', quantity: 9 });
  await migrateInventory(hub.db, { log() {} });
  await migrateInventory(hub.db, { log() {} });
  const all = await items.find({}).toArray();
  assert.deepStrictEqual(all.map((d) => [d.ref, d.category, d.tracking]), [['PNL-1', 'electrical', 'unit'], ['RBT-1', 'mechanical', 'lot'], ['RBT-2', 'electrical', 'unit']]);
});
