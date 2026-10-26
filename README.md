# 大肥鱼插件组 · DSH

给 DeepSeek Harness（DSH）养一条「有脾气、有心情、有日子」的鱼。四个插件各管一件事，通过一份轻量事件通道互相喂料：

| 插件 | 一句话 | 注入到上下文的内容 |
|---|---|---|
| **dsh-sulk** | 被晾着了会主动开口 | 无（它往会话里塞一句她的动机） |
| **dsh-feeling** | 感情账本：对谁什么态度、什么事还没解决 | `【时间】` `【关系·阿元】` `【当前事项】` |
| **dsh-mood** | 心情：整体状态 + 七个情绪维度 | `【缘由】` `【心情】` |
| **dsh-life** | 她的日常：上班、三餐、追剧、快递到了 | `【日常】` |

四个插件都是**独立可装**的：不装 feeling 也能只用 mood，反之亦然。装在一起时按下面的顺序互相协作：

```
life 发事实 ─┐
sulk 发等待 ─┼→ mood/inbox.jsonl → mood 决定心情（可以改变，也可以是零变化）
feeling 发关系事件 ─┘                ↓
                             每轮注入一段状态
                                    ↓
                              她按状态说话
```

## 设计上的几条硬规矩

- **life 只发事实，不发分数**。它说“被领导点名说方案要改”，mood 和 feeling 各自决定这算不算事。
- **availability 是睡眠的唯一写入者**。作息窗口、午睡、随机小睡都由它生成，其他插件只查询。
- **同一件事只有一个通道负责讲**。feeling 讲“对谁、因为什么、还没解决”，mood 讲“整体氛围”，避免两段文案互相打架。
- **消费是 at-least-once**。先落库再推进 offset；重启补消费旧事件，但过期的主动消息绝不补发。

## 安装

```bash
# 每个插件单独装（本地目录）
dsh plugin --profile <配置档名> add "link:/path/to/plugins/dsh-mood"
dsh plugin --profile <配置档名> add "link:/path/to/plugins/dsh-feeling"
dsh plugin --profile <配置档名> add "link:/path/to/plugins/dsh-sulk"
dsh plugin --profile <配置档名> add "link:/path/to/plugins/dsh-life"

# 装完重启一次 DSH（bundle 层要重启才组装）
```

装好后在「设置」里会多出四项：**鱼的脾气**（sulk）、**鱼的作息**（feeling 内的 availability）、**鱼的心情**（mood）、**鱼的生活**（life）。

## 配置

每个插件目录里都有 `config.example.json`，把它复制到 `~/.dsh/<插件名>-config.json` 再改。真实配置和运行状态（`*.log`、`*.db`、`state.json`）**永远不进仓库**，见 `.gitignore`。

## 需要 DSH 什么版本

插件用的是 DSH 的宿主服务：`systemPrompt`、`agents`、`llm`、`timer`、`webServer`，以及 `agent/turn-stopping`、`agent/inbox/inserted` 两个钩子。如果 DSH 大版本改动这些接口，插件需要跟着改。

## 许可

MIT。见 [LICENSE](./LICENSE)。
