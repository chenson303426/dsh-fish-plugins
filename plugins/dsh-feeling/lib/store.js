// dsh-feeling · 存储层
// SQLite（node:sqlite，Node 24 / Electron 44 实测可用）
//
// 三张表：
//   objects  每个「鱼 → 对象」一份关系状态（关系基线 + 当前反应分）
//   matters  未解决事项（可以一直生气的那件事）
//   events   原始事件（带证据、去重键、确认状态）
//
// 关键约束：
//   - 事件只有 committed=1 才允许影响分数（确认后提交）
//   - dedup_key 唯一，重放/重试不会重复入账（事件幂等）
//   - 事件带 expires_at，过期或已被更新消息取代的不再入账（候选失效）

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  fish_id   TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'person',
  name      TEXT,
  warmth    REAL NOT NULL DEFAULT 0,
  trust     REAL NOT NULL DEFAULT 50,
  intimacy  REAL NOT NULL DEFAULT 0,
  admiration REAL NOT NULL DEFAULT 0,
  support_reliance REAL NOT NULL DEFAULT 50,
  band_warmth   TEXT,
  band_trust    TEXT,
  band_intimacy TEXT,
  map_version   INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fish_id, target_id)
);

CREATE TABLE IF NOT EXISTS matters (
  id            TEXT PRIMARY KEY,
  fish_id       TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  reason        TEXT,
  anger         REAL NOT NULL DEFAULT 0,
  anger_floor   REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',
  disclosure    TEXT NOT NULL DEFAULT 'unknown',
  repair_stance TEXT NOT NULL DEFAULT 'unknown',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  fish_id        TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  at             INTEGER NOT NULL,
  source         TEXT NOT NULL,
  source_msg_ids TEXT,
  evidence       TEXT,
  interpretation TEXT,
  severity       REAL NOT NULL DEFAULT 1,
  uncertainty    REAL NOT NULL DEFAULT 0,
  deltas         TEXT,
  matter_id      TEXT,
  dedup_key      TEXT NOT NULL UNIQUE,
  committed      INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS silence_seen (
  episode_id TEXT PRIMARY KEY,
  fish_id    TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  stage      TEXT,
  observed_at INTEGER NOT NULL,
  matter_id  TEXT
);

CREATE TABLE IF NOT EXISTS expectations (
  id             TEXT PRIMARY KEY,
  fish_id        TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  promisor_id    TEXT NOT NULL,
  beneficiary_id TEXT NOT NULL,
  original_text  TEXT,
  deadline_at    INTEGER,
  precision      TEXT NOT NULL DEFAULT 'vague',
  status         TEXT NOT NULL DEFAULT 'pending',
  evidence_ref   TEXT,
  created_at     INTEGER NOT NULL,
  detected_at    INTEGER,
  fulfilled_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_events_target ON events (fish_id, target_id, at);
CREATE INDEX IF NOT EXISTS idx_matters_open ON matters (fish_id, target_id, status);
`

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec(SCHEMA)
  // 迁移：老库没有的列补上
  try {
    db.exec('ALTER TABLE events ADD COLUMN severity REAL NOT NULL DEFAULT 1')
  } catch (error) {
    /* 已经有了，忽略 */
  }
  return db
}

export function ensureObject(db, fishId, targetId, kind, name) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO objects (fish_id, target_id, kind, name, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (fish_id, target_id) DO UPDATE SET
       name = COALESCE(excluded.name, objects.name),
       updated_at = objects.updated_at`,
  ).run(fishId, targetId, kind || 'person', name || null, now)
  return db.prepare('SELECT * FROM objects WHERE fish_id = ? AND target_id = ?').get(fishId, targetId)
}

export function getObject(db, fishId, targetId) {
  return db.prepare('SELECT * FROM objects WHERE fish_id = ? AND target_id = ?').get(fishId, targetId)
}

