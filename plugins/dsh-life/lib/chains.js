// dsh-life · v2 事件链
//
// 原则（Codex 定稿）：
//   · 确定性骨架不变（锚点/槽位/意图）；模型只**偶尔**提一条链
//   · 模型只返回候选 JSON，代码决定接受与否、怎么执行、怎么落库
//   · 只有 status=occurred 的节点才送 mood（moodDelta 固定 0，只发事实）
//   · 每天最多一次模型调用；失败/超时/空 → 当天关闭机会，不重试

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { 种子, 骰 } from './plan.js'

const 允许效果 = [
  'extend_activity',
  'interrupt_activity',
  'reschedule_activity',
  'replace_future_activity',
  'request_nap',
]

const 最早 = [9, 0]
const 最晚 = [22, 0]

function 今日键(now) {
  const d = new Date(now)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function 时(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return [h || 0, m || 0]
}

// 每天一个确定性机会点
export function 确保机会(state, cfg, now) {
  const dayKey = 今日键(now)
  if (state.chainOpportunity && state.chainOpportunity.dayKey === dayKey) return state.chainOpportunity
  const [sh, sm] = 时(cfg.chainWindowStart || '09:00')
  const [eh, em] = 时(cfg.chainWindowEnd || '22:00')
  const 起 = new Date(now)
  起.setHours(sh, sm, 0, 0)
  const 止 = new Date(now)
  止.setHours(eh, em, 0, 0)
  const 跨度 = Math.max(60000, 止.getTime() - 起.getTime())
  const r = 骰(种子(cfg.fishId || 'fish:default', dayKey, 'chain', cfg.chainVersion || 1))
  const 偏移 = r() * 跨度
  state.chainOpportunity = {
    dayKey,
    at: Math.round(起.getTime() + 偏移),
    status: 'open',
    opportunityId: 'opp_' + createHash('sha1').update(dayKey + '|' + (cfg.fishId || '')).digest('hex').slice(0, 12),
  }
  return state.chainOpportunity
}

// 连续两天"打断日程"的链 → 今天跳过
export function 该跳过(state, now) {
  const 前 = (state.chains || []).filter((c) => c.status === 'occurred' || c.status === 'occurring')
  const 最近两天 = []
  for (let i = 0; i < 2; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - 1 - i)
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    最近两天.push(k)
  }
  const 打断类 = 前.filter((c) => {
    if (!最近两天.includes(c.dayKey)) return false
    return (c.effects || []).some((e) => ['interrupt_activity', 'reschedule_activity', 'replace_future_activity'].includes(e.type) && e.status === 'applied')
  })
  return new Set(打断类.map((c) => c.dayKey)).size >= 2
}

export function 该试(state, cfg, now) {
  const opp = 确保机会(state, cfg, now)
  if (opp.status !== 'open') return null
  if (now < opp.at) return null
  if (现在在窗口外(cfg, now)) return null
  if (该跳过(state, now)) {
    opp.status = 'closed'
    opp.reason = '连续两天打断，今天跳过'
    return null
  }
  return opp
}

function 现在在窗口外(cfg, now) {
  const [sh, sm] = 时(cfg.chainWindowStart || '09:00')
  const [eh, em] = 时(cfg.chainWindowEnd || '22:00')
  const d = new Date(now)
  const 分 = d.getHours() * 60 + d.getMinutes()
  return 分 < sh * 60 + sm || 分 > eh * 60 + em
}

