'use strict';
// Per-role workflows. Every role owns an ordered list of stages in role_stages:
//   first  = "New"       (kind 'new')        fixed
//   middle = 0..6 custom (kind 'progress')   named by an admin, any order
//   last 2 = "Onboarded" (kind 'onboarded'), "Passed" (kind 'passed')   fixed
// applications.stage_id is the source of truth. The legacy applications.stage column (CHECK-limited to the five old
// values) is still written, as the stage's CATEGORY, so older queries and exports never break.
const { nowIso } = require('./db');

const MAX_PROGRESS = 6;
const NAME_MAX = 30;
const DEFAULT_PROGRESS = ['Reviewing', 'Trial'];
const FIXED_NAMES = { new: 'New', onboarded: 'Onboarded', passed: 'Passed' };
const KINDS = ['new', 'progress', 'onboarded', 'passed'];

// Legacy words as stored in old events and in applications.stage.
const LEGACY_LABELS = { new: 'New', reviewing: 'Reviewing', trial: 'Trial', onboarded: 'Onboarded', passed: 'Passed' };

// kind -> value for the legacy applications.stage column
function legacyCategory(kind) {
  return kind === 'progress' ? 'reviewing' : kind;
}

// legacy applications.stage value -> kind ('trial' is in progress)
function kindOfLegacy(stage) {
  return stage === 'reviewing' || stage === 'trial' ? 'progress' : stage;
}

// SQL: category for a role_stages row alias, and kind for a legacy stage column.
const CATEGORY_SQL = (alias) => `CASE ${alias}.kind WHEN 'progress' THEN 'reviewing' ELSE ${alias}.kind END`;

// One name as stored: whitespace collapsed, trimmed.
function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Plain-text name for an event value stored by an older version ('reviewing') or by this one ('Reviewing').
function eventStageName(value) {
  return Object.prototype.hasOwnProperty.call(LEGACY_LABELS, value) ? LEGACY_LABELS[value] : value;
}

// Rows of the five fixed/default stages, as [position, name, kind].
function stageRows(progressNames) {
  const rows = [[0, FIXED_NAMES.new, 'new']];
  progressNames.forEach((n, i) => rows.push([i + 1, n, 'progress']));
  rows.push([progressNames.length + 1, FIXED_NAMES.onboarded, 'onboarded']);
  rows.push([progressNames.length + 2, FIXED_NAMES.passed, 'passed']);
  return rows;
}

// Statements that insert a role's stages right after the INSERT INTO job_roles of the same batch: the first one reads
// the new role id from last_insert_rowid(), every next one takes the role id of the stage inserted just before it.
function insertStagesAfterRole(progressNames, now = nowIso()) {
  return stageRows(progressNames).map(([position, name, kind], i) =>
    i === 0
      ? { sql: 'INSERT INTO role_stages (role_id, position, name, kind, created_at) VALUES (last_insert_rowid(), ?, ?, ?, ?)', args: [position, name, kind, now] }
      : {
          sql: 'INSERT INTO role_stages (role_id, position, name, kind, created_at) SELECT role_id, ?, ?, ?, ? FROM role_stages WHERE id = last_insert_rowid()',
          args: [position, name, kind, now],
        }
  );
}

// Same, for a role that already exists and is found by a WHERE clause (sample data).
function insertStagesWhere(progressNames, whereSql, whereArgs, now = nowIso()) {
  return stageRows(progressNames).map(([position, name, kind]) => ({
    sql: `INSERT INTO role_stages (role_id, position, name, kind, created_at) SELECT id, ?, ?, ?, ? FROM job_roles WHERE ${whereSql}`,
    args: [position, name, kind, now, ...whereArgs],
  }));
}

