'use strict';
// Questionnaires: named, reusable lists of questions. A role selects one (job_roles.questionnaire_id) or none.
// A questionnaire keeps its questions as a JSON array in questionnaires.questions_json, exactly the representation the
// per-role questions always had: [{ "text": "...", "required": true }, ...].
//
// job_roles.questions_json is LEGACY storage. The app never reads it for display. It is still WRITTEN, as a verbatim
// copy of the selected questionnaire's questions_json ('[]' for none), on every role save and every questionnaire save,
// so a rollback to the previous version still shows the right questions. repair() handles the other direction: a role
// written by that older version.
const { nowIso } = require('./db');

const MAX_QUESTIONS = 5;
const QUESTION_MAX = 500;
const NAME_MAX = 80;

// Questions as the app handles them: [{ text, required }]. Tolerant of anything stored (never throws).
function parseQuestions(json) {
  let value;
  try {
    value = JSON.parse(json || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((q) => q && typeof q === 'object' && typeof q.text === 'string' && q.text.trim())
    .map((q) => ({ text: q.text, required: q.required === true || q.required === 1 || q.required === '1' }));
}

// The one serialisation, used for questionnaires.questions_json and for the legacy copy on roles.
function serialise(questions) {
  return JSON.stringify(questions.map((q) => ({ text: q.text, required: Boolean(q.required) })));
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// SQL: is this column a non-empty JSON array? ('' , '[]', '[ ]', ' [\n] ', anything not starting with '[' are not.)
// No JSON functions: whitespace is stripped and the result compared with '[]'.
const nonEmptyArray = (col) =>
  `(substr(trim(${col}, ' ' || char(9) || char(10) || char(13)), 1, 1) = '[' AND replace(replace(replace(replace(${col}, ' ', ''), char(9), ''), char(10), ''), char(13), '') != '[]')`;

// SQL: the name given to the questionnaire made from a role's own questions, for the role row `alias` ("<title> questions",
// title cut to 50 characters). A role whose shortened title (case-insensitive) is shared with an EARLIER role that has
// questions gets " (<role id>)" added, so every name is unique and at most 80 characters.
function backfillName(alias) {
  const short = (a) => `lower(trim(substr(trim(${a}.title), 1, 50)))`;
  const base = `(COALESCE(NULLIF(trim(substr(trim(${alias}.title), 1, 50)), ''), 'Role ' || ${alias}.id) || ' questions')`;
  return `(CASE WHEN EXISTS (SELECT 1 FROM job_roles o WHERE o.id < ${alias}.id AND ${nonEmptyArray('o.questions_json')} AND ${short('o')} = ${short(alias)})
     THEN ${base} || ' (' || ${alias}.id || ')' ELSE ${base} END)`;
}

// A statement that always fails (questionnaires.name is NOT NULL) when `conditionSql` is true: rolls the batch back.
function abortIf(conditionSql, args = []) {
  return { sql: `INSERT INTO questionnaires (name, questions_json, created_at, updated_at) SELECT NULL, '[]', '', '' WHERE ${conditionSql}`, args };
}

function isGuardFailure(err) {
  return /questionnaires\.name/i.test(String(err && err.message));
}

function isDuplicateName(err) {
  return /UNIQUE constraint failed/i.test(String(err && err.message)) && /questionnaires/i.test(String(err && err.message));
}

// Every questionnaire with its question count and the roles that use it: [{ id, name, questions, roles: [{ id, title }] }].
async function listAll(db) {
  const rows = await db.all('SELECT id, name, questions_json, is_sample, created_at, updated_at FROM questionnaires ORDER BY name COLLATE NOCASE, id');
  const roles = await db.all('SELECT id, title, questionnaire_id FROM job_roles WHERE questionnaire_id IS NOT NULL ORDER BY title COLLATE NOCASE, id');
  const byQ = new Map();
  for (const r of roles) {
    if (!byQ.has(r.questionnaire_id)) byQ.set(r.questionnaire_id, []);
    byQ.get(r.questionnaire_id).push({ id: r.id, title: r.title });
  }
  return rows.map((q) => ({ ...q, questions: parseQuestions(q.questions_json), roles: byQ.get(q.id) || [] }));
}

async function getOne(db, id) {
  const q = await db.get('SELECT * FROM questionnaires WHERE id = ?', [id]);
  if (!q) return null;
  q.questions = parseQuestions(q.questions_json);
  q.roles = await db.all('SELECT id, title FROM job_roles WHERE questionnaire_id = ? ORDER BY title COLLATE NOCASE, id', [id]);
  return q;
}

// "<title> questions", or "... (2)", "... (3)" when that name is taken (case-insensitive).
function freeName(title, taken) {
  const t = cleanName(title).slice(0, 50).trim() || 'Role';
  const base = `${t} questions`;
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

// Start-up repair for roles written by an OLDER deployment (a rollout or a rollback), which only knows
// job_roles.questions_json. One cheap read when everything is consistent. A role is out of step when
//  - it has no questionnaire but its legacy questions are non-empty (created or edited by the older version), or
//  - its legacy copy differs from its questionnaire's questions (edited by the older version).
// Such a role gets a NEW questionnaire made from its legacy questions and is pointed at it, because the older version
// edited that ROLE (its questionnaire may be shared with other roles, which must not change). A role whose legacy
// questions were emptied by the older version loses its questionnaire. Each role is one atomic, guarded batch.
async function repair(db, now = nowIso()) {
  const todo = await db.all(
    `SELECT r.id, r.title, ${nonEmptyArray('r.questions_json')} AS has_questions
       FROM job_roles r LEFT JOIN questionnaires q ON q.id = r.questionnaire_id
      WHERE (r.questionnaire_id IS NULL AND ${nonEmptyArray('r.questions_json')})
         OR (r.questionnaire_id IS NOT NULL AND (q.id IS NULL OR r.questions_json != q.questions_json))
      ORDER BY r.id`
  );
  const result = { created: 0, cleared: 0 };
  for (const role of todo) {
    if (!role.has_questions) {
      const r = await db.run(
        `UPDATE job_roles SET questionnaire_id = NULL WHERE id = ? AND questionnaire_id IS NOT NULL AND NOT ${nonEmptyArray('questions_json')}`,
        [role.id]
      );
      result.cleared += r.changes;
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const taken = (await db.all('SELECT name FROM questionnaires')).map((x) => x.name);
      const name = freeName(role.title, taken);
      try {
        const [ins] = await db.batch([
          {
            sql: `INSERT INTO questionnaires (name, questions_json, created_at, updated_at)
                  SELECT ?, r.questions_json, ?, ? FROM job_roles r
                   WHERE r.id = ? AND ${nonEmptyArray('r.questions_json')}
                     AND (r.questionnaire_id IS NULL OR NOT EXISTS (SELECT 1 FROM questionnaires q WHERE q.id = r.questionnaire_id AND q.questions_json = r.questions_json))`,
            args: [name, now, now, role.id],
          },
          { sql: 'UPDATE job_roles SET questionnaire_id = last_insert_rowid() WHERE id = ? AND changes() > 0', args: [role.id] },
        ]);
        result.created += ins.changes;
        break;
      } catch (err) {
        if (!isDuplicateName(err)) throw err; // another instance took the name: pick the next free one
      }
    }
  }
  return result;
}

module.exports = {
  MAX_QUESTIONS,
  QUESTION_MAX,
  NAME_MAX,
  parseQuestions,
  serialise,
  cleanName,
  nonEmptyArray,
  backfillName,
  abortIf,
  isGuardFailure,
  isDuplicateName,
  listAll,
  getOne,
  freeName,
  repair,
};