// 给模型的输入
export function 造提示(state, cfg, now) {
  const 计划 = (state.plan || [])
    .filter((it) => it.endAt > now)
    .slice(0, 12)
    .map((it) => {
      const a = new Date(it.startAt).toTimeString().slice(0, 5)
      const b = new Date(it.endAt).toTimeString().slice(0, 5)
      return a + '–' + b + ' ' + it.title + (it.objectId ? '（在读书）' : '')
    })
  const 近三天 = (state.chains || []).filter((c) => now - c.createdAt < 3 * 86400000).length
  return [
    '她的今天：',
    ...计划,
    '',
    '最近 3 天已有 ' + 近三天 + ' 条事件链（每天最多 1 条）。',
    '请判断今天要不要发生一件“小插曲”，它必须真的改变后续安排，而不是只写一句气氛。',
    '要求：最多 3 个节点、最多 2 个 effect；宁可不提；不要每天都出事。',
    'effect.type 只能是：extend_activity / interrupt_activity / reschedule_activity / replace_future_activity / request_nap。',
    'request_nap 只有在她的午睡或夜睡窗口内才合法（比如午后小睡、晚上看书看困了直接睡），否则不要提。',
    '示例（不要照抄）：看书看到一半睡着、加班导致晚饭推迟、太累晚上吃了顿好的。',
    '输出严格 JSON：{"chain":{"reason":"一句理由","nodes":[{"at":"21:10","text":"事实描述"}],"effects":[{"type":"extend_activity","params":{"title":"看《X》","minutes":20},"node":0}]}}',
    '如果今天不该有事，输出 {"chain":null}。',
  ].join('\n')
}

// 调模型：10 秒超时，失败返回 null（调用方负责关闭机会）
export async function 提候选(ctx, cfg, state, agent, now) {
  const t = 取模型(ctx, cfg, agent)
  if (!t) return { error: '没有可用模型' }
  const 输入 = 造提示(state, cfg, now)
  let 出 = ''
  const 限时 = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), Number(cfg.chainTimeoutMs) || 10000))
  const 调用 = (async () => {
    try {
      for await (const chunk of ctx.llm.stream({
        provider: t.provider,
        model: t.model,
        system: '你是生活模拟的候选生成器。只输出 JSON，不要解释。',
        messages: [{ role: 'user', content: [{ type: 'text', text: 输入 }], source: { kind: 'plugin', plugin: 'dsh-life' } }],
        maxTokens: 500,
        temperature: 0.7,
      })) {
        if (chunk && chunk.type === 'text-delta') 出 += chunk.text
      }
      return 'done'
    } catch (error) {
      return 'error:' + String((error && error.message) || error)
    }
  })()
  const 谁 = await Promise.race([调用, 限时])
  if (谁 === '__timeout__') return { error: '超时' }
  if (String(谁).startsWith('error:')) return { error: String(谁).slice(6) }
  let j = null
  try {
    const m = 出.match(/\{[\s\S]*\}/)
    j = JSON.parse(m ? m[0] : '{}')
  } catch (error) {
    return { error: '解析失败' }
  }
  return { chain: j && j.chain ? j.chain : null, raw: 出.slice(0, 400) }
}

function 取模型(ctx, cfg, agent) {
  if (cfg.chainProvider && cfg.chainModel) return { provider: cfg.chainProvider, model: cfg.chainModel }
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
  } catch (error) {}
  try {
    const list = ctx.agents.list() || []
    const a = list.find((x) => String(x.session && x.session.id) === String(cfg.targetSession)) || list[0]
    if (a && a.options && a.options.provider && a.options.model) return { provider: a.options.provider, model: a.options.model }
  } catch (error) {}
  return null
}

function 找项(state, 名, now, 只看未来) {
  const plan = state.plan || []
  if (!名) return null
  const 命中 = plan.filter((it) => String(it.title || '').includes(String(名)) || String(it.id) === String(名))
  return 命中.find((it) => (只看未来 ? it.startAt >= now : true)) || null
}

function 冲突(state, 起, 止, 排除id) {
  return (state.plan || []).some((it) => it.id !== 排除id && it.startAt < 止 && it.endAt > 起)
}

