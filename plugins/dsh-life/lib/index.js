// dsh-life · 宿主半边
//
// 她的日常：每日确定性计划 + 懒推进。只发布事实，不评分。
// 睡眠归 availability（这里只读它），心情归 mood（这里只往 inbox 写事实）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { 生成计划, 抽插曲, 日键 } from './plan.js'
import { 推进, 渲染, 当前项, 当天插曲 } from './advance.js'

export const name = 'life'
export const inject = ['systemPrompt', 'agents', 'timer', 'webServer']

const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置路径 = join(家, 'life-config.json')
const 状态路径 = join(家, 'life', 'state.json')
const 日志路径 = join(家, 'life.log')
const 作息数据 = join(家, 'feeling', 'availability.json')
const 作息状态 = join(家, 'feeling', 'availability-state.json')
const 心情配置 = join(家, 'mood-config.json')

const 默认配置 = {
  enabled: true,
  fishId: 'fish:default',
  targetSession: '',
  inject: true,
  injectOrder: 930,
  injectMaxChars: 80,
  workdays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  meals: ['08:00', '12:00', '19:00'],
  advanceStepMinutes: 5,
  offlineCollapseHours: 48,
}

function 记账(话) {
  const 行 = new Date().toISOString() + '  ' + 话
  try {
    appendFileSync(日志路径, 行 + '\n', 'utf8')
  } catch (error) {}
  console.log('[life] ' + 话)
}

function 读配置() {
  let cfg = { ...默认配置 }
  try {
    cfg = { ...cfg, ...JSON.parse(readFileSync(配置路径, 'utf8').replace(/^\uFEFF/, '')) }
  } catch (error) {}
  if (!cfg.targetSession) {
    try {
      const m = JSON.parse(readFileSync(心情配置, 'utf8').replace(/^\uFEFF/, ''))
      if (m && m.targetSession) cfg.targetSession = m.targetSession
    } catch (error) {}
  }
  return cfg
}

function 写默认配置() {
  try {
    if (existsSync(配置路径)) return
    mkdirSync(家, { recursive: true })
    writeFileSync(配置路径, JSON.stringify(默认配置, null, 2), 'utf8')
  } catch (error) {}
}

function 读状态() {
  try {
    return JSON.parse(readFileSync(状态路径, 'utf8'))
  } catch (error) {
    return { dayKey: '', plan: [], incidents: [], needs: { energy: 70, fullness: 70, social: 60 }, lastAdvanceAt: 0, active: null }
  }
}

function 存状态(s) {
  try {
    mkdirSync(join(家, 'life'), { recursive: true })
    writeFileSync(状态路径, JSON.stringify(s, null, 2), 'utf8')
  } catch (error) {}
}

// 读她的睡眠区间（只读 availability 的产物）
function 读睡眠段(dayKey) {
  try {
    const 数据 = JSON.parse(readFileSync(作息数据, 'utf8'))
    const 区间 = (数据.days && 数据.days[dayKey]) || []
    return 区间
      .filter((iv) => iv.actorId === 'fish:default' && ['sleep', 'nap', 'random_nap'].includes(iv.kind))
      .map((iv) => [iv.startAt, iv.endAt])
  } catch (error) {
    return []
  }
}

function 读睡着() {
  try {
    const s = JSON.parse(readFileSync(作息状态, 'utf8'))
    return Boolean(s && s.fish && s.fish.asleep)
  } catch (error) {
    return false
  }
}

function 会话id(会话) {
  const s = 会话 && 会话.id
  return s ? String(s) : ''
}

