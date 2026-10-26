// dsh-life · 她自己的安排（v1.1）
//
// 四层：想做什么(intention) → 排到哪段(plan) → 实际做了什么(activity) → 读到哪儿(progress)
// 约束：
//   · 局部替换：默认 30 分钟插进晚间窗口，不占满整晚；没空档就保持 pending
//   · 只重排未来未开始的槽位；已开始/已完成的记录不动
//   · 阅读按 activityId 唯一结算：同一活动重复推进不加章
//   · 没材料（material=none）就标 pending_material，不许编"昨天那章"

import { createHash } from 'node:crypto'

const 章节池 = [
  '开头那点事',
  '第一次拐弯',
  '不太对劲',
  '原来如此',
  '有人来了',
  '旧账',
  '雨停之后',
  '另一个版本',
  '说不出口',
  '最后一页之前',
  '空着的座位',
  '回头路',
  '一封没寄出的信',
  '收尾',
  '后记',
]

const 梗概池 = [
  '主角把一件早就该说的事压回心里',
  '一个熟人说漏了嘴，局面开始松动',
  '旧照片被翻出来，前情被重新解释',
  '有人不告而别，留下一句没头没尾的话',
  '计划被打断，只能临时换一条路走',
  '一段关系被摆到台面上，谁都没先低头',
  '下了一场很长的雨，两个人都没走',
  '真相说出口以后，反而更安静了',
  '一个决定做下去，就再回不了头',
  '所有伏笔收在一间空屋子里',
]

function 种子(...p) {
  return createHash('sha1').update(p.join('|')).digest().readUInt32BE(0)
}