// 校验：返回 {ok, errors, cleaned}
export function 校验链(chain, state, cfg, now) {
  const errs = []
  if (!chain || typeof chain !== 'object') return { ok: false, errors: ['空链'] }
  const nodes = Array.isArray(chain.nodes) ? chain.nodes.slice(0, 3) : []
  const effects = Array.isArray(chain.effects) ? chain.effects.slice(0, 2) : []
  if (!nodes.length) errs.push('没有节点')
  if (!effects.length) errs.push('没有效果')
  const cleanNodes = []
  for (const n of nodes) {
    if (!n || !n.text) { errs.push('节点缺 text'); continue }
    const at = 解时间(n.at, now)
    if (!at) { errs.push('节点时间不合法：' + n.at); continue }
    cleanNodes.push({ id: 'node_' + createHash('sha1').update(String(n.text) + at).digest('hex').slice(0, 10), at, text: String(n.text).slice(0, 80), status: 'proposed' })
  }
  const cleanEffects = []
  for (const e of effects) {
    if (!e || !允许效果.includes(e.type)) { errs.push('非法 effect：' + (e && e.type)); continue }
    const params = e.params || {}
    if (e.type === 'extend_activity') {
      const it = 找项(state, params.title || params.itemId, now, false)
      if (!it) { errs.push('extend_activity 找不到活动'); continue }
      if (!(Number(params.minutes) > 0) || Number(params.minutes) > 120) { errs.push('extend_activity 分钟数不合法'); continue }
    }
    if (e.type === 'interrupt_activity') {
      const it = 当前项名(state, now, params.title)
      if (!it) { errs.push('interrupt_activity 没有正在进行的活动'); continue }
    }
    if (e.type === 'reschedule_activity') {
      const it = 找项(state, params.title || params.itemId, now, true)
      if (!it) { errs.push('reschedule_activity 找不到未来活动'); continue }
      const 新起 = 解时间(params.startAt, now)
      const 新止 = 解时间(params.endAt, now) || (新起 && 新起 + (it.endAt - it.startAt))
      if (!新起 || !新止 || 新止 <= 新起) { errs.push('reschedule_activity 时间不合法'); continue }
      if (冲突(state, 新起, 新止, it.id)) { errs.push('reschedule_activity 时间冲突'); continue }
    }
    if (e.type === 'replace_future_activity') {
      const it = 找项(state, params.title || params.itemId, now, true)
      if (!it) { errs.push('replace_future_activity 找不到未来活动'); continue }
      if (!params.with) { errs.push('replace_future_activity 缺 with'); continue }
    }
    if (e.type === 'request_nap' && !在午睡窗口(state, now)) {
      // 不在睡眠窗口：不拒绝整条链，只把这个效果标成取消（节点随之取消）
      cleanEffects.push({
        id: 'eff_' + createHash('sha1').update('nap' + JSON.stringify(params) + cleanNodes.length).digest('hex').slice(0, 10),
        type: e.type, params, node: Number.isInteger(e.node) ? e.node : 0, status: 'cancelled', reason: '不在睡眠窗口',
      })
      continue
    }
    cleanEffects.push({
      id: 'eff_' + createHash('sha1').update(e.type + JSON.stringify(params) + cleanNodes.length).digest('hex').slice(0, 10),
      type: e.type,
      params,
      node: Number.isInteger(e.node) ? e.node : 0,
      status: 'pending',
    })
  }
  return { ok: errs.length === 0, errors: errs, nodes: cleanNodes, effects: cleanEffects }
}

function 当前项名(state, now, 名) {
  const it = (state.plan || []).find((x) => now >= x.startAt && now < x.endAt)
  if (!it) return null
  if (!名) return it
  return String(it.title || '').includes(String(名)) ? it : null
}

function 解时间(s, now) {
  if (!s) return 0
  const str = String(s)
  if (/^\d{1,2}:\d{2}$/.test(str)) {
    const [h, m] = str.split(':').map(Number)
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    return d.getTime()
  }
  const t = Date.parse(str)
  return Number.isFinite(t) ? t : 0
}

