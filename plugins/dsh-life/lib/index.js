// dsh-life · 宿主半边
//
// 她的日常：每日确定性计划 + 懒推进。只发布事实，不评分。
// 睡眠归 availability（这里只读它），心情归 mood（这里只往 inbox 写事实）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { 生成计划, 抽插曲, 日键, 候选池 } from './plan.js'
import { 推进, 渲染, 当前项, 当天插曲, 渲染流水 } from './advance.js'
import { 加意图, 排意图, 结算阅读, 可分享阅读, 日键 as 意日键 } from './intentions.js'
import { 确保机会, 该试, 提候选, 校验链, 接受链, 执行到点, 写节点事实, 能否现在睡 } from './chains.js'
import { 候选模板, 按模板建链 } from './templates.js'
import { 默认条件配置, 刷新天气, 生效条件, 评估活动, 设置条件, 跨天结转, 写心情 } from './conditions.js'
import { 当前天气, 预览一年, 生成预览文本, 默认天气配置, 预设, 天气名, 风力名, 重生成, 天气配置 as 天气配置规范 } from './weather.js'
import { 编辑计划 } from './planedit.js'

export const name = 'life'
export const inject = ['systemPrompt', 'agents', 'timer', 'webServer', 'llm']

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
  useDesire: true,
  desireBase: 'http://127.0.0.1:3080',
  advanceStepMinutes: 5,
  offlineCollapseHours: 48,
  chainEnabled: true,
  chainWindowStart: '09:00',
  chainWindowEnd: '22:00',
  chainTimeoutMs: 10000,
  chainVersion: 1,
  chainProvider: '',
  chainModel: '',
  napWindows: [{ start: 780, end: 810 }, { start: 870, end: 990 }],
  ...默认条件配置,
}

function 记账(话) {
  const 行 = new Date().toISOString() + '  ' + 话
  try {
    appendFileSync(日志路径, 行 + '\n', 'utf8')
  } catch (error) {}
  console.log('[life] ' + 话)
}

function 合并配置(raw) {
  const 基 = { ...默认配置, ...(raw || {}) }
  基.weather = { ...默认天气配置, ...((raw && raw.weather) || {}) }
  基.weather.weights = { ...默认天气配置.weights, ...((raw && raw.weather && raw.weather.weights) || {}) }
  基.weather.windWeights = { ...默认天气配置.windWeights, ...((raw && raw.weather && raw.weather.windWeights) || {}) }
  return 基
}

