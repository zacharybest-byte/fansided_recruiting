'use strict';
// v2.4.0: linked documents on email templates. Every integration test runs on both drivers (sqlite, Turso fake).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, freshDb, makeUser, makeRole, lastApplication, count } = require('./helpers');
const { MIGRATIONS, migrate } = require('../src/lib/db');
const { currentVersion } = require('../src/lib/db/migrations');
const { parseDocuments, resolveDocuments, bodyWithDocuments, worstCaseLength, composeUrl, DOCS } = require('../src/lib/email');
const { normaliseUrl } = require('../src/lib/urls');

const T0 = '2026-10-01T12:00:00.000Z';
const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const handoffHref = (text) => unescapeHtml(/<a href="([^"]*)" data-auto-open/.exec(text)[1]);
const textareaBody = (text) => unescapeHtml(/<textarea name="body" id="f-body"[^>]*>([\s\S]*?)<\/textarea>/.exec(text)[1]);
const urlOf = (href) => new URL(href);

const DOC1 = ['Style guide', 'https://drive.google.com/file/d/abc123/view?usp=sharing&x=1#top'];
const DOC2 = ['Pay rates {{role_title}}', 'https://example.com/a/b?c=d&e=f#g'];

// Form fields for a template with the given [name, url] pairs.
function tplForm(extra = {}, docs = []) {
  const f = { name: 'With docs', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}},\n\nWelcome.\n\nBest,\n{{rep_name}}', ...extra };
  docs.forEach(([n, u], i) => {
    f[`doc_name_${i + 1}`] = n;
    f[`doc_url_${i + 1}`] = u;
  });
  return f;
}

test('normaliseUrl is the shared helper: https only, bare hosts get https://', () => {
  assert.equal(normaliseUrl('example.com/x'), 'https://example.com/x');
  assert.equal(normaliseUrl('http://example.com'), null);
  assert.equal(normaliseUrl('javascript:alert(1)'), null);
  assert.equal(normaliseUrl('data:text/html,x'), null);
  assert.equal(normaliseUrl(''), '');
});

test('parseDocuments / bodyWithDocuments are defensive and exact', () => {
  assert.deepEqual(parseDocuments('[]'), []);
  assert.deepEqual(parseDocuments('not json'), []);
  assert.deepEqual(parseDocuments('{"a":1}'), []);
  assert.deepEqual(parseDocuments(JSON.stringify([{ name: 'A', url: 'https://a.co/' }, { name: '', url: 'https://b.co/' }, 5])), [{ name: 'A', url: 'https://a.co/' }]);
  assert.equal(bodyWithDocuments('Hi', []), 'Hi');
  assert.equal(bodyWithDocuments('Hi', [{ name: 'A', url: 'https://a.co/' }, { name: 'B', url: 'https://b.co/' }]), 'Hi\n\nDocuments:\n- A: https://a.co/\n- B: https://b.co/');
  const r = resolveDocuments([{ name: 'Rates for {{role_title}} {{nope}}', url: 'https://{{first_name}}.co/' }], { first_name: 'Jo', role_title: 'Bears\nWriter' });
  assert.deepEqual(r.docs, [{ name: 'Rates for Bears Writer {{nope}}', url: 'https://{{first_name}}.co/' }]);
  assert.deepEqual(r.unknown, ['nope']);
  assert.equal(worstCaseLength('x', []), 1);
});