// ---- 作息窗口：读「鱼的作息」配置（availability-config.json）----

const 作息配置路径 = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'availability-config.json')

function 转分钟(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const v = Number(m[1]) * 60 + Number(m[2])
  return Number.isFinite(v) ? v : null
}

// 读配置里的夜睡 + 午睡（random_nap 不参与）
export function 读作息窗口() {
  try {
    const raw = readFileSync(作息配置路径(), 'utf8')
    const j = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const rules = ((j.actors || {})['fish:default'] || {}).rules || []
    const 窗 = []
    for (const r of rules) {
      if (!r || r.enabled === false) continue
      if (r.kind !== 'sleep' && r.kind !== 'nap') continue
      const s = 转分钟(r.start)
      const e = 转分钟(r.end)
      if (s === null || e === null) continue
      窗.push({ start: s, end: e, kind: r.kind })
    }
    if (窗.length) return 窗
  } catch (error) {}
  // 兜底：读不到就用合理默认
  return [
    { start: 23 * 60 + 30, end: 8 * 60, kind: 'sleep' },
    { start: 13 * 60, end: 13 * 60 + 30, kind: 'nap' },
  ]
}

// 跨午夜窗口：end <= start 表示跨天
export function 能否现在睡(now) {
  const d = new Date(now)
  const 分 = d.getHours() * 60 + d.getMinutes()
  return 读作息窗口().some((w) =>
    w.end > w.start ? 分 >= w.start && 分 <= w.end : 分 >= w.start || 分 <= w.end,
  )
}

// 兼容旧名字
export function 在午睡窗口(state, now) {
  return 能否现在睡(now)
}

// 接受：落库，状态 scheduled
export function 接受链(state, chain, 校验, now, dayKey) {
  const 条 = {
    chainId: 'chain_' + createHash('sha1').update(dayKey + now).digest('hex').slice(0, 12),
    dayKey,
    opportunityId: (state.chainOpportunity && state.chainOpportunity.opportunityId) || '',
    origin: 'life_simulation',
    generator: 'model',
    status: 'scheduled',
    reason: String((chain && chain.reason) || '').slice(0, 120),
    nodes: 校验.nodes,
    effects: 校验.effects,
    createdAt: now,
  }
  state.chains = (state.chains || []).concat(条).slice(-60)
  return 条
}

// 到点执行（每个 tick 调一次）
export function 执行到点(state, cfg, now, 记事实) {
  const events = []
  for (const chain of state.chains || []) {
    if (chain.status === 'cancelled' || chain.status === 'occurred') continue
    for (let i = 0; i < (chain.nodes || []).length; i++) {
      const node = chain.nodes[i]
      if (node.status !== 'proposed' && node.status !== 'scheduled') continue
      if (node.at > now) continue
      node.status = 'occurred'
      chain.status = 'occurring'
      const 本节点效果 = (chain.effects || []).filter((e) => e.node === i)
      for (const eff of 本节点效果) {
        if (eff.status !== 'pending') continue
        const r = 执行效果(eff, state, now)
        eff.status = r.ok ? 'applied' : 'cancelled'
        eff.appliedAt = now
        eff.reason = r.reason || ''
        if (!r.ok) node.status = 'cancelled'
        events.push({ type: 'effect', effect: eff, ok: r.ok, reason: r.reason })
      }
      const 本节点效果全部取消 = 本节点效果.length > 0 && 本节点效果.every((x) => x.status === 'cancelled')
      if (本节点效果全部取消) node.status = 'cancelled'
      if (node.status === 'occurred') {
        try { 记事实(node, now, chain) } catch (error) {}
        events.push({ type: 'node', node })
      }
    }
    if ((chain.nodes || []).every((n) => ['occurred', 'cancelled'].includes(n.status))) {
      chain.status = chain.nodes.some((n) => n.status === 'occurred') ? 'occurred' : 'cancelled'
    }
  }
  return events
}