function 骰(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function 日键(d) {
  const x = new Date(d)
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')
}

function 时刻(dayKey, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  const [y, mo, d] = dayKey.split('-').map(Number)
  return new Date(y, mo - 1, d, h || 0, m || 0, 0, 0).getTime()
}

// 虚构作品：一次性生成 8~15 章，之后按进度推进，不许每次现编
export function 造虚构章节(title, objectId) {
  const r = 骰(种子(objectId, 'chapters'))
  const 章数 = 8 + Math.floor(r() * 8)
  const 起 = Math.floor(r() * 章节池.length)
  const out = []
  for (let i = 0; i < 章数; i++) {
    out.push({
      n: i + 1,
      title: '第' + (i + 1) + '章 ' + 章节池[(起 + i) % 章节池.length],
      gist: 梗概池[(起 + i * 3) % 梗概池.length],
    })
  }
  return out
}

export function 确保对象(state, input) {
  state.objects = state.objects || []
  const title = String(input.title || '').trim()
  const contentMode = input.contentMode === 'real' ? 'real' : 'fictional'
  const 老 = state.objects.find((o) => o.title === title && o.contentMode === contentMode)
  if (老) return 老
  const objectId = 'obj_' + createHash('sha1').update(title + '|' + contentMode).digest('hex').slice(0, 12)
  const material = input.material || {}
  const o = {
    objectId,
    title,
    author: String(input.author || ''),
    contentMode,
    materialKind: ['chapter', 'excerpt', 'description', 'none'].includes(material.kind) ? material.kind : contentMode === 'fictional' ? 'chapter' : 'none',
    sourceUrl: String(material.url || ''),
    nextPosition: 0,
    lastReadAt: 0,
    createdAt: Date.now(),
  }
  if (contentMode === 'fictional') o.chapters = 造虚构章节(title, objectId)
  if (Array.isArray(material.chapters) && material.chapters.length) {
    o.chapters = material.chapters.map((c, i) => ({ n: i + 1, title: String(c.title || '第' + (i + 1) + '章'), gist: String(c.gist || '') }))
  }
  state.objects.push(o)
  return o
}

// 加一条意图；能排就排，排不上就 pending
export function 加意图(state, cfg, input, dayKey) {
  state.intentions = state.intentions || []
  const object = input.kind === 'reading' ? 确保对象(state, input) : null
  const 条 = {
    id: 'int_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    strength: ['wish', 'decided', 'commitment'].includes(input.strength) ? input.strength : 'decided',
    kind: ['reading', 'game', 'series', 'other'].includes(input.kind) ? input.kind : 'other',
    objectId: object ? object.objectId : '',
    title: String(input.title || '').trim(),
    sourceMessageId: String(input.sourceMessageId || ''),
    timezone: 'Asia/Shanghai',
    windowStart: String(input.windowStart || '19:40'),
    windowEnd: String(input.windowEnd || '22:30'),
    minutes: Math.max(10, Math.min(180, Number(input.minutes) || 30)),
    schedulingPolicy: input.schedulingPolicy === 'recurring' ? 'recurring' : 'once',
    status: 'pending',
    forDay: String(input.forDay || dayKey),
    createdAt: Date.now(),
  }
  state.intentions.push(条)
  return 条
}

// 在晚间窗口里找一个够长的空档，插入一条活动；返回是否排上
export function 排意图(state, cfg, dayKey, dayItems) {
  const 窗口起 = 时刻(dayKey, cfg.eveningStart || '19:40')
  const 窗口止 = 时刻(dayKey, cfg.eveningEnd || '22:30')
  let 排了几条 = 0
  for (const it of (state.intentions || []).filter((x) => String(x.forDay) === String(dayKey) && (x.status === 'pending' || (x.status === 'scheduled' && x.scheduledDay === dayKey)))) {
    const object = it.objectId ? (state.objects || []).find((o) => o.objectId === it.objectId) : null
    const 时长 = Math.min(it.minutes, 180) * 60000
    // 候选空档：窗口内、被现有活动占掉的部分挖掉
    const 占 = dayItems.map((x) => [x.startAt, x.endAt]).sort((a, b) => a[0] - b[0])
    let 缺口 = []
    let cur = 窗口起
    for (const [a, b] of 占) {
      if (b <= 窗口起 || a >= 窗口止) continue
      if (a > cur) 缺口.push([cur, Math.min(a, 窗口止)])
      cur = Math.max(cur, b)
    }
    if (cur < 窗口止) 缺口.push([cur, 窗口止])
    let 够 = 缺口.find(([a, b]) => b - a >= 时长)
    if (!够) {
      // 没有空档：从同一窗口里的一条空闲活动切走一段（intention 优先级高于随机活动）
      const 可挪 = dayItems.find(
        (x) =>
          x.kind === 'activity' && !x.intentionId && x.startAt >= 窗口起 && x.endAt <= 窗口止 &&
          x.endAt - x.startAt >= 时长 + 15 * 60000,
      )
      if (!可挪) continue
      够 = [可挪.startAt, 可挪.startAt + 时长]
      可挪.startAt = 够[1]
      if (可挪.endAt - 可挪.startAt < 20 * 60000) {
        const idx = dayItems.indexOf(可挪)
        if (idx >= 0) {
          可挪.status = 可挪.status === 'running' ? 'interrupted' : 'skipped'
          可挪.ranMinutes = 可挪.status === 'interrupted'
            ? Math.max(0, (Date.now() - (可挪.startedAt || 可挪.startAt)) / 60000)
            : 0
          可挪.plannedMinutes = (可挪.endAt - 可挪.startAt) / 60000
          state.archive = (state.archive || []).concat([可挪]).slice(-50)
          dayItems.splice(idx, 1)
        }
      }
    }
    const id = dayKey + ':intent:' + it.id
    if (dayItems.some((x) => x.id === id)) continue
    dayItems.push({
      id,
      slotId: 'intent:' + it.id,
      kind: 'activity',
      title: it.kind === 'reading' ? '看《' + (object ? object.title : it.title) + '》' : it.title,
      objectId: it.objectId,
      intentionId: it.id,
      startAt: 够[0],
      endAt: 够[0] + 时长,
    })
    it.status = 'scheduled'
    it.scheduledDay = dayKey
    it.scheduledItemId = id
    排了几条++
  }
  dayItems.sort((a, b) => a.startAt - b.startAt)
  return 排了几条
}

// 阅读结算：按运行状态折算，同一 activityId 只算一次
// 选项：{ status: 'completed'|'interrupted'|'skipped', plannedMinutes, ranMinutes }
export function 结算阅读(state, item, at, 选项 = {}) {
  const opt = typeof 选项 === 'number' ? { status: 'completed', ratio: 选项 } : (选项 || {})
  const status = String(opt.status || 'completed')
  state.readings = state.readings || []
  const object = item.objectId ? (state.objects || []).find((o) => o.objectId === item.objectId) : null
  if (!object) return null
  if (object.materialKind === 'none') {
    object.pendingMaterial = true
    return { objectId: object.objectId, pendingMaterial: true }
  }
  if (object.materialKind === 'description' || object.materialKind === 'excerpt') {
    return { objectId: object.objectId, progress: 0, kind: object.materialKind }
  }
  const activityId = String(item.id || item.slotId)
  if (state.readings.some((r) => r.activityId === activityId)) return { duplicate: true }

  const 总章 = (object.chapters && object.chapters.length) || 0
  if (!总章) return null

  const 计划分 = Number(opt.plannedMinutes) || Math.max(1, (Number(item.endAt) - Number(item.startAt)) / 60000)
  const 实跑分 = Number(opt.ranMinutes)
  const 比例 = status === 'completed' ? 1 : Math.max(0, Math.min(1, (Number.isFinite(实跑分) ? 实跑分 : 0) / 计划分))

  let 章数
  if (status === 'completed') {
    // 2~3 章，按 activityId 确定性分配（不用 Math.random，重算不跳）
    章数 = 2 + (骰(种子(activityId, 'chapters'))() < 0.5 ? 0 : 1)
  } else if (status === 'interrupted') {
    章数 = Math.floor(2.5 * 比例)
  } else {
    章数 = 0
  }

  const from = object.nextPosition
  const to = Math.min(总章, from + Math.max(0, 章数))
  state.readings.push({
    activityId, objectId: object.objectId, fromPosition: from, toPosition: to,
    completedAt: at, dayKey: 日键(new Date(at)), status, ranMinutes: Math.round(实跑分 || 0), plannedMinutes: Math.round(计划分),
  })
  if (to > from) {
    object.nextPosition = to
    object.lastReadAt = at
  }
  return { objectId: object.objectId, fromPosition: from, toPosition: to, chapter: to, status, 章数: to - from }
}

// 可分享的阅读记录（sulk 用）：新、未分享、同书 48h 内没提过、7 天内最多 2 次
export function 可分享阅读(state, now = Date.now()) {
  const readings = (state.readings || []).slice().reverse()
  const 分享 = state.shares || []
  for (const r of readings) {
    if (now - r.completedAt > 7 * 24 * 3600000) continue
    if (r.toPosition <= r.fromPosition) continue
    if (分享.some((s) => s.activityId === r.activityId)) continue
    const object = (state.objects || []).find((o) => o.objectId === r.objectId)
    if (!object) continue
    const 同书 = 分享.filter((s) => s.objectId === r.objectId)
    const 最近 = 同书.map((s) => s.at).sort((a, b) => b - a)[0] || 0
    if (now - 最近 < 48 * 3600000) continue
    if (同书.filter((s) => now - s.at < 7 * 24 * 3600000).length >= 2) continue
    const 章 = (object.chapters || []).find((c) => c.n === r.toPosition) || null
    return {
      candidateId: 'cand_' + r.activityId,
      activityId: r.activityId,
      objectId: object.objectId,
      kind: 'reading',
      title: object.title,
      contentMode: object.contentMode,
      summary: 章 ? 章.title + '：' + 章.gist : '读到第 ' + r.toPosition + ' 章',
      completedAt: r.completedAt,
    }
  }
  return null
}
