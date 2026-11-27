'use strict';

// Sample inventory for the demo hub (SEED=1): a few IT gadgets, panel items and robot items.
const crypto = require('crypto');

const ITEMS = [
  ['it', 'Desktop CPU (i5, 16 GB)', 8, { type: 'CPU', make: 'Dell', model: 'OptiPlex 7010', location: 'Office, first floor', condition: 'working', minQuantity: 2, unitPrice: 48500 }],
  ['it', 'Dell 24" monitor', 5, { type: 'Monitor', make: 'Dell', model: 'P2422H', specs: '24 inch, 1080p', location: 'Office, first floor', condition: 'working', unitPrice: 14200 }],
  ['it', 'Wired keyboard', 6, { type: 'Keyboard', make: 'Logitech', model: 'K120', location: 'Office store', condition: 'new', minQuantity: 3, unitPrice: 650 }],
  ['it', 'Wireless mouse', 2, { type: 'Mouse', make: 'Logitech', model: 'M185', location: 'Office store', condition: 'new', minQuantity: 3, unitPrice: 700 }],
  ['it', 'Engineering laptop', 4, { type: 'Laptop', make: 'Lenovo', model: 'ThinkPad T14', specs: 'Ryzen 7, 32 GB, Ubuntu', assignedTo: 'Software team', condition: 'working', unitPrice: 98000 }],
  ['it', 'Laser printer', 1, { type: 'Printer', make: 'HP', model: 'LaserJet M126nw', location: 'Reception', condition: 'needs_repair', notes: 'Paper jam on tray 1' }],
  ['it', '24-port switch', 2, { type: 'Router / switch', make: 'TP-Link', model: 'TL-SG1024', location: 'Server rack', condition: 'working' }],
  ['panel', '24 V 10 A SMPS', 12, { type: 'SMPS', make: 'Mean Well', model: 'LRS-250-24', specs: '24 V DC, 10.4 A', location: 'Store, rack B2', minQuantity: 4, unitPrice: 2150 }],
  ['panel', 'Servo drive 750 W', 8, { type: 'Servo drive', make: 'Delta', model: 'ASD-B3-0721', specs: 'EtherCAT, 750 W', location: 'Store, rack B1', minQuantity: 6, unitPrice: 18400 }],
  ['panel', 'Servo motor 750 W', 7, { type: 'Servo motor', make: 'Delta', model: 'ECM-B3M-C20807', specs: '2.39 Nm, 3000 rpm', location: 'Store, rack B1', minQuantity: 6 }],
  ['panel', 'Stepper driver', 15, { type: 'Stepper driver', make: 'Leadshine', model: 'DM542', location: 'Store, rack B3' }],
  ['panel', 'Safety relay', 3, { type: 'Relay', make: 'Pilz', model: 'PNOZ s4', location: 'Store, rack B3', minQuantity: 4 }],
  ['panel', 'MCB 2-pole 6 A', 40, { type: 'MCB', make: 'Schneider', model: 'A9F74206', location: 'Store, bin 14' }],
  ['panel', 'PLC CPU', 2, { type: 'PLC', make: 'Siemens', model: 'S7-1200 1214C', location: 'Store, rack B1', condition: 'new' }],
  ['robot', '20 kg payload robot', 6, { type: 'Robot', make: 'Nextup', model: 'NexR20', payloadKg: 20, specs: '1.8 m reach', unit: 'Nos', location: 'Assembly bay' }],
  ['robot', '10 kg payload robot', 4, { type: 'Robot', make: 'Nextup', model: 'NexR10', payloadKg: 10, unit: 'Nos', location: 'Assembly bay' }],
  ['robot', '5 kg payload robot', 3, { type: 'Robot', make: 'Nextup', model: 'NexC5', payloadKg: 5, specs: 'Cobot, white', unit: 'Nos', location: 'Demo room' }],
  ['robot', 'Robot controller', 9, { type: 'Controller', make: 'Nextup', model: 'NX-CTRL-2', location: 'Assembly bay', minQuantity: 4 }],
  ['robot', 'Teach pendant', 5, { type: 'Teach pendant', make: 'Nextup', model: 'TP-10', location: 'Assembly bay' }],
  ['robot', 'Joint module J1–J3', 2, { type: 'Joint module', make: 'Nextup', model: 'JM-80', location: 'Spares shelf', minQuantity: 3, condition: 'new' }],
];
const PREFIX = { it: 'IT', panel: 'PNL', robot: 'RBT' };

async function seedInventory(db) {
  const items = db.collection('inventory_items');
  const counters = db.collection('counters');
  const seq = { it: 0, panel: 0, robot: 0 };
  const day = 24 * 3600 * 1000;
  let n = 0;
  for (const [category, name, quantity, extra] of ITEMS) {
    seq[category] += 1;
    n += 1;
    const at = new Date(Date.now() - (30 - n) * day);
    const doc = { _id: crypto.randomUUID(), ref: `${PREFIX[category]}-${seq[category]}`, seq: seq[category], category, name, quantity, unit: 'pcs', type: '', make: '', model: '', specs: '', location: '', assignedTo: '', serials: '', supplier: '', notes: '', condition: 'working', minQuantity: null, payloadKg: null, unitPrice: null, purchasedOn: '', ...extra };
    doc.nameKey = name.toLowerCase();
    doc.searchText = [doc.ref, name, doc.type, doc.make, doc.model, doc.specs, doc.location, doc.assignedTo, doc.notes, doc.payloadKg ? `${doc.payloadKg} kg` : ''].filter(Boolean).join(' ').toLowerCase();
    Object.assign(doc, { createdBy: 'Dhirendra', createdAt: at, updatedBy: 'Dhirendra', updatedAt: at, history: [{ at, by: 'Dhirendra', change: quantity, quantity, note: 'Added' }] });
    await items.insertOne(doc);
  }
  for (const k of Object.keys(seq)) await counters.updateOne({ _id: `inventory_${k}` }, { $set: { seq: seq[k] } }, { upsert: true });
}

module.exports = { seedInventory };
