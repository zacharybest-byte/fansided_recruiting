'use strict';
// Regression tests for the third QA round (stale tabs, confirmations, error summaries, mobile menu, wording).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole, lastApplication, count, stageId, moveStage } = require('./helpers');
const { formatDateTimeFriendly } = require('../src/lib/time');
const { sourceLabel } = require('../src/lib/layout');
const { nowIso } = require('../src/lib/db');

const flashOf = async (c, res) => (await c.follow(res)).text.match(/class="flash flash-(ok|error)" role="(?:alert|status)">([^<]*)</);

test('U10: friendly timestamps carry a zone label; sources keep what was typed after a known prefix', () => {
  assert.equal(formatDateTimeFriendly('2026-11-18T19:32:00Z', 'America/New_York'), 'Nov 18, 2026, 2:32 PM ET');
  assert.equal(formatDateTimeFriendly('2026-07-18T19:32:00Z', 'America/New_York'), 'Jul 18, 2026, 3:32 PM ET');
  assert.equal(formatDateTimeFriendly('', 'America/New_York'), '');
  assert.equal(formatDateTimeFriendly('nonsense', 'America/New_York'), '');
  assert.equal(sourceLabel('linkedin'), 'LinkedIn');
  assert.equal(sourceLabel('linkedin-nfl'), 'LinkedIn (linkedin-nfl)');
  assert.equal(sourceLabel('x_promo'), 'X (x_promo)');
  assert.equal(sourceLabel('xylophone'), 'xylophone'); // "x" alone is a prefix only before a separator
  assert.equal(sourceLabel('newsletter'), 'newsletter');
  assert.equal(sourceLabel(''), '');
});