export function apply(ctx) {
  写默认配置()
  let cfg = 读配置()
  let 状态 = 读状态()
  const mounted = new Map()

  function 必要时重排() {
    const dayKey = 日键(new Date())
    if (状态.dayKey === dayKey && Array.isArray(状态.plan) && 状态.plan.length) return false
    const { theme, items } = 生成计划(dayKey, cfg, 读睡眠段(dayKey))
    状态.dayKey = dayKey
    状态.plan = items
    状态.incidents = (状态.incidents || []).filter((x) => x.dayKey === dayKey)
    状态.active = null
    状态.needs = 状态.needs || { energy: 70, fullness: 70, social: 60 }
    记账('今天排好了：主题=' + theme + '，' + items.length + ' 段')
    return true
  }

  function 走一步(手动) {
    try {
      状态.asleep = 读睡着()
      const now = Date.now()
      const 结果 = 推进(状态, cfg, now, 抽插曲, { 家 })
      if (结果.events && 结果.events.length) {
        for (const e of 结果.events) {
          if (e.type === 'started') 记账('开始：' + e.item.title + ' → ' + new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }))
          if (e.type === 'ended') 记账('结束：' + e.item.title)
          if (e.type === 'incident') 记账('插曲：' + e.text)
        }
      }
      if (结果.collapsed) 记账('离线太久，已经折叠（只排当前状态）')
      存状态(状态)
      return 结果
    } catch (error) {
      记账('推进失败：' + String(error && error.message))
      return null
    }
  }

  function tick() {
    try {
      cfg = 读配置()
      if (!cfg.enabled) return
      必要时重排()
      if (!状态.lastAdvanceAt) 状态.lastAdvanceAt = Date.now()
      走一步(false)
      if (!cfg.targetSession) return
      const list = ctx.agents.list() || []
      for (const agent of list) {
        const sid = 会话id(agent.session)
        if (!sid || sid !== cfg.targetSession || mounted.has(sid)) continue
        try {
          mounted.set(sid, 挂到(agent, sid))
          记账('已挂生活到 ' + sid)
        } catch (error) {
          记账('挂 ' + sid + ' 失败：' + String(error && error.message))
        }
      }
      for (const [sid, off] of mounted) {
        const 还在 = list.some((a) => 会话id(a.session) === sid)
        if (!还在 || sid !== cfg.targetSession) {
          try {
            off()
          } catch (error) {}
          mounted.delete(sid)
        }
      }
    } catch (error) {}
  }

  function 挂到(agent, sid) {
    const offs = []
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'life',
          order: Number(cfg.injectOrder) || 930,
          text: () => {
            try {
              if (!cfg.enabled || cfg.inject === false) return ''
              return 渲染(状态, Date.now(), Number(cfg.injectMaxChars) || 80)
            } catch (error) {
              return ''
            }
          },
        }),
      )
    } catch (error) {
      记账('注册注入失败：' + String(error && error.message))
    }
    return () => {
      for (const off of offs) {
        try {
          if (typeof off === 'function') off()
        } catch (error) {}
      }
    }
  }

  // ---- 路由 ----
  const json = (res, obj, code = 200) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
  }
  const 读体 = (req) =>
    new Promise((resolve) => {
      let 全 = ''
      req.on('data', (c) => {
        全 += c
        if (全.length > 200000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(全 || '{}'))
        } catch (error) {
          resolve({})
        }
      })
    })

  try {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/state',
        handler: async (req, res) => {
          try {
            const now = Date.now()
            json(res, {
              ok: true,
              dayKey: 状态.dayKey,
              active: 当前项(状态, now),
              asleep: Boolean(状态.asleep),
              needs: 状态.needs,
              incidents: 当天插曲(状态, 状态.dayKey),
              plan: (状态.plan || []).map((it) => ({
                title: it.title,
                kind: it.kind,
                start: new Date(it.startAt).toTimeString().slice(0, 5),
                end: new Date(it.endAt).toTimeString().slice(0, 5),
              })),
              preview: 渲染(状态, now, Number(cfg.injectMaxChars) || 80),
            })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/config',
        handler: async (req, res) => {
          try {
            if (req.method === 'POST') {
              const body = await 读体(req)
              cfg = { ...cfg, ...(body || {}) }
              writeFileSync(配置路径, JSON.stringify(cfg, null, 2), 'utf8')
              记账('配置已更新')
            }
            json(res, { ok: true, config: cfg })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/advance',
        handler: async (req, res) => {
          try {
            const r = 走一步(true)
            json(res, { ok: true, events: r && r.events, preview: 渲染(状态, Date.now(), Number(cfg.injectMaxChars) || 80) })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )
  } catch (error) {
    记账('注册路由失败：' + String(error && error.message))
  }

  ctx.effect(() => ctx.interval(tick, 60000))
  ctx.effect(() => () => {
    for (const [, off] of mounted) {
      try {
        off()
      } catch (error) {}
    }
    mounted.clear()
  })

  必要时重排()
  状态.lastAdvanceAt = 状态.lastAdvanceAt || Date.now()
  tick()
  记账('已装好 v0.1.0｜目标 ' + (cfg.targetSession || '（未配置）') + '｜计划 ' + (状态.plan || []).length + ' 段')
}
