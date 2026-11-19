'use strict';
// v2.2.0: per-role workflows (stages) and copying a role. Every test runs on both drivers.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole, lastApplication, count, stageId, moveStage } = require('./helpers');

const XSS = '<script>alert(1)</script>';
const XSS_ESCAPED = '&lt;script&gt;alert\\(1\\)&lt;\\/script&gt;'; // for use inside RegExp source

for (const driver of DRIVERS) describe(`[${driver}] workflows`, () => {
  let t;
  let admin;
  let rep;
  let repId;

  before(async () => {
    t = await startApp({ driver });
    repId = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    admin = t.client();
    await admin.login('admin@fansided.com');
    rep = t.client();
    await rep.login('rep@fansided.com');
  });
  after(() => t.close());

  const stagesOf = (roleId) => t.db.all('SELECT id, position, name, kind FROM role_stages WHERE role_id = ? ORDER BY position, id', [roleId]);
  const names = async (roleId) => (await stagesOf(roleId)).map((s) => s.name);
  let seq = 0;
  const email = () => `wf${++seq}@example.com`;

  // A role with the given custom stages, made through the real admin form.
  async function createRole(title, progress, extra = {}) {
    await admin.get('/app/admin/roles/new');
    const fields = { title, vertical: 'NFL', status: 'open', assigned_user_id: String(repId), stage_slots: '1', ...extra };
    for (let i = 0; i < 6; i++) {
      fields[`stage_name_${i}`] = progress[i] || '';
      fields[`stage_pos_${i}`] = progress[i] ? String(i + 1) : '';
    }
    const res = await admin.post('/app/admin/roles', fields);
    assert.equal(res.status, 303, res.text);
    return Number(/\/app\/admin\/roles\/(\d+)$/.exec(res.headers.get('location'))[1]);
  }

  // The editor fields of an existing role as the form would send them (names, positions and ids from the database).
  async function editorFields(roleId, mutate = (f) => f) {
    const stages = await stagesOf(roleId);
    const fields = { stage_slots: '1', stage_ids: stages.map((s) => s.id).join(',') };
    const custom = stages.filter((s) => s.kind === 'progress');
    for (let i = 0; i < 6; i++) {
      const s = custom[i];
      fields[`stage_id_${i}`] = s ? String(s.id) : '';
      fields[`stage_name_${i}`] = s ? s.name : '';
      fields[`stage_pos_${i}`] = s ? String(i + 1) : '';
    }
    return mutate(fields);
  }

  async function saveRole(roleId, overrides = {}, mutate) {
    const role = await t.db.get('SELECT * FROM job_roles WHERE id = ?', [roleId]);
    await admin.get(`/app/admin/roles/${roleId}`);
    const fields = { title: role.title, vertical: role.vertical, status: role.status, assigned_user_id: role.assigned_user_id ? String(role.assigned_user_id) : '', ...(await editorFields(roleId, mutate)), ...overrides };
    return admin.post(`/app/admin/roles/${roleId}`, fields);
  }

  async function applyTo(roleId, name = 'Pat Candidate') {
    assert.equal((await t.client().apply(roleId, { email: email(), name })).status, 303);
    return (await lastApplication(t.db)).id;
  }

  const boardColumns = (text) => [...text.matchAll(/<section class="board-col stage-(\w+)" id="stage-\d+" data-stage="\d+" data-kind="\w+" aria-labelledby="h-\d+">\s*<div class="board-col-head">\s*<h2 id="h-\d+">([\s\S]*?)<\/h2>/g)].map((m) => `${m[1]}:${m[2]}`);
  const columnOf = (text, name) => {
    const hit = text.split('<section class="board-col ').slice(1).find((p) => p.includes(`>${name}</h2>`));
    assert.ok(hit, `column ${name}`);
    return hit.split('</section>')[0];
  };

  // ---------------------------------------------------------------- the editor
  test('role form: new role offers Reviewing and Trial by default; fixed stages are read-only; spare rows are rendered', async () => {
    const res = await admin.get('/app/admin/roles/new');
    assert.equal(res.status, 200);
    assert.match(res.text, /<legend>Workflow<\/legend>/);
    assert.match(res.text, /name="stage_slots" value="1"/);
    assert.match(res.text, /name="stage_name_0"[^>]*value="Reviewing"/);
    assert.match(res.text, /name="stage_name_1"[^>]*value="Trial"/);
    for (let i = 2; i < 6; i++) assert.match(res.text, new RegExp(`name="stage_name_${i}"[^>]*value=""`));
    assert.doesNotMatch(res.text, /name="stage_name_6"/);
    for (const fixed of ['New', 'Onboarded', 'Passed']) assert.match(res.text, new RegExp(`<strong>${fixed}</strong>`));
    assert.doesNotMatch(res.text, /name="stage_name_[^"]*"[^>]*value="(New|Onboarded|Passed)"/); // no input for the fixed ones
    assert.match(res.text, /type="number"[^>]*name="stage_pos_0"/);
  });

  test('create: stages are stored in the submitted position order, trimmed, with kinds; the role is created with its workflow in one go', async () => {
    await admin.get('/app/admin/roles/new');
    const res = await admin.post('/app/admin/roles', {
      title: 'Ordered', vertical: 'NFL', status: 'open', stage_slots: '1',
      stage_name_0: 'Phone screen', stage_pos_0: '3',
      stage_name_1: '  Edit   test ', stage_pos_1: '1',
      stage_name_2: 'Trial run', stage_pos_2: '2',
    });
    assert.equal(res.status, 303);
    const role = await t.db.get("SELECT id FROM job_roles WHERE title = 'Ordered'");
    const rows = await stagesOf(role.id);
    assert.deepEqual(rows.map((s) => [s.position, s.name, s.kind]), [
      [0, 'New', 'new'], [1, 'Edit test', 'progress'], [2, 'Trial run', 'progress'], [3, 'Phone screen', 'progress'], [4, 'Onboarded', 'onboarded'], [5, 'Passed', 'passed'],
    ]);
    // the edit page shows them in that order, with ids, ready to edit
    const edit = await admin.get(`/app/admin/roles/${role.id}`);
    assert.match(edit.text, /name="stage_name_0"[^>]*value="Edit test"/);
    assert.match(edit.text, /name="stage_name_2"[^>]*value="Phone screen"/);
    assert.match(edit.text, new RegExp(`name="stage_ids" value="${rows.map((s) => s.id).join(',')}"`));
  });

  test('create: without editor fields the default workflow is used; with the editor and no names there are no custom stages', async () => {
    await admin.get('/app/admin/roles/new');
    await admin.post('/app/admin/roles', { title: 'Default flow', vertical: 'NFL', status: 'open' });
    const a = await t.db.get("SELECT id FROM job_roles WHERE title = 'Default flow'");
    assert.deepEqual(await names(a.id), ['New', 'Reviewing', 'Trial', 'Onboarded', 'Passed']);
    const b = await createRole('Bare flow', []);
    assert.deepEqual(await names(b), ['New', 'Onboarded', 'Passed']);
    const board = await admin.get(`/app/roles/${b}`);
    assert.deepEqual(boardColumns(board.text), ['new:New', 'onboarded:Onboarded', 'passed:Passed']);
  });

  test('create: up to six custom stages (nine columns); the board and dashboard follow', async () => {
    const six = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
    const id = await createRole('Nine columns', six);
    assert.equal((await stagesOf(id)).length, 9);
    const app = await applyTo(id);
    const board = await admin.get(`/app/roles/${id}`);
    assert.deepEqual(boardColumns(board.text), ['new:New', ...six.map((n) => `progress:${n}`), 'onboarded:Onboarded', 'passed:Passed']);
    assert.match(board.text, /<div class="board" data-columns="9" tabindex="0" role="region"/);
    assert.match(board.text, /This workflow has 9 stages\. Scroll the board sideways/);
    const dash = await admin.get('/app?view=all');
    const row = new RegExp(`data-role-id="${id}">([\\s\\S]*?)</ol>`).exec(dash.text)[1];
    assert.equal((row.match(/<li class="stage-seg /g) || []).length, 9);
    assert.ok(app);
  });

  test('validation: duplicates (case-insensitive), fixed names, length, position; error summary and inline errors; nothing is created', async () => {
    const before = await count(t.db, 'job_roles');
    await admin.get('/app/admin/roles/new');
    const res = await admin.post('/app/admin/roles', {
      title: 'Invalid flow', vertical: 'NFL', status: 'open', stage_slots: '1',
      stage_name_0: 'Trial', stage_name_1: 'trial',
      stage_name_2: 'PASSED',
      stage_name_3: 'x'.repeat(31),
      stage_name_4: 'Fine', stage_pos_4: 'abc',
      stage_name_5: 'Also fine', stage_pos_5: '0',
    });
    assert.equal(res.status, 400);
    assert.equal(await count(t.db, 'job_roles'), before);
    assert.match(res.text, /id="error-summary"/);
    assert.match(res.text, /<a href="#f-stage-name-1">&quot;trial&quot; is already used in this workflow\./);
    assert.match(res.text, /id="err-stage-1"/);
    assert.match(res.text, /&quot;PASSED&quot; is a fixed stage of every role/);
    assert.match(res.text, /Stage names must be at most 30 characters\./);
    assert.match(res.text, /Position must be a whole number from 1 to 99\./);
    assert.equal((res.text.match(/Position must be a whole number/g) || []).length >= 2, true);
    // what was typed is kept
    assert.match(res.text, /name="stage_name_0"[^>]*value="Trial"/);
    assert.match(res.text, /name="stage_pos_4"[^>]*value="abc"/);
    // exactly 30 characters is fine, and an in-range position
    const ok = await admin.post('/app/admin/roles', { title: 'Thirty', vertical: 'NFL', status: 'open', stage_slots: '1', stage_name_0: 'y'.repeat(30), stage_pos_0: '99' });
    assert.equal(ok.status, 303);
  });

  test('XSS: stage names are escaped in the form errors, on the board, stepper, candidate page, dashboard, search and move menus; CSV formulas are guarded', async () => {
    // errors and values in the editor
    await admin.get('/app/admin/roles/new');
    const bad = await admin.post('/app/admin/roles', { title: 'XSS flow', vertical: 'NFL', stage_slots: '1', stage_name_0: XSS, stage_name_1: XSS });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.text, /<script>alert\(1\)/);
    assert.match(bad.text, new RegExp(`value="${XSS_ESCAPED}"`));
    assert.match(bad.text, new RegExp(`&quot;${XSS_ESCAPED}&quot; is already used`));

    const id = await createRole('XSS board', [XSS, '=cmd|x', '"><img src=x onerror=1>']);
    const appId = await applyTo(id, 'Xss Target');
    const c = admin;
    const everywhere = [];
    everywhere.push((await c.get(`/app/roles/${id}`)).text);
    const move = await moveStage(c, t.db, appId, XSS, 'new');
    assert.equal(move.status, 303);
    everywhere.push((await c.follow(move)).text); // the flash "Moved ... to <script>"
    everywhere.push((await c.get(`/app/applications/${appId}`)).text); // stepper, badge, move select, event log
    everywhere.push((await c.get('/app?view=all')).text);
    everywhere.push((await c.get('/app/candidates?owner=all&status=all&q=xss')).text);
    everywhere.push((await c.get(`/app/admin/roles/${id}`)).text);
    for (const text of everywhere) {
      assert.doesNotMatch(text, /<script>alert\(1\)/);
      assert.doesNotMatch(text, /<img src=x onerror=1>/);
    }
    assert.match(everywhere[0], new RegExp(`<h2 id="h-\\d+">${XSS_ESCAPED}</h2>`));
    assert.match(everywhere[2], new RegExp(`<span class="stepper-label">${XSS_ESCAPED}</span>`));
    assert.match(everywhere[2], new RegExp(`<span class="stage-badge stage-progress">${XSS_ESCAPED}</span>`));
    assert.match(everywhere[2], new RegExp(`Stage: New → ${XSS_ESCAPED}`));
    assert.match(everywhere[3], new RegExp(`<span class="stage-seg-l">${XSS_ESCAPED}</span>`));
    assert.match(everywhere[4], new RegExp(`stage-badge stage-progress">${XSS_ESCAPED}<`));
    assert.match(everywhere[1], new RegExp(`to ${XSS_ESCAPED}\\.`));
    // CSV: a stage named like a formula is neutralised, and the kind column is the fixed vocabulary
    await moveStage(c, t.db, appId, '=cmd|x', XSS);
    const csv = (await c.get('/app/export.csv')).text;
    assert.match(csv, new RegExp(`,'=cmd\\|x,progress,`));
    assert.doesNotMatch(csv, /,=cmd\|x,/);
  });

  // ---------------------------------------------------------------- editing
  test('edit: rename keeps candidates in place; add, reorder and remove (empty) stages in one save; old events keep their text', async () => {
    const id = await createRole('Editable', ['Reviewing', 'Trial']);
    const appId = await applyTo(id);
    await moveStage(admin, t.db, appId, 'Trial', 'New');
    const before = await stagesOf(id);
    const trial = before.find((s) => s.name === 'Trial');
    const reviewing = before.find((s) => s.name === 'Reviewing');
    const res = await saveRole(id, { title: 'Editable v2' }, (f) => {
      f.stage_name_1 = 'Final trial'; // rename (id kept)
      f.stage_name_0 = ''; // remove Reviewing (empty)
      f.stage_name_2 = 'Edit test'; // add
      f.stage_pos_2 = '1'; // ... and put it first
      f.stage_pos_1 = '2';
      return f;
    });
    assert.equal(res.status, 303);
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [id])).title, 'Editable v2');
    const after = await stagesOf(id);
    assert.deepEqual(after.map((s) => [s.position, s.name, s.kind]), [[0, 'New', 'new'], [1, 'Edit test', 'progress'], [2, 'Final trial', 'progress'], [3, 'Onboarded', 'onboarded'], [4, 'Passed', 'passed']]);
    assert.equal(after.find((s) => s.name === 'Final trial').id, trial.id, 'renamed stage keeps its id');
    assert.equal(after.some((s) => s.id === reviewing.id), false);
    const row = await t.db.get('SELECT stage, stage_id FROM applications WHERE id = ?', [appId]);
    assert.equal(row.stage_id, trial.id);
    assert.equal(row.stage, 'reviewing');
    const board = await admin.get(`/app/roles/${id}`);
    assert.match(columnOf(board.text, 'Final trial'), /Pat Candidate/);
    // the history is text and is not rewritten
    const events = await t.db.all('SELECT from_value, to_value FROM application_events WHERE application_id = ? ORDER BY id', [appId]);
    assert.deepEqual(events.map((e) => [e.from_value, e.to_value]), [[null, 'New'], ['New', 'Trial']]);
    assert.match((await admin.get(`/app/applications/${appId}`)).text, /Stage: New → Trial/);
  });

  test('edit: removing a stage that still has candidates is refused, names the stage and the count, and saves NOTHING', async () => {
    const id = await createRole('Refuse removal', ['Reviewing', 'Edit test']);
    const a1 = await applyTo(id);
    const a2 = await applyTo(id);
    await moveStage(admin, t.db, a1, 'Edit test', 'New');
    await moveStage(admin, t.db, a2, 'Edit test', 'New');
    const before = await stagesOf(id);
    const res = await saveRole(id, { title: 'Should not be saved' }, (f) => {
      f.stage_name_1 = '';
      f.stage_name_0 = 'Renamed too';
      return f;
    });
    assert.equal(res.status, 400);
    assert.match(res.text, /Move the 2 candidates out of Edit test before removing it\./);
    assert.match(res.text, /<a href="#f-stage-name-1">Move the 2 candidates out of Edit test before removing it\./);
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [id])).title, 'Refuse removal');
    assert.deepEqual(await stagesOf(id), before, 'no stage was renamed or removed');
    // one candidate: singular
    await moveStage(admin, t.db, a2, 'Reviewing', 'Edit test');
    const one = await saveRole(id, {}, (f) => {
      f.stage_name_1 = '';
      return f;
    });
    assert.match(one.text, /Move the 1 candidate out of Edit test before removing it\./);
    // after moving the last one out, the removal works
    await moveStage(admin, t.db, a1, 'Reviewing', 'Edit test');
    assert.equal((await saveRole(id, {}, (f) => ((f.stage_name_1 = ''), f))).status, 303);
    assert.deepEqual(await names(id), ['New', 'Reviewing', 'Onboarded', 'Passed']);
  });

  test('edit: the whole save is one atomic batch: a candidate that arrives in a stage being removed, or a changed stage list, aborts everything', async () => {
    const id = await createRole('Atomic flow', ['Reviewing', 'Trial']);
    const first = await applyTo(id);
    const before = await stagesOf(id);
    const trial = before.find((s) => s.name === 'Trial');
    function raceBeforeNextBatch(doRace) {
      const orig = t.db.batch;
      t.db.batch = async (statements) => {
        t.db.batch = orig;
        await doRace();
        return orig.call(t.db, statements);
      };
    }
    // (a) the page was read, then a candidate moved into Trial before the save: Trial is removed + title changed -> abort all
    await admin.get(`/app/admin/roles/${id}`);
    raceBeforeNextBatch(() => t.db.run("UPDATE applications SET stage_id = ?, stage = 'reviewing' WHERE id = ?", [trial.id, first]));
    const res = await saveRole(id, { title: 'Half saved?' }, (f) => ((f.stage_name_1 = ''), f));
    assert.equal(res.status, 409);
    assert.match(res.text, /Nothing was saved/);
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [id])).title, 'Atomic flow');
    assert.deepEqual(await stagesOf(id), before);
    // (b) another admin added a stage in between: the set of stages differs from the form's -> abort all
    raceBeforeNextBatch(() => t.db.run("INSERT INTO role_stages (role_id, position, name, kind, created_at) VALUES (?, 3, 'Sneaky', 'progress', '2026-01-01T00:00:00.000Z')", [id]));
    const res2 = await saveRole(id, { title: 'Half saved 2?' }, (f) => ((f.stage_name_0 = 'Renamed'), f));
    assert.equal(res2.status, 409);
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [id])).title, 'Atomic flow');
    assert.equal((await names(id)).includes('Renamed'), false);
    // (c) a form with a stale list of ids (read before the Sneaky stage existed) is refused up front too
    const stale = await saveRole(id, { title: 'Stale' }, (f) => ((f.stage_ids = before.map((s) => s.id).join(',')), f));
    assert.equal(stale.status, 400);
    assert.match(stale.text, /changed by someone else/);
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [id])).title, 'Atomic flow');
  });

  test('edit: a role form without the workflow editor (an old tab) saves the role and leaves the workflow alone', async () => {
    const id = await createRole('Old tab', ['Alpha', 'Beta']);
    const before = await stagesOf(id);
    await admin.get(`/app/admin/roles/${id}`);
    const res = await admin.post(`/app/admin/roles/${id}`, { title: 'Old tab saved', vertical: 'NFL', status: 'open' });
    assert.equal(res.status, 303);
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [id])).title, 'Old tab saved');
    assert.deepEqual(await stagesOf(id), before);
  });

  test('edit: a stage id from another role in the form is refused (nothing saved)', async () => {
    const a = await createRole('Mine', ['Alpha']);
    const b = await createRole('Theirs', ['Beta']);
    const theirs = (await stagesOf(b)).find((s) => s.name === 'Beta');
    const res = await saveRole(a, { title: 'Hijacked' }, (f) => ((f.stage_id_0 = String(theirs.id)), (f.stage_name_0 = 'Taken over'), f));
    assert.equal(res.status, 400);
    assert.equal((await t.db.get('SELECT name FROM role_stages WHERE id = ?', [theirs.id])).name, 'Beta');
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [a])).title, 'Mine');
  });

  test('access: reps cannot see or change workflows or copy roles; new forms need the CSRF token', async () => {
    const id = await createRole('Admin only', ['Alpha']);
    const before = await stagesOf(id);
    assert.equal((await rep.get(`/app/admin/roles/${id}`)).status, 403);
    assert.equal((await rep.get('/app/admin/roles/new')).status, 403);
    assert.equal((await rep.get(`/app/admin/roles/new?copy=${id}`)).status, 403);
    assert.equal((await rep.get('/app/admin/roles')).status, 403);
    await rep.get('/app');
    const fields = { title: 'Rep edit', vertical: 'NFL', stage_slots: '1', stage_ids: before.map((s) => s.id).join(','), stage_id_0: String(before[1].id), stage_name_0: 'Hacked' };
    assert.equal((await rep.post(`/app/admin/roles/${id}`, fields)).status, 403);
    assert.equal((await rep.post('/app/admin/roles', fields)).status, 403);
    // admin without / with a wrong token
    await admin.get(`/app/admin/roles/${id}`);
    assert.equal((await admin.post(`/app/admin/roles/${id}`, fields, { csrf: null })).status, 403);
    assert.equal((await admin.post(`/app/admin/roles/${id}`, fields, { csrf: 'deadbeef.00' })).status, 403);
    assert.equal((await admin.post('/app/admin/roles', fields, { csrf: 'x' })).status, 403);
    assert.deepEqual(await stagesOf(id), before);
    assert.equal((await t.db.get('SELECT title FROM job_roles WHERE id = ?', [id])).title, 'Admin only');
    // the workflow is on the edit page and the rep still moves candidates through it
    assert.equal(await count(t.db, 'job_roles', "title = 'Rep edit'"), 0);
  });

  // ---------------------------------------------------------------- the pipeline
  test('board and candidate page follow the role: columns in order, "Move to…" lists that role\'s other stages, kinds colour the columns', async () => {
    const id = await createRole('Seven', ['Reviewing', 'Edit test', 'Phone screen', 'Trial']);
    const appId = await applyTo(id, 'Seven Stage');
    const board = await admin.get(`/app/roles/${id}`);
    assert.deepEqual(boardColumns(board.text), ['new:New', 'progress:Reviewing', 'progress:Edit test', 'progress:Phone screen', 'progress:Trial', 'onboarded:Onboarded', 'passed:Passed']);
    const card = columnOf(board.text, 'New');
    const select = /<select name="stage"[^>]*>([\s\S]*?)<\/select>/.exec(card)[1];
    assert.deepEqual([...select.matchAll(/<option value="(\d*)"[^>]*>([^<]*)</g)].map((m) => m[2]), ['Move to…', 'Reviewing', 'Edit test', 'Phone screen', 'Trial', 'Onboarded', 'Passed']);
    const newId = await stageId(t.db, id, 'new');
    assert.match(card, new RegExp(`name="from_stage" value="${newId}"`));
    const page = await admin.get(`/app/applications/${appId}`);
    const steps = [...page.text.matchAll(/<li class="stepper-step stage-(\w+)([^"]*)"[^>]*><span class="stepper-dot" aria-hidden="true"><\/span><span class="stepper-label">([^<]*)</g)];
    assert.deepEqual(steps.map((m) => m[3]), ['New', 'Reviewing', 'Edit test', 'Phone screen', 'Trial', 'Onboarded', 'Passed']);
    assert.match(steps[0][2], /is-current/);
    assert.match(page.text, /<option value="\d+" data-kind="onboarded">Onboarded<\/option>/); // the Voltax fields key off this
    // move through custom stages: legacy column holds the category, stage_id the truth
    await moveStage(admin, t.db, appId, 'Phone screen', 'New');
    let row = await t.db.get('SELECT stage, stage_id FROM applications WHERE id = ?', [appId]);
    assert.equal(row.stage, 'reviewing');
    assert.equal(String(row.stage_id), await stageId(t.db, id, 'Phone screen'));
    const stepsAfter = [...(await admin.get(`/app/applications/${appId}`)).text.matchAll(/<li class="stepper-step stage-(\w+)([^"]*)"/g)].map((m) => m[2]);
    assert.match(stepsAfter[0], /is-done/);
    assert.match(stepsAfter[3], /is-current/);
    await moveStage(admin, t.db, appId, 'Trial', 'Phone screen');
    row = await t.db.get('SELECT stage, stage_id FROM applications WHERE id = ?', [appId]);
    assert.equal(row.stage, 'reviewing');
    assert.equal(String(row.stage_id), await stageId(t.db, id, 'Trial'));
    const moved = await moveStage(admin, t.db, appId, 'Passed', 'Trial');
    assert.equal(moved.status, 303);
    assert.equal((await t.db.get('SELECT stage FROM applications WHERE id = ?', [appId])).stage, 'passed');
    const events = (await t.db.all('SELECT from_value, to_value FROM application_events WHERE application_id = ? ORDER BY id', [appId])).map((e) => `${e.from_value}>${e.to_value}`);
    assert.deepEqual(events, ['null>New', 'New>Phone screen', 'Phone screen>Trial', 'Trial>Passed']);
  });

  test('Onboarded (kind) records the Voltax fields wherever it sits in the role; onboarded_at is set; the Voltax form shows on the candidate page', async () => {
    const id = await createRole('Voltax flow', ['A', 'B']);
    const appId = await applyTo(id);
    const res = await moveStage(admin, t.db, appId, 'Onboarded', 'New', { voltax_user_id: 'vx-1', voltax_onboarded_on: '2026-11-02' });
    assert.equal(res.status, 303);
    const row = await t.db.get('SELECT stage, voltax_user_id, voltax_onboarded_on, onboarded_at FROM applications WHERE id = ?', [appId]);
    assert.deepEqual({ ...row, onboarded_at: Boolean(row.onboarded_at) }, { stage: 'onboarded', voltax_user_id: 'vx-1', voltax_onboarded_on: '2026-11-02', onboarded_at: true });
    assert.match((await admin.get(`/app/applications/${appId}`)).text, /<h3 id="voltax">Voltax<\/h3>/);
    const csv = (await admin.get('/app/export.csv')).text;
    assert.match(csv, /,Onboarded,onboarded,/);
  });

  test('stale tabs: the stage ids must match; a stage of another role, a name, or a stage that was removed writes nothing', async () => {
    const id = await createRole('Stale flow', ['Reviewing', 'Trial']);
    const other = await createRole('Elsewhere', ['Reviewing']);
    const appId = await applyTo(id);
    const events = () => count(t.db, 'application_events', 'application_id = ?', appId);
    const n = await events();
    const reviewing = await stageId(t.db, id, 'Reviewing');
    const trial = await stageId(t.db, id, 'Trial');
    const newId = await stageId(t.db, id, 'New');
    await admin.get(`/app/applications/${appId}`);
    // someone else moves it to Trial; this tab still says it is in New
    await rep.get(`/app/applications/${appId}`);
    await moveStage(rep, t.db, appId, 'Trial', 'New');
    const n2 = await events();
    assert.ok(n2 > n);
    for (const fields of [
      { stage: reviewing, from_stage: newId }, // stale from
      { stage: reviewing, from_stage: await stageId(t.db, other, 'Reviewing') }, // from of another role
      { stage: reviewing }, // no from
      { stage: reviewing, from_stage: 'Trial' }, // a name is not an id
    ]) {
      const res = await admin.post(`/app/applications/${appId}/stage`, fields);
      assert.equal(res.status, 303);
      assert.match((await admin.follow(res)).text, /Someone else changed this candidate/, JSON.stringify(fields));
    }
    for (const stage of [await stageId(t.db, other, 'Reviewing'), 'Reviewing', '0', '-1', '1e3', '9999999']) {
      const res = await admin.post(`/app/applications/${appId}/stage`, { stage, from_stage: trial });
      assert.equal(res.status, 303);
      assert.match((await admin.follow(res)).text, /Unknown stage\./, stage);
    }
    assert.equal(await events(), n2);
    assert.equal(String((await t.db.get('SELECT stage_id FROM applications WHERE id = ?', [appId])).stage_id), trial);
    // a race between the read and the write is caught by the SQL guard (no event, no change)
    const orig = t.db.batch;
    t.db.batch = async (st) => {
      t.db.batch = orig;
      await t.db.run('UPDATE applications SET stage_id = ?, stage = ? WHERE id = ?', [Number(reviewing), 'reviewing', appId]);
      return orig.call(t.db, st);
    };
    const res = await moveStage(admin, t.db, appId, 'Passed', 'Trial');
    assert.match((await admin.follow(res)).text, /Someone else changed this candidate/);
    assert.equal(String((await t.db.get('SELECT stage_id FROM applications WHERE id = ?', [appId])).stage_id), reviewing);
    assert.equal(await events(), n2);
  });

  test('moving to another role maps the stage by kind, then by name (case-insensitive), then to the first in-progress stage, else New; the event log records it', async () => {
    const r1 = await createRole('Map R1', ['Reviewing', 'Edit test', 'Trial']);
    const r2 = await createRole('Map R2', ['TRIAL', 'Phone screen']); // different case
    const r3 = await createRole('Map R3', []); // no in-progress stages at all
    const r4 = await createRole('Map R4', ['Phone screen', 'Other']);
    const move = async (appId, toRole) => {
      const app = await t.db.get('SELECT role_id FROM applications WHERE id = ?', [appId]);
      await admin.get(`/app/applications/${appId}`);
      const res = await admin.post(`/app/applications/${appId}/role`, { role_id: String(toRole), from_role_id: String(app.role_id) });
      assert.equal(res.status, 303);
      return t.db.get('SELECT a.role_id, a.stage, s.name, s.kind, s.role_id AS stage_role FROM applications a JOIN role_stages s ON s.id = a.stage_id WHERE a.id = ?', [appId]);
    };
    // same name, different case
    const a = await applyTo(r1);
    await moveStage(admin, t.db, a, 'Trial', 'New');
    let row = await move(a, r2);
    assert.deepEqual({ ...row }, { role_id: r2, stage: 'reviewing', name: 'TRIAL', kind: 'progress', stage_role: r2 });
    // no stage of that name: the target's first in-progress stage
    const b = await applyTo(r1);
    await moveStage(admin, t.db, b, 'Edit test', 'New');
    row = await move(b, r4);
    assert.equal(row.name, 'Phone screen');
    // a target without in-progress stages: New (legacy category follows)
    const c = await applyTo(r1);
    await moveStage(admin, t.db, c, 'Reviewing', 'New');
    row = await move(c, r3);
    assert.deepEqual({ ...row }, { role_id: r3, stage: 'new', name: 'New', kind: 'new', stage_role: r3 });
    // fixed kinds map to the fixed stages
    const d = await applyTo(r1);
    await moveStage(admin, t.db, d, 'Onboarded', 'New', { voltax_user_id: 'vx-9' });
    assert.equal((await move(d, r4)).name, 'Onboarded');
    const e = await applyTo(r1);
    await moveStage(admin, t.db, e, 'Passed', 'New');
    assert.equal((await move(e, r4)).name, 'Passed');
    const f = await applyTo(r1);
    assert.equal((await move(f, r4)).name, 'New');
    // events: role_change always; stage_change only when the name changes, with names
    const evs = async (id) => (await t.db.all('SELECT type, from_value, to_value FROM application_events WHERE application_id = ? ORDER BY id', [id])).map((x) => `${x.type}:${x.from_value}>${x.to_value}`);
    assert.deepEqual((await evs(a)).slice(-2), [`role_change:Map R1 (#${r1})>Map R2 (#${r2})`, 'stage_change:Trial>TRIAL']);
    assert.deepEqual((await evs(b)).slice(-2), [`role_change:Map R1 (#${r1})>Map R4 (#${r4})`, 'stage_change:Edit test>Phone screen']);
    assert.deepEqual((await evs(c)).slice(-2), [`role_change:Map R1 (#${r1})>Map R3 (#${r3})`, 'stage_change:Reviewing>New']);
    assert.deepEqual((await evs(f)).slice(-1), [`role_change:Map R1 (#${r1})>Map R4 (#${r4})`]); // New stays New: no stage event
    assert.match((await admin.get(`/app/applications/${a}`)).text, /Stage: Trial → TRIAL/);
    // and back again: the name matches case-insensitively
    row = await move(a, r1);
    assert.equal(row.name, 'Trial');
    // the flash says where it landed
    await admin.get(`/app/applications/${b}`);
    const res = await admin.post(`/app/applications/${b}/role`, { role_id: String(r1), from_role_id: String(r4) });
    assert.match((await admin.follow(res)).text, /to Map R1, stage Reviewing\./);
  });

  test('a role move that races with a change of the target workflow writes nothing', async () => {
    const r1 = await createRole('Race R1', ['Reviewing']);
    const r2 = await createRole('Race R2', ['Reviewing']);
    const a = await applyTo(r1);
    await moveStage(admin, t.db, a, 'Reviewing', 'New');
    await admin.get(`/app/applications/${a}`);
    const reviewing2 = Number(await stageId(t.db, r2, 'Reviewing'));
    const orig = t.db.batch;
    const eventsBefore = await count(t.db, 'application_events', 'application_id = ?', a);
    t.db.batch = async (st) => {
      t.db.batch = orig;
      await t.db.run('DELETE FROM role_stages WHERE id = ?', [reviewing2]); // the stage we mapped to disappears
      return orig.call(t.db, st);
    };
    const res = await admin.post(`/app/applications/${a}/role`, { role_id: String(r2), from_role_id: String(r1) });
    assert.match((await admin.follow(res)).text, /Someone else changed this candidate/);
    assert.equal((await t.db.get('SELECT role_id FROM applications WHERE id = ?', [a])).role_id, r1);
    assert.equal(await count(t.db, 'application_events', 'application_id = ?', a), eventsBefore);
  });

  // ---------------------------------------------------------------- dashboard, search, CSV
  test('dashboard: each role card counts its own stages; the strip says "New applications", "In progress" (all progress stages) and "Onboarded this month"', async () => {
    const a = await createRole('Dash A', ['Reviewing', 'Edit test', 'Trial']);
    const b = await createRole('Dash B', ['Phone screen']);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await applyTo(a));
    await moveStage(admin, t.db, ids[1], 'Reviewing', 'New');
    await moveStage(admin, t.db, ids[2], 'Edit test', 'New');
    await moveStage(admin, t.db, ids[3], 'Onboarded', 'New');
    const x = await applyTo(b);
    await moveStage(admin, t.db, x, 'Phone screen', 'New');
    const dash = (await admin.get('/app?view=all')).text;
    const counter = (roleId) => {
      const body = new RegExp(`data-role-id="${roleId}">([\\s\\S]*?)</ol>`).exec(dash)[1];
      return [...body.matchAll(/class="stage-seg ([^"]*)" data-stage="\d+" data-kind="(\w+)"><span class="stage-seg-n">(\d+)<\/span><span class="stage-seg-l">([^<]*)</g)].map((m) => `${m[4]}=${m[3]}`);
    };
    assert.deepEqual(counter(a), ['New=1', 'Reviewing=1', 'Edit test=1', 'Trial=0', 'Onboarded=1', 'Passed=0']);
    assert.deepEqual(counter(b), ['New=0', 'Phone screen=1', 'Onboarded=0', 'Passed=0']);
    const strip = Object.fromEntries([...dash.matchAll(/<span class="summary-n">(\d+)<\/span><span class="summary-l">([^<]+)</g)].map((m) => [m[2], Number(m[1])]));
    assert.ok('New applications' in strip && 'In progress' in strip && 'Onboarded this month' in strip && 'Open roles' in strip);
    assert.equal('In Trial' in strip, false);
    // totals over the roles shown: compare with the database
    const kind = async (k) => (await t.db.get("SELECT COUNT(*) AS n FROM applications a JOIN role_stages s ON s.id = a.stage_id JOIN job_roles r ON r.id = a.role_id WHERE s.kind = ?", [k])).n;
    assert.equal(strip['New applications'], await kind('new'));
    assert.equal(strip['In progress'], await kind('progress'));
    assert.equal(strip['Onboarded this month'] >= 1, true);
    // "My roles" for the rep only counts their roles
    const mine = (await rep.get('/app')).text;
    assert.match(mine, /<span class="summary-l">In progress</);
  });

  test('candidate search and CSV show the stage name and kind', async () => {
    const id = await createRole('Search flow', ['Reviewing', 'Edit test']);
    const appId = await applyTo(id, 'Searchable Sam');
    await moveStage(admin, t.db, appId, 'Edit test', 'New');
    const res = await admin.get('/app/candidates?owner=all&q=searchable');
    assert.match(res.text, /<span class="stage-badge stage-progress">Edit test<\/span>/);
    const csv = (await admin.get('/app/export.csv')).text;
    assert.match(csv, new RegExp(`^${appId},.*,Edit test,progress,`, 'm'));
    assert.match(csv.split('\r\n')[0], /,stage,stage_kind,stage_changed_at,/);
  });

  test('public apply: a new application starts in the New stage of ITS role, even for a custom workflow; a role without stages is repaired when its pipeline is opened', async () => {
    const id = await createRole('Public flow', ['Alpha']);
    const appId = await applyTo(id);
    const row = await t.db.get('SELECT a.stage, a.stage_id, s.name, s.role_id FROM applications a JOIN role_stages s ON s.id = a.stage_id WHERE a.id = ?', [appId]);
    assert.deepEqual({ ...row, stage_id: undefined }, { stage: 'new', stage_id: undefined, name: 'New', role_id: id });
    // a role created by older code (no stage rows)
    const now = new Date().toISOString();
    const raw = (await t.db.run("INSERT INTO job_roles (title, vertical, status, created_at, updated_at) VALUES ('Legacy role', 'NFL', 'open', ?, ?)", [now, now])).lastInsertRowid;
    const legacyApp = await applyTo(raw, 'Legacy Larry');
    assert.equal((await t.db.get('SELECT stage_id FROM applications WHERE id = ?', [legacyApp])).stage_id, null);
    const board = await admin.get(`/app/roles/${raw}`);
    assert.equal(board.status, 200);
    assert.match(columnOf(board.text, 'New'), /Legacy Larry/);
    assert.deepEqual(await names(raw), ['New', 'Reviewing', 'Trial', 'Onboarded', 'Passed']);
    assert.ok((await t.db.get('SELECT stage_id FROM applications WHERE id = ?', [legacyApp])).stage_id);
  });

  // ---------------------------------------------------------------- copying a role
  test('Duplicate: the roles list links to the pre-filled form; nothing is created until saved', async () => {
    const src = await createRole('Original role', ['Reviewing', 'Edit test', 'Trial'], {
      site_name: 'Arrowhead <b>Addict</b>', description: 'Line one\nLine two', q_text_0: 'Why us?', q_required_0: '1', q_text_1: 'Optional one', q_text_2: 'Third?', q_required_2: '1',
    });
    const list = await admin.get('/app/admin/roles');
    assert.match(list.text, new RegExp(`<a href="/app/admin/roles/new\\?copy=${src}">Duplicate<span class="visually-hidden"> Original role</span></a>`));
    const rolesBefore = await count(t.db, 'job_roles');
    const stagesBefore = await count(t.db, 'role_stages');
    const form = await admin.get(`/app/admin/roles/new?copy=${src}`);
    assert.equal(form.status, 200);
    assert.match(form.text, /<h1>New role<\/h1>/);
    assert.match(form.text, /name="title"[^>]*value="Copy of Original role"/);
    assert.match(form.text, /name="vertical"[^>]*value="NFL"/);
    assert.match(form.text, /name="site_name"[^>]*value="Arrowhead &lt;b&gt;Addict&lt;\/b&gt;"/);
    assert.match(form.text, /Line one\nLine two<\/textarea>/);
    assert.match(form.text, /<option value="closed" selected>Closed<\/option>/);
    assert.doesNotMatch(form.text, /<option value="open" selected>/);
    assert.match(form.text, new RegExp(`<option value="${repId}" selected>Rita Rep</option>`));
    assert.match(form.text, /name="q_text_0"[^>]*value="Why us\?"/);
    assert.match(form.text, /name="q_required_0" value="1" checked/);
    assert.match(form.text, /name="q_text_1"[^>]*value="Optional one"/);
    assert.doesNotMatch(form.text, /name="q_required_1" value="1" checked/);
    assert.match(form.text, /name="q_required_2" value="1" checked/);
    assert.match(form.text, /name="stage_name_0"[^>]*value="Reviewing"/);
    assert.match(form.text, /name="stage_name_1"[^>]*value="Edit test"/);
    assert.match(form.text, /name="stage_name_2"[^>]*value="Trial"/);
    assert.match(form.text, /id="copy-notice"/);
    assert.doesNotMatch(form.text, /name="stage_id_\d" value="\d+"/); // new stages, not the source's ids
    assert.match(form.text, /action="\/app\/admin\/roles"/);
    assert.equal(await count(t.db, 'job_roles'), rolesBefore, 'GET creates nothing');
    assert.equal(await count(t.db, 'role_stages'), stagesBefore);
  });

  test('Duplicate: saving creates an independent role with the copied questions and workflow; candidates and the source are untouched', async () => {
    const src = await createRole('Source role', ['Phone screen', 'Trial'], { q_text_0: 'Why us?', q_required_0: '1', q_text_1: 'And?' });
    assert.equal((await t.client().apply(src, { email: email(), name: 'Stays Here', answer_0: 'because' })).status, 303);
    const srcStages = await stagesOf(src);
    const form = await admin.get(`/app/admin/roles/new?copy=${src}`);
    assert.equal(form.status, 200);
    const res = await admin.post('/app/admin/roles', {
      title: 'Copy of Source role', vertical: 'NFL', status: 'closed', assigned_user_id: String(repId), q_text_0: 'Why us?', q_required_0: '1', q_text_1: 'And?',
      stage_slots: '1', stage_name_0: 'Phone screen', stage_pos_0: '1', stage_name_1: 'Trial', stage_pos_1: '2',
    });
    assert.equal(res.status, 303);
    const copy = await t.db.get("SELECT * FROM job_roles WHERE title = 'Copy of Source role'");
    assert.equal(copy.status, 'closed');
    assert.deepEqual(JSON.parse(copy.questions_json), [{ text: 'Why us?', required: true }, { text: 'And?', required: false }]);
    assert.deepEqual(await names(copy.id), ['New', 'Phone screen', 'Trial', 'Onboarded', 'Passed']);
    assert.equal(await count(t.db, 'applications', 'role_id = ?', copy.id), 0, 'candidates are not copied');
    assert.equal(await count(t.db, 'applications', 'role_id = ?', src), 1);
    assert.deepEqual(await stagesOf(src), srcStages, 'the source workflow is untouched');
    assert.equal((await stagesOf(copy.id)).some((s) => srcStages.some((o) => o.id === s.id)), false, 'new stage rows');
    // closed: not on the careers page
    assert.doesNotMatch((await t.client().get('/')).text, /Copy of Source role/);
    // editing the copy does not touch the source
    await saveRole(copy.id, {}, (f) => ((f.stage_name_0 = 'Changed'), f));
    assert.deepEqual(await names(src), ['New', 'Phone screen', 'Trial', 'Onboarded', 'Passed']);
  });

  test('Duplicate: an unknown or malformed copy id gives the plain empty form; titles are escaped and long titles stay valid', async () => {
    for (const bad of ['', 'abc', '0', '-1', '99999999', '1;DROP TABLE job_roles', '1%20OR%201=1', '01', '1e2', '9'.repeat(40)]) {
      const res = await admin.get(`/app/admin/roles/new?copy=${bad}`);
      assert.equal(res.status, 200, bad);
      assert.match(res.text, /name="title"[^>]*value=""/, bad);
      assert.doesNotMatch(res.text, /id="copy-notice"/, bad);
      assert.match(res.text, /name="stage_name_0"[^>]*value="Reviewing"/, bad);
    }
    assert.ok(await t.db.get('SELECT id FROM job_roles LIMIT 1'));
    const xss = await createRole(`${XSS} role`, ['Reviewing']);
    const form = await admin.get(`/app/admin/roles/new?copy=${xss}`);
    assert.doesNotMatch(form.text, /<script>alert\(1\)/);
    assert.match(form.text, new RegExp(`value="Copy of ${XSS_ESCAPED} role"`));
    assert.match(form.text, new RegExp(`copying &quot;${XSS_ESCAPED} role&quot;`));
    const long = (await t.db.run("INSERT INTO job_roles (title, vertical, created_at, updated_at) VALUES (?, 'NFL', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')", ['L'.repeat(200)])).lastInsertRowid;
    const lf = await admin.get(`/app/admin/roles/new?copy=${long}`);
    const title = /name="title"[^>]*value="([^"]*)"/.exec(lf.text)[1];
    assert.equal(title.length, 200);
    assert.deepEqual(await names(long), ['New', 'Reviewing', 'Trial', 'Onboarded', 'Passed']); // repaired lazily
  });

  test('Duplicate: an inactive source rep is not carried over', async () => {
    const gone = await makeUser(t.db, { email: 'gone@fansided.com', name: 'Gone Rep' });
    const src = await createRole('Rep gone role', ['Reviewing'], { assigned_user_id: String(gone) });
    await t.db.run('UPDATE users SET active = 0 WHERE id = ?', [gone]);
    const form = await admin.get(`/app/admin/roles/new?copy=${src}`);
    assert.doesNotMatch(form.text, new RegExp(`<option value="${gone}" selected>`));
    assert.match(form.text, /<option value="" selected>Unassigned<\/option>|<option value="">Unassigned<\/option>/);
  });
});

