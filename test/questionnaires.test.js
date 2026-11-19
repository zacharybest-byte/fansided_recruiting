'use strict';
// v2.3.0: questionnaire templates. Every test runs on both drivers.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole, makeQuestionnaire, lastApplication, count } = require('./helpers');
const { loadSample, removeSample } = require('../src/lib/sample');
const qn = require('../src/lib/questionnaires');

const XSS = '<script>alert(1)</script>';
const IMG = '"><img src=x onerror=alert(2)>';

for (const driver of DRIVERS) describe(`[${driver}] questionnaires`, () => {
  let t;
  let admin;
  let rep;
  let repId;
  let seq = 0;

  before(async () => {
    t = await startApp({ driver });
    repId = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    admin = t.client();
    await admin.login('admin@fansided.com');
    rep = t.client();
    await rep.login('rep@fansided.com');
  });
  after(() => t.close());

  const email = () => `qn${++seq}@example.com`;
  const questionsOf = (id) => t.db.get('SELECT questions_json FROM questionnaires WHERE id = ?', [id]).then((r) => JSON.parse(r.questions_json));
  const roleRow = (id) => t.db.get('SELECT * FROM job_roles WHERE id = ?', [id]);
  const byName = (name) => t.db.get('SELECT * FROM questionnaires WHERE name = ?', [name]);
  const labels = (text) => [...(/<legend>Questions<\/legend>([\s\S]*?)<\/fieldset>/.exec(text) || [, ''])[1].matchAll(/<label for="f-answer_\d+">([^<]*)/g)].map((m) => m[1].trim());

  async function createQuestionnaire(name, questions = [['Why us?', true]], extra = {}) {
    await admin.get('/app/admin/questionnaires/new');
    const fields = { name, ...extra };
    questions.forEach(([text, required], i) => {
      fields[`q_text_${i}`] = text;
      if (required) fields[`q_required_${i}`] = '1';
    });
    const res = await admin.post('/app/admin/questionnaires', fields);
    assert.equal(res.status, 303, res.text);
    return (await byName(name)).id;
  }

  // Saves a role through the real form. `fields` override the defaults.
  async function saveRole(roleId, fields = {}) {
    const r = await roleRow(roleId);
    await admin.get(`/app/admin/roles/${roleId}`);
    return admin.post(`/app/admin/roles/${roleId}`, { title: r.title, vertical: r.vertical, status: r.status, questionnaire_id: r.questionnaire_id ? String(r.questionnaire_id) : '', ...fields });
  }

  // ------------------------------------------------------------------ access
  test('reps get 403 on every questionnaire admin route; anonymous visitors are sent to sign in', async () => {
    const id = await makeQuestionnaire(t.db, { name: 'Rep proof' });
    for (const url of ['/app/admin/questionnaires', '/app/admin/questionnaires/new', `/app/admin/questionnaires/new?copy=${id}`, `/app/admin/questionnaires/${id}`, `/app/admin/questionnaires/${id}/delete`]) {
      assert.equal((await rep.get(url)).status, 403, `GET ${url}`);
      assert.equal((await t.client().get(url)).status, 302, `anonymous GET ${url}`);
    }
    await rep.get('/app');
    for (const url of ['/app/admin/questionnaires', `/app/admin/questionnaires/${id}`, `/app/admin/questionnaires/${id}/delete`]) {
      assert.equal((await rep.post(url, { name: 'Hacked', q_text_0: 'x' })).status, 403, `POST ${url}`);
    }
    assert.equal(await count(t.db, 'questionnaires', 'name = ?', 'Hacked'), 0);
    assert.ok(await byName('Rep proof'));
    // and the nav shows reps neither item
    const dash = await rep.get('/app');
    assert.doesNotMatch(dash.text, /Questionnaires|Email templates/);
  });

  test('CSRF: every questionnaire POST without a valid token is refused and changes nothing', async () => {
    const id = await makeQuestionnaire(t.db, { name: 'Csrf proof' });
    await admin.get('/app/admin/questionnaires');
    for (const url of ['/app/admin/questionnaires', `/app/admin/questionnaires/${id}`, `/app/admin/questionnaires/${id}/delete`]) {
      assert.equal((await admin.post(url, { name: 'Csrf changed', q_text_0: 'x' }, { csrf: '' })).status, 403, url);
      assert.equal((await admin.post(url, { name: 'Csrf changed', q_text_0: 'x' }, { csrf: 'nope' })).status, 403, url);
      assert.equal((await admin.post(url, { name: 'Csrf changed', q_text_0: 'x' }, { csrf: null })).status, 403, url);
    }
    assert.ok(await byName('Csrf proof'));
    assert.equal(await count(t.db, 'questionnaires', 'name = ?', 'Csrf changed'), 0);
    // the forms carry the token
    for (const url of ['/app/admin/questionnaires/new', `/app/admin/questionnaires/${id}`, `/app/admin/questionnaires/${id}/delete`]) {
      assert.match((await admin.get(url)).text, /name="csrf" value="[0-9a-f.]+"/, url);
    }
  });

  test('the Manage menu has "Email templates" and "Questionnaires" (no bare "Templates"), and marks the current page', async () => {
    const page = await admin.get('/app/admin/questionnaires');
    assert.match(page.text, /<a href="\/app\/admin\/questionnaires" aria-current="page">Questionnaires<\/a>/);
    assert.match(page.text, /<a href="\/app\/admin\/templates">Email templates<\/a>/);
    assert.doesNotMatch(page.text, />Templates</);
    assert.match((await admin.get('/app/admin/templates')).text, /<a href="\/app\/admin\/templates" aria-current="page">Email templates<\/a>/);
  });

  // ------------------------------------------------------------------ CRUD and validation
  test('list: empty state first, then name, question count and "Used by" with linked role titles; Edit, Duplicate, Delete', async () => {
    const fresh = await startApp({ driver });
    try {
      const a = fresh.client();
      await a.login('admin@fansided.com');
      const page = await a.get('/app/admin/questionnaires');
      assert.match(page.text, /No questionnaires yet/);
      assert.match(page.text, /<a class="btn btn-primary" href="\/app\/admin\/questionnaires\/new">Create the first questionnaire<\/a>/);
    } finally {
      await fresh.close();
    }
    const id = await createQuestionnaire('List set', [['One?', true], ['Two?', false]]);
    const r1 = await makeRole(t.db, { title: 'List role A', questionnaire: id });
    const r2 = await makeRole(t.db, { title: 'List role B', questionnaire: id });
    const page = await admin.get('/app/admin/questionnaires');
    assert.equal(page.status, 200);
    assert.match(page.text, /<a href="\/app\/admin\/questionnaires\/new" class="btn btn-primary">New questionnaire<\/a>/);
    const row = new RegExp(`<tr data-questionnaire-id="${id}">[\\s\\S]*?</tr>`).exec(page.text)[0];
    assert.match(row, /<strong>List set<\/strong>/);
    assert.match(row, /<td class="num" data-label="Questions">2<\/td>/);
    assert.match(row, /Used by 2 roles/);
    assert.match(row, new RegExp(`<a href="/app/admin/roles/${r1}">List role A</a>`));
    assert.match(row, new RegExp(`<a href="/app/admin/roles/${r2}">List role B</a>`));
    assert.match(row, new RegExp(`href="/app/admin/questionnaires/${id}">Edit`));
    assert.match(row, new RegExp(`href="/app/admin/questionnaires/new\\?copy=${id}">Duplicate`));
    assert.match(row, new RegExp(`href="/app/admin/questionnaires/${id}/delete">Delete`));
    const unused = await makeQuestionnaire(t.db, { name: 'List unused' });
    assert.match(new RegExp(`<tr data-questionnaire-id="${unused}">[\\s\\S]*?</tr>`).exec((await admin.get('/app/admin/questionnaires')).text)[0], /Not used by any role/);
    // a single user
    const solo = await makeQuestionnaire(t.db, { name: 'List solo' });
    await makeRole(t.db, { title: 'List only role', questionnaire: solo });
    assert.match(new RegExp(`<tr data-questionnaire-id="${solo}">[\\s\\S]*?</tr>`).exec((await admin.get('/app/admin/questionnaires')).text)[0], /Used by 1 role</);
  });

  test('create: stores trimmed name and questions in order with required flags; 5 questions at most; blank rows skipped', async () => {
    await admin.get('/app/admin/questionnaires/new');
    const res = await admin.post('/app/admin/questionnaires', {
      name: '  Create   set  ', q_text_0: '  First?  ', q_required_0: '1', q_text_1: '', q_required_1: '1', q_text_2: 'Third\nwith newline', q_text_3: 'Fourth?', q_text_4: 'Fifth?', q_required_4: '1', q_text_5: 'Sixth is ignored',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/app/admin/questionnaires');
    const q = await byName('Create set');
    assert.ok(q, 'whitespace in the name is collapsed');
    assert.deepEqual(JSON.parse(q.questions_json), [{ text: 'First?', required: true }, { text: 'Third with newline', required: false }, { text: 'Fourth?', required: false }, { text: 'Fifth?', required: true }]);
    assert.equal(q.is_sample, 0);
    assert.match((await admin.get('/app/admin/questionnaires')).text, /Questionnaire created\./);
  });

  test('validation: name required, at most 80, unique ignoring case, at least one question, question at most 500; values are kept; error summary', async () => {
    const existing = await createQuestionnaire('Taken Name');
    const before = await count(t.db, 'questionnaires');
    const post = (fields) => admin.get('/app/admin/questionnaires/new').then(() => admin.post('/app/admin/questionnaires', fields));
    let res = await post({ name: '', q_text_0: 'Kept question' });
    assert.equal(res.status, 400);
    assert.match(res.text, /class="error-summary"/);
    assert.match(res.text, /<a href="#f-name">Name is required\.<\/a>/);
    assert.match(res.text, /id="err-name"/);
    assert.match(res.text, /name="q_text_0"[^>]*value="Kept question"/);
    res = await post({ name: 'x'.repeat(81), q_text_0: 'q' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Name must be at most 80 characters\./);
    assert.equal((await post({ name: 'y'.repeat(80), q_text_0: 'q' })).status, 303, '80 is allowed');
    res = await post({ name: 'taken NAME', q_text_0: 'q' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Another questionnaire already has this name/);
    assert.match(res.text, /name="name"[^>]*value="taken NAME"/);
    res = await post({ name: 'No questions here' });
    assert.equal(res.status, 400);
    assert.match(res.text, /<a href="#f-q0">Add at least one question/);
    res = await post({ name: 'Long question', q_text_0: 'z'.repeat(501) });
    assert.equal(res.status, 400);
    assert.match(res.text, /Questions must be at most 500 characters\./);
    assert.equal((await post({ name: 'Long question ok', q_text_0: 'z'.repeat(500) })).status, 303);
    res = await post({ name: 'Control\u0001char', q_text_0: 'q' });
    assert.equal(res.status, 400);
    assert.equal(await count(t.db, 'questionnaires'), before + 2, 'only the 80-character name and the 500-character question were created');
    assert.ok(existing);
  });

  test('edit: renames and rewrites; the name may change case; another questionnaire\'s name is refused; unknown ids are 404', async () => {
    const id = await createQuestionnaire('Edit me', [['Old?', false]]);
    const other = await createQuestionnaire('Edit other');
    const form = await admin.get(`/app/admin/questionnaires/${id}`);
    assert.match(form.text, /<h1>Edit Edit me<\/h1>/);
    assert.match(form.text, /name="q_text_0"[^>]*value="Old\?"/);
    assert.doesNotMatch(form.text, /id="in-use"/, 'no notice while unused');
    assert.equal((await admin.post(`/app/admin/questionnaires/${id}`, { name: 'EDIT ME', q_text_0: 'New?', q_required_0: '1', q_text_1: 'Added?' })).status, 303);
    assert.deepEqual(await questionsOf(id), [{ text: 'New?', required: true }, { text: 'Added?', required: false }]);
    assert.equal((await t.db.get('SELECT name FROM questionnaires WHERE id = ?', [id])).name, 'EDIT ME');
    await admin.get(`/app/admin/questionnaires/${id}`);
    const clash = await admin.post(`/app/admin/questionnaires/${id}`, { name: 'edit OTHER', q_text_0: 'x' });
    assert.equal(clash.status, 400);
    assert.match(clash.text, /Another questionnaire already has this name/);
    assert.equal((await t.db.get('SELECT name FROM questionnaires WHERE id = ?', [id])).name, 'EDIT ME');
    assert.ok(other);
    for (const url of ['/app/admin/questionnaires/999999', '/app/admin/questionnaires/abc', '/app/admin/questionnaires/999999/delete']) assert.equal((await admin.get(url)).status, 404, url);
    assert.equal((await admin.post('/app/admin/questionnaires/999999', { name: 'x', q_text_0: 'x' })).status, 404);
    assert.equal((await admin.post('/app/admin/questionnaires/999999/delete', {})).status, 404);
  });

  test('two admins saving the same new name at once: exactly one questionnaire is created, the other gets the name error', async () => {
    const other = t.client();
    await other.login('admin@fansided.com');
    await admin.get('/app/admin/questionnaires/new');
    await other.get('/app/admin/questionnaires/new');
    const fields = { name: 'Race name', q_text_0: 'q' };
    const [a, b] = await Promise.all([admin.post('/app/admin/questionnaires', fields), other.post('/app/admin/questionnaires', { ...fields, name: 'RACE NAME' })]);
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses[0], 303);
    assert.ok([400, 409].includes(statuses[1]), `the loser is refused (${statuses[1]})`);
    assert.equal(await count(t.db, 'questionnaires', "name = 'Race name' COLLATE NOCASE"), 1);
  });

  // ------------------------------------------------------------------ XSS on every screen that shows names and questions
  test('XSS: a hostile questionnaire name, question and role title are escaped on every screen that shows them', async () => {
    const name = `Evil ${XSS} ${IMG}`.slice(0, 80);
    const question = `Q ${XSS} ${IMG}`;
    const id = await createQuestionnaire(name, [[question, true]]);
    const roleId = await makeRole(t.db, { title: `Role ${XSS}`, questionnaire: id, assigned: repId });
    const pages = [
      '/app/admin/questionnaires',
      `/app/admin/questionnaires/${id}`,
      `/app/admin/questionnaires/${id}/delete`,
      `/app/admin/questionnaires/new?copy=${id}`,
      '/app/admin/roles',
      `/app/admin/roles/${roleId}`,
      `/app/admin/roles/new?copy=${roleId}`,
    ];
    for (const url of pages) {
      const res = await admin.get(url);
      assert.equal(res.status, 200, url);
      assert.doesNotMatch(res.text, /<script>alert\(1\)/, url);
      assert.doesNotMatch(res.text, /<img src=x/, url);
    }
    const pub = await t.client().get(`/roles/${roleId}`);
    assert.doesNotMatch(pub.text, /<script>alert\(1\)/);
    assert.doesNotMatch(pub.text, /<img src=x/);
    assert.match(pub.text, /Q &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    // the saved-name error page and the success flash too
    await admin.get('/app/admin/questionnaires/new');
    const bad = await admin.post('/app/admin/questionnaires', { name: `${XSS}${'x'.repeat(80)}`, q_text_0: 'q' });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.text, /<script>alert\(1\)/);
    const done = await admin.post(`/app/admin/questionnaires/${id}`, { name, q_text_0: question });
    assert.equal(done.status, 303);
    assert.doesNotMatch((await admin.get('/app/admin/questionnaires')).text, /<script>alert\(1\)/);
    // candidate page: the snapshot with hostile text
    assert.equal((await t.client().apply(roleId, { email: email(), answer_0: `A ${XSS}` })).status, 303);
    const app = await lastApplication(t.db);
    const cand = await admin.get(`/app/applications/${app.id}`);
    assert.equal(cand.status, 200);
    assert.doesNotMatch(cand.text, /<script>alert\(1\)/);
    assert.match(cand.text, /Q &lt;script&gt;/);
  });

  // ------------------------------------------------------------------ a shared questionnaire
  test('editing a shared questionnaire changes the apply form of every role that uses it, straight away; the form warns it is in use', async () => {
    const id = await createQuestionnaire('Shared set', [['Original question?', true]]);
    const roles = [];
    for (const title of ['Shared A', 'Shared B', 'Shared C']) roles.push(await makeRole(t.db, { title, questionnaire: id }));
    const other = await makeRole(t.db, { title: 'Not shared', questions: [{ text: 'Own question', required: false }] });
    for (const r of roles) assert.deepEqual(labels((await t.client().get(`/roles/${r}`)).text), ['Original question?']);

    const form = await admin.get(`/app/admin/questionnaires/${id}`);
    assert.match(form.text, /id="in-use"/);
    assert.match(form.text, /Used by 3 roles\./);
    assert.match(form.text, /Changes apply to all of them straight away\./);
    for (const [i, title] of ['Shared A', 'Shared B', 'Shared C'].entries()) assert.match(form.text, new RegExp(`<a href="/app/admin/roles/${roles[i]}">${title}</a>`));

    const res = await admin.post(`/app/admin/questionnaires/${id}`, { name: 'Shared set', q_text_0: 'Rewritten question?', q_text_1: 'And a second one?', q_required_1: '1' });
    assert.equal(res.status, 303);
    assert.match((await admin.get('/app/admin/questionnaires')).text, /Questionnaire saved\. Used by 3 roles/);
    for (const r of roles) {
      assert.deepEqual(labels((await t.client().get(`/roles/${r}`)).text), ['Rewritten question?', 'And a second one?']);
      assert.equal((await roleRow(r)).questions_json, JSON.stringify([{ text: 'Rewritten question?', required: false }, { text: 'And a second one?', required: true }]), 'legacy copy kept in step');
    }
    assert.deepEqual(labels((await t.client().get(`/roles/${other}`)).text), ['Own question'], 'other roles are not touched');
    // singular wording
    const solo = await createQuestionnaire('Solo set');
    await makeRole(t.db, { title: 'Solo role', questionnaire: solo });
    const soloForm = await admin.get(`/app/admin/questionnaires/${solo}`);
    assert.match(soloForm.text, /Used by 1 role\./);
    assert.match(soloForm.text, /Changes apply to it straight away\./);
  });

  test('past applications are unchanged by editing, swapping or removing a questionnaire: answers are snapshots', async () => {
    const id = await createQuestionnaire('Snapshot set', [['Snapshot question one?', true], ['Snapshot question two?', false]]);
    const roleId = await makeRole(t.db, { title: 'Snapshot role', questionnaire: id, assigned: repId });
    assert.equal((await t.client().apply(roleId, { email: email(), answer_0: 'first answer', answer_1: 'second answer' })).status, 303);
    const app = await lastApplication(t.db);
    const snapshot = app.answers_json;
    assert.deepEqual(JSON.parse(snapshot), [{ question: 'Snapshot question one?', answer: 'first answer' }, { question: 'Snapshot question two?', answer: 'second answer' }]);
    const check = async () => {
      assert.equal((await t.db.get('SELECT answers_json FROM applications WHERE id = ?', [app.id])).answers_json, snapshot);
      const page = await admin.get(`/app/applications/${app.id}`);
      assert.match(page.text, /Snapshot question one\?/);
      assert.match(page.text, /first answer/);
      assert.match(page.text, /Snapshot question two\?/);
      const rp = await rep.get(`/app/applications/${app.id}`);
      assert.match(rp.text, /Snapshot question one\?/);
    };
    await check();
    await admin.get(`/app/admin/questionnaires/${id}`);
    assert.equal((await admin.post(`/app/admin/questionnaires/${id}`, { name: 'Snapshot set', q_text_0: 'Completely different?' })).status, 303);
    await check();
    assert.doesNotMatch((await admin.get(`/app/applications/${app.id}`)).text, /Completely different/);
    const swapTo = await createQuestionnaire('Snapshot other', [['Another?', false]]);
    assert.equal((await saveRole(roleId, { questionnaire_id: String(swapTo) })).status, 303);
    await check();
    assert.equal((await saveRole(roleId, { questionnaire_id: '' })).status, 303);
    await check();
    assert.match((await admin.get('/app/export.csv')).text, /Snapshot role/);
  });

  // ------------------------------------------------------------------ duplicate a questionnaire
  test('Duplicate: a pre-filled "New questionnaire" form named "Copy of …"; nothing is created until saved; the copy is independent', async () => {
    const id = await createQuestionnaire('Original set', [['Keep me?', true], ['And me?', false]]);
    const role = await makeRole(t.db, { title: 'Original user', questionnaire: id });
    const before = await count(t.db, 'questionnaires');
    const form = await admin.get(`/app/admin/questionnaires/new?copy=${id}`);
    assert.equal(form.status, 200);
    assert.match(form.text, /<h1>New questionnaire<\/h1>/);
    assert.match(form.text, /name="name"[^>]*value="Copy of Original set"/);
    assert.match(form.text, /name="q_text_0"[^>]*value="Keep me\?"/);
    assert.match(form.text, /name="q_required_0" value="1" checked/);
    assert.match(form.text, /name="q_text_1"[^>]*value="And me\?"/);
    assert.match(form.text, /id="copy-notice"/);
    assert.doesNotMatch(form.text, /id="in-use"/, 'the copy starts unused');
    assert.match(form.text, /action="\/app\/admin\/questionnaires"/);
    assert.equal(await count(t.db, 'questionnaires'), before, 'GET creates nothing');
    // unknown / hostile copy ids: the plain empty form
    for (const bad of ['999999', 'abc', '1 OR 1=1', '']) {
      const plain = await admin.get(`/app/admin/questionnaires/new?copy=${encodeURIComponent(bad)}`);
      assert.equal(plain.status, 200);
      assert.doesNotMatch(plain.text, /id="copy-notice"/);
    }
    // a very long name is cut to 80 with the prefix
    const longId = await makeQuestionnaire(t.db, { name: 'L'.repeat(80) });
    assert.match((await admin.get(`/app/admin/questionnaires/new?copy=${longId}`)).text, new RegExp(`value="Copy of ${'L'.repeat(72)}"`));
    // saving under the unchanged name is a clash only if it exists
    assert.equal((await admin.post('/app/admin/questionnaires', { name: 'Copy of Original set', q_text_0: 'Keep me?', q_required_0: '1', q_text_1: 'And me?' })).status, 303);
    const copy = await byName('Copy of Original set');
    assert.notEqual(copy.id, id);
    await admin.get('/app/admin/questionnaires/new');
    assert.equal((await admin.post('/app/admin/questionnaires', { name: 'Copy of Original set', q_text_0: 'again' })).status, 400, 'a second copy needs another name');
    // the copy is independent; roles keep using the original
    await admin.get(`/app/admin/questionnaires/${copy.id}`);
    assert.equal((await admin.post(`/app/admin/questionnaires/${copy.id}`, { name: 'Copy of Original set', q_text_0: 'Changed copy' })).status, 303);
    assert.deepEqual(await questionsOf(id), [{ text: 'Keep me?', required: true }, { text: 'And me?', required: false }]);
    assert.equal((await roleRow(role)).questionnaire_id, id);
  });

  // ------------------------------------------------------------------ delete
  test('Delete: a confirm page; refused while any role uses it (names the roles, offers nothing destructive); allowed when unused', async () => {
    const id = await createQuestionnaire('Delete set');
    const r1 = await makeRole(t.db, { title: 'Deleter A', questionnaire: id });
    await makeRole(t.db, { title: 'Deleter B', questionnaire: id });
    const refused = await admin.get(`/app/admin/questionnaires/${id}/delete`);
    assert.equal(refused.status, 200);
    assert.match(refused.text, /This questionnaire is in use/);
    assert.match(refused.text, /It cannot be deleted while 2 roles use it\./);
    assert.match(refused.text, /Deleter A/);
    assert.match(refused.text, /Deleter B/);
    assert.doesNotMatch(refused.text, /Yes, delete questionnaire/);
    assert.doesNotMatch(refused.text, new RegExp(`<form method="post" action="/app/admin/questionnaires/${id}/delete"`));
    // a hand-made POST is refused too, and nothing changes
    await admin.get('/app/admin/questionnaires');
    const post = await admin.post(`/app/admin/questionnaires/${id}/delete`, {});
    assert.equal(post.status, 409);
    assert.match(post.text, /Deleter A/);
    assert.ok(await byName('Delete set'));
    assert.equal((await roleRow(r1)).questionnaire_id, id);
    // switch the roles away, then it can go
    await t.db.run('UPDATE job_roles SET questionnaire_id = NULL, questions_json = ? WHERE questionnaire_id = ?', ['[]', id]);
    const ok = await admin.get(`/app/admin/questionnaires/${id}/delete`);
    assert.match(ok.text, /Yes, delete questionnaire/);
    assert.match(ok.text, /No role uses it/);
    const del = await admin.post(`/app/admin/questionnaires/${id}/delete`, {});
    assert.equal(del.status, 303);
    assert.equal(await byName('Delete set'), undefined);
    assert.match((await admin.get('/app/admin/questionnaires')).text, /Questionnaire &quot;Delete set&quot; deleted\.|Questionnaire "Delete set" deleted\./);
    assert.equal((await admin.get(`/app/admin/questionnaires/${id}`)).status, 404);
  });

  test('Delete is atomic with the in-use check: a role that picks the questionnaire first wins; the delete is refused', async () => {
    const id = await createQuestionnaire('Race delete');
    const roleId = await makeRole(t.db, { title: 'Race role' });
    await admin.get(`/app/admin/roles/${roleId}`);
    const csrfRole = admin.csrf();
    const other = t.client();
    await other.login('admin@fansided.com');
    await other.get(`/app/admin/questionnaires/${id}/delete`);
    const [a, b] = await Promise.all([
      admin.post(`/app/admin/roles/${roleId}`, { title: 'Race role', vertical: 'NFL', status: 'open', questionnaire_id: String(id) }, { csrf: csrfRole }),
      other.post(`/app/admin/questionnaires/${id}/delete`, {}),
    ]);
    const stillThere = Boolean(await byName('Race delete'));
    const role = await roleRow(roleId);
    // either the role saved and the delete was refused, or the delete won and the role save was refused: never a role pointing at nothing
    if (stillThere) {
      assert.equal(role.questionnaire_id, id);
      assert.equal(b.status, 409);
      assert.equal(a.status, 303);
    } else {
      assert.equal(role.questionnaire_id, null);
      assert.equal(b.status, 303);
      assert.ok([400, 409].includes(a.status), `role save refused (${a.status})`);
    }
    assert.equal(await t.db.get('SELECT COUNT(*) AS n FROM job_roles r WHERE r.questionnaire_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM questionnaires q WHERE q.id = r.questionnaire_id)').then((r) => r.n), 0);
  });

  // ------------------------------------------------------------------ the role form
  test('role form: a Questionnaire select (None + all, with question counts), the saved selection previewed, and the two links', async () => {
    const id = await createQuestionnaire('Form set', [['Preview question one?', true], ['Preview question two?', false]]);
    const solo = await createQuestionnaire('Form one', [['Just one?', false]]);
    const roleId = await makeRole(t.db, { title: 'Form role', questionnaire: id });
    const form = await admin.get(`/app/admin/roles/${roleId}`);
    assert.match(form.text, /<legend>Questionnaire<\/legend>/);
    assert.match(form.text, /<select [^>]*name="questionnaire_id">/);
    assert.match(form.text, /<option value="">None \(no questions\)<\/option>/);
    assert.match(form.text, new RegExp(`<option value="${id}" selected>Form set \\(2 questions\\)</option>`));
    assert.match(form.text, new RegExp(`<option value="${solo}">Form one \\(1 question\\)</option>`));
    const preview = /id="qn-preview"[\s\S]*?<\/fieldset>/.exec(form.text)[0];
    assert.match(preview, /Preview question one\?[\s\S]*Required/);
    assert.match(preview, /Preview question two\?[\s\S]*Optional/);
    assert.match(form.text, new RegExp(`<a href="/app/admin/questionnaires/${id}">Edit this questionnaire</a>`));
    assert.match(form.text, /<a href="\/app\/admin\/questionnaires">Manage questionnaires<\/a>/);
    assert.doesNotMatch(form.text, /name="q_text_0"/, 'the per-role question editor is gone');
    // a role without one
    const bare = await makeRole(t.db, { title: 'Bare role' });
    const bareForm = await admin.get(`/app/admin/roles/${bare}`);
    assert.doesNotMatch(bareForm.text, /selected>Form/);
    assert.match(bareForm.text, /No questionnaire: the application form has no Questions section\./);
    assert.doesNotMatch(bareForm.text, /Edit this questionnaire/);
    assert.match(bareForm.text, /Manage questionnaires/);
    // new role form
    const fresh = await admin.get('/app/admin/roles/new');
    assert.match(fresh.text, /<option value="">None \(no questions\)<\/option>/);
    assert.match(fresh.text, /Manage questionnaires/);
  });

  test('create a role with a questionnaire; the role list shows the questionnaire name; "None" shows nothing', async () => {
    const id = await createQuestionnaire('Role list set', [['Listed?', true]]);
    await admin.get('/app/admin/roles/new');
    let res = await admin.post('/app/admin/roles', { title: 'Created with set', vertical: 'NBA', status: 'open', questionnaire_id: String(id) });
    assert.equal(res.status, 303);
    const created = await t.db.get("SELECT * FROM job_roles WHERE title = 'Created with set'");
    assert.equal(created.questionnaire_id, id);
    assert.equal(created.questions_json, JSON.stringify([{ text: 'Listed?', required: true }]));
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM role_stages WHERE role_id = ?', [created.id])).n, 5, 'workflow created with the role');
    assert.deepEqual(labels((await t.client().get(`/roles/${created.id}`)).text), ['Listed?']);
    await admin.get('/app/admin/roles/new');
    res = await admin.post('/app/admin/roles', { title: 'Created bare', vertical: 'NBA', status: 'open', questionnaire_id: '' });
    assert.equal(res.status, 303);
    const bare = await t.db.get("SELECT * FROM job_roles WHERE title = 'Created bare'");
    assert.equal(bare.questionnaire_id, null);
    assert.equal(bare.questions_json, '[]');
    const list = await admin.get('/app/admin/roles');
    const row = (title) => new RegExp(`<tr><td><a href="/app/admin/roles/\\d+"><strong>${title}</strong></a>[\\s\\S]*?</tr>`).exec(list.text)[0];
    assert.match(row('Created with set'), new RegExp(`<a href="/app/admin/questionnaires/${id}">Role list set</a>`));
    assert.match(row('Created bare'), /<span class="muted">None<\/span>/);
    assert.match(list.text, /<th>Questionnaire<\/th>/);
  });

  test('an unknown, removed or malformed questionnaire id on save is an inline error and saves nothing', async () => {
    const id = await createQuestionnaire('Soon gone');
    const roleId = await makeRole(t.db, { title: 'Pointer role', questionnaire: id });
    await t.db.run('UPDATE job_roles SET questionnaire_id = NULL, questions_json = ? WHERE id = ?', ['[]', roleId]);
    await t.db.run('DELETE FROM questionnaires WHERE id = ?', [id]);
    const rolesBefore = await count(t.db, 'job_roles');
    for (const bad of [String(id), '999999', 'abc', '0', '-1', '1.5', '1 OR 1=1', "1'; DROP TABLE job_roles;--"]) {
      const res = await saveRole(roleId, { title: 'Pointer changed', questionnaire_id: bad });
      assert.equal(res.status, 400, bad);
      assert.match(res.text, /id="err-questionnaire_id"/, bad);
      assert.match(res.text, /<a href="#f-questionnaire_id">/, bad);
      assert.equal((await roleRow(roleId)).title, 'Pointer role', `${bad}: nothing saved`);
      await admin.get('/app/admin/roles/new');
      const created = await admin.post('/app/admin/roles', { title: 'Never created', vertical: 'NFL', questionnaire_id: bad });
      assert.equal(created.status, 400, `new role with ${bad}`);
    }
    assert.equal(await count(t.db, 'job_roles'), rolesBefore);
    assert.equal(await count(t.db, 'job_roles', "title = 'Never created'"), 0);
    // the SQL guard on its own: a questionnaire that vanishes between the check and the save aborts the whole batch
    await assert.rejects(t.db.batch([qn.abortIf('? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM questionnaires WHERE id = ?)', [id, id]), { sql: "UPDATE job_roles SET title = 'Guard failed' WHERE id = ?", args: [roleId] }]), (e) => qn.isGuardFailure(e));
    assert.equal((await roleRow(roleId)).title, 'Pointer role');
    await t.db.batch([qn.abortIf('? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM questionnaires WHERE id = ?)', [null, null]), { sql: "UPDATE job_roles SET title = 'Guard passed' WHERE id = ?", args: [roleId] }]);
    assert.equal((await roleRow(roleId)).title, 'Guard passed');
  });

  test('swapping a role\'s questionnaire changes its apply form, keeps the legacy copy in step, and leaves other roles alone', async () => {
    const a = await createQuestionnaire('Swap A', [['Question from A?', true]]);
    const b = await createQuestionnaire('Swap B', [['Question from B?', false], ['Second from B?', true]]);
    const r1 = await makeRole(t.db, { title: 'Swapper', questionnaire: a });
    const r2 = await makeRole(t.db, { title: 'Stays on A', questionnaire: a });
    assert.deepEqual(labels((await t.client().get(`/roles/${r1}`)).text), ['Question from A?']);
    assert.equal((await saveRole(r1, { questionnaire_id: String(b) })).status, 303);
    assert.deepEqual(labels((await t.client().get(`/roles/${r1}`)).text), ['Question from B?', 'Second from B?']);
    assert.deepEqual(labels((await t.client().get(`/roles/${r2}`)).text), ['Question from A?']);
    assert.equal((await roleRow(r1)).questions_json, JSON.stringify([{ text: 'Question from B?', required: false }, { text: 'Second from B?', required: true }]));
    assert.match((await admin.get(`/app/admin/roles/${r1}`)).text, new RegExp(`<option value="${b}" selected>`));
    // to none: no Questions section at all
    assert.equal((await saveRole(r1, { questionnaire_id: '' })).status, 303);
    const pub = await t.client().get(`/roles/${r1}`);
    assert.doesNotMatch(pub.text, /<legend>Questions<\/legend>/);
    assert.equal((await roleRow(r1)).questions_json, '[]');
    // the apply form works with no questions
    assert.equal((await t.client().apply(r1, { email: email() })).status, 303);
    assert.equal(JSON.parse((await lastApplication(t.db)).answers_json).length, 0);
  });

  test('Duplicate role keeps the same questionnaire selected, and the copy shares it (editing the questionnaire changes both)', async () => {
    const id = await createQuestionnaire('Dup role set', [['Dup question?', true]]);
    const src = await makeRole(t.db, { title: 'Dup source', questionnaire: id });
    const form = await admin.get(`/app/admin/roles/new?copy=${src}`);
    assert.match(form.text, new RegExp(`<option value="${id}" selected>Dup role set \\(1 question\\)</option>`));
    assert.match(form.text, /Dup question\?/);
    await admin.post('/app/admin/roles', { title: 'Copy of Dup source', vertical: 'NFL', status: 'closed', questionnaire_id: String(id) });
    const copy = await t.db.get("SELECT * FROM job_roles WHERE title = 'Copy of Dup source'");
    assert.equal(copy.questionnaire_id, id);
    await admin.get(`/app/admin/questionnaires/${id}`);
    await admin.post(`/app/admin/questionnaires/${id}`, { name: 'Dup role set', q_text_0: 'Changed for both?' });
    assert.deepEqual(labels((await t.client().get(`/roles/${src}`)).text), ['Changed for both?']);
    assert.equal((await roleRow(copy.id)).questions_json, JSON.stringify([{ text: 'Changed for both?', required: false }]));
    // a source without a questionnaire gives a copy without one
    const bare = await makeRole(t.db, { title: 'Dup bare' });
    assert.doesNotMatch((await admin.get(`/app/admin/roles/new?copy=${bare}`)).text, /<option value="\d+" selected>/);
  });

  // ------------------------------------------------------------------ the public form and its fingerprint
  test('public form: no questionnaire means no Questions section; required answers are enforced; the answer snapshot uses the questionnaire text', async () => {
    const id = await createQuestionnaire('Public set', [['Must answer?', true], ['May answer?', false]]);
    const roleId = await makeRole(t.db, { title: 'Public role', questionnaire: id });
    const page = await t.client().get(`/roles/${roleId}`);
    assert.match(page.text, /<legend>Questions<\/legend>/);
    assert.match(page.text, /name="answer_0"[^>]* required/);
    assert.doesNotMatch(page.text, /name="answer_1"[^>]* required/);
    const missing = await t.client().apply(roleId, { email: email(), answer_0: '' });
    assert.equal(missing.status, 400);
    assert.match(missing.text, /&quot;Must answer\?&quot; needs an answer\.|"Must answer\?" needs an answer\./);
    assert.equal((await t.client().apply(roleId, { email: email(), answer_0: 'Yes', answer_1: 'Maybe' })).status, 303);
    assert.deepEqual(JSON.parse((await lastApplication(t.db)).answers_json), [{ question: 'Must answer?', answer: 'Yes' }, { question: 'May answer?', answer: 'Maybe' }]);
    const bare = await makeRole(t.db, { title: 'Public bare' });
    assert.doesNotMatch((await t.client().get(`/roles/${bare}`)).text, /Questions/);
  });

  test('fingerprint: a questionnaire EDITED while an applicant has the form open asks them to review, and keeps what they typed', async () => {
    const id = await createQuestionnaire('Fp edit', [['Old Q1', true], ['Old Q2', false]]);
    const roleId = await makeRole(t.db, { title: 'Fp edit role', questionnaire: id });
    const c = t.client();
    await c.get(`/roles/${roleId}`);
    const stale = /name="qv" value="([0-9a-f]+)"/.exec(c.lastHtml)[1];
    await admin.get(`/app/admin/questionnaires/${id}`);
    assert.equal((await admin.post(`/app/admin/questionnaires/${id}`, { name: 'Fp edit', q_text_0: 'New Q1', q_required_0: '1' })).status, 303);
    const before = await count(t.db, 'applications');
    const res = await c.apply(roleId, { name: 'Kept Name', email: 'fpedit@example.com', answer_0: 'answer to old Q1', qv: stale });
    assert.equal(res.status, 409);
    assert.match(res.text, /The questions for this role have changed/);
    assert.match(res.text, /value="Kept Name"/);
    assert.match(res.text, /New Q1/);
    assert.equal(await count(t.db, 'applications'), before, 'nothing stored');
    assert.equal((await c.apply(roleId, { name: 'Kept Name', email: 'fpedit@example.com', answer_0: 'new answer' })).status, 303, 'the fresh form is accepted');
  });

  test('fingerprint: a questionnaire SWAPPED (or added, or removed) while the form is open is detected too', async () => {
    const a = await createQuestionnaire('Fp swap A', [['Swap Q from A', true]]);
    const b = await createQuestionnaire('Fp swap B', [['Swap Q from B', true]]);
    const roleId = await makeRole(t.db, { title: 'Fp swap role', questionnaire: a });
    const stale = async () => {
      const c = t.client();
      await c.get(`/roles/${roleId}`);
      return { c, qv: /name="qv" value="([0-9a-f]+)"/.exec(c.lastHtml)[1] };
    };
    const attempt = async (s, fields = {}) => {
      const before = await count(t.db, 'applications');
      const res = await s.c.apply(roleId, { email: email(), answer_0: 'x', qv: s.qv, ...fields });
      assert.equal(await count(t.db, 'applications'), before + (res.status === 303 ? 1 : 0));
      return res;
    };
    // unchanged: fine
    assert.equal((await attempt(await stale())).status, 303);
    // swapped to another questionnaire
    let s = await stale();
    await saveRole(roleId, { questionnaire_id: String(b) });
    let res = await attempt(s);
    assert.equal(res.status, 409);
    assert.match(res.text, /Swap Q from B/);
    // removed
    s = await stale();
    await saveRole(roleId, { questionnaire_id: '' });
    res = await attempt(s);
    assert.equal(res.status, 409);
    assert.doesNotMatch(res.text, /<legend>Questions<\/legend>/);
    // added to a role that had none
    s = await stale();
    await saveRole(roleId, { questionnaire_id: String(a) });
    res = await attempt(s);
    assert.equal(res.status, 409);
    assert.match(res.text, /Swap Q from A/);
    // swapped to a questionnaire with identical questions: the form is the same, so the applicant is not bothered
    const twin = await createQuestionnaire('Fp swap twin', [['Swap Q from A', true]]);
    s = await stale();
    await saveRole(roleId, { questionnaire_id: String(twin) });
    assert.equal((await attempt(s)).status, 303);
  });

  // ------------------------------------------------------------------ sample data
  describe('sample data', () => {
    let s;
    let sAdmin;
    before(async () => {
      s = await startApp({ driver });
      sAdmin = s.client();
      await sAdmin.login('admin@fansided.com');
    });
    after(() => s.close());
    const sq = () => s.db.all('SELECT * FROM questionnaires ORDER BY name');

    test('load creates three shared questionnaires used by the six sample roles; removing the sample data removes them', async () => {
      const adminId = (await s.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id;
      assert.equal((await loadSample(s.db, adminId)).ok, true);
      const qs = await sq();
      assert.deepEqual(qs.map((x) => x.name), ['Entertainment writer', 'League-wide writer', 'Team site contributor']);
      assert.ok(qs.every((x) => x.is_sample === 1));
      const roles = await s.db.all('SELECT r.title, r.questions_json, q.name AS qn, q.questions_json AS qj FROM job_roles r JOIN questionnaires q ON q.id = r.questionnaire_id WHERE r.is_sample = 1');
      assert.equal(roles.length, 6);
      assert.ok(roles.every((r) => r.questions_json === r.qj), 'legacy copy in step');
      const per = {};
      for (const r of roles) per[r.qn] = (per[r.qn] || 0) + 1;
      assert.deepEqual(per, { 'Team site contributor': 3, 'League-wide writer': 2, 'Entertainment writer': 1 });
      const list = await sAdmin.get('/app/admin/questionnaires');
      assert.match(list.text, /Used by 3 roles/);
      // sample candidates' answers match the questions they were asked
      const app = await s.db.get("SELECT a.answers_json, r.questionnaire_id FROM applications a JOIN job_roles r ON r.id = a.role_id JOIN people p ON p.id = a.person_id WHERE p.is_sample = 1 LIMIT 1");
      assert.equal(JSON.parse(app.answers_json).length, (await s.db.get('SELECT questions_json FROM questionnaires WHERE id = ?', [app.questionnaire_id])).questions_json && JSON.parse((await s.db.get('SELECT questions_json FROM questionnaires WHERE id = ?', [app.questionnaire_id])).questions_json).length);
      await removeSample(s.db);
      assert.equal((await sq()).length, 0);
      assert.equal(await count(s.db, 'job_roles'), 0);
    });

    test('removing keeps (and unmarks) a sample questionnaire that a real role uses', async () => {
      const adminId = (await s.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id;
      await loadSample(s.db, adminId);
      const league = await s.db.get("SELECT id FROM questionnaires WHERE name = 'League-wide writer'");
      const real = await makeRole(s.db, { title: 'Real role', questionnaire: league.id });
      await removeSample(s.db);
      const left = await sq();
      assert.deepEqual(left.map((x) => x.name), ['League-wide writer']);
      assert.equal(left[0].is_sample, 0);
      assert.equal((await s.db.get('SELECT questionnaire_id FROM job_roles WHERE id = ?', [real])).questionnaire_id, league.id);
      // loading again does not clash with the kept questionnaire: it is used as it is
      assert.equal((await loadSample(s.db, adminId)).ok, true);
      assert.equal((await sq()).length, 3);
      assert.equal((await s.db.get("SELECT is_sample FROM questionnaires WHERE name = 'League-wide writer'")).is_sample, 0);
      await removeSample(s.db);
      assert.deepEqual((await sq()).map((x) => x.name), ['League-wide writer'], 'the kept one survives a second removal');
      await s.db.run('DELETE FROM job_roles WHERE id = ?', [real]);
      await s.db.run('DELETE FROM questionnaires');
    });

    test('sample roles that still hold real applications are kept (closed) with their questionnaire, which is kept and unmarked', async () => {
      const adminId = (await s.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id;
      await loadSample(s.db, adminId);
      const role = await s.db.get("SELECT id FROM job_roles WHERE title = 'TV and streaming writer'");
      assert.equal((await s.client().apply(role.id, { email: 'real@example.com', answer_0: 'x' })).status, 303);
      await removeSample(s.db);
      assert.deepEqual((await sq()).map((x) => [x.name, x.is_sample]), [['Entertainment writer', 0]]);
      assert.equal((await s.db.get('SELECT status, is_sample, questionnaire_id FROM job_roles WHERE id = ?', [role.id])).is_sample, 0);
    });
  });
});