function 后移(plan, 从, 毫秒) {
  for (const it of plan) {
    if (it.startAt >= 从) {
      it.startAt += 毫秒
      it.endAt += 毫秒
    }
  }
}

export function 执行效果(eff, state, now) {
  const plan = state.plan || []
  const p = eff.params || {}
  if (eff.type === 'extend_activity') {
    const it = 找项(state, p.title || p.itemId, now, false)
    if (!it) return { ok: false, reason: '找不到活动' }
    const 分 = Math.min(120, Math.max(1, Number(p.minutes) || 0))
    it.endAt += 分 * 60000
    后移(plan, it.endAt - 分 * 60000 + 1, 分 * 60000)
    return { ok: true }
  }
  if (eff.type === 'interrupt_activity') {
    const it = 当前项名(state, now, p.title)
    if (!it) return { ok: false, reason: '没有正在进行的活动' }
    const 计划分 = Math.max(1, (it.endAt - it.startAt) / 60000)
    const 实跑 = Math.max(0, Math.min(计划分, (now - (it.startedAt || it.startAt)) / 60000))
    it.endAt = now
    it.plannedMinutes = 计划分
    it.ranMinutes = 实跑
    it.status = 'interrupted'
    if (state.active === it.id) state.active = null
    return { ok: true }
  }
  if (eff.type === 'reschedule_activity') {
    const it = 找项(state, p.title || p.itemId, now, true)
    if (!it) return { ok: false, reason: '找不到未来活动' }
    const 新起 = 解时间(p.startAt, now)
    const 新止 = 解时间(p.endAt, now) || 新起 + (it.endAt - it.startAt)
    if (!新起 || 新止 <= 新起) return { ok: false, reason: '时间不合法' }
    if (冲突(state, 新起, 新止, it.id)) return { ok: false, reason: '时间冲突' }
    it.startAt = 新起
    it.endAt = 新止
    return { ok: true }
  }
  if (eff.type === 'replace_future_activity') {
    const it = 找项(state, p.title || p.itemId, now, true)
    if (!it) return { ok: false, reason: '找不到未来活动' }
    it.title = String(p.with).slice(0, 30)
    if (p.kind) it.kind = String(p.kind)
    return { ok: true }
  }
  if (eff.type === 'request_nap') {
    if (!在午睡窗口(state, now)) return { ok: false, reason: '不在睡眠窗口' }
    state.napRequestedAt = now
    const it = 当前项名(state, now, p.title)
    if (it) {
      const 计划分 = Math.max(1, (it.endAt - it.startAt) / 60000)
      it.plannedMinutes = 计划分
      it.ranMinutes = Math.max(0, Math.min(计划分, (now - (it.startedAt || it.startAt)) / 60000))
      it.endAt = now
      it.status = 'interrupted'
    }
    return { ok: true }
  }
  return { ok: false, reason: '未知效果' }
}

// 节点事实：只发事实，不发分数
export function 写节点事实(state, 家, node, at, chain) {
  const 条 = { at, dayKey: 今日键(at), kind: 'chain', text: node.text, chainId: chain && chain.chainId }
  state.incidents = (state.incidents || []).concat(条).slice(-300)
  try {
    mkdirSync(join(家, 'life'), { recursive: true })
    appendFileSync(join(家, 'life', 'incidents.jsonl'), JSON.stringify(条) + '\n', 'utf8')
  } catch (error) {}
  try {
    mkdirSync(join(家, 'mood'), { recursive: true })
    appendFileSync(
      join(家, 'mood', 'inbox.jsonl'),
      JSON.stringify({ id: 'mood_life_' + at + '_' + (node.id || ''), at, source: 'life', kind: 'incident', moodDelta: 0, reason: node.text }) + '\n',
      'utf8',
    )
  } catch (error) {}
  return 条
}
