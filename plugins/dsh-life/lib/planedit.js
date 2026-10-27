// dsh-life · 改计划
//
// 只允许改「未来且未开始」的活动；睡眠/三餐/明确约定不许动。
// requestId 幂等；baseVersion 并发检查；每次改动写 planChanges。

const 受保护类型 = new Set(['sleep', 'meal', 'work', 'commute'])

function 重叠(a1, a2, b1, b2) {
  return a1 < b2 && b1 < a2
}

function 在睡眠里(起, 止, 睡眠段) {
  for (const [s, e] of 睡眠段 || []) {
    if (重叠(起, 止, Number(s), Number(e))) return true
  }
  return false
}

function 摘要(状态) {
  return (状态.plan || []).map((it) => ({
    id: it.id,
    title: it.title,
    kind: it.kind,
    start: new Date(it.startAt).toTimeString().slice(0, 5),
    end: new Date(it.endAt).toTimeString().slice(0, 5),
    status: it.status || 'scheduled',
    desireId: it.desireId || null,
  }))
}

export function 编辑计划(状态, 输入, now = Date.now(), 睡眠段 = []) {
  状态.planEditResults = 状态.planEditResults || {}
  状态.planChanges = 状态.planChanges || []
  状态.planVersion = Number(状态.planVersion) || 1

  const requestId = String(输入.requestId || '')
  if (requestId && 状态.planEditResults[requestId]) return { ...状态.planEditResults[requestId], idempotent: true }

  const 失败 = (code, msg) => {
    const r = { ok: false, code, error: msg, version: 状态.planVersion }
    if (requestId) 状态.planEditResults[requestId] = r
    return r
  }

  if (输入.baseVersion !== undefined && Number(输入.baseVersion) !== 状态.planVersion) {
    return 失败('version_conflict', '计划版本已变，请重新读取再改')
  }

  const op = String(输入.op || '')
  if (!['insert', 'move', 'cancel', 'replace'].includes(op)) return 失败('bad_op', '不认识的 op：' + op)

  const 计划 = 状态.plan || []
  let 目标 = null
  if (op !== 'insert') {
    目标 = 计划.find((it) => it.id === String(输入.targetId || ''))
    if (!目标) return 失败('not_found', '找不到这条活动')
    if (受保护类型.has(目标.kind) || 目标.pinned || 目标.expectationId) {
      return 失败('protected', '这条不能动（睡眠/三餐/上班/明确约定）')
    }
    if (Number(目标.startAt) <= now || ['running', 'completed', 'interrupted'].includes(目标.status)) {
      return 失败('past', '只能改还没开始的活动')
    }
  }

  // 新时段
  let 起 = Number((输入.item && 输入.item.startAt) || 0)
  let 止 = Number((输入.item && 输入.item.endAt) || 0)
  if (op === 'cancel') {
    // 不改时间
  } else {
    if (op === 'move') {
      起 = 起 || Number(目标.startAt)
      止 = 止 || (起 + (Number(目标.endAt) - Number(目标.startAt)))
    }
    if (!起 || !止 || 止 <= 起) return 失败('bad_time', '时间不合法')
    if (起 <= now) return 失败('past', '不能排到过去')
    if (在睡眠里(起, 止, 睡眠段)) return 失败('sleep_conflict', '不能排进睡眠时间')
    for (const it of 计划) {
      if (目标 && it.id === 目标.id) continue
      if (重叠(起, 止, Number(it.startAt), Number(it.endAt))) {
        return 失败('overlap', '和「' + it.title + '」时间冲突（' + new Date(it.startAt).toTimeString().slice(0, 5) + '）')
      }
    }
  }

  const 旧值 = 目标 ? { id: 目标.id, title: 目标.title, startAt: 目标.startAt, endAt: 目标.endAt } : null
  let 新值 = null

  if (op === 'insert') {
    const it = {
      id: 输入.item.id || 'edit_' + now,
      slotId: 输入.item.slotId || 'edited',
      kind: 输入.item.kind || 'activity',
      title: String(输入.item.title || '活动'),
      startAt: 起,
      endAt: 止,
      status: 'scheduled',
      source: 'plan_edit',
    }
    计划.push(it)
    新值 = { id: it.id, title: it.title, startAt: 起, endAt: 止 }
  } else if (op === 'move' || op === 'replace') {
    目标.startAt = 起
    目标.endAt = 止
    if (op === 'replace') {
      目标.title = String((输入.item && 输入.item.title) || 目标.title)
      目标.kind = (输入.item && 输入.item.kind) || 目标.kind
      目标.source = 'plan_edit'
    }
    新值 = { id: 目标.id, title: 目标.title, startAt: 起, endAt: 止 }
  } else if (op === 'cancel') {
    目标.status = 'cancelled'
    新值 = { id: 目标.id, title: 目标.title, cancelled: true }
  }

  计划.sort((a, b) => Number(a.startAt) - Number(b.startAt))
  状态.plan = 计划
  状态.planVersion += 1
  状态.planChanges = [
    ...状态.planChanges,
    { at: now, op, reason: String(输入.reason || ''), 旧值, 新值, version: 状态.planVersion },
  ].slice(-100)

  const r = { ok: true, op, version: 状态.planVersion, plan: 摘要(状态) }
  if (requestId) 状态.planEditResults[requestId] = { ok: true, op, version: 状态.planVersion, plan: r.plan }
  return r
}
