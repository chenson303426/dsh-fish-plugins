// dsh-mood · 宿主半边
//
// 鱼的心情：mood 0~100 + 七个情绪维度，半衰期衰减，每轮一行注入。
// 与旧 feiyu-mood 的关键差别：对外开放 /dsh-mood/apply，feeling / sulk / life 可以直接喂事件。
//
// 设计约束（阿元定的）：
//   · 注入里绝不出现数字，只说等级 + 一句倾向
//   · 情绪判断只管「她遇到的事、被怎样对待」，不因「用户惹她 / 用户不回」掉 mood（那是怨气，归 feeling）
//   · 同一变化只注入一次，低置信度不注入，每天有上限

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'mood'
export const inject = ['systemPrompt', 'agents', 'llm', 'timer', 'webServer']

const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置路径 = join(家, 'mood-config.json')
const 状态路径 = join(家, 'mood', 'state.json')
const 旧状态路径 = join(家, 'feiyu-mood', 'state.json')
const 日志路径 = join(家, 'mood.log')

const 维度 = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']
const 维度名 = { happy: '开心', calm: '平静', sweet: '甜', heartache: '心酸', worry: '担心', sad: '难过', jealous: '吃味' }

const 默认配置 = {
  enabled: true,
  targetSession: '',
  displayName: '阿元',
  moodBase: 70,
  moodFloor: 1,
  decayHalfHours: 14,
  injectMode: 'event',
  injectConfidence: 55,
  injectPerDay: 6,
  sigMood: 2,
  sigDim: 4,
  autoJudge: true,
  judgeProvider: '',
  judgeModel: '',
}

function 读配置() {
  try {
    return { ...默认配置, ...JSON.parse(readFileSync(配置路径, 'utf8').replace(/^\uFEFF/, '')) }
  } catch (error) {
    return { ...默认配置 }
  }
}

function 写默认配置() {
  try {
    if (existsSync(配置路径)) return
    mkdirSync(家, { recursive: true })
    writeFileSync(配置路径, JSON.stringify(默认配置, null, 2), 'utf8')
  } catch (error) {}
}

function 空状态(cfg) {
  return {
    mood: Number(cfg.moodBase) || 70,
    dims: Object.fromEntries(维度.map((k) => [k, 0])),
    lastReason: '',
    lastConfidence: 0,
    injectedFor: 0,
    saidAt: [],
    updatedAt: 0,
    lastDecayAt: 0,
    timeline: [],
  }
}

// 首次启动：从旧的 feiyu-mood 迁移 mood / dims
function 读状态(cfg) {
  try {
    const raw = JSON.parse(readFileSync(状态路径, 'utf8').replace(/^\uFEFF/, ''))
    return { ...空状态(cfg), ...raw, dims: { ...空状态(cfg).dims, ...(raw.dims || {}) } }
  } catch (error) {
    const 新 = 空状态(cfg)
    try {
      if (existsSync(旧状态路径)) {
        const 旧 = JSON.parse(readFileSync(旧状态路径, 'utf8').replace(/^\uFEFF/, ''))
        if (typeof 旧.mood === 'number') 新.mood = 旧.mood
        for (const k of 维度) if (旧.dims && typeof 旧.dims[k] === 'number') 新.dims[k] = 旧.dims[k]
        新.lastReason = '（从旧的心情插件迁移）'
        记账('已从 feiyu-mood 迁移：mood=' + 新.mood + ' dims=' + JSON.stringify(新.dims))
      }
    } catch (error) {}
    return 新
  }
}

function 存状态(状态) {
  try {
    mkdirSync(join(家, 'mood'), { recursive: true })
    writeFileSync(状态路径, JSON.stringify(状态, null, 2), 'utf8')
  } catch (error) {}
}

function 记账(话) {
  const 行 = new Date().toISOString() + '  ' + 话
  try {
    appendFileSync(日志路径, 行 + '\n', 'utf8')
  } catch (error) {}
  console.log('[mood] ' + 话)
}

function 会话id(会话) {
  return 会话 && 会话.id ? String(会话.id) : ''
}

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

