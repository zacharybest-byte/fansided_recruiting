'use strict';
// Public pages: openings list, role page + apply form, thanks.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { html, multiline } = require('../lib/render');
const { page, HEARD_FROM } = require('../lib/layout');
const { readForm } = require('../lib/http');
const { publicField, verifyPublic } = require('../lib/csrf');
const { transaction, nowIso } = require('../lib/db');
const { randomHex } = require('../lib/crypto');
const { normaliseEmail } = require('../lib/auth');

const LIMITS = { name: 200, email: 254, linkedin: 2000, links: 2000, answer: 5000, source: 100 };
const FILE_TYPES = {
  pdf: (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
  doc: (b) => b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0,
  docx: (b) => b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b, // "PK" (zip container)
};
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function createRateLimiter(limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS) {
  const hits = new Map();
  const recent = (key, now) => (hits.get(key) || []).filter((t) => now - t < windowMs);
  return {
    // True while the caller has fewer than `limit` recorded submissions in the window.
    allowed(key, now = Date.now()) {
      return recent(key, now).length < limit;
    },
    // Records one submission (only stored applications and honeypot hits are recorded).
    record(key, now = Date.now()) {
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
    },
    reset() {
      hits.clear();
    },
  };
}

function excerpt(text, max = 160) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
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

function getRole(db, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const role = db.prepare('SELECT * FROM job_roles WHERE id = ?').get(Number(id));
  if (role) role.questions = JSON.parse(role.questions_json || '[]');
  return role;
}

function openingsPage(ctx) {
  const source = cleanSource(ctx.query.get('source'));
  const roles = ctx.app.db
    .prepare("SELECT * FROM job_roles WHERE status = 'open' ORDER BY vertical COLLATE NOCASE, title COLLATE NOCASE")
    .all();
  const groups = new Map();
  for (const r of roles) {
    const key = r.vertical || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  page(ctx, {
    title: 'Open roles',
    body: html`<h1>Write for FanSided</h1>
      <p>We are looking for contributors. Pick a role below to apply.</p>
      ${roles.length === 0 ? html`<p class="muted">There are no open roles right now. Please check back soon.</p>` : ''}
      ${[...groups].map(
        ([vertical, list]) => html`<section class="vertical">
          <h2>${vertical}</h2>
          <ul class="openings">
            ${list.map(
              (r) => html`<li>
                <a href="/roles/${r.id}${sourceSuffix(source)}" class="role-title">${r.title}</a>
                ${r.site_name ? html`<span class="muted"> · ${r.site_name}</span>` : ''}
                <div class="excerpt">${excerpt(r.description)}</div>
                <a href="/roles/${r.id}${sourceSuffix(source)}#apply">Apply</a>
              </li>`
            )}
          </ul>
        </section>`
      )}`,
  });
}

function closedPage(ctx) {
  page(ctx, {
    title: 'Role closed',
    status: 404,
    body: html`<h1>This role is no longer open</h1><p><a href="/">See all open roles</a></p>`,
  });
}

function fieldError(errors, name) {
  return errors[name] ? html`<span class="error" id="err-${name}">${errors[name]}</span>` : '';
}

function applyFormPage(ctx, role, { values = {}, errors = {}, status = 200 } = {}) {
  const source = values.source !== undefined ? values.source : cleanSource(ctx.query.get('source'));
  const hasErrors = Object.keys(errors).length > 0;
  page(ctx, {
    title: role.title,
    status,
    body: html`<p><a href="/${sourceSuffix(source)}">← All open roles</a></p>
      <h1>${role.title}</h1>
      <p class="muted">${role.vertical}${role.site_name ? ` · ${role.site_name}` : ''}</p>
      ${multiline(role.description)}
      <h2 id="apply">Apply</h2>
      ${hasErrors
        ? html`<div class="flash flash-error" id="error-summary" tabindex="-1" role="alert">
            ${errors._questions ? html`<p>${errors._questions}</p>` : html`<p>Please fix the highlighted fields below.</p>`}
            ${errors.file ? '' : html`<p>If you attached a file, please choose it again.</p>`}
          </div>`
        : ''}
      <form method="post" action="/roles/${role.id}/apply#apply" enctype="multipart/form-data" class="stacked" novalidate>
        ${publicField(ctx)}
        <input type="hidden" name="source" value="${source}">
        <input type="hidden" name="qv" value="${questionsVersion(role)}">
        <div class="hp" aria-hidden="true">
          <label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        </div>
        <label>Full name <span class="req">*</span>
          <input type="text" name="name" maxlength="${LIMITS.name}" value="${values.name || ''}" required>
        </label>${fieldError(errors, 'name')}
        <label>Email <span class="req">*</span>
          <input type="email" name="email" maxlength="${LIMITS.email}" value="${values.email || ''}" required>
        </label>${fieldError(errors, 'email')}
        <label>LinkedIn or portfolio URL
          <input type="url" name="linkedin_url" maxlength="${LIMITS.linkedin}" value="${values.linkedin_url || ''}">
        </label>${fieldError(errors, 'linkedin_url')}
        <label>Writing sample links <span class="req">*</span> <span class="muted">(one URL per line)</span>
          <textarea name="sample_links" rows="4" maxlength="${LIMITS.links}" required>${values.sample_links || ''}</textarea>
        </label>${fieldError(errors, 'sample_links')}
        <label>Resume or writing sample file <span class="muted">(optional; PDF, DOC or DOCX; up to ${ctx.app.config.maxUploadMb} MB)</span>
          <input type="file" name="file" accept=".pdf,.doc,.docx">
        </label>${fieldError(errors, 'file')}
        ${role.questions.map(
          (q, i) => html`<label>${q.text}${q.required ? html` <span class="req">*</span>` : ''}
              <textarea name="answer_${i}" rows="4" maxlength="${LIMITS.answer}"${q.required ? html` required` : ''}>${(values.answers || [])[i] || ''}</textarea>
            </label>${fieldError(errors, `answer_${i}`)}`
        )}
        <label>How did you hear about us?
          <select name="heard_from">
            <option value="">Choose one</option>
            ${HEARD_FROM.map((h) => html`<option${values.heard_from === h ? html` selected` : ''}>${h}</option>`)}
          </select>
        </label>${fieldError(errors, 'heard_from')}
        <p><button type="submit" class="primary">Submit application</button></p>
      </form>`,
  });
}

// Accepts "https://x", "http://x" or a bare "example.com/x" (assumed https).
function normaliseUrl(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')) return u.toString();
  } catch {
    /* invalid */
  }
  return null;
}

function validate(form, role, maxUploadBytes) {
  const errors = {};
  const values = {
    name: form.get('name').replace(/\s+/g, ' ').trim(),
    email: form.get('email').trim(),
    linkedin_url: form.get('linkedin_url').trim(),
    sample_links: form.get('sample_links').replace(/\r\n/g, '\n').trim(),
    heard_from: form.get('heard_from').trim(),
    source: cleanSource(form.get('source')),
    answers: role.questions.map((_, i) => form.get(`answer_${i}`).replace(/\r\n/g, '\n').trim()),
  };

  if (!values.name) errors.name = 'Please enter your full name.';
  else if (values.name.length > LIMITS.name) errors.name = `Name must be at most ${LIMITS.name} characters.`;

  if (!values.email) errors.email = 'Please enter your email address.';
  else if (values.email.length > LIMITS.email || !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(values.email))
    errors.email = 'Please enter a valid email address.';

  let linkedin = '';
  if (values.linkedin_url) {
    if (values.linkedin_url.length > LIMITS.linkedin) errors.linkedin_url = `Must be at most ${LIMITS.linkedin} characters.`;
    else if (!(linkedin = normaliseUrl(values.linkedin_url))) errors.linkedin_url = 'Please enter a valid http(s) URL.';
  }

  const links = values.sample_links.split('\n').map((l) => l.trim()).filter(Boolean);
  const normalisedLinks = links.map(normaliseUrl);
  if (values.sample_links.length > LIMITS.links) errors.sample_links = `Links must be at most ${LIMITS.links} characters in total.`;
  else if (links.length === 0) errors.sample_links = 'Please add at least one writing sample link.';
  else if (normalisedLinks.some((l) => !l)) errors.sample_links = 'Each line must be a valid http(s) URL.';

  role.questions.forEach((q, i) => {
    const a = values.answers[i];
    if (q.required && !a) errors[`answer_${i}`] = 'This question is required.';
    else if (a.length > LIMITS.answer) errors[`answer_${i}`] = `Answers must be at most ${LIMITS.answer} characters.`;
  });

  if (values.heard_from && !HEARD_FROM.includes(values.heard_from)) errors.heard_from = 'Please pick one of the options.';

  let file = form.file('file');
  if (file) {
    const ext = path.extname(file.filename).slice(1).toLowerCase();
    if (!FILE_TYPES[ext]) errors.file = 'The file must be a PDF, DOC or DOCX.';
    else if (file.data.length === 0) errors.file = 'The file is empty.';
    else if (file.data.length > maxUploadBytes) errors.file = `The file must be at most ${Math.round(maxUploadBytes / 1048576)} MB.`;
    else if (!FILE_TYPES[ext](file.data)) errors.file = `The file does not look like a real .${ext} file.`;
    if (!errors.file) file = { ...file, ext };
  }

  return {
    errors,
    values,
    clean: {
      name: values.name,
      email: normaliseEmail(values.email),
      linkedin_url: linkedin || '',
      sample_links: normalisedLinks.join('\n'),
      heard_from: values.heard_from,
      source_tag: values.source,
      answers: role.questions.map((q, i) => ({ question: q.text, answer: values.answers[i] })),
      file: errors.file ? null : file,
    },
  };
}

async function applySubmit(ctx) {
  const { db, config, mailer, log } = ctx.app;
  const role = getRole(db, ctx.params.id);
  if (!role || role.status !== 'open') return closedPage(ctx);

  if (!ctx.app.applyLimiter.allowed(ctx.ip)) {
    return page(ctx, {
      title: 'Too many submissions',
      status: 429,
      body: html`<h1>Too many submissions</h1><p>You have sent too many applications in the last hour. Please try again later.</p>`,
    });
  }

  const form = await readForm(ctx.req, config.maxBodyBytes);
  verifyPublic(ctx, form);

  // Honeypot: pretend it worked, save nothing (still counts towards the rate limit).
  if (form.get('website').trim()) {
    ctx.app.applyLimiter.record(ctx.ip);
    return ctx.redirect('/thanks');
  }

  const { errors, values, clean } = validate(form, role, config.maxUploadBytes);
  if (form.get('qv') !== questionsVersion(role)) {
    // The questionnaire changed after the form was loaded: show the current questions, keep the rest.
    return applyFormPage(ctx, role, {
      values: { ...values, answers: [] },
      errors: { _questions: 'The questions for this role have changed since you opened the form. Please review your answers below and submit again.' },
      status: 409,
    });
  }
  if (Object.keys(errors).length) return applyFormPage(ctx, role, { values, errors, status: 400 });

  let storedPath = null;
  if (clean.file) {
    const uploads = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    storedPath = `uploads/${randomHex(16)}.${clean.file.ext}`;
    fs.writeFileSync(path.join(config.dataDir, storedPath), clean.file.data, { flag: 'wx' });
  }

  let applicationId;
  let person;
  try {
    transaction(db, () => {
      const now = nowIso();
      person = db.prepare('SELECT * FROM people WHERE email = ?').get(clean.email);
      if (person) {
        db.prepare('UPDATE people SET name = ?, linkedin_url = ?, updated_at = ? WHERE id = ?').run(clean.name, clean.linkedin_url, now, person.id);
      } else {
        const r = db
          .prepare('INSERT INTO people (email, name, linkedin_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(clean.email, clean.name, clean.linkedin_url, now, now);
        person = { id: Number(r.lastInsertRowid) };
      }
      person = { ...person, email: clean.email, name: clean.name };
      const r = db
        .prepare(
          `INSERT INTO applications (person_id, role_id, stage, sample_links, file_path, file_name, answers_json,
             heard_from, source_tag, applied_at, stage_changed_at)
           VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          person.id,
          role.id,
          clean.sample_links,
          storedPath,
          clean.file ? clean.file.filename.slice(0, 255) : null,
          JSON.stringify(clean.answers),
          clean.heard_from,
          clean.source_tag,
          now,
          now
        );
      applicationId = Number(r.lastInsertRowid);
      db.prepare(
        "INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at) VALUES (?, 'stage_change', NULL, 'new', NULL, ?)"
      ).run(applicationId, now);
    });
  } catch (err) {
    if (storedPath) fs.rmSync(path.join(config.dataDir, storedPath), { force: true });
    throw err;
  }

  ctx.app.applyLimiter.record(ctx.ip);
  try {
    await mailer.notifyNewApplication({ role, person, applicationId });
  } catch (err) {
    log(`[notify] unexpected error: ${err.message}`);
  }
  ctx.redirect('/thanks');
}

function register(router) {
  router.get('/', openingsPage);
  router.get('/roles/:id', (ctx) => {
    const role = getRole(ctx.app.db, ctx.params.id);
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
      body: html`<h1>Thank you for applying</h1>
        <p>We have received your application. A member of our team will review it and get in touch if there is a fit.</p>
        <p><a href="/">See other open roles</a></p>`,
    })
  );
}

module.exports = { register, createRateLimiter, LIMITS };
