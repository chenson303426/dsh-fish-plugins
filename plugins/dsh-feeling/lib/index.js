// dsh-feeling · 宿主半边
//
// 感情账本 v1：每个「鱼 → 对象」一份关系状态 + 未解决事项 + 原始事件。
//
// 设计约束（与 Codex 定稿）：
//   · 事件先入 events（带证据 / 去重键 / 确认状态），代码再决定是否应用
//   · 模型只提候选（kind + 证据 + 解读），不直接写分数
//   · 分数变化由代码的规则表算，带单事件上限与 24h 滚动上限
//   · 未解决事项单独存，可以一直生气；衰减有 floor，不自动清零
//   · 注入只给「等级 + 原因 + 当前反应」，不给数字

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { openStore, ensureObject, getObject, insertEvent, insertMatter, openMatters, updateObject, updateMatter, updateEventResult, recordSilence, insertExpectation, pendingExpectations, closeExpectation } from './store.js'
import { renderContext } from './render.js'
import { loadTime, saveTime, onUser, onReply, renderTime } from './time.js'
import { 默认规则, loadAvailability, saveAvailability, ensureDay, coveredMs, isAsleep, tickSleepLog, renderSleepLog, activityAt } from './availability.js'

export const name = 'feeling'
export const inject = ['systemPrompt', 'agents', 'llm', 'timer', 'webServer']

const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置路径 = join(家, 'feeling-config.json')
const 库目录 = join(家, 'feeling')
const 日志路径 = join(家, 'feeling.log')

const 默认配置 = {
  enabled: true,
  fishId: 'fish:default',
  targetSession: '',
  displayName: '阿元',
  judgeProvider: '',
  judgeModel: '',
  injectOrder: 910,
  maxEventsPerTurn: 2,
  eventTtlMinutes: 10,
  caps: { warmth: 3, trust: 4, intimacy: 2, reaction: 15 },
  rolling24h: { warmth: 6, trust: 8, intimacy: 4 },
  decay: { angerHours: 6, hurtHours: 18 },
  sleep: { start: [23, 30], end: [8, 0] },
  expectationGraceMinutes: 15,
}

// kind → 规则（代码算分，不信模型给的数字）
const 规则 = {
  // —— 正面 ——
  praise: { warmth: 0.5, cooldownMin: 10 },
  remembered_detail: { warmth: 0.5, intimacy: 1, cooldownMin: 60 }, // 记得她说过的小事
  quality_time: { warmth: 0.5, intimacy: 1, cooldownMin: 240 }, // 认真聊了很久
  comfort_given: { warmth: 0.5, reduceAnger: 1.5, reduces: ['accusation', 'dismissive', 'disagreement'], cooldownMin: 30 },
  apology: { trust: 0.5, reduceAnger: 2, reduces: ['broken_promise', 'boundary', 'insult'], cooldownMin: 30 }, // 你道歉（只对相关事项有效）
  boundary_respected: { trust: 1.5, warmth: 0.5, cooldownMin: 60 }, // 她说不，你就停
  promise_kept: { warmth: 1, trust: 2, intimacy: 0.5, reduceAnger: 1.5, reduces: ['broken_promise'], cooldownMin: 0 },
  share_answered: { warmth: 1, trust: 1, intimacy: 1, cooldownMin: 30 },
  // —— 中性/摩擦 ——（anger 已按 Codex 建议整体 ×0.5）
  ordinary_disagreement: { matter: { kind: 'disagreement', anger: 2, floor: 0.6 }, cooldownMin: 120 },
  dismissive: { warmth: -0.3, matter: { kind: 'dismissive', anger: 1.5, floor: 0.45 }, cooldownMin: 30 }, // 敷衍
  comparison: { warmth: -0.5, matter: { kind: 'comparison', anger: 3, floor: 0.9 }, cooldownMin: 120 }, // 拿她跟别人比
  // —— 负面 ——
  promise_broken: { warmth: -1, trust: -3, matter: { kind: 'broken_promise', anger: 4, floor: 1.2 }, cooldownMin: 0 },
  insult: { warmth: -3, trust: -4, intimacy: -1, matter: { kind: 'insult', anger: 6, floor: 1.8 }, cooldownMin: 0 },
  boundary_violation: { warmth: -1, trust: -2, matter: { kind: 'boundary', anger: 5, floor: 1.5 }, cooldownMin: 0 },
  // —— 方向纠正用的两类 ——
  accusation: { matter: { kind: 'accusation', anger: 3, floor: 0.9 }, cooldownMin: 30 },
  fish_fault: { matter: { kind: 'fish_fault', anger: 1, floor: 0.3 }, cooldownMin: 0 },
}

