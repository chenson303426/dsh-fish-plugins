// dsh-life · 每日计划
//
// 确定性：同一天、同一个鱼，重算结果必须一样。
// 种子 = fishId | 本地日期 | slotId | generatorVersion | purpose
// 顺序：睡眠窗口（避让）→ 固定安排 → 空闲槽位填活动

import { createHash } from 'node:crypto'
import { 排意图 } from './intentions.js'

const 版本 = 1

export function 种子(...parts) {
  const h = createHash('sha1').update(parts.join('|')).digest()
  return h.readUInt32BE(0)
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

// 活动池：theme 越高越容易被抽中
const 池 = [
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

const 主题池 = ['游戏', '剧', '书', '健身', '外出', '宅', '厨', '音乐']

export function 今日主题(dayKey, fishId) {
  const r = 骰(种子(fishId, dayKey, 'theme', 版本, 'pick'))
  return 主题池[Math.floor(r() * 主题池.length)]
}

function 选活动(dayKey, fishId, slotId, theme) {
  const r = 骰(种子(fishId, dayKey, slotId, 版本, 'activity'))
  const 权重 = 池.map((a) => 1 + (a.theme[theme] || 0) * 1.5)
  const 总 = 权重.reduce((a, b) => a + b, 0)
  let x = r() * 总
  for (let i = 0; i < 池.length; i++) {
    x -= 权重[i]
    if (x <= 0) return 池[i]
  }
  return 池[池.length - 1]
}

// 固定锚点（工作日）
function 固定安排(dayKey, cfg) {
  const d = new Date(时刻(dayKey, '12:00'))
  const 周 = d.getDay() === 0 ? 7 : d.getDay()
  const 工作 = (cfg.workdays || [1, 2, 3, 4, 5]).includes(周)
  const 出 = []
  const 加 = (slotId, kind, title, a, b) => 出.push({ id: dayKey + ':' + slotId, slotId, kind, title, startAt: 时刻(dayKey, a), endAt: 时刻(dayKey, b) })
  if (工作) {
    加('commute-out', 'commute', '出门上班', '08:30', '09:00')
    加('work-am', 'work', '上班', '09:00', '12:00')
    加('lunch', 'meal', '午饭', '12:00', '12:40')
    加('work-pm', 'work', '上班', '13:00', '18:00')
    加('commute-home', 'commute', '下班回家', '18:00', '18:40')
    加('dinner', 'meal', '晚饭', '19:00', '19:40')
  } else {
    加('brunch', 'meal', '早午饭', '10:30', '11:10')
    加('outing', 'out', '出门逛逛', '14:00', '17:00')
    加('dinner', 'meal', '晚饭', '19:00', '19:40')
  }
  return 出
}

// 与睡眠区间求差：把落在睡眠里的部分裁掉
function 避开睡眠(items, 睡眠段) {
  const 出 = []
  for (const it of items) {
    let 段 = [[it.startAt, it.endAt]]
    for (const s of 睡眠段) {
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

export function 生成计划(dayKey, cfg, 睡眠段, 生活状态) {
  const fishId = cfg.fishId || 'fish:default'
  const 主题 = 今日主题(dayKey, fishId)
  let items = 固定安排(dayKey, cfg).filter((it) => it.kind !== 'meal' || true)
  items = 避开睡眠(items, 睡眠段)

  // 她自己的安排：优先于空闲抽活动（局部替换，不占满整晚）
  let 排了 = 0
  try { if (生活状态) 排了 = 排意图(生活状态, cfg, dayKey, items) } catch (error) {}

  // 空闲填充：把 08:00–22:30 里没被占的缺口切成 60~90 分钟
  const 起 = 时刻(dayKey, '08:00')
  const 止 = 时刻(dayKey, '22:30')
  const 占 = items.map((it) => [it.startAt, it.endAt]).sort((a, b) => a[0] - b[0])
  const 缺口 = []
  let cur = 起
  for (const [a, b] of 占) {
    if (a > cur) 缺口.push([cur, Math.min(a, 止)])
    cur = Math.max(cur, b)
  }
  if (cur < 止) 缺口.push([cur, 止])

  let n = 0
  let lastTitle = ''
  for (const [a, b] of 缺口) {
    let t = a
    while (b - t >= 45 * 60000) {
      const slotId = 'free' + n++
      const r = 骰(种子(fishId, dayKey, slotId, 版本, 'len'))
      const 长 = (60 + Math.floor(r() * 31)) * 60000
      const 结束 = Math.min(b, t + 长)
      let 活动 = 选活动(dayKey, fishId, slotId, 主题)
      if (活动.title === lastTitle) {
        const 下一个 = 池[(池.findIndex((x) => x.id === 活动.id) + 1) % 池.length]
        活动 = 下一个
      }
      lastTitle = 活动.title
      items.push({ id: dayKey + ':' + slotId, slotId, kind: 'activity', title: 活动.title, startAt: t, endAt: 结束 })
      t = 结束
    }
  }
  items = 避开睡眠(items, 睡眠段)
  items.sort((a, b) => a.startAt - b.startAt)
  return { theme: 主题, items }
}

// 插曲池
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
