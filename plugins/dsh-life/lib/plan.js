// dsh-life · 日计划生成
//
// 确定性：种子 = fishId | 日期 | 槽位 | 版本 | 用途
// 工作日 / 周末两套模板；周末活动池按类别拆开，每天一个主娱乐块 + 一两个小活动
// 去重：最近 7 天"实际完成过"的活动进入冷却（连载/带 objectId 的不受限制）

import { 排意图 } from './intentions.js'

const 版本 = 2

export function 种子(...parts) {
  const s = parts.map((x) => String(x)).join('|')
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function 骰(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function 日键(d) {
  const x = new Date(d)
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')
}

function 时刻(dayKey, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  const [y, mo, d] = dayKey.split('-').map(Number)
  return new Date(y, mo - 1, d, h || 0, m || 0, 0, 0).getTime()
}

// ---------- 活动池 ----------

const 池_工作日 = [
  { id: 'game', title: '打游戏', theme: { 游戏: 3, 宅: 1 } },
  { id: 'drama', title: '追剧', theme: { 剧: 3, 宅: 1 } },
  { id: 'novel', title: '看小说', theme: { 书: 3, 宅: 1 } },
  { id: 'book', title: '看书', theme: { 书: 2 } },
  { id: 'workout', title: '运动', theme: { 健身: 3 } },
  { id: 'cook', title: '做饭', theme: { 厨: 2, 宅: 1 } },
  { id: 'walk', title: '出门散步', theme: { 外出: 2 } },
  { id: 'video', title: '刷视频', theme: { 宅: 2 } },
  { id: 'tidy', title: '收拾屋子', theme: { 宅: 1 } },
  { id: 'shop', title: '逛街', theme: { 外出: 3 } },
  { id: 'music', title: '听歌', theme: { 音乐: 2 } },
  { id: 'bili', title: '刷 B 站', theme: { 宅: 2 } },
]

// 周末池：按类别分开，各类带具体活动
export const 周末池 = {
  宅家: [
    '接着上次的位置读小说',
    '试做新口味的咖喱',
    '把拼图拼完一半',
    '练一个一直没掌握的游戏角色',
    '挑一部收藏已久的电影配零食',
    '把阳台的花浇一遍',
    '重看一集老剧',
  ],
  附近外出: [
    '去旧书店翻书',
    '沿河走一段路拍照',
    '去早餐店坐下来吃',
    '逛花店挑一盆小盆栽',
    '在公园画几张速写',
    '去便利店买点没见过的零食',
  ],
  半日出行: [
    '去看一个只逛一个展厅的展',
    '坐车去吃惦记很久的那家面馆',
    '骑一条没骑过的绿道',
    '逛二手市集（设了个小预算）',
    '去做一次陶艺体验',
    '去邻区的公园走一圈',
  ],
  社交: [
    '约人打羽毛球',
    '和朋友一起做晚饭，各做一道菜',
    '参加一次新手桌游局',
    '一起去逛文具店',
    '约着看同一部电影',
  ],
}

const 主题池 = ['游戏', '剧', '书', '健身', '外出', '宅', '厨', '音乐']

export function 今日主题(dayKey, fishId) {
  const r = 骰(种子(fishId, dayKey, 'theme', 版本, 'pick'))
  return 主题池[Math.floor(r() * 主题池.length)]
}

function 周号(dayKey) {
  const d = new Date(时刻(dayKey, '12:00'))
  return d.getDay() === 0 ? 7 : d.getDay()
}

export function 日类型(dayKey, cfg) {
  const 工作 = (cfg.workdays || [1, 2, 3, 4, 5]).includes(周号(dayKey))
  return 工作 ? 'workday' : 'restday'
}

// ---------- 去重 ----------

// 最近 7 天"实际完成过"的活动标题（连载/带 objectId 的除外）
export function 最近完成过的(状态, dayKey) {
  const 止 = 时刻(dayKey, '00:00')
  const 起 = 止 - 7 * 86400000
  const 表 = new Map()
  const 源 = (状态 && 状态.archive ? 状态.archive : []).concat(状态 && 状态.plan ? 状态.plan : [])
  for (const it of 源) {
    if (!it || it.objectId) continue
    if (it.status !== 'completed') continue
    const 末 = Number(it.endAt)
    if (末 < 起 || 末 > 止) continue
    const 名 = String(it.title || '')
    表.set(名, Math.max(表.get(名) || 0, 末))
  }
  return 表
}

function 可用(标题, 冷却) {
  if (!冷却 || !冷却.size) return true
  return !冷却.has(String(标题))
}

// 词穷时挑"最久没做过"的，保证 7 天内不重复
function 最久没做(列表, 冷却) {
  if (!冷却 || !冷却.size) return 列表[0]
  let 最好 = 列表[0]
  let 最早 = Infinity
  for (const x of 列表) {
    const 末 = 冷却.get(String(x.title || x)) || 0
    if (末 < 最早) { 最早 = 末; 最好 = x }
  }
  return 最好
}

// ---------- 固定锚点 ----------

function 固定安排(dayKey, cfg) {
  const 出 = []
  const 加 = (slotId, kind, title, a, b) =>
    出.push({ id: dayKey + ':' + slotId, slotId, kind, title, startAt: 时刻(dayKey, a), endAt: 时刻(dayKey, b) })
  if (日类型(dayKey, cfg) === 'workday') {
    加('commute-out', 'commute', '出门上班', '08:30', '09:00')
    加('work-am', 'work', '上班', '09:00', '12:00')
    加('lunch', 'meal', '午饭', '12:00', '12:40')
    加('work-pm', 'work', '上班', '13:00', '18:00')
    加('commute-home', 'commute', '下班回家', '18:00', '18:40')
    加('dinner', 'meal', '晚饭', '19:00', '19:40')
  } else {
    加('brunch', 'meal', '早午饭', '10:30', '11:10')
    加('dinner', 'meal', '晚饭', '19:00', '19:40')
    加('chores', 'chore', '收拾屋子', '20:30', '21:00')
  }
  return 出
}

function 避开睡眠(items, 睡眠段) {
  const 出 = []
  for (const it of items) {
    let 段 = [[it.startAt, it.endAt]]
    for (const s of 睡眠段 || []) {
      const 下一 = []
      for (const [a, b] of 段) {
        if (b <= s[0] || a >= s[1]) {
          下一.push([a, b])
          continue
        }
        if (a < s[0]) 下一.push([a, s[0]])
        if (b > s[1]) 下一.push([s[1], b])
      }
      段 = 下一
    }
    for (const [a, b] of 段) if (b - a >= 15 * 60000) 出.push({ ...it, startAt: a, endAt: b })
  }
  return 出
}

function 缺口们(items, 起, 止) {
  const 占 = items.map((it) => [it.startAt, it.endAt]).sort((a, b) => a[0] - b[0])
  const 缺口 = []
  let cur = 起
  for (const [a, b] of 占) {
    if (a > cur) 缺口.push([cur, Math.min(a, 止)])
    cur = Math.max(cur, b)
  }
  if (cur < 止) 缺口.push([cur, 止])
  return 缺口.filter(([a, b]) => b - a >= 20 * 60000)
}

// ---------- 选活动 ----------

function 选活动(dayKey, fishId, slotId, theme, 冷却, 已用, 欲望) {
  const r = 骰(种子(fishId, dayKey, slotId, 版本, 'activity'))
  const 候选 = 池_工作日.filter((a) => 可用(a.title, 冷却) && !(已用 && 已用.has(a.title)))
  const 表 = 候选.length ? 候选 : [最久没做(池_工作日, 冷却)]
  // 欲望排序微调：只改排序，不去重、不覆盖冷却
  if (欲望 && 欲望.scores) {
    let 最好 = null
    for (const a of 表) {
      const sc = 欲望.scores[a.title]
      if (!sc || typeof sc.score !== 'number') continue
      if (!最好 || sc.score > 最好.score) 最好 = { a, score: sc.score, sc }
    }
    if (最好) return { ...最好.a, desireId: (最好.sc.reasonIds || [])[0] || null }
  }
  const 权重 = 表.map((a) => 1 + (a.theme[theme] || 0) * 1.5)
  const 总 = 权重.reduce((a, b) => a + b, 0)
  let x = r() * 总
  for (let i = 0; i < 表.length; i++) {
    x -= 权重[i]
    if (x <= 0) return 表[i]
  }
  return 表[表.length - 1]
}

function 选周末活动(dayKey, fishId, slotId, 类别, 冷却, 已用, 欲望) {
  const 全 = 周末池[类别] || 周末池.宅家
  let 表 = 全.filter((t) => 可用(t, 冷却) && !(已用 && 已用.has(t)))
  if (!表.length) 表 = 全.filter((t) => !(已用 && 已用.has(t)))
  if (!表.length) 表 = 全
  const 用 = 表.length ? 表 : [最久没做(全.map((title) => ({ title })), 冷却).title]
  // 欲望排序微调
  if (欲望 && 欲望.scores) {
    let 最好 = null
    for (const 名 of 用) {
      const sc = 欲望.scores[名]
      if (!sc || typeof sc.score !== 'number') continue
      if (!最好 || sc.score > 最好.score) 最好 = { 名, score: sc.score, sc }
    }
    if (最好) return { title: 最好.名, desireId: (最好.sc.reasonIds || [])[0] || null }
  }
  const r = 骰(种子(fishId, dayKey, slotId, 版本, 'weekend'))
  return { title: 用[Math.floor(r() * 用.length)], desireId: null }
}

function 选类别(dayKey, fishId) {
  const r = 骰(种子(fishId, dayKey, 'category', 版本, 'pick'))
  const x = r()
  if (x < 0.45) return '宅家'
  if (x < 0.7) return '附近外出'
  if (x < 0.88) return '半日出行'
  return '社交'
}

// ---------- 生成 ----------

export function 生成计划(dayKey, cfg, 睡眠段, 生活状态, 欲望) {
  const fishId = cfg.fishId || 'fish:default'
  const 主题 = 今日主题(dayKey, fishId)
  const 类型 = 日类型(dayKey, cfg)
  const 冷却 = 最近完成过的(生活状态, dayKey)
  const 今日已用 = new Set()
  let items = 固定安排(dayKey, cfg)
  items = 避开睡眠(items, 睡眠段)

  // 她自己的安排优先
  let 排了 = 0
  try {
    if (生活状态) 排了 = 排意图(生活状态, cfg, dayKey, items)
  } catch (error) {}

  if (类型 === 'restday') {
    // 主娱乐块：13:30 起，90~180 分钟
    const 类 = 选类别(dayKey, fishId)
    const r1 = 骰(种子(fishId, dayKey, 'main', 版本, 'len'))
    const 主长 = (90 + Math.floor(r1() * 91)) * 60000
    const 主起 = 时刻(dayKey, '13:30')
    const 主止 = 主起 + 主长
    if (!items.some((it) => it.startAt < 主止 && it.endAt > 主起)) {
      const 选 = 选周末活动(dayKey, fishId, 'main', 类, 冷却, 今日已用, 欲望)
      今日已用.add(选.title)
      items.push({ id: dayKey + ':main', slotId: 'main', kind: 'activity', title: 选.title, category: 类, startAt: 主起, endAt: 主止, desireId: 选.desireId || null })
    }
    // 小活动：一到两个 20~60 分钟，填剩余空隙
    const 小槽 = 缺口们(items.sort((a, b) => a.startAt - b.startAt), 时刻(dayKey, '08:00'), 时刻(dayKey, '22:30'))
    let 放 = 0
    for (const [a, b] of 小槽) {
      if (放 >= 2) break
      if (a < 时刻(dayKey, '11:00')) continue // 早上的空档留给睡醒和早午饭，不塞活动
      const r2 = 骰(种子(fishId, dayKey, 'small' + 放, 版本, 'len'))
      const 长 = (20 + Math.floor(r2() * 41)) * 60000
      if (b - a < 长) continue
      const 类2 = 类 === '半日出行' ? '宅家' : 选类别(dayKey, fishId)
      const 选小 = 选周末活动(dayKey, fishId, 'small' + 放, 类2, 冷却, 今日已用, 欲望)
      今日已用.add(选小.title)
      items.push({ id: dayKey + ':small' + 放, slotId: 'small' + 放, kind: 'activity', title: 选小.title, category: 类2, startAt: a, endAt: a + 长, desireId: 选小.desireId || null })
      放++
    }
  } else {
    // 工作日：把缺口切成 60~90 分钟活动
    const 缺口 = 缺口们(items.sort((a, b) => a.startAt - b.startAt), 时刻(dayKey, '08:00'), 时刻(dayKey, '22:30'))
    let n = 0
    let lastTitle = ''
    for (const [a, b] of 缺口) {
      let t = a
      while (b - t >= 45 * 60000) {
        const slotId = 'free' + n++
        const r = 骰(种子(fishId, dayKey, slotId, 版本, 'len'))
        const 长 = (60 + Math.floor(r() * 31)) * 60000
        const 结束 = Math.min(b, t + 长)
        let 活动 = 选活动(dayKey, fishId, slotId, 主题, 冷却, 今日已用, 欲望)
        if (活动.title === lastTitle) {
          const 下一个 = 池_工作日[(池_工作日.findIndex((x) => x.id === 活动.id) + 1) % 池_工作日.length]
          活动 = 下一个
        }
        lastTitle = 活动.title
        今日已用.add(活动.title)
        items.push({ id: dayKey + ':' + slotId, slotId, kind: 'activity', title: 活动.title, startAt: t, endAt: 结束, desireId: 活动.desireId || null })
        t = 结束
      }
    }
  }

  items = 避开睡眠(items.sort((a, b) => a.startAt - b.startAt), 睡眠段)
  return { theme: 主题, dayTemplate: 类型, items }
}

// ---------- 插曲 ----------

const 工作插曲 = [
  '被领导点名说方案要改',
  '同事请了奶茶',
  '开会开得脑子发木',
  '把拖了两天的活干完了',
  '被夸了一句今天效率高',
]
const 休闲插曲 = [
  '输了一局，气得想摔手柄',
  '刷到一条特别好笑的视频',
  '看到一半发现是重播',
  '抢到一张想看的票',
  '快递到了，去楼下取',
  '泡的茶凉了才想起来',
]
const 意外插曲 = ['下楼遇到下雨没带伞', '手机差点掉水里', '邻居家在装修']

export function 抽插曲(kind, dayKey, fishId, slotId, n) {
  const 表 = kind === 'work' ? 工作插曲 : kind === 'accident' ? 意外插曲 : 休闲插曲
  const r = 骰(种子(fishId, dayKey, slotId, 版本, 'incident' + n))
  return 表[Math.floor(r() * 表.length)]
}

// 给欲望评分用的候选池（当天会出现的所有可能活动）
export function 候选池(dayKey, cfg) {
  const 类型 = 日类型(dayKey, cfg)
  if (类型 === 'restday') {
    const 全部 = []
    for (const [类, 表] of Object.entries(周末池)) for (const title of 表) 全部.push({ title, kind: 'activity', category: 类 })
    return 全部
  }
  return 池_工作日.map((a) => ({ title: a.title, kind: 'activity' }))
}
