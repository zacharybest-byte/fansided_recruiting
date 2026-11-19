'use strict';
// Public pages: openings list, role page + apply form, thanks.
const crypto = require('node:crypto');
const { html, raw } = require('../lib/render');
const { page, HEARD_FROM } = require('../lib/layout');
const { readForm } = require('../lib/http');
const { publicField, verifyPublic } = require('../lib/csrf');
const { nowIso } = require('../lib/db');
const { rateKey, reserve, reserveStatements, reservedGuard, pruneStatement } = require('../lib/ratelimit');
const { SAMPLE_DOMAIN } = require('../lib/sample');
const { normaliseEmail } = require('../lib/auth');
const { notifyNewApplication } = require('../lib/notify');

const LIMITS = { name: 200, email: 254, linkedin: 2000, resume: 2000, links: 2000, answer: 5000, source: 100 };
const RATE_LIMIT = 10; // stored applications / honeypot hits per IP
const RATE_WINDOW_MS = 60 * 60 * 1000;

function excerpt(text, max = 160) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).trimEnd()}…`;
}

function sourceSuffix(source) {
  return source ? `?source=${encodeURIComponent(source)}` : '';
}

function cleanSource(value) {
  return String(value || '').trim().slice(0, LIMITS.source);
}

// Short fingerprint of a role's questionnaire. The form carries it so answers are never
// matched to questions that changed while the applicant was typing.
function questionsVersion(role) {
  return crypto.createHash('sha256').update(role.questions_json || '[]').digest('hex').slice(0, 16);
}

async function getRole(db, id) {
  if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) return null;
  const role = await db.get('SELECT * FROM job_roles WHERE id = ?', [Number(id)]);
  if (role) role.questions = JSON.parse(role.questions_json || '[]');
  return role;
}

async function openingsPage(ctx) {
  const source = cleanSource(ctx.query.get('source'));
  const roles = await ctx.app.db.all("SELECT * FROM job_roles WHERE status = 'open' ORDER BY vertical COLLATE NOCASE, title COLLATE NOCASE");
  const groups = new Map();
  for (const r of roles) {
    const key = r.vertical || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const wanted = String(ctx.query.get('vertical') || '').trim();
  const verticals = [...groups.keys()];
  const filter = verticals.find((v) => v.toLowerCase() === wanted.toLowerCase()) || '';
  const shown = filter ? groups.get(filter) : roles;
  const link = (vertical) => {
    const params = new URLSearchParams();
    if (vertical) params.set('vertical', vertical);
    if (source) params.set('source', source);
    const qs = params.toString();
    return qs ? `/?${qs}` : '/';
  };
  const chip = (vertical, label) => html`<li><a class="chip" href="${link(vertical)}"${filter === vertical ? html` aria-current="true"` : ''}>${label}</a></li>`;

  page(ctx, {
    title: 'Open roles',
    body: html`<div class="hero">
        <h1 class="display">Write for FanSided</h1>
        <p class="lede">Cover the teams and shows you know best for one of our fan sites. Pick a role, tell us about your writing and we will be in touch.</p>
        <ul class="facts">
          <li><strong>Remote and flexible</strong><span>Write from wherever you are, around your own schedule.</span></li>
          <li><strong>Cover the team you follow</strong><span>Bring your knowledge of the teams and shows you already watch.</span></li>
          <li><strong>Edited and published</strong><span>Your work is edited and published on a FanSided site.</span></li>
        </ul>
      </div>
      ${roles.length === 0
        ? html`<div class="empty">
            <h2>No roles are open right now</h2>
            <p>We open new roles throughout the year. Check back soon and your next application could be the one.</p>
          </div>`
        : html`${verticals.length > 1
            ? html`<nav aria-label="Filter by vertical"><ul class="filter">${chip('', 'All roles')}${verticals.map((v) => chip(v, v))}</ul></nav>`
            : ''}
          ${filter ? html`<h2 class="grid-heading" id="roles-heading">${filter}<span class="count">${shown.length} ${shown.length === 1 ? 'role' : 'roles'}</span></h2>` : html`<h2 class="visually-hidden" id="roles-heading">Open roles</h2>`}
          <ul class="tile-grid" aria-labelledby="roles-heading">
            ${shown.map(
              (r) => html`<li class="tile-item">
                <article class="tile">
                  <div class="tile-band"><span class="tile-vertical">${r.vertical || 'Other'}</span></div>
                  <div class="tile-body">
                    <h3 class="tile-title"><a href="/roles/${r.id}${sourceSuffix(source)}">${r.title}</a></h3>
                    ${r.site_name ? html`<p class="tile-site">${r.site_name}</p>` : ''}
                    <p class="tile-desc">${excerpt(r.description, 220)}</p>
                  </div>
                  <div class="tile-action"><a class="btn btn-primary btn-block" href="/roles/${r.id}${sourceSuffix(source)}#apply" aria-label="Apply for ${r.title}">Apply</a></div>
                </article>
              </li>`
            )}
          </ul>`}`,
  });
}

function closedPage(ctx) {
  page(ctx, {
    title: 'Role closed',
    status: 404,
    body: html`<div class="wrap-read">
      <h1 class="display">This role is no longer open</h1>
      <p class="lede">It may have been filled or taken down. Other roles are still open.</p>
      <p><a class="btn btn-primary" href="/">See all open roles</a></p>
    </div>`,
  });
}

function fieldError(errors, name) {
  return errors[name] ? html`<p class="error" id="err-${name}">${errors[name]}</p>` : '';
}

// One labelled field. `control(attrs)` renders the input with the id, error and help wiring.
function field(errors, name, label, { help = '', required = false } = {}, control) {
  const id = `f-${name}`;
  const describedBy = [help ? `help-${name}` : '', errors[name] ? `err-${name}` : ''].filter(Boolean).join(' ');
  const attrs = raw(`id="${id}"${describedBy ? ` aria-describedby="${describedBy}"` : ''}${errors[name] ? ' aria-invalid="true"' : ''}`);
  return html`<div class="field${errors[name] ? ' has-error' : ''}">
    <label for="${id}">${label}${required ? html` <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span>` : ''}</label>
    ${help ? html`<p class="help" id="help-${name}">${help}</p>` : ''}
    ${control(attrs)}
    ${fieldError(errors, name)}
  </div>`;
}

function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => html`<p>${p}</p>`);
}

function applyFormPage(ctx, role, { values = {}, errors = {}, status = 200 } = {}) {
  const source = values.source !== undefined ? values.source : cleanSource(ctx.query.get('source'));
  const fieldKeys = Object.keys(errors).filter((k) => k !== '_questions');
  const hasErrors = Object.keys(errors).length > 0;
  page(ctx, {
    title: role.title,
    status,
    body: html`<a class="back" href="/${sourceSuffix(source)}">All open roles</a>
      <div class="page-header">
        <div>
          <h1>${role.title}</h1>
          <dl class="meta-list">
            ${role.site_name ? html`<div><dt>Site</dt><dd>${role.site_name}</dd></div>` : ''}
            <div><dt>Vertical</dt><dd>${role.vertical}</dd></div>
          </dl>
        </div>
        <div class="page-actions"><a class="btn btn-primary" href="#apply">Apply for this role</a></div>
      </div>
      <div class="prose">${paragraphs(role.description)}</div>
      <section class="apply-wrap" aria-labelledby="apply">
      <h2 id="apply">Apply for this role</h2>
      ${hasErrors
        ? html`<div class="error-summary" id="error-summary" tabindex="-1" role="alert">
            <h2>There is a problem</h2>
            ${errors._questions ? html`<p>${errors._questions}</p>` : ''}
            ${fieldKeys.length
              ? html`<p>Please fix ${fieldKeys.length === 1 ? 'this field' : 'these fields'} and send the form again.</p>
                <ul>${fieldKeys.map((k) => html`<li><a href="#f-${k}">${errors[k]}</a></li>`)}</ul>`
              : ''}
          </div>`
        : ''}
      <form method="post" action="/roles/${role.id}/apply#apply" novalidate>
        ${publicField(ctx)}
        <input type="hidden" name="source" value="${source}">
        <input type="hidden" name="qv" value="${questionsVersion(role)}">
        <div class="hp" aria-hidden="true">
          <label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        </div>
        <fieldset class="form-section">
          <legend>About you</legend>
          ${field(errors, 'name', 'Full name', { required: true }, (a) => html`<input type="text" ${a} name="name" maxlength="${LIMITS.name}" value="${values.name || ''}" autocomplete="name" required>`)}
          ${field(errors, 'email', 'Email', { required: true, help: 'We will only use this to reply about your application.' }, (a) => html`<input type="email" ${a} name="email" maxlength="${LIMITS.email}" value="${values.email || ''}" autocomplete="email" required>`)}
          ${field(errors, 'linkedin_url', 'LinkedIn or portfolio URL', { help: 'A link starting with https://' }, (a) => html`<input type="text" ${a} inputmode="url" name="linkedin_url" maxlength="${LIMITS.linkedin}" value="${values.linkedin_url || ''}">`)}
          ${field(errors, 'heard_from', 'How did you hear about us?', {}, (a) => html`<select ${a} name="heard_from">
              <option value="">Choose one</option>
              ${HEARD_FROM.map((h) => html`<option${values.heard_from === h ? html` selected` : ''}>${h}</option>`)}
            </select>`)}
        </fieldset>
        <fieldset class="form-section">
          <legend>Your work</legend>
          ${field(errors, 'sample_links', 'Writing samples', { required: true, help: 'Paste links to your best published work, one per line. Links must start with https://' }, (a) => html`<textarea ${a} name="sample_links" rows="4" maxlength="${LIMITS.links}" required>${values.sample_links || ''}</textarea>`)}
          ${field(errors, 'resume_url', 'Resume link', { help: 'Optional. A link to your resume, starting with https://' }, (a) => html`<input type="text" ${a} inputmode="url" name="resume_url" maxlength="${LIMITS.resume}" value="${values.resume_url || ''}">`)}
        </fieldset>
        ${role.questions.length
          ? html`<fieldset class="form-section">
              <legend>Questions</legend>
              ${role.questions.map((q, i) =>
                field(errors, `answer_${i}`, q.text, { required: q.required }, (a) => html`<textarea ${a} name="answer_${i}" rows="4" maxlength="${LIMITS.answer}"${q.required ? html` required` : ''}>${(values.answers || [])[i] || ''}</textarea>`)
              )}
            </fieldset>`
          : ''}
        <div class="form-actions"><button type="submit" class="btn btn-primary">Send application</button></div>
      </form>
      </section>`,
  });
}

// Accepts "https://x" or a bare "example.com/x" (https:// is added). http:// and every other scheme
// (javascript:, data:, ftp:, ...) is refused. Returns '' for empty input and null for an invalid URL.
function normaliseUrl(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  if (/^[/\\]|\s/.test(v)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(v);
  const hostAndPort = /^[^/?#:@]+:\d+([/?#]|$)/.test(v); // "example.com:8080/x" is a host, not a scheme
  if (hasScheme && !hostAndPort && !/^https:\/\//i.test(v)) return null;
  if (!hasScheme || hostAndPort) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password) return u.toString();
  } catch {
    /* invalid */
  }
  return null;
}

// A plain address: one @, a local part of letters, digits and . _ + - (no leading, trailing or doubled dot), and a
// dotted domain with a letters-only last label. Everything that could change a mailto: or URL (? & = % / # quotes
// angle brackets , ; whitespace) is refused. The reserved sample domain is refused so applicants can never attach to
// sample data.
function validEmail(email) {
  const e = String(email).toLowerCase();
  if (e.length > LIMITS.email || e.includes('..')) return false;
  if (!/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(e)) return false;
  return !e.endsWith(`@${SAMPLE_DOMAIN}`);
}

function validate(form, role) {
  const errors = {};
  const values = {
    name: form.get('name').replace(/\s+/g, ' ').trim(),
    email: form.get('email').trim(),
    linkedin_url: form.get('linkedin_url').trim(),
    resume_url: form.get('resume_url').trim(),
    sample_links: form.get('sample_links').replace(/\r\n/g, '\n').trim(),
    heard_from: form.get('heard_from').trim(),
    source: cleanSource(form.get('source')),
    answers: role.questions.map((_, i) => form.get(`answer_${i}`).replace(/\r\n/g, '\n').trim()),
  };

  if (!values.name) errors.name = 'Please enter your full name.';
  else if (values.name.length > LIMITS.name) errors.name = `Name must be at most ${LIMITS.name} characters.`;

  if (!values.email) errors.email = 'Please enter your email address.';
  else if (!validEmail(values.email)) errors.email = 'Please enter a valid email address.';

  let linkedin = '';
  if (values.linkedin_url) {
    if (values.linkedin_url.length > LIMITS.linkedin) errors.linkedin_url = `Must be at most ${LIMITS.linkedin} characters.`;
    else if (!(linkedin = normaliseUrl(values.linkedin_url))) errors.linkedin_url = 'Please enter a valid https:// URL.';
  }

  let resume = '';
  if (values.resume_url) {
    if (values.resume_url.length > LIMITS.resume) errors.resume_url = `Must be at most ${LIMITS.resume} characters.`;
    else if (!(resume = normaliseUrl(values.resume_url))) errors.resume_url = 'Please enter a valid https:// URL.';
  }

  const links = values.sample_links.split('\n').map((l) => l.trim()).filter(Boolean);
  const normalisedLinks = links.map(normaliseUrl);
  if (values.sample_links.length > LIMITS.links) errors.sample_links = `Links must be at most ${LIMITS.links} characters in total.`;
  else if (links.length === 0) errors.sample_links = 'Please add at least one writing sample link.';
  else if (normalisedLinks.some((l) => !l)) errors.sample_links = 'Each line must be a valid https:// URL.';

  role.questions.forEach((q, i) => {
    const a = values.answers[i];
    if (q.required && !a) errors[`answer_${i}`] = 'This question is required.';
    else if (a.length > LIMITS.answer) errors[`answer_${i}`] = `Answers must be at most ${LIMITS.answer} characters.`;
  });

  if (values.heard_from && !HEARD_FROM.includes(values.heard_from)) errors.heard_from = 'Please pick one of the options.';

  return {
    errors,
    values,
    clean: {
      name: values.name,
      email: normaliseEmail(values.email),
      linkedin_url: linkedin || '',
      resume_url: resume || '',
      sample_links: normalisedLinks.join('\n'),
      heard_from: values.heard_from,
      source_tag: values.source,
      answers: role.questions.map((q, i) => ({ question: q.text, answer: values.answers[i] })),
    },
  };
}

async function applySubmit(ctx) {
  const { db, config, log } = ctx.app;
  const role = await getRole(db, ctx.params.id);
  if (!role || role.status !== 'open') return closedPage(ctx);

  const form = await readForm(ctx.req);
  verifyPublic(ctx, form);

  // The per-IP limit is reserved INSIDE the batches below (atomic with the inserts), never checked first.
  const limitKey = rateKey(config.secret, 'apply', ctx.ip);
  const spec = { key: limitKey, limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS };

  // Honeypot: pretend it worked, save nothing (still counts towards the rate limit).
  if (form.get('website').trim()) {
    await reserve(db, [spec]);
    return ctx.redirect('/thanks#top');
  }

  const { errors, values, clean } = validate(form, role);
  if (form.get('qv') !== questionsVersion(role)) {
    // The questionnaire changed after the form was loaded: show the current questions, keep the rest.
    return applyFormPage(ctx, role, {
      values: { ...values, answers: [] },
      errors: { _questions: 'The questions for this role have changed since you opened the form. Please review your answers below and submit again.' },
      status: 409,
    });
  }
  if (Object.keys(errors).length) return applyFormPage(ctx, role, { values, errors, status: 400 });

  // One atomic batch. The rate-limit row is reserved first (only while the IP has fewer than RATE_LIMIT hits in the
  // window); every later statement is conditioned on that row existing, so at most RATE_LIMIT applications are
  // stored however many requests arrive at once. The application and the event find their ids in SQL (the person by
  // email, the application via last_insert_rowid()), so there is no read-then-write. An existing person keeps their
  // name and LinkedIn (filled only when empty); what was typed this time is kept on the application row.
  const now = nowIso();
  const { at, statements: reserved } = reserveStatements([spec]);
  const guard = reservedGuard(limitKey, at);
  const results = await db.batch([
    reserved[0],
    {
      sql: `INSERT INTO people (email, name, linkedin_url, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}
            ON CONFLICT(email) DO UPDATE SET
              name = CASE WHEN people.name = '' THEN excluded.name ELSE people.name END,
              linkedin_url = CASE WHEN people.linkedin_url = '' THEN excluded.linkedin_url ELSE people.linkedin_url END,
              updated_at = excluded.updated_at`,
      args: [clean.email, clean.name, clean.linkedin_url, now, now, ...guard.args],
    },
    {
      sql: `INSERT INTO applications (person_id, role_id, applicant_name, applicant_linkedin, stage, sample_links, resume_url, answers_json,
              heard_from, source_tag, applied_at, stage_changed_at)
            SELECT id, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ? FROM people WHERE email = ? AND ${guard.sql}`,
      args: [
        role.id,
        clean.name,
        clean.linkedin_url,
        clean.sample_links,
        clean.resume_url,
        JSON.stringify(clean.answers),
        clean.heard_from,
        clean.source_tag,
        now,
        now,
        clean.email,
        ...guard.args,
      ],
    },
    {
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT last_insert_rowid(), 'stage_change', NULL, 'new', NULL, ? WHERE ${guard.sql}`,
      args: [now, ...guard.args],
    },
    pruneStatement(),
  ]);
  if (results[0].changes !== 1) {
    return page(ctx, {
      title: 'Too many submissions',
      status: 429,
      body: html`<div class="wrap-read"><h1 class="display">Too many submissions</h1><p class="lede">You have sent too many applications in the last hour. Please try again later.</p><p><a href="/">Back to open roles</a></p></div>`,
    });
  }
  const applicationId = results[2].lastInsertRowid;

  // Optional webhook after the batch has committed: role title and link only, never applicant data.
  await notifyNewApplication({
    webhookUrl: config.webhookUrl,
    fetchImpl: ctx.app.fetchImpl,
    log,
    roleTitle: role.title,
    applicationId,
    baseUrl: ctx.baseUrl(),
  });
  // The form's action carries #apply, which a redirect without a fragment would inherit.
  ctx.redirect('/thanks#top');
}

function register(router) {
  router.get('/', openingsPage);
  router.get('/roles/:id', async (ctx) => {
    const role = await getRole(ctx.app.db, ctx.params.id);
    if (!role || role.status !== 'open') return closedPage(ctx);
    applyFormPage(ctx, role);
  });
  router.post('/roles/:id/apply', applySubmit);
  // Reloading or bookmarking the form's action URL lands back on the role page.
  router.get('/roles/:id/apply', (ctx) => {
    const source = cleanSource(ctx.query.get('source'));
    ctx.redirect(`/roles/${encodeURIComponent(ctx.params.id)}${sourceSuffix(source)}`);
  });
  router.post('/roles/:id', applySubmit);
  router.get('/thanks', (ctx) =>
    page(ctx, {
      title: 'Thank you',
      body: html`<div class="thanks wrap-read">
        <h1 class="display">Thank you for applying</h1>
        <p class="lede">We have your application. An editor will read it and get in touch if there is a fit.</p>
        <p><a class="btn btn-primary" href="/">See other open roles</a></p>
      </div>`,
    })
  );
}

module.exports = { register, LIMITS, RATE_LIMIT, RATE_WINDOW_MS };