export function listObjects(db, fishId, limit = 20) {
  return db
    .prepare('SELECT * FROM objects WHERE fish_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(fishId, limit)
}

export function updateObject(db, fishId, targetId, patch) {
  const cols = Object.keys(patch)
  if (!cols.length) return
  const set = cols.map((c) => `${c} = ?`).join(', ')
  db.prepare(`UPDATE objects SET ${set}, updated_at = ? WHERE fish_id = ? AND target_id = ?`).run(
    ...cols.map((c) => patch[c]),
    Date.now(),
    fishId,
    targetId,
  )
}

export function insertEvent(db, ev) {
  const now = Date.now()
  try {
    db.prepare(
      `INSERT INTO events
        (id, fish_id, target_id, kind, at, source, source_msg_ids, evidence, interpretation,
         severity, uncertainty, deltas, matter_id, dedup_key, committed, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ev.id,
      ev.fishId,
      ev.targetId,
      ev.kind,
      ev.at || now,
      ev.source,
      JSON.stringify(ev.sourceMsgIds || []),
      ev.evidence || '',
      ev.interpretation || '',
      Number(ev.severity) || 1,
      Number(ev.uncertainty) || 0,
      JSON.stringify(ev.deltas || {}),
      ev.matterId || null,
      ev.dedupKey,
      ev.committed ? 1 : 0,
      ev.expiresAt || 0,
      now,
    )
    return { ok: true, id: ev.id }
  } catch (error) {
    // UNIQUE 冲突 = 重复事件，当作正常情况吞掉
    if (String(error && error.message).includes('UNIQUE')) return { ok: false, duplicate: true }
    throw error
  }
}

export function commitEvent(db, id) {
  db.prepare('UPDATE events SET committed = 1 WHERE id = ?').run(id)
}

export function dropEvent(db, id, why) {
  db.prepare('UPDATE events SET committed = 0, interpretation = COALESCE(interpretation, ?) WHERE id = ?').run(
    why || null,
    id,
  )
}

export function openMatters(db, fishId, targetId) {
  return db
    .prepare(
      `SELECT * FROM matters WHERE fish_id = ? AND target_id = ? AND status = 'open'
       ORDER BY updated_at DESC`,
    )
    .all(fishId, targetId)
}

export function insertMatter(db, m) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO matters
      (id, fish_id, target_id, kind, reason, anger, anger_floor, status, disclosure, repair_stance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(
    m.id,
    m.fishId,
    m.targetId,
    m.kind,
    m.reason || '',
    Number(m.anger) || 0,
    Number(m.angerFloor) || 0,
    m.disclosure || 'unknown',
    m.repairStance || 'unknown',
    now,
    now,
  )
}

export function updateMatter(db, id, patch) {
  const cols = Object.keys(patch)
  if (!cols.length) return
  const set = cols.map((c) => `${c} = ?`).join(', ')
  db.prepare(`UPDATE matters SET ${set}, updated_at = ? WHERE id = ?`).run(
    ...cols.map((c) => patch[c]),
    Date.now(),
    id,
  )
}

export function recentEvents(db, fishId, targetId, limit = 10) {
  return db
    .prepare('SELECT * FROM events WHERE fish_id = ? AND target_id = ? ORDER BY at DESC LIMIT ?')
    .all(fishId, targetId, limit)
}

export function updateEventResult(db, id, deltas, severity) {
  try {
    db.prepare('UPDATE events SET deltas = ?, severity = ? WHERE id = ?').run(
      JSON.stringify(deltas || {}),
      Number(severity) || 1,
      id,
    )
  } catch (error) {}
}

export function recordSilence(db, o) {
  try {
    db.prepare(
      'INSERT OR IGNORE INTO silence_seen (episode_id, fish_id, target_id, stage, observed_at, matter_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(o.episodeId, o.fishId, o.targetId, o.stage || '', Number(o.observedAt) || Date.now(), o.matterId || null)
    return true
  } catch (error) {
    return false
  }
}

export function insertExpectation(db, e) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO expectations
      (id, fish_id, target_id, promisor_id, beneficiary_id, original_text, deadline_at, precision, status, evidence_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    e.id, e.fishId, e.targetId, e.promisorId || 'person:qq:<你的QQ号>', e.beneficiaryId || 'fish:default',
    e.originalText || '', e.deadlineAt || null, e.precision || 'vague', e.evidenceRef || '', now,
  )
  return e.id
}

export function pendingExpectations(db, fishId, targetId) {
  return db
    .prepare("SELECT * FROM expectations WHERE fish_id = ? AND target_id = ? AND status = 'pending' ORDER BY created_at")
    .all(fishId, targetId)
}

export function closeExpectation(db, id, status, at) {
  const now = at || Date.now()
  db.prepare('UPDATE expectations SET status = ?, detected_at = ?, fulfilled_at = ? WHERE id = ?').run(
    status, now, status === 'fulfilled' ? now : null, id,
  )
}
