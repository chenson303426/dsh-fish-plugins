// dsh-desire · 纯逻辑（可单独测试，不依赖宿主）
//
// 边界（写进 README）：
//   欲望：我现在想得到或做什么？
//   mood：我现在感觉怎样？
//   feeling：我对谁什么态度、什么事还挂着？
//   life：我最终安排并经历了什么？

import { createHash } from 'node:crypto'

export const NEEDS = ['recovery', 'autonomy', 'competence', 'connection', 'novelty', 'enjoyment', 'expression']

export const NEED_LABELS = {
  recovery: '恢复',
  autonomy: '自主',
  competence: '胜任',
  connection: '联结',
  novelty: '探索',
  enjoyment: '享受',
  expression: '表达',
}

export const BASE = 20 // 所有需要从 20 起步；高于 20 的部分才会衰减
export const MAX_NEED = 100
export const TIME_CAP = 60 // 纯时间累积最多推到 60

const 半天 = 12 * 3600000

export function defaultState(now = Date.now()) {
  const needs = {}
  for (const k of NEEDS) needs[k] = BASE
  return {
    needs,
    desires: [],
    sleeping: false,
    lastWakeAt: 0,
    lastTickAt: now,
    dayKey: dayKeyOf(now),
    dayCounters: { novelty: 0, enjoyment: 0 },
    seq: 0,
  }
}

