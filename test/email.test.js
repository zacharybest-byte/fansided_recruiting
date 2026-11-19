'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeUser, makeRole, lastApplication, count } = require('./helpers');
const { createFakeGoogle, googleSignIn } = require('./fake-google');

function decodeMime(decoded) {
  const [head, ...rest] = decoded.split('\r\n\r\n');
  const headers = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

function decodeWord(v) {
  const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

describe('EMAIL_MODE=log', () => {
  let t;
  let rep;
  let role;
  before(async () => {
    t = await startApp();
    rep = makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    role = makeRole(t.db, { title: 'Bears Writer', assigned: rep });
  });
  after(() => t.close());

  test('AC-12: a new application notifies the assigned rep; a failed send still saves the application', async () => {
    t.db.exec('DELETE FROM dev_mail_log');
    const res = await t.client().apply(role, { name: 'Nina Note', email: 'nina@example.com' });
    assert.equal(res.status, 303);
    const app = lastApplication(t.db);
    const mail = t.db.prepare('SELECT * FROM dev_mail_log').all();
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to_email, 'rep@fansided.com');
    assert.equal(mail[0].from_email, 'rep@fansided.com'); // sent as the rep, to themselves
    assert.equal(mail[0].subject, 'New application: Nina Note for Bears Writer');
    assert.match(mail[0].body, new RegExp(`http://localhost/app/applications/${app.id}`));
    assert.equal(count(t.db, 'emails_sent'), 0); // notifications are not logged on the candidate

    // Rep's send fails: falls back to the first active admin's account, still to the rep.
    const deliver = t.app.mailer.deliver;
    const attempts = [];
    t.app.mailer.deliver = async (sender, msg) => {
      attempts.push(sender.email);
      if (sender.email === 'rep@fansided.com') throw new Error('no token');
      return deliver(sender, msg);
    };
    t.db.exec('DELETE FROM dev_mail_log');
    await t.client().apply(role, { email: 'fallback@example.com' });
    assert.deepEqual(attempts, ['rep@fansided.com', 'admin@fansided.com']);
    const fb = t.db.prepare('SELECT * FROM dev_mail_log').get();
    assert.equal(fb.from_email, 'admin@fansided.com');
    assert.equal(fb.to_email, 'rep@fansided.com');

    // Everything fails: application is still saved.
    t.app.mailer.deliver = async () => {
      throw new Error('Gmail is down');
    };
    const before = count(t.db, 'applications');
    const r = await t.client().apply(role, { email: 'stillsaved@example.com' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/thanks');
    assert.equal(count(t.db, 'applications'), before + 1);
    t.app.mailer.deliver = deliver;
  });

  test('AC-26: Load fills first_name, role_title and rep_name; unknown fields stay and warn', async () => {
    await t.client().apply(role, { name: 'Jamie Lynn Carter', email: 'jamie@example.com' });
    const app = lastApplication(t.db);
    const tpl = t.db
      .prepare('INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)')
      .run('Merge test', 'Hi {{first_name}} re {{role_title}}', 'Dear {{ first_name }},\n{{role_title}} / {{rep_name}} / {{favourite_team}}', new Date().toISOString()).lastInsertRowid;
    const c = t.client();
    await c.login('rep@fansided.com');
    const page = await c.get(`/app/applications/${app.id}?template=${tpl}`);
    assert.match(page.text, /name="subject" maxlength="300" value="Hi Jamie re Bears Writer"/);
    assert.match(page.text, /Dear Jamie,\nBears Writer \/ Rita Rep \/ \{\{favourite_team\}\}<\/textarea>/);
    assert.match(page.text, /id="merge-warning">Unknown merge field: \{\{favourite_team\}\}/);
    const clean = t.db.prepare("SELECT id FROM email_templates WHERE name = 'Trial invite'").get().id;
    const page2 = await c.get(`/app/applications/${app.id}?template=${clean}`);
    assert.doesNotMatch(page2.text, /merge-warning/);
    assert.match(page2.text, /Next step: a trial for Bears Writer/);
  });

  test('AC-27 (log mode): sending logs subject, body, sender and time on the candidate; failures are logged and shown', async () => {
    const app = lastApplication(t.db);
    const deliver = t.app.mailer.deliver;
    const c = t.client();
    await c.login('rep@fansided.com');
    await c.get(`/app/applications/${app.id}`);
    const res = await c.post(`/app/applications/${app.id}/email`, { subject: 'Trial details', body: 'Line one\nLine two' });
    assert.equal(res.status, 303);
    const row = t.db.prepare('SELECT * FROM emails_sent ORDER BY id DESC').get();
    assert.equal(row.status, 'sent');
    assert.equal(row.subject, 'Trial details');
    assert.equal(row.body, 'Line one\nLine two');
    assert.equal(row.sender_user_id, rep);
    assert.equal(row.to_email, 'jamie@example.com');
    assert.ok(row.sent_at);
    const page = await c.follow(res);
    assert.match(page.text, /Email sent to jamie@example.com/);
    assert.match(page.text, /<summary><strong>Trial details<\/strong> · Rita Rep · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    t.app.mailer.deliver = async () => {
      throw new Error('invalid_grant');
    };
    await c.post(`/app/applications/${app.id}/email`, { subject: 'Will fail', body: 'x' });
    const failed = t.db.prepare('SELECT * FROM emails_sent ORDER BY id DESC').get();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /invalid_grant/);
    const after = await c.get(`/app/applications/${app.id}`);
    assert.match(after.text, /Email not sent: please sign out and in again\./);
    assert.match(after.text, /Will fail<\/strong>.*failed/);
    t.app.mailer.deliver = deliver;
  });

  test('AC-28: admin creates, edits and deletes templates; edits apply on next Load', async () => {
    const app = lastApplication(t.db);
    const a = t.client();
    await a.login('admin@fansided.com');
    await a.get('/app/admin/templates/new');
    const list0 = await a.get('/app/admin/templates');
    assert.match(list0.text, /\{\{first_name\}\}/); // merge fields listed
    let res = await a.post('/app/admin/templates', { name: 'Follow-up', subject: 'Following up, {{first_name}}', body: 'Version one' });
    assert.equal(res.status, 303);
    const id = t.db.prepare("SELECT id FROM email_templates WHERE name = 'Follow-up'").get().id;
    let page = await a.get(`/app/applications/${app.id}?template=${id}`);
    assert.match(page.text, />Version one<\/textarea>/);

    await a.get(`/app/admin/templates/${id}`);
    res = await a.post(`/app/admin/templates/${id}`, { name: 'Follow-up', subject: 'Following up again, {{first_name}}', body: 'Version two' });
    assert.equal(res.status, 303);
    page = await a.get(`/app/applications/${app.id}?template=${id}`);
    assert.match(page.text, />Version two<\/textarea>/);
    assert.match(page.text, /value="Following up again, Jamie"/);

    await a.get('/app/admin/templates');
    res = await a.post(`/app/admin/templates/${id}/delete`, {});
    assert.equal(res.status, 303);
    assert.equal(count(t.db, 'email_templates', 'id = ?', id), 0);
    page = await a.get(`/app/applications/${app.id}`);
    assert.doesNotMatch(page.text, /<option value="\d+">Follow-up<\/option>/);

    // Validation
    await a.get('/app/admin/templates/new');
    res = await a.post('/app/admin/templates', { name: '', subject: '', body: '' });
    assert.equal(res.status, 400);
  });
});

describe('EMAIL_MODE=gmail against a fake Gmail API', () => {
  let t;
  let fake;
  let role;
  before(async () => {
    fake = createFakeGoogle();
    t = await startApp({
      env: { EMAIL_MODE: 'gmail', DEV_LOGIN: '0', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' },
      fetchImpl: fake.fetch,
    });
    const rep = makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    role = makeRole(t.db, { title: 'Équipe Writer', assigned: rep });
    fake.addIdentity('admin', { email: 'admin@fansided.com', email_verified: true, name: 'Ada Admin', refresh_token: 'rt-admin' });
    fake.addIdentity('rep', { email: 'rep@fansided.com', email_verified: true, name: 'Rita Rep', refresh_token: 'rt-rep' });
  });
  after(() => t.close());

  test('AC-27 + AC-12 (gmail mode): sends as the signed-in rep via refresh token; revoked token is logged as failed; notifications fall back to admin', async () => {
    const admin = t.client();
    await googleSignIn(admin, 'admin');
    const rep = t.client();
    await googleSignIn(rep, 'rep');

    // Notification: sent with the rep's own token, to the rep.
    await t.client().apply(role, { name: 'Zoë Ångström', email: 'zoe@example.com' });
    let sent = fake.sent[fake.sent.length - 1];
    assert.equal(sent.accessToken, 'at-from-rt-rep');
    let msg = decodeMime(sent.decoded);
    assert.equal(msg.headers.to, 'rep@fansided.com');
    assert.equal(decodeWord(msg.headers.subject), 'New application: Zoë Ångström for Équipe Writer');

    const app = lastApplication(t.db);
    await rep.get(`/app/applications/${app.id}`);
    const res = await rep.post(`/app/applications/${app.id}/email`, { subject: 'Café — trial', body: 'Hi Zoë,\nWelcome.' });
    assert.equal(res.status, 303);
    sent = fake.sent[fake.sent.length - 1];
    assert.equal(sent.accessToken, 'at-from-rt-rep');
    assert.ok(!/[+/=]/.test(sent.raw), 'raw must be base64url without padding');
    msg = decodeMime(sent.decoded);
    assert.equal(msg.headers.from, '"Rita Rep" <rep@fansided.com>');
    assert.equal(msg.headers.to, 'zoe@example.com');
    assert.equal(decodeWord(msg.headers.subject), 'Café — trial');
    assert.equal(msg.headers['content-type'], 'text/plain; charset="UTF-8"');
    assert.equal(msg.body, 'Hi Zoë,\r\nWelcome.');
    assert.ok(sent.decoded.includes('\r\n'));
    const row = t.db.prepare('SELECT * FROM emails_sent ORDER BY id DESC').get();
    assert.equal(row.status, 'sent');
    assert.equal(row.gmail_message_id, `gmail-${fake.sent.length}`);

    // Revoked token: logged as failed, rep is told, stored token cleared.
    fake.revoked.add('rt-rep');
    await rep.post(`/app/applications/${app.id}/email`, { subject: 'Second', body: 'x' });
    const failed = t.db.prepare('SELECT * FROM emails_sent ORDER BY id DESC').get();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /invalid_grant/);
    const page = await rep.get(`/app/applications/${app.id}`);
    assert.match(page.text, /Email not sent: please sign out and in again\./);
    assert.equal(t.db.prepare("SELECT google_refresh_token_enc FROM users WHERE email = 'rep@fansided.com'").get().google_refresh_token_enc, null);

    // Notification now goes out with the admin's token, addressed to the rep.
    const n = fake.sent.length;
    await t.client().apply(role, { email: 'second@example.com' });
    assert.equal(fake.sent.length, n + 1);
    sent = fake.sent[fake.sent.length - 1];
    assert.equal(sent.accessToken, 'at-from-rt-admin');
    msg = decodeMime(sent.decoded);
    assert.equal(msg.headers.to, 'rep@fansided.com');
    assert.match(msg.headers.from, /admin@fansided.com/);

    // Gmail API error (e.g. scope not granted) is also logged as failed.
    fake.failSendFor.add('at-from-rt-admin');
    await admin.get(`/app/applications/${app.id}`);
    await admin.post(`/app/applications/${app.id}/email`, { subject: 'Third', body: 'y' });
    const failed2 = t.db.prepare('SELECT * FROM emails_sent ORDER BY id DESC').get();
    assert.equal(failed2.status, 'failed');
    assert.match(failed2.error, /Insufficient Permission/);

    // Both tokens unusable: application still saved, nothing sent.
    fake.revoked.add('rt-admin');
    const before = count(t.db, 'applications');
    const r = await t.client().apply(role, { email: 'third@example.com' });
    assert.equal(r.status, 303);
    assert.equal(count(t.db, 'applications'), before + 1);
  });
});
