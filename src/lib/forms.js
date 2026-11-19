'use strict';
// Form building blocks shared by the admin screens.
const { html, raw } = require('./render');
const { errorSummary } = require('./layout');

function fieldError(errors, name) {
  return errors[name] ? html`<p class="error" id="err-${name}">${errors[name]}</p>` : '';
}

// One labelled field with optional help text and inline error; `control(attrs)` renders the input.
function field(errors, name, label, { help = '', required = false, id = `f-${name}` } = {}, control) {
  const describedBy = [help ? `help-${name}` : '', errors[name] ? `err-${name}` : ''].filter(Boolean).join(' ');
  const attrs = raw(`id="${id}"${describedBy ? ` aria-describedby="${describedBy}"` : ''}${errors[name] ? ' aria-invalid="true"' : ''}`);
  return html`<div class="field${errors[name] ? ' has-error' : ''}">
    <label for="${id}">${label}${required ? html` <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span>` : ''}</label>
    ${help ? html`<p class="help" id="help-${name}">${help}</p>` : ''}
    ${control(attrs)}
    ${fieldError(errors, name)}
  </div>`;
}

// Error summary for a form that has per-field errors. `ids` maps a field name to the element id when it is not f-<name>.
function summaryFor(errors, ids = {}) {
  return errorSummary(Object.keys(errors).map((k) => ({ id: ids[k] || `f-${k}`, text: errors[k] })));
}

// A read-only numbered list of questions with their required flag (role form preview, questionnaire list).
function questionList(questions) {
  if (!questions.length) return html`<p class="muted">No questions.</p>`;
  return html`<ol class="qn-questions">${questions.map((q) => html`<li><span class="qn-text">${q.text}</span> <span class="qn-flag${q.required ? ' is-required' : ''}">${q.required ? 'Required' : 'Optional'}</span></li>`)}</ol>`;
}

module.exports = { fieldError, field, summaryFor, questionList };
