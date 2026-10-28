// dsh-life · 虚拟天气引擎
//
// 不用真实 API：一套完全可复现的"模拟世界天气"。
//   · 每 3 小时一个时段，8 种主天气，持续型马尔可夫链
//     P(j|i) = p·(i==j) + (1-p)·π[j]
//   · 风力独立（不占天气槽），也是持续型转移
//   · 温度 = 年均温 + 季节振幅×年周期 + 当日异常 + 日温振幅×cos(2π(hour-15)/24)
//   · 种子与 fishId 无关：同城市的多条鱼看到同一天气
//   · 生成过的时段落库，懒推进补算；改配置只影响未来时段
//
// 这是「模拟天气」，不是真实气象。注入/文案里只能说"预计/她那边"，不能说实测。

import { createHash } from 'node:crypto'

export const 天气种类 = ['clear', 'cloudy', 'overcast', 'drizzle', 'rain', 'storm', 'snow', 'fog']
export const 天气名 = {
  clear: '晴',
  cloudy: '多云',
  overcast: '阴',
  drizzle: '小雨',
  rain: '大雨',
  storm: '雷暴',
  snow: '雪',
  fog: '雾',
}
export const 风力种类 = ['breeze', 'moderate', 'strong', 'gale']
export const 风力名 = { breeze: '微风', moderate: '和风', strong: '强风', gale: '大风' }

export const 预设 = {
  多雨: {
    weights: { clear: 12, cloudy: 18, overcast: 22, drizzle: 25, rain: 14, storm: 4, snow: 1, fog: 4 },
    persistence: 0.75, annualTemp: 17, seasonalAmp: 8, diurnalAmp: 3,
    windWeights: { breeze: 60, moderate: 30, strong: 9, gale: 1 },
  },
  多风: {
    weights: { clear: 25, cloudy: 25, overcast: 20, drizzle: 10, rain: 8, storm: 3, snow: 4, fog: 5 },
    persistence: 0.6, annualTemp: 12, seasonalAmp: 12, diurnalAmp: 5,
    windWeights: { breeze: 25, moderate: 40, strong: 30, gale: 5 },
  },
  四季分明: {
    weights: { clear: 25, cloudy: 25, overcast: 20, drizzle: 12, rain: 8, storm: 3, snow: 3, fog: 4 },
    persistence: 0.65, annualTemp: 14, seasonalAmp: 15, diurnalAmp: 5,
    windWeights: { breeze: 60, moderate: 30, strong: 9, gale: 1 },
  },
  干燥: {
    weights: { clear: 45, cloudy: 30, overcast: 15, drizzle: 5, rain: 2, storm: 1, snow: 1, fog: 1 },
    persistence: 0.75, annualTemp: 18, seasonalAmp: 12, diurnalAmp: 8,
    windWeights: { breeze: 60, moderate: 30, strong: 9, gale: 1 },
  },
}

export const 默认天气配置 = {
  preset: '四季分明',
  ...预设['四季分明'],
  cityId: 'city:default',
  worldSeed: 'fish-world',
  slotHours: 3,
  generatorVersion: 1,
}

// 配置规范：允许传整个 life 配置（cfg.weather），也允许直接传天气配置
function 规范(cfg) {
  if (cfg && cfg.weather) return { ...默认天气配置, ...cfg.weather }
  return { ...默认天气配置, ...(cfg || {}) }
}

