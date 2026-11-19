'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole, lastApplication, count } = require('./helpers');
const { composeUrl, applyMergeFields } = require('../src/lib/email');

const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const handoffHref = (text) => unescapeHtml(/<a href="([^"]*)" data-auto-open/.exec(text)[1]);

test('composeUrl percent-encodes every value; Gmail uses %0A, mailto uses %0D%0A', () => {
  const v = { to: 'a+b@example.com', subject: 'Re: A & B #1 é', body: 'Line one\nLine & two #3\r\né' };
  assert.equal(
    composeUrl('gmail', v),
    'https://mail.google.com/mail/?view=cm&fs=1&to=a%2Bb%40example.com&su=Re%3A%20A%20%26%20B%20%231%20%C3%A9&body=Line%20one%0ALine%20%26%20two%20%233%0A%C3%A9'
  );
  assert.equal(
    composeUrl('mailto', v),
    'mailto:a%2Bb%40example.com?subject=Re%3A%20A%20%26%20B%20%231%20%C3%A9&body=Line%20one%0D%0ALine%20%26%20two%20%233%0D%0A%C3%A9'
  );
});

for (const driver of DRIVERS) {

describe(`[${driver}] email composer`, () => {
  let t;
  let rep;
  let role;
  let app;
  before(async () => {
    t = await startApp({ driver });
    rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    role = await makeRole(t.db, { title: 'Bears Writer', assigned: rep });
    await t.client().apply(role, { name: 'Jamie Lynn Carter', email: 'jamie@example.com' });
    app = await lastApplication(t.db);
  });
  after(() => t.close());

  test('AC-26: Load fills first_name, role_title and rep_name; unknown fields stay and warn', async () => {
    const tpl = (
      await t.db.run('INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)', [
        'Merge test', 'Hi {{first_name}} re {{role_title}}', 'Dear {{ first_name }},\n{{role_title}} / {{rep_name}} / {{favourite_team}}', new Date().toISOString(),
      ])
    ).lastInsertRowid;
    const c = t.client();
    await c.login('rep@fansided.com');
    const page = await c.get(`/app/applications/${app.id}?template=${tpl}`);
    assert.match(page.text, /name="subject" maxlength="200" value="Hi Jamie re Bears Writer"/);
    assert.match(page.text, /Dear Jamie,\nBears Writer \/ Rita Rep \/ \{\{favourite_team\}\}<\/textarea>/);
    assert.match(page.text, /id="merge-warning" role="alert">Unknown merge field: \{\{favourite_team\}\}/);
    const clean = (await t.db.get("SELECT id FROM email_templates WHERE name = 'Trial invite'")).id;
    const page2 = await c.get(`/app/applications/${app.id}?template=${clean}`);
    assert.doesNotMatch(page2.text, /merge-warning/);
    assert.match(page2.text, /Next step: a trial for Bears Writer/);
    assert.deepEqual(applyMergeFields('{{first_name}} {{nope}}', { first_name: 'A' }), { text: 'A {{nope}}', unknown: ['nope'] });
  });

  test('the compose form opens in a new tab and has the two submit buttons; there is no send button and no recipient field', async () => {
    const c = t.client();
    await c.login('rep@fansided.com');
    const page = await c.get(`/app/applications/${app.id}`);
    const form = /<form method="post" action="\/app\/applications\/\d+\/email"[^>]*>[\s\S]*?<\/form>/.exec(page.text)[0];
    assert.match(form, /target="_blank"/);
    assert.match(form, /<button type="submit" name="via" value="gmail"[^>]*>Open in Gmail<\/button>/);
    assert.match(form, /<button type="submit" name="via" value="mailto"[^>]*>Open in mail app<\/button>/);
    assert.doesNotMatch(form, /name="(to|recipient|email)"/);
    assert.doesNotMatch(page.text, />Send</);
  });

  test('AC-52: Open in Gmail logs one row and returns a hand-off page with the exactly encoded link; the recipient cannot be overridden', async () => {
    const c = t.client();
    await c.login('rep@fansided.com');
    await c.get(`/app/applications/${app.id}`);
    const tplId = (await t.db.get("SELECT id FROM email_templates WHERE name = 'Trial invite'")).id;
    const before = await count(t.db, 'emails_sent');
    const res = await c.post(`/app/applications/${app.id}/email`, {
      via: 'gmail',
      template_id: tplId,
      subject: 'Hello & welcome #1 é',
      body: 'Line one\r\nTom & Jerry #2 100% é\nLast line',
      to: 'evil@attacker.example', recipient: 'evil@attacker.example', to_email: 'evil@attacker.example',
    });
    assert.equal(res.status, 200, 'no redirect (form-action would block a cross-origin redirect)');
    assert.equal(res.headers.get('location'), null);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.text, /Email logged\. Opening Gmail…/);
    assert.match(res.text, /data-auto-open/);
    assert.equal(
      handoffHref(res.text),
      'https://mail.google.com/mail/?view=cm&fs=1&to=jamie%40example.com&su=Hello%20%26%20welcome%20%231%20%C3%A9&body=Line%20one%0ATom%20%26%20Jerry%20%232%20100%25%20%C3%A9%0ALast%20line'
    );
    assert.doesNotMatch(res.text, /attacker/);
    assert.equal(await count(t.db, 'emails_sent'), before + 1);
    const row = await t.db.get('SELECT * FROM emails_sent ORDER BY id DESC LIMIT 1');
    assert.equal(row.person_id, app.person_id);
    assert.equal(row.application_id, app.id);
    assert.equal(row.role_id, role);
    assert.equal(row.template_id, tplId);
    assert.equal(row.sender_user_id, rep);
    assert.equal(row.to_email, 'jamie@example.com');
    assert.equal(row.subject, 'Hello & welcome #1 é');
    assert.equal(row.body, 'Line one\nTom & Jerry #2 100% é\nLast line');
    assert.equal(row.via, 'gmail');
    assert.ok(row.sent_at);
    // Activity shows it with subject, rep, time, role tag and expandable body.
    const act = await c.get(`/app/applications/${app.id}`);
    const li = /<li class="email-gmail">[\s\S]*?<\/li>/.exec(act.text)[0];
    assert.match(li, /<details>/);
    assert.match(li, /Hello &amp; welcome #1 é/);
    assert.match(li, /opened in Gmail/);
    assert.match(li, /Rita Rep/);
    assert.match(li, /<span class="tag">Bears Writer<\/span>/);
    assert.match(li, /Tom &amp; Jerry #2 100% é/);
  });

  test('AC-52: Open in mail app does the same with a mailto: link (CRLF newlines) and via=mailto', async () => {
    const c = t.client();
    await c.login('rep@fansided.com');
    await c.get(`/app/applications/${app.id}`);
    const res = await c.post(`/app/applications/${app.id}/email`, { via: 'mailto', template_id: '', subject: 'Re: a&b', body: 'one\ntwo & #three é' });
    assert.equal(res.status, 200);
    assert.match(res.text, /Email logged\. Opening your mail app…/);
    assert.equal(handoffHref(res.text), 'mailto:jamie%40example.com?subject=Re%3A%20a%26b&body=one%0D%0Atwo%20%26%20%23three%20%C3%A9');
    const row = await t.db.get('SELECT * FROM emails_sent ORDER BY id DESC LIMIT 1');
    assert.equal(row.via, 'mailto');
    assert.equal(row.template_id, null);
    assert.equal(row.to_email, 'jamie@example.com');
    assert.match((await c.get(`/app/applications/${app.id}`)).text, /opened in mail app/);
  });

  test('invalid requests log nothing: no CSRF, unknown via, empty or over-long subject/body', async () => {
    const c = t.client();
    await c.login('rep@fansided.com');
    await c.get(`/app/applications/${app.id}`);
    const before = await count(t.db, 'emails_sent');
    const url = `/app/applications/${app.id}/email`;
    assert.equal((await c.post(url, { via: 'gmail', subject: 's', body: 'b' }, { csrf: null })).status, 403);
    assert.equal((await c.post(url, { via: 'gmail', subject: 's', body: 'b' }, { csrf: 'f'.repeat(64) })).status, 403);
    assert.equal((await c.post(url, { via: 'smtp', subject: 's', body: 'b' })).status, 400);
    assert.equal((await c.post(url, { subject: 's', body: 'b' })).status, 400);
    assert.equal((await c.post(url, { via: 'gmail', subject: '', body: 'b' })).status, 400);
    assert.equal((await c.post(url, { via: 'gmail', subject: 's', body: '  ' })).status, 400);
    assert.equal((await c.post(url, { via: 'gmail', subject: 's'.repeat(201), body: 'b' })).status, 400);
    assert.equal((await c.post(url, { via: 'gmail', subject: 's', body: 'b'.repeat(4001) })).status, 400);
    assert.equal((await c.post('/app/applications/abc/email', { via: 'gmail', subject: 's', body: 'b' })).status, 404);
    assert.equal(await count(t.db, 'emails_sent'), before);
    // The limits themselves are accepted.
    assert.equal((await c.post(url, { via: 'gmail', subject: 's'.repeat(200), body: 'b'.repeat(4000) })).status, 200);
    // Signed-out visitors are sent to login.
    assert.equal((await t.client().post(url, { via: 'gmail', subject: 's', body: 'b' }, { csrf: null })).status, 302);
  });

  test('the external script follows the hand-off link only for Gmail compose or mailto URLs', async () => {
    const js = await t.client().get('/public/app.js');
    assert.match(js.text, /a\[data-auto-open\]/);
    assert.match(js.text, /https:\/\/mail\.google\.com\/mail\/\?/);
    assert.match(js.text, /window\.location\.replace\(target\)/);
  });

  test('AC-28: admin creates, edits and deletes templates; edits apply on next Load', async () => {
    const a = t.client();
    await a.login('admin@fansided.com');
    await a.get('/app/admin/templates/new');
    const list0 = await a.get('/app/admin/templates');
    assert.match(list0.text, /\{\{first_name\}\}/); // merge fields listed
    let res = await a.post('/app/admin/templates', { name: 'Follow-up', subject: 'Following up, {{first_name}}', body: 'Version one' });
    assert.equal(res.status, 303);
    const id = (await t.db.get("SELECT id FROM email_templates WHERE name = 'Follow-up'")).id;
    let page = await a.get(`/app/applications/${app.id}?template=${id}`);
    assert.match(page.text, />Version one<\/textarea>/);

    await a.get(`/app/admin/templates/${id}`);
    res = await a.post(`/app/admin/templates/${id}`, { name: 'Follow-up', subject: 'Following up again, {{first_name}}', body: 'Version two' });
    assert.equal(res.status, 303);
    page = await a.get(`/app/applications/${app.id}?template=${id}`);
    assert.match(page.text, />Version two<\/textarea>/);
    assert.match(page.text, /value="Following up again, Jamie"/);

    // a logged email keeps its text and loses only the template link when the template is deleted
    await a.get(`/app/applications/${app.id}`);
    await a.post(`/app/applications/${app.id}/email`, { via: 'gmail', template_id: id, subject: 'from follow-up', body: 'x' });
    await a.get('/app/admin/templates');
    res = await a.post(`/app/admin/templates/${id}/delete`, {});
    assert.equal(res.status, 303);
    assert.equal(await count(t.db, 'email_templates', 'id = ?', id), 0);
    assert.equal(await count(t.db, 'emails_sent', "subject = 'from follow-up' AND template_id IS NULL"), 1);
    page = await a.get(`/app/applications/${app.id}`);
    assert.doesNotMatch(page.text, /<option value="\d+">Follow-up<\/option>/);

    // Validation, including the 10,000 character template body limit
    await a.get('/app/admin/templates/new');
    res = await a.post('/app/admin/templates', { name: '', subject: '', body: '' });
    assert.equal(res.status, 400);
    assert.equal((await a.post('/app/admin/templates', { name: 'Big', subject: 's', body: 'x'.repeat(10001) })).status, 400);
    assert.equal((await a.post('/app/admin/templates', { name: 'Big', subject: 's'.repeat(201), body: 'x' })).status, 400);
    assert.equal(await count(t.db, 'email_templates', "name = 'Big'"), 0);
  });
});

}