// Idempotent repair, run at start-up and whenever a page finds a role without stages:
//  1. roles with no stages get the default five,
//  2. applications with no stage (written by an older deployment) or pointing at another role's stage are re-pointed
//     by their legacy value.
async function repair(db, now = nowIso()) {
  const fix = `s.role_id = applications.role_id AND s.kind = CASE WHEN applications.stage IN ('reviewing', 'trial') THEN 'progress' ELSE applications.stage END`;
  const order = `ORDER BY CASE WHEN lower(s.name) = applications.stage THEN 0 ELSE 1 END, s.position, s.id LIMIT 1`;
  const statements = [];
  // ONE statement for all five rows: the NOT EXISTS is evaluated before any of them is inserted.
  const rows = stageRows(DEFAULT_PROGRESS);
  statements.push({
    sql: `INSERT INTO role_stages (role_id, position, name, kind, created_at)
          SELECT r.id, d.position, d.name, d.kind, ?
            FROM job_roles r
           CROSS JOIN (${rows.map(() => 'SELECT ? AS position, ? AS name, ? AS kind').join(' UNION ALL ')}) d
           WHERE NOT EXISTS (SELECT 1 FROM role_stages s WHERE s.role_id = r.id)
           ORDER BY r.id, d.position`,
    args: [now, ...rows.flat()],
  });
  statements.push({
    sql: `UPDATE applications SET stage_id = (SELECT s.id FROM role_stages s WHERE ${fix} ${order})
           WHERE stage_id IS NULL OR NOT EXISTS (SELECT 1 FROM role_stages x WHERE x.id = applications.stage_id AND x.role_id = applications.role_id)`,
  });
  // One cheap read first: nothing to do on the normal path.
  const todo = await db.get(
    `SELECT (SELECT COUNT(*) FROM job_roles r WHERE NOT EXISTS (SELECT 1 FROM role_stages s WHERE s.role_id = r.id)) AS roles,
            (SELECT COUNT(*) FROM applications a JOIN job_roles r ON r.id = a.role_id
              WHERE a.stage_id IS NULL OR NOT EXISTS (SELECT 1 FROM role_stages x WHERE x.id = a.stage_id AND x.role_id = a.role_id)) AS apps`
  );
  if (!todo.roles && !todo.apps) return { roles: 0, applications: 0 };
  await db.batch(statements);
  return { roles: Number(todo.roles), applications: Number(todo.apps) };
}

// All stages of the given roles (or of every role), grouped: Map(role_id -> [stage, ...]) in position order.
async function stagesByRole(db, roleIds = null) {
  const rows = await db.all(
    `SELECT id, role_id, position, name, kind FROM role_stages
      ${roleIds ? `WHERE role_id IN (${roleIds.map(() => '?').join(',') || 'NULL'})` : ''}
      ORDER BY role_id, position, id`,
    roleIds || []
  );
  const map = new Map();
  for (const s of rows) {
    if (!map.has(s.role_id)) map.set(s.role_id, []);
    map.get(s.role_id).push(s);
  }
  return map;
}

// The stages of one role. A role without any (created by an older deployment during a rollout) is repaired first.
async function roleStages(db, roleId) {
  let list = (await stagesByRole(db, [roleId])).get(roleId);
  if (!list || !list.length) {
    await repair(db);
    list = (await stagesByRole(db, [roleId])).get(roleId) || [];
  }
  return list;
}

// Which stage an application is in, as an object of its role's list. stage_id is the truth; an application that has
// none (should not exist after repair) falls back to the first stage of the kind of its legacy value.
function stageOf(app, stages) {
  const byId = stages.find((s) => s.id === app.stage_id);
  if (byId) return byId;
  const kind = kindOfLegacy(app.stage);
  return stages.find((s) => s.kind === kind) || stages[0];
}

// Where a candidate lands when moved to another role: same kind for new / onboarded / passed; a progress stage maps to
// the target's progress stage with the same name (case-insensitive), else its first progress stage, else New.
function mapStage(fromStage, targetStages) {
  const ofKind = (k) => targetStages.find((s) => s.kind === k);
  if (fromStage.kind !== 'progress') return ofKind(fromStage.kind) || ofKind('new') || targetStages[0];
  const want = fromStage.name.toLowerCase();
  const same = targetStages.find((s) => s.kind === 'progress' && s.name.toLowerCase() === want);
  return same || ofKind('progress') || ofKind('new') || targetStages[0];
}

// A statement that always fails (NOT NULL) when `conditionSql` is true, which rolls the whole batch back.
// This is how a guard makes a multi-statement batch all-or-nothing.
function abortIf(conditionSql, args = []) {
  return {
    sql: `INSERT INTO role_stages (role_id, position, name, kind, created_at) SELECT NULL, 0, 'guard', 'new', '' WHERE ${conditionSql}`,
    args,
  };
}

function isGuardFailure(err) {
  return /role_stages\.role_id/i.test(String(err && err.message));
}

// Stage name for display in a sentence: "1 candidate" / "3 candidates".
function countWord(n, noun = 'candidate') {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

module.exports = {
  MAX_PROGRESS,
  NAME_MAX,
  DEFAULT_PROGRESS,
  FIXED_NAMES,
  KINDS,
  LEGACY_LABELS,
  legacyCategory,
  kindOfLegacy,
  CATEGORY_SQL,
  cleanName,
  eventStageName,
  stageRows,
  insertStagesAfterRole,
  insertStagesWhere,
  repair,
  stagesByRole,
  roleStages,
  stageOf,
  mapStage,
  abortIf,
  isGuardFailure,
  countWord,
};
