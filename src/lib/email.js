'use strict';
// Email composing helpers. The app never sends mail: it fills in a template, logs that the rep opened a
// compose window, and hands the rep a Gmail or mailto: link.

const MERGE_FIELDS = {
  first_name: "First word of the candidate's name",
  role_title: "The application's current role title",
  rep_name: 'Your name (the sender)',
};

// Resolves {{field}} placeholders. Unknown fields stay as literal text and are reported.
function applyMergeFields(text, values) {
  const unknown = new Set();
  const out = String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(MERGE_FIELDS, key)) return values[key] ?? '';
    unknown.add(key);
    return m;
  });
  return { text: out, unknown: [...unknown] };
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// The compose link for a logged email. Every value goes through encodeURIComponent.
//   gmail:  https://mail.google.com/mail/?view=cm&fs=1&to=..&su=..&body=..   (newlines as %0A)
//   mailto: mailto:<address>?subject=..&body=..                              (newlines as %0D%0A)
function composeUrl(via, { to, subject, body }) {
  const text = String(body).replace(/\r\n|\r/g, '\n');
  if (via === 'mailto') {
    return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.replace(/\n/g, '\r\n'))}`;
  }
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

// ---- Linked documents (2.4.0) ----
// A draft URL cannot carry files, so a template can carry named links that are appended to the body as ordinary text.
const DOCS = { max: 5, name: 80, url: 500, body: 4000 };

// Stored as JSON [{name, url}] in email_templates.attachments_json. Anything malformed reads as "no documents".
function parseDocuments(json) {
  try {
    const v = JSON.parse(json || '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((d) => d && typeof d.name === 'string' && typeof d.url === 'string' && d.name && d.url)
      .slice(0, DOCS.max)
      .map((d) => ({ name: d.name, url: d.url }));
  } catch {
    return [];
  }
}

// Merge fields work in names (never in URLs); the result stays on one line.
function resolveDocuments(docs, values) {
  const unknown = [];
  const out = docs.map((d) => {
    const r = applyMergeFields(d.name, values);
    unknown.push(...r.unknown);
    return { name: r.text.replace(/\s+/g, ' ').trim(), url: d.url };
  });
  return { docs: out, unknown };
}

// "Documents:" then one "- Name: URL" line per document. Empty string when there are none.
function documentsBlock(docs) {
  if (!docs.length) return '';
  return `Documents:\n${docs.map((d) => `- ${d.name}: ${d.url}`).join('\n')}`;
}

// Template body, a blank line, then the block.
function bodyWithDocuments(body, docs) {
  const block = documentsBlock(docs);
  return block ? `${body}\n\n${block}` : body;
}

// Longest a draft can get: merge fields are counted at a generous length (first name 40, role title 100, rep name 60).
const WORST_CASE = { first_name: 40, role_title: 100, rep_name: 60 };
function worstCaseLength(body, docs) {
  const fill = (text) => applyMergeFields(text, Object.fromEntries(Object.entries(WORST_CASE).map(([k, n]) => [k, 'x'.repeat(n)]))).text;
  return bodyWithDocuments(fill(body), docs.map((d) => ({ name: fill(d.name), url: d.url }))).length;
}

const VIA_LABELS = { gmail: 'opened in Gmail', mailto: 'opened in mail app' };

module.exports = { DOCS, parseDocuments, resolveDocuments, documentsBlock, bodyWithDocuments, worstCaseLength, applyMergeFields, firstName, composeUrl, MERGE_FIELDS, VIA_LABELS };
