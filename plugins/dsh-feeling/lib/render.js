// dsh-feeling · 渲染层
//
// 只做两件事：
//   1. 分数 → 等级（带迟滞，避免在阈值上抖动）
//   2. 等级 + 原因 → 两行注入文案（模板只固定字段名，不规定台词）

// 每个维度：阈值切档 + 迟滞回退
const BANDS = {
  warmth: { cuts: [-40, -10, 30, 70], names: ['很疏远', '疏远', '一般', '亲近', '很亲近'], hyst: 5 },
  trust: { cuts: [20, 45, 70], names: ['低', '一般', '偏高', '高'], hyst: 5 },
  intimacy: { cuts: [20, 50, 75], names: ['浅', '一般', '较深', '深'], hyst: 5 },
  admiration: { cuts: [30, 60, 80], names: ['一般', '认可', '佩服', '很佩服'], hyst: 5 },
  support_reliance: { cuts: [30, 55, 75], names: ['不会先找', '看情况', '多半会找', '会先找你'], hyst: 5 },
}

function bandOf(value, spec, lastBand) {
  const { cuts, names, hyst } = spec
  let idx = 0
  for (let i = 0; i < cuts.length; i++) if (value >= cuts[i]) idx = i + 1
  // 迟滞：如果上次档位不同，往回退时必须越过 hyst 才切档
  if (lastBand) {
    const last = names.indexOf(lastBand)
    if (last >= 0 && last !== idx) {
      if (idx < last) {
        // 降档：当前值要低于「上一档下限 − hyst」才真的降
        const lower = last === 0 ? -Infinity : cuts[last - 1]
        if (value > lower - hyst) idx = last
      } else {
        // 升档：当前值要高于「上一档上限 + hyst」才真的升
        const upper = cuts[last]
        if (value < upper + hyst) idx = last
      }
    }
  }
  return { idx, name: names[idx] }
}

export function renderBands(obj) {
  const out = {}
  for (const key of Object.keys(BANDS)) {
    const lastKey = 'band_' + (key === 'support_reliance' ? 'support' : key)
    const last = obj[lastKey] || null
    const r = bandOf(Number(obj[key] || 0), BANDS[key], last)
    out[key] = { idx: r.idx, name: r.name }
  }
  return out
}

// 关系一行：只写「有证据的维度」，不写趋势词（"稳定"这种需要时间序列支撑，v1 不给）
export function renderRelation(obj, displayName) {
  const b = renderBands(obj)
  const parts = []
  parts.push('亲近' + b.warmth.name.replace('很亲近', '高').replace('亲近', '高').replace('一般', '一般').replace('疏远', '低').replace('很疏远', '很低'))
  parts.push('信任' + b.trust.name)
  if (Number(obj.intimacy || 0) > 0) parts.push('分享' + b.intimacy.name)
  if (Number(obj.support_reliance || 0) !== 50) parts.push(b.support_reliance.name)
  return `【关系·${displayName || obj.target_id}】${parts.join('｜')}`
}

// 反应档位（anger 新刻度：事件增量已 ×0.5，同一事项 24h 最多 +8、封顶 20）
// <0.5 不写反应词；0.5~3 还有一点气；3~8 还在生气；>=8 很生气。退出档低 0.3 防抖。
export function angerBand(anger) {
  const a = Number(anger) || 0
  if (a >= 8) return { idx: 3, text: '很生气' }
  if (a >= 3) return { idx: 2, text: '还在生气' }
  if (a >= 0.5) return { idx: 1, text: '还有一点气' }
  return { idx: 0, text: '' }
}

// 事项一行：原因来自存储，措辞来自状态，不编造；低强度不注入
export function renderMatter(matter, displayName) {
  if (!matter) return ''
  const band = angerBand(matter.anger)
  if (!band.text) return '' // 低于可见阈值：不写"已平复"，只是不显示
  const 状态 = matter.status === 'resolved' ? '已解决' : '未解决'
  const 反应 = [band.text]
  if (matter.disclosure === 'withheld') 反应.push('暂不愿展开')
  else if (matter.disclosure === 'willing') 反应.push('愿意说')
  if (matter.repair_stance === 'wants_comfort') 反应.push('想先被安慰')
  else if (matter.repair_stance === 'wants_explain') 反应.push('想先听解释')
  else if (matter.repair_stance === 'wants_space') 反应.push('想缓一缓')
  const 原因 = matter.reason ? `：${matter.reason}` : ''
  return `【当前事项】${状态}${原因}；${反应.join('，')}。`
}

export function renderContext(obj, matters, displayName) {
  const lines = []
  if (obj) lines.push(renderRelation(obj, displayName))
  const open = (matters || []).filter((m) => m.status === 'open')
  if (open.length) lines.push(renderMatter(open[0], displayName))
  return lines.join('\n')
}
