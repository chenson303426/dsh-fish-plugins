// dsh-feeling · 时间感
//
// 目的：让她在开口时知道「现在几点 / 距上次说话多久 / 这段时间里有多少是她的睡眠段」。
// 全部由代码算，不调模型；状态落盘，重启后仍然接得上。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const 默认 = {
  lastUserMessageAt: 0, // 对方最后一条来信
  lastReplyDeliveredAt: 0, // 她最后一次回复
  lastExchangeEndedAt: 0, // 上一段交流结束
  endingKind: 'unknown', // wrapped | open | unknown
  lastSessionAt: 0, // 上一段交流的开始
  sessionsToday: 0,
  dayKey: '',
}

export function loadTime(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { ...默认, ...raw }
  } catch (error) {
    return { ...默认 }
  }
}

export function saveTime(file, t) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(t, null, 2), 'utf8')
  } catch (error) {}
}

function 今日键(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

// 收到来信
export function onUser(t, at, text) {
  t.lastUserMessageAt = at
  // 隔 30 分钟以上算新的一段交流
  if (!t.lastSessionAt || at - t.lastSessionAt > 30 * 60000) {
    t.lastSessionAt = at
    const k = 今日键(new Date(at))
    if (t.dayKey !== k) {
      t.dayKey = k
      t.sessionsToday = 0
    }
    t.sessionsToday += 1
  }
  // 判断这段交流是怎么结束的
  const s = String(text || '')
  if (/(晚安|睡了|拜拜|再见|一会儿见|回头聊|先这样|去忙|出门|下班)/.test(s)) t.endingKind = 'wrapped'
  else if (/[?？]$|吗$|呢$/.test(s.trim())) t.endingKind = 'open'
  else t.endingKind = t.endingKind === 'open' ? 'open' : 'unknown'
  return t
}

export function onReply(t, at) {
  t.lastReplyDeliveredAt = at
  t.lastExchangeEndedAt = at
  return t
}

// 两个时间点之间落在睡眠段（默认 23:30–08:00）的毫秒数
export function sleepMsBetween(from, to, sleepStart = [23, 30], sleepEnd = [8, 0]) {
  if (!from || !to || to <= from) return 0
  let 总 = 0
  const 起 = new Date(from)
  起.setHours(0, 0, 0, 0)
  起.setDate(起.getDate() - 1) // 前一天晚上 23:30 的睡眠段也要算进来
  for (let d = new Date(起); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    const s = new Date(d)
    s.setHours(sleepStart[0], sleepStart[1], 0, 0)
    const e = new Date(d)
    e.setDate(e.getDate() + 1)
    e.setHours(sleepEnd[0], sleepEnd[1], 0, 0)
    const a = Math.max(from, s.getTime())
    const b = Math.min(to, e.getTime())
    if (b > a) 总 += b - a
  }
  return 总
}

function 时长(ms) {
  const 分 = Math.round(ms / 60000)
  if (分 < 60) return 分 + '分钟'
  const 时 = Math.floor(分 / 60)
  const 余 = 分 % 60
  return 余 ? 时 + '小时' + 余 + '分' : 时 + '小时'
}

const 周 = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 时间摘要：1~2 行，代码生成
export function renderTime(t, now = Date.now(), opts = {}) {
  const d = new Date(now)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const 首行 = `【时间】${周[d.getDay()]} ${hh}:${mm}（上海）`
  const 段 = []
  const 参照 = t.lastExchangeEndedAt || t.lastUserMessageAt
  if (参照) {
    const 间隔 = now - 参照
    const 睡 = typeof opts.sleepMs === 'number' ? opts.sleepMs : sleepMsBetween(参照, now, opts.sleepStart, opts.sleepEnd)
    const 清醒 = Math.max(0, 间隔 - 睡)
    let 句 = 参照 === t.lastExchangeEndedAt ? '距上次交流结束 ' : '距上次来信 '
    句 += 时长(间隔)
    if (睡 > 0) 句 += `，其中睡眠段 ${时长(睡)}`
    if (清醒 > 0 && 清醒 < 间隔) 句 += `（清醒 ${时长(清醒)}）`
    if (间隔 < 60000) 句 = '刚刚还在说话'
    段.push(句)
  }
  if (t.sessionsToday > 0) 段.push(`今天是第 ${t.sessionsToday} 段交流`)
  const 有 = 段.length ? `；${段.join('；')}` : ''
  const lines = [首行 + 有]

  // 等待情境：只有「明确在等答复」才计算，且要扣掉睡眠
  if (t.endingKind === 'open' && 参照) {
    const 清醒 = Math.max(0, now - 参照 - sleepMsBetween(参照, now, opts.sleepStart, opts.sleepEnd))
    if (清醒 > 2 * 3600000) {
      lines.push(`【等待情境】上次明确在等答复；清醒等待已超过 ${时长(清醒)}。没有失约或故意忽略的证据。`)
    }
  }
  return lines.join('\n')
}
