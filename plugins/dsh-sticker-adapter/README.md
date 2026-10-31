# dsh-sticker-adapter · 把表情包接给 QQ 桥接

`dsh-nekowhale-stickers` 让模型在回复里写 `[sticker:摸鱼]`，但它只提供 cordis 服务，**QQ 桥接拿不到**。
这个插件在中间加一层 HTTP，把名字/情绪词解析成图片地址。

## 路由

| 路由 | 作用 |
|---|---|
| `GET /dsh-sticker/resolve?name=摸鱼` | 解析一个名字或情绪词 → `{ok, name, url}` |
| `GET /dsh-sticker/pick?emotion=开心` | 按情绪随机一张 → `{ok, emotion, url}` |
| `GET /dsh-sticker/health` | `{ok, hasService}` |

`url` 是站点公网地址；桥接会下载后发出。

## 行为

- 懒取 `stickers` 服务（每 5 秒重试挂载），**拿不到就降级**：接口返回 `ok:false`，日志记一笔，不影响其它插件
- 给每个会话注入一行提示（37 字）：让她别同一条消息里同时用两种表情机制
- 日志：`~/.dsh/sticker-adapter.log`

## 配套改动

`dsh-qq` 桥接（`src/bridge.js`）在发送前把 `[sticker:名字]` 换成 `[[图片:URL]]`：

- 解析失败 → **整段删掉该标记**，不留方括号
- 配置项 `stickerBridge`（默认 `true`，可关）
- 一次回复多个标记也支持

## 注意

- 桥接是独立进程，改完要**单独重启桥接**
- 表情资源许可是 CC BY-NC 4.0（非商业、需署名原作者），**不要把图片打进本仓库**
