'use strict';

/**
 * Who may do what. One table, used by the server (every route checks it) and sent to the
 * dashboard (GET /auth/me), so menus only show what a person can open.
 *
 *   founder   everything
 *   hr        people: accounts, attendance, leave, holidays, calendar. No customer data, no bugs, no production.
 *   lead      runs a team: production, bug triage, website enquiries, their team's attendance and leave
 *   inventory view + export: everyone; add, edit, import: founder, hr, lead; delete: founder
 *   employee  their own attendance and leave, the calendar, production (updates the stages given to them),
 *             projects (read, log problems and site visits), bug reports (read and comment)
 *
 * Personal data stays narrow: website enquiries (customer names, phones) are founder + lead only,
 * HR records (joining date, employee id, emergency contact) are founder + hr only (and the person),
 * and a colleague's leave reason is only seen by whoever approves it.
 */
const ROLES = ['founder', 'hr', 'lead', 'employee'];
const ROLE_LABELS = { founder: 'Founder', hr: 'HR', lead: 'Lead', employee: 'Employee' };
// The secret super user (SUPERUSER_EMAIL / SUPERUSER_PASSWORD on the server): every permission, above
// founders, and hidden from everyone else. Not in ROLES, so nobody can give this role to an account.
const SUPERUSER = 'superuser';

const ALL = ROLES;
const PERMISSIONS = {
  // people
  'users.view': ALL,                         // directory: name, role, team, title, work email and phone
  'users.manage': ['founder', 'hr'],         // add people, change roles and teams, reset passwords, deactivate
  'users.hr_records': ['founder', 'hr'],     // joining date, employee id, emergency contact
  // attendance and leave
  'attendance.self': ALL,
  'attendance.team': ['lead'],               // their own team
  'attendance.all': ['founder', 'hr'],
  'attendance.edit': ['founder', 'hr'],      // correct anyone's day
  'leave.self': ALL,
  'leave.approve_team': ['lead'],            // their own team
  'leave.approve_all': ['founder', 'hr'],
  'holidays.manage': ['founder', 'hr'],
  'calendar.view': ALL,
  'calendar.manage': ['founder', 'hr', 'lead'],
  // production
  'production.view': ['founder', 'lead', 'employee'],
  'production.manage': ['founder', 'lead'],  // add units, change stages and dates, assign people
  'production.update_assigned': ['founder', 'lead', 'employee'], // tick off stages given to you
  'production.delete': ['founder'],
  // projects: customer installations, their robots, problems, solutions and site visits
  'projects.view': ['founder', 'lead', 'employee'],   // every project and its record; customer contact only for the project's team
  'projects.manage': ['founder', 'lead'],             // create, edit, team, robots, status
  'projects.log': ['founder', 'lead', 'employee'],    // log problems, solutions, site visits, notes
  'projects.delete': ['founder'],
  // clients: the companies the projects are for (company contacts like the site contact: managers and their project teams)
  'clients.view': ['founder', 'lead', 'employee'],
  'clients.manage': ['founder', 'lead'],
  'clients.delete': ['founder'],
  // bulk import from spreadsheets (people, clients, projects, robots, equipment, past problems): the super user only
  'data.import': [],
  // inventory (separate Nextup inventory app): IT gadgets, panel items, robot items
  'inventory.view': ALL,                              // see every group, search, export PDF / Excel
  'inventory.manage': ['founder', 'hr', 'lead'],      // add, edit, stock in/out, CSV import
  'inventory.delete': ['founder'],
  // website enquiries (customer contact details)
  'enquiries.view': ['founder', 'lead'],
  'enquiries.edit': ['founder', 'lead'],
  'enquiries.delete': ['founder'],
  // bug reports and releases of the two apps
  'bugs.view': ['founder', 'lead', 'employee'],
  'bugs.comment': ['founder', 'lead', 'employee'],
  'bugs.triage': ['founder', 'lead'],
  'releases.publish': ['founder', 'lead'],
  'apps.manage': ['founder'],
};

const can = (user, perm) => !!user && user.active !== false && (user.role === SUPERUSER ? perm in PERMISSIONS : (PERMISSIONS[perm] || []).includes(user.role));
const permissionsOf = (role) => Object.keys(PERMISSIONS).filter((p) => role === SUPERUSER || PERMISSIONS[p].includes(role));
/** Founders and the super user: the top of the company. */
const isTop = (user) => !!user && (user.role === 'founder' || user.role === SUPERUSER);

module.exports = { ROLES, ROLE_LABELS, PERMISSIONS, SUPERUSER, can, permissionsOf, isTop };
