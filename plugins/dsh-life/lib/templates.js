// dsh-life · 相邻日程联动模板
//
// 用法：代码按当前时间挑出 3~5 个候选 → 模型只选一个 id 或返回 null，并补一句细节
// 后果（effects）只能来自这里；模型不能发明新效果

export const 模板 = [
  // ---------- morning -> commute ----------
  {
    id: 'morning_snooze_breakfast',
    transition: 'morning->commute',
    requires: ['has_commute', 'has_breakfast_slot'],
    impactLevel: 'minor',
    durationMinutes: [5, 10],
    domains: ['energy'],
    effects: [{ op: 'reschedule', role: 'nextMeal', delayMinutes: 15 }],
    summaryPattern: '早上多赖了几分钟，来不及坐下吃早饭，出门路上买了个包子带走。',
  },
  {
    id: 'morning_key_hunt',
    transition: 'morning->commute',
    requires: ['has_commute'],
    impactLevel: 'minor',
    durationMinutes: [5, 10],
    domains: ['mood'],
    effects: [{ op: 'reschedule', role: 'nextCommute', delayMinutes: 5 }],
    summaryPattern: '出门前找不到钥匙，翻了半天，出门比平时晚了几分钟。',
  },
  {
    id: 'morning_prepared',
    transition: 'morning->commute',
    requires: [],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['mood'],
    effects: [{ op: 'record' }],
    summaryPattern: '前一晚就把东西收拾好了，早上出门很从容。',
  },

  // ---------- commute -> work ----------
  {
    id: 'commute_standing',
    transition: 'commute->work',
    requires: ['has_work'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['energy'],
    effects: [{ op: 'record' }],
    summaryPattern: '通勤一路站着，到单位先坐下来喝了点水。',
  },
  {
    id: 'commute_idea',
    transition: 'commute->work',
    requires: ['has_work'],
    impactLevel: 'minor',
    durationMinutes: [10, 20],
    domains: ['mood'],
    effects: [{ op: 'reschedule', role: 'nextWork', delayMinutes: 10 }],
    summaryPattern: '路上想到昨天卡住的那个问题，到单位先试了这个办法。',
  },
  {
    id: 'commute_delay',
    transition: 'commute->work',
    requires: ['has_work'],
    impactLevel: 'moderate',
    durationMinutes: [10, 20],
    domains: ['energy', 'mood'],
    effects: [{ op: 'reschedule', role: 'nextWork', delayMinutes: 15 }],
    summaryPattern: '路上有点堵，到单位比平时晚了一点，赶紧坐下了。',
  },

  // ---------- work -> lunch ----------
  {
    id: 'work_lunch_late',
    transition: 'work->lunch',
    requires: ['meal_soon'],
    impactLevel: 'minor',
    durationMinutes: [10, 10],
    domains: ['energy'],
    effects: [{ op: 'reschedule', role: 'nextMeal', delayMinutes: 10 }],
    summaryPattern: '手头只剩一点收尾，做完才去吃午饭，比平时晚了十分钟。',
  },
  {
    id: 'work_lunch_colleague',
    transition: 'work->lunch',
    requires: ['meal_soon'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['social'],
    effects: [{ op: 'record' }],
    summaryPattern: '同事推荐了家新开的店，午饭换了个地方吃。',
  },
  {
    id: 'work_lunch_light',
    transition: 'work->lunch',
    requires: ['meal_soon'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['energy'],
    effects: [{ op: 'record' }],
    summaryPattern: '上午有点累，午饭随便吃了点省事的。',
  },

  // ---------- lunch -> work_pm ----------
  {
    id: 'lunch_queue',
    transition: 'lunch->work_pm',
    requires: ['meal_soon'],
    impactLevel: 'minor',
    durationMinutes: [10, 15],
    domains: ['energy'],
    effects: [{ op: 'reschedule', role: 'nextWork', delayMinutes: 10 }],
    summaryPattern: '午饭排队太久，吃完就回去了，原本想散步那一小段取消了。',
  },
  {
    id: 'lunch_full',
    transition: 'lunch->work_pm',
    requires: ['has_work'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['energy'],
    effects: [{ op: 'record' }],
    summaryPattern: '午饭吃撑了，下午先挑轻省的活做。',
  },
  {
    id: 'lunch_interrupted',
    transition: 'lunch->work_pm',
    requires: ['meal_soon'],
    impactLevel: 'moderate',
    durationMinutes: [10, 20],
    domains: ['mood', 'energy'],
    effects: [{ op: 'interrupt', role: 'current' }],
    summaryPattern: '饭吃到一半收到临时通知，把剩下的打包，先回去处理了。',
  },

  // ---------- offwork -> dinner ----------
  {
    id: 'offwork_overtime_simple',
    transition: 'offwork->dinner',
    requires: ['has_dinner'],
    impactLevel: 'moderate',
    durationMinutes: [20, 40],
    domains: ['energy'],
    effects: [
      { op: 'reschedule', role: 'nextMeal', delayMinutes: 20 },
      { op: 'record' },
    ],
    summaryPattern: '加班结束已经晚了，取消回家做饭，路上买了份简餐，晚饭没跳过。',
  },
  {
    id: 'offwork_reward',
    transition: 'offwork->dinner',
    requires: ['has_dinner'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['mood'],
    effects: [{ op: 'record' }],
    summaryPattern: '忙了一天收完任务，晚饭选了惦记几天的那家店。',
  },
  {
    id: 'offwork_groceries',
    transition: 'offwork->dinner',
    requires: ['has_dinner'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['energy'],
    effects: [{ op: 'record' }],
    summaryPattern: '路上顺手买了食材，晚饭照原计划做。',
  },

  // ---------- dinner -> evening ----------
  {
    id: 'dinner_cleanup_late',
    transition: 'dinner->evening',
    requires: ['has_evening_activity'],
    impactLevel: 'minor',
    durationMinutes: [10, 15],
    domains: ['energy'],
    effects: [{ op: 'reschedule', role: 'nextActivity', delayMinutes: 15 }],
    summaryPattern: '晚饭做得比想象中复杂，洗完碗晚了十几分钟，娱乐时间往后挪了挪。',
  },
  {
    id: 'dinner_recovered',
    transition: 'dinner->evening',
    requires: [],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['mood'],
    effects: [{ op: 'record' }],
    summaryPattern: '吃完饭精神回来了，晚上照原计划看书。',
  },
  {
    id: 'dinner_replace_evening',
    transition: 'dinner->evening',
    requires: ['has_evening_activity'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['mood'],
    effects: [{ op: 'replace', role: 'nextActivity', with: '追一集刚更新的剧' }],
    summaryPattern: '追的节目更新了，晚上的空闲换成了看那一集。',
  },

  // ---------- evening -> sleep ----------
  {
    id: 'evening_read_sleepy',
    transition: 'evening->sleep',
    requires: ['reading_in_progress', 'nap_window'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['energy'],
    effects: [{ op: 'nap' }, { op: 'record' }],
    summaryPattern: '书读到一半开始犯困，记下停的位置，提前睡了。',
  },
  {
    id: 'evening_game_stop',
    transition: 'evening->sleep',
    requires: ['has_evening_activity'],
    impactLevel: 'minor',
    durationMinutes: [0, 0],
    domains: ['energy'],
    effects: [{ op: 'record' }],
    summaryPattern: '打完一局就收手了，没再开新的。',
  },
  {
    id: 'evening_read_extra',
    transition: 'evening->sleep',
    requires: ['reading_in_progress'],
    impactLevel: 'minor',
    durationMinutes: [10, 10],
    domains: ['mood'],
    effects: [{ op: 'extend', role: 'nextActivity', minutes: 10 }],
    summaryPattern: '读到紧张的地方，忍不住又多读了十分钟。',
  },
]

// 背景条件（代码判断）
function 满足(tpl, ctx) {
  for (const r of tpl.requires || []) {
    if (r === 'has_work' && !ctx.hasWork) return false
    if (r === 'has_lunch' && !ctx.hasMeal) return false
    if (r === 'has_dinner' && !ctx.hasMeal) return false
    if (r === 'has_commute' && !ctx.hasNext) return false
    if (r === 'has_breakfast_slot' && !ctx.hasNext) return false
    if (r === 'has_evening_activity' && !ctx.hasEvening) return false
    if (r === 'reading_in_progress' && !ctx.reading) return false
    if (r === 'nap_window' && !ctx.napOk) return false
    if (r === 'meal_soon' && !ctx.mealSoon) return false
  }
  return true
}

// 现在属于哪一段（决定候选模板）
export function 当前段(now) {
  const d = new Date(now)
  const m = d.getHours() * 60 + d.getMinutes()
  if (m < 9 * 60 + 30) return 'morning->commute'
  if (m < 12 * 60) return 'commute->work'
  if (m < 12 * 60 + 40) return 'work->lunch'
  if (m < 14 * 60) return 'lunch->work_pm'
  if (m < 19 * 60) return 'offwork->dinner'
  if (m < 20 * 60 + 30) return 'dinner->evening'
  return 'evening->sleep'
}

// 挑 3~5 个候选给模型
export function 候选模板(now, ctx, 最多 = 5) {
  const 段 = 当前段(now)
  const 允许大类 = (ctx.cfg && ctx.cfg.allowMajor) ? true : false
  const 顺序 = ['morning->commute','commute->work','work->lunch','lunch->work_pm','offwork->dinner','dinner->evening','evening->sleep']
  const 位 = Math.max(0, 顺序.indexOf(段))
  const 距 = (tr) => (顺序.indexOf(tr) - 位 + 7) % 7  // 只往前看，越近越优先
  const 本段 = 模板.filter((t) => t.transition === 段 && (允许大类 || t.impactLevel !== 'major'))
  const 其他 = 模板.filter((t) => t.transition !== 段 && (允许大类 || t.impactLevel !== 'major')).sort((a, b) => 距(a.transition) - 距(b.transition))
  const 出 = []
  for (const t of 本段) {
    if (出.length >= Math.min(3, 最多)) break
    if (!满足(t, ctx)) continue
    if (ctx.最近用过 && ctx.最近用过.has(t.id)) continue
    出.push(t)
  }
  for (const t of 其他) {
    if (出.length >= 最多) break
    if (!满足(t, ctx)) continue
    if (ctx.最近用过 && ctx.最近用过.has(t.id)) continue
    出.push(t)
  }
  return 出
}

// 把模板实例化成链（effect 参数按当前计划解析）
export function 按模板建链(tpl, details, ctx, now, dayKey) {
  const 节点文本 = String(details || tpl.summaryPattern || '').slice(0, 80)
  const 效果 = []
  const 找 = (role) => {
    const plan = (ctx.state && ctx.state.plan) || []
    const 未来 = plan.filter((it) => it.endAt > now).sort((a, b) => a.startAt - b.startAt)
    const 当前 = plan.find((it) => it.startAt <= now && it.endAt > now)
    if (role === 'current') return 当前 || null
    if (role === 'nextMeal') return 未来.find((it) => it.kind === 'meal') || null
    if (role === 'nextCommute') return 未来.find((it) => it.kind === 'commute') || null
    if (role === 'nextWork') return 未来.find((it) => it.kind === 'work') || null
    if (role === 'nextActivity') {
      const 在读 = plan.filter((it) => it.objectId && it.startAt <= now && it.endAt > now)[0] || null
      return 在读 || 未来.find((it) => it.kind === 'activity') || 未来[0] || null
    }
    return null
  }
  const 时分 = (ms) => {
    const d = new Date(ms)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  for (const e of tpl.effects || []) {
    if (e.op === 'record') continue
    if (e.op === 'nap') {
      效果.push({ type: 'request_nap', params: {}, node: 0 })
      continue
    }
    const it = 找(e.role)
    if (!it) continue
    if (e.op === 'extend') {
      效果.push({ type: 'extend_activity', params: { title: it.title, minutes: Number(e.minutes) || 10 }, node: 0 })
    } else if (e.op === 'interrupt') {
      效果.push({ type: 'interrupt_activity', params: { title: it.title }, node: 0 })
    } else if (e.op === 'reschedule') {
      const 移 = (Number(e.delayMinutes) || 10) * 60000
      效果.push({
        type: 'reschedule_activity',
        params: { title: it.title, startAt: 时分(it.startAt + 移), endAt: 时分(it.endAt + 移) },
        node: 0,
      })
    } else if (e.op === 'replace') {
      效果.push({ type: 'replace_future_activity', params: { title: it.title, with: e.with || '随便换个别的' }, node: 0 })
    }
  }
  if (!效果.length) 效果.push({ type: 'record', params: {}, node: 0 })
  return {
    reason: '模板 ' + tpl.id,
    templateId: tpl.id,
    planVersion: ctx.state ? ctx.state.planVersion : undefined,
    nodes: [{ at: 时分(now), text: 节点文本 }],
    effects: 效果,
  }
}

export function 模板字符串() {
  return 模板.map((t) => t.id + '｜' + t.transition + '｜' + t.summaryPattern).join('\n')
}
