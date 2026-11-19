'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole, lastApplication, count } = require('./helpers');

for (const driver of DRIVERS) describe(`[${driver}]`, () => {

let t;
let rep1;
let rep2;
let roleA;
let roleB;
let roleC;

function dashboardCounts(htmlText, roleId) {
  const row = new RegExp(`data-role-id="${roleId}">([\\s\\S]*?)</ol>`).exec(htmlText);
  if (!row) return null;
  const out = {};
  for (const m of row[1].matchAll(/data-stage="(\w+)"><span class="stage-seg-n">(\d+)</g)) out[m[1]] = Number(m[2]);
  return out;
}

before(async () => {
  t = await startApp({ driver });
  rep1 = await makeUser(t.db, { email: 'rep1@fansided.com', name: 'Rep One' });
  rep2 = await makeUser(t.db, { email: 'rep2@fansided.com', name: 'Rep Two' });
  roleA = await makeRole(t.db, { title: 'Role A', assigned: rep1 });
  roleB = await makeRole(t.db, { title: 'Role B', assigned: rep2 });
  roleC = await makeRole(t.db, { title: 'Role C', assigned: rep1, status: 'closed' });
});
after(() => t.close());

async function applyTo(roleId, email, name = 'Pat Candidate') {
  const res = await t.client().apply(roleId, { email, name });
  assert.equal(res.status, 303);
  return (await lastApplication(t.db)).id;
}

test('AC-18: dashboard shows my roles with per-stage counts; All roles shows every role', async () => {
  const a1 = await applyTo(roleA, 'd1@example.com');
  await applyTo(roleA, 'd2@example.com');
  await applyTo(roleA, 'd3@example.com');
  await applyTo(roleB, 'd4@example.com');
  await t.db.run("UPDATE applications SET stage = 'trial' WHERE id = ?", [a1]);

  const c = t.client();
  await c.login('rep1@fansided.com');
  const mine = await c.get('/app');
  assert.deepEqual(dashboardCounts(mine.text, roleA), { new: 2, reviewing: 0, trial: 1, onboarded: 0, passed: 0 });
  assert.ok(dashboardCounts(mine.text, roleC)); // closed but assigned: still listed internally
  assert.equal(dashboardCounts(mine.text, roleB), null);
  assert.match(mine.text, /class="stage-seg stage-new is-hot" data-stage="new"><span class="stage-seg-n">2</); // new counts highlighted
  const all = await c.get('/app?view=all');
  assert.deepEqual(dashboardCounts(all.text, roleB), { new: 1, reviewing: 0, trial: 0, onboarded: 0, passed: 0 });
  assert.ok(dashboardCounts(all.text, roleA));
  assert.ok(dashboardCounts(all.text, roleC));
  assert.match(mine.text, /href="\/app\/export"/);
});

test('AC-19: role pipeline shows the five stages in fixed order', async () => {
  const c = t.client();
  await c.login('rep1@fansided.com');
  const res = await c.get(`/app/roles/${roleA}`);
  const order = [...res.text.matchAll(/<section class="board-col stage-\w+" id="stage-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['new', 'reviewing', 'trial', 'onboarded', 'passed']);
  const trialSection = res.text.split('id="stage-trial"')[1].split('</section>')[0];
  assert.match(trialSection, /d1@example.com/);
  const newSection = res.text.split('id="stage-new"')[1].split('</section>')[0];
  assert.match(newSection, /d2@example.com/);
  assert.match(newSection, /d3@example.com/);
  assert.match(res.text, /Reassign rep/);
  assert.match(newSection, /class="cand-name" href="\/app\/applications\/\d+"/);
});

test('AC-20 + AC-21: stage changes add events with from/to/actor/time; the log is append-only', async () => {
  const id = await applyTo(roleA, 'stages@example.com');
  const c = t.client();
  await c.login('rep1@fansided.com');
  await c.get(`/app/roles/${roleA}`);
  const before = Date.now();
  const res = await c.post(`/app/applications/${id}/stage`, { stage: 'reviewing', from_stage: 'new', return_to: `/app/roles/${roleA}` });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/app/roles/${roleA}`);
  let app = await t.db.get('SELECT * FROM applications WHERE id = ?', [id]);
  assert.equal(app.stage, 'reviewing');
  let events = await t.db.all('SELECT * FROM application_events WHERE application_id = ? ORDER BY id', [id]);
  assert.equal(events.length, 2);
  const e = events[1];
  assert.equal(e.type, 'stage_change');
  assert.equal(e.from_value, 'new');
  assert.equal(e.to_value, 'reviewing');
  assert.equal(e.actor_user_id, rep1);
  assert.ok(Date.parse(e.at) >= before - 1000);
  assert.equal(app.stage_changed_at, e.at);

  // Picking the current stage again does nothing, and says so.
  const same = await c.post(`/app/applications/${id}/stage`, { stage: 'reviewing', from_stage: 'reviewing' });
  assert.equal(same.status, 303);
  assert.match((await c.follow(same)).text, /Already in Reviewing\./);
  assert.equal(await count(t.db, 'application_events', 'application_id = ?', id), 2);

  const snapshot = JSON.stringify(await t.db.all('SELECT * FROM application_events WHERE application_id = ? ORDER BY id', [id]));
  await c.post(`/app/applications/${id}/stage`, { stage: 'trial', from_stage: 'reviewing' });
  await c.post(`/app/applications/${id}/stage`, { stage: 'passed', from_stage: 'trial' });
  events = await t.db.all('SELECT * FROM application_events WHERE application_id = ? ORDER BY id', [id]);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((x) => [x.from_value, x.to_value]), [[null, 'new'], ['new', 'reviewing'], ['reviewing', 'trial'], ['trial', 'passed']]);
  assert.equal(JSON.stringify(events.slice(0, 2)), snapshot); // earlier rows unchanged
  for (let i = 1; i < events.length; i++) assert.ok(events[i].at >= events[i - 1].at);
  await assert.rejects(t.db.run("UPDATE application_events SET to_value = 'x' WHERE id = ?", [events[0].id]), /append-only/);
  app = await t.db.get('SELECT * FROM applications WHERE id = ?', [id]);
  assert.equal(app.stage, 'passed');

  const page = await c.get(`/app/applications/${id}`);
  assert.match(page.text, /Stage: Trial → Passed/);
  assert.match(page.text, /Applied \(stage New\) <span class="meta">System,/);
});

test('AC-22: Onboarded with Voltax ID and date saves both, sets onboarded_at and calls voltax.createUser', async () => {
  const voltax = require('../src/voltax');
  const calls = [];
  const original = voltax.createUser;
  voltax.createUser = async (person, application) => {
    calls.push({ person, application });
    return original(person, application);
  };
  try {
    assert.deepEqual(await original({}, {}), { status: 'not_configured' });
    const id = await applyTo(roleA, 'onboard@example.com', 'Onna Board');
    const c = t.client();
    await c.login('rep1@fansided.com');
    const page = await c.get(`/app/applications/${id}`);
    assert.match(page.text, /name="voltax_user_id"/);
    assert.match(page.text, /name="voltax_onboarded_on" value="\d{4}-\d{2}-\d{2}"/); // defaults to today
    const res = await c.post(`/app/applications/${id}/stage`, { stage: 'onboarded', from_stage: 'new', voltax_user_id: 'vx-777', voltax_onboarded_on: '2026-11-02' });
    assert.equal(res.status, 303);
    const app = await t.db.get('SELECT * FROM applications WHERE id = ?', [id]);
    assert.equal(app.stage, 'onboarded');
    assert.equal(app.voltax_user_id, 'vx-777');
    assert.equal(app.voltax_onboarded_on, '2026-11-02');
    assert.ok(app.onboarded_at);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].person.email, 'onboard@example.com');
    assert.equal(calls[0].application.id, id);
    const types = (await t.db.all('SELECT type FROM application_events WHERE application_id = ? ORDER BY id', [id])).map((r) => r.type);
    assert.deepEqual(types, ['stage_change', 'stage_change', 'voltax_recorded']);
    const after = await c.follow(res);
    assert.equal(after.status, 200);
    assert.match(after.text, /Voltax details saved/);
  } finally {
    voltax.createUser = original;
  }
});

test('AC-23: moving to another role changes where it appears, logs role_change, keeps notes/emails/events', async () => {
  const id = await applyTo(roleA, 'mover@example.com', 'Mo Ver');
  const c = t.client();
  await c.login('rep1@fansided.com');
  await c.get(`/app/applications/${id}`);
  await c.post(`/app/applications/${id}/stage`, { stage: 'reviewing', from_stage: 'new' });
  await c.post(`/app/applications/${id}/notes`, { body: 'Note before move' });
  await c.post(`/app/applications/${id}/email`, { via: 'gmail', subject: 'Hello', body: 'Body before move' });
  const eventsBefore = await t.db.all('SELECT * FROM application_events WHERE application_id = ? ORDER BY id', [id]);

  const res = await c.post(`/app/applications/${id}/role`, { role_id: String(roleB), from_role_id: String(roleA) });
  assert.equal(res.status, 303);
  const app = await t.db.get('SELECT * FROM applications WHERE id = ?', [id]);
  assert.equal(app.role_id, roleB);
  assert.equal(app.stage, 'reviewing');
  const events = await t.db.all('SELECT * FROM application_events WHERE application_id = ? ORDER BY id', [id]);
  assert.equal(events.length, eventsBefore.length + 1);
  const last = events[events.length - 1];
  assert.equal(last.type, 'role_change');
  assert.equal(last.from_value, `Role A (#${roleA})`);
  assert.equal(last.to_value, `Role B (#${roleB})`);
  assert.equal(await count(t.db, 'notes', 'application_id = ?', id), 1);
  assert.equal(await count(t.db, 'emails_sent', 'application_id = ?', id), 1);

  const pipeA = await c.get(`/app/roles/${roleA}`);
  assert.doesNotMatch(pipeA.text, /mover@example.com/);
  const pipeB = await c.get(`/app/roles/${roleB}`);
  assert.match(pipeB.text.split('id="stage-reviewing"')[1].split('</section>')[0], /mover@example.com/);
  const page = await c.get(`/app/applications/${id}`);
  assert.match(page.text, /Note before move/);
  assert.match(page.text, /Body before move/);
  assert.match(page.text, /Role: Role A \(#\d+\) → Role B/);
});

test('AC-24 + AC-25: notes follow the person; history lists prior applications with role, date, stage', async () => {
  const first = await applyTo(roleA, 'repeat@example.com', 'Rae Peat');
  const c = t.client();
  await c.login('rep2@fansided.com');
  await c.get(`/app/applications/${first}`);
  await c.post(`/app/applications/${first}/stage`, { stage: 'passed', from_stage: 'new' });
  await c.post(`/app/applications/${first}/notes`, { body: 'Good writer, wrong team' });
  await c.post(`/app/applications/${first}/email`, { via: 'gmail', subject: 'Earlier email', body: 'Sent on the first application' });

  const page1 = await c.get(`/app/applications/${first}`);
  assert.match(page1.text, /Rep Two, [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M ET/); // author and friendly time with zone
  assert.match(page1.text, /Good writer, wrong team/);

  const second = await applyTo(roleB, 'REPEAT@example.com', 'Rae Peat');
  const page2 = await c.get(`/app/applications/${second}`);
  assert.match(page2.text, /Good writer, wrong team/);
  assert.match(page2.text, /Earlier email/);
  const notes = page2.text.split('id="notes"')[1].split('</section>')[0];
  assert.match(notes, /<span class="tag">Role A<\/span>/); // tagged with the application's role
  const history = page2.text.split('id="history"')[1].split('</section>')[0];
  assert.match(history, new RegExp(`<a href="/app/applications/${first}">Role A</a></td><td>[A-Z][a-z]{2} \\d{1,2}, \\d{4}</td><td><span class="stage-badge stage-passed">Passed</span></td>`));

  // A note on the second application shows on the first too, newest first.
  await c.post(`/app/applications/${second}/notes`, { body: 'Reapplied for B' });
  const again = await c.get(`/app/applications/${first}`);
  const n = again.text.split('id="notes"')[1];
  assert.ok(n.indexOf('Reapplied for B') < n.indexOf('Good writer, wrong team'));
});

test('AC-31: reassigning a role updates both dashboards', async () => {
  const role = await makeRole(t.db, { title: 'Reassign Me', assigned: rep1 });
  const c1 = t.client();
  await c1.login('rep1@fansided.com');
  const c2 = t.client();
  await c2.login('rep2@fansided.com');
  assert.ok(dashboardCounts((await c1.get('/app')).text, role));
  assert.equal(dashboardCounts((await c2.get('/app')).text, role), null);

  await c1.get(`/app/roles/${role}`);
  const res = await c1.post(`/app/roles/${role}/assign`, { user_id: String(rep2) });
  assert.equal(res.status, 303);
  assert.equal((await t.db.get('SELECT assigned_user_id FROM job_roles WHERE id = ?', [role])).assigned_user_id, rep2);
  assert.equal(dashboardCounts((await c1.get('/app')).text, role), null);
  assert.ok(dashboardCounts((await c2.get('/app')).text, role));

  // Inactive users cannot be picked.
  const inactive = await makeUser(t.db, { email: 'inactive@fansided.com', active: 0 });
  await c1.get(`/app/roles/${role}`);
  await c1.post(`/app/roles/${role}/assign`, { user_id: String(inactive) });
  assert.equal((await t.db.get('SELECT assigned_user_id FROM job_roles WHERE id = ?', [role])).assigned_user_id, rep2);
});
});
