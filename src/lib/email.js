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

const VIA_LABELS = { gmail: 'opened in Gmail', mailto: 'opened in mail app' };

module.exports = { applyMergeFields, firstName, composeUrl, MERGE_FIELDS, VIA_LABELS };