for (const driver of DRIVERS) {
  describe(`[${driver}] migration 5: email_templates.attachments_json`, () => {
    test('exact statement: one additive ALTER; a v2.3 database (upTo 4) keeps every template and log row, attachments empty; second start is a no-op', async () => {
      assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5]);
      const stmts = MIGRATIONS.find((m) => m.version === 5).statements();
      assert.deepEqual(stmts, ["ALTER TABLE email_templates ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'"]);

      const h = await freshDb(driver, { upTo: 4 });
      try {
        assert.equal(await currentVersion(h.db), 4);
        const cols0 = (await h.db.all("SELECT name FROM pragma_table_info('email_templates')")).map((c) => c.name);
        assert.ok(!cols0.includes('attachments_json'));
        await h.db.run("INSERT INTO email_templates (name, subject, body, updated_at) VALUES ('Custom <b>', 'Subj & more', 'Body\nline two {{first_name}} é', ?)", [T0]);
        const u = await h.db.run("INSERT INTO users (email, name, role, created_at) VALUES ('rep@fansided.com', 'Rita', 'rep', ?)", [T0]);
        const p = await h.db.run("INSERT INTO people (email, name, created_at, updated_at) VALUES ('p@example.com', 'P One', ?, ?)", [T0, T0]);
        const tpl = (await h.db.get("SELECT id FROM email_templates WHERE name = 'Welcome aboard'")).id;
        await h.db.run("INSERT INTO emails_sent (person_id, template_id, sender_user_id, to_email, subject, body, via, sent_at) VALUES (?, ?, ?, 'p@example.com', 's', 'logged body', 'gmail', ?)", [p.lastInsertRowid, tpl, u.lastInsertRowid, T0]);
        const before = await h.db.all('SELECT * FROM email_templates ORDER BY id');
        const logBefore = await h.db.all('SELECT * FROM emails_sent ORDER BY id');
        assert.equal(before.length, 5);

        assert.deepEqual(await migrate(h.db), { from: 4, to: 5 });
        const after = await h.db.all('SELECT * FROM email_templates ORDER BY id');
        assert.equal(after.length, before.length);
        after.forEach((row, i) => {
          const { attachments_json, ...rest } = row;
          assert.deepEqual(rest, before[i], 'template unchanged (updated_at too)');
          assert.equal(attachments_json, '[]');
        });
        assert.deepEqual(await h.db.all('SELECT * FROM emails_sent ORDER BY id'), logBefore);
        // an older deployment that does not know the column keeps inserting and updating templates
        await h.db.run("INSERT INTO email_templates (name, subject, body, updated_at) VALUES ('Old code', 's', 'b', ?)", [T0]);
        await h.db.run("UPDATE email_templates SET body = 'b2' WHERE name = 'Old code'");
        assert.equal((await h.db.get("SELECT attachments_json FROM email_templates WHERE name = 'Old code'")).attachments_json, '[]');
        assert.deepEqual(await migrate(h.db), { from: 5, to: 5 });
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM schema_migrations')).n, 5);
      } finally {
        await h.close();
      }
    });

    test('atomic: a failure after the ALTER in the same batch rolls back the column and the tracking row', async () => {
      const h = await freshDb(driver, { upTo: 4 });
      try {
        const before = await h.db.all('SELECT * FROM email_templates ORDER BY id');
        const good = MIGRATIONS.find((m) => m.version === 5).statements();
        await assert.rejects(h.db.batch([...good, 'INSERT INTO no_such_table VALUES (1)']));
        const cols = (await h.db.all("SELECT name FROM pragma_table_info('email_templates')")).map((c) => c.name);
        assert.ok(!cols.includes('attachments_json'));
        assert.equal(await currentVersion(h.db), 4);
        assert.deepEqual(await h.db.all('SELECT * FROM email_templates ORDER BY id'), before);
        assert.deepEqual(await migrate(h.db), { from: 4, to: 5 });
      } finally {
        await h.close();
      }
    });

    test('cold start and concurrent start: three runners end at version 5 with one tracking row', async () => {
      const h = await freshDb(driver, { upTo: 4 });
      try {
        const { openDb } = require('../src/lib/db');
        const second = driver === 'turso' ? openDb({ tursoUrl: h.fake.url, tursoToken: h.fake.token }) : openDb({ dataDir: h.dir });
        const results = await Promise.all([migrate(h.db), migrate(second), migrate(h.db)]);
        assert.ok(results.every((r) => r.to === 5));
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5')).n, 1);
        await second.close();
      } finally {
        await h.close();
      }
    });
  });

  describe(`[${driver}] linked documents`, () => {
    let t;
    let rep;
    let role;
    let app;
    let admin;
    before(async () => {
      t = await startApp({ driver });
      rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      role = await makeRole(t.db, { title: 'Bears Writer', assigned: rep });
      await t.client().apply(role, { name: 'Jamie Lynn Carter', email: 'jamie@example.com' });
      app = await lastApplication(t.db);
      admin = t.client();
      await admin.login('admin@fansided.com');
    });
    after(() => t.close());

    const create = async (fields, docs) => {
      await admin.get('/app/admin/templates/new');
      return admin.post('/app/admin/templates', tplForm(fields, docs));
    };
    const stored = async (name) => t.db.get('SELECT * FROM email_templates WHERE name = ?', [name]);

    test('create, order preserved, blank rows skipped, links normalised, list shows the count, edit round-trips', async () => {
      const res = await create({ name: 'Two docs' }, [DOC1, ['', ''], DOC2, ['  Contract  ', 'example.org/contract']]);
      assert.equal(res.status, 303);
      const row = await stored('Two docs');
      assert.deepEqual(JSON.parse(row.attachments_json), [
        { name: 'Style guide', url: 'https://drive.google.com/file/d/abc123/view?usp=sharing&x=1#top' },
        { name: 'Pay rates {{role_title}}', url: 'https://example.com/a/b?c=d&e=f#g' },
        { name: 'Contract', url: 'https://example.org/contract' },
      ]);
      const list = await admin.get('/app/admin/templates');
      assert.match(list.text, /<th>Linked documents<\/th>/);
      assert.match(list.text, /<strong>Two docs<\/strong><\/a><\/td><td>Hi \{\{first_name\}\}<\/td><td>3<\/td>/);
      assert.match(list.text, /<strong>Welcome aboard<\/strong><\/a><\/td><td>[^<]*<\/td><td>0<\/td>/);
      const form = await admin.get(`/app/admin/templates/${row.id}`);
      assert.match(form.text, /<legend>Linked documents<\/legend>/);
      assert.match(form.text, /Files cannot be attached to a draft, so add links to documents instead \(for example a Google Drive link that anyone with the link can view\)\. They are added to the end of the email\./);
      for (let i = 1; i <= 5; i++) {
        assert.match(form.text, new RegExp(`<label for="f-doc_name_${i}">Document ${i} name</label>`));
        assert.match(form.text, new RegExp(`<label for="f-doc_url_${i}">Document ${i} link</label>`));
      }
      assert.doesNotMatch(form.text, /doc_name_6/);
      assert.match(form.text, /name="doc_name_1" maxlength="160" value="Style guide"/);
      assert.match(form.text, /name="doc_url_3" maxlength="1000" value="https:\/\/example.org\/contract"/);
      // editing: remove one, add a new one, keep order
      const edit = await admin.post(`/app/admin/templates/${row.id}`, tplForm({ name: 'Two docs' }, [DOC2, ['Extra', 'https://example.net/x']]));
      assert.equal(edit.status, 303);
      assert.deepEqual(JSON.parse((await stored('Two docs')).attachments_json).map((d) => d.name), ['Pay rates {{role_title}}', 'Extra']);
      // clearing all rows empties the list
      await admin.get(`/app/admin/templates/${row.id}`);
      await admin.post(`/app/admin/templates/${row.id}`, tplForm({ name: 'Two docs' }, []));
      assert.equal((await stored('Two docs')).attachments_json, '[]');
    });

    test('validation: http://, javascript:, data:, missing name, missing link, over-long, duplicates; nothing is saved; error summary; typed values kept', async () => {
      const cases = [
        [[['Doc', 'http://example.com/a']], /Document 1: the link must be a valid link starting with https:\/\//, 'f-doc_url_1'],
        [[['Doc', 'javascript:alert(1)']], /Document 1: the link must be a valid link/, 'f-doc_url_1'],
        [[['Doc', 'data:text/html,<script>alert(1)</script>']], /Document 1: the link must be a valid link/, 'f-doc_url_1'],
        [[DOC1, ['', 'https://example.com/only-link']], /Document 2: add a name, or clear the link\./, 'f-doc_name_2'],
        [[['Name only', '']], /Document 1: add a link, or clear the name\./, 'f-doc_url_1'],
        [[['n'.repeat(81), 'https://example.com/a']], /Document 1: the name must be at most 80 characters\./, 'f-doc_name_1'],
        [[['Doc', `https://example.com/${'a'.repeat(500)}`]], /Document 1: the link must be at most 500 characters\./, 'f-doc_url_1'],
        [[['One', 'https://example.com/same'], ['Two', 'https://example.com/same']], /Document 2: this link is already used for &quot;One&quot;/, 'f-doc_url_2'],
        [[['One', 'https://example.com/same'], ['Two', 'example.com/same']], /Document 2: this link is already used/, 'f-doc_url_2'],
      ];
      for (const [docs, re, anchor] of cases) {
        const before = await count(t.db, 'email_templates');
        const res = await create({ name: 'Bad docs' }, docs);
        assert.equal(res.status, 400, JSON.stringify(docs).slice(0, 60));
        assert.match(res.text, re);
        assert.match(res.text, new RegExp(`<a href="#${anchor}">`), 'error summary links to the field');
        assert.match(res.text, /id="err-doc_/);
        assert.match(res.text, /aria-invalid="true"/);
        assert.match(res.text, /name="name"[^>]*value="Bad docs"/, 'typed values are kept');
        assert.equal(await count(t.db, 'email_templates'), before);
      }
      // exactly 80 / 500 are fine
      const ok = await create({ name: 'Edge limits' }, [['n'.repeat(80), `https://example.com/${'a'.repeat(500 - 'https://example.com/'.length)}`]]);
      assert.equal(ok.status, 303);
    });

    test('a sixth row is ignored; five are stored', async () => {
      await admin.get('/app/admin/templates/new');
      const f = tplForm({ name: 'Six rows' }, [1, 2, 3, 4, 5].map((n) => [`Doc ${n}`, `https://example.com/${n}`]));
      f.doc_name_6 = 'Doc 6';
      f.doc_url_6 = 'https://example.com/6';
      assert.equal((await admin.post('/app/admin/templates', f)).status, 303);
      assert.equal(JSON.parse((await stored('Six rows')).attachments_json).length, 5);
      // even an invalid sixth row is not read
      await admin.get('/app/admin/templates/new');
      f.name = 'Six rows bad';
      f.doc_url_6 = 'javascript:alert(1)';
      assert.equal((await admin.post('/app/admin/templates', f)).status, 303);
    });

    test('body limit: body plus documents block must fit 4,000 characters; exact boundary; clear error; merge fields counted generously', async () => {
      const docs = [['A', 'https://example.com/a'], ['B', 'https://example.com/b']];
      const block = bodyWithDocuments('', docs.map(([name, url]) => ({ name, url }))).length; // "\n\n" + block
      const fits = 'x'.repeat(DOCS.body - block);
      assert.equal((await create({ name: 'Fits exactly', body: fits }, docs)).status, 303);
      assert.equal(bodyWithDocuments(fits, docs.map(([name, url]) => ({ name, url }))).length, 4000);
      const over = await create({ name: 'One too long', body: `${fits}x` }, docs);
      assert.equal(over.status, 400);
      assert.match(over.text, /The body and the linked documents together can reach 4,001 characters\. A draft can hold 4,000\. Shorten the body or remove a document\./);
      assert.match(over.text, /<a href="#f-body">/);
      assert.equal(await count(t.db, 'email_templates', "name = 'One too long'"), 0);
      // without documents the same limit applies to the body alone
      const plain = await create({ name: 'Plain long', body: 'y'.repeat(4001) }, []);
      assert.equal(plain.status, 400);
      assert.match(plain.text, /The body can reach 4,001 characters/);
      assert.equal((await create({ name: 'Plain 4000', body: 'y'.repeat(4000) }, [])).status, 303);
      // merge fields are counted at 40 / 100 / 60 characters, so a template cannot overflow once they are filled in
      const merged = await create({ name: 'Merge heavy', body: `${'{{role_title}}'.repeat(41)}` }, []);
      assert.equal(merged.status, 400);
      assert.equal(worstCaseLength('{{first_name}}{{role_title}}{{rep_name}}', []), 200);
      // the textarea carries the limit
      assert.match((await admin.get('/app/admin/templates/new')).text, /<textarea [^>]*name="body" rows="12" maxlength="4000" required>/);
    });

    test('composer output: exact text, note under the picker, merge fields in names only', async () => {
      await create({ name: 'Composer docs', subject: 'Welcome {{first_name}}', body: 'Hi {{first_name}},\n\nWelcome to the {{role_title}} team.\n\nBest,\n{{rep_name}}' }, [DOC1, DOC2]);
      const id = (await stored('Composer docs')).id;
      const c = t.client();
      await c.login('rep@fansided.com');
      const page = await c.get(`/app/applications/${app.id}?template=${id}`);
      assert.equal(
        textareaBody(page.text),
        'Hi Jamie,\n\nWelcome to the Bears Writer team.\n\nBest,\nRita Rep\n\nDocuments:\n- Style guide: https://drive.google.com/file/d/abc123/view?usp=sharing&x=1#top\n- Pay rates Bears Writer: https://example.com/a/b?c=d&e=f#g'
      );
      assert.match(page.text, /<div class="doc-note" id="doc-note"><p>This template added 2 linked documents to the end of the message\. Delete a line from the message if you do not want to send it\.<\/p>\s*<ul><li>Style guide<\/li><li>Pay rates Bears Writer<\/li><\/ul><\/div>/);
      // the note sits between the template picker and the message box; it is plain text, not links
      const noteAt = page.text.indexOf('id="doc-note"');
      assert.ok(page.text.indexOf('Load template') < noteAt && noteAt < page.text.indexOf('id="f-body"'));
      assert.doesNotMatch(/<div class="doc-note"[\s\S]*?<\/div>/.exec(page.text)[0], /<a /);
      assert.doesNotMatch(page.text, /merge-warning/);
      // a template without documents: no note, no block
      const plainId = (await t.db.get("SELECT id FROM email_templates WHERE name = 'Trial invite'")).id;
      const plain = await c.get(`/app/applications/${app.id}?template=${plainId}`);
      assert.doesNotMatch(plain.text, /doc-note/);
      assert.doesNotMatch(textareaBody(plain.text), /Documents:/);
      // a single document reads in the singular; unknown merge fields in a name warn
      await create({ name: 'One doc', body: 'Body' }, [['Guide {{nope}}', 'https://example.com/g']]);
      const one = await c.get(`/app/applications/${app.id}?template=${(await stored('One doc')).id}`);
      assert.match(one.text, /added a linked document to the end/);
      assert.match(one.text, /id="merge-warning" role="alert">Unknown merge field: \{\{nope\}\}/);
      assert.equal(textareaBody(one.text), 'Body\n\nDocuments:\n- Guide {{nope}}: https://example.com/g');
      // URLs get no merge: a placeholder in a URL stays as typed (and is refused as an address anyway)
      const bad = await create({ name: 'Merge url' }, [['X', 'https://example.com/{{first_name}}']]);
      assert.equal(bad.status, 303);
      const m = await c.get(`/app/applications/${app.id}?template=${(await stored('Merge url')).id}`);
      assert.match(textareaBody(m.text), /- X: https:\/\/example\.com\/%7B%7Bfirst_name%7D%7D$/);
    });

    test('the exact Gmail and mailto hand-off URLs for a template with two documents (: / ? & # encoded); the logged body is the final text', async () => {
      const id = (await stored('Composer docs')).id;
      const c = t.client();
      await c.login('rep@fansided.com');
      const page = await c.get(`/app/applications/${app.id}?template=${id}`);
      const body = textareaBody(page.text);
      const subject = unescapeHtml(/name="subject"[^>]*value="([^"]*)"/.exec(page.text)[1]);
      assert.equal(subject, 'Welcome Jamie');
      const before = await count(t.db, 'emails_sent');
      const g = await c.post(`/app/applications/${app.id}/email`, { via: 'gmail', template_id: id, subject, body });
      const gmail =
        'https://mail.google.com/mail/?view=cm&fs=1&to=jamie%40example.com&su=Welcome%20Jamie&body=' +
        'Hi%20Jamie%2C%0A%0AWelcome%20to%20the%20Bears%20Writer%20team.%0A%0ABest%2C%0ARita%20Rep%0A%0ADocuments%3A%0A' +
        '-%20Style%20guide%3A%20https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Fabc123%2Fview%3Fusp%3Dsharing%26x%3D1%23top%0A' +
        '-%20Pay%20rates%20Bears%20Writer%3A%20https%3A%2F%2Fexample.com%2Fa%2Fb%3Fc%3Dd%26e%3Df%23g';
      assert.equal(handoffHref(g.text), gmail);
      const mt = await c.post(`/app/applications/${app.id}/email`, { via: 'mailto', template_id: id, subject, body });
      assert.equal(handoffHref(mt.text), gmail.replace('https://mail.google.com/mail/?view=cm&fs=1&to=jamie%40example.com&su=Welcome%20Jamie&body=', 'mailto:jamie%40example.com?subject=Welcome%20Jamie&body=').replace(/%0A/g, '%0D%0A'));
      assert.equal(await count(t.db, 'emails_sent'), before + 2);
      const row = await t.db.get('SELECT * FROM emails_sent ORDER BY id DESC LIMIT 1');
      assert.equal(row.body, body, 'the logged email stores the final body, links included');
      assert.equal(composeUrl('gmail', { to: 'jamie@example.com', subject, body }), gmail);
      // the rep removed a line before opening: only the remaining link is logged and sent
      const trimmed = body.split('\n').filter((l) => !l.startsWith('- Pay rates')).join('\n');
      const r = await c.post(`/app/applications/${app.id}/email`, { via: 'gmail', template_id: id, subject, body: trimmed });
      assert.doesNotMatch(handoffHref(r.text), /example\.com%2Fa/);
      assert.equal((await t.db.get('SELECT body FROM emails_sent ORDER BY id DESC LIMIT 1')).body, trimmed);
      // Activity shows the logged text as plain text: the links are not auto-linked
      const act = await c.get(`/app/applications/${app.id}`);
      const log = /<ul class="emails email-log">[\s\S]*?<\/ul>/.exec(act.text)[0];
      assert.match(log, /Documents:\n- Style guide: https:\/\/drive\.google\.com\/file\/d\/abc123\/view\?usp=sharing&amp;x=1#top/);
      assert.doesNotMatch(log, /<a /);
    });

    test('XSS: names and URLs are escaped on the form, list, composer note, composed text, hand-off page and Activity', async () => {
      const evilName = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
      const evilUrl = 'https://example.com/"><script>alert(3)</script>?q=<b>&r=\'x\'';
      const res = await create({ name: 'Evil docs <i>' }, [[evilName, evilUrl]]);
      assert.equal(res.status, 303);
      const id = (await stored('Evil docs <i>')).id;
      const saved = JSON.parse((await stored('Evil docs <i>')).attachments_json)[0];
      assert.doesNotMatch(saved.url, /[<>"]/, 'URL is percent-encoded by the shared helper');
      // a javascript: link written straight to the database (never through the form) is still only ever text
      await t.db.run('UPDATE email_templates SET attachments_json = ? WHERE id = ?', [JSON.stringify([{ name: evilName, url: 'javascript:alert(4)' }, { name: evilName, url: saved.url }]), id]);
      const c = t.client();
      await c.login('rep@fansided.com');
      const pages = [];
      pages.push((await admin.get('/app/admin/templates')).text);
      pages.push((await admin.get(`/app/admin/templates/${id}`)).text);
      const composer = await c.get(`/app/applications/${app.id}?template=${id}`);
      pages.push(composer.text);
      const body = textareaBody(composer.text);
      assert.match(body, /- "><script>alert\(1\)<\/script><img src=x onerror=alert\(2\)>: javascript:alert\(4\)/, 'plain text in the message box');
      const handoff = await c.post(`/app/applications/${app.id}/email`, { via: 'gmail', template_id: id, subject: 's', body });
      pages.push(handoff.text);
      assert.doesNotMatch(handoffHref(handoff.text), /[<>" ]/);
      pages.push((await c.get(`/app/applications/${app.id}`)).text);
      for (const p of pages) {
        assert.doesNotMatch(p, /<script>alert/);
        assert.doesNotMatch(p, /<img src=x/);
        assert.doesNotMatch(p, /onerror=alert\(2\)>/);
        assert.doesNotMatch(p, /<a [^>]*href="javascript:/i);
      }
      // the template form echoes typed values escaped, also after a validation error
      const bad = await create({ name: 'Evil again' }, [[evilName, 'javascript:alert(1)']]);
      assert.equal(bad.status, 400);
      assert.doesNotMatch(bad.text, /<script>alert/);
      assert.match(bad.text, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });

    test('CSRF: a template with documents is not saved without a valid token; rep gets 403 on template admin', async () => {
      const c = t.client();
      await c.login('admin@fansided.com');
      await c.get('/app/admin/templates/new');
      const before = await count(t.db, 'email_templates');
      assert.equal((await c.post('/app/admin/templates', tplForm({ name: 'No csrf' }, [DOC1]), { csrf: 'nope' })).status, 403);
      assert.equal((await c.post('/app/admin/templates', tplForm({ name: 'No csrf' }, [DOC1]), { csrf: null })).status, 403);
      assert.equal(await count(t.db, 'email_templates'), before);
      const id = (await stored('Two docs')).id;
      const docsBefore = (await stored('Two docs')).attachments_json;
      assert.equal((await c.post(`/app/admin/templates/${id}`, tplForm({ name: 'Two docs' }, [DOC1]), { csrf: 'nope' })).status, 403);
      assert.equal((await stored('Two docs')).attachments_json, docsBefore);

      const r = t.client();
      await r.login('rep@fansided.com');
      assert.equal((await r.get('/app/admin/templates')).status, 403);
      assert.equal((await r.get('/app/admin/templates/new')).status, 403);
      assert.equal((await r.get(`/app/admin/templates/${id}`)).status, 403);
      await r.get(`/app/applications/${app.id}`);
      assert.equal((await r.post('/app/admin/templates', tplForm({ name: 'Rep made' }, [DOC1]))).status, 403);
      assert.equal((await r.post(`/app/admin/templates/${id}`, tplForm({ name: 'Two docs' }, [DOC1]))).status, 403);
      assert.equal(await count(t.db, 'email_templates', "name = 'Rep made'"), 0);
      assert.equal((await stored('Two docs')).attachments_json, docsBefore);
    });

    test('seeded templates are untouched: four, no documents', async () => {
      const seeded = await t.db.all("SELECT attachments_json FROM email_templates WHERE name IN ('Thanks for applying', 'Trial invite', 'Welcome aboard', 'Not a fit this time')");
      assert.equal(seeded.length, 4);
      assert.ok(seeded.every((s) => s.attachments_json === '[]'));
    });
  });
}
