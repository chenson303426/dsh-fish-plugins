// dsh-life · 懒推进
//
// 不跑后台定时器：每次 tick 把 lastAdvanceAt → now 按 5 分钟步长补算。
// 离线超过 48h 折叠成一句话，不补发、不把几天的坏事一次性扣到心情上。

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const 插曲预算 = { work: 2, leisure: 3, accident: 1, total: 5 }

function 时(k) {
  return new Date(k).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function 当天插曲(state, dayKey) {
  return (state.incidents || []).filter((x) => x.dayKey === dayKey)
}

function 可插(state, dayKey, kind, now) {
  const 今天 = 当天插曲(state, dayKey)
  if (今天.length >= 插曲预算.total) return false
  const 同类 = 今天.filter((x) => x.kind === kind)
  if (kind === 'work' && 同类.length >= 插曲预算.work) return false
  if (kind === 'leisure' && 同类.length >= 插曲预算.leisure) return false
  if (kind === 'accident' && 同类.length >= 插曲预算.accident) return false
  const 最近 = 今天.map((x) => x.at).sort((a, b) => b - a)[0] || 0
  const 间隔 = kind === 'work' ? 2 * 3600000 : 90 * 60000
  if (now - 最近 < 间隔) return false
  return true
}

// 把一条插曲写进档案 + 通知 mood（mood 自己决定要不要变心情）
export function 记插曲(家, state, dayKey, kind, text, at, slotId) {
  const 条 = { at, dayKey, kind, text, slotId }
  state.incidents = (state.incidents || []).concat(条).slice(-300)
  try {
    mkdirSync(join(家, 'life'), { recursive: true })
    appendFileSync(join(家, 'life', 'incidents.jsonl'), JSON.stringify(条) + '\n', 'utf8')
  } catch (error) {}
  try {
    mkdirSync(join(家, 'mood'), { recursive: true })
    appendFileSync(
      join(家, 'mood', 'inbox.jsonl'),
      JSON.stringify({ id: 'mood_life_' + at, at, source: 'life', kind: 'incident', moodDelta: 0, reason: text }) + '\n',
      'utf8',
    )
  } catch (error) {}
  return 条
}

// 当前计划项（含"刚结束"的容错）
export function 当前项(state, now) {
  const plan = state.plan || []
  return plan.find((it) => now >= it.startAt && now < it.endAt) || null
}

export function 最近结束(state, now, 窗口分钟 = 120) {
  const plan = state.plan || []
  const 已结束 = plan.filter((it) => it.endAt <= now && now - it.endAt <= 窗口分钟 * 60000)
  return 已结束[已结束.length - 1] || null
}

// 主推进：返回 { collapsed, events }
export function 推进(state, cfg, now, 抽插曲, 命) {
  const 步长 = Math.max(1, Number(cfg.advanceStepMinutes) || 5) * 60000
  const 折叠线 = (Number(cfg.offlineCollapseHours) || 48) * 3600000
  const fishId = cfg.fishId || 'fish:default'
  const events = []
  let collapsed = false

  let from = Number(state.lastAdvanceAt) || now
  if (now - from > 折叠线) {
    collapsed = true
    from = now - 步长
  }

  // 需求条衰减（只用于挑活动，不注入数字）
  const 小时 = Math.max(0, (now - from) / 3600000)
  const needs = state.needs || { energy: 70, fullness: 70, social: 60 }
  needs.energy = Math.max(0, needs.energy - 3 * 小时)
  needs.fullness = Math.max(0, needs.fullness - 4 * 小时)
  needs.social = Math.max(0, needs.social - 2 * 小时)
  state.needs = needs

  const 睡眠 = state.asleep === true
  if (睡眠) {
    // 睡着：先把正在跑的活动按"打断"结算掉
    const 在跑 = 当前项(state, now)
    if (在跑 && 在跑.status === 'running') {
      const 计划分 = Math.max(1, (在跑.endAt - 在跑.startAt) / 60000)
      const 实跑 = Math.max(0, Math.min(计划分, (now - (在跑.startedAt || 在跑.startAt)) / 60000))
      在跑.plannedMinutes = 计划分
      在跑.ranMinutes = 实跑
      在跑.status = 'interrupted'
      events.push({ type: 'ended', item: 在跑, at: now, status: 'interrupted', ranMinutes: 实跑, 打断: 'sleep' })
    }
    // 睡着：不推进活动，只把精力补一点
    needs.energy = Math.min(100, needs.energy + 6 * 小时)
    state.lastAdvanceAt = now
    state.active = null
    return { collapsed, events, asleep: true }
  }

  const plan = state.plan || []
  for (let t = from; t <= now; t += 步长) {
    // 开始
    for (const it of plan) {
      if (it.startAt > t - 步长 && it.startAt <= t) {
        state.active = it.id
        it.status = 'running'
        it.startedAt = it.startAt
        events.push({ type: 'started', item: it, at: it.startAt })
        if (it.kind === 'meal') needs.fullness = Math.min(100, needs.fullness + 25)
        if (it.kind === 'work') needs.energy = Math.max(0, needs.energy - 2)
        if (it.kind === 'out') needs.energy = Math.max(0, needs.energy - 1)
        // 插曲：按预算和间隔
        if (!collapsed) {
          const 想 = it.kind === 'work' ? 'work' : it.kind === 'activity' ? 'leisure' : null
          if (想 && 可插(state, state.dayKey, 想, t)) {
            const 文 = 抽插曲(想, state.dayKey, fishId, it.slotId, 当天插曲(state, state.dayKey).length)
            记插曲(命.家, state, state.dayKey, 想, 文, t, it.slotId)
            events.push({ type: 'incident', text: 文, at: t })
          }
        }
      }
      if (it.endAt > t - 步长 && it.endAt <= t) {
        if (state.active === it.id) state.active = null
        const 计划分 = Math.max(1, (it.endAt - it.startAt) / 60000)
        const 起点 = Number(it.startedAt) || it.startAt
        const 实跑 = Math.max(0, Math.min(计划分, (it.endAt - 起点) / 60000))
        it.plannedMinutes = 计划分
        it.ranMinutes = 实跑
        it.status = it.startedAt ? (实跑 >= 计划分 - 1 ? 'completed' : 'interrupted') : 'skipped'
        events.push({ type: 'ended', item: it, at: it.endAt, status: it.status, ranMinutes: it.ranMinutes })
      }
    }
    // 意外事件：每天 ≤1，占用总预算
    if (!collapsed && state.dayKey && 可插(state, state.dayKey, 'accident', t) && 骰一次性(state, t)) {
      const 文 = 抽插曲('accident', state.dayKey, fishId, 'accident' + Math.floor(t / 3600000), 当天插曲(state, state.dayKey).length)
      记插曲(命.家, state, state.dayKey, 'accident', 文, t, 'accident')
      events.push({ type: 'incident', text: 文, at: t })
    }
  }

  // 补账：区间已过但没记状态（离线折叠 / 被新计划顶掉）
  for (const it of plan) {
    if (it.status) continue
    if (it.endAt > now) continue
    const 计划分 = Math.max(1, (it.endAt - it.startAt) / 60000)
    it.plannedMinutes = 计划分
    if (it.startedAt) {
      const 实跑 = Math.max(0, Math.min(计划分, (it.endAt - it.startedAt) / 60000))
      it.ranMinutes = 实跑
      it.status = 'interrupted'
      events.push({ type: 'ended', item: it, at: it.endAt, status: 'interrupted', ranMinutes: 实跑, 打断: 'recover' })
    } else {
      it.ranMinutes = 0
      it.status = 'skipped'
      events.push({ type: 'ended', item: it, at: it.endAt, status: 'skipped', ranMinutes: 0, 打断: 'never' })
    }
  }

  state.lastAdvanceAt = now
  return { collapsed, events, asleep: false }
}

// 意外事件：很低概率，且只在整点附近判一次
function 骰一次性(state, t) {
  if (t % 3600000 > 5 * 60000) return false
  const r = ((t / 60000) * 2654435761) % 1000
  return r < 8
}

// 注入文案（≤80 字）：当前活动优先，其次两小时内的相关插曲
// 读书类活动带上书名和章数；虚构作品要标出来
export function 渲染(state, now, 上限 = 80) {
  const 当前 = 当前项(state, now)
  const 刚结束 = 当前 ? null : 最近结束(state, now, 120)
  let 主 = ''
  const 对象表 = state.objects || []
  const 读书 = (it) => (it && it.objectId ? 对象表.find((o) => o.objectId === it.objectId) : null)
  if (当前) {
    const o = 读书(当前)
    if (o) {
      const 总 = (o.chapters && o.chapters.length) || 0
      const 章号 = Math.min(总 || o.nextPosition + 1, o.nextPosition + 1)
      const 标 = o.contentMode === 'fictional' ? '（虚构）' : ''
      主 = '正在看《' + o.title + '》第' + 章号 + '章' + 标 + '，预计' + 时(当前.endAt) + '结束'
    } else {
      主 = '正在' + 当前.title + '，预计' + 时(当前.endAt) + '结束'
    }
  } else if (刚结束) {
    const o = 读书(刚结束)
    主 = o ? '刚看完《' + o.title + '》' : '刚忙完' + 刚结束.title
  } else {
    return ''
  }
  const 插曲 = (state.incidents || [])
    .filter((x) => now - x.at >= 0 && now - x.at <= 2 * 3600000)
    .sort((a, b) => b.at - a.at)[0]
  let 句 = 主
  if (插曲) 句 += '；' + 时(插曲.at) + '刚' + 插曲.text
  句 += '。'
  if (句.length > 上限) 句 = 句.slice(0, 上限 - 1) + '。'
  return '【日常】' + 句
}

// 今天的流水：一行，≤120 字，最多 6 段（给"你今天干嘛了"用）
export function 渲染流水(state) {
  const 日志 = (state.dayLog || []).slice().sort((a, b) => Number(a.at) - Number(b.at))
  if (!日志.length) return ''
  const 段 = []
  for (const x of 日志) {
    if (x.kind === 'incident') {
      段.push(时(x.at) + ' ' + x.title)
    } else if (x.status === 'skipped') {
      continue
    } else {
      段.push(时(x.startAt) + '-' + 时(x.endAt) + ' ' + x.title)
    }
    if (段.length >= 6) break
  }
  if (!段.length) return ''
  let 行 = '【今天的流水】' + 段.join('｜')
  if (行.length > 120) 行 = 行.slice(0, 119) + '…'
  return 行
}
