// dsh-sulk —— 被冷落了会闹脾气的主动搭话
//
// 和 speak-up 的区别只有一件事：**它会先看这段对话是怎么结束的**。
//
//   · 我说完话、她没接        → 场景 ignored，等 10 分钟就可以闹
//   · 她说了「晚安 / 一会儿见」→ 场景 wrapped，等 30 分钟，而且不许赌气
//   · 只是自然停住了          → 场景 idle，等 45 分钟，轻轻问一句
//
// 场景由模型判（一次沉默只判一次，判完缓存），判不出来就退回关键词规则。

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'sulk'
export const inject = ['agents', 'sessions', 'timer', 'webServer', 'llm']

const 源标记 = 'sulk'
const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置路径 = join(家, 'sulk-config.json')
const 日志路径 = join(家, 'sulk.log')

const 默认配置 = {
  enabled: true,
  dryRun: true,                       // 先别真发，只记账
  targets: [],                        // 目标会话 id
  workspace: '',                      // 只列工作目录等于这里的会话；空 = 用宿主启动时的目录
  heartbeatSeconds: 60,
  cooldownMinutes: 10,                // 两次搭话之间至少隔多久
  maxNudgesPerSilence: 2,             // 同一次沉默最多闹几次
  quiet: { start: 1, end: 9 },        // 安静时段，含起不含止；起===止 表示不启用
  model: { provider: '', model: '' }, // 判场景用哪个模型；空 = 用会话自己的
  scenes: {
    ignored: {
      minutes: 10,
      intervalMinutes: 10,
      probability: 0.25,
      afterCooldownMinutes: 30,
      maxPerEpisode: 2,
      prompt: '她十分钟没回我了……有点委屈，想发条消息酸她一句，看她还在不在。',
    },
    wrapped: {
      minutes: 30,
      intervalMinutes: 30,
      probability: 0.1,
      afterCooldownMinutes: 90,
      maxPerEpisode: 1,
      prompt: '她大概忙去了。要不要说句话？不说也行的。',
    },
    idle: {
      minutes: 45,
      intervalMinutes: 45,
      probability: 0.2,
      afterCooldownMinutes: 90,
      maxPerEpisode: 1,
      prompt: '好一会儿没动静了。随便问一句吧，别不理她。',
    },
  },
  dailyCap: 3,
}

// ---------- 配置 & 日志 ----------

function 读配置() {
  try {
    const 原始 = JSON.parse(readFileSync(配置路径, 'utf8'))
    const 配置 = { ...默认配置, ...原始 }
    配置.quiet = { ...默认配置.quiet, ...(原始.quiet || {}) }
    配置.model = { ...默认配置.model, ...(原始.model || {}) }
    配置.scenes = {}
    for (const key of Object.keys(默认配置.scenes)) {
      配置.scenes[key] = { ...默认配置.scenes[key], ...((原始.scenes || {})[key] || {}) }
    }
    if (!Array.isArray(配置.targets)) 配置.targets = []
    return 配置
  } catch (error) {
    return JSON.parse(JSON.stringify(默认配置))
  }
}

function 写默认配置() {
  try {
    if (existsSync(配置路径)) return // ⚠ 只在**没有**配置文件时铺一份，绝不能覆盖用户改过的
    mkdirSync(家, { recursive: true })
    写文件(配置路径, JSON.stringify(默认配置, null, 2))
  } catch (error) {}
}

// 设置页保存时用：只覆盖她动过的那几项，别把没提交的字段抹掉
function 合并配置(现有, 补丁) {
  const 新 = { ...现有 }
  for (const k of ['enabled', 'dryRun']) {
    if (typeof 补丁[k] === 'boolean') 新[k] = 补丁[k]
  }
  for (const k of ['heartbeatSeconds', 'cooldownMinutes', 'maxNudgesPerSilence']) {
    const v = Number(补丁[k])
    if (Number.isFinite(v) && v > 0) 新[k] = v
  }
  if (Array.isArray(补丁.targets)) 新.targets = 补丁.targets.map((x) => String(x)).filter(Boolean)
  if (typeof 补丁.workspace === 'string') 新.workspace = 补丁.workspace
  if (补丁.quiet) {
    新.quiet = {
      start: Number.isFinite(Number(补丁.quiet.start)) ? Number(补丁.quiet.start) : 现有.quiet.start,
      end: Number.isFinite(Number(补丁.quiet.end)) ? Number(补丁.quiet.end) : 现有.quiet.end,
    }
  }
  if (补丁.model) {
    新.model = { provider: String(补丁.model.provider || ''), model: String(补丁.model.model || '') }
  }
  if (补丁.scenes) {
    新.scenes = {}
    for (const key of Object.keys(默认配置.scenes)) {
      const 旧 = 现有.scenes[key] || 默认配置.scenes[key]
      const 送 = 补丁.scenes[key] || {}
      const 分钟 = Number(送.minutes)
      新.scenes[key] = {
        minutes: Number.isFinite(分钟) && 分钟 > 0 ? 分钟 : 旧.minutes,
        prompt: typeof 送.prompt === 'string' && 送.prompt.trim() ? 送.prompt : 旧.prompt,
      }
    }
  }
  return 新
}

