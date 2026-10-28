// dsh-life · 条件事件
//
// 「什么会让她出不了门」：身体 / 环境 / 他人 / 临时事务 / 交通场所。
// 核心原则（和 Codex 定稿）：
//   · 判断对象是「此时去哪里、用什么方式、做多久」，不是给她贴"今天不能出门"
//   · 只有 life 改日程；条件只报告变化与限制
//   · 天气是预报，不是实测；失败写 unknown，不补造、不取消全天
//   · 生病默认关闭；熬夜/淋雨不直接推成感冒

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { 当前天气, 天气名, 风力名, 预览一年, 生成预览文本, 默认天气配置, 预设 } from './weather.js'
import { join } from 'node:path'

export const 默认条件配置 = {
  weatherEnabled: true,
  weatherLat: 30.60,
  weatherLon: 114.30,
  weatherCacheMinutes: 60,
  weatherStaleMinutes: 180,
  hotCautionC: 32,
  hotBlockC: 38,
  autoIllness: false,
  illnessDailyChance: 0.01,
  illnessMinGapDays: 30,
  illnessHours: [24, 48],
  weather: { ...默认天气配置 },
}

// 天气代码 → 粗分类（只做活动策略，不当气象等级）
export function 天气分类(code) {
  const c = Number(code)
  if (c === 0) return 'clear'
  if (c >= 1 && c <= 3) return 'cloudy'
  if (c === 45 || c === 48) return 'fog'
  if (c >= 51 && c <= 57) return 'drizzle'
  if (c >= 61 && c <= 65) return 'rain'
  if (c >= 66 && c <= 67) return 'freezing_rain'
  if (c >= 71 && c <= 77) return 'snow'
  if (c >= 80 && c <= 82) return 'showers'
  if (c >= 85 && c <= 86) return 'snow_showers'
  if (c >= 95) return 'thunder'
  return 'unknown'
}

const 强降水 = new Set(['rain', 'showers', 'thunder', 'freezing_rain', 'drizzle'])

// 虚拟天气：不再请求外部 API（见 weather.js）
export function 刷新天气(状态, cfg, now = Date.now()) {
  if (cfg.weatherEnabled === false) return 状态.weather || null
  try {
    const w = 当前天气(状态, cfg, now)
    状态.weather = w
    return w
  } catch (error) {
    状态.weather = {
      ok: false, fetchedAt: now, stale: false, current: null, hourly: [],
      error: String(error && error.message),
    }
    return 状态.weather
  }
}

