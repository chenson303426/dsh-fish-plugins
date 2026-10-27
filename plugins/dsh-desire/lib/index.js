// dsh-desire · 宿主半边
//
// 欲望 v1：七维需要 + 具体欲求。只影响活动选择与欲求形成，不直接改 mood / feeling。
// 数据：<你的DSH目录>\desire\state.json
// 配置：<你的DSH目录>\desire-config.json

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  NEEDS,
  NEED_LABELS,
  BASE,
  defaultState,
  dayKeyOf,
  advanceNeeds,
  expireDesires,
  activeDesires,
  addDesire,
  linkPlan,
  applyOutcome,
  scoreCandidates,
  renderDesire,
} from './logic.js'

export const name = 'desire'
export const inject = ['systemPrompt', 'agents', 'timer', 'webServer', 'llm']

const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置路径 = join(家, 'desire-config.json')
const 库目录 = join(家, 'desire')
const 状态路径 = join(库目录, 'state.json')
const 日志路径 = join(家, 'desire.log')

const 默认配置 = {
  enabled: true,
  targetSession: '',
  injectOrder: 925,
  dailyCandidates: true,
  maxActive: 3,
  tickSeconds: 60,
  model: { provider: '', model: '' },
}

function 读配置() {
  try {
    const raw = JSON.parse(readFileSync(配置路径, 'utf8').replace(/^\uFEFF/, ''))
    return { ...默认配置, ...raw, model: { ...默认配置.model, ...(raw.model || {}) } }
  } catch (error) {
    return JSON.parse(JSON.stringify(默认配置))
  }
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
    const raw = JSON.parse(readFileSync(状态路径, 'utf8'))
    if (!raw || !raw.needs) return defaultState()
    for (const k of NEEDS) if (typeof raw.needs[k] !== 'number') raw.needs[k] = BASE
    raw.desires = Array.isArray(raw.desires) ? raw.desires : []
    return raw
  } catch (error) {
    return defaultState()
  }
}

function 存状态(状态) {
  try {
    mkdirSync(库目录, { recursive: true })
    writeFileSync(状态路径, JSON.stringify(状态, null, 2), 'utf8')
  } catch (error) {}
}

function 记账(话) {
  const 行 = new Date().toISOString() + '  ' + 话
  try {
    appendFileSync(日志路径, 行 + '\n', 'utf8')
  } catch (error) {}
  console.log('[desire] ' + 话)
}

// 读 life 与 availability 的只读状态，判断"现在在干嘛"
function 读生活上下文() {
  const 结果 = { asleep: false, working: false, workMinutesToday: 0, activeTitle: '', activeKind: '' }
  try {
    const 睡 = JSON.parse(readFileSync(join(家, 'feeling', 'availability-state.json'), 'utf8'))
    if (睡 && 睡.fish) 结果.asleep = Boolean(睡.fish.asleep)
  } catch (error) {}
  try {
    const 生 = JSON.parse(readFileSync(join(家, 'life', 'state.json'), 'utf8'))
    if (生 && 生.active) {
      结果.activeTitle = String(生.active.title || '')
      结果.activeKind = String(生.active.kind || '')
      结果.working = 结果.activeKind === 'work'
    }
    const 今日 = 生 && 生.dayKey
    let 分钟 = 0
    for (const it of (生 && 生.plan) || []) {
      if (it.kind === 'work' && (!今日 || it.dayKey === 今日 || String(it.slotId || '').includes('work'))) {
        分钟 += Number(it.ranMinutes) || 0
      }
    }
    结果.workMinutesToday = 分钟
  } catch (error) {}
  return 结果
}

function 取模型(ctx, agent, cfg) {
  if (cfg.model && cfg.model.provider && cfg.model.model) return cfg.model
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
  } catch (error) {}
  try {
    const svc = ctx.get('agentDefaultModel')
    const sel = svc && svc.currentSelection ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return sel
  } catch (error) {}
  return null
}

function 会话id(会话) {
  const s = 会话 && 会话.id
  return s ? String(s) : ''
}

