// DSH「鱼的脾气」· 网页半边
//
// 只干一件事：在 DSH 设置左侧栏加一项「鱼的脾气」，把 dsh-sulk 的参数摆出来。
// 逻辑全在宿主半边（lib/index.js），这里只是往 /dsh-sulk/* 路由读写。

window.__ModuleLoader__.load({
  id: 'dsh-sulk',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-sulk'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 170, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 240px', minWidth: 200 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 12.5,
        background: 'transparent',
        color: 'inherit',
        width: 90,
      },
      ta: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '6px 8px',
        fontSize: 12.5,
        background: 'transparent',
        color: 'inherit',
        width: '100%',
        minHeight: 54,
        resize: 'vertical',
        fontFamily: 'inherit',
      },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      ok: { color: '#1e8449', fontSize: 12 },
      err: { color: '#c0392b', fontSize: 12 },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 12.5,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      日志行: { fontFamily: 'ui-monospace, monospace', fontSize: 11.5, opacity: 0.8, whiteSpace: 'pre-wrap' },
      悬浮: {
        position: 'sticky',
        bottom: 0,
        marginTop: 10,
        padding: '8px 10px',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
    }

    const 场景表 = [
      { key: 'ignored', 名: '被晾着（ignored）', 说明: '我说完话，你没接。默认 10 分钟就可以闹。' },
      { key: 'wrapped', 名: '正常收尾（wrapped）', 说明: '你说的是晚安 / 一会儿见 / 去忙。默认 30 分钟，不许赌气。' },
      { key: 'idle', 名: '自然停住（idle）', 说明: '对话只是停了，不像收尾也不像被晾着。默认 45 分钟。' },
    ]

    function 行(标签, 控件, 提示) {
      return h('div', { style: S.row },
        h('div', { style: S.lab }, 标签),
        h('div', { style: S.ctl }, 控件, 提示 ? h('div', { style: S.hint }, 提示) : null),
      )
    }

    function 按钮(文字, 点, 主, 忙) {
      return h('button', {
        style: { ...S.btn, ...(主 ? { borderColor: '#2d7ff9', color: '#2d7ff9' } : {}), opacity: 忙 ? 0.5 : 1 },
        disabled: !!忙,
        onClick: 点,
      }, 文字)
    }

    function Section() {
      const [配置, 设配置] = React.useState(null)
      const [日志, 设日志] = React.useState([])
      const [会话列表, 设会话列表] = React.useState([])
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')
      const [演练, 设演练] = React.useState(null)

      const 拉 = async () => {
        const d = await get('/state')
        if (d && d.ok) {
          设配置(d.配置)
          设日志(d.日志 || [])
          设脏(false)
        }
      }
      const 拉会话 = async () => {
        const d = await get('/sessions')
        if (d && d.ok) 设会话列表(d.会话 || [])
      }
      React.useEffect(() => { 拉(); 拉会话() }, [])
      if (!配置) return h('div', { style: S.wrap }, '载入中…')

      const 改 = (f) => { 设配置(f(配置)); 设脏(true) }
      const 存 = async () => {
        设忙(true)
        const r = await post('/save', 配置)
        设忙(false)
        if (r && r.ok) { 设配置(r.配置); 设脏(false); 设说('已保存'); 拉(); 拉会话() }
        else 设说('保存失败：' + ((r && r.说) || '未知原因'))
      }
      const 试 = async () => {
        设忙(true)
        const r = await post('/test', {})
        设忙(false)
        设演练(r && r.ok ? r : null)
        if (!r || !r.ok) 设说('演练失败：' + ((r && r.说) || '未知原因'))
      }

      const 勾会话 = (id, on) => 改((c) => {
        const k = String(id).replace(/^session-/, '')
        const 余 = (c.targets || []).filter((x) => String(x).replace(/^session-/, '') !== k)
        return { ...c, targets: on ? [...余, String(id)] : 余 }
      })

      return h('div', { style: S.wrap },
        h('div', { style: S.dim },
          '在你的鱼沉默时主动开口。和旧「主动搭话」的区别：它会先判断这段对话是怎么结束的，再决定等多久、说什么。'),
        h('div', { style: S.dim },
          '配置文件：' + '%USERPROFILE%\\.dsh\\sulk-config.json（这里改了也一样落盘）'),

        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '总开关'),
          行('启用', h('input', {
            type: 'checkbox',
            checked: !!配置.enabled,
            onChange: (e) => 改((c) => ({ ...c, enabled: e.target.checked })),
          })),
          行('试运行（只记账，不真发）', h('input', {
            type: 'checkbox',
            checked: !!配置.dryRun,
            onChange: (e) => 改((c) => ({ ...c, dryRun: e.target.checked })),
          }), '先开着观察几天，确认她说的像人话再关。'),
          行('心跳（秒）', h('input', {
            style: S.input, type: 'number', min: 15, value: 配置.heartbeatSeconds,
            onChange: (e) => 改((c) => ({ ...c, heartbeatSeconds: Number(e.target.value) })),
          }), '多久检查一次。这一项要重启才生效。'),
          行('搭话冷却（分钟）', h('input', {
            style: S.input, type: 'number', min: 1, value: 配置.cooldownMinutes,
            onChange: (e) => 改((c) => ({ ...c, cooldownMinutes: Number(e.target.value) })),
          }), '两次开口之间至少隔多久。'),
          行('同一次沉默最多闹几次', h('input', {
            style: S.input, type: 'number', min: 1, max: 5, value: 配置.maxNudgesPerSilence,
            onChange: (e) => 改((c) => ({ ...c, maxNudgesPerSilence: Number(e.target.value) })),
          })),
        ),

        场景表.map(({ key, 名, 说明 }) =>
          h('div', { key, style: S.card },
            h('div', { style: { ...S.h, margin: '0 0 8px' } }, 名),
            h('div', { style: S.dim }, 说明),
            行('等多久（分钟）', h('input', {
              style: S.input, type: 'number', min: 1, value: 配置.scenes[key].minutes,
              onChange: (e) => 改((c) => {
                const scenes = { ...c.scenes, [key]: { ...c.scenes[key], minutes: Number(e.target.value) } }
                return { ...c, scenes }
              }),
            })),
            行('说什么（她的动机，不是系统提示）', h('textarea', {
              style: S.ta, value: 配置.scenes[key].prompt,
              onChange: (e) => 改((c) => {
                const scenes = { ...c.scenes, [key]: { ...c.scenes[key], prompt: e.target.value } }
                return { ...c, scenes }
              }),
            })),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '安静时段'),
          行('从几点到几点不开口', h('div', null,
            h('input', {
              style: S.input, type: 'number', min: 0, max: 23, value: 配置.quiet.start,
              onChange: (e) => 改((c) => ({ ...c, quiet: { ...c.quiet, start: Number(e.target.value) } })),
            }),
            h('span', { style: S.dim }, ' 点到 '),
            h('input', {
              style: S.input, type: 'number', min: 0, max: 23, value: 配置.quiet.end,
              onChange: (e) => 改((c) => ({ ...c, quiet: { ...c.quiet, end: Number(e.target.value) } })),
            }),
            h('span', { style: S.dim }, ' 点（含起不含止；两格相同 = 不启用）'),
          )),
        ),

        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '在哪个对话里生效'),
          h('div', { style: S.dim }, '勾上的对话才会被这个插件管；没勾的一律不碰。'),
          h('div', { style: { marginTop: 6 } },
            会话列表.length === 0
              ? h('div', { style: S.dim }, '还没读到会话。点下面的「刷新会话列表」。')
              : 会话列表.map((s) =>
                  h('div', { key: s.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' } },
                    h('input', {
                      type: 'checkbox',
                      checked: !!s.勾着,
                      onChange: (e) => 勾会话(s.id, e.target.checked),
                    }),
                    h('span', null, s.标题 || '（还没起名）'),
                    h('span', { style: S.dim },
                      '　' + String(s.id).replace(/^session-/, '').slice(0, 8) + (s.活着 ? ' · 开着' : ' · 没开')),
                  ),
                ),
          ),
          h('div', { style: { marginTop: 6 } },
            按钮('刷新会话列表', 拉会话, false, 忙),
            h('span', { style: S.dim }, '　勾选立即算草稿，记得点最下面的「保存设置」。'),
          ),
          行('也可以手填 id（逗号分隔）', h('input', {
            style: { ...S.input, width: '100%' },
            value: (配置.targets || []).join(', '),
            onChange: (e) => 改((c) => ({ ...c, targets: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })),
          })),
          行('判场景用哪个模型', h('div', null,
            h('input', {
              style: { ...S.input, width: 150 }, placeholder: 'provider', value: 配置.model.provider,
              onChange: (e) => 改((c) => ({ ...c, model: { ...c.model, provider: e.target.value } })),
            }),
            h('span', { style: S.dim }, ' / '),
            h('input', {
              style: { ...S.input, width: 150 }, placeholder: 'model', value: 配置.model.model,
              onChange: (e) => 改((c) => ({ ...c, model: { ...c.model, model: e.target.value } })),
            }),
          ), '留空 = 用会话自己的模型。'),
        ),

        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '试一下'),
          h('div', null,
            按钮('演练一次（不真发）', 试, false, 忙),
            h('span', { style: S.dim }, '　'),
            按钮('刷新日志', 拉, false, 忙),
          ),
          演练
            ? h('div', { style: { marginTop: 8, fontSize: 12.5 } },
                h('div', null, '判成场景：' + 演练.场景 + '（等 ' + 演练.等待分钟 + ' 分钟）'),
                h('div', { style: S.dim }, '本来要发：' + 演练.文案),
                h('div', { style: S.dim }, '当前沉默：' + (演练.沉默分钟 == null ? '还没聊过' : 演练.沉默分钟.toFixed(1) + ' 分钟')),
              )
            : null,
          说 ? h('div', { style: 说.indexOf('失败') >= 0 ? S.err : S.ok }, 说) : null,
        ),

        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '最近 ' + 日志.length + ' 条记录'),
          h('div', { style: S.dim }, '每轮都会留痕：判了什么场景、试运行该发什么、真发成功没有。'),
          h('div', { style: { marginTop: 6, maxHeight: 240, overflowY: 'auto' } },
            日志.length === 0
              ? h('div', { style: S.dim }, '还没有记录。')
              : 日志.map((行, i) => h('div', { key: i, style: S.日志行 }, 行)),
          ),
        ),

        脏
          ? h('div', { style: S.悬浮 },
              h('span', { style: { fontWeight: 600, color: '#c0392b' } }, '⚠ 有改动还没保存'),
              按钮('保存设置', 存, true, 忙),
            )
          : h('div', { style: { marginTop: 8 } }, 按钮('保存设置', 存, true, 忙)),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'sulk', order: 54, label: () => '鱼的脾气' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
