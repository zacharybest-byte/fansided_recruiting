'use strict';
// Tiny HTML templating: the `html` tag escapes every interpolated value unless
// it is already a SafeHtml (produced by `html` itself or by `raw`).

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function toHtml(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(toHtml).join('');
  return escapeHtml(value);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// Only for strings the code itself built and trusts.
function raw(value) {
  return new SafeHtml(String(value));
}

// Only https URLs are ever rendered as links.
function isHttpsUrl(value) {
  try {
    return new URL(String(value).trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

// Render a URL as a link only when it parses and is https; otherwise as plain text.
function link(url, text) {
  const value = String(url || '').trim();
  if (!value) return html``;
  if (!isHttpsUrl(value)) return html`${value}`;
  return html`<a href="${value}" rel="noopener noreferrer" target="_blank">${text || value}</a>`;
}

// Plain text with newlines kept (CSS uses white-space: pre-wrap on .pre).
function multiline(text) {
  return html`<div class="pre">${text || ''}</div>`;
}

function selected(cond) {
  return cond ? raw(' selected') : '';
}
function checked(cond) {
  return cond ? raw(' checked') : '';
}

module.exports = { html, raw, escapeHtml, SafeHtml, link, multiline, isHttpsUrl, selected, checked };
