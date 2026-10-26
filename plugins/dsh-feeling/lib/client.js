// DSH「鱼的作息」· 网页半边
// 在设置左侧栏加一项，读写 /dsh-feeling/availability。逻辑全在宿主。

window.__ModuleLoader__.load({
  id: 'dsh-feeling',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-feeling'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    const S = {
      wrap: { padding: '12px 14px 28px', fontSize: 13, lineHeight: 1.7 },
      h: { fontSize: 14, fontWeight: 600, margin: '18px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
      lab: { width: 90, opacity: 0.75, fontSize: 12 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 12,
        width: 74,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'inherit',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '5px 14px',
        fontSize: 12,
        cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
    }

    function 规则行({ rule, onChange }) {
      const set = (k, v) => onChange({ ...rule, [k]: v })
      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('input', {
            type: 'checkbox',
            checked: rule.enabled !== false,
            onChange: (e) => set('enabled', e.target.checked),
          }),
          h('b', null, rule.id),
          h('span', { style: S.dim }, '  ' + (rule.kind === 'sleep' ? '整夜睡' : rule.kind === 'nap' ? '午睡' : rule.kind === 'work' ? '上班' : '随机小睡')),
        ),
        rule.kind === 'random_nap'
          ? h(
              'div',
              null,
              h(
                'div',
                { style: S.row },
                h('span', { style: S.lab }, '触发时段'),
                h('input', { style: S.input, value: rule.startRange?.[0] || '14:30', onChange: (e) => set('startRange', [e.target.value, rule.startRange?.[1] || '16:30']) }),
                h('span', null, '—'),
                h('input', { style: S.input, value: rule.startRange?.[1] || '16:30', onChange: (e) => set('startRange', [rule.startRange?.[0] || '14:30', e.target.value]) }),
              ),
              h(
                'div',
                { style: S.row },
                h('span', { style: S.lab }, '时长(分钟)'),
                h('input', { style: S.input, value: rule.durationMinutes?.[0] ?? 10, onChange: (e) => set('durationMinutes', [Number(e.target.value) || 0, rule.durationMinutes?.[1] ?? 25]) }),
                h('span', null, '—'),
                h('input', { style: S.input, value: rule.durationMinutes?.[1] ?? 25, onChange: (e) => set('durationMinutes', [rule.durationMinutes?.[0] ?? 10, Number(e.target.value) || 0]) }),
                h('span', { style: S.lab }, '概率'),
                h('input', { style: S.input, value: Math.round((rule.probability ?? 0.2) * 100), onChange: (e) => set('probability', (Number(e.target.value) || 0) / 100) }),
                h('span', { style: S.dim }, '%'),
              ),
            )
          : h(
              'div',
              { style: S.row },
              h('span', { style: S.lab }, '时间'),
              h('input', { style: S.input, value: rule.start || '00:00', onChange: (e) => set('start', e.target.value) }),
              h('span', null, '—'),
              h('input', { style: S.input, value: rule.end || '00:00', onChange: (e) => set('end', e.target.value) }),
            ),
      )
    }

    function 面板() {
      const [数据, set数据] = React.useState(null)
      const [保存中, set保存中] = React.useState(false)
      const [提示, set提示] = React.useState('')

      const 载入 = () => get('/availability').then((r) => { if (r && r.ok) set数据(r) })
      React.useEffect(() => { 载入() }, [])

      const 改 = (actorId, idx, next) => {
        const 副本 = JSON.parse(JSON.stringify(数据.rules))
        副本.actors[actorId].rules[idx] = next
        set数据({ ...数据, rules: 副本 })
      }

      const 保存 = async () => {
        set保存中(true)
        const r = await post('/availability', 数据.rules)
        set保存中(false)
        set提示(r && r.ok ? '已保存（下一轮按新规则算）' : '保存失败')
        setTimeout(() => set提示(''), 4000)
      }

      if (!数据) return h('div', { style: S.wrap }, '读取中…')
      const 她 = 数据.rules.actors['fish:default']
      const 他 = 数据.rules.actors['person:qq:<你的QQ号>']
      const 状态 = 数据.state || {}

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.dim },
          '统一回答「她睡没睡、你在不在、能不能搭话」。聊天中不会入睡——进入睡眠时段后还要沉默满 ' +
            (数据.rules.onsetSilenceMinutes || 20) + ' 分钟才真的睡着。'),
        h('div', { style: S.row },
          h('span', null, '当前：'),
          h('span', { style: S.dim },
            (状态.fish && 状态.fish.asleep ? '她在睡' : '她醒着') + '；' +
            (状态.ownerAway ? '你不在窗口（' + (状态.ownerKind || '') + '）' : '你在') +
            (状态.suppressProactive ? '；已暂停搭话' : '')),
        ),

        h('div', { style: S.h }, '她'),
        ...(她.rules || []).map((r, i) => h(规则行, { key: 'f' + i, rule: r, onChange: (n) => 改('fish:default', i, n) })),

        h('div', { style: S.h }, '你'),
        ...(他.rules || []).map((r, i) => h(规则行, { key: 'p' + i, rule: r, onChange: (n) => 改('person:qq:<你的QQ号>', i, n) })),

        h('div', { style: S.row },
          h('span', { style: S.lab }, '入睡门槛'),
          h('input', {
            style: S.input,
            value: 数据.rules.onsetSilenceMinutes || 20,
            onChange: (e) => set数据({ ...数据, rules: { ...数据.rules, onsetSilenceMinutes: Number(e.target.value) || 20 } }),
          }),
          h('span', { style: S.dim }, '分钟（沉默这么久才算真的睡着）'),
        ),

        h('div', { style: S.row },
          h('button', { style: S.btn, onClick: 保存, disabled: 保存中 }, 保存中 ? '保存中…' : '保存'),
          h('button', { style: S.btn, onClick: 载入 }, '重新读取'),
          提示 ? h('span', { style: S.dim }, 提示) : null,
        ),
      )
    }

    const apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'feeling', order: 55, label: () => '鱼的作息' },
          () => h(面板, null),
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
