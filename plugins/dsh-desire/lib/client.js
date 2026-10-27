// DSH「鱼的欲望」· 网页半边
// 设置 → 鱼的欲望：七维只读进度条 + 活跃欲求 + 两个开关

window.__ModuleLoader__.load({
  id: 'dsh-desire',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-desire'
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
      bar: { height: 8, borderRadius: 6, background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,.08))', overflow: 'hidden', flex: 1, minWidth: 120 },
      fill: { height: '100%', borderRadius: 6, background: 'var(--dsw-alias-accent, #4b8bf5)' },
      lab: { width: 56, opacity: 0.75, fontSize: 12 },
      btn: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '5px 14px', fontSize: 12, cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-2)' },
    }

    function 面板() {
      const [数据, set数据] = React.useState(null)
      const [配置, set配置] = React.useState(null)
      React.useEffect(() => {
        get('/state').then((r) => r && r.ok && set数据(r))
        get('/config').then((r) => r && r.ok && set配置(r.config))
      }, [])

      const 改 = async (patch) => {
        const r = await post('/config', patch)
        if (r && r.ok) { set配置(r.config); }
      }

      if (!数据) return h('div', { style: S.wrap }, '读取中…')
      const labels = 数据.needsLabels || {}

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.dim },
          '欲望只影响「想做什么」和活动选择，不直接改心情或感情。数值越高越值得优先满足（0~100）。'),

        h('div', { style: S.h }, '七种需要'),
        ...Object.keys(数据.needs || {}).map((k) =>
          h('div', { style: S.row, key: k },
            h('span', { style: S.lab }, labels[k] || k),
            h('div', { style: S.bar }, h('div', { style: { ...S.fill, width: Math.round(数据.needs[k]) + '%' } })),
            h('span', { style: { ...S.dim, width: 30, textAlign: 'right' } }, Math.round(数据.needs[k])),
          ),
        ),

        h('div', { style: S.h }, '活跃欲求（最多 3 个）'),
        (数据.active || []).length === 0
          ? h('div', { style: S.dim }, '现在没有什么特别想做的')
          : (数据.active || []).map((d) =>
              h('div', { style: S.card, key: d.id },
                h('div', null, h('b', null, d.goal)),
                h('div', { style: S.dim }, '强度 ' + Math.round(d.strength) + '｜' + d.status + '｜进度 ' + Math.round((d.progress || 0) * 100) + '%'),
              ),
            ),

        h('div', { style: S.h }, '开关'),
        h('div', { style: S.row },
          h('label', null, h('input', { type: 'checkbox', checked: !!(配置 && 配置.enabled), onChange: (e) => 改({ enabled: e.target.checked }) }), ' 启用欲望'),
        ),
        h('div', { style: S.row },
          h('label', null, h('input', { type: 'checkbox', checked: !!(配置 && 配置.dailyCandidates), onChange: (e) => 改({ dailyCandidates: e.target.checked }) }), ' 每天生成新欲求（最多 2 条）'),
        ),

        h('div', { style: S.row },
          h('button', { style: S.btn, onClick: () => get('/state').then((r) => r && r.ok && set数据(r)) }, '刷新'),
        ),
      )
    }

    const apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'desire', order: 58, label: () => '鱼的欲望' },
          () => h(面板, null),
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