for (const driver of DRIVERS) {
  describe(`[${driver}] QA round 3: stage forms, stale tabs and wording`, () => {
    let t;
    let admin;
    let rep;
    let role;
    let other;
    const newApp = async (email, name = 'Zed New') => {
      await t.client().apply(role, { email, name, answer_0: 'a' });
      return lastApplication(t.db);
    };
    before(async () => {
      t = await startApp({ driver });
      rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      role = await makeRole(t.db, { title: 'Stage Role', assigned: rep, questions: [{ text: 'Why us?', required: true }] });
      other = await makeRole(t.db, { title: 'Other Role', assigned: rep });
      admin = t.client();
      await admin.login('admin@fansided.com');
    });
    after(() => t.close());

    test('B2: stage forms on the board and the candidate page carry from_stage; the role form carries from_role_id', async () => {
      const app = await newApp('forms@example.com');
      const board = await admin.get(`/app/roles/${role}`);
      const newId = await stageId(t.db, role, 'new');
      assert.match(board.text, new RegExp(`<input type="hidden" name="from_stage" value="${newId}">`)); // the stage ID, not its name
      const page = await admin.get(`/app/applications/${app.id}`);
      assert.match(page.text, /<form method="post" action="\/app\/applications\/\d+\/stage" id="stage-form">[\s\S]*?name="from_stage" value="\d+"/);
      assert.match(page.text, /name="from_role_id" value="\d+"/);
      assert.match(page.text, /<h2>Move to another stage<\/h2>/);
      assert.match(page.text, /<label for="f-stage">Stage<\/label>/);
      assert.match(page.text, /<button type="submit" class="btn btn-primary">Move<\/button>/);
    });

    test('B2: a stale tab, a missing from_stage and an invalid from_stage write nothing and flash the conflict message', async () => {
      const app = await newApp('stale@example.com');
      await t.db.run("UPDATE applications SET stage = 'trial' WHERE id = ?", [app.id]); // someone else moved it
      const events = () => count(t.db, 'application_events', 'application_id = ?', app.id);
      const before = await events();
      await admin.get(`/app/applications/${app.id}`);
      const passed = await stageId(t.db, role, 'passed');
      const newStage = await stageId(t.db, role, 'new');
      const otherNew = await stageId(t.db, other, 'new'); // a stage of a different role is never a valid "from"
      for (const fields of [{ stage: passed, from_stage: newStage }, { stage: passed }, { stage: passed, from_stage: 'bogus' }, { stage: passed, from_stage: '' }, { stage: passed, from_stage: otherNew }, { stage: passed, from_stage: 'new' }]) {
        const res = await admin.post(`/app/applications/${app.id}/stage`, fields);
        assert.equal(res.status, 303, JSON.stringify(fields));
        const [, type, msg] = await flashOf(admin, res);
        assert.equal(type, 'error');
        assert.match(msg, /Someone else changed this candidate/);
        assert.equal((await t.db.get('SELECT stage FROM applications WHERE id = ?', [app.id])).stage, 'trial');
        assert.equal(await events(), before, 'no event row');
      }
    });

    test('B2: choosing the stage it is already in says so and writes no event; a real move quotes the name', async () => {
      const app = await newApp('same@example.com', 'Zed New');
      await admin.get(`/app/applications/${app.id}`);
      const moved = await moveStage(admin, t.db, app.id, 'trial', 'new');
      assert.deepEqual((await flashOf(admin, moved)).slice(1), ['ok', 'Moved &quot;Zed New&quot; to Trial.']);
      const n = await count(t.db, 'application_events', 'application_id = ?', app.id);
      const again = await moveStage(admin, t.db, app.id, 'trial', 'trial');
      assert.deepEqual((await flashOf(admin, again)).slice(1), ['ok', 'Already in Trial.']);
      assert.equal(await count(t.db, 'application_events', 'application_id = ?', app.id), n);
    });

    test('the empty "Move to…" choice flashes a prompt and changes nothing', async () => {
      const app = await newApp('empty@example.com');
      const n = await count(t.db, 'application_events', 'application_id = ?', app.id);
      await admin.get(`/app/roles/${role}`);
      const res = await admin.post(`/app/applications/${app.id}/stage`, { stage: '', from_stage: await stageId(t.db, role, 'new'), return_to: `/app/roles/${role}` });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/app/roles/${role}`);
      assert.deepEqual((await flashOf(admin, res)).slice(1), ['error', 'Choose a stage to move this candidate to.']);
      assert.equal((await t.db.get('SELECT stage FROM applications WHERE id = ?', [app.id])).stage, 'new');
      assert.equal(await count(t.db, 'application_events', 'application_id = ?', app.id), n);
      assert.match((await admin.get(`/app/roles/${role}`)).text, /<option value="">Move to…<\/option>/);
    });

    test('B2: moving to another role needs the role the page showed; same role says so', async () => {
      const app = await newApp('role@example.com', 'Rhea Role');
      await admin.get(`/app/applications/${app.id}`);
      const stale = await admin.post(`/app/applications/${app.id}/role`, { role_id: String(other), from_role_id: String(other) });
      assert.match((await flashOf(admin, stale))[2], /Someone else changed this candidate/);
      const missing = await admin.post(`/app/applications/${app.id}/role`, { role_id: String(other) });
      assert.match((await flashOf(admin, missing))[2], /Someone else changed this candidate/);
      assert.equal((await t.db.get('SELECT role_id FROM applications WHERE id = ?', [app.id])).role_id, role);
      assert.equal(await count(t.db, 'application_events', "application_id = ? AND type = 'role_change'", app.id), 0);
      const same = await admin.post(`/app/applications/${app.id}/role`, { role_id: String(role), from_role_id: String(role) });
      assert.deepEqual((await flashOf(admin, same)).slice(1), ['ok', 'Already in Stage Role.']);
      const ok = await admin.post(`/app/applications/${app.id}/role`, { role_id: String(other), from_role_id: String(role) });
      assert.deepEqual((await flashOf(admin, ok)).slice(1), ['ok', 'Moved &quot;Rhea Role&quot; to Other Role.']);
    });

    test('U5 + B3: one Voltax form; fields live in the stage form until onboarded, then a single "Update Voltax details" form', async () => {
      const app = await newApp('voltax@example.com', 'Vera Voltax');
      let page = (await admin.get(`/app/applications/${app.id}`)).text;
      assert.equal((page.match(/name="voltax_user_id"/g) || []).length, 1);
      assert.match(page, /Only used when moving to Onboarded\./);
      assert.doesNotMatch(page, /Update Voltax details/);
      await moveStage(admin, t.db, app.id, 'onboarded', 'new', { voltax_user_id: 'vx-42', voltax_onboarded_on: '2026-11-02' });
      page = (await admin.get(`/app/applications/${app.id}`)).text;
      assert.equal((page.match(/name="voltax_user_id"/g) || []).length, 1, 'only the update form has the field');
      assert.match(page, /action="\/app\/applications\/\d+\/voltax"/);
      assert.match(page, /Update Voltax details/);
      assert.doesNotMatch(page, /Only used when moving to Onboarded/);

      // B3: onboarded this month counts current onboarded applications only; CSV exports onboarded_at only while onboarded.
      const monthCount = async () => /<span class="summary-n">(\d+)<\/span><span class="summary-l">Onboarded this month/.exec((await admin.get('/app?view=all')).text)[1];
      const before = Number(await monthCount());
      assert.ok(before >= 1);
      const csv = async () => {
        const rows = (await admin.get('/app/export.csv')).text.replace(/^﻿/, '').split('\r\n').filter(Boolean).map((l) => l.split(','));
        return rows.find((r) => r[0] === String(app.id));
      };
      const idx = (await admin.get('/app/export.csv')).text.replace(/^﻿/, '').split('\r\n')[0].split(',');
      const onCol = idx.indexOf('onboarded_at');
      const vxCol = idx.indexOf('voltax_user_id');
      assert.ok((await csv())[onCol]);
      await admin.get(`/app/applications/${app.id}`);
      await moveStage(admin, t.db, app.id, 'trial', 'onboarded');
      assert.equal(Number(await monthCount()), before - 1);
      const left = await csv();
      assert.equal(left[onCol], '', 'not onboarded: no onboarded_at in the export');
      assert.equal(left[vxCol], 'vx-42', 'the Voltax id is kept');
      assert.equal((await t.db.get('SELECT voltax_user_id FROM applications WHERE id = ?', [app.id])).voltax_user_id, 'vx-42');
    });

    test('U6 + U4: merge warning is an alert; the hand-off page links back to the candidate; history uses friendly times', async () => {
      const app = await newApp('merge@example.com');
      const tpl = await t.db.run("INSERT INTO email_templates (name, subject, body, updated_at) VALUES ('Odd', 'Hi {{nope}}', 'Body', ?)", [nowIso()]);
      const page = await admin.get(`/app/applications/${app.id}?template=${tpl.lastInsertRowid}`);
      assert.match(page.text, /id="merge-warning" role="alert"/);
      const res = await admin.post(`/app/applications/${app.id}/email`, { via: 'mailto', subject: 'S', body: 'B' });
      assert.match(res.text, new RegExp(`<a class="btn btn-secondary" href="/app/applications/${app.id}#activity">Back to candidate</a>`));
      const after = (await admin.get(`/app/applications/${app.id}`)).text;
      assert.match(after, /[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M ET/);
      assert.doesNotMatch(after, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    });

    test('B5: search shows the match count and a page past the end redirects to the last page', async () => {
      const r2 = await makeRole(t.db, { title: 'Bulk Role' });
      const now = nowIso();
      for (let i = 0; i < 53; i++) {
        const p = await t.db.run('INSERT INTO people (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [`zq${i}@example.com`, `Zqperson ${i}`, now, now]);
        await t.db.run('INSERT INTO applications (person_id, role_id, stage, applied_at, stage_changed_at) VALUES (?, ?, ?, ?, ?)', [p.lastInsertRowid, r2, 'new', now, now]);
      }
      const res = await admin.get('/app/candidates?q=zqperson');
      assert.match(res.text, /id="result-count">53 matches for &quot;zqperson&quot;\. Page 1 of 2</);
      assert.match((await admin.get('/app/candidates?q=zqperson+1')).text, /id="result-count">\d+ matches? for/);
      const past = await admin.get('/app/candidates?q=zqperson&page=9');
      assert.equal(past.status, 303);
      assert.equal(past.headers.get('location'), '/app/candidates?q=zqperson&page=2');
      const none = await admin.get('/app/candidates?q=nomatchatall&page=3');
      assert.equal(none.headers.get('location'), '/app/candidates?q=nomatchatall');
      assert.match((await admin.get('/app/candidates?q=zqperson&page=2')).text, /3 matches|53 matches/);
      assert.match((await admin.get('/app/candidates?q=zqperson1')).text, /No candidates match/);
    });
  });

  describe(`[${driver}] QA round 3: dashboard, admin confirmations, forms and shell`, () => {
    let t;
    let admin;
    let repId;
    before(async () => {
      t = await startApp({ driver });
      repId = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      admin = t.client();
      await admin.login('admin@fansided.com');
    });
    after(() => t.close());

    test('U3 + U2: the account-creation time is the first baseline (no write on GET); Mark as seen only when something is new', async () => {
      const role = await makeRole(t.db, { title: 'Dash Role', assigned: repId, status: 'open' });
      await makeRole(t.db, { title: 'Shut Role', assigned: repId, status: 'closed' });
      await t.db.run("UPDATE users SET created_at = ? WHERE id = ?", [new Date(Date.now() - 60000).toISOString(), repId]);
      const rc = t.client();
      await rc.login('rep@fansided.com');
      let page = (await rc.get('/app')).text;
      assert.doesNotMatch(page, /Mark as seen/);
      assert.doesNotMatch(page, /since your last visit/);
      await t.client().apply(role, { email: 'dash1@example.com' });
      await t.client().apply(role, { email: 'dash2@example.com' });
      page = (await rc.get('/app')).text;
      assert.match(page, /\+2 since your last visit/);
      assert.match(page, />Mark as seen<\/button>/);
      assert.equal((await t.db.get('SELECT dashboard_seen_at FROM users WHERE id = ?', [repId])).dashboard_seen_at, null, 'GET wrote nothing');
      const res = await rc.post('/app/seen', {}, { csrf: rc.csrf(page) });
      assert.match((await flashOf(rc, res))[2], /Marked as seen\. New applications will show as \+N from now on\./);
      assert.doesNotMatch((await rc.get('/app')).text, /Mark as seen/);
    });

    test('A6 + U11: role card titles are h2; only a Closed role gets a status badge; the role form links to the public page when open', async () => {
      const open = await makeRole(t.db, { title: 'Open Card', assigned: repId, status: 'open' });
      const shut = await makeRole(t.db, { title: 'Closed Card', assigned: repId, status: 'closed' });
      const page = (await admin.get('/app?view=all')).text;
      assert.match(page, /<h2 class="role-heading"><a class="role-title" href="\/app\/roles\/\d+">Open Card<\/a><\/h2>/);
      const card = (id) => new RegExp(`data-role-id="${id}">[\\s\\S]*?<div class="role-row-counter">`).exec(page)[0];
      assert.doesNotMatch(card(open), /class="status/);
      assert.match(card(shut), /<span class="status status-closed">Closed<\/span>/);
      assert.match((await admin.get(`/app/admin/roles/${open}`)).text, new RegExp(`href="/roles/${open}">View public page`));
      assert.doesNotMatch((await admin.get(`/app/admin/roles/${shut}`)).text, /View public page/);
      // A rep with no display name shows once, with the label.
      await t.db.run("UPDATE users SET name = '' WHERE id = ?", [repId]);
      assert.match((await admin.get('/app?view=all')).text, /<span>Rep: rep@fansided\.com<\/span>/);
    });

    test('A4 + R2: main is focusable; the small-screen menu is a details element with every link and aria-current', async () => {
      const page = (await admin.get('/app/admin/users')).text;
      assert.match(page, /<main id="main" tabindex="-1">/);
      assert.match(page, /<details class="nav-menu">\s*<summary><span class="nav-menu-label">Menu<\/span><span class="nav-menu-current">Users<\/span><\/summary>/);
      const menu = /<nav class="nav-menu-list" aria-label="Main menu">([\s\S]*?)<\/nav>\s*<\/details>/.exec(page)[1];
      for (const href of ['/app', '/app/candidates', '/app/export', '/app/admin/roles', '/app/admin/templates', '/app/admin/users', '/app/admin/sample']) {
        assert.ok(menu.includes(`href="${href}"`), href);
      }
      assert.match(menu, /<a href="\/app\/admin\/users" aria-current="page">Users<\/a>/);
      assert.equal((menu.match(/aria-current/g) || []).length, 1);
      const rep = t.client();
      await rep.login('rep@fansided.com');
      const repMenu = /<nav class="nav-menu-list"[^>]*>([\s\S]*?)<\/nav>/.exec((await rep.get('/app/export')).text)[1];
      assert.doesNotMatch(repMenu, /admin/);
      assert.match(repMenu, /<a href="\/app\/export" aria-current="page">Export<\/a>/);
    });

    test('A3: admin forms show an error summary that links to the fields', async () => {
      const tpl = await admin.get('/app/admin/templates/new');
      const bad = await admin.post('/app/admin/templates', { name: '', subject: '', body: '' }, { csrf: admin.csrf(tpl.text) });
      assert.equal(bad.status, 400);
      assert.match(bad.text, /<div class="error-summary" id="error-summary" tabindex="-1" role="alert">\s*<h2>There is a problem<\/h2>[\s\S]*<a href="#f-name">Name is required/);
      assert.match(bad.text, /<a href="#f-subject">/);

      const roleNew = await admin.get('/app/admin/roles/new');
      const badRole = await admin.post('/app/admin/roles', { title: '', vertical: '', status: 'open' }, { csrf: admin.csrf(roleNew.text) });
      assert.equal(badRole.status, 400);
      assert.match(badRole.text, /<a href="#f-title">Title is required/);
      assert.match(badRole.text, /<a href="#f-vertical">Vertical is required/);

      const users = await admin.get('/app/admin/users');
      const badUser = await admin.post('/app/admin/users', { email: 'nope', name: '', role: 'rep' }, { csrf: admin.csrf(users.text) });
      assert.equal(badUser.status, 400);
      assert.match(badUser.text, /<a href="#f-email">Enter a valid email address\.<\/a>/);

      const acct = await admin.get('/app/account');
      const badPw = await admin.post('/app/account', { current_password: 'x', password: 'a-long-enough-password', password_confirm: 'different-password-here' }, { csrf: admin.csrf(acct.text) });
      assert.equal(badPw.status, 400);
      assert.match(badPw.text, /<div class="error-summary" id="error-summary"[\s\S]*<a href="#f-password-confirm">The two passwords do not match\.<\/a>/);
      const badCur = await admin.post('/app/account', { current_password: 'wrong', password: 'a-long-enough-password-1', password_confirm: 'a-long-enough-password-1' }, { csrf: admin.csrf(acct.text) });
      assert.match(badCur.text, /<a href="#f-current_password">The current password is not correct\.<\/a>/);
    });

    test('U1: template delete, user deactivate and sample removal go through server-rendered confirm pages (GET changes nothing)', async () => {
      const list = (await admin.get('/app/admin/templates')).text;
      assert.doesNotMatch(list, /data-confirm/);
      const tpl = await t.db.get('SELECT id, name FROM email_templates ORDER BY id LIMIT 1');
      assert.match(list, new RegExp(`href="/app/admin/templates/${tpl.id}/delete">Delete`));
      const before = await count(t.db, 'email_templates');
      const confirm = await admin.get(`/app/admin/templates/${tpl.id}/delete`);
      assert.equal(confirm.status, 200);
      assert.match(confirm.text, /<form method="post" action="\/app\/admin\/templates\/\d+\/delete"[^>]*>\s*<input type="hidden" name="csrf"/);
      assert.doesNotMatch(confirm.text, /data-confirm/);
      assert.equal(await count(t.db, 'email_templates'), before);
      assert.equal((await t.client().get(`/app/admin/templates/${tpl.id}/delete`)).status, 302); // signed out
      const rep = t.client();
      await rep.login('rep@fansided.com');
      assert.equal((await rep.get(`/app/admin/templates/${tpl.id}/delete`)).status, 403);
      assert.equal((await rep.get(`/app/admin/users/${repId}/deactivate`)).status, 403);
      const gone = await admin.post(`/app/admin/templates/${tpl.id}/delete`, {}, { csrf: admin.csrf(confirm.text) });
      assert.equal(gone.status, 303);
      assert.equal(await count(t.db, 'email_templates'), before - 1);

      // deactivate: confirm page for a user without roles and for one with roles
      const solo = await makeUser(t.db, { email: 'solo@fansided.com', name: 'Solo Sam' });
      const page = await admin.get(`/app/admin/users/${solo}/deactivate`);
      assert.match(page.text, /<h1>Deactivate Solo Sam\?<\/h1>/);
      assert.doesNotMatch(page.text, /still the assigned rep/);
      assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [solo])).active, 1);
      const withRoles = await admin.get(`/app/admin/users/${repId}/deactivate`);
      assert.match(withRoles.text, /still the assigned rep for/);
      assert.match(withRoles.text, /Deactivate anyway/);
      assert.equal((await admin.get(`/app/admin/users/${(await t.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id}/deactivate`)).status, 303); // yourself
      const done = await admin.post(`/app/admin/users/${solo}/deactivate`, { confirm: '1' }, { csrf: admin.csrf(page.text) });
      assert.match((await flashOf(admin, done))[2], /Solo Sam deactivated\./);
      assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [solo])).active, 0);
      const re = await admin.post(`/app/admin/users/${solo}/reactivate`);
      assert.deepEqual((await flashOf(admin, re)).slice(1), ['ok', 'Reactivated. Create a reset link so they can sign in.']);

      // sample removal with nothing loaded just goes back
      const none = await admin.get('/app/admin/sample/remove');
      assert.equal(none.status, 303);
    });

    test('U8: user buttons are named consistently and flashes use the name', async () => {
      const fresh = await makeUser(t.db, { email: 'invitee@fansided.com', name: 'Ivy Invitee', password: null });
      const page = (await admin.get('/app/admin/users')).text;
      assert.match(page, /Create invite link<\/button>/);
      assert.match(page, /Create reset link<\/button>/);
      assert.doesNotMatch(page, /New invite link/);
      assert.doesNotMatch(page, /class="btn btn-primary">Add a user/);
      assert.match(page, /<a href="#add-user" class="btn btn-quiet">Add a user<\/a>/);
      const res = await admin.post(`/app/admin/users/${fresh}/role`, { role: 'admin' }, { csrf: admin.csrf(page) });
      assert.deepEqual((await flashOf(admin, res)).slice(1), ['ok', 'Ivy Invitee is now an admin.']);
    });

    test('A1 + A2: the apply form errors name the field; /thanks is reached without a fragment', async () => {
      const role = await makeRole(t.db, { title: 'Apply Role', questions: [{ text: 'Which Chiefs storyline will define the season for the fan base?', required: true }, { text: 'Short?', required: true }] });
      const c = t.client();
      const res = await c.apply(role, { name: '', email: '', sample_links: '', answer_0: '', answer_1: '' });
      assert.equal(res.status, 400);
      for (const text of ['Full name is required.', 'Email is required.', 'Writing samples needs at least one link.', '&quot;Short?&quot; needs an answer.', '&quot;Which Chiefs storyline will define the season for…&quot; needs an answer.']) {
        assert.ok(res.text.includes(`>${text}</a>`), `summary link: ${text}`);
        assert.ok(res.text.includes(`>${text}</p>`), `inline: ${text}`);
      }
      assert.match(res.text, /<a class="btn btn-primary" href="#apply">Go to application form<\/a>/);
      assert.doesNotMatch(res.text, /action="\/roles\/\d+\/apply#/);
      const ok = await c.apply(role, { answer_0: 'x', answer_1: 'y' });
      assert.equal(ok.headers.get('location'), '/thanks');
    });

    test('U9 + U12: invalid links share one page titled "This link is no longer valid"; unknown ?vertical= shows all roles', async () => {
      for (const url of ['/set-password?token=nope', `/set-password?token=${'a'.repeat(43)}`, '/setup?token=nope']) {
        const res = await t.client().get(url);
        assert.equal(res.status, 404, url);
        assert.match(res.text, /<title>This link is no longer valid \| FanSided<\/title>/);
        assert.match(res.text, /<a class="btn btn-primary btn-block" href="\/login">Go to sign in<\/a>/);
      }
      await makeRole(t.db, { title: 'Chip Role', vertical: 'NFL' });
      await makeRole(t.db, { title: 'Chip Role Two', vertical: 'NBA' });
      const page = (await t.client().get('/?vertical=Cricket')).text;
      assert.match(page, /<a class="chip" href="\/" aria-current="true">All roles<\/a>/);
      assert.equal((page.match(/aria-current="true"/g) || []).length, 1);
      assert.match(page, /Chip Role Two/);
    });

    test('A7 + A5 + R3: the stylesheet has readable disabled colours, 44px tap targets and a wrapping stage counter at small widths', async () => {
      const css = (await t.client().get('/public/style.css')).text;
      assert.match(css, /button:disabled[^{]*\{[^}]*color: #6b6b67/);
      assert.doesNotMatch(css, /opacity: 0\.45/);
      assert.match(css, /@media \(max-width: 600px\) \{[^@]*min-height: 2\.75rem/);
      assert.match(css, /\.stage-counter \{ list-style: none; display: grid; grid-template-columns: repeat\(auto-fit, minmax\(4\.25rem/);
      assert.match(css, /@media \(max-width: 400px\) \{ \.stage-counter \{ grid-template-columns: repeat\(auto-fit, minmax\(3\.75rem/);
      assert.match(css, /\.nav-menu \{ display: none; \}/);
    });
  });
}