function 写文件(路径, 内容) {
  try {
    writeFileSync(路径, 内容, 'utf8')
  } catch (error) {}
}

function 写观察(o) {
  try {
    mkdirSync(join(家, 'sulk'), { recursive: true })
    const 行 = JSON.stringify({
      id: 'obs_' + randomUUID(),
      ...o,
      closedAt: o.closedAt || null,
    })
    appendFileSync(join(家, 'sulk', 'observations.jsonl'), 行 + '\n', 'utf8')
  } catch (error) {}
}

function 写心情(e) {
  try {
    mkdirSync(join(家, 'mood'), { recursive: true })
    appendFileSync(
      join(家, 'mood', 'inbox.jsonl'),
      JSON.stringify({ id: 'mood_' + randomUUID(), at: Date.now(), source: 'sulk', ...e }) + '\n',
      'utf8',
    )
  } catch (error) {}
}

function 记账(话) {
  const 行 = new Date().toISOString() + '  ' + 话
  try {
    appendFileSync(日志路径, 行 + '\n', 'utf8')
  } catch (error) {}
  console.log('[sulk] ' + 话)
}

// ---------- 小工具 ----------

function 找agent(ctx, id) {
  const 原 = String(id == null ? '' : id).trim()
  if (原 === '') return undefined
  const 候选 = [原]
  if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
  else 候选.push('session-' + 原)
  for (const 一个 of 候选) {
    try {
      const a = ctx.agents.get(一个)
      if (a !== undefined) return a
    } catch (error) {}
  }
  return undefined
}

function 取文本(消息) {
  try {
    const 内容 = 消息 && 消息.content
    if (typeof 内容 === 'string') return 内容.slice(0, 300)
    if (!Array.isArray(内容)) return ''
    let 出 = ''
    for (const 段 of 内容) {
      if (段 && 段.type === 'text' && typeof 段.text === 'string') 出 += 段.text
    }
    return 出.replace(/\s+/g, ' ').trim().slice(0, 300)
  } catch (error) {
    return ''
  }
}

function 在安静时段(配置, 现在) {
  const { start, end } = 配置.quiet
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
  const 点 = 现在.getHours()
  if (start < end) return 点 >= start && 点 < end
  return 点 >= start || 点 < end
}

