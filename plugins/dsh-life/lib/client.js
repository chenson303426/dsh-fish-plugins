// DSH「鱼的生活」· 网页半边
// 只读展示 + 少量参数，逻辑全在宿主（/dsh-life/*）。

window.__ModuleLoader__.load({
  id: 'dsh-life',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement
    const B = '/dsh-life'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    const S = {
      wrap: { padding: '12px 14px 28px', fontSize: 13, lineHeight: 1.7 },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 12,
        width: 90,
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
      bar: { height: 6, borderRadius: 4, background: 'var(--dsw-alias-border-l2)', overflow: 'hidden', width: 140 },
      fill: { height: 6, background: '#4b7bec' },
    }

    function 面板() {
      const [数据, set数据] = React.useState(null)
      const [配置, set配置] = React.useState(null)
      const [提示, set提示] = React.useState('')

      const 载入 = async () => {
        const s = await get('/state')
        const c = await get('/config')
        if (s && s.ok) set数据(s)
        if (c && c.ok) set配置(c.config)
      }
      React.useEffect(() => { 载入() }, [])

      const 保存 = async () => {
        const r = await post('/config', 配置)
        set提示(r && r.ok ? '已保存' : '保存失败')
        setTimeout(() => set提示(''), 3000)
      }
      const [表单, set表单] = React.useState({ title: '', windowStart: '19:40', windowEnd: '22:30', minutes: 30, contentMode: 'fictional' })
      const 加安排 = async () => {
        if (!表单.title.trim()) return set提示('先写书名/做什么')
        const r = await post('/intention', { ...表单, kind: 'reading', strength: 'decided' })
        set提示(r && r.ok ? '已加：' + (r.intention ? r.intention.status : '') : '加失败')
        载入()
        setTimeout(() => set提示(''), 5000)
      }
      const 推进 = async () => {
        const r = await post('/advance')
        set提示(r && r.ok ? '推进了：' + (r.preview || '（无活动）') : '推进失败')
        载入()
        setTimeout(() => set提示(''), 6000)
      }

      if (!数据 || !配置) return h('div', { style: S.wrap }, '读取中…')
      const 在 = 数据.active
      const 需 = 数据.needs || {}

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.dim }, '她的日常：每天按确定性规则排一版，聊天时懒推进，只往外发事实，不评分。'),

        h('div', { style: S.h }, '现在'),
        h('div', { style: S.card },
          h('div', null, 在 ? '正在' + 在.title + '（' + new Date(在.startAt).toTimeString().slice(0, 5) + '–' + new Date(在.endAt).toTimeString().slice(0, 5) + '）' : (数据.asleep ? '在睡' : '空着')),
          h('div', { style: S.dim }, 数据.preview || '（这一轮不会注入）'),
        ),

        h('div', { style: S.h }, '需求条'),
        h('div', { style: S.card },
          ...['energy', 'fullness', 'social'].map((k) =>
            h('div', { style: S.row, key: k },
              h('span', { style: { width: 64, opacity: .7 } }, { energy: '精力', fullness: '饱腹', social: '社交' }[k]),
              h('div', { style: S.bar }, h('div', { style: { ...S.fill, width: Math.round(需[k] || 0) + '%' } })),
              h('span', { style: S.dim }, Math.round(需[k] || 0)),
            ),
          ),
        ),

        h('div', { style: S.h }, '今天'),
        h('div', { style: S.card },
          (数据.incidents || []).length
            ? h('div', null, ...(数据.incidents || []).slice(-6).map((x, i) =>
                h('div', { key: i, style: S.dim }, new Date(x.at).toTimeString().slice(0, 5) + '  ' + x.text)))
            : h('div', { style: S.dim }, '今天还没有插曲'),
        ),

        h('div', { style: S.h }, '她的安排'),
        h('div', { style: S.card },
          (数据.intentions || []).length
            ? h('div', null, ...(数据.intentions || []).map((x, i) =>
                h('div', { key: i, style: S.dim }, (x.windowStart || '') + '–' + (x.windowEnd || '') + '  ' + x.title + '  [' + x.status + ']')))
            : h('div', { style: S.dim }, '还没有她自己排的事'),
          h('div', { style: { ...S.row, marginTop: 8 } },
            h('input', { style: { ...S.input, width: 160 }, placeholder: '书名 / 做什么', value: 表单.title, onChange: (e) => set表单({ ...表单, title: e.target.value }) }),
            h('input', { style: { ...S.input, width: 64 }, value: 表单.windowStart, onChange: (e) => set表单({ ...表单, windowStart: e.target.value }) }),
            h('span', null, '—'),
            h('input', { style: { ...S.input, width: 64 }, value: 表单.windowEnd, onChange: (e) => set表单({ ...表单, windowEnd: e.target.value }) }),
            h('input', { style: { ...S.input, width: 52 }, value: 表单.minutes, onChange: (e) => set表单({ ...表单, minutes: Number(e.target.value) || 30 }) }),
            h('span', { style: S.dim }, '分钟'),
            h('label', null, h('input', { type: 'checkbox', checked: 表单.contentMode === 'real', onChange: (e) => set表单({ ...表单, contentMode: e.target.checked ? 'real' : 'fictional' }) }), ' 真实'),
            h('button', { style: S.btn, onClick: 加安排 }, '加一条'),
          ),
        ),

        h('div', { style: S.h }, '读过的书'),
        h('div', { style: S.card },
          (数据.objects || []).length
            ? h('div', null, ...(数据.objects || []).map((o, i) =>
                h('div', { key: i, style: S.dim }, '《' + o.title + '》 ' + (o.contentMode === 'fictional' ? '虚构 ' : '真实 ') + '读到第 ' + o.nextPosition + ' / ' + (o.chapters || '?') + ' 章' + (o.pendingMaterial ? '（没有正文）' : ''))))
            : h('div', { style: S.dim }, '还没读过什么'),
        ),

        h('div', { style: S.h }, '计划'),
        h('div', { style: S.card },
          h('div', { style: S.dim }, ...(数据.plan || []).slice(0, 12).map((it, i) =>
            h('div', { key: i }, it.start + '–' + it.end + '  ' + it.title))),
        ),

        h('div', { style: S.h }, '参数'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('label', null, h('input', { type: 'checkbox', checked: 配置.enabled !== false, onChange: (e) => set配置({ ...配置, enabled: e.target.checked }) }), ' 启用'),
            h('label', null, h('input', { type: 'checkbox', checked: 配置.inject !== false, onChange: (e) => set配置({ ...配置, inject: e.target.checked }) }), ' 注入日常'),
          ),
          h('div', { style: S.row },
            h('span', { style: { width: 64, opacity: .7 } }, '上班'),
            h('input', { style: S.input, value: 配置.workStart || '', onChange: (e) => set配置({ ...配置, workStart: e.target.value }) }),
            h('span', null, '—'),
            h('input', { style: S.input, value: 配置.workEnd || '', onChange: (e) => set配置({ ...配置, workEnd: e.target.value }) }),
          ),
          h('div', { style: S.row },
            h('span', { style: { width: 64, opacity: .7 } }, '三餐'),
            h('input', {
              style: { ...S.input, width: 200 },
              value: (配置.meals || []).join(','),
              onChange: (e) => set配置({ ...配置, meals: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }),
            }),
          ),
        ),

        h('div', { style: S.row },
          h('button', { style: S.btn, onClick: 保存 }, '保存'),
          h('button', { style: S.btn, onClick: 推进 }, '推进一下'),
          h('button', { style: S.btn, onClick: 载入 }, '刷新'),
          提示 ? h('span', { style: S.dim }, 提示) : null,
        ),
      )
    }

    const apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'life', order: 57, label: () => '鱼的生活' }, () => h(面板, null)),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
