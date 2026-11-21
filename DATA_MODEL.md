# Data model: releases, bug reports and updates

One MongoDB database (`nextup_support`) serves both applications you maintain: the
**EtherCAT config tool** (`ethercat_config_tool`) and the **main application** (`main_app`).
Every document carries `appId`, so bugs, releases and update records of the two apps never mix,
and each app numbers its bugs separately (`ECT-12`, `MAIN-7`).

```
apps ──┬── releases        what is in each version (features, fixes, notes)
       ├── bug_reports     problems reported from machines or by you
       ├── machines        every installed copy that has reported in
       └── update_events   which machine moved to which version, when, and whether it worked
attachments                screenshots of bug reports (image bytes as base64)
counters                   per-app bug numbers, enquiry numbers
contact_submissions        enquiries from the website's contact form (separate from the two apps)

users ── sessions          dashboard accounts (founder, hr, lead, employee) and their sign-ins
      ├─ attendance        one per person per working day
      └─ leave_requests    leave asked for, approved, rejected or cancelled
holidays, events           the company calendar
production_units           every robot being built, with its build stages
projects ── project_entries  customer installations, and their problems, site visits and notes
```

The three kinds of data you asked for are `releases` (1), `bug_reports` (2) and
`update_events` (3, with `machines` as its summary per PC).

