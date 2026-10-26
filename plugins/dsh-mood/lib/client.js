// DSH「鱼的心情」· 网页半边
// 只读展示 mood / 七个维度，改几个参数，手动「调一下」。

window.__ModuleLoader__.load({
  id: 'dsh-mood',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-mood'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    const 维度 = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']
    const 维度名 = { happy: '开心', calm: '平静', sweet: '甜', heartache: '心酸', worry: '担心', sad: '难过', jealous: '吃味' }

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
      lab: { width: 92, opacity: 0.75, fontSize: 12 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 12,
        width: 90,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'inherit',
      },
      wide: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 6px',
        fontSize: 12,
        flex: 1,
        minWidth: 260,
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
      bar: { height: 6, borderRadius: 4, background: 'rgba(0,0,0,.08)', flex: 1, minWidth: 90, overflow: 'hidden' },
      fill: { height: '100%', borderRadius: 4 },
    }

    function 条({ label, value, max, color }) {
      const pct = Math.max(0, Math.min(100, (Number(value) / max) * 100))
      return h(
        'div',
        { style: { ...S.row, gap: 8 } },
        h('span', { style: { ...S.lab, width: 56 } }, label),
        h('div', { style: S.bar }, h('div', { style: { ...S.fill, width: pct + '%', background: color } })),
        h('span', { style: { width: 44, textAlign: 'right', fontSize: 11, opacity: 0.7 } }, String(Math.round(Number(value) * 10) / 10)),
      )
    }

    function 面板() {
      const [数据, set数据] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [delta, setDelta] = React.useState(-2)
      const [理由, set理由] = React.useState('')
      const [提示, set提示] = React.useState('')

      const 载入 = async () => {
        const r = await get('/state')
        if (r && r.ok) {
          set数据(r.state)
          setCfg(r.cfg)
        }
      }
      React.useEffect(() => { 载入() }, [])
      React.useEffect(() => {
        const t = setInterval(载入, 15000)
        return () => clearInterval(t)
      }, [])

      const 存配置 = async (patch) => {
        const 新 = await post('/config', patch)
        if (新 && 新.ok) { setCfg(新.cfg); set提示('已保存'); setTimeout(() => set提示(''), 2500) }
      }

      const 调一下 = async () => {
        const r = await post('/apply', { source: 'manual', moodDelta: Number(delta) || 0, reason: 理由 || '手动调整' })
        if (r && r.ok) { set数据(r.state); set提示('已应用'); set理由(''); setTimeout(() => set提示(''), 2500) }
      }

      if (!数据 || !cfg) return h('div', { style: S.wrap }, '读取中…')
      const 今天0点 = new Date(); 今天0点.setHours(0, 0, 0, 0)
      const 今天次数 = (数据.saidAt || []).filter((t) => Number(t) >= 今天0点.getTime()).length

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.dim }, '心情影响她怎么说话；对谁的感情、怨气归「感情账本」。注入里只说等级，不给数字。'),

        h('div', { style: S.h }, '当前'),
        h(条, { label: '心情', value: 数据.mood, max: 100, color: 'linear-gradient(90deg,#7bb7ff,#5b8def)' }),
        ...维度.map((k) => h(条, {
          key: k,
          label: 维度名[k],
          value: 数据.dims[k],
          max: 60,
          color: 'linear-gradient(90deg,#ffc46b,#f59e42)',
        })),
        h('div', { style: S.dim },
          '今天注入了 ' + 今天次数 + ' 次 / 上限 ' + (cfg.injectPerDay || 6) +
          '；上次理由：' + (数据.lastReason || '—')),

        h('div', { style: S.h }, '设置'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.lab }, '目标会话'),
            h('input', {
              style: S.wide,
              value: cfg.targetSession || '',
              onChange: (e) => setCfg({ ...cfg, targetSession: e.target.value }),
              onBlur: () => 存配置({ targetSession: cfg.targetSession }),
            })),
          h('div', { style: S.row },
            h('span', { style: S.lab }, '注入'),
            h('select', {
              style: { ...S.input, width: 120 },
              value: cfg.injectMode || 'event',
              onChange: (e) => { setCfg({ ...cfg, injectMode: e.target.value }); 存配置({ injectMode: e.target.value }) },
            }, h('option', { value: 'event' }, '有变化才说'), h('option', { value: 'off' }, '不注入')),
            h('span', { style: S.lab }, '每日上限'),
            h('input', {
              style: S.input,
              value: cfg.injectPerDay || 6,
              onChange: (e) => setCfg({ ...cfg, injectPerDay: Number(e.target.value) || 6 }),
              onBlur: () => 存配置({ injectPerDay: cfg.injectPerDay }),
            })),
          h('div', { style: S.row },
            h('span', { style: S.lab }, '衰减半衰期'),
            h('input', {
              style: S.input,
              value: cfg.decayHalfHours || 14,
              onChange: (e) => setCfg({ ...cfg, decayHalfHours: Number(e.target.value) || 14 }),
              onBlur: () => 存配置({ decayHalfHours: cfg.decayHalfHours }),
            }),
            h('span', { style: S.dim }, '小时（情绪回到平常的速度）')),
          h('div', { style: S.row },
            h('span', { style: S.lab }, '自动判断'),
            h('input', {
              type: 'checkbox',
              checked: cfg.autoJudge !== false,
              onChange: (e) => { setCfg({ ...cfg, autoJudge: e.target.checked }); 存配置({ autoJudge: e.target.checked }) },
            }),
            h('span', { style: S.dim }, '每轮由模型判断一次（关掉就只靠外部事件）'))),

        h('div', { style: S.h }, '手动调一下'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.lab }, '变化'),
            h('input', { style: S.input, value: delta, onChange: (e) => setDelta(e.target.value) }),
            h('input', {
              style: S.wide,
              placeholder: '理由（会记进时间线）',
              value: 理由,
              onChange: (e) => set理由(e.target.value),
            }),
            h('button', { style: S.btn, onClick: 调一下 }, '应用')),
          h('div', { style: S.dim }, '也可以由 feeling / sulk / life 直接 POST /dsh-mood/apply。')),

        h('div', { style: S.row },
          h('button', { style: S.btn, onClick: 载入 }, '刷新'),
          提示 ? h('span', { style: S.dim }, 提示) : null),
      )
    }

    const apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'mood', order: 56, label: () => '鱼的心情' },
          () => h(面板, null),
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