export function apply(ctx) {
  写默认配置()
  let cfg = 读配置()
  const 状态 = 读状态()
  const mounted = new Map()
  let 当前agent = null
  let 日候选dayKey = ''

  function tick() {
    try {
      cfg = 读配置()
      if (!cfg.enabled) return
      const now = Date.now()
      const 生活 = 读生活上下文()
      const 上次 = Number(状态.lastTickAt) || now
      // 时间推进
      advanceNeeds(状态, {
        from: 上次,
        to: now,
        asleep: 生活.asleep,
        working: 生活.working,
        workMinutesToday: 生活.workMinutesToday,
      })
      状态.lastTickAt = now
      // 过期
      const 前 = (状态.desires || []).filter((d) => ['active', 'scheduled', 'pursuing'].includes(d.status)).length
      expireDesires(状态, now)
      const 后 = activeDesires(状态, now).length
      if (后 < 前) 记账('欲求过期 ' + (前 - 后) + ' 条')
      存状态(状态)

      // 挂会话
      if (!cfg.targetSession) {
        const list = ctx.agents.list() || []
        if (list.length) {
          cfg.targetSession = 会话id(list[0].session)
          记账('自动选定会话 ' + cfg.targetSession)
        }
      }
      if (cfg.targetSession) {
        const list = ctx.agents.list() || []
        for (const agent of list) {
          const sid = 会话id(agent.session)
          if (!sid || sid !== cfg.targetSession || mounted.has(sid)) continue
          当前agent = agent
          try {
            mounted.set(sid, 挂到(agent, sid))
            记账('已挂欲望到 ' + sid)
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
      }

      // 每日候选（一天最多一次）
      const 今日 = dayKeyOf(now)
      if (cfg.dailyCandidates && 日候选dayKey !== 今日) {
        日候选dayKey = 今日
        void 生成候选(今日).catch((e) => 记账('候选失败：' + String(e && e.message)))
      }
    } catch (error) {
      记账('tick 出错：' + String(error && error.message))
    }
  }

  async function 生成候选(今日) {
    const t = 取模型(ctx, 当前agent, cfg)
    if (!t) return
    const 需要行 = NEEDS.map((k) => NEED_LABELS[k] + ' ' + Math.round(状态.needs[k])).join('、')
    const 系统 = [
      '你在给一条鱼生成"今天想要什么"。只输出 JSON 数组，不要解释。',
      '格式：[{"goal":"想做的一件具体小事","need":"recovery|autonomy|competence|connection|novelty|enjoyment|expression","strength":0-100}]',
      '要求：最多 2 条；必须是今天能做的具体小事（不是"想要陪伴"这种抽象愿望）；不要编造真实事件；',
      '如果没有什么特别想要的，就输出 []。',
    ].join('\n')
    let 出 = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: t.provider,
        model: t.model,
        system: 系统,
        messages: [{ role: 'user', content: [{ type: 'text', text: '当前需要：' + 需要行 }], source: { kind: 'plugin', plugin: 'dsh-desire' } }],
        maxTokens: 300,
        temperature: 0.9,
      })) {
        if (chunk && chunk.type === 'text-delta') 出 += chunk.text
      }
    } catch (error) {
      记账('候选调用失败：' + String(error && error.message))
      return
    }
    let list = []
    try {
      const m = 出.match(/\[[\s\S]*\]/)
      list = JSON.parse(m ? m[0] : '[]')
      if (!Array.isArray(list)) list = []
    } catch (error) {
      记账('候选解析失败：' + 出.slice(0, 80))
      return
    }
    let 加 = 0
    for (const item of list.slice(0, 2)) {
      const r = addDesire(状态, {
        goal: String(item.goal || '').slice(0, 60),
        needWeights: { [String(item.need || '')]: 1 },
        strength: Number(item.strength) || 50,
      }, Date.now(), Number(cfg.maxActive) || 3)
      if (r.ok) {
        加 += 1
        记账('新欲求：' + r.desire.goal)
      }
    }
    if (加) 存状态(状态)
  }

  function 挂到(agent, sid) {
    const offs = []
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'desire',
          order: Number(cfg.injectOrder) || 925,
          text: () => {
            try {
              if (!cfg.enabled) return ''
              return renderDesire(状态, Date.now())
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

  // ---------- 路由 ----------
  function 注册路由(path, handler) {
    try {
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try {
              const body = await 读body(req)
              const out = await handler(body)
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ ok: true, ...(out || {}) }))
            } catch (error) {
              res.statusCode = 500
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
            }
          },
        }),
      )
    } catch (error) {
      记账('注册路由 ' + path + ' 失败：' + String(error && error.message))
    }
  }

  function 读body(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET') return resolve({})
      let 全 = ''
      req.on('data', (c) => {
        全 += c
        if (全.length > 200000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(全 ? JSON.parse(全) : {})
        } catch (error) {
          resolve({})
        }
      })
      req.on('error', reject)
    })
  }

  注册路由('/dsh-desire/active', async () => ({ desires: activeDesires(状态, Date.now()) }))
  注册路由('/dsh-desire/score', async (body) => {
    const r = scoreCandidates(状态, body.candidates || [], Date.now())
    存状态(状态)
    return { scores: r }
  })
  注册路由('/dsh-desire/link-plan', async (body) => {
    const r = linkPlan(状态, body, Date.now())
    存状态(状态)
    return r
  })
  注册路由('/dsh-desire/outcome', async (body) => {
    const r = applyOutcome(状态, body, Date.now())
    存状态(状态)
    return r
  })
  注册路由('/dsh-desire/config', async (body) => {
    if (body && typeof body === 'object' && Object.keys(body).length) {
      cfg = { ...cfg, ...body }
      writeFileSync(配置路径, JSON.stringify(cfg, null, 2), 'utf8')
      记账('配置已更新：' + Object.keys(body).join(','))
    }
    return { config: cfg }
  })
  注册路由('/dsh-desire/state', async () => ({
    needs: 状态.needs,
    needsLabels: NEED_LABELS,
    desires: 状态.desires,
    active: activeDesires(状态, Date.now()),
    lastTickAt: 状态.lastTickAt,
  }))

  ctx.effect(() => ctx.interval(tick, Math.max(15, Number(默认配置.tickSeconds)) * 1000))
  ctx.effect(() => () => {
    for (const [, off] of mounted) {
      try {
        off()
      } catch (error) {}
    }
    mounted.clear()
  })

  tick()
  记账('已装好 v0.1.0｜会话 ' + (cfg.targetSession || '（待定）') + '｜库 ' + 状态路径)
}
