// dsh-feeling · 日记
//
// 定位（阿元定的）：
//   · 短：每天一段，3~5 条关键事项，100~200 字
//   · 不主动读：不进每轮上下文
//   · 按需翻：她说"我翻一下日记"，或他问"10 月 24 号那天"，才查
//   · 不替代 fish-memory（衰减记忆），也不进 knowledge
//
// 这里只做存取与解析；生成逻辑在 index.js（要读 SQLite 事件）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const 最多天数 = 180

export function 日键(d) {
  const x = new Date(d)
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')
}

export function 载入(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] }
  } catch (error) {
    return { entries: [] }
  }
}

export function 保存(file, diary) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const entries = (diary.entries || []).slice(-最多天数)
    writeFileSync(file, JSON.stringify({ entries }, null, 2), 'utf8')
  } catch (error) {}
}

export function 写入(diary, entry) {
  const list = diary.entries || []
  const idx = list.findIndex((e) => e.date === entry.date)
  if (idx >= 0) list[idx] = { ...list[idx], ...entry }
  else list.push(entry)
  list.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  diary.entries = list.slice(-最多天数)
  return diary
}

export function 取(diary, date) {
  return (diary.entries || []).find((e) => e.date === date) || null
}

// 最近 n 天（含今天），没有记录的跳过
export function 最近(diary, n = 3) {
  const out = []
  const now = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const e = 取(diary, 日键(d))
    if (e) out.push(e)
  }
  return out
}

// 从一句话里解析出想看的日期：绝对日期优先，其次相对词
export function 解析日期(text, now = new Date()) {
  const s = String(text || '')
  if (!s) return null
  const 命中 = []

  // 10月24 / 10-24 / 10/24（没有年份，取最近的过去）
  const m = s.match(/(\d{1,2})\s*[月\-\/]\s*(\d{1,2})/)
  if (m) {
    const 月 = Number(m[1])
    const 日 = Number(m[2])
    if (月 >= 1 && 月 <= 12 && 日 >= 1 && 日 <= 31) {
      const cand = new Date(now)
      cand.setMonth(月 - 1, 日)
      if (cand.getTime() > now.getTime()) cand.setFullYear(cand.getFullYear() - 1)
      命中.push({ date: 日键(cand), 说法: m[0] })
    }
  }
  // 2026-10-24
  const m2 = s.match(/(\d{4})\s*[-\/年]\s*(\d{1,2})\s*[-\/月]\s*(\d{1,2})/)
  if (m2) {
    const d = new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]))
    if (!Number.isNaN(d.getTime())) 命中.push({ date: 日键(d), 说法: m2[0] })
  }
  // 相对词
  const rel = [
    ['前天', 2],
    ['昨天', 1],
    ['今天', 0],
  ]
  for (const [word, back] of rel) {
    if (s.includes(word)) {
      const d = new Date(now)
      d.setDate(d.getDate() - back)
      命中.push({ date: 日键(d), 说法: word })
    }
  }
  if (/上周/.test(s)) {
    const d = new Date(now)
    d.setDate(d.getDate() - 7)
    命中.push({ date: 日键(d), 说法: '上周的今天' })
  }
  return 命中
}

// 她/他想翻日记的意图。注意：「今天」这种不能单独触发，否则天天都在翻日记
export function 是翻日记请求(text) {
  const s = String(text || '')
  if (!s) return false
  if (/(日记|翻翻|翻一下|还记得|记不记得|那次|那天|当时|以前的事)/.test(s)) return true
  // 绝对日期（10月24 / 2026-10-24）足够具体，可以直接触发
  if (/\d{1,2}\s*[月\-\/]\s*\d{1,2}/.test(s)) return true
  // 相对词要配合一句"在问过去发生了什么"
  if (/(昨天|前天|上周|上个月)/.test(s) && /(干嘛|做什么|发生|说|聊|记得|怎么样|过得)/.test(s)) return true
  return false
}

export function 渲染(entry) {
  if (!entry || !Array.isArray(entry.lines) || !entry.lines.length) return ''
  const [y, mo, d] = String(entry.date).split('-')
  const 头 = '【日记·' + Number(mo) + '月' + Number(d) + '日】'
  return 头 + entry.lines.map((l) => String(l).trim()).filter(Boolean).join('；')
}