// ---------- 随机 ----------
function 哈希种子(s) {
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
function 种子字符串(cfg, purpose, extra) {
  return [
    cfg.worldSeed || 'fish-world',
    cfg.cityId || 'city:default',
    cfg.generatorVersion || 1,
    cfg.configVersion || 1,
    extra,
    purpose,
  ].join('|')
}

function 本地日起点(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function 日序号(t) {
  return Math.floor(本地日起点(t) / 86400000)
}
function 是一年第几天(t) {
  const d = new Date(t)
  const 初 = new Date(d.getFullYear(), 0, 1).getTime()
  return Math.floor((d.getTime() - 初) / 86400000) + 1
}
function 时段起点(t, slotHours) {
  const h = Number(slotHours) || 3
  return Math.floor(t / (h * 3600000)) * h * 3600000
}

// ---------- 温度 ----------
function 当日异常(cfg, dayIdx) {
  // 0.85 前值 + 噪声，限 ±5；按天确定性
  let v = 0
  const rnd = 随机(哈希种子(种子字符串(cfg, 'anomaly-base', 'day0')))
  // 从固定基准日推到这个 dayIdx，成本可接受（按日线性，最多几百天）
  const 基准 = Math.min(dayIdx, dayIdx) - 60
  let cur = 0
  const r = 随机(哈希种子(种子字符串(cfg, 'anomaly-seed', String(dayIdx))))
  // 用当天独立种子做一次平滑：0.85 衰减叠加 3 层噪声，效果接近 AR(1) 且无需历史
  for (let k = 0; k < 3; k++) {
    const n = (r() * 3) - 1.5
    cur = 0.85 * cur + n
  }
  v = Math.max(-5, Math.min(5, cur))
  return v
}

export function 温度(原始cfg, at) {
  const cfg = 规范(原始cfg)
  const 年均 = Number(cfg.annualTemp ?? 14)
  const 季节 = Number(cfg.seasonalAmp ?? 15)
  const 日幅 = Number(cfg.diurnalAmp ?? 5)
  const day = 是一年第几天(at)
  // 7 月中（第 196 天）最热
  const 年周期 = -Math.cos((2 * Math.PI * (day - 196)) / 365)
  const d = new Date(at)
  const hour = d.getHours() + d.getMinutes() / 60
  const 日周期 = Math.cos((2 * Math.PI * (hour - 15)) / 24)
  const 异常 = 当日异常(cfg, 日序号(at))
  return 年均 + 季节 * 年周期 + 异常 + 日幅 * 日周期
}

// ---------- 转移 ----------
function 归一化(对象, 允许键) {
  const 源 = 对象 || {}
  const 键 = 允许键 || Object.keys(源)
  let 总 = 0
  for (const k of 键) 总 += Math.max(0, Number(源[k]) || 0)
  if (总 <= 0) {
    const 均 = {}
    for (const k of 键) 均[k] = 1 / 键.length
    return 均
  }
  const out = {}
  for (const k of 键) out[k] = Math.max(0, Number(源[k]) || 0) / 总
  return out
}

function 按温度筛选(分布, temp) {
  const 副本 = { ...分布 }
  if (temp > 2) 副本.snow = 0
  if (temp < 10) 副本.storm = 0
  const 总 = Object.values(副本).reduce((a, b) => a + b, 0)
  if (总 <= 0) return { overcast: 1 }
  const out = {}
  for (const k of Object.keys(副本)) out[k] = 副本[k] / 总
  return out
}

function 抽样(分布, rnd) {
  const r = rnd()
  let acc = 0
  for (const [k, v] of Object.entries(分布)) {
    acc += v
    if (r <= acc) return k
  }
  const keys = Object.keys(分布)
  return keys[keys.length - 1]
}

// 下一步：P(j|i) = p·(i==j) + (1-p)·π[j]
function 下一步(当前, 基础分布, persistence, rnd, temp) {
  const p = Math.max(0, Math.min(0.95, Number(persistence) || 0.65))
  const 筛后 = 按温度筛选(基础分布, temp)
  const 分布 = {}
  for (const k of Object.keys(筛后)) {
    分布[k] = (k === 当前 ? p : 0) + (1 - p) * 筛后[k]
  }
  return 抽样(分布, rnd)
}

// ---------- 时段生成 ----------
export function 确保时段(状态, 原始cfg, now = Date.now()) {
  const cfg = 规范(原始cfg)
  if (!状态.weatherEngine) 状态.weatherEngine = { slots: [] }
  const 引擎 = 状态.weatherEngine
  const 时段长 = (Number(cfg.slotHours) || 3) * 3600000
  const 目标 = 时段起点(now, Number(cfg.slotHours) || 3)
  const 已有 = new Map(引擎.slots.map((s) => [s.startAt, s]))

  // 找最后一个已知时段，作为链条起点；没有就从目标前一格开始
  let 游标 = 引擎.slots.length ? Math.max(...引擎.slots.map((s) => s.startAt)) : 目标 - 时段长
  if (!引擎.slots.length) {
    // 初始化 24 小时前，保证有上下文
    游标 = 目标 - 8 * 时段长
  }
  const 权重 = 归一化(cfg.weights, 天气种类)
  const 风权重 = 归一化(cfg.windWeights, 风力种类)

  let 上一类 = null
  let 上一风 = null
  for (const s of 引擎.slots.slice().sort((a, b) => a.startAt - b.startAt)) {
    上一类 = s.kind
    上一风 = s.wind
  }

  let 保护 = 0
  while (游标 < 目标 + 时段长 && 保护 < 4000) {
    游标 += 时段长
    保护++
    if (已有.has(游标)) {
      const s = 已有.get(游标)
      上一类 = s.kind
      上一风 = s.wind
      continue
    }
    const t = 温度(cfg, 游标)
    const r1 = 随机(哈希种子(种子字符串(cfg, 'weather', String(游标))))
    const 类 = 上一类 ? 下一步(上一类, 权重, cfg.persistence, r1, t) : 抽样(按温度筛选(权重, t), r1)
    const r2 = 随机(哈希种子(种子字符串(cfg, 'wind', String(游标))))
    const 风 = 上一风 ? 下一步(上一风, 风权重, cfg.windPersistence ?? 0.7, r2, 999) : 抽样(风权重, r2)
    const 时段 = { startAt: 游标, endAt: 游标 + 时段长, kind: 类, wind: 风, temp: Math.round(t * 10) / 10 }
    引擎.slots.push(时段)
    已有.set(游标, 时段)
    上一类 = 类
    上一风 = 风
  }
  // 只留最近 15 天
  const 最早 = 目标 - 15 * 24 * 3600000
  引擎.slots = 引擎.slots.filter((s) => s.endAt >= 最早).sort((a, b) => a.startAt - b.startAt)
  return 引擎
}

export function 当前天气(状态, 原始cfg, now = Date.now()) {
  const cfg = 规范(原始cfg)
  const 引擎 = 确保时段(状态, cfg, now)
  const 时段长 = (Number(cfg.slotHours) || 3) * 3600000
  const 起 = 时段起点(now, Number(cfg.slotHours) || 3)
  const 命中 = 引擎.slots.find((s) => s.startAt === 起) || 引擎.slots[引擎.slots.length - 1] || null
  if (!命中) return { ok: false, kind: null, reason: 'no-slot' }
  const 下一格 = 引擎.slots.find((s) => s.startAt === 起 + 时段长) || null
  // 兼容旧字段名，别的地方还在读 current.kind / current.precip
  const 降水 = { drizzle: 2, rain: 10, storm: 12, snow: 3 }[命中.kind] || 0
  const 兼容类 = { storm: 'thunder', drizzle: 'drizzle', snow: 'snow', fog: 'fog', clear: 'clear', cloudy: 'cloudy', overcast: 'cloudy', rain: 'rain' }[命中.kind] || 'cloudy'
  return {
    ok: true,
    fetchedAt: now,
    stale: false,
    slot: 命中,
    nextKind: 下一格 ? 下一格.kind : null,
    nextName: 下一格 ? 天气名[下一格.kind] : null,
    current: {
      kind: 兼容类,
      realKind: 命中.kind,
      name: 天气名[命中.kind],
      wind: 命中.wind,
      windName: 风力名[命中.wind],
      temp: Math.round(命中.temp),
      feels: Math.round(命中.temp),
      precip: 降水,
      code: -1,
    },
    hourly: [],
  }
}

// 一年预览（按当前权重 + 温度筛选，纯统计，用固定种子）
export function 预览一年(原始cfg) {
  const cfg = 规范(原始cfg)
  const 权重 = 归一化(cfg.weights, 天气种类)
  const 计数 = {}
  for (const k of 天气种类) 计数[k] = 0
  const 起点 = Date.UTC(2026, 0, 1)
  let 上一 = null
  const 时段长 = (Number(cfg.slotHours) || 3) * 3600000
  for (let i = 0; i < 365 * (24 / (Number(cfg.slotHours) || 3)); i++) {
    const at = 起点 + i * 时段长
    const t = 温度(cfg, at)
    const r = 随机(哈希种子(种子字符串(cfg, 'preview', String(i))))
    上一 = 上一 ? 下一步(上一, 权重, cfg.persistence, r, t) : 抽样(按温度筛选(权重, t), r)
    计数[上一] = (计数[上一] || 0) + 1
  }
  const 总 = Object.values(计数).reduce((a, b) => a + b, 0) || 1
  const 比例 = {}
  for (const k of 天气种类) 比例[k] = Math.round((计数[k] / 总) * 1000) / 10
  return 比例
}

export function 生成预览文本(原始cfg) {
  const cfg = 规范(原始cfg)
  const 比例 = 预览一年(cfg)
  return 天气种类
    .filter((k) => 比例[k] >= 1)
    .sort((a, b) => 比例[b] - 比例[a])
    .map((k) => 天气名[k] + ' ' + 比例[k] + '%')
    .join(' / ')
}

export { 规范 as 天气配置 }
export function 重生成(状态) {
  const seed = 'world-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  状态.weatherEngine = { slots: [] }
  return seed
}
