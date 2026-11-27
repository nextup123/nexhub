'use strict';

// Sample asset tree for the demo hub (SEED=1), made through the API like the dashboard would:
// the welding cell gets a panel, a robot arm (with a joint) and a computer, with parts from stock.
async function seedAssets(base, email = 'dhirendra@nextup.demo', password = 'nextup-demo') {
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
    return j;
  };
  const { token } = await call('POST', '/auth/login', { email, password });
  const projects = (await call('GET', '/projects', null, token)).projects;
  const prj = projects.find((p) => /welding/i.test(p.name)) || projects[0];
  const stock = (await call('GET', '/inventory', null, token)).items;
  const item = (name) => stock.find((s) => s.name === name)._id;
  const add = async (body) => (await call('POST', '/assets', body, token)).assets;
  const [panel] = await add({ kind: 'assembly', assemblyType: 'Panel', name: 'Main control panel', projectId: prj._id, location: 'Cell, left of the fence', make: 'Nextup', model: 'CP-600' });
  await add({ parentId: panel._id, fromStock: { itemId: item('Servo drive 750 W'), quantity: 6, serials: 'D23B0711\nD23B0712\nD23B0713\nD23B0714\nD23B0719\nD23B0720' } });
  await add({ parentId: panel._id, fromStock: { itemId: item('Relay 24 V DC'), quantity: 4 } });
  await add({ parentId: panel._id, fromStock: { itemId: item('24 V 10 A SMPS'), quantity: 2 } });
  await add({ parentId: panel._id, fromStock: { itemId: item('Robot controller'), quantity: 1, serials: 'CTRL-2-0042' } });
  await add({ parentId: panel._id, fromStock: { itemId: item('M4 x 10 screw'), quantity: 40 } });
  await add({ parentId: panel._id, fromStock: { itemId: item('Cable, 4 core 1.5 sq mm'), quantity: 30 } });
  const [arm] = await add({ kind: 'assembly', assemblyType: 'Robot arm', name: 'Robot arm NexR10', projectId: prj._id, serial: 'NX-R10-0007' });
  for (const j of ['J1 base', 'J2 shoulder', 'J3 elbow']) {
    const [joint] = await add({ kind: 'assembly', assemblyType: 'Joint', name: `Joint ${j}`, parentId: arm._id });
    await add({ parentId: joint._id, fromStock: { itemId: item('Servo motor 750 W'), quantity: 1 } });
    await add({ parentId: joint._id, fromStock: { itemId: item('Harmonic gearbox 100:1'), quantity: 1 } });
    await add({ parentId: joint._id, fromStock: { itemId: item('Deep groove bearing 6205'), quantity: 2, mode: 'unit' } });
    await add({ parentId: joint._id, fromStock: { itemId: item('M6 x 20 hex bolt'), quantity: 12 } });
    await add({ parentId: joint._id, fromStock: { itemId: item('M6 nut'), quantity: 12 } });
  }
  const [pc] = await add({ kind: 'assembly', assemblyType: 'Computer', name: 'Cell HMI computer', projectId: prj._id });
  for (const n of ['Desktop CPU (i5, 16 GB)', 'Dell 24" monitor', 'Wired keyboard', 'Wireless mouse']) await add({ parentId: pc._id, fromStock: { itemId: item(n), quantity: 1 } });
  // A machine registered on its own, in the store.
  await add({ kind: 'unit', name: 'Fluke 87V multimeter', make: 'Fluke', model: '87V', serial: '43120987', location: 'Service van' });
}

module.exports = { seedAssets };
