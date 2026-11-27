'use strict';

const { MongoClient } = require('mongodb');
const M = require('./models');

/**
 * Collections (database nextup_support):
 *   apps           one per maintained application (ethercat_config_tool, main_app)
 *   releases       release notes: one per app + version
 *   bug_reports    bugs, numbered per app (ECT-12, MAIN-7)
 *   machines       every installed copy that has reported in
 *   update_events  which machine moved to which version, when, and whether it worked
 *   attachments    screenshots sent with bug reports (base64 in `data`)
 *   counters       per-app bug numbers, and the enquiry number (ENQ-12)
 *   contact_submissions  enquiries sent from the website's contact form
 *   users, sessions      dashboard accounts (roles founder, hr, lead, employee) and sign-ins
 *   attendance           one per person per day
 *   leave_requests       leave asked for, approved or rejected
 *   holidays, events     the company calendar
 *   production_units     every robot being built, with its build stages
 *   projects             customer installations: robots, team, details
 *   clients              the companies projects are for, with their contacts
 *   project_entries      a project's record: problems and solutions, site visits, notes
 *   inventory_items      what the company owns: IT gadgets, panel items, robot items (src/inventory.js)
 */

// MongoDB-side validation, so documents written by other tools (scripts,
// Compass, the main application) keep the same shape as the API writes.
const VALIDATORS = {
  apps: {
    bsonType: 'object',
    required: ['_id', 'name', 'bugPrefix'],
    properties: {
      _id: { bsonType: 'string' },
      name: { bsonType: 'string' },
      bugPrefix: { bsonType: 'string', pattern: '^[A-Z]{2,8}$' },
    },
  },
  releases: {
    bsonType: 'object',
    required: ['appId', 'version', 'status', 'title', 'changes', 'releasedAt'],
    properties: {
      appId: { bsonType: 'string' },
      version: { bsonType: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
      status: { enum: M.RELEASE_STATUSES },
      channel: { enum: M.CHANNELS },
      changes: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['type', 'title'],
          properties: { type: { enum: M.CHANGE_TYPES }, title: { bsonType: 'string' }, bugs: { bsonType: 'array' } },
        },
      },
      releasedAt: { bsonType: 'date' },
    },
  },
  bug_reports: {
    bsonType: 'object',
    required: ['appId', 'number', 'seq', 'title', 'description', 'status', 'severity', 'category', 'createdAt'],
    properties: {
      appId: { bsonType: 'string' },
      number: { bsonType: 'string' },
      seq: { bsonType: ['int', 'long'] },
      status: { enum: M.BUG_STATUSES },
      severity: { enum: M.SEVERITIES },
      priority: { enum: [...M.SEVERITIES, null] },
      category: { enum: M.BUG_CATEGORIES },
      frequency: { enum: M.FREQUENCIES },
    },
  },
  machines: {
    bsonType: 'object',
    required: ['_id', 'appId', 'lastSeenAt'],
    properties: { _id: { bsonType: 'string' }, appId: { bsonType: 'string' }, lastSeenAt: { bsonType: 'date' } },
  },
  update_events: {
    bsonType: 'object',
    required: ['appId', 'machineId', 'toVersion', 'result'],
    properties: { result: { enum: M.UPDATE_RESULTS }, kind: { enum: M.UPDATE_KINDS } },
  },
  contact_submissions: {
    bsonType: 'object',
    required: ['_id', 'ref', 'name', 'message', 'status', 'createdAt'],
    properties: {
      _id: { bsonType: 'string' },
      ref: { bsonType: 'string', pattern: '^ENQ-\\d+$' },
      name: { bsonType: 'string', maxLength: 80 },
      email: { bsonType: ['string', 'null'] },
      phone: { bsonType: ['string', 'null'] },
      message: { bsonType: 'string', maxLength: 5000 },
      status: { enum: M.CONTACT_STATUSES },
      starred: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
    },
  },
  users: {
    bsonType: 'object',
    required: ['_id', 'name', 'email', 'role', 'passwordHash'],
    properties: { email: { bsonType: 'string' }, role: { enum: ['superuser', 'founder', 'hr', 'lead', 'employee'] }, active: { bsonType: 'bool' } },
  },
  attendance: {
    bsonType: 'object',
    required: ['_id', 'userId', 'date', 'status'],
    properties: { date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, status: { enum: ['present', 'half_day', 'absent', 'leave', 'holiday'] } },
  },
  leave_requests: {
    bsonType: 'object',
    required: ['_id', 'userId', 'type', 'from', 'to', 'status'],
    properties: { type: { enum: ['casual', 'sick', 'earned', 'unpaid'] }, status: { enum: ['pending', 'approved', 'rejected', 'cancelled'] } },
  },
  holidays: { bsonType: 'object', required: ['_id', 'date', 'name'], properties: { date: { bsonType: 'string' } } },
  events: { bsonType: 'object', required: ['_id', 'title', 'date'], properties: { date: { bsonType: 'string' } } },
  production_units: {
    bsonType: 'object',
    required: ['_id', 'serial', 'model', 'stages'],
    properties: { model: { enum: ['NexC5', 'NexR10', 'NexR20', 'Custom'] }, stages: { bsonType: 'array' } },
  },
  projects: {
    bsonType: 'object',
    required: ['_id', 'ref', 'name', 'status'],
    properties: { status: { enum: ['planning', 'in_progress', 'commissioning', 'live', 'on_hold', 'closed'] }, team: { bsonType: 'array' } },
  },
  clients: { bsonType: 'object', required: ['_id', 'ref', 'name', 'nameKey'], properties: { contacts: { bsonType: 'array' } } },
  inventory_items: {
    bsonType: 'object',
    required: ['_id', 'ref', 'category', 'name', 'quantity'],
    properties: { category: { enum: ['it', 'panel', 'robot'] }, name: { bsonType: 'string' }, quantity: { bsonType: ['int', 'long', 'double'], minimum: 0 }, condition: { enum: ['new', 'working', 'needs_repair', 'faulty', 'scrapped'] } },
  },
  project_entries: {
    bsonType: 'object',
    required: ['_id', 'projectId', 'kind'],
    properties: { kind: { enum: ['issue', 'visit', 'note'] }, status: { enum: ['open', 'investigating', 'workaround', 'solved'] } },
  },
};