export function dayKeyOf(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function 夹(v, lo = 0, hi = MAX_NEED) {
  return Math.max(lo, Math.min(hi, v))
}

// 高于 base 的部分按半衰期衰减
function 衰减超额(value, hours, halfHours, base = BASE) {
  if (value <= base) return value
  return base + (value - base) * Math.pow(0.5, hours / halfHours)
}

// 时间推进：只按有效区间积分；睡眠不计 novelty/connection/enjoyment
export function advanceNeeds(state, { from, to, asleep = false, working = false, workMinutesToday = 0 }) {
  const now = Number(to)
  const 起始 = Number.isFinite(Number(from)) ? Number(from) : now
  let hours = (now - 起始) / 3600000
  if (!(hours > 0)) return state
  hours = Math.min(hours, 24) // 单次推进最多 24 小时，避免离线暴涨

  const 今日 = dayKeyOf(now)
  if (state.dayKey !== 今日) {
    state.dayKey = 今日
    state.dayCounters = { novelty: 0, enjoyment: 0 }
  }

  // 睡眠→醒来的那一下，恢复 −10（一次，不按小时重复）
  if (state.sleeping && !asleep) {
    state.needs.recovery = 夹(state.needs.recovery - 10)
    state.sleeping = false
    state.lastWakeAt = now
  }
  if (asleep) state.sleeping = true

  if (!asleep) {
    // 恢复：工作/投入 +2/h（高负荷 +4/h），休息 −6/h
    if (working) {
      const 速率 = workMinutesToday >= 8 * 60 ? 4 : 2
      state.needs.recovery = Math.min(TIME_CAP, 夹(state.needs.recovery + 速率 * hours))
      // 享受：连续工作 +1/h，每天最多 +4
      const 可加 = Math.max(0, 4 - (state.dayCounters.enjoyment || 0))
      const 加 = Math.min(可加, 1 * hours)
      if (加 > 0) {
        state.needs.enjoyment = Math.min(TIME_CAP, 夹(state.needs.enjoyment + 加))
        state.dayCounters.enjoyment = (state.dayCounters.enjoyment || 0) + 加
      }
    } else {
      state.needs.recovery = 夹(state.needs.recovery - 6 * hours)
      // 探索：清醒空闲 +0.5/h，每天最多 +3
      const 可加 = Math.max(0, 3 - (state.dayCounters.novelty || 0))
      const 加 = Math.min(可加, 0.5 * hours)
      if (加 > 0) {
        state.needs.novelty = Math.min(TIME_CAP, 夹(state.needs.novelty + 加))
        state.dayCounters.novelty = (state.dayCounters.novelty || 0) + 加
      }
    }
  }

  // 不自动上涨的四维：只衰减超额部分
  state.needs.autonomy = 夹(衰减超额(state.needs.autonomy, hours, 24))
  state.needs.competence = 夹(衰减超额(state.needs.competence, hours, 48))
  state.needs.connection = 夹(衰减超额(state.needs.connection, hours, 24))
  state.needs.expression = 夹(衰减超额(state.needs.expression, hours, 48))

  state.lastTickAt = now
  return state
}

// 单个普通事件 ±10 封顶
export function nudgeNeed(state, key, delta, reason) {
  if (!NEEDS.includes(key)) return state
  const 值 = Math.max(-10, Math.min(10, Number(delta) || 0))
  state.needs[key] = 夹((state.needs[key] || BASE) + 值)
  return state
}

let 去重表 = new Set()
export function resetDedupe() {
  去重表 = new Set()
}

function 新id(prefix, seed) {
  const h = createHash('sha1').update(String(seed) + '|' + Math.random()).digest('hex').slice(0, 10)
  return prefix + '_' + h
}

export function activeDesires(state, now = Date.now()) {
  return (state.desires || []).filter(
    (d) => ['active', 'scheduled', 'pursuing'].includes(d.status) && !(d.validUntil && d.validUntil < now),
  )
}

export function expireDesires(state, now = Date.now()) {
  for (const d of state.desires || []) {
    if (['active', 'scheduled', 'pursuing'].includes(d.status) && d.validUntil && d.validUntil < now) {
      d.status = 'expired'
      d.updatedAt = now
    }
  }
  return state
}

export function addDesire(state, input, now = Date.now(), maxActive = 3) {
  const 已有 = activeDesires(state, now)
  if (已有.length >= maxActive) return { ok: false, reason: 'active_limit' }
  const goal = String(input.goal || '').trim()
  if (!goal) return { ok: false, reason: 'empty_goal' }
  if (已有.some((d) => d.goal === goal)) return { ok: false, reason: 'duplicate' }
  const d = {
    id: 新id('desire', goal + now),
    goal: goal.slice(0, 80),
    objectId: input.objectId || null,
    needWeights: input.needWeights || {},
    strength: Math.max(0, Math.min(100, Number(input.strength) || 50)),
    importance: input.importance || 'normal',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    validUntil: input.validUntil || now + 24 * 3600000,
    sourceEventIds: input.sourceEventIds || [],
    progress: 0,
    planId: null,
  }
  state.desires = (state.desires || []).concat(d).slice(-50)
  return { ok: true, desire: d }
}

export function linkPlan(state, { desireId, planId, expectedOutcome }, now = Date.now()) {
  const d = (state.desires || []).find((x) => x.id === desireId)
  if (!d) return { ok: false, reason: 'not_found' }
  d.planId = planId || null
  d.status = 'scheduled'
  d.updatedAt = now
  d.expectedOutcome = expectedOutcome || null
  return { ok: true, desire: d }
}

// 结果回填：completed 才满足；interrupted 只保留实际进度
export function applyOutcome(state, { activityId, objectId, result, title }, now = Date.now()) {
  const key = 'outcome|' + (activityId || title || '') + '|' + result
  if (去重表.has(key)) return { ok: true, duplicate: true }
  去重表.add(key)

  const d = (state.desires || []).find(
    (x) => ['scheduled', 'pursuing', 'active'].includes(x.status) && (x.objectId && objectId ? x.objectId === objectId : true),
  )

  if (result === 'completed') {
    if (d) {
      d.progress = 1
      d.status = 'satisfied'
      d.updatedAt = now
    }
    // 完成带来的满足（读取类：胜任 + 探索）
    nudgeNeed(state, 'competence', -8)
    nudgeNeed(state, 'novelty', -6)
    return { ok: true, desire: d || null, needs: { competence: state.needs.competence, novelty: state.needs.novelty } }
  }
  if (result === 'interrupted') {
    if (d) {
      d.progress = Math.min(0.9, (d.progress || 0) + 0.5)
      d.status = 'pursuing'
      d.updatedAt = now
    }
    nudgeNeed(state, 'competence', -3)
    return { ok: true, desire: d || null }
  }
  // skipped：不动进度，也不扣分
  return { ok: true, desire: d || null }
}

// 候选打分：needFit 来自关键词映射，goalFit 来自与活跃欲求的字面重合
const 关键词 = {
  recovery: ['休息', '躺', '睡', '发呆', '洗澡', '放松', '缓'],
  competence: ['读', '学', '练', '写', '做', '完成', '整理', '工作'],
  connection: ['聊', '一起', '约', '朋友', '同伴', '分享'],
  novelty: ['新', '逛', '试', '发现', '出门', '探索', '换'],
  enjoyment: ['吃', '游戏', '剧', '电影', '玩', '甜', '咖啡', '奶茶'],
  expression: ['写', '画', '拍', '记录', '整理', '布置'],
  autonomy: ['自己', '随便', '想'],
}

function 字面重合(a, b) {
  const A = new Set(String(a).split(''))
  const B = new Set(String(b).split(''))
  let 同 = 0
  for (const c of A) if (B.has(c)) 同 += 1
  return A.size ? 同 / A.size : 0
}

export function scoreCandidates(state, candidates, now = Date.now()) {
  const 活跃 = activeDesires(state, now)
  return (candidates || []).map((c) => {
    const title = String(c.title || '')
    const 命中 = {}
    for (const [need, words] of Object.entries(关键词)) {
      if (words.some((w) => title.includes(w))) 命中[need] = (命中[need] || 0) + 1
    }
    const 键 = Object.keys(命中)
    const needFit = 键.length
      ? 键.reduce((s, k) => s + (state.needs[k] || BASE) / MAX_NEED, 0) / 键.length
      : 0.3
    let goalFit = 0
    let reasonIds = []
    for (const d of 活跃) {
      const 重 = 字面重合(title, d.goal)
      if (重 > goalFit) {
        goalFit = 重
        reasonIds = [d.id]
      }
    }
    return {
      title,
      kind: c.kind || '',
      needFit: Math.round(needFit * 100) / 100,
      goalFit: Math.round(goalFit * 100) / 100,
      reasonIds,
      needs: 键,
    }
  })
}

// 注入：只给一个最相关的欲求，一行 ≤60 字
export function renderDesire(state, now = Date.now()) {
  const 活跃 = activeDesires(state, now)
  if (!活跃.length) return ''
  const top = 活跃.slice().sort((a, b) => (b.strength || 0) - (a.strength || 0))[0]
  let goal = String(top.goal || '').trim()
  if (goal.length > 50) goal = goal.slice(0, 50) + '…'
  return '【想做】' + goal
}
