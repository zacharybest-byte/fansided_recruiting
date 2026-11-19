'use strict';
// Stage B: candidates tab owner + status filters, and the application history panel on the candidate page.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole } = require('./helpers');
const { nowIso } = require('../src/lib/db');
const { legacyCategory } = require('../src/lib/stages');

const rowsOf = (text) => [...text.matchAll(/<a href="\/app\/applications\/(\d+)"><strong>([^<]*)<\/strong>/g)].map((m) => m[2]);
const D = (n) => new Date(Date.UTC(2026, 9, 1, 12) + n * 86400000).toISOString();

async function person(db, name, email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`) {
  const now = nowIso();
  return Number((await db.run('INSERT INTO people (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [email, name, now, now])).lastInsertRowid);
}
// An application in the named stage of the role's own workflow; the legacy column gets the category like the app does.
async function app(db, roleId, personId, stageName, appliedAt, changedAt = appliedAt) {
  const st = await db.get('SELECT id, kind FROM role_stages WHERE role_id = ? AND name = ?', [roleId, stageName]);
  assert.ok(st, `stage ${stageName}`);
  const r = await db.run('INSERT INTO applications (person_id, role_id, stage, stage_id, applied_at, stage_changed_at) VALUES (?, ?, ?, ?, ?, ?)', [personId, roleId, legacyCategory(st.kind), st.id, appliedAt, changedAt]);
  return Number(r.lastInsertRowid);
}

for (const driver of DRIVERS) {
  describe(`[${driver}] candidates owner and status filters`, () => {
    let t, admin, ritaC, samC, rita, sam, roleA, roleB, roleU, roleC;
    before(async () => {
      t = await startApp({ driver });
      rita = await makeUser(t.db, { email: 'rita@fansided.com', name: 'Rita Rep' });
      sam = await makeUser(t.db, { email: 'sam@fansided.com', name: 'Sam <b>Rep</b>' });
      roleA = await makeRole(t.db, { title: 'Role A', site: 'Site A', assigned: rita });
      roleB = await makeRole(t.db, { title: 'Role B', site: 'Site B', assigned: sam });
      roleU = await makeRole(t.db, { title: 'Role U', site: 'Site U' });
      roleC = await makeRole(t.db, { title: 'Role C', site: 'Site C', assigned: rita, progress: ['Edit test'] });
      const mk = async (role, stage, name, day, changed) => app(t.db, role, await person(t.db, name), stage, D(day), changed === undefined ? D(day) : D(changed));
      await mk(roleA, 'New', 'A New', 1);
      await mk(roleA, 'Reviewing', 'A Reviewing', 2, 10);
      await mk(roleA, 'Onboarded', 'A Onboarded', 3);
      await mk(roleA, 'Passed', 'A Passed', 4);
      await mk(roleB, 'New', 'B New', 5);
      await mk(roleB, 'Passed', 'B Passed', 6);
      await mk(roleU, 'New', 'U New', 7);
      await mk(roleC, 'Edit test', 'C Edit', 8, 8);
      admin = t.client(); await admin.login('admin@fansided.com');
      ritaC = t.client(); await ritaC.login('rita@fansided.com');
      samC = t.client(); await samC.login('sam@fansided.com');
    });
    after(() => t.close());
    const names = async (c, qs = '') => rowsOf((await c.get(`/app/candidates${qs}`)).text);

    test('default is my candidates, active only (new + in progress), most recently applied first', async () => {
      assert.deepEqual(await names(ritaC), ['C Edit', 'A Reviewing', 'A New']);
      assert.deepEqual(await names(samC), ['B New']);
      const res = await ritaC.get('/app/candidates');
      assert.match(res.text, /id="result-count">3 active candidates on your roles, most recently applied first</);
      assert.doesNotMatch(res.text, /Clear filters/);
    });

    test('an admin also starts on their own roles (none here) and is told what to change', async () => {
      const res = await admin.get('/app/candidates');
      assert.deepEqual(rowsOf(res.text), []);
      assert.match(res.text, /No active candidates on your roles/);
      assert.match(res.text, /href="\/app\/candidates\?owner=all"/);
      assert.match(res.text, /href="\/app\/candidates\?status=all">Show all statuses \(0\)|Show all candidates/);
    });

    test('owner=all shows everyone; owner=none the roles without a rep', async () => {
      assert.deepEqual((await names(ritaC, '?owner=all')).sort(), ['A New', 'A Reviewing', 'B New', 'C Edit', 'U New']);
      assert.deepEqual((await names(admin, '?owner=all')).slice().sort(), ['A New', 'A Reviewing', 'B New', 'C Edit', 'U New']);
      assert.deepEqual(await names(admin, '?owner=none'), ['U New']);
      assert.match((await admin.get('/app/candidates?owner=none')).text, /1 active candidate on roles without a rep/);
    });

    test('an admin can view another rep by id; the summary names them', async () => {
      assert.deepEqual(await names(admin, `?owner=${rita}`), ['C Edit', 'A Reviewing', 'A New']);
      const res = await admin.get(`/app/candidates?owner=${sam}`);
      assert.deepEqual(rowsOf(res.text), ['B New']);
      assert.match(res.text, /on Sam &lt;b&gt;Rep&lt;\/b&gt;&#39;s roles/);
      assert.doesNotMatch(res.text, /<b>Rep<\/b>/);
      assert.match(res.text, new RegExp(`<option value="${sam}" selected>Sam &lt;b&gt;Rep`));
    });

    test('a rep passing another user id, none, or junk gets their own list, not an error', async () => {
      for (const owner of [sam, 'none', 'abc', '0', '-1', '9999999', `${rita}x`, '']) {
        const res = await ritaC.get(`/app/candidates?owner=${owner}`);
        assert.equal(res.status, 200, String(owner));
        assert.deepEqual(rowsOf(res.text), ['C Edit', 'A Reviewing', 'A New'], String(owner));
      }
      // admin with an unknown id: own (empty) list
      assert.deepEqual(await names(admin, '?owner=999999'), []);
      assert.match((await admin.get('/app/candidates?owner=999999')).text, /on your roles/);
    });

    test('every status value filters; the default hides passed; unknown values fall back to active', async () => {
      const all = (qs) => names(admin, `?owner=all${qs}`).then((n) => n.sort());
      assert.deepEqual(await all(''), ['A New', 'A Reviewing', 'B New', 'C Edit', 'U New']);
      assert.deepEqual(await all('&status=active'), ['A New', 'A Reviewing', 'B New', 'C Edit', 'U New']);
      assert.deepEqual(await all('&status=new'), ['A New', 'B New', 'U New']);
      assert.deepEqual(await all('&status=progress'), ['A Reviewing', 'C Edit']);
      assert.deepEqual(await all('&status=onboarded'), ['A Onboarded']);
      assert.deepEqual(await all('&status=passed'), ['A Passed', 'B Passed']);
      assert.deepEqual(await all('&status=all'), ['A New', 'A Onboarded', 'A Passed', 'A Reviewing', 'B New', 'B Passed', 'C Edit', 'U New']);
      assert.deepEqual(await all('&status=bogus'), ['A New', 'A Reviewing', 'B New', 'C Edit', 'U New']);
      assert.deepEqual(await all('&status=%27%20OR%201=1--'), ['A New', 'A Reviewing', 'B New', 'C Edit', 'U New']);
      assert.match((await admin.get('/app/candidates?owner=all&status=passed')).text, /2 passed candidates on all roles/);
      assert.match((await admin.get('/app/candidates?owner=all&status=all')).text, /8 candidates on all roles/);
    });

    test('status chips carry counts for the current owner and search scope', async () => {
      const chips = (text) => Object.fromEntries([...text.matchAll(/<a class="chip" href="[^"]*"(?: aria-current="true")?>([^<]+?) <span class="chip-count">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]));
      assert.deepEqual(chips((await ritaC.get('/app/candidates')).text), { Active: 3, New: 1, 'In progress': 2, Onboarded: 1, Passed: 1, 'All statuses': 5 });
      assert.deepEqual(chips((await admin.get('/app/candidates?owner=all')).text), { Active: 5, New: 3, 'In progress': 2, Onboarded: 1, Passed: 2, 'All statuses': 8 });
      assert.deepEqual(chips((await admin.get('/app/candidates?owner=all&q=A%20P&status=new')).text), { Active: 0, New: 0, 'In progress': 0, Onboarded: 0, Passed: 1, 'All statuses': 1 });
      const html = (await admin.get('/app/candidates?owner=all&status=passed')).text;
      assert.match(html, /<a class="chip" href="\/app\/candidates\?owner=all&amp;status=passed" aria-current="true">Passed <span/);
    });

    test('search combines with both filters and every link keeps the other parameters', async () => {
      const res = await admin.get(`/app/candidates?owner=${rita}&status=all&sort=stage_age&q=a.`);
      assert.deepEqual(rowsOf(res.text).sort(), ['A New', 'A Onboarded', 'A Passed', 'A Reviewing']);
      assert.match(res.text, new RegExp(`href="/app/candidates\\?q=a.&amp;owner=all&amp;status=all&amp;sort=stage_age"`));
      assert.match(res.text, new RegExp(`href="/app/candidates\\?q=a.&amp;owner=${rita}&amp;status=passed&amp;sort=stage_age"`));
      assert.match(res.text, new RegExp(`href="/app/candidates\\?q=a.&amp;owner=${rita}&amp;status=all"`)); // order chip back to recent
      assert.match(res.text, /name="owner" value="\d+"/); // the search form keeps the owner
      assert.match(res.text, /name="status" value="all"/);
      assert.match(res.text, /name="sort" value="stage_age"/);
      // the rep picker keeps q, status, sort
      const picker = res.text.split('id="rep-picker"')[1].split('</form>')[0];
      assert.match(picker, /name="q" value="a\."/);
      assert.match(picker, /name="status" value="all"/);
      assert.match(picker, /name="sort" value="stage_age"/);
      assert.match(res.text, /id="clear-filters"/);
    });

    test('sort=stage_age lists the longest in stage first; days in stage are shown', async () => {
      const res = await admin.get('/app/candidates?owner=all&status=all&sort=stage_age');
      const order = rowsOf(res.text);
      assert.equal(order[0], 'A New'); // changed earliest (day 1)
      assert.equal(order[order.length - 1], 'A Reviewing'); // changed last (day 10)
      assert.match(res.text, /longest in stage first/);
      assert.match(res.text, /data-label="Days in stage" class="num">\d+</);
    });

    test('columns: candidate, role and site, stage name with kind colour, rep, applied date', async () => {
      const text = (await admin.get('/app/candidates?owner=all&q=C+Edit')).text;
      assert.match(text, /<th>Candidate<\/th><th>Role<\/th><th>Stage<\/th><th>Rep<\/th><th>Applied<\/th><th class="num">Days in stage<\/th>/);
      assert.match(text, /<span class="cell-sub">c\.edit@example\.com<\/span>/);
      assert.match(text, /Role C<span class="cell-sub">Site C<\/span>/);
      assert.match(text, /<span class="stage-badge stage-progress">Edit test<\/span>/);
      assert.match(text, /data-label="Rep">Rita Rep</);
      assert.match(text, /data-label="Applied">Oct 9, 2026</);
      assert.match((await admin.get('/app/candidates?owner=all&q=U+New')).text, /data-label="Rep"><span class="muted">Unassigned<\/span>/);
      assert.match(text, /class="table-wrap table-stack"/);
    });

    test('only admins get the rep picker, listing active users and unassigned roles', async () => {
      assert.doesNotMatch((await ritaC.get('/app/candidates')).text, /rep-picker/);
      const text = (await admin.get('/app/candidates')).text;
      const picker = text.split('id="rep-picker"')[1].split('</form>')[0];
      assert.match(picker, /<label for="f-owner">Rep<\/label>/);
      assert.match(picker, new RegExp(`<option value="${rita}">Rita Rep</option>`));
      assert.match(picker, /Unassigned roles/);
      assert.match(picker, /<button type="submit" class="btn btn-secondary">Show<\/button>/);
      await makeUser(t.db, { email: 'gone@fansided.com', name: 'Gone Rep', active: 0 });
      assert.doesNotMatch((await admin.get('/app/candidates')).text, />Gone Rep</);
    });

    test('Clear filters appears only when something is not the default; empty states say what to change', async () => {
      assert.doesNotMatch((await ritaC.get('/app/candidates')).text, /Clear filters/);
      for (const qs of ['?owner=all', '?status=passed', '?sort=stage_age', '?q=a']) assert.match((await ritaC.get(`/app/candidates${qs}`)).text, /href="\/app\/candidates" id="clear-filters">Clear filters/, qs);
      const empty = await samC.get('/app/candidates?status=onboarded');
      assert.match(empty.text, /No onboarded candidates on your roles/);
      assert.match(empty.text, /Show all candidates/);
      assert.match(empty.text, /Clear filters/);
      const nomatch = await samC.get('/app/candidates?q=zzzz');
      assert.match(nomatch.text, /No active candidates on your roles matching "zzzz"/);
      assert.match(nomatch.text, /Clear the search/);
    });

    test('XSS in q, owner, status and sort is escaped or ignored', async () => {
      const bad = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
      for (const key of ['q', 'owner', 'status', 'sort']) {
        const res = await admin.get(`/app/candidates?${key}=${encodeURIComponent(bad)}&owner=all`);
        assert.equal(res.status, 200);
        assert.doesNotMatch(res.text, /<script>alert/);
        assert.doesNotMatch(res.text, /<img src=x/);
      }
      assert.match((await admin.get(`/app/candidates?q=${encodeURIComponent(bad)}`)).text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });

    test('signed-out visitors are redirected to sign in', async () => {
      const res = await t.client().get('/app/candidates?owner=all&status=passed');
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /^\/login/);
    });

    test('pagination keeps owner, status, sort and q in the previous / next links', async () => {
      const bulk = await makeRole(t.db, { title: 'Bulk', assigned: rita });
      for (let i = 0; i < 60; i++) await app(t.db, bulk, await person(t.db, `Bulk ${i}`), i % 2 ? 'Reviewing' : 'New', new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString());
      const p1 = await admin.get(`/app/candidates?owner=${rita}&status=active&sort=stage_age&q=bulk`);
      assert.equal(rowsOf(p1.text).length, 50);
      assert.match(p1.text, new RegExp(`class="btn btn-secondary pager-next" rel="next" href="/app/candidates\\?q=bulk&amp;owner=${rita}&amp;sort=stage_age&amp;page=2"`));
      const p2 = await admin.get(`/app/candidates?owner=${rita}&sort=stage_age&q=bulk&page=2`);
      assert.equal(rowsOf(p2.text).length, 10);
      assert.match(p2.text, new RegExp(`pager-prev"? rel="prev" href="/app/candidates\\?q=bulk&amp;owner=${rita}&amp;sort=stage_age"`));
      const past = await admin.get(`/app/candidates?owner=${rita}&q=bulk&page=9`);
      assert.equal(past.status, 303);
      assert.equal(past.headers.get('location'), `/app/candidates?q=bulk&owner=${rita}&page=2`);
    });
  });

  describe(`[${driver}] application history panel`, () => {
    let t, admin, roleOld, roleMid, roleNow, roleOther, first, second, third;
    const XSS = '<img src=x onerror=alert(1)>';
    before(async () => {
      t = await startApp({ driver });
      const rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      roleOld = await makeRole(t.db, { title: 'Old Role', site: 'Old Site', assigned: rep });
      roleMid = await makeRole(t.db, { title: `Mid ${XSS}`, site: 'Mid Site', assigned: rep });
      roleNow = await makeRole(t.db, { title: 'Current Role', assigned: rep });
      roleOther = await makeRole(t.db, { title: 'Someone Else Role', assigned: rep });
      const pid = await person(t.db, 'Repeat Person', 'repeat.person.with.a.very.long.address.that.must.wrap@subdomain.example.com');
      first = await app(t.db, roleOld, pid, 'Onboarded', D(1), D(5));
      second = await app(t.db, roleMid, pid, 'Passed', D(20), D(25));
      third = await app(t.db, roleNow, pid, 'New', D(40));
      const stillOpen = await app(t.db, roleOther, pid, 'Reviewing', D(30), D(31));
      await app(t.db, roleOther, await person(t.db, 'Other Person'), 'Passed', D(2));
      const note = (appId, body, at) => t.db.run('INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at) VALUES (?, ?, (SELECT role_id FROM applications WHERE id = ?), ?, ?, ?)', [pid, appId, appId, rep, body, at]);
      await note(second, `Weak pitches ${XSS}`, D(24));
      await note(second, 'Reliable, would reconsider', D(25));
      await note(first, 'Great first season', D(4));
      await t.db.run('INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at) VALUES (?, ?, ?, ?, ?, ?)', [second, 'stage_change', 'New', 'Passed', rep, D(25)]);
      t.stillOpen = stillOpen;
      admin = t.client(); await admin.login('admin@fansided.com');
    });
    after(() => t.close());

    test('the panel sits under the stepper, before the two columns, with the summary line', async () => {
      const text = (await admin.get(`/app/applications/${third}`)).text;
      assert.ok(text.indexOf('class="stepper"') < text.indexOf('id="history"'));
      assert.ok(text.indexOf('id="history"') < text.indexOf('class="grid-2 wide-left"'));
      assert.match(text, /<h2 id="history-h">Application history<\/h2>/);
      assert.match(text, /Applied 3 times before: 1 onboarded, 1 passed, 1 still in progress\./);
      assert.doesNotMatch(text, /First application from this person/);
    });

    test('lists every other application newest first, with outcome badge, date, rep, last actor, note count and a link', async () => {
      const text = (await admin.get(`/app/applications/${third}`)).text;
      const panel = text.split('id="history"')[1].split('</section>')[0];
      const ids = [...panel.matchAll(/data-application-id="(\d+)"/g)].map((m) => Number(m[1]));
      assert.deepEqual(ids, [t.stillOpen, second, first]);
      assert.ok(!ids.includes(third));
      assert.match(panel, /<span class="stage-badge stage-passed">Passed<\/span> <span>Passed on Oct 26, 2026<\/span>/);
      assert.match(panel, /<span class="stage-badge stage-onboarded">Onboarded<\/span> <span>Onboarded on Oct 6, 2026<\/span>/);
      assert.match(panel, /Still in Reviewing since Nov 1, 2026/);
      assert.match(panel, /<dt>Assigned rep<\/dt><dd>Rita Rep<\/dd>/);
      assert.match(panel, /<dt>Last moved by<\/dt><dd>Rita Rep<\/dd>/);
      assert.match(panel, /<dt>Notes<\/dt><dd>2<\/dd>/);
      assert.match(panel, /<dt>Notes<\/dt><dd>1<\/dd>/);
      assert.match(panel, /<dt>Notes<\/dt><dd>0<\/dd>/);
      for (const id of ids) assert.match(panel, new RegExp(`<a class="btn btn-secondary" href="/app/applications/${id}">Open this application`));
      assert.match(panel, /Old Role <span class="history-site">Old Site<\/span>/);
    });

    test('notes of the earlier application sit in a collapsed details with their count, author and time', async () => {
      const panel = (await admin.get(`/app/applications/${third}`)).text.split('id="history"')[1].split('</section>')[0];
      assert.match(panel, /<details class="history-notes">\s*<summary>Show 2 notes from this application<\/summary>/);
      assert.match(panel, /<summary>Show 1 note from this application<\/summary>/);
      assert.doesNotMatch(panel, /<details class="history-notes" open/);
      assert.match(panel, /Rita Rep, Oct 25, 2026, \d{1,2}:\d{2} [AP]M ET/);
      // newest note first inside the list
      const d = panel.split('Show 2 notes')[1];
      assert.ok(d.indexOf('Reliable, would reconsider') < d.indexOf('Weak pitches'));
      assert.match(panel, /No notes were written on this application\./);
    });

    test('print: the notes are also rendered expanded for the print stylesheet', async () => {
      const panel = (await admin.get(`/app/applications/${third}`)).text.split('id="history"')[1].split('</section>')[0];
      assert.equal((panel.match(/class="history-notes-print"/g) || []).length, 2);
      assert.equal((panel.match(/Great first season/g) || []).length, 2);
      const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/style.css'), 'utf8');
      const printCss = css.slice(css.lastIndexOf('@media print'));
      assert.match(printCss, /\.history-notes \{ display: none; \}/);
      assert.match(printCss, /\.history-notes-print \{ display: block;/);
    });

    test('role titles and note text are escaped in the panel', async () => {
      const text = (await admin.get(`/app/applications/${third}`)).text;
      assert.doesNotMatch(text, /<img src=x/);
      assert.match(text, /Mid &lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(text, /Weak pitches &lt;img src=x onerror=alert\(1\)&gt;/);
    });

    test('a first-time applicant gets no panel, just a quiet line; other people history is not mixed in', async () => {
      const lone = await app(t.db, roleNow, await person(t.db, 'Lone Applicant'), 'New', D(41));
      const text = (await admin.get(`/app/applications/${lone}`)).text;
      assert.doesNotMatch(text, /id="history"/);
      assert.doesNotMatch(text, /Application history/);
      assert.match(text, /<p class="muted first-application" id="first-application">First application from this person\.<\/p>/);
      // the other person's application is not in repeat person's panel
      const otherApp = await t.db.get("SELECT a.id FROM applications a JOIN people p ON p.id = a.person_id WHERE p.name = 'Other Person'");
      assert.doesNotMatch((await admin.get(`/app/applications/${third}`)).text, new RegExp(`data-application-id="${otherApp.id}"`));
    });

    test('one earlier application reads "once"', async () => {
      const pid = await person(t.db, 'Twice Over');
      await app(t.db, roleOld, pid, 'Passed', D(3), D(4));
      const now = await app(t.db, roleNow, pid, 'New', D(50));
      assert.match((await admin.get(`/app/applications/${now}`)).text, /Applied once before: 1 passed\./);
    });

    test('sample data: two people have earlier applications (one passed with notes, one onboarded)', async () => {
      const { loadSample } = require('../src/lib/sample');
      const adminId = (await t.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id;
      assert.equal((await loadSample(t.db, adminId)).ok, true);
      const multi = await t.db.all("SELECT p.name, COUNT(*) AS n FROM applications a JOIN people p ON p.id = a.person_id WHERE p.is_sample = 1 GROUP BY p.id HAVING n > 1 ORDER BY p.name");
      assert.deepEqual(multi.map((m) => m.name), ['Daniel Okafor', 'Tyler Reyes']);
      const cur = await t.db.get("SELECT a.id FROM applications a JOIN people p ON p.id = a.person_id WHERE p.name = 'Tyler Reyes' AND a.stage = 'new'");
      const text = (await admin.get(`/app/applications/${cur.id}`)).text;
      assert.match(text, /Applied once before: 1 passed\./);
      assert.match(text, /Show 2 notes from this application/);
      const dan = await t.db.get("SELECT a.id FROM applications a JOIN people p ON p.id = a.person_id WHERE p.name = 'Daniel Okafor' AND a.stage = 'new'");
      assert.match((await admin.get(`/app/applications/${dan.id}`)).text, /Applied once before: 1 onboarded\./);
    });

    test('a long email wraps at the @ (a break opportunity) instead of mid-word', async () => {
      const text = (await admin.get(`/app/applications/${third}`)).text;
      assert.match(text, /class="meta-email"><a href="mailto:[^"]*">repeat\.person\.with\.a\.very\.long\.address\.that\.must\.wrap<wbr>@subdomain\.example\.com<\/a>/);
    });

    test('the users admin page is stacked cards on phones: cells carry their column label', async () => {
      const text = (await admin.get('/app/admin/users')).text;
      assert.match(text, /class="table-wrap table-stack"/);
      for (const label of ['Name', 'Email', 'Role', 'Status', 'Roles assigned', 'Actions']) assert.match(text, new RegExp(`data-label="${label}"`));
    });
  });
}