function 读配置() {
  let cfg = { ...默认配置 }
  try {
    cfg = 合并配置(JSON.parse(readFileSync(配置路径, 'utf8').replace(/^\uFEFF/, '')))
  } catch (error) {
    cfg = 合并配置(null)
  }
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
    return { dayKey: '', plan: [], incidents: [], needs: { energy: 70, fullness: 70, social: 60 }, lastAdvanceAt: 0, active: null, intentions: [], objects: [], readings: [], shares: [], reservations: [], planVersion: 1, planChanges: [], dayLog: [], conditions: [], weather: null, planEditResults: {}, carriedDays: [], moodSent: [] }
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

  // ---- 和欲望插件的接口（失败静默，不影响排程） ----
  const 欲望缓存 = { dayKey: '', tried: false, scores: null, pending: false }
  async function 预取欲望评分(dayKey) {
    if (cfg.useDesire === false) return
    欲望缓存.pending = true
    try {
      const cands = 候选池(dayKey, cfg)
      const r = await fetch(String(cfg.desireBase || 'http://127.0.0.1:3080') + '/dsh-desire/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fishId: cfg.fishId || 'fish:default', at: Date.now(), candidates: cands }),
        signal: AbortSignal.timeout(2500),
      })
      const j = await r.json()
      const 分 = {}
      for (const x of (j && j.scores) || []) {
        const 名 = x.title || x.candidate || ''
        if (!名) continue
        const needFit = Number(x.needFit) || 0
        const goalFit = Number(x.goalFit) || 0
        分[名] = { score: 0.6 * needFit + 0.4 * goalFit, reasonIds: x.reasonIds || [] }
      }
      欲望缓存.scores = Object.keys(分).length ? 分 : null
      记账('欲望评分：' + Object.keys(分).length + ' 个候选')
    } catch (error) {
      欲望缓存.scores = null
      记欲望失败(String(error && error.message))
    } finally {
      欲望缓存.pending = false
    }
  }
  let 欲望失败日志_时 = 0
  function 记欲望失败(msg) {
    if (Date.now() - 欲望失败日志_时 < 5 * 60000) return
    欲望失败日志_时 = Date.now()
    记账('欲望接口失败：' + msg)
  }
  async function 上报欲望(路径, body) {
    try {
      await fetch(String(cfg.desireBase || 'http://127.0.0.1:3080') + 路径, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2500),
      })
    } catch (error) {
      记欲望失败(String(error && error.message))
    }
  }

  function 必要时重排() {
    const dayKey = 日键(new Date())
    if (状态.dayKey === dayKey && Array.isArray(状态.plan) && 状态.plan.length) return false
    // 欲望评分：每天先试一次（最多等一个 tick）；失败就退回原来的随机
    if (欲望缓存.pending) return false
    if (cfg.useDesire !== false && 欲望缓存.dayKey !== dayKey && !欲望缓存.tried) {
      欲望缓存.dayKey = dayKey
      欲望缓存.tried = true
      void 预取欲望评分(dayKey)
      return false
    }
    const { theme, items } = 生成计划(dayKey, cfg, 读睡眠段(dayKey), 状态, 欲望缓存.scores ? { scores: 欲望缓存.scores } : null)
    状态.dayKey = dayKey
    状态.plan = items
    状态.incidents = (状态.incidents || []).filter((x) => x.dayKey === dayKey)
    状态.active = null
    状态.dayLog = []
    状态.needs = 状态.needs || { energy: 70, fullness: 70, social: 60 }
    记账('今天排好了：主题=' + theme + '，' + items.length + ' 段')
    // 有关联欲求的活动上报一次
    for (const it of items) {
      if (it.desireId) void 上报欲望('/dsh-desire/link-plan', { desireId: it.desireId, planId: it.id, expectedOutcome: it.title })
    }
    return true
  }

  // 活动结束后统一结算（running/completed/interrupted/skipped 由 advance 标注）
  function 结算已结束(now) {
    const 所有 = (状态.plan || []).concat(状态.archive || [])
    for (const it of 所有) {
      if (!['completed', 'interrupted', 'skipped'].includes(it.status)) continue
      if (it.settled) continue
      // 回填欲望（结果未知按 skipped，不阻塞）
      void 上报欲望('/dsh-desire/outcome', {
        eventId: it.id,
        activityId: it.id,
        result: it.status === 'completed' ? 'completed' : it.status === 'interrupted' ? 'interrupted' : 'skipped',
      })
      if (!it.objectId) { it.settled = true; continue }
      const 计划分 = Number(it.plannedMinutes) || Math.max(1, (it.endAt - it.startAt) / 60000)
      const 实跑分 = Number(it.ranMinutes) || 0
      const 结果 = 结算阅读(状态, it, Number(it.endAt) || now, { status: it.status, plannedMinutes: 计划分, ranMinutes: 实跑分 })
      it.settled = true
      it.settledResult = 结果 || null
      if (!结果) continue
      if (结果.duplicate) { 记账('重复结算已跳过：' + it.title); continue }
      if (it.status === 'interrupted') {
        记账('打断：' + it.title + ' 读了 ' + Math.round(实跑分) + '/' + Math.round(计划分) + ' 分钟，结算 ' + (结果.章数 || 0) + ' 章')
      } else if (it.status === 'skipped') {
        记账('没开始：' + it.title)
      } else {
        记账('读完：' + it.title + '，结算 ' + (结果.章数 || 0) + ' 章')
      }
    }
    if (状态.archive) 状态.archive = 状态.archive.slice(-50)
  }

  function 记录流水(events) {
    if (!Array.isArray(状态.dayLog)) 状态.dayLog = []
    for (const e of events) {
      if (!e || !e.type) continue
      if (e.type === 'started') {
        const id = String(e.item.id || e.item.title + '@' + e.item.startAt)
        if (!状态.dayLog.some((x) => x.id === id)) {
          状态.dayLog.push({ id, at: e.item.startAt, kind: e.item.kind, title: e.item.title, startAt: e.item.startAt, endAt: e.item.endAt, status: 'running' })
        }
      } else if (e.type === 'ended') {
        const id = String(e.item.id || e.item.title + '@' + e.item.startAt)
        const 条 = { id, at: e.item.startAt, kind: e.item.kind, title: e.item.title, startAt: e.item.startAt, endAt: e.item.endAt, status: e.status || e.item.status || 'ended' }
        const 现有 = 状态.dayLog.find((x) => x.id === id)
        if (现有) Object.assign(现有, 条)
        else 状态.dayLog.push(条)
      } else if (e.type === 'incident') {
        const id = 'inc:' + e.at + ':' + String(e.text || '').slice(0, 10)
        if (!状态.dayLog.some((x) => x.id === id)) {
          状态.dayLog.push({ id, at: e.at, kind: 'incident', title: String(e.text || ''), startAt: e.at, endAt: e.at, status: 'occurred' })
        }
      }
    }
    状态.dayLog = 状态.dayLog.slice(-40)
  }

  const 上次结束 = new Map()
  function 走一步(手动) {
    try {
      状态.asleep = 读睡着()
      const now = Date.now()
      const 结果 = 推进(状态, cfg, now, 抽插曲, { 家 })
      if (结果.events && 结果.events.length) {
        for (const e of 结果.events) {
          if (e.type === 'started') 记账('开始：' + e.item.title + ' → ' + new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }))
          if (e.type === 'ended') {
            const k = (e.item.id || e.item.title) + '@' + (e.item.endAt || e.item.end || '')
            if (上次结束.get(k)) continue
            上次结束.set(k, true)
            记账('结束：' + e.item.title)
          }
          if (e.type === 'incident') 记账('插曲：' + e.text)
        }
      }
      记录流水(结果.events || [])
      if (结果.collapsed) 记账('离线太久，已经折叠（只排当前状态）')
      结算已结束(now)
      存状态(状态)
      return 结果
    } catch (error) {
      记账('推进失败：' + String(error && error.message))
      return null
    }
  }

  let 链锁 = false
  async function 试链() {
    if (链锁) return
    if (cfg.chainEnabled === false) return
    const now = Date.now()
    const opp = 该试(状态, cfg, now)
    if (!opp) return
    opp.status = 'used'
    链锁 = true
    try {
      let agent = null
      try {
        const list = ctx.agents.list() || []
        agent = list.find((a) => 会话id(a.session) === String(cfg.targetSession)) || list[0] || null
      } catch (error) {}
      // 挑 3~5 个联动模板给模型选（模型只能选 id，不能发明效果）
      try {
        const 阅读中 = (状态.plan || []).some((it) => it.objectId && it.startAt <= now && it.endAt > now)
        const ctxT = {
          cfg,
          state: 状态,
          hasWork: (状态.plan || []).some((it) => it.kind === 'work'),
          hasMeal: (状态.plan || []).some((it) => it.kind === 'meal' && it.startAt > now),
          mealSoon: (状态.plan || []).some((it) => it.kind === 'meal' && it.startAt > now && it.startAt - now < 90 * 60000),
          hasNext: (状态.plan || []).some((it) => it.startAt > now),
          hasEvening: (状态.plan || []).some((it) => it.kind === 'activity' && new Date(it.startAt).getHours() >= 19),
          reading: 阅读中,
          napOk: 能否现在睡(now),
        }
        cfg.__候选 = 候选模板(now, ctxT, 5)
        cfg.__ctx = ctxT
      } catch (error) { cfg.__候选 = [] }
      const r = await 提候选(ctx, cfg, 状态, agent, now)
      let 链 = r && r.chain ? r.chain : null
      if (r && r.templateId && cfg.__ctx) {
        const tpl = (cfg.__候选 || []).find((x) => x.id === r.templateId)
        if (tpl) {
          链 = 按模板建链(tpl, r.details, cfg.__ctx, now, 状态.dayKey || 日键(new Date(now)))
          记账('模板命中：' + tpl.id)
        }
      }
      if (!链) {
        opp.reason = (r && r.error) || '模型没提'
        记账('链：今天不提（' + opp.reason + '）')
        存状态(状态)
        return
      }
      记账('链候选：' + (链.nodes || []).length + ' 节点 / ' + (链.effects || []).length + ' 后果')
      const v = 校验链(链, 状态, cfg, now)
      if (!v.ok) {
        记账('链拒绝：' + v.errors.join('；'))
        存状态(状态)
        return
      }
      const c = 接受链(状态, 链, v, now, 状态.dayKey || 日键(new Date(now)))
      记账('链接受：' + (c.reason || '（无理由）') + '｜' + c.effects.map((e) => e.type).join(', '))
      存状态(状态)
    } catch (error) {
      记账('链异常：' + String(error && error.message))
    } finally {
      链锁 = false
    }
  }

  let 上次条件维护 = 0
  async function 条件维护() {
    if (Date.now() - 上次条件维护 < 10 * 60000) return
    上次条件维护 = Date.now()
    try {
      await 刷新天气(状态, cfg)
      const 结转 = 跨天结转(状态, Date.now())
      if (结转 && 结转.carried) 记账('跨天结转：' + 结转.carried + ' 条身体条件')
      存状态(状态)
    } catch (error) {
      记账('条件维护失败：' + String(error && error.message))
    }
  }

  function tick() {
    void 条件维护()
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

  // 用户在问"今天/刚才干了什么"吗？（只匹配"做事"类问法，"今天天气不错"不触发）
  const 流水问法 = /(干嘛|干了什么|干了啥|做了什么|做了啥|忙什么|忙啥|过得怎么样|怎么过的|做什么了|干什么了)/
  function 取文本(消息) {
    try {
      const c = 消息 && 消息.content
      if (typeof c === 'string') return c.trim()
      if (!Array.isArray(c)) return ''
      return c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('').trim()
    } catch (error) {
      return ''
    }
  }

  function 挂到(agent, sid) {
    const offs = []
    let 要流水 = ''
    try {
      offs.push(
        agent.ctx.on('agent/inbox/inserted', (payload) => {
          const msg = payload && payload.message ? payload.message : payload
          const src = msg && msg.source && msg.source.kind ? String(msg.source.kind) : ''
          if (['sulk', 'feeling', 'mood', 'life', 'speak-up'].includes(src)) return
          const txt = 取文本(msg)
          if (!txt) return
          const m = txt.match(流水问法)
          if (m) 要流水 = m[0]
        }),
      )
    } catch (error) {
      记账('监听 inbox 失败：' + String(error && error.message))
    }
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'life',
          order: Number(cfg.injectOrder) || 930,
          text: () => {
            try {
              if (!cfg.enabled || cfg.inject === false) return ''
              const 行 = 渲染(状态, Date.now(), Number(cfg.injectMaxChars) || 80)
              // 每次注入留痕（5 分钟内只记一次），方便确认她真的收到了
              if (行 && Date.now() - (globalThis.__life_注入日志 || 0) > 5 * 60000) {
                globalThis.__life_注入日志 = Date.now()
                记账('注入：' + 行)
              }
              // 这一轮在问"今天干了什么" → 追加今天的流水（只说一次）
              if (要流水) {
                const 词 = 要流水
                要流水 = ''
                const 流水 = 渲染流水(状态, Date.now())
                if (流水) {
                  记账('流水注入：' + 词)
                  return (行 ? 行 + '\n' : '') + 流水
                }
              }
              return 行
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
              intentions: (状态.intentions || []).slice(-20).map((x) => ({
                id: x.id, title: x.title, status: x.status, strength: x.strength,
                windowStart: x.windowStart, windowEnd: x.windowEnd, minutes: x.minutes,
              })),
              objects: (状态.objects || []).map((o) => ({
                objectId: o.objectId, title: o.title, contentMode: o.contentMode,
                materialKind: o.materialKind, nextPosition: o.nextPosition,
                chapters: (o.chapters || []).length, pendingMaterial: Boolean(o.pendingMaterial),
              })),
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
        path: '/dsh-life/day',
        handler: async (req, res) => {
          try {
            const 日志 = (状态.dayLog || []).slice().sort((a, b) => Number(a.at) - Number(b.at))
            json(res, {
              ok: true,
              dayKey: 状态.dayKey,
              count: 日志.length,
              log: 日志,
              line: 渲染流水(状态, Date.now()),
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
    // ---- v1.1 新增路由 ----
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/intention',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') return json(res, { ok: false, error: 'POST only' }, 405)
            const body = await 读体(req)
            if (!body || !body.title) return json(res, { ok: false, error: '缺 title' }, 400)
            const dayKey = 意日键(new Date())
            const 条 = 加意图(状态, cfg, body, dayKey)
            // 只把新意图插进今天的空档，不整天重排
            const 插了 = 排意图(状态, cfg, 状态.dayKey || dayKey, 状态.plan || [])
            if (插了) {
              状态.planVersion = (状态.planVersion || 1) + 1
              状态.planChanges = (状态.planChanges || []).concat({ at: Date.now(), why: 'intention', id: 条.id }).slice(-100)
            }
            存状态(状态)
            记账('新安排：' + 条.title + '（' + 条.status + '）')
            json(res, { ok: true, intention: 条 })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/activity',
        handler: async (req, res) => {
          const now = Date.now()
          const a = 当前项(状态, now)
          json(res, {
            ok: true,
            active: a ? { title: a.title, kind: a.kind, objectId: a.objectId || null, endAt: a.endAt } : null,
          })
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/preview',
        handler: async (req, res) => {
          json(res, { ok: true, text: 渲染(状态, Date.now(), Number(cfg.injectMaxChars) || 80) })
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/shareable',
        handler: async (req, res) => {
          const c = 可分享阅读(状态, Date.now())
          json(res, { ok: true, candidate: c })
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/reserve-share',
        handler: async (req, res) => {
          try {
            const body = await 读体(req)
            const requestId = String(body.requestId || '')
            const candidateId = String(body.candidateId || '')
            if (!requestId || !candidateId) return json(res, { ok: false, error: '缺 requestId/candidateId' }, 400)
            状态.reservations = (状态.reservations || []).filter((r) => r.expiresAt > Date.now())
            const 旧 = 状态.reservations.find((r) => r.requestId === requestId)
            if (旧) return json(res, { ok: true, reservation: 旧, reused: true })
            const c = 可分享阅读(状态, Date.now())
            if (!c || c.candidateId !== candidateId) return json(res, { ok: false, error: '候选已失效' }, 409)
            const 条 = { requestId, candidateId, activityId: c.activityId, objectId: c.objectId, at: Date.now(), expiresAt: Date.now() + 10 * 60000 }
            状态.reservations.push(条)
            存状态(状态)
            json(res, { ok: true, reservation: 条 })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/finish-share',
        handler: async (req, res) => {
          try {
            const body = await 读体(req)
            const requestId = String(body.requestId || '')
            const 预约 = (状态.reservations || []).find((r) => r.requestId === requestId)
            if (!预约) return json(res, { ok: false, error: '没有这个预约' }, 404)
            状态.shares = (状态.shares || []).concat({ activityId: 预约.activityId, objectId: 预约.objectId, at: Date.now() }).slice(-200)
            状态.reservations = 状态.reservations.filter((r) => r.requestId !== requestId)
            存状态(状态)
            记账('分享了：' + 预约.candidateId)
            json(res, { ok: true })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/chains',
        handler: async (req, res) => {
          json(res, { ok: true, chains: (状态.chains || []).slice(-10), opportunity: 状态.chainOpportunity || null })
        },
      }),
    )


    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/plan/edit',
        handler: async (req, res) => {
          try {
            const b = await 读体(req)
            const r = 编辑计划(状态, b, Date.now(), 读睡眠段(状态.dayKey))
            if (r.ok) {
              存状态(状态)
              记账('改计划：' + r.op + (b.reason ? '（' + String(b.reason).slice(0, 40) + '）' : ''))
              if (b.cause === 'condition') {
                写心情(家, 状态, { kind: 'plan_change', reason: '计划因条件变了：' + String(b.reason || r.op), correlationId: 'plan:' + (b.requestId || r.op) })
              }
            }
            json(res, r, r.ok ? 200 : 409)
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/conditions',
        handler: async (req, res) => {
          try {
            if (req.method === 'POST') {
              const b = await 读体(req)
              const r = 设置条件(状态, b, Date.now())
              if (r.ok && !r.removed && b.type === 'illness') {
                写心情(家, 状态, { kind: 'condition', reason: '身体不太舒服（' + (b.severity || 'moderate') + '）', correlationId: 'illness:' + r.condition.id + ':' + r.condition.validFrom })
              }
              存状态(状态)
              记账('设置条件：' + (r.removed ? '解除 ' + r.id : r.condition.type + '/' + r.condition.severity))
              json(res, { ok: true, ...r, active: 生效条件(状态, cfg, Date.now()) })
            } else {
              json(res, { ok: true, active: 生效条件(状态, cfg, Date.now()), weather: 状态.weather || null })
            }
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    // 虚拟天气：读配置 / 改配置 / 换世界
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/weather',
        handler: async (req, res) => {
          try {
            if (req.method === 'POST') {
              const b = await 读体(req)
              const 现 = 读配置()
              const 预 = (b && b.preset && 预设[b.preset]) ? 预设[b.preset] : null
              const 基 = 预 ? { ...现.weather, ...预 } : 现.weather
              const 新 = {
                ...基,
                ...(b || {}),
                weights: { ...基.weights, ...((b && !预 && b.weights) || {}) },
                windWeights: { ...基.windWeights, ...((b && !预 && b.windWeights) || {}) },
                configVersion: Number(现.weather.configVersion || 1) + 1,
              }
              const 圆 = Object.values(新.weights).reduce((a, x) => a + Math.max(0, Number(x) || 0), 0)
              if (圆 <= 0) return json(res, { ok: false, error: '天气权重不能全为 0' }, 400)
              const 全文 = (() => { try { return JSON.parse(readFileSync(配置路径, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { return {} } })()
              全文.weather = 新
              writeFileSync(配置路径, JSON.stringify(全文, null, 2), 'utf8')
              cfg = 读配置()
              存状态(状态)
              记账('天气配置已更新：预设=' + (新.preset || '自定义') + ' 持续=' + 新.persistence)
              return json(res, { ok: true, weather: cfg.weather, preview: 生成预览文本(cfg) })
            }
            const w = 当前天气(状态, cfg, Date.now())
            存状态(状态)
            json(res, {
              ok: true,
              current: w.current || null,
              slot: w.slot || null,
              config: cfg.weather,
              presets: Object.keys(预设),
              preview: 生成预览文本(cfg),
              previewPercent: 预览一年(cfg),
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
        path: '/dsh-life/weather/regenerate',
        handler: async (req, res) => {
          try {
            const b = await 读体(req)
            if (!b || b.confirm !== true) return json(res, { ok: false, error: '需要 confirm:true 才会换世界' }, 400)
            const 现 = 读配置()
            const seed = 重生成(状态)
            const 全文 = (() => { try { return JSON.parse(readFileSync(配置路径, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { return {} } })()
            全文.weather = { ...现.weather, worldSeed: seed, configVersion: Number(现.weather.configVersion || 1) + 1 }
            writeFileSync(配置路径, JSON.stringify(全文, null, 2), 'utf8')
            cfg = 读配置()
            存状态(状态)
            记账('天气世界已重生成：' + seed)
            json(res, { ok: true, worldSeed: seed, current: 当前天气(状态, cfg, Date.now()).current })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/evaluate',
        handler: async (req, res) => {
          try {
            const b = await 读体(req)
            const 活动 = b.activity || {}
            const 结果 = 评估活动(状态, cfg, 活动, Date.now())
            json(res, { ok: true, ...结果 })
          } catch (error) {
            json(res, { ok: false, error: String(error && error.message) }, 500)
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-life/can-social',
        handler: async (req, res) => {
          try {
            const 结果 = 评估活动(状态, cfg, { title: '社交活动', kind: 'social', outdoor: false }, Date.now())
            const 身体 = (生效条件(状态, cfg, Date.now()) || []).filter((c) => c.category === 'body' && c.status === 'active')
            json(res, {
              ok: true,
              allowed: 结果.decision !== 'blocked' && 身体.length === 0,
              decision: 结果.decision,
              reasons: [...结果.reasons, ...身体.map((c) => ({ conditionId: c.id, category: 'body', effect: c.constraints && c.constraints.effect, severity: c.severity, basis: c.basis }))],
            })
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

  状态.chains = 状态.chains || []
  状态.chainOpportunity = 状态.chainOpportunity || null
  必要时重排()
  状态.lastAdvanceAt = 状态.lastAdvanceAt || Date.now()
  tick()
  记账('已装好 v0.1.0｜目标 ' + (cfg.targetSession || '（未配置）') + '｜计划 ' + (状态.plan || []).length + ' 段')
}