// 天气 → 条件（可能为 null / unknown）
export function 天气条件(状态, cfg, now = Date.now()) {
  const w = 状态.weather
  if (!w || !w.current) {
    return {
      id: 'weather_unknown', category: 'environment', type: 'weather', origin: 'life_simulation', basis: 'simulated',
      severity: 'minor', status: 'unknown', validFrom: now, validUntil: now + 30 * 60000,
      constraints: { scope: 'outdoor', effect: 'shorten' },
      detail: '不知道外面天气怎么样',
    }
  }
  const c = w.current
  const 热 = Number(c.feels)
  if (Number.isFinite(热) && 热 >= (Number(cfg.hotBlockC) || 38)) {
    return {
      id: 'weather_hot', category: 'environment', type: 'weather', origin: 'life_simulation', basis: 'simulated',
      severity: 'major', status: 'active', validFrom: w.fetchedAt, validUntil: w.fetchedAt + 2 * 3600000,
      constraints: { scope: 'outdoor', effect: 'avoid' }, detail: '外面太热了（体感 ' + Math.round(热) + '℃）',
    }
  }
  if (Number.isFinite(热) && 热 >= (Number(cfg.hotCautionC) || 32)) {
    return {
      id: 'weather_warm', category: 'environment', type: 'weather', origin: 'life_simulation', basis: 'simulated',
      severity: 'minor', status: 'active', validFrom: w.fetchedAt, validUntil: w.fetchedAt + 2 * 3600000,
      constraints: { scope: 'outdoor', effect: 'shorten' }, detail: '有点热（体感 ' + Math.round(热) + '℃）',
    }
  }
  if (强降水.has(c.kind)) {
    const 重大 = c.kind === 'thunder' || (Number(c.precip) || 0) >= 12
    return {
      id: 'weather_rain', category: 'environment', type: 'weather', origin: 'life_simulation', basis: 'simulated',
      severity: 重大 ? 'major' : 'moderate', status: 'active',
      validFrom: w.fetchedAt, validUntil: w.fetchedAt + 2 * 3600000,
      constraints: { scope: 'outdoor', effect: 重大 ? 'avoid' : 'shorten' },
      detail: (c.realKind === 'storm' ? '外面在打雷下雨' : c.realKind === 'drizzle' ? '外面在下小雨' : '外面在下大雨'),
    }
  }
  // 现在是干的，但下一个时段要下雨 → 只说"可能"
  if (['drizzle', 'rain', 'storm'].includes(String(w.nextKind || ''))) {
    return {
      id: 'weather_prob', category: 'environment', type: 'weather', origin: 'life_simulation', basis: 'simulated',
      severity: 'minor', status: 'active', validFrom: now, validUntil: now + 90 * 60000,
      constraints: { scope: 'outdoor', effect: 'shorten' },
      detail: '过会儿可能会下雨（' + (w.nextName || '雨') + '）',
    }
  }

  // 现在没下，但两小时内降水概率高 → 只作"可能"，不是"已经下了"
  try {
    const 未来 = (w.hourly || []).filter((h) => h.at >= now - 1800000 && h.at <= now + 2 * 3600000)
    const 最高 = 未来.reduce((m, h) => Math.max(m, Number(h.pop) || 0), 0)
    if (最高 >= 60) {
      return {
        id: 'weather_prob', category: 'environment', type: 'weather', origin: 'life_simulation', basis: 'simulated',
        severity: 'minor', status: 'active', validFrom: now, validUntil: now + 90 * 60000,
        constraints: { scope: 'outdoor', effect: 'shorten' },
        detail: '过会儿可能会下雨（降水概率 ' + 最高 + '%）',
      }
    }
  } catch (error) {}
  return null
}

// 当前所有生效条件 = 已存条件 + 天气
export function 生效条件(状态, cfg, now = Date.now()) {
  const 存 = (状态.conditions || []).filter(
    (c) => c.status === 'active' && Number(c.validFrom || 0) <= now && now < Number(c.validUntil || Infinity),
  )
  const w = 天气条件(状态, cfg, now)
  return w ? [...存, w] : 存
}

// 作用范围匹配
function 命中范围(scope, activity) {
  if (!scope || scope === 'all') return true
  if (scope === 'outdoor') return Boolean(activity.outdoor)
  if (scope === 'commute') return activity.kind === 'commute'
  if (scope === 'social') return activity.kind === 'social'
  return true
}

// 统一判定入口
export function 评估活动(状态, cfg, activity, now = Date.now()) {
  const 条件 = 生效条件(状态, cfg, now)
  const reasons = []
  let decision = 'allow'
  const adjustments = []
  const alternatives = []

  for (const c of 条件) {
    if (!命中范围(c.constraints && c.constraints.scope, activity)) continue
    if (c.status === 'unknown') {
      reasons.push({ conditionId: c.id, category: c.category, effect: 'unknown', severity: c.severity, basis: c.basis, confidence: 0.4 })
      if (decision === 'allow') decision = 'unknown'
      continue
    }
    const effect = (c.constraints && c.constraints.effect) || 'shorten'
    reasons.push({ conditionId: c.id, category: c.category, effect, severity: c.severity, basis: c.basis, confidence: 0.9 })
    if (effect === 'avoid') {
      decision = 'blocked'
      alternatives.push('改成室内活动')
    } else if (effect === 'shorten') {
      if (decision !== 'blocked') decision = 'caution'
      adjustments.push('缩短到 20 分钟')
    } else if (effect === 'reschedule') {
      if (decision !== 'blocked') decision = 'caution'
      adjustments.push('换个时间')
    }
  }

  return {
    decision,
    scope: activity.title || '这次活动',
    validUntil: now + 30 * 60000,
    reasons,
    adjustments,
    alternatives,
  }
}