function 取模型(ctx, agent, cfg) {
  if (cfg.judgeProvider && cfg.judgeModel) return { provider: cfg.judgeProvider, model: cfg.judgeModel }
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
  } catch (error) {}
  try {
    const svc = ctx.get('agentDefaultModel')
    const sel = svc && svc.currentSelection ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

function 夹(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// 半衰期衰减：dims → 0，mood → moodBase
function 衰减(状态, cfg, now) {
  const 上次 = Number(状态.lastDecayAt) || now
  const 小时 = Math.max(0, (now - 上次) / 3600000)
  if (小时 <= 0.001) return false
  const 系数 = Math.pow(2, -小时 / Math.max(0.5, Number(cfg.decayHalfHours) || 14))
  let 有变化 = false
  for (const k of 维度) {
    const v = Number(状态.dims[k]) || 0
    const nv = Math.abs(v) < 0.05 ? 0 : v * 系数
    if (Math.abs(nv - v) > 0.01) 有变化 = true
    状态.dims[k] = Math.round(nv * 10) / 10
  }
  const base = Number(cfg.moodBase) || 70
  const m = Number(状态.mood) || base
  const nm = base + (m - base) * 系数
  if (Math.abs(nm - m) > 0.01) 有变化 = true
  状态.mood = Math.round(nm * 10) / 10
  状态.lastDecayAt = now
  return 有变化
}

function 应用(状态, cfg, 变化) {
  const now = Date.now()
  const 前 = { mood: 状态.mood, dims: { ...状态.dims } }
  const moodDelta = Number(变化.moodDelta) || 0
  状态.mood = Math.round(夹((Number(状态.mood) || 0) + moodDelta, Number(cfg.moodFloor) || 1, 100) * 10) / 10
  const dimsDelta = {}
  for (const k of 维度) {
    const d = Number((变化.dims || {})[k]) || 0
    if (!d) continue
    dimsDelta[k] = d
    状态.dims[k] = Math.round(夹((Number(状态.dims[k]) || 0) + d, -60, 60) * 10) / 10
  }
  状态.updatedAt = now
  状态.lastReason = String(变化.reason || '').slice(0, 300)
  if (变化.reason) {
    状态.lastCause = { id: 'c_' + now, at: now, text: String(变化.reason).slice(0, 120), source: 变化.source || 'judge' }
  }
  状态.lastConfidence = Number(变化.confidence) || 0
  const 条目 = {
    at: now,
    mood: 状态.mood,
    delta: 状态.mood - 前.mood,
    reason: 状态.lastReason,
    conf: Number(变化.confidence) || 0,
    source: 变化.source || 'judge',
    kind: 变化.kind || '',
    dims: { ...状态.dims },
    dimsDelta,
  }
  状态.timeline = (状态.timeline || []).concat(条目).slice(-200)
  return 条目
}

// 文案：缘由 + 心情（两行），绝不出现数字
function 相对时间(ms) {
  const m = Math.round(ms / 60000)
  if (m < 5) return '刚才'
  if (m < 60) return m + ' 分钟前'
  const h = Math.round(m / 60)
  if (h < 12) return '约 ' + h + ' 小时前'
  return '今天早些时候'
}

// 维度只说倾向，不下命令；worry/heartache 合成一条，避免重复追问
const 维度软化 = {
  happy: '忍不住想笑',
  calm: '心是稳的',
  sweet: '更想亲近些',
  heartache: '更留意对方是否安好',
  worry: '更留意对方是否安好',
  sad: '提不起劲',
  jealous: '有点在意比较，可能含蓄试探',
}

function 渲染(状态, cfg) {
  const lines = []
  // 有自然旁白就用它（同一变化只生成一次），否则退回代码拼
  if (cfg.naturalInject !== false && 状态.pendingText && 状态.pendingFor === 状态.updatedAt) {
    const c = 状态.lastCause
    const 头 = c && c.text && Date.now() - Number(c.at) < 6 * 3600000 ? '【缘由】' + 相对时间(Date.now() - Number(c.at)) + '：' + String(c.text).slice(0, 90) : ''
    return (头 ? 头 + '\n' : '') + 状态.pendingText + '\n' + '这些只是背景倾向，不必逐项表现；别重复已经问过的话，具体怎么接看当下聊什么。'
  }
  // ① 缘由：只展示一次、只取六小时内的、措辞带真实时间
  const c = 状态.lastCause
  if (c && c.text && Date.now() - Number(c.at) < 6 * 3600000 && c.id !== 状态.lastCauseShownId) {
    lines.push('【缘由】' + 相对时间(Date.now() - Number(c.at)) + '：' + String(c.text).slice(0, 90))
    状态.lastCauseShownId = c.id
  }
  // ② 心情：档位 + 最多两个维度倾向
  const m = Number(状态.mood) || 0
  const 档 = m < 30 ? '很低落' : m < 50 ? '有点闷' : m < 65 ? '平平稳稳' : m < 80 ? '心里松快' : '心情很好'
  const 句 = {
    很低落: '说话会没力气，不太想接话',
    有点闷: '话会少，也不太想接玩笑',
    平平稳稳: '不多不少，该说说该笑笑',
    心里松快: '说话会轻快一点，愿意多聊两句',
    心情很好: '话会多一点，也想闹一闹',
  }[档]
  const ranked = 维度
    .map((k) => ({ k, v: Number(状态.dims[k]) || 0 }))
    .filter((x) => Math.abs(x.v) >= 4)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
  const 尾 = []
  const 重复档 = { 心里松快: ['happy'], 心情很好: ['happy'], 很低落: ['sad'], 有点闷: ['sad'] }[档] || []
  const 可用 = ranked.filter((x) => !重复档.includes(x.k))
  if (可用[0]) 尾.push(维度软化[可用[0].k])
  if (可用[1]) {
    const 同族 = ['worry', 'heartache'].includes(可用[0].k) && ['worry', 'heartache'].includes(可用[1].k)
    if (!同族 && Math.abs(可用[1].v) >= Math.abs(可用[0].v) * 0.6) 尾.push(维度软化[可用[1].k])
  }
  lines.push('【心情】' + 档 + '，' + 句 + (尾.length ? '，' + 尾.join('，') : '') + '。')
  lines.push('这些只是背景倾向，不必逐项表现；别重复已经问过的话，具体怎么接看当下聊什么。')
  return lines.join('\n')
}

// 自然旁白：给模型「事实 + 心情」，让它写 1~2 句内心话；不喂它任何它不该知道的东西
function 生成旁白(ctx, cfg, 状态, 变化, agent) {
  const 档 = (function () {
    const m = Number(状态.mood) || 0
    return m < 30 ? '很低落' : m < 50 ? '有点闷' : m < 65 ? '平平稳稳' : m < 80 ? '心里松快' : '心情很好'
  })()
  const 维度行 = 维度
    .filter((k) => Math.abs(Number(状态.dims[k]) || 0) >= 3)
    .map((k) => 维度名[k] + Math.round(Number(状态.dims[k]) || 0))
    .join('、') || '（无明显波动）'
  const 事实 = String((变化 && 变化.reason) || '').slice(0, 120)
  const 系统 = [
    '你在写一条鱼的内心旁白。只写她此刻心里的状态，1~2 句，总共不超过 40 个汉字。',
    '要求：第一人称；口语；不带任何数字；不写"事件""原因""系统"这类词；',
    '只能围绕我给你的「刚发生的事」和「当前情绪」写，不许补充这两项里没有的事实、时间、人名或细节。',
    '不要命令她怎么说话，只描述心里是什么感觉。直接输出这句话，不要引号、不要解释。',
  ].join('\n')
  const 输入 = '刚发生的事：' + (事实 || '（无）') + '\n当前情绪：' + 维度行 + '\n整体：' + 档
  let 用agent = agent
  if (!用agent) {
    try {
      const list = ctx.agents.list() || []
      用agent = list.find((a) => String(a.session && a.session.id) === String(cfg.targetSession)) || list[0] || null
    } catch (error) {}
  }
  const t = 取模型(ctx, 用agent, cfg) || null
  if (!t) return Promise.resolve(null)
  return (async () => {
    let 出 = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: t.provider,
        model: t.model,
        system: 系统,
        messages: [{ role: 'user', content: [{ type: 'text', text: 输入 }], source: { kind: 'plugin', plugin: 'dsh-mood' } }],
        maxTokens: 120,
        temperature: 0.8,
      })) {
        if (chunk && chunk.type === 'text-delta') 出 += chunk.text
      }
    } catch (error) {
      return null
    }
    const 净 = String(出 || '').replace(/[\r\n]+/g, ' ').replace(/^["'「」]+|["'「」]+$/g, '').trim()
    if (!净 || 净.length > 80) { 记账('旁白被丢弃（长度 ' + 净.length + '）'); return null }
    状态.pendingText = 净
    状态.pendingFor = 状态.updatedAt
    记账('旁白：' + 净)
    return 净
  })()
}

