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
  ['electrical', '24 V 10 A SMPS', 12, { type: 'SMPS', make: 'Mean Well', model: 'LRS-250-24', specs: '24 V DC, 10.4 A', location: 'Store, rack B2', minQuantity: 4, unitPrice: 2150 }],
  ['electrical', 'Servo drive 750 W', 14, { type: 'Servo drive', make: 'Delta', model: 'ASD-B3-0721', specs: 'EtherCAT, 750 W', location: 'Store, rack B1', minQuantity: 6, unitPrice: 18400 }],
  ['electrical', 'Servo motor 750 W', 13, { type: 'Servo motor', make: 'Delta', model: 'ECM-B3M-C20807', specs: '2.39 Nm, 3000 rpm', location: 'Store, rack B1', minQuantity: 6 }],
  ['electrical', 'Relay 24 V DC', 60, { type: 'Relay', make: 'Omron', model: 'MY2N', location: 'Store, bin 9' }],
  ['electrical', 'Safety relay', 3, { type: 'Relay', make: 'Pilz', model: 'PNOZ s4', location: 'Store, rack B3', minQuantity: 4 }],
  ['electrical', 'MCB 2-pole 6 A', 40, { type: 'MCB', make: 'Schneider', model: 'A9F74206', location: 'Store, bin 14' }],
  ['electrical', 'Robot controller', 9, { type: 'Controller', make: 'Nextup', model: 'NX-CTRL-2', location: 'Assembly bay', minQuantity: 4 }],
  ['raw_material', 'Aluminium 6061 round bar, 50 mm', 18, { type: 'Aluminium', unit: 'm', specs: '6061-T6', location: 'Raw material rack', minQuantity: 6 }],
  ['raw_material', 'MS plate 10 mm', 6, { type: 'Mild steel', unit: 'sheets', specs: '1250 x 2500 mm, IS 2062', location: 'Yard' }],
  ['raw_material', 'Cable, 4 core 1.5 sq mm', 220, { type: 'Other', unit: 'm', make: 'Lapp', model: 'Ölflex 110', location: 'Store, drum 2' }],
  ['mechanical', 'M6 x 20 hex bolt', 480, { type: 'Bolt', make: 'Unbrako', model: 'M6x20 12.9', location: 'Store, bin 21', minQuantity: 200 }],
  ['mechanical', 'M6 nut', 650, { type: 'Nut', make: 'Unbrako', model: 'M6', location: 'Store, bin 22', minQuantity: 200 }],
  ['mechanical', 'M4 x 10 screw', 120, { type: 'Screw', make: 'Unbrako', model: 'M4x10', location: 'Store, bin 18', minQuantity: 150 }],
  ['mechanical', 'Deep groove bearing 6205', 24, { type: 'Bearing', make: 'SKF', model: '6205-2RS', location: 'Store, rack C1' }],
  ['mechanical', 'Harmonic gearbox 100:1', 7, { type: 'Gearbox', make: 'Nextup', model: 'HG-25-100', location: 'Spares shelf', minQuantity: 6, tracking: 'unit' }],
  ['machinery', 'CNC lathe', 1, { type: 'Lathe', make: 'Ace Micromatic', model: 'Jobber XL', location: 'Machine shop', unitPrice: 2850000 }],
  ['machinery', 'VMC 850', 1, { type: 'VMC', make: 'BFW', model: 'Gaurav 850', specs: '850 x 500 x 500 mm', location: 'Machine shop' }],
  ['machinery', 'MIG welding machine', 2, { type: 'Welding machine', make: 'ESAB', model: 'Rebel 285', location: 'Fabrication bay', condition: 'working' }],
];
const TRACK = { it: 'unit', electrical: 'unit', raw_material: 'lot', mechanical: 'lot', machinery: 'unit' };
const PREFIX = { it: 'IT', electrical: 'EE', raw_material: 'RM', mechanical: 'MEC', machinery: 'MCH' };

async function seedInventory(db) {
  const items = db.collection('inventory_items');
  const counters = db.collection('counters');
  const seq = { it: 0, electrical: 0, raw_material: 0, mechanical: 0, machinery: 0 };
  const day = 24 * 3600 * 1000;
  let n = 0;
  for (const [category, name, quantity, extra] of ITEMS) {
    seq[category] += 1;
    n += 1;
    const at = new Date(Date.now() - (40 - n) * day);
    const doc = { _id: crypto.randomUUID(), ref: `${PREFIX[category]}-${seq[category]}`, seq: seq[category], category, name, quantity, unit: 'pcs', type: '', make: '', model: '', specs: '', location: '', assignedTo: '', serials: '', supplier: '', notes: '', condition: 'working', minQuantity: null, payloadKg: null, unitPrice: null, purchasedOn: '', tracking: TRACK[category], ...extra };
    doc.nameKey = name.toLowerCase();
    doc.searchText = [doc.ref, name, doc.type, doc.make, doc.model, doc.specs, doc.location, doc.assignedTo, doc.notes, doc.payloadKg ? `${doc.payloadKg} kg` : ''].filter(Boolean).join(' ').toLowerCase();
    Object.assign(doc, { createdBy: 'Dhirendra', createdAt: at, updatedBy: 'Dhirendra', updatedAt: at, history: [{ at, by: 'Dhirendra', change: quantity, quantity, note: 'Added' }] });
    await items.insertOne(doc);
  }
  for (const k of Object.keys(seq)) await counters.updateOne({ _id: `inventory_${k}` }, { $set: { seq: seq[k] } }, { upsert: true });
}

module.exports = { seedInventory };