// 手动设置条件（生病 / 不适 / 解除）
export function 设置条件(状态, 输入, now = Date.now()) {
  const 秒 = 3600000
  const id = String(输入.id || 'cond_' + now)
  const 已有 = (状态.conditions || []).find((c) => c.id === id)
  if (输入.remove) {
    if (已有) {
      已有.status = 'removed'
      已有.validUntil = now
    }
    return { ok: true, removed: true, id }
  }
  const 条件 = {
    id,
    category: 输入.category || 'body',
    type: 输入.type || 'illness',
    origin: 输入.origin || 'life_simulation',
    basis: 输入.basis || 'declared',
    severity: 输入.severity || 'moderate',
    validFrom: Number(输入.validFrom) || now,
    validUntil: Number(输入.validUntil) || now + (Number(输入.hours) || 24) * 秒,
    constraints: 输入.constraints || { scope: 输入.scope || 'outdoor', effect: 输入.effect || 'shorten' },
    sourceRef: 输入.sourceRef || 'manual',
    status: 'active',
    detail: 输入.detail || (输入.type === 'illness' ? '身体不太舒服' : ''),
  }
  if (已有) Object.assign(已有, 条件)
  else {
    状态.conditions = 状态.conditions || []
    状态.conditions.push(条件)
    状态.conditions = 状态.conditions.slice(-50)
  }
  return { ok: true, condition: 条件 }
}

// 跨天结转：昨天的生病/淋雨 → 今天的身体状态（幂等，只结一次）
export function 跨天结转(状态, now = Date.now()) {
  const 今天 = new Date(now)
  const dayKey = 今天.getFullYear() + '-' + String(今天.getMonth() + 1).padStart(2, '0') + '-' + String(今天.getDate()).padStart(2, '0')
  状态.carriedDays = 状态.carriedDays || []
  if (状态.carriedDays.includes(dayKey)) return { ok: true, skipped: true }
  状态.carriedDays = [...状态.carriedDays.slice(-30), dayKey]
  const 新 = []
  const 昨天的 = (状态.conditions || []).filter((c) => c.status === 'active' && Number(c.validFrom) < now - 6 * 3600000)
  for (const c of 昨天的) {
    if (c.category !== 'body') continue
    // 还没恢复的病 → 今天继续（但只延到原 validUntil，不无限续）
    if (Number(c.validUntil) > now) continue
    新.push({
      id: 'carry_' + dayKey + '_' + c.type,
      category: 'body',
      type: c.type === 'illness' ? 'recovering' : 'tired',
      origin: c.origin,
      basis: 'declared',
      severity: 'minor',
      validFrom: now,
      validUntil: now + 12 * 3600000,
      constraints: { scope: 'outdoor', effect: 'shorten' },
      sourceRef: c.id,
      status: 'active',
      detail: '昨天' + (c.type === 'illness' ? '生病' : '不太舒服') + '，今天还有点没缓过来',
      carriedFrom: c.id,
    })
  }
  if (新.length) 状态.conditions = [...(状态.conditions || []), ...新].slice(-50)
  return { ok: true, carried: 新.length }
}

// 往 mood/inbox 写一条事实（correlationId 去重）
export function 写心情(家, 状态, payload) {
  try {
    const key = String(payload.correlationId || payload.reason || '')
    if (!key) return false
    状态.moodSent = 状态.moodSent || []
    if (状态.moodSent.includes(key)) return false
    状态.moodSent = [...状态.moodSent.slice(-200), key]
    mkdirSync(join(家, 'mood'), { recursive: true })
    appendFileSync(
      join(家, 'mood', 'inbox.jsonl'),
      JSON.stringify({ id: 'cond_' + Date.now(), at: Date.now(), source: 'life', kind: payload.kind || 'condition', moodDelta: 0, reason: payload.reason }) + '\n',
      'utf8',
    )
    return true
  } catch (error) {
    return false
  }
}
