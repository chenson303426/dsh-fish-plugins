// dsh-sticker-adapter · 宿主半边
//
// 桥接只认 `[[图片:URL]]`，而 nekowhale 表情包插件用的是 `[sticker:名字]`。
// 这里把两边接起来：
//   GET /dsh-sticker/resolve?name=摸鱼  → 一张图的可发送地址
//   GET /dsh-sticker/pick?emotion=开心  → 按情绪随机一张
//   GET /dsh-sticker/health            → 服务在不在
//
// 拿不到 stickers 服务时**降级**：接口返回 ok:false，日志记一笔，不影响别的插件。

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'sticker-adapter'
export const inject = ['webServer', 'agents', 'timer', 'systemPrompt']

const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 日志路径 = join(家, 'sticker-adapter.log')
const 注入行 = '【表情】想发图就用自己的图或 [sticker:情绪]，别同一条两种都发。'

function 记账(话) {
  try {
    appendFileSync(日志路径, new Date().toISOString() + '  ' + 话 + '\n', 'utf8')
  } catch (error) {}
  console.log('[sticker-adapter] ' + 话)
}

// 取得 stickers 服务（懒取：它可能比我们晚加载）
function 取服务(ctx) {
  try {
    const s = ctx.get ? ctx.get('stickers') : undefined
    if (s) return s
  } catch (error) {}
  try {
    if (ctx.stickers) return ctx.stickers
  } catch (error) {}
  return null
}

// 解析一个名字/情绪词 → 可发送地址
async function 解析一个(kit, ref) {
  if (!kit) return null
  const 名 = String(ref || '').trim()
  if (!名) return null
  let s = null
  try {
    s = await kit.pick(名)
  } catch (error) {
    return null
  }
  if (!s && typeof kit.search === 'function') {
    try {
      const hits = await kit.search(名, { limit: 1, shuffle: true })
      s = hits && hits[0] ? hits[0].sticker || hits[0] : null
    } catch (error) {}
  }
  if (!s) return null
  try {
    if (typeof kit.url === 'function') {
      const url = kit.url(s)
      if (url) return { sticker: s, url }
    }
  } catch (error) {}
  try {
    const f = await kit.file(s)
    if (f && f.path) return { sticker: s, url: 'file:///' + String(f.path).replace(/\\/g, '/') }
  } catch (error) {}
  return null
}

export function apply(ctx) {
  // —— 每轮一行提示（很短，只有一句）——
  const mounted = new Map()
  function 挂到(agent, sid) {
    try {
      const off = agent.ctx.systemPrompt.context({
        name: 'sticker',
        order: 940,
        text: () => 注入行,
      })
      return () => {
        try {
          if (typeof off === 'function') off()
        } catch (error) {}
      }
    } catch (error) {
      记账('挂注入失败：' + String(error && error.message))
      return () => {}
    }
  }

  function tick() {
    try {
      const list = (ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []) || []
      for (const agent of list) {
        const sid = String((agent.session && agent.session.id) || '')
        if (!sid || mounted.has(sid)) continue
        mounted.set(sid, 挂到(agent, sid))
      }
      for (const [sid, off] of mounted) {
        const 还在 = list.some((a) => String((a.session && a.session.id) || '') === sid)
        if (!还在) {
          try {
            off()
          } catch (error) {}
          mounted.delete(sid)
        }
      }
    } catch (error) {}
  }

  ctx.effect(() => ctx.interval(tick, 5000))

  // —— HTTP ——
  const 路由 = async (req, res, 处理) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    try {
      const out = await 处理()
      res.end(JSON.stringify(out))
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
    }
  }

  const 注册 = (path, 处理) => {
    try {
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: (req, res) => 路由(req, res, () => 处理(req)),
        }),
      )
    } catch (error) {
      记账('注册 ' + path + ' 失败：' + String(error && error.message))
    }
  }

  注册('/dsh-sticker/resolve', async (req) => {
    const name = new URL(req.url, 'http://127.0.0.1').searchParams.get('name') || ''
    const kit = 取服务(ctx)
    const r = await 解析一个(kit, name)
    if (!r) {
      记账('解析失败：' + name + (kit ? '' : '（stickers 服务不可用）'))
      return { ok: false, name, url: '' }
    }
    return { ok: true, name, url: r.url }
  })

  注册('/dsh-sticker/pick', async (req) => {
    const emotion = new URL(req.url, 'http://127.0.0.1').searchParams.get('emotion') || ''
    const kit = 取服务(ctx)
    let s = null
    try {
      if (kit && typeof kit.random === 'function') s = await kit.random({ emotion: emotion || undefined })
    } catch (error) {}
    if (!s && kit && typeof kit.pick === 'function') {
      try {
        s = await kit.pick(emotion || '')
      } catch (error) {}
    }
    if (!s) return { ok: false, emotion, url: '' }
    let url = ''
    try {
      url = kit.url(s)
    } catch (error) {}
    return { ok: Boolean(url), emotion, url }
  })

  注册('/dsh-sticker/health', async () => ({ ok: Boolean(取服务(ctx)), hasService: Boolean(取服务(ctx)) }))

  tick()
  记账('已装好 v0.1.0｜stickers 服务：' + (取服务(ctx) ? '可用' : '暂时没有（每 5 秒重试挂载）'))
}