export function apply(ctx) {
  写默认配置()
  let cfg = 读配置()
  const 状态 = 读状态(cfg)
  const mounted = new Map()
  let 当前agent = null
  let 判链 = Promise.resolve()

  function 存盘() {
    存状态(状态)
  }

  function 排旁白(变化) {
    if (cfg.naturalInject === false) return
    void 生成旁白(ctx, cfg, 状态, 变化, 当前agent)
      .then((s) => { if (s) 存盘() })
      .catch((e) => 记账('旁白失败：' + String(e && e.message)))
  }

  // 插件互联：读 ~/.dsh/mood/inbox.jsonl（sulk/feeling/life 往这里追加事件）
  const 收件箱路径 = join(家, 'mood', 'inbox.jsonl')
  let 收件箱偏移 = 0
  try { if (existsSync(收件箱路径)) 收件箱偏移 = readFileSync(收件箱路径, 'utf8').length } catch (error) {}
  function 读收件箱() {
    try {
      if (!existsSync(收件箱路径)) return
      const 全文 = readFileSync(收件箱路径, 'utf8')
      if (全文.length <= 收件箱偏移) return
      const 新 = 全文.slice(收件箱偏移)
      收件箱偏移 = 全文.length
      for (const 行 of 新.split('\n')) {
        if (!行.trim()) continue
        let ev
        try { ev = JSON.parse(行) } catch { continue }
        if (ev && ev.kind === 'proactive_opportunity') {
          排旁白({ reason: ev.reason, kind: ev.kind, source: ev.source })
          记账('主动机会：' + String(ev.reason || '').slice(0, 60))
          continue
        }
        const 条目 = 应用(状态, cfg, {
          moodDelta: ev.moodDelta, dims: ev.dims, reason: ev.reason,
          source: ev.source || 'inbox', kind: ev.kind,
        })
        存盘()
        if (Math.abs(条目.delta) >= Number(cfg.sigMood || 2) || Object.keys(条目.dimsDelta || {}).length) 排旁白({ reason: ev.reason, kind: ev.kind, source: ev.source })
        记账('外部事件（' + 条目.source + '/' + (条目.kind || '') + '）mood=' + 状态.mood + ' delta=' + 条目.delta + '（' + (条目.reason || '') + '）')
      }
    } catch (error) {}
  }

  function tick() {
    try {
      cfg = 读配置()
      读收件箱()
      if (!cfg.enabled) return
      if (衰减(状态, cfg, Date.now())) 存盘()
      if (!cfg.targetSession) return
      const list = ctx.agents.list() || []
      for (const agent of list) {
        const sid = 会话id(agent.session)
        if (!sid || sid !== cfg.targetSession || mounted.has(sid)) continue
        try {
          当前agent = agent
          mounted.set(sid, 挂到(agent, sid))
          记账('已挂心情到 ' + sid)
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
    let 最近文本 = ''
    const offs = []

    try {
      offs.push(
        agent.ctx.on('agent/inbox/inserted', (payload) => {
          const msg = payload && payload.message ? payload.message : payload
          const src = msg && msg.source && msg.source.kind ? String(msg.source.kind) : ''
          if (src === 'sulk' || src === 'speak-up' || src === 'feeling' || src === 'mood') return
          const txt = 取文本(msg)
          if (txt) 最近文本 = txt
        }),
      )
    } catch (error) {
      记账('监听 inbox 失败：' + String(error && error.message))
    }

    try {
      offs.push(
        agent.ctx.on('agent/turn-stopping', () => {
          if (!cfg.enabled || !cfg.autoJudge) return
          const txt = 最近文本
          最近文本 = ''
          if (!txt) return
          判链 = 判链
            .then(() => 判断(ctx, agent, txt))
            .catch((e) => 记账('判断异常：' + String(e && e.message)))
        }),
      )
    } catch (error) {
      记账('监听 turn-stopping 失败：' + String(error && error.message))
    }

    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'mood',
          order: 920,
          text: () => {
            try {
              if (!cfg.enabled || cfg.injectMode === 'off') return ''
              if (状态.injectedFor === 状态.updatedAt) return ''
              if (Number(状态.lastConfidence) < Number(cfg.injectConfidence)) return ''
              const 今天0点 = new Date()
              今天0点.setHours(0, 0, 0, 0)
              const 今天说过 = (状态.saidAt || []).filter((t) => Number(t) >= 今天0点.getTime()).length
              if (今天说过 >= Number(cfg.injectPerDay || 6)) return ''
              状态.injectedFor = 状态.updatedAt
              状态.saidAt = (状态.saidAt || []).concat(Date.now()).slice(-60)
              存盘()
              return 渲染(状态, cfg)
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

  async function 判断(ctx, agent, 文本) {
    const t = 取模型(ctx, agent, cfg)
    if (!t) return
    const 系统 = [
      '你是情绪判断器。只输出一个 JSON 对象，不要解释，不要 Markdown。',
      '格式：{"moodDelta":-3,"dims":{"happy":-2,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0},"reason":"一句中文理由","inner":"1~2 句第一人称内心话，不超过 40 字","confidence":0-100}',
      'inner 只围绕这一轮**实际发生过的事**和当前情绪写，不带任何数字，不补充没发生过的细节、时间、人名；语气像她自己在心里嘀咕。',
      '判断依据：她这一轮遇到的事、被怎样对待、说的话里的情绪。',
      '⚠ 不要因为「用户惹她生气」「用户不回消息」「用户指责她」就降低 mood——那是怨气，归别的模块管。',
      '在这里只判断她自己的心境：被关心、被夸、被逗、聊得开心 → 升；被冷落之外的真实难过（担心、心累、失望）→ 降。',
      'moodDelta 一般在 -5~+5，dims 每项 -8~+8；没有明显情绪就返回 0 和空 dims。',
    ].join('\n')
    let 出 = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: t.provider,
        model: t.model,
        system: 系统,
        messages: [{ role: 'user', content: [{ type: 'text', text: 文本 }], source: { kind: 'plugin', plugin: 'dsh-mood' } }],
        maxTokens: 300,
        temperature: 0,
      })) {
        if (chunk && chunk.type === 'text-delta') 出 += chunk.text
      }
    } catch (error) {
      记账('判断失败：' + String((error && error.message) || error))
      return
    }
    let j = null
    try {
      const m = 出.match(/\{[\s\S]*\}/)
      j = JSON.parse(m ? m[0] : '{}')
    } catch (error) {
      记账('解析失败：' + 出.slice(0, 120))
      return
    }
    const conf = Number(j.confidence) || 0
    if (conf < 40) {
      记账('置信度太低，跳过（' + conf + '）')
      return
    }
    const 条目 = 应用(状态, cfg, { ...j, confidence: conf, source: 'judge' })
      if (j && j.inner && String(j.inner).trim().length >= 4) {
        状态.pendingText = String(j.inner).replace(/[\r\n]+/g, ' ').slice(0, 80)
        状态.pendingFor = 状态.updatedAt
      }
      排旁白({ reason: j.reason, source: 'judge' })
    存盘()
    记账('心情更新 mood=' + 状态.mood + ' delta=' + 条目.delta + '（' + (j.reason || '') + '）')
  }

  // ---------- HTTP ----------
  function 读体(req) {
    return new Promise((resolve, reject) => {
      let 全 = ''
      req.on('data', (c) => {
        全 += c
        if (全.length > 200000) req.destroy()
      })
      req.on('end', () => resolve(全 || '{}'))
      req.on('error', reject)
    })
  }

  function 发(res, obj, code) {
    res.statusCode = code || 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-mood/state',
      handler: async (req, res) => {
        try {
          衰减(状态, cfg, Date.now())
          发(res, { ok: true, cfg, state: { ...状态, timeline: (状态.timeline || []).slice(-30) } })
        } catch (error) {
          发(res, { ok: false, error: String(error && error.message) }, 500)
        }
      },
    }))

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-mood/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = JSON.parse(await 读体(req))
            cfg = { ...cfg, ...body }
            writeFileSync(配置路径, JSON.stringify(cfg, null, 2), 'utf8')
            记账('配置已更新')
          }
          发(res, { ok: true, cfg })
        } catch (error) {
          发(res, { ok: false, error: String(error && error.message) }, 500)
        }
      },
    }))

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-mood/apply',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return 发(res, { ok: false, error: 'POST only' }, 405)
          const body = JSON.parse(await 读体(req))
          const 条目 = 应用(状态, cfg, {
            moodDelta: body.moodDelta,
            dims: body.dims,
            reason: body.reason,
            confidence: Number(body.confidence) || 80,
            source: String(body.source || 'manual'),
            kind: String(body.kind || ''),
          })
          存盘()
          记账('外部事件（' + 条目.source + (条目.kind ? '/' + 条目.kind : '') + '）mood=' + 状态.mood + ' delta=' + 条目.delta + '（' + (body.reason || '') + '）')
          发(res, { ok: true, state: { ...状态, timeline: (状态.timeline || []).slice(-30) } })
        } catch (error) {
          发(res, { ok: false, error: String(error && error.message) }, 500)
        }
      },
    }))

    // 预览当前会注入什么（调试/设置页用）
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-mood/preview',
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, mood: 状态.mood, dims: 状态.dims, text: 渲染(状态, cfg) }))
      },
    }))
  } catch (error) {}

  ctx.effect(() => ctx.interval(tick, 30000))
  } catch (error) {
    记账('注册路由/定时失败：' + String(error && error.message))
  }

  ctx.effect(() => () => {
    for (const [, off] of mounted) {
      try {
        off()
      } catch (error) {}
    }
    mounted.clear()
    存盘()
  })

  tick()
  存盘()
  记账('已装好 v0.1.0｜目标 ' + (cfg.targetSession || '（未配置）') + '｜mood=' + 状态.mood + '｜库 ' + 状态路径)
}
