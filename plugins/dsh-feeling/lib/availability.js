// dsh-feeling · availability（作息与可用性）
//
// 一个模块回答四个问题：
//   她现在是什么状态（睡 / 午睡 / 小睡 / 清醒）
//   阿元预计在不在（上班 / 夜里 / 午睡）
//   这段时间能不能累计"等待"
//   现在能不能主动搭话
//
// 关键规则（阿元定的）：
//   · 聊天中不会入睡——只有沉默够久，窗口内的睡眠才真的开始
//   · 睡着期间不回消息（由桥接/上层决定怎么排）
//   · 醒来不补投骰子，只安排下一次机会
//
// 数据分两层：规则（用户可改）与当天生成的区间（随机小睡落成绝对时间，当天固定）

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

export const 默认规则 = {
  timezone: 'Asia/Shanghai',
  rulesVersion: 1,
  onsetSilenceMinutes: 20, // 沉默多久才真的睡着
  actors: {
    'fish:default': {
      rules: [
        { id: 'fish-night', kind: 'sleep', start: '23:30', end: '08:00', enabled: true },
        { id: 'fish-noon', kind: 'nap', start: '13:00', end: '13:30', enabled: true },
        {
          id: 'fish-doze',
          kind: 'random_nap',
          enabled: true,
          startRange: ['14:30', '16:30'],
          durationMinutes: [10, 25],
          probability: 0.2,
          maxPerDay: 1,
        },
      ],
    },
    'person:qq:<你的QQ号>': {
      rules: [
        { id: 'owner-night', kind: 'sleep', start: '00:30', end: '08:30', enabled: true },
        { id: 'owner-work', kind: 'work', enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
        { id: 'owner-nap', kind: 'nap', enabled: false, start: '13:00', end: '13:40' },
      ],
    },
  },
}

// 字符串 → 32 位种子（mulberry32）
function 种子(s) {
  const h = createHash('sha1').update(String(s)).digest()
  return h.readUInt32BE(0)
}
function 随机(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function 日键(d) {
  const x = new Date(d)
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')
}

function 时刻(dayKey, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  const [y, mo, d] = dayKey.split('-').map(Number)
  return new Date(y, mo - 1, d, h || 0, m || 0, 0, 0).getTime()
}

// 展开某一天的固定区间（含跨午夜）
function 展开固定(actorId, dayKey, rule) {
  if (rule.enabled === false) return []
  if (rule.kind === 'random_nap') return []
  const 起 = 时刻(dayKey, rule.start)
  let 止 = 时刻(dayKey, rule.end)
  if (止 <= 起) 止 += 24 * 3600 * 1000 // 跨午夜
  return [{ actorId, ruleId: rule.id, kind: rule.kind, startAt: 起, endAt: 止, basis: 'configured' }]
}

// 随机小睡：按 日期+鱼+规则+版本 确定性生成候选
function 生成小睡(actorId, dayKey, rule) {
  if (rule.enabled === false) return []
  const rnd = 随机(种子(`${actorId}|${dayKey}|${rule.id}|${rule.rulesVersion || 1}|nap`))
  if (rnd() > Number(rule.probability ?? 0.2)) return []
  const [a, b] = rule.startRange || ['14:30', '16:30']
  const A = 时刻(dayKey, a)
  const B = 时刻(dayKey, b)
  if (B <= A) return []
  const start = A + Math.floor(rnd() * (B - A) / 60000) * 60000
  const [lo, hi] = rule.durationMinutes || [10, 25]
  const dur = Math.round(lo + rnd() * Math.max(0, hi - lo))
  return [
    {
      actorId,
      ruleId: rule.id,
      kind: 'random_nap',
      startAt: start,
      endAt: start + dur * 60000,
      basis: 'simulated_schedule',
    },
  ]
}

export function loadAvailability(file, rules) {
  const 配置 = rules || 默认规则
  let 数据 = { 配置版本: 配置.rulesVersion || 1, days: {}, sleepLog: [], openSleep: null, lastActivityAt: 0 }
  try {
    if (existsSync(file)) 数据 = { ...数据, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {}
  return 数据
}

export function saveAvailability(file, 数据) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(数据, null, 2), 'utf8')
  } catch (error) {}
}

// 确保这一天的区间已生成（随机结果当天固定）
export function ensureDay(数据, 配置, dayKey) {
  if (数据.days[dayKey]) return 数据.days[dayKey]
  const 区间 = []
  for (const [actorId, actor] of Object.entries((配置.actors || {}))) {
    const rules = (actor && actor.rules) || []
    // 跨午夜的前一天区间也要算（查凌晨时要能命中）
    for (const r of rules) 区间.push(...展开固定(actorId, dayKey, r))
    for (const r of rules) 区间.push(...生成小睡(actorId, dayKey, r))
  }
  // 前一天跨午夜的睡眠段，补进来（只补跨夜的）
  const 昨 = 日键(new Date(时刻(dayKey, '00:00') - 24 * 3600 * 1000))
  for (const [actorId, actor] of Object.entries((配置.actors || {}))) {
    for (const r of (actor && actor.rules) || []) {
      if (r.enabled === false || r.kind === 'random_nap') continue
      const 起 = 时刻(昨, r.start)
      const 止 = 时刻(昨, r.end)
      if (止 <= 起) {
        const 真实止 = 止 + 24 * 3600 * 1000
        if (真实止 > 时刻(dayKey, '00:00')) {
          区间.push({ actorId, ruleId: r.id, kind: r.kind, startAt: 起, endAt: 真实止, basis: 'configured' })
        }
      }
    }
  }
  数据.days[dayKey] = 区间
  // 只留最近 14 天
  const keys = Object.keys(数据.days).sort()
  for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete 数据.days[k]
  return 区间
}

// 某时刻某人的活动状态（不考虑"是否真的睡着"，那是状态机）
export function activityAt(数据, 配置, actorId, at) {
  const dayKey = 日键(new Date(at))
  ensureDay(数据, 配置, dayKey)
  const 昨 = 日键(new Date(at - 24 * 3600 * 1000))
  const 是否在 = (iv) => at >= iv.startAt && at < iv.endAt
  for (const dk of [dayKey, 昨]) {
    for (const iv of 数据.days[dk] || []) {
      if (iv.actorId !== actorId) continue
      if (是否在(iv)) return iv
    }
  }
  return null
}

// 区间并集覆盖的毫秒数（避免重叠重复扣）
export function coveredMs(数据, 配置, actorIds, from, to) {
  if (!from || !to || to <= from) return 0
  const 段 = []
  for (let d = 时刻(日键(new Date(from)), '00:00') - 24 * 3600 * 1000; d <= to; d += 24 * 3600 * 1000) {
    const dayKey = 日键(new Date(d))
    ensureDay(数据, 配置, dayKey)
    for (const iv of 数据.days[dayKey] || []) {
      if (!actorIds.includes(iv.actorId)) continue
      const a = Math.max(from, iv.startAt)
      const b = Math.min(to, iv.endAt)
      if (b > a) 段.push([a, b])
    }
  }
  段.sort((x, y) => x[0] - y[0])
  let 总 = 0
  let cur = null
  for (const [a, b] of 段) {
    if (!cur) cur = [a, b]
    else if (a <= cur[1]) cur[1] = Math.max(cur[1], b)
    else {
      总 += cur[1] - cur[0]
      cur = [a, b]
    }
  }
  if (cur) 总 += cur[1] - cur[0]
  return 总
}

// 是否真的在睡：在睡眠区间内 + 沉默够久（聊天中不会入睡）
export function isAsleep(数据, 配置, actorId, at) {
  const iv = activityAt(数据, 配置, actorId, at)
  if (!iv) return { asleep: false, interval: null }
  if (iv.kind !== 'sleep' && iv.kind !== 'nap' && iv.kind !== 'random_nap') return { asleep: false, interval: iv }
  const onset = (Number(配置.onsetSilenceMinutes) || 20) * 60000
  const 静默 = at - (Number(数据.lastActivityAt) || 0)
  return { asleep: 静默 >= onset, interval: iv, silenceMs: 静默 }
}

// 睡眠记录：进入/离开时各写一条（她去睡觉、她醒了）
export function tickSleepLog(数据, 配置, actorId, at) {
  const r = isAsleep(数据, 配置, actorId, at)
  const 开 = 数据.openSleep
  if (r.asleep && (!开 || 开.actorId !== actorId)) {
    数据.openSleep = { actorId, ruleId: r.interval.ruleId, kind: r.interval.kind, startAt: at }
    return { event: 'sleep', at, kind: r.interval.kind }
  }
  if (!r.asleep && 开 && 开.actorId === actorId) {
    数据.sleepLog.push({ ...开, endAt: at, minutes: Math.round((at - 开.startAt) / 60000) })
    数据.sleepLog = 数据.sleepLog.slice(-50)
    数据.openSleep = null
    数据.lastWakeAt = at
    数据.lastWakeMinutes = Math.round((at - 开.startAt) / 60000)
    数据.lastWakeKind = 开.kind
    return { event: 'wake', at, minutes: Math.round((at - 开.startAt) / 60000), kind: 开.kind }
  }
  return null
}

// 给注入用：今天睡了几次、几点到几点
export function renderSleepLog(数据, at) {
  const dayKey = 日键(new Date(at))
  const 今天 = 数据.sleepLog.filter((s) => 日键(new Date(s.startAt)) === dayKey)
  if (!今天.length) return ''
  const 描述 = 今天
    .map((s) => {
      const a = new Date(s.startAt)
      const b = new Date(s.endAt)
      const f = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      const 名 = s.kind === 'nap' ? '午睡' : s.kind === 'random_nap' ? '眯了一会儿' : '睡'
      return `${f(a)}–${f(b)} ${名}`
    })
    .join('，')
  return `【今天的睡眠】${描述}（共 ${今天.length} 次）`
}