const INDEXES = {
  releases: [
    [{ appId: 1, version: 1 }, { unique: true }],
    [{ appId: 1, status: 1, releasedAt: -1 }, {}],
  ],
  bug_reports: [
    [{ appId: 1, seq: 1 }, { unique: true }],
    [{ number: 1 }, { unique: true }],
    [{ clientReportId: 1 }, { unique: true, partialFilterExpression: { clientReportId: { $type: 'string' } } }],
    [{ appId: 1, status: 1, createdAt: -1 }, {}],
    [{ 'machine.machineId': 1, createdAt: -1 }, {}],
    [{ title: 'text', description: 'text', stepsToReproduce: 'text' }, { name: 'bug_text' }],
  ],
  machines: [[{ appId: 1, lastSeenAt: -1 }, {}]],
  attachments: [
    [{ bugNumber: 1 }, {}],
    [{ clientAttachmentId: 1 }, { unique: true, partialFilterExpression: { clientAttachmentId: { $type: 'string' } } }],
  ],
  update_events: [
    [{ clientEventId: 1 }, { unique: true }],
    [{ appId: 1, finishedAt: -1 }, {}],
    [{ machineId: 1, finishedAt: -1 }, {}],
  ],
  contact_submissions: [
    [{ ref: 1 }, { unique: true }],
    [{ createdAt: -1 }, {}],
    [{ status: 1, createdAt: -1 }, {}],
    [{ ipHash: 1, createdAt: -1 }, {}],        // daily limit per visitor
    [{ email: 1, createdAt: -1 }, {}],         // daily limit per email
    [{ phone: 1, createdAt: -1 }, {}],
    [{ messageHash: 1, createdAt: -1 }, {}],   // same message sent twice
  ],
  users: [[{ email: 1 }, { unique: true }], [{ team: 1 }, {}]],
  sessions: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }], [{ userId: 1 }, {}]],
  attendance: [[{ userId: 1, date: 1 }, {}], [{ date: 1 }, {}]],
  leave_requests: [[{ userId: 1, from: 1 }, {}], [{ status: 1, from: 1 }, {}]],
  holidays: [[{ date: 1 }, { unique: true }]],
  events: [[{ date: 1 }, {}]],
  production_units: [[{ serial: 1 }, { unique: true }], [{ createdAt: -1 }, {}], [{ projectId: 1 }, {}]],
  projects: [[{ ref: 1 }, { unique: true }], [{ status: 1, updatedAt: -1 }, {}], [{ clientId: 1 }, {}]],
  clients: [[{ ref: 1 }, { unique: true }], [{ nameKey: 1 }, { unique: true }]],
  inventory_items: [[{ ref: 1 }, { unique: true }], [{ category: 1, nameKey: 1 }, {}], [{ updatedAt: -1 }, {}]],
  project_entries: [[{ projectId: 1, createdAt: -1 }, {}], [{ kind: 1, status: 1 }, {}], [{ kind: 1, date: 1 }, {}]],
};

const DEFAULT_APPS = [
  { _id: 'ethercat_config_tool', name: 'EtherCAT config tool', bugPrefix: 'ECT', repo: { tagPrefix: 'v' }, platforms: ['linux'] },
  { _id: 'main_app', name: 'Main application', bugPrefix: 'MAIN', repo: { tagPrefix: 'v' }, platforms: ['linux'] },
];

// Each step is tried on its own: a hosted plan that refuses a command (for example
// validators on a shared cluster) is logged and skipped instead of stopping the server.
// Returns the list of steps that failed.
async function setup(db) {
  const problems = [];
  const attempt = async (what, fn) => { try { await fn(); } catch (err) { problems.push(`${what}: ${err.message}`); } };
  let existing = new Set();
  await attempt('list collections', async () => {
    existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  });
  for (const [name, schema] of Object.entries(VALIDATORS)) {
    const validator = { $jsonSchema: schema };
    await attempt(`rules for ${name}`, async () => {
      if (existing.has(name)) await db.command({ collMod: name, validator, validationLevel: 'moderate' });
      else await db.createCollection(name, { validator, validationLevel: 'moderate' });
    });
  }
  for (const [name, list] of Object.entries(INDEXES)) {
    for (const [keys, opts] of list) await attempt(`index on ${name}`, () => db.collection(name).createIndex(keys, opts));
  }
  for (const app of DEFAULT_APPS) {
    const { value } = M.normaliseApp(app);
    // Must work, or there are no apps to report against.
    await db.collection('apps').updateOne({ _id: value._id }, { $setOnInsert: { ...value, createdAt: new Date() } }, { upsert: true });
  }
  return problems;
}

async function connect(url, dbName) {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName);
  await db.command({ ping: 1 });
  return { client, db };
}

module.exports = { connect, setup, VALIDATORS, INDEXES, DEFAULT_APPS };