function 取模型(ctx, agent, 配置) {
  const 指定 = 配置.model
  if (指定 && 指定.provider && 指定.model) return { provider: 指定.provider, model: 指定.model }
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
  } catch (error) {}
  try {
    const h = agent && agent.session && agent.session.requestHeader ? agent.session.requestHeader() : null
    const cfg = h && h.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  } catch (error) {}
  try {
    const svc = ctx.get('agentDefaultModel')
    const sel = svc && svc.currentSelection ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

// ---------- 判场景 ----------

const 收尾词 = /(晚安|拜拜|再见|回见|一会儿见|待会儿见|回头聊|先这样|先不聊|去忙|忙去|睡了|去睡|吃饭去|下班|出门|回头说|改天聊)/

function 关键词判(缓冲) {
  const 末 = 缓冲[缓冲.length - 1]
  if (!末) return 'idle'
  if (末.role === 'assistant') return 'ignored'
  if (收尾词.test(末.text || '')) return 'wrapped'
  return 'idle'
}

async function 模型判(ctx, agent, 配置, 缓冲) {
  if (!ctx.llm || typeof ctx.llm.stream !== 'function') return null
  const t = 取模型(ctx, agent, 配置)
  if (!t) return null
  const 对话 = 缓冲
    .slice(-8)
    .map((m) => (m.role === 'user' ? '她：' : '我：') + (m.text || ''))
    .join('\n')
  if (!对话) return null
  const 系统 = '你是一个对话状态判断器。只输出一个标签词，不要解释、不要标点。'
  const 问 =
    '下面是「我」（助手）和「她」（用户）最近的对话。现在她有一段时间没出声了。\n' +
    '判断这次沉默属于哪一种：\n' +
    '- ignored：我说完话之后她就没再出声，像是把我晾着 / 她跑开了\n' +
    '- wrapped：她是正常收尾（晚安、拜拜、一会儿见、去忙、先这样、吃饭去……），对话已经结束\n' +
    '- idle：对话只是自然停住了，既不像把我晾着，也不像正式收尾\n' +
    '只输出 ignored / wrapped / idle 其中一个词。\n\n对话：\n' +
    对话
  let 出 = ''
  try {
    for await (const chunk of ctx.llm.stream({
      provider: t.provider,
      model: t.model,
      system: 系统,
      messages: [{ role: 'user', content: [{ type: 'text', text: 问 }], source: { kind: 'plugin', plugin: 'dsh-sulk' } }],
      maxTokens: 12,
      temperature: 0,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') 出 += chunk.text
    }
  } catch (error) {
    记账('判场景失败（退回关键词）：' + String((error && error.message) || error))
    return null
  }
  const 净 = String(出 || '').toLowerCase()
  for (const key of ['ignored', 'wrapped', 'idle']) {
    if (净.includes(key)) return key
  }
  return null
}

// ---------- 主体 ----------

export function apply(ctx) {
  写默认配置()
  let 配置 = 读配置()
  const 状态 = new Map() // sid -> { lastUserAt, verdict, verdictFor, nudges, lastNudgeAt, buffer }
  let 表 = null
  let 表秒 = 0

  function 取状态(sid) {
    let s = 状态.get(sid)
    if (!s) {
      s = {
        lastUserAt: 0,
        verdict: null,
        verdictFor: 0,
        nudges: 0,
        lastNudgeAt: 0,
        nextRollAt: 0,
        sendLog: [],
        episodeId: randomUUID(),
        anchorMessageId: '',
        observed: new Set(),
        buffer: [],
      }
      状态.set(sid, s)
    }
    return s
  }

  // 记对话：谁说了什么、什么时候
  function 记事件(session, event) {
    const 配置现在 = 配置
    if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) return
    const sid = String(session && session.id)
    if (!sid) return
    if (配置现在.targets.length && !配置现在.targets.includes(sid)) return
    const 消息 = event.data
    const 角色 = event.type === 'user/message' ? 'user' : 'assistant'
    const 来源 = 消息 && 消息.source
    if (角色 === 'user' && 来源 && 来源.kind === 源标记) return // 自己发的催话不算她说
    const s = 取状态(sid)
    const 文 = 取文本(消息)
    s.buffer.push({ role: 角色, text: 文, at: event.time || Date.now() })
    if (s.buffer.length > 16) s.buffer = s.buffer.slice(-16)
    if (角色 === 'user') {
      s.lastUserAt = event.time || Date.now()
      s.verdict = null // 她一说话，上次的判断作废
      s.verdictFor = 0
      s.nudges = 0
      s.nextRollAt = 0
      s.episodeId = randomUUID() // 新的一段沉默
      s.anchorMessageId = String((消息 && 消息.id) || '')
      s.observed = new Set()
    }
  }

  async function 取活agent(ctx, sid) {
    const 现成 = 找agent(ctx, sid)
    if (现成) return 现成
    // 冷会话：试着唤醒它（dsh-schedule 用的也是这条路）
    try {
      const sc = ctx.get('sessionController')
      if (sc && typeof sc.resolveAgent === 'function') {
        const a = await sc.resolveAgent(String(sid))
        if (a) return a
      }
    } catch (error) {
      记账('唤醒会话失败：' + String((error && error.message) || error))
    }
    return undefined
  }

  async function 跑一轮() {
    配置 = 读配置()
    if (!配置.enabled) return
    const 现在 = new Date()
    if (在安静时段(配置, 现在)) return
    // 共享作息：她在睡 或 阿元不在（上班/夜里/午睡）→ 不主动搭话
    try {
      const 状态文件 = join(家, 'feeling', 'availability-state.json')
      if (existsSync(状态文件)) {
        const 作息状态 = JSON.parse(readFileSync(状态文件, 'utf8'))
        if (作息状态 && 作息状态.suppressProactive) {
          const 谁 = 作息状态.fish && 作息状态.fish.asleep ? '她在睡' : '阿元不在'
          if (!globalThis.__sulk_suppress_logged || Date.now() - globalThis.__sulk_suppress_logged > 30 * 60000) {
            globalThis.__sulk_suppress_logged = Date.now()
            记账('暂停搭话（' + 谁 + '）')
          }
          return
        }
      }
    } catch (error) {}
    // 跨天（第一次跑出安静时段时）：重置每段沉默的搭话次数，
    // 这样「很久没回」也不会因为额度用尽而永远沉默——每天还有机会。
    const 今日 = 现在.getFullYear() + '-' + (现在.getMonth() + 1) + '-' + 现在.getDate()
    for (const sid of 配置.targets) {
      let s = 状态.get(String(sid))
      if (!s) {
        s = 取状态(String(sid))
        s.lastUserAt = Date.now() // 宿主刚起来：从现在开始算沉默
      }
      if (s.dayKey !== 今日) {
        if (s.dayKey) 记账('跨天重置额度（' + s.dayKey + ' → ' + 今日 + '）')
        s.dayKey = 今日
        s.nudges = 0
        s.nextRollAt = 0
      }
      if (!s.lastUserAt) continue
      const 沉默分 = (Date.now() - s.lastUserAt) / 60000
      const 最短 = Math.min(...Object.values(配置.scenes).map((x) => Number(x.minutes) || 999))
      if (沉默分 < 最短) continue
      const agent = await 取活agent(ctx, String(sid))
      if (!agent) continue
      // ① 场景：一次沉默只判一次（互斥）
      if (!s.verdict || s.verdictFor !== s.lastUserAt) {
        s.verdict = (await 模型判(ctx, agent, 配置, s.buffer)) || 关键词判(s.buffer)
        s.verdictFor = s.lastUserAt
        s.nudges = 0
        s.nextRollAt = 0
        记账('判场景：' + s.verdict + '（沉默 ' + 沉默分.toFixed(1) + ' 分钟）')
      }
      const 场 = 配置.scenes[s.verdict] || 配置.scenes.idle
      const 首等 = Number(场.minutes) || 45
      const 间隔 = Number(场.intervalMinutes) || 首等
      const 命中率 = Number(场.probability ?? 0.2)
      const 上限 = Number(场.maxPerEpisode ?? 1)
      if (沉默分 < 首等) continue
      // ② 观察记录：每段沉默、每个阶段只写一次（给 feeling 用）
      const 阶段 = s.verdict + ':' + 首等
      if (!s.observed) s.observed = new Set()
      if (!s.observed.has(阶段)) {
        s.observed.add(阶段)
        写观察({
          fishId: 配置.fishId || 'fish:default',
          targetId: 配置.targetId || '',
          sessionId: String(sid),
          silenceEpisodeId: s.episodeId,
          anchorMessageId: s.anchorMessageId || '',
          startedAt: s.lastUserAt,
          observedAt: Date.now(),
          elapsedMs: Date.now() - s.lastUserAt,
          stage: 阶段,
          endingKind: s.verdict === 'wrapped' ? 'wrapped' : 'open',
          expectationOccurrenceId: null,
          monitoringValid: true,
        })
        // 被晾着 → 心情真的会掉一点（不再靠她表演难过）
        if (s.verdict === 'ignored') {
          写心情({ kind: 'silence', moodDelta: -2, dims: { sad: 2, heartache: 1 }, reason: '沉默 ' + Math.round(沉默分) + ' 分钟没回我' })
        } else if (s.verdict === 'idle') {
          写心情({ kind: 'silence', moodDelta: -1, dims: { sad: 1 }, reason: '好一会儿没人说话了' })
        }
      }
      // ③ 骰子：到点才掷，不是每个 tick 都掷
      if (!s.nextRollAt) s.nextRollAt = Date.now() + 间隔 * 60000
      if (Date.now() < s.nextRollAt) continue
      // 每日总上限（滚动 24h）
      const 一天内 = (s.sendLog || []).filter((t) => Date.now() - t < 24 * 3600 * 1000)
      s.sendLog = 一天内
      if (一天内.length >= (配置.dailyCap || 3)) continue
      const 命中 = Math.random() < 命中率
      s.nextRollAt = Date.now() + 间隔 * 60000
      if (!命中) {
        记账('掷骰未中（' + s.verdict + '，命中率 ' + Math.round(命中率 * 100) + '%）')
        continue
      }
      if (s.nudges >= 上限) continue
      const 文案 = String(场.prompt || '')
      if (!文案) continue
      try {
        写心情({ kind: 'proactive_opportunity', moodDelta: 0, reason: '沉默 ' + Math.round(沉默分) + ' 分钟，她想主动开口（' + s.verdict + '）' })
      } catch (error) {}
      if (配置.dryRun) {
        记账('[试运行] 该发（' + s.verdict + '）：' + 文案)
        s.nudges += 1
        s.lastNudgeAt = Date.now()
        s.nextRollAt = Date.now() + Number(场.afterCooldownMinutes || 30) * 60000
        continue
      }
      try {
        await agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: 文案 }],
          source: { kind: 源标记, scene: s.verdict },
        })
        s.nudges += 1
        s.lastNudgeAt = Date.now()
        s.sendLog.push(Date.now())
        s.nextRollAt = Date.now() + Math.max(间隔, Number(场.afterCooldownMinutes || 30)) * 60000
        记账('已搭话（' + s.verdict + '）：' + 文案)
      } catch (error) {
        记账('followup 失败：' + String((error && error.message) || error))
      }
    }
  }

  function 挂表() {
    if (表) return
    if (typeof ctx.interval !== 'function') {
      记账('拿不到 timer 服务（ctx.interval 不在），定时不会跑')
      return
    }
    const 秒 = Math.max(15, Number(配置.heartbeatSeconds) || 60)
    表 = ctx.interval(() => {
      void 跑一轮().catch((error) => 记账('这一轮出错：' + String((error && error.message) || error)))
    }, 秒 * 1000)
    表秒 = 秒
  }

  function 摘表() {
    if (表 && typeof 表 === 'function') 表()
    表 = null
  }

  ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        记事件(session, event)
      } catch (error) {}
    })
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
      摘表()
    }
  })

  ctx.effect(() => {
    挂表()
    const 配置摘要 = 读配置()
    记账(
      '已装好 v0.1.0｜目标 ' +
        (配置摘要.targets.length || 0) +
        ' 个会话｜心跳 ' +
        表秒 +
        's｜' +
        (配置摘要.dryRun ? '**试运行（只记账不真发）**' : '会真发') +
        '｜安静时段 ' +
        配置摘要.quiet.start +
        '~' +
        配置摘要.quiet.end,
    )
    if (!配置摘要.targets.length) 记账('⚠ 还没填 targets，不会触发。编辑 ' + 配置路径)
    return () => 摘表()
  })

  // ---------- 设置页路由（网页半边只读这里）----------

  const 回 = (res, o) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(o))
  }
  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )

  const 读日志 = () => {
    try {
      return readFileSync(日志路径, 'utf8').split('\n').filter(Boolean).slice(-40)
    } catch (error) {
      return []
    }
  }

  // ---------- 会话清单（设置页那个勾选列表）----------
  const 会话键 = (v) => String(v == null ? '' : v).replace(/^session-/, '')

  function 取标题(ctx, id) {
    // ① 标题服务（内存，改名立刻能看到）
    try {
      const 服务 = ctx.get('sessionTitle')
      if (服务 && typeof 服务.get === 'function') {
        let 会话
        try {
          会话 = ctx.sessions.get(String(id))
        } catch (error) {}
        if (会话) {
          const 快照 = 服务.get(会话)
          const 题 = 快照 && typeof 快照.title === 'string' ? 快照.title.trim() : ''
          if (题) return 题
        }
      }
    } catch (error) {}
    // ② 投影缓存（读盘兜底）
    try {
      const 目录 = join(家, 'storages', 'session_projcache', 'sessions')
      for (const 名 of [String(id) + '.json', 'session-' + 会话键(id) + '.json']) {
        const 路 = join(目录, 名)
        if (!existsSync(路)) continue
        const 记 = JSON.parse(readFileSync(路, 'utf8'))
        const 行 = 记 && 记.record && 记.record.rows
        const 题 = (行 && 行.title && 行.title.val) || (行 && 行.titleInput && 行.titleInput.val && 行.titleInput.val.first && 行.titleInput.val.first.text)
        if (typeof 题 === 'string' && 题.trim()) return 题.trim()
      }
    } catch (error) {}
    return ''
  }

  const 读会话工作区 = (id) => {
    try {
      const 目录 = join(家, 'storages', 'session_projcache', 'sessions')
      for (const 名 of [String(id) + '.json', 'session-' + 会话键(id) + '.json']) {
        const 路 = join(目录, 名)
        if (!existsSync(路)) continue
        const 记 = JSON.parse(readFileSync(路, 'utf8'))
        const 行 = 记 && 记.record && 记.record.rows
        const 值 = 行 && 行.workingDirectory && 行.workingDirectory.val
        if (typeof 值 === 'string' && 值.trim()) return 值.trim()
      }
    } catch (error) {}
    return ''
  }

  const 会话清单 = () => {
    const 出 = []
    const 见过 = new Set()
    const 收 = (v) => {
      const id = String(v == null ? '' : v).trim()
      if (!id) return
      const k = 会话键(id)
      if (见过.has(k)) return
      见过.add(k)
      出.push({ id, 标题: 取标题(ctx, id), 活着: 找agent(ctx, id) !== undefined })
    }
    try {
      if (ctx.sessions && typeof ctx.sessions.list === 'function') {
        for (const s of ctx.sessions.list()) 收(s && s.id)
      }
    } catch (error) {}
    try {
      for (const a of ctx.agents.list()) 收(a && a.id)
    } catch (error) {}
    // 兜底：从投影缓存里把「开过但当前没开着」的会话也捞出来，
    // 不然重启之后目标会话不在列表里，就没法勾。
    try {
      const 目录 = join(家, 'storages', 'session_projcache', 'sessions')
      for (const 名 of readdirSync(目录)) {
        if (名.endsWith('.json')) 收(名.replace(/\.json$/, ''))
      }
    } catch (error) {}
    const 勾着 = new Set((读配置().targets || []).map(会话键))
    let 结果 = 出.map((x) => ({ ...x, 勾着: 勾着.has(会话键(x.id)) }))

    // 只留「工作目录 = 这个家」的会话：刷B站的临时会话、别的客户端的会话都不该混进来。
    // 工作目录读不出来的一律保留（宁可多列一个，也别把该勾的藏了）。
    const 期望 = String(读配置().workspace || process.cwd() || '').replace(/[\\/]+$/, '').toLowerCase()
    if (期望) {
      const 过滤后 = 结果.filter((x) => {
        if (x.勾着) return true // 已经勾着的一定留着，不然没法取消
        const 工作区 = 读会话工作区(x.id)
        if (!工作区) return true
        return 工作区.replace(/[\\/]+$/, '').toLowerCase() === 期望
      })
      if (过滤后.length > 0) 结果 = 过滤后
    }

    return 结果.sort((a, b) => {
      if (a.活着 !== b.活着) return a.活着 ? -1 : 1
      return (a.标题 || '\uffff').localeCompare(b.标题 || '\uffff', 'zh')
    })
  }

  路线('/dsh-sulk/sessions', async (req, res) => {
    回(res, { ok: true, 会话: 会话清单() })
  })

  路线('/dsh-sulk/state', async (req, res) => {
    回(res, { ok: true, 配置: 读配置(), 日志: 读日志() })
  })

  路线('/dsh-sulk/save', async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    let 补丁 = {}
    try {
      补丁 = JSON.parse(body || '{}')
    } catch (error) {}
    const 新 = 合并配置(读配置(), 补丁)
    try {
      writeFileSync(配置路径, JSON.stringify(新, null, 2), 'utf8')
      配置 = 新
      记账('设置页保存：试运行=' + 新.dryRun + '｜目标 ' + 新.targets.length + ' 个｜ignored=' + 新.scenes.ignored.minutes + 'min')
      回(res, { ok: true, 配置: 新 })
    } catch (error) {
      回(res, { ok: false, 说: '写不进配置文件：' + String((error && error.message) || error) })
    }
  })

  路线('/dsh-sulk/test', async (req, res) => {
    // 手动演练：立刻判一次场景 + 报「本来要发什么」，不真发
    const 目标 = (配置.targets || [])[0]
    if (!目标) return 回(res, { ok: false, 说: '还没填目标会话' })
    const s = 状态.get(String(目标))
    const agent = 找agent(ctx, 目标)
    if (!agent) return 回(res, { ok: false, 说: '目标会话没活着' })
    const 场景 = (await 模型判(ctx, agent, 配置, s ? s.buffer : [])) || 关键词判(s ? s.buffer : [])
    const 场 = 配置.scenes[场景] || 配置.scenes.idle
    回(res, { ok: true, 场景, 等待分钟: 场.minutes, 文案: 场.prompt, 沉默分钟: s ? (Date.now() - s.lastUserAt) / 60000 : null })
  })
}