// QA F-04: Voltax details can only be recorded for a candidate in an Onboarded stage, even with a hand-made request.
for (const driver of DRIVERS) test(`[${driver}] F-04: POST /voltax is refused unless the candidate is onboarded`, async () => {
  const t = await startApp({ driver });
  try {
    const admin = t.client();
    await admin.login('admin@fansided.com');
    const roleId = await makeRole(t.db, { title: 'F04 role' });
    await t.db.run("INSERT INTO people (email, name, created_at, updated_at) VALUES ('vera.voltax@example.com', 'Vera Voltax', ?, ?)", [new Date().toISOString(), new Date().toISOString()]);
    const person = await t.db.get("SELECT id FROM people WHERE email = 'vera.voltax@example.com'");
    await t.db.run(
      "INSERT INTO applications (person_id, role_id, stage, stage_id, applied_at, stage_changed_at) VALUES (?, ?, 'new', ?, ?, ?)",
      [person.id, roleId, await stageId(t.db, roleId, 'New'), new Date().toISOString(), new Date().toISOString()],
    );
    const a = await t.db.get('SELECT id FROM applications WHERE person_id = ?', [person.id]);
    await admin.get(`/app/applications/${a.id}`);
    const res = await admin.post(`/app/applications/${a.id}/voltax`, { voltax_user_id: 'V-1', voltax_onboarded_on: '2026-11-19' });
    assert.equal(res.status, 303);
    const row = await t.db.get('SELECT voltax_user_id FROM applications WHERE id = ?', [a.id]);
    assert.equal(row.voltax_user_id, null);
    assert.equal((await t.db.get("SELECT COUNT(*) AS n FROM application_events WHERE type = 'voltax_recorded'")).n, 0);
  } finally {
    await t.close();
  }
});
