'use strict';

// Inventory (1.10): three groups, CRUD, stock in/out, CSV import, PDF and Excel export, roles.
const test = require('node:test');
const assert = require('node:assert');
const { startHub, stopAll } = require('./helpers');
const { parseCsv } = require('../src/inventory');

test.after(stopAll);

test('inventory: add, list, edit, adjust, delete, with roles', async () => {
  const hub = await startHub();
  const founder = await hub.founder();
  const hr = await hub.person(founder, { name: 'Meena', email: 'meena@nextup.test', role: 'hr', team: 'People' });
  const emp = await hub.person(founder, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee' });

  const meta = await hub.call('GET', '/inventory/meta', null, { token: emp.token });
  assert.deepStrictEqual(meta.body.categories.map((c) => c.key), ['it', 'panel', 'robot']);

  // Employees can look but not add.
  assert.strictEqual((await hub.call('POST', '/inventory', { category: 'it', name: 'Monitor', quantity: 5 }, { token: emp.token })).status, 403);
  // HR adds IT gadgets.
  const mon = await hub.call('POST', '/inventory', { category: 'it', name: 'Dell 24" monitor', quantity: '5', type: 'Monitor', minQuantity: 2 }, { token: hr.token });
  assert.strictEqual(mon.status, 201);
  assert.strictEqual(mon.body.item.ref, 'IT-1');
  assert.strictEqual(mon.body.item.quantity, 5);
  assert.strictEqual(mon.body.item.unit, 'pcs');
  await hub.call('POST', '/inventory', { category: 'it', name: 'Keyboard', quantity: 6, type: 'Keyboard' }, { token: founder });
  const robot = await hub.call('POST', '/inventory', { category: 'robot', name: '20 kg payload robot', quantity: 6, model: 'NexR20', payloadKg: 20, unit: 'Nos' }, { token: founder });
  assert.strictEqual(robot.body.item.ref, 'RBT-1');
  await hub.call('POST', '/inventory', { category: 'robot', name: '5 kg payload robot', quantity: 3, model: 'NexC5', payloadKg: 5, unit: 'Nos' }, { token: founder });
  await hub.call('POST', '/inventory', { category: 'panel', name: '24 V SMPS', quantity: 12, type: 'SMPS' }, { token: founder });

  // Bad input
  for (const bad of [{ category: 'it', quantity: 1 }, { category: 'it', name: 'X', quantity: -1 }, { category: 'it', name: 'X', quantity: 1.5 }, { category: 'other', name: 'X', quantity: 1 }, { category: 'it', name: 'X', quantity: 1, condition: 'shiny' }]) {
    assert.strictEqual((await hub.call('POST', '/inventory', bad, { token: founder })).status, 400, JSON.stringify(bad));
  }

  const it = await hub.call('GET', '/inventory?category=it', null, { token: emp.token });
  assert.deepStrictEqual(it.body.items.map((d) => d.name), ['Dell 24" monitor', 'Keyboard']);
  assert.strictEqual(it.body.quantity, 11);
  const search = await hub.call('GET', '/inventory?q=nexr20', null, { token: emp.token });
  assert.deepStrictEqual(search.body.items.map((d) => d.ref), ['RBT-1']);
  const kg = await hub.call('GET', '/inventory?q=5%20kg', null, { token: emp.token });
  assert.deepStrictEqual(kg.body.items.map((d) => d.name), ['5 kg payload robot']);

  // Edit and stock out; history kept; low stock flag.
  const id = mon.body.item._id;
  const ed = await hub.call('PATCH', `/inventory/${id}`, { location: 'Office', quantity: 4 }, { token: hr.token });
  assert.strictEqual(ed.body.item.quantity, 4);
  assert.strictEqual(ed.body.item.location, 'Office');
  const out = await hub.call('POST', `/inventory/${id}/adjust`, { delta: -2, note: 'Given to site team' }, { token: hr.token });
  assert.strictEqual(out.body.item.quantity, 2);
  assert.strictEqual(out.body.item.low, true);
  assert.strictEqual((await hub.call('POST', `/inventory/${id}/adjust`, { delta: -3 }, { token: hr.token })).status, 400);
  const one = await hub.call('GET', '/inventory/IT-1', null, { token: emp.token });
  assert.deepStrictEqual(one.body.item.history.map((h) => h.change), [5, -1, -2]);
  const low = await hub.call('GET', '/inventory?low=1', null, { token: emp.token });
  assert.deepStrictEqual(low.body.items.map((d) => d.ref), ['IT-1']);

  const sum = await hub.call('GET', '/inventory/summary', null, { token: emp.token });
  assert.deepStrictEqual(sum.body.categories.map((c) => [c.key, c.items, c.quantity, c.low]), [['it', 2, 8, 1], ['panel', 1, 12, 0], ['robot', 2, 9, 0]]);

  // Delete: founder only.
  assert.strictEqual((await hub.call('DELETE', `/inventory/${id}`, null, { token: hr.token })).status, 403);
  assert.strictEqual((await hub.call('DELETE', `/inventory/${id}`, null, { token: founder })).status, 200);
  assert.strictEqual((await hub.call('GET', `/inventory/${id}`, null, { token: founder })).status, 404);
  // The cached list does not keep the deleted item.
  assert.strictEqual((await hub.call('GET', '/inventory?category=it', null, { token: emp.token })).body.items.length, 1);
  const bulk = await hub.call('POST', '/inventory/bulk-delete', { ids: [robot.body.item._id] }, { token: founder });
  assert.strictEqual(bulk.body.deleted, 1);
});

test('inventory: CSV import with dry run, loose headers, re-import does not double', async () => {
  const hub = await startHub();
  const founder = await hub.founder();
  const csv = '﻿Item Name,Qty,Brand,Model No,Remarks\r\n"Servo drive, 750 W",8,Delta,ASD-B2,\r\nSMPS 24V,12,Mean Well,LRS-250-24,rack B2\r\nBad row,many,,,\r\n';
  const dry = await hub.call('POST', '/inventory/import', { category: 'panel', csv, dryRun: true }, { token: founder });
  assert.strictEqual(dry.status, 200);
  assert.deepStrictEqual(dry.body.counts, { added: 2, updated: 0, skipped: 0, failed: 1 });
  assert.strictEqual((await hub.call('GET', '/inventory', null, { token: founder })).body.total, 0);

  const real = await hub.call('POST', '/inventory/import', { category: 'panel', csv, dryRun: false }, { token: founder });
  assert.deepStrictEqual(real.body.counts, { added: 2, updated: 0, skipped: 0, failed: 1 });
  const list = (await hub.call('GET', '/inventory?category=panel', null, { token: founder })).body.items;
  assert.deepStrictEqual(list.map((d) => [d.name, d.quantity, d.make, d.notes]), [['Servo drive, 750 W', 8, 'Delta', ''], ['SMPS 24V', 12, 'Mean Well', 'rack B2']]);

  // Same file again: updated in place (quantities set), nothing doubled. "add" adds the quantities.
  const again = await hub.call('POST', '/inventory/import', { category: 'panel', csv, dryRun: false }, { token: founder });
  assert.strictEqual(again.body.counts.updated, 2);
  const add = await hub.call('POST', '/inventory/import', { category: 'panel', csv: 'name,model,quantity\nSMPS 24V,LRS-250-24,3\n', dryRun: false, onExisting: 'add' }, { token: founder });
  assert.match(add.body.results[0].message, /12 → 15/);

  // One file with a category column, from anywhere; a row for another page is refused on a page.
  const mixed = 'category,name,quantity,payload\nIT,CPU i5,4,\nRobot specific,20 kg payload robot,6,20\n';
  const m = await hub.call('POST', '/inventory/import', { csv: mixed, dryRun: false }, { token: founder });
  assert.deepStrictEqual(m.body.counts, { added: 2, updated: 0, skipped: 0, failed: 0 });
  const r = (await hub.call('GET', '/inventory?category=robot', null, { token: founder })).body.items[0];
  assert.strictEqual(r.payloadKg, 20);
  const wrongPage = await hub.call('POST', '/inventory/import', { category: 'it', csv: mixed, dryRun: true }, { token: founder });
  assert.strictEqual(wrongPage.body.counts.failed, 1);

  // Template
  const t = await hub.call('GET', '/inventory/template.csv?category=robot', null, { token: founder });
  assert.match(t.body, /payloadKg/);
  assert.match(t.body, /20 kg payload robot/);
});

test('inventory: PDF and Excel exports', async () => {
  const hub = await startHub();
  const founder = await hub.founder();
  for (let i = 0; i < 60; i++) await hub.call('POST', '/inventory', { category: i % 3 === 0 ? 'it' : i % 3 === 1 ? 'panel' : 'robot', name: `Item ${i}`, quantity: i, specs: 'x'.repeat(i % 7 * 20) }, { token: founder });
  const pdf = await fetch(`${hub.base}/inventory/export.pdf`, { headers: { Authorization: `Bearer ${founder}` } });
  assert.strictEqual(pdf.status, 200);
  assert.match(pdf.headers.get('content-disposition'), /nextup-inventory-all-.*\.pdf/);
  const pbuf = Buffer.from(await pdf.arrayBuffer());
  assert.strictEqual(pbuf.subarray(0, 5).toString(), '%PDF-');
  const xls = await fetch(`${hub.base}/inventory/export.xlsx?category=panel`, { headers: { Authorization: `Bearer ${founder}` } });
  assert.strictEqual(xls.status, 200);
  const xbuf = Buffer.from(await xls.arrayBuffer());
  assert.strictEqual(xbuf.subarray(0, 2).toString(), 'PK');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xbuf);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Panel items']);
  assert.strictEqual(wb.getWorksheet('Panel items').rowCount, 1 + 20 + 1);
  // Signed out: no export.
  assert.strictEqual((await fetch(`${hub.base}/inventory/export.pdf`)).status, 401);
});

test('inventory: CSV parser', () => {
  assert.deepStrictEqual(parseCsv('a;b\n"x;y";"he said ""hi"""\n'), [['a', 'b'], ['x;y', 'he said "hi"']]);
  assert.deepStrictEqual(parseCsv('a\tb\r\n1\t2'), [['a', 'b'], ['1', '2']]);
});
