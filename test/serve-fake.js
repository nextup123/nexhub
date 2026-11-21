'use strict';

// Runs the hub on an in-memory database, for trying the apps without MongoDB.
//   PORT=4060 node test/serve-fake.js
// SEED=1 adds a sample company (12 people, robots in the build, attendance, leave, bugs, enquiries).
// Sign in as dhirendra@nextup.demo (founder), meena@ (HR), anil@ (lead) or ravi@ (employee),
// password nextup-demo. Without SEED the setup screen asks for the setup key: SETUP_KEY, or `dev-key`.
const config = require('../src/config');
const { setup } = require('../src/db');
const { createApp } = require('../src/app');
const { createFakeDb } = require('./fakeDb');

(async () => {
  const db = createFakeDb();
  await setup(db);
  const cfg = { ...config, SETUP_KEY: config.SETUP_KEY || config.ADMIN_KEY || 'dev-key' };
  if (process.env.SEED) {
    await require('./seedContacts').seedContacts(db);
    await require('./seedCompany').seedCompany(db);
    await require('./seedProjects').seedProjects(db);
  }
  const app = createApp({ db, config: cfg });
  await app.locals.migrate();
  await app.locals.ensureSuperuser();
  app.listen(config.PORT, '127.0.0.1', () => console.log(`[HUB] in-memory hub on ${config.PORT}, ${process.env.SEED ? 'sample company, password nextup-demo' : `setup key ${cfg.SETUP_KEY === 'dev-key' ? 'dev-key' : '(from SETUP_KEY)'}`}`));
})();