The same rules are enforced in three places: `src/models.js` (API input), MongoDB
`$jsonSchema` validators (`src/db.js`, so scripts and Compass can't write a different shape),
and unique indexes.

## apps

| Field | Type | Example | Notes |
|---|---|---|---|
| `_id` | string | `ethercat_config_tool` | the appId used everywhere |
| `name` | string | `EtherCAT config tool` | |
| `bugPrefix` | string | `ECT` | 2–8 capital letters, used for bug numbers |
| `description` | string | | |
| `repo.url` | string | `git@github.com:org/repo.git` | for reference; each machine has its own copy of this setting |
| `repo.tagPrefix` | string | `v` | tag `v3.5.1` = version 3.5.1. Use `ect-v` / `main-v` if both apps share one repository |
| `repo.subdir` | string | `ethercat_config_tool` | folder in the repository, empty if the app is at the top |
| `platforms` | string[] | `["linux"]` | `android`, `ios` for the mobile app later |

Both apps are created when the server first starts.

## releases (1. update release data)

One document per app and version. Unique on `{appId, version}`.

| Field | Type | Example | Notes |
|---|---|---|---|
| `appId` | string | `ethercat_config_tool` | |
| `version` | string | `3.5.1` | semantic version `MAJOR.MINOR.PATCH[-pre]` |
| `tag` | string | `v3.5.1` | the git tag the update installs |
| `commit` | string | `9f3c…` | filled by the GitHub Action |
| `channel` | `stable` \| `beta` | `stable` | |
| `status` | `draft` \| `published` \| `withdrawn` | `published` | machines only see `published`; `withdrawn` hides a bad release from the Update page |
| `title` | string | `Homing fix` | one line shown on the Update page |
| `summary` | string | | a short paragraph |
| `releasedAt` | date | | |
| `changes[]` | array | see below | grouped on the Update page by type |
| `changes[].type` | `feature` \| `improvement` \| `fix` \| `security` \| `breaking` \| `known_issue` | `fix` | shown as New, Improved, Fixed, Safety, Needs attention, Known problem |
| `changes[].area` | string | `Recipes` | page or part of the app |
| `changes[].title` | string | `Homing no longer stops on J3` | |
| `changes[].description` | string | | |
| `changes[].bugs` | string[] | `["ECT-1"]` | bug numbers this change fixes |
| `changes[].images` | string[] | | screenshot URLs |
| `upgradeNotes` | string | | what to do before or after updating (shown in amber) |
| `requiresRestart` | bool | `true` | |
| `mandatory` | bool | `false` | marks the version "Required" |
| `minVersion` | string \| null | `3.4.0` | oldest version that may update straight to this one |
| `compatibility` | object | `{"ros":"humble","drives":"SV660N"}` | free key/value |
| `artifacts[]` | `{platform,url,sha256,size}` | | for builds that are downloaded instead of built (main app, mobile app) |
| `publishedBy` | string | `github-actions` | |
| `createdAt`, `updatedAt` | date | | |

**Publishing a release marks its bugs fixed.** Every bug listed in `changes[].bugs` moves to
`released` with `fixedInVersion` set, and the vendor's machine shows "Fixed in version 3.5.1"
next to their report.

The notes are written once, in `release-notes.json` at the top of the app's repository, and
committed with the version. The GitHub Action sends them to the server when the tag is pushed.
The Update page reads them from the server, or straight from the tag when the server can't be reached.

## bug_reports (2. bug reports)

Unique on `number`, on `{appId, seq}`, and on `clientReportId`.

| Field | Type | Example | Notes |
|---|---|---|---|
| `appId` | string | `ethercat_config_tool` | which app the bug belongs to |
| `seq`, `number` | int, string | `12`, `ECT-12` | per-app counter |
| `clientReportId` | uuid | | made on the machine; a report sent twice (offline retry) is stored once |
| `appVersion` | string | `3.5.0` | version the problem happened on |
| `title` | string | `Homing stops at step 4 on J3` | "What went wrong?" |
| `description` | string | | "What happened" |
| `stepsToReproduce` | string | | "What were you doing?" |
| `expected`, `actual` | string | | optional, for your own reports |
| `category` | `crash` \| `wrong_result` \| `drive_communication` \| `screen_problem` \| `slow` \| `update` \| `other` | | |
| `severity` | `critical` \| `high` \| `medium` \| `low` | `high` | the reporter's "How bad is it?" (Stops work, Serious, Annoying, Small) |
| `priority` | same values or null | | yours, set when you triage |
| `frequency` | `always` \| `sometimes` \| `once` | | |
| `area` | string | `Recipes` | page where it happened |
| `reporter` | `{name, company, phone, email}` | | the vendor |
| `machine` | `{machineId, name, site, hostname, os}` | | which PC it came from |
| `context` | object | | added by the app if the reporter allows it: drives on the bus and their state, last 20 History entries, controller connected, screen size. Capped at 200 KB |
| `attachments[]` | `{id,name,type,size,url,createdAt}` | | screenshots sent with the report (collection `attachments`); `url` is `/api/v1/attachments/<id>` |
| `status` | `new` \| `triaged` \| `need_info` \| `in_progress` \| `fixed` \| `released` \| `closed` \| `wont_fix` \| `duplicate` | `new` | open = new, triaged, need_info, in_progress |
| `assignee` | string \| null | | |
| `labels` | string[] | | |
| `duplicateOf` | string \| null | `ECT-3` | |
| `fixedInVersion` | string \| null | `3.5.1` | set by hand or by publishing a release |
| `comments[]` | `{author, text, internal, at}` | | `internal: false` comments are meant for the reporter |
| `statusHistory[]` | `{status, by, at, note}` | | every status change |
| `submittedBy` | string | | machine name or reporter that sent it |
| `reportedAt` | date | | when the operator pressed Send (may be days before `createdAt` if offline) |
| `createdAt`, `updatedAt` | date | | |

What the vendor sees on their machine is limited to number, title, status, fixed-in version and dates.

## machines

`_id` is a UUID the app makes once and keeps in `data/machine.json`.

| Field | Type | Notes |
|---|---|---|
| `_id` | uuid | machineId |
| `appId` | string | |
| `name`, `site` | string | set on the Update page (Name of this PC, Customer or site) |
| `hostname`, `os` | string | |
| `version` | string | version running now |
| `channel` | string | |
| `lastUpdate` | `{toVersion, result, at}` | |
| `firstSeenAt`, `lastSeenAt` | date | updated by a heartbeat every minute while online |

## update_events (3. update records)

One per update or roll-back attempt on one machine. Unique on `clientEventId` (offline retries).

| Field | Type | Example | Notes |
|---|---|---|---|
| `clientEventId` | uuid | | |
| `appId`, `machineId` | string | | |
| `kind` | `update` \| `rollback` | | rollback = "Go back to …" pressed |
| `fromVersion`, `toVersion`, `tag` | string | `3.5.0`, `3.5.1`, `v3.5.1` | |
| `result` | `success` \| `failed` \| `rolled_back` \| `not_applied` | | `failed` = stopped before switching (nothing changed); `rolled_back` = new version did not start and the old one was started again |
| `failedStep` | string | `build` | download, unpack, install, build, check, switch, start |
| `error` | string | | plain-words reason |
| `log` | string | | last 80 lines of the update log (left out of list views) |
| `startedAt`, `finishedAt`, `durationSec` | | | |
| `receivedAt` | date | | |

## contact_submissions (website enquiries)

One per enquiry sent from the contact page of the Nextup website. Unique on `ref`.
Not tied to an app, so it carries no `appId`.

| Field | Type | Example | Notes |
|---|---|---|---|
| `_id` | uuid | | used in dashboard links |
| `ref`, `seq` | string, int | `ENQ-12`, `12` | shown to the visitor after sending |
| `name` | string | `Rakesh Sharma` | required, up to 80 characters |
| `email`, `phone` | string \| null | | at least one is required |
| `company`, `industry`, `product` | string | `NexR20` | the form's pickers |
| `message` | string | | "What do you want to automate?", up to 5000 characters |
| `source` | `{page, referrer, utm}` | `/contact?product=robot1` | where the visitor came from |
| `status` | `new` \| `in_progress` \| `replied` \| `closed` \| `spam` | `new` | open = new, in_progress |
| `starred` | bool | | |
| `readAt` | date \| null | | set when opened in the dashboard |
| `assignee` | string \| null | | |
| `tags` | string[] | | |
| `notes[]` | `{id, author, text, at}` | | internal, never shown to the visitor |
| `statusHistory[]` | `{status, by, at}` | | every status change; the first Replied/Closed gives the reply time |
| `messageHash` | string | | finds the same message sent twice |
| `ipHash` | string | | salted hash of the visitor's address, for the daily limit. Never sent out |
| `userAgent` | string | | |
| `createdAt`, `updatedAt` | date | | |

## Company hub collections

Dates that are days (`date`, `from`, `to`, `targetDate`…) are `YYYY-MM-DD` strings in the company
time zone (`COMPANY_TZ`), so a day never shifts with the server's clock. Moments (`checkIn`, `createdAt`)
are real dates.

### users

| Field | Type | Notes |
|---|---|---|
| `_id` | uuid | |
| `name`, `email` | string | email is unique, lower case, and is the sign-in name |
| `phone`, `title`, `team` | string | a lead looks after everyone with the same `team` |
| `role` | `founder` \| `hr` \| `lead` \| `employee` | what each can do is in `src/permissions.js` |
| `hidden` | bool | only on the super user (`role: superuser`), made from `SUPERUSER_EMAIL` / `SUPERUSER_PASSWORD`; left out of every list and count |
| `active` | bool | switched-off accounts cannot sign in and are hidden from lists |
| `passwordHash` | string | `scrypt$<salt>$<hash>`. Never sent out |
| `mustChangePassword` | bool | true after an account is added or its password reset |
| `hr` | `{employeeId, joinedOn, emergencyContact}` | sent only to the person, HR and founders |
| `lastLoginAt`, `createdAt`, `updatedAt` | date | |

### sessions

`_id` is the SHA-256 of the sign-in token (the token itself is never stored), with `userId`,
`createdAt`, `userAgent` and `expiresAt` (a TTL index removes it then).

### attendance

`_id` = `<userId>:<date>`. `userId`, `date`, `checkIn`, `checkOut`, `hours`, `mode`
(`office` \| `wfh` \| `site`), `status` (`present` \| `half_day` \| `absent` \| `leave` \| `holiday`),
`late`, `note`, `source` (`self`, or `hr` when HR corrected it), `editedBy`, `updatedAt`.
Days without a record are worked out when shown: week off, holiday, on leave or absent.

### leave_requests

`userId`, `type` (`casual` \| `sick` \| `earned` \| `unpaid`), `from`, `to`, `halfDay`, `days`
(working days, without week offs and holidays), `reason`, `status` (`pending` \| `approved` \|
`rejected` \| `cancelled`), `decidedBy`, `decidedAt`, `comment`, `createdAt`, `updatedAt`.

### holidays, events

Holiday: `date` (unique), `name`, `kind` (`national` \| `festival` \| `optional`;
optional holidays still count as working days for leave). Event: `title`, `date`, `endDate`,
`time`, `location`, `description`, `createdBy`, `createdById`.

### production_units

| Field | Type | Notes |
|---|---|---|
| `serial` | string | unique, `NX-C5-0001`, from the `unit:<prefix>` counter |
| `model`, `colour` | `NexC5` \| `NexR10` \| `NexR20` \| `Custom` | NexC5 is White or Blue |
| `customer` | `{company, city}` | |
| `enquiryRef` | string | the website enquiry it came from, e.g. `ENQ-8` |
| `orderedOn`, `targetDate`, `dispatchedOn`, `installedOn` | day | |
| `priority` | `normal` \| `high` \| `urgent` | |
| `onHold`, `holdReason` | bool, string | |
| `stages[]` | `{key, label, area, state, assigneeId, assignee, startedAt, doneAt, doneBy, note}` | `state`: `pending` \| `in_progress` \| `done` \| `blocked` \| `skipped`; the note says why a stage is blocked |
| `notes[]`, `history[]` | `{at, by, text}` | every change is added to `history` |
| `projectId` | uuid \| null | the project the robot is on |
| `software` | `{version, since}` \| null | the version on the robot now |
| `softwareHistory[]` | `{version, on, by, note}` | every version it has run, oldest first |

A robot added as built before the hub has every stage `done` with `doneBy: 'Before the hub'`.

Phase (worked out, not stored): Planned (nothing started), In build, Testing (from Calibrated on),
Ready to ship (all stages done), Dispatched, Installed.

### projects

| Field | Type | Notes |
|---|---|---|
| `ref` | string | unique, `PRJ-3`, from the `project` counter |
| `name`, `application`, `description`, `scope` | string | |
| `status` | `planning` \| `in_progress` \| `commissioning` \| `live` \| `on_hold` \| `closed` | |
| `customer` | `{company, city, site, contactName, contactPhone, contactEmail}` | the contact is sent only to founders, leads and the project's team |
| `startDate`, `goLiveDate`, `closedOn` | day | |
| `enquiryRef`, `tags[]` | string | |
| `clientId` | uuid \| null | the client; `customer.company` is kept equal to the client's name |
| `team[]` | `{userId, name, role}` | |
| `equipment[]` | `{_id, kind, name, make, model, serial, supplier, status, installedOn, notes, addedBy, addedAt}` | `kind`: `conveyor` \| `spm` \| `gripper` \| `vision` \| `fixture` \| `safety` \| `plc_panel` \| `positioner` \| `agv` \| `other`; `status`: `planned` \| `installed` \| `removed` |
| `history[]` | `{at, by, text}` | |
| `searchText` | string | lower-case text of the project, its team, equipment, its robots' serials and software versions, and every error code in a squeezed form (`e131`); never sent out |

The robots are not stored here: each `production_units` document has `projectId`.

### clients

| Field | Type | Notes |
|---|---|---|
| `ref` | string | unique, `CLI-4`, from the `client` counter |
| `name`, `nameKey` | string | `nameKey` is the lower-case name, unique, so one company is one client |
| `industry`, `city`, `address`, `gstin`, `website`, `notes` | string | |
| `contacts[]` | `{name, role, phone, email}` | phone and email are sent only to founders, leads and the teams of its projects |
| `searchText` | string | never sent out |

### project_entries

One per problem, site visit or note, with `projectId`, `kind` (`issue` \| `visit` \| `note`),
`createdBy`, `createdById`, `createdAt`, `updatedAt`, `updates[]` (`{at, by, text, status?}`) and `searchText`
(its own text plus the project's ref, name and customer).

- Problem (`issue`): `ref` (`PRB-12`, from the `project-issue` counter), `title`, `description`, `category`,
  `severity` (`low` \| `medium` \| `high` \| `critical`), `status` (`open` \| `investigating` \| `workaround` \| `solved`),
  `rootCause`, `solution`, `unitId`, `serial`, `model`, `foundOn`, `solvedOn`, `solvedBy`, `visitId` (the visit it was found on),
  `errorCodes[]` (as typed, upper case), `component`, `softwareVersion`, `equipmentId`, `equipmentName`, `equipmentKind`.
- Site visit (`visit`): `date`, `endDate`, `engineers[]` (`{userId, name}`), `hours`, `purpose`, `workDone`,
  `nextSteps`, `problemIds[]` (the problems logged with it).
- Note (`note`): `title`, `text`.

## API (for the apps and the mobile app)

All under `/api/v1`. The apps and robots need no sign-in. Send `X-User-Name: <name>`
to record who made a change (status history, comments, publishing); without it the name is
`maintainer`. When someone is signed in (`Authorization: Bearer <token>`), their name is used and
their role applies; with `LOCK_BUG_ROUTES=true`, reading bugs, machines, update records and summaries
needs an account, and publishing releases needs `releases.publish` or `RELEASE_TOKEN`. Installed apps ask for releases with `status=published`.

| Method and path | What |
|---|---|
| `GET /apps` | the two apps |
| `PUT /apps/:id` | add or change an app |
| `GET /apps/:appId/releases?after=3.5.0&status=` | newest first; `status=published` for installed apps |
| `GET /apps/:appId/releases/:version` | |
| `PUT /apps/:appId/releases/:version` | create or replace; publishing links bugs |
| `POST /apps/:appId/bugs` | new report (repeat-safe) |
| `POST /bugs/:number/attachments` | one screenshot: `{clientAttachmentId, name, data}` (base64 JPEG, PNG, WebP or GIF, up to 700 KB, 5 per bug). Repeat-safe. Also at `/apps/:appId/bugs/:number/attachments` |
| `GET /attachments/:id` | the image itself, with its content type (the random id is the access) |
| `GET /apps/:appId/bugs?status=open&severity=high&q=&machineId=&page=` | list with filters, 30 per page |
| `GET /bugs/:number` | full report |
| `PATCH /bugs/:number` | status, priority, assignee, labels, fixedInVersion, duplicateOf, note |
| `POST /bugs/:number/comments` | |
| `GET /apps/:appId/machines/:machineId/bugs` | a machine's own reports, short form |
| `POST /apps/:appId/machines/heartbeat` | |
| `GET /apps/:appId/machines` | |
| `POST /apps/:appId/update-events` | repeat-safe |
| `GET /apps/:appId/update-events?result=failed,rolled_back` | |
| `GET /apps/:appId/summary` | dashboard: open bugs by severity, bugs by status, latest release, machines per version, recent failed updates |
| `GET /meta` | the allowed values above, so the mobile app builds its pickers from the server |

Website enquiries. `POST /contact` is public and rate limited; the rest need a founder or lead
signed in (`401` when not signed in, `403` for other roles; deleting is founders only).

| Method and path | What |
|---|---|
| `POST /contact` | `{name, email, phone, company, industry, product, message, website, source}` → `201 {ok, ref}`; `200 {duplicate: true}` for the same message again; `400` with a plain-words error; `429` over a limit |
| `GET /contact-submissions?status=inbox&product=&industry=&q=&from=&to=&unread=true&starred=true&sort=oldest&page=&limit=` | newest first, 50 per page. `status`: `inbox` (all but spam), `open`, or a list |
| `GET /contact-submissions/summary?days=30&tzOffset=-330` | dashboard counts and enquiries per day |
| `GET /contact-submissions/export.csv?…` | same filters, as a spreadsheet |
| `GET /contact-submissions/:id` | one enquiry, plus other enquiries from the same email or phone |
| `PATCH /contact-submissions/:id` | `status`, `starred`, `read`, `assignee`, `tags` |
| `POST /contact-submissions/:id/notes` | `{text}` |
| `DELETE /contact-submissions/:id` | removes it for good |

## Using it from the main application

Have the main application send the same `POST /apps/main_app/bugs`, `/update-events` and `/machines/heartbeat` bodies. The
EtherCAT tool's `server/lib/hub.js` (offline queue included) can be copied as is with
`APP_ID` changed.

## Company hub API

All under `/api/v1`, with `Authorization: Bearer <token>` from `/auth/login`. Answers are `401` when
not signed in, `403` when the role does not allow it (and `403 {mustChangePassword: true}` until a
temporary password is changed).

| Method and path | Who | What |
|---|---|---|
| `GET /auth/status` | anyone | `{needsSetup, company, tz}` |
| `POST /auth/setup` | anyone, once | `{setupKey, name, email, password}` creates the first founder |
| `POST /auth/login` | anyone | `{email, password, remember}` → `{token, user, permissions}`. Rate limited |
| `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/me` | signed in | own name and phone |
| `POST /auth/password` | signed in | `{current, password}`; signs out other devices |
| `GET /users?all=true` | everyone (`all` for HR, founders) | directory |
| `POST /users`, `PATCH /users/:id`, `POST /users/:id/password` | HR, founders | add (returns `temporaryPassword`), change, reset password |
| `GET /home` | signed in | counts for the home page, by role |
| `GET /stream` | signed in | server-sent events: `change {area}` (reload), `notify {kind, id, ref, title, body}` for new enquiries (`enquiries.view`) and bug reports (`bugs.view`) |
| `GET /notifications/telegram`, `GET /notifications/telegram/chats`, `POST /notifications/telegram/test` | founders | Telegram status, chats that messaged the bot, a test message |
| `POST /attendance/check-in`, `POST /attendance/check-out` | everyone | `{mode, note}` |
| `GET /attendance/today` | everyone | own day, and the team's or everyone's board |
| `GET /attendance/month?month=2026-11&team=` | everyone (own), leads (team), HR/founders (all) | grid and totals |
| `PUT /attendance/:userId/:date` | HR, founders | correct a day; `{clear: true}` removes it |
| `GET /leave?scope=mine\|approvals\|team&year=` | everyone | |
| `GET /leave/balance?userId=&year=` | everyone (own), approvers | |
| `POST /leave` | everyone | `{type, from, to, halfDay, reason}` |
| `POST /leave/:id/decision` | the team's lead, HR, founders | `{decision: approve\|reject, comment}` |
| `POST /leave/:id/cancel` | the person | before the leave starts |
| `GET /holidays?year=`, `POST /holidays`, `DELETE /holidays/:id` | everyone reads; HR, founders change | |
| `POST /events`, `PATCH /events/:id`, `DELETE /events/:id` | founders, HR, leads | |
| `GET /calendar?from=&to=` | everyone | holidays, events, approved leave, and robot dates for those who see production |
| `GET /production/templates` | production | models, stages, states |
| `GET /units?model=&phase=&q=&assignee=me`, `GET /units/summary` | founders, leads, employees | |
| `POST /units`, `PATCH /units/:id` | founders, leads | |
| `GET /units/:id` | founders, leads, employees | |
| `PATCH /units/:id/stages/:key` | founders, leads; employees on stages given to them | `{state, note, assigneeId}` |
| `POST /units/:id/stages`, `DELETE /units/:id/stages/:key` | founders, leads | add or remove a stage |
| `POST /units/:id/notes` | founders, leads, employees | |
| `DELETE /units/:id` | founders | |
| `GET /bugs?status=open&appId=&severity=&q=` | founders, leads, employees | bugs from both apps |
| `GET /projects?status=open&mine=true` | founders, leads, employees | with counts: robots, open problems, visits, last visit |
| `POST /projects`, `PATCH /projects/:id` | founders, leads | details, status, `team: [{userId, role}]` |
| `GET /projects/:id` | founders, leads, employees | the project, its robots and its whole record |
| `DELETE /projects/:id` | founders | the record goes too; robots stay in the build list |
| `PUT /projects/:id/units/:unitId`, `DELETE …` | founders, leads | put a robot on the project or take it off (`409` if it is on another project) |
| `GET /projects/search?q=&kind=issue,visit,note,project,client&status=open&category=&projectId=&clientId=` | founders, leads, employees | every word must match (error codes in any spelling); ranked. `mode=similar&exclude=<id>&limit=` for "seen before" |
| `GET /clients`, `GET /clients/:id` | founders, leads, employees | the client with its projects, robots (with software) and equipment |
| `POST /clients`, `PATCH /clients/:id` | founders, leads | `409` if a client with that name exists |
| `DELETE /clients/:id` | founders | `409` while it has projects |
| `POST /projects/:id/equipment`, `PATCH`/`DELETE /projects/:id/equipment/:eid` | founders, leads | |
| `POST /units` with `alreadyBuilt: true, serial, softwareVersion, projectId, installedOn` | founders, leads | a robot from before the hub |
| `POST /units/:id/software` | founders, leads; employees for robots on a project | `{version, on, note}` |
| `GET /import/templates`, `POST /import/:kind` | super user | `{rows: [{header: value}], dryRun}`; dry run unless `dryRun: false` |
| `POST /projects/:id/entries` | founders, leads, employees | `{kind: issue, title, …}`, `{kind: visit, date, engineers, purpose, workDone, nextSteps, hours, problems: [{title, solution, rootCause, status, category, severity, unitId}]}` or `{kind: note, text}` |
| `PATCH /project-entries/:id` | the author, leads, founders; anyone may set `status`, `rootCause`, `solution` | |
| `POST /project-entries/:id/updates` | founders, leads, employees | `{text}` |
| `DELETE /project-entries/:id` | the author, leads, founders | |