function 读配置() {
  try {
    const raw = JSON.parse(readFileSync(配置路径, 'utf8'))
    return { ...默认配置, ...raw, caps: { ...默认配置.caps, ...(raw.caps || {}) }, rolling24h: { ...默认配置.rolling24h, ...(raw.rolling24h || {}) }, decay: { ...默认配置.decay, ...(raw.decay || {}) } }
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

function 记账(话) {
  const 行 = new Date().toISOString() + '  ' + 话
  try {
    appendFileSync(日志路径, 行 + '\n', 'utf8')
  } catch (error) {}
  console.log('[feeling] ' + 话)
}

function 会话id(会话) {
  const s = 会话 && 会话.id
  return s ? String(s) : ''
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

const 心情映射 = {
  praise: { moodDelta: 1, dims: { happy: 2 } },
  remembered_detail: { moodDelta: 1, dims: { sweet: 2 } },
  comfort_given: { moodDelta: 1, dims: { sweet: 1, sad: -1 } },
  apology: { moodDelta: 1, dims: { sad: -1 } },
  promise_kept: { moodDelta: 2, dims: { happy: 2, sweet: 1 } },
  share_answered: { moodDelta: 1, dims: { happy: 1 } },
  boundary_respected: { moodDelta: 1, dims: { calm: 1 } },
  ordinary_disagreement: { moodDelta: -1, dims: { sad: 1 } },
  dismissive: { moodDelta: -1, dims: { sad: 1 } },
  comparison: { moodDelta: -1, dims: { jealous: 2 } },
  accusation: { moodDelta: -1, dims: { sad: 1 } },
  promise_broken: { moodDelta: -2, dims: { sad: 2, heartache: 1 } },
  boundary_violation: { moodDelta: -2, dims: { sad: 2 } },
  insult: { moodDelta: -3, dims: { sad: 3 } },
}

function 写心情事件(kind, reason) {
  const m = 心情映射[kind]
  if (!m) return
  try {
    mkdirSync(join(家, 'mood'), { recursive: true })
    appendFileSync(
      join(家, 'mood', 'inbox.jsonl'),
      JSON.stringify({ id: 'mood_' + randomUUID(), at: Date.now(), source: 'feeling', kind, ...m, reason }) + '\n',
      'utf8',
    )
  } catch (error) {}
}

function 去重键(targetId, kind, msgIds) {
  const base = targetId + '|' + kind + '|' + [...msgIds].sort().join(',')
  return createHash('sha1').update(base).digest('hex')
}

function 衰减愤怒(matter, cfg) {
  const 起始 = Number(matter.anger) || 0
  const floor = Number(matter.anger_floor) || 0
  if (起始 <= floor) return floor
  const 小时 = Math.max(0, (Date.now() - Number(matter.updated_at || Date.now())) / 3600000)
  const 当前 = floor + (起始 - floor) * Math.pow(2, -小时 / (cfg.decay.angerHours || 6))
  return Math.max(floor, Math.min(100, 当前))
}

export function apply(ctx) {
  写默认配置()
  let cfg = 读配置()
  const db = openStore(join(库目录, 'feeling.db'))
  const 时间路径 = join(库目录, 'time.json')
  const 作息规则路径 = join(家, 'availability-config.json')
  const 作息状态路径 = join(库目录, 'availability-state.json')
  const 作息文件 = join(库目录, 'availability.json')
  let 作息规则 = 默认规则
  try { if (existsSync(作息规则路径)) 作息规则 = { ...默认规则, ...JSON.parse(readFileSync(作息规则路径, 'utf8')) } } catch (error) {}
  const 作息 = loadAvailability(作息文件, 作息规则)
  const 我 = 作息规则.actors['fish:default'] ? 'fish:default' : Object.keys(作息规则.actors)[0]
  const 他 = 作息规则.actors['person:qq:<你的QQ号>'] ? 'person:qq:<你的QQ号>' : Object.keys(作息规则.actors).find((k) => k.startsWith('person:')) || 'person:qq:<你的QQ号>'
  let 时间 = loadTime(时间路径)
  const mounted = new Map()

  const 上次同类 = new Map()

  function 应用事件(ev, cfg) {
    const rule = 规则[ev.kind]
    if (!rule) return null
    // 同类冷却：防止「换句话夸十次」把分数刷满
    const cd = Number(rule.cooldownMin || 0)
    const 冷却键 = ev.targetId + '|' + ev.kind
    if (cd > 0) {
      const last = Number(上次同类.get(冷却键) || 0)
      if (Date.now() - last < cd * 60000) return { skipped: 'cooldown' }
    }
    const 强度 = Math.max(0.2, Math.min(1, Number(ev.severity) || 1))
    const fishId = cfg.fishId
    const obj = getObject(db, fishId, ev.targetId) || ensureObject(db, fishId, ev.targetId, 'person', ev.name || null)
    const patch = {}
    for (const k of ['warmth', 'trust', 'intimacy', 'admiration', 'support_reliance']) {
      if (typeof rule[k] === 'number') {
        const cap = k === 'warmth' ? cfg.caps.warmth : k === 'trust' ? cfg.caps.trust : cfg.caps.intimacy
        const 变化 = Math.max(-cap, Math.min(cap, rule[k] * 强度))
        const cur = Number(obj[k]) || 0
        const next = cur + 变化
        patch[k] = k === 'warmth' ? Math.max(-100, Math.min(100, next)) : Math.max(0, Math.min(100, next))
      }
    }
    if (Object.keys(patch).length) updateObject(db, fishId, ev.targetId, patch)
    // 修复：哄/道歉/兑现约定 → 只对**相关事项**降愤怒，且不低于 floor
    if (typeof rule.reduceAnger === 'number') {
      const open = openMatters(db, fishId, ev.targetId)
      const 可减 = new Set(rule.reduces || [])
      const m = open.find((x) => 可减.has(String(x.kind)))
      if (m) {
        const floor = Number(m.anger_floor) || 0
        const 当前 = 衰减愤怒(m, cfg)
        const 之后 = Math.max(floor, 当前 - rule.reduceAnger * 强度)
        updateMatter(db, m.id, { anger: 之后 })
      }
    }
    let matterId = null
    if (rule.matter) {
      // 合并：同 kind + 24 小时内 → 只补证据与愤怒，不新增事项
      const 旧 = openMatters(db, fishId, ev.targetId).find(
        (m) => String(m.kind) === String(rule.matter.kind) && Date.now() - Number(m.created_at) < 24 * 3600 * 1000,
      )
      if (旧) {
        const 当前 = 衰减愤怒(旧, cfg)
        const 增量 = Math.min(8, rule.matter.anger * 强度) // 同一事项 24h 内最多 +8
        updateMatter(db, 旧.id, { anger: Math.min(20, 当前 + 增量) })
        matterId = 旧.id
      } else {
        const id = 'matter_' + randomUUID()
        insertMatter(db, {
          id,
          fishId,
          targetId: ev.targetId,
          kind: rule.matter.kind,
          reason: ev.interpretation || ev.evidence || '',
          anger: Math.min(20, Math.max(0.3, rule.matter.anger * 强度)),
          angerFloor: Math.min(6, Math.max(0.1, rule.matter.floor * 强度)),
        })
        matterId = id
      }
    }
    上次同类.set(冷却键, Date.now())
    return { patch, matterId, 强度 }
  }

  async function 评估(ctx, agent, sid, 文本, msgIds) {
    const t = 取模型(ctx, agent, cfg)
    if (!t) return
    const 系统 = [
      '你是关系事件抽取器。只输出 JSON 数组，不要解释，不要 Markdown。',
      '任务：从「用户对助手说的话」里，提取 0~2 个有明确证据的关系事件。宁缺毋滥。',
      '',
      '⚠ 先判断方向：是「用户做的」还是「助手做的」？方向错，整条就错。',
      '',
      '正面 kind（按证据选，不要凑数）：',
      'praise=具体夸她；remembered_detail=记得她说过的小事；quality_time=认真聊了很久/陪着她；',
      'comfort_given=用户哄她安慰她；apology=用户道歉；boundary_respected=她说不、用户就停；',
      'promise_kept=用户兑现答应的事；share_answered=用户认真回应她的分享。',
      '',
      '摩擦/负面 kind：',
      'ordinary_disagreement=普通分歧；dismissive=敷衍（"哦""随便"）；comparison=拿她跟别人/AI 比；',
      'promise_broken=**用户自己**明确没做到且无解释；insult=**用户**针对她的人身攻击；',
      'boundary_violation=她拒绝后用户还逼；accusation=用户指责她没做到（≠用户失约）；',
      'fish_fault=证据表明**她**确实没做到。',
      '',
      '规则：玩笑、引用、转述、夸张不算；对象不明不算；不确定就少提或返回 []。',
      '如果用户承认自己没做到某件答应过的事，要同时给 apology 和 promise_broken 两条（这两条不互斥）。',
      'severity 取 0.2~1，表示这条证据有多强（随口一句 0.3，郑重其事 1.0）。',
      '另外：如果用户明确约定了一个时间点（今晚8点、半小时后、明天中午12点），额外给一条',
      '{"kind":"expectation","text":"原话","deadline":"ISO8601（Asia/Shanghai）","precision":"exact|relative|vague"}。',
      '“晚点”“今晚”这种没有具体时刻的，precision 用 vague、deadline 给今天最晚的合理时间也记 vague。',
      '输出形如：[{"kind":"praise","evidence":"原话片段","interpretation":"一句关系意义","severity":0.6,"uncertainty":0.2}]',
    ].join('\n')
    let 出 = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: t.provider,
        model: t.model,
        system: 系统,
        messages: [{ role: 'user', content: [{ type: 'text', text: 文本 }], source: { kind: 'plugin', plugin: 'dsh-feeling' } }],
        maxTokens: 400,
        temperature: 0,
      })) {
        if (chunk && chunk.type === 'text-delta') 出 += chunk.text
      }
    } catch (error) {
      记账('评估失败：' + String((error && error.message) || error))
      return
    }
    let list = []
    try {
      const m = 出.match(/\[[\s\S]*\]/)
      list = JSON.parse(m ? m[0] : '[]')
      if (!Array.isArray(list)) list = []
    } catch (error) {
      记账('解析失败：' + 出.slice(0, 120))
      return
    }
    list = list.slice(0, cfg.maxEventsPerTurn || 2)
    for (const item of list) {
      const kind = String(item && item.kind || '')
      const targetId = cfg.targetId || ('person:qq:' + (cfg.ownerQq || 'unknown'))
      // 约定：不参与打分，只记一条待办
      if (kind === 'expectation') {
        const 时间 = Date.parse(String(item.deadline || ''))
        if (Number.isFinite(时间)) {
          insertExpectation(db, {
            id: 'exp_' + randomUUID(),
            fishId: cfg.fishId,
            targetId,
            promisorId: targetId,
            beneficiaryId: cfg.fishId,
            originalText: String(item.text || item.evidence || '').slice(0, 200),
            deadlineAt: 时间,
            precision: String(item.precision || 'exact'),
            evidenceRef: msgIds[0] || '',
          })
          记账('记下约定：' + String(item.text || '').slice(0, 60) + ' @ ' + new Date(时间).toLocaleString('zh-CN'))
        }
        continue
      }
      if (!规则[kind]) continue
      const evidence = String(item.evidence || '').slice(0, 300)
      if (!evidence) continue
      ensureObject(db, cfg.fishId, targetId, 'person', cfg.displayName)
      const ev = {
        id: 'evt_' + randomUUID(),
        fishId: cfg.fishId,
        targetId,
        kind,
        at: Date.now(),
        source: 'user_message',
        sourceMsgIds: msgIds,
        evidence,
        interpretation: String(item.interpretation || '').slice(0, 200),
        severity: Number(item.severity) || 1,
        uncertainty: Number(item.uncertainty) || 0,
        dedupKey: 去重键(targetId, kind, msgIds),
        committed: 1, // 用户消息本身就是既成事实
        expiresAt: Date.now() + (cfg.eventTtlMinutes || 10) * 60000,
      }
      const r = insertEvent(db, ev)
      if (!r.ok) continue
      const applied = 应用事件(ev, cfg)
      if (applied && !applied.skipped) {
        写心情事件(kind, String(item.interpretation || evidence || '').slice(0, 60))
        // 给 mood 用：最近一条事件（不让它自己编）
        try {
          writeFileSync(join(库目录, 'latest-event.json'), JSON.stringify({
            id: ev.id, at: Date.now(), kind,
            interpretation: String(item.interpretation || '').slice(0, 120),
            evidence: String(evidence || '').slice(0, 120),
            targetId,
          }), 'utf8')
        } catch (error) {}
      }
      updateEventResult(db, ev.id, applied && applied.patch, ev.severity)
      记账('事件入账 ' + kind + ' → ' + JSON.stringify(applied && applied.patch) + (applied && applied.matterId ? ' +事项' : ''))
    }
    // 注入文案在下一轮由 systemPrompt.context 现读
  }

  function 挂到(agent, sid) {
    let 最近文本 = ''
    let 最近id = ''
    const offs = []
    try {
      offs.push(
        agent.ctx.on('agent/inbox/inserted', (payload) => {
          const msg = payload && payload.message ? payload.message : payload
          const src = msg && msg.source && msg.source.kind ? String(msg.source.kind) : ''
          if (src === 'speak-up' || src === 'sulk' || src === 'feeling') return
          const txt = 取文本(msg)
          if (!txt) return
          最近文本 = txt
          最近id = String((msg && msg.id) || '')
          // 时间感：记录来信时间 / 交流段 / 结束方式
          try {
            // 约定达成：来信落在截止时间±宽限内
            const grace = (Number(cfg.expectationGraceMinutes) || 15) * 60000
            for (const e of pendingExpectations(db, cfg.fishId, cfg.targetId)) {
              if (!e.deadline_at) continue
              if (Math.abs(Date.now() - Number(e.deadline_at)) <= grace) {
                closeExpectation(db, e.id, 'fulfilled')
                记账('约定达成：' + (e.original_text || ''))
              }
            }
            onUser(时间, Date.now(), txt)
            saveTime(时间路径, 时间)
            作息.lastActivityAt = Date.now()
            saveAvailability(作息文件, 作息)
          } catch (error) {}
        }),
      )
    } catch (error) {
      记账('监听 inbox 失败：' + String(error && error.message))
    }
    try {
      offs.push(
        agent.ctx.on('agent/turn-stopping', () => {
          if (!cfg.enabled) return
          try {
            onReply(时间, Date.now())
            saveTime(时间路径, 时间)
            作息.lastActivityAt = Date.now()
            saveAvailability(作息文件, 作息)
          } catch (error) {}
          const txt = 最近文本
          const id = 最近id
          最近文本 = ''
          最近id = ''
          if (!txt) return
          void 评估(ctx, agent, sid, txt, id ? [id] : []).catch((e) => 记账('回合评估异常：' + String(e && e.message)))
        }),
      )
    } catch (error) {
      记账('监听 turn-stopping 失败：' + String(error && error.message))
    }
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'feeling',
          order: cfg.injectOrder || 910,
          text: () => {
            try {
              if (!cfg.enabled) return ''
              const targetId = cfg.targetId || ('person:qq:' + (cfg.ownerQq || 'unknown'))
              const obj = getObject(db, cfg.fishId, targetId)
              const lines = []
              // ① 时间感（代码算，不调模型）
              try {
                const now = Date.now()
                const 参照 = 时间.lastExchangeEndedAt || 时间.lastUserMessageAt
                let 睡 = 0
                try { 睡 = 参照 ? coveredMs(作息, 作息规则, [我, 他], 参照, now) : 0 } catch (error) {}
                lines.push(renderTime(时间, now, { ...(cfg.sleep || {}), sleepMs: 睡 }))
                const 睡眠行 = renderSleepLog(作息, now)
                if (作息.lastWakeAt && now - 作息.lastWakeAt < 10 * 60000) {
                  lines.push('【刚睡醒】你刚睡了 ' + (作息.lastWakeMinutes || 0) + ' 分钟，刚醒过来，还有点迷糊。')
                }
                if (睡眠行) lines.push(睡眠行)
              } catch (error) {}
              if (!obj) return lines.join('\n')
              const matters = openMatters(db, cfg.fishId, targetId).map((m) => ({ ...m, anger: 衰减愤怒(m, cfg) }))
              const 关系 = renderContext(obj, matters, cfg.displayName)
              if (关系) lines.push(关系)
              return lines.join('\n')
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

  // 导入 sulk 写的沉默观察（只读，按 episode 去重；没有约定就不生成事项）
  let 观察偏移 = 0
  function 导入观察() {
    try {
      const 文件 = join(家, 'sulk', 'observations.jsonl')
      if (!existsSync(文件)) return
      const 全文 = readFileSync(文件, 'utf8')
      if (全文.length <= 观察偏移) return
      const 新 = 全文.slice(观察偏移)
      观察偏移 = 全文.length
      for (const 行 of 新.split('\n')) {
        if (!行.trim()) continue
        let o
        try { o = JSON.parse(行) } catch { continue }
        const 新记录 = recordSilence(db, {
          episodeId: o.silenceEpisodeId || o.id,
          fishId: o.fishId || cfg.fishId,
          targetId: o.targetId || cfg.targetId,
          stage: o.stage,
          observedAt: o.observedAt,
        })
        if (新记录 && o.expectationOccurrenceId) {
          记账('沉默观察命中约定 ' + o.expectationOccurrenceId + '（v1 先只记录，不自动扣分）')
        }
      }
    } catch (error) {}
  }

  // 约定检查：到期未兑现 → 记一次 missed（每条约只记一次）
  function 检查约定() {
    try {
      const grace = (Number(cfg.expectationGraceMinutes) || 15) * 60000
      for (const e of pendingExpectations(db, cfg.fishId, cfg.targetId)) {
        if (!e.deadline_at) continue
        const now = Date.now()
        if (now <= Number(e.deadline_at) + grace) continue
        closeExpectation(db, e.id, 'missed', now)
        const mid = 'matter_' + randomUUID()
        insertMatter(db, {
          id: mid, fishId: cfg.fishId, targetId: cfg.targetId, kind: 'broken_promise',
          reason: '约定没兑现：' + (e.original_text || ''),
          anger: 4, angerFloor: 1.2,
        })
        insertEvent(db, {
          id: 'evt_' + randomUUID(), fishId: cfg.fishId, targetId: cfg.targetId,
          kind: 'promise_broken', at: now, source: 'expectation', sourceMsgIds: [],
          evidence: e.original_text || '', interpretation: '约定到期未兑现',
          severity: 1, dedupKey: 'exp:' + e.id, committed: 1, expiresAt: 0,
        })
        记账('约定到期未兑现：' + (e.original_text || ''))
      }
    } catch (error) {}
  }

  function tick() {
    检查约定();
    try {
      const now = Date.now()
      const d = new Date()
      const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      ensureDay(作息, 作息规则, dayKey)
      const 变 = tickSleepLog(作息, 作息规则, 我, now)
      if (变 && 变.event === 'sleep') 记账('她睡着了（' + 变.kind + '）')
      if (变 && 变.event === 'wake') 记账('她醒了，睡了 ' + 变.minutes + ' 分钟')
      const 她的 = isAsleep(作息, 作息规则, 我, now)
      // 给 sulk 看的共享状态
      const 他的区间 = activityAt(作息, 作息规则, 他, now)
      const 状态文件 = {
        at: now,
        fish: { asleep: Boolean(她的.asleep), ruleId: 她的.interval ? 她的.interval.ruleId : null },
        ownerAway: Boolean(他的区间),
        ownerKind: 他的区间 ? 他的区间.kind : null,
        suppressProactive: Boolean(她的.asleep) || Boolean(他的区间),
      }
      writeFileSync(作息状态路径, JSON.stringify(状态文件, null, 2), 'utf8')
      saveAvailability(作息文件, 作息)
    } catch (error) {}
    导入观察();
    try {
      cfg = 读配置()
      if (!cfg.targetSession) return
      const list = ctx.agents.list() || []
      for (const agent of list) {
        const sid = 会话id(agent.session)
        if (!sid || sid !== cfg.targetSession || mounted.has(sid)) continue
        try {
          mounted.set(sid, 挂到(agent, sid))
          记账('已挂感情到 ' + sid)
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

  // 设置页：读写作息规则
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-feeling/availability',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = JSON.parse(await new Promise((resolve, reject) => {
              let 全 = ''
              req.on('data', (c) => { 全 += c; if (全.length > 200000) req.destroy() })
              req.on('end', () => resolve(全 || '{}'))
              req.on('error', reject)
            }))
            if (body && body.actors) {
              作息规则 = { ...默认规则, ...body }
              writeFileSync(作息规则路径, JSON.stringify(作息规则, null, 2), 'utf8')
              for (const k of Object.keys(作息.days)) delete 作息.days[k]
              记账('作息规则已更新')
            }
          }
          const 状态 = JSON.parse(readFileSync(作息状态路径, 'utf8').toString())
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, rules: 作息规则, state: 状态 }))
        } catch (error) {
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
        }
      },
    }))

    ctx.effect(() => ctx.interval(tick, 3000))
  } catch (error) {
    记账('注册作息设置页失败：' + String(error && error.message))
  }
  ctx.effect(() => () => {
    for (const [, off] of mounted) {
      try {
        off()
      } catch (error) {}
    }
    mounted.clear()
    try {
      db.close()
    } catch (error) {}
  })
  tick()
  记账('已装好 v0.1.0｜目标 ' + (cfg.targetSession || '（未配置）') + '｜库 ' + join(库目录, 'feeling.db'))
}
