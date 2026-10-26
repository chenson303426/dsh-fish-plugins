# 架构：四个插件怎么协作

## 一句话

每个插件只回答一个问题，答案通过**事件**流动，而不是互相调用：

| 插件 | 只回答 |
|---|---|
| life | 她现在在干什么、刚发生了什么 |
| sulk | 她该不该主动开口 |
| feeling | 她对谁是什么态度、有什么事还没解决 |
| mood | 她此刻整体是什么状态 |

## 数据流

```
                ┌─────────────┐
   用户消息 ───▶│  会话上下文  │◀─── systemPrompt.context（每轮注入）
                └──────┬──────┘
                       │ 回合结束 / 来信
        ┌──────────────┼───────────────┐
        ▼              ▼               ▼
     feeling         mood            life
   （SQLite）     （state.json）   （state.json）
        │              ▲               │
        │  事件        │  inbox.jsonl  │ 事件（只发事实）
        └──────────────┴───────────────┘
                       ▲
                     sulk（沉默观察 / 主动机会）
```

## 事件总线契约（目标形态）

当前实现是 v0：`~/.dsh/mood/inbox.jsonl` 追加一行，消费方按 offset 读取。目标形态是 SQLite 总线，三张表：

```sql
bus_events(seq, id UNIQUE, type, envelope_json)
consumer_offsets(consumer_id PRIMARY KEY, last_seq)
consumer_receipts(consumer_id, event_id, PRIMARY KEY(consumer_id, event_id))
```

- `seq` 是数据库分配的读取顺序；事件自己的时间戳只表示“发生时间”，两者分开。
- 每个消费者启动后按 `seq` 顺序补消费，**处理成功才推进 offset**；失败不能直接跳过，只能显式标记“不适用”或隔离。
- 业务更新与去重凭据必须**原子提交**；如果业务库和总线库分开，凭据放业务库同一事务，然后才更新 offset。
- 需要在下游再发事件时，用**outbox** 在同一事务里记录，再重试投递。调用模型和发送 QQ 不要放进事务。

## 事件信封

```json
{
  "schemaVersion": 1,
  "id": "稳定的事件 ID",
  "type": "life.activity_started",
  "occurredAt": "2026-10-26T15:00:00+08:00",
  "recordedAt": "2026-10-26T15:00:01+08:00",
  "producer": "life",
  "fishId": "fish:default",
  "subjectId": "fish:default",
  "origin": "life_simulation",
  "causationId": null,
  "correlationId": "activity_001",
  "payload": {}
}
```

`origin` 必须能区分**真人消息 / 工具观察 / 模拟生活 / 派生评估**——否则模拟出来的事会被当成现实证据。重试发布必须沿用原 ID。

## 谁拥有什么

| 资源 | 唯一写入者 | 其他插件 |
|---|---|---|
| 作息窗口、午睡、随机小睡、睡眠日志 | **feeling 内的 availability** | 只读查询 |
| 关系分、事项、约定 | **feeling** | 只发事件 |
| 心情数值与情绪维度 | **mood** | 只发事件 |
| 日常计划与生活事件 | **life** | 只发事件 |
| 主动开口的时间与文案 | **sulk** | 只消费作息状态 |

## 三条容易翻车的地方

1. **事件重复生效**：只存内存、先推进 offset、或者用“业务更新后再发下游事件”的写法。用持久化 + 原子去重 + outbox 解决。
2. **反馈循环**：生活事件 → 心情变差 → 生成更坏的生活事件 → 再次扣分。所有派生状态必须保留来源链，**不能把自己生成的内容当成新事实**。
3. **恢复时集中骚扰**：重启补消费旧观察后连发催促。所有发送动作都要重新检查有效期、当前作息、episode 是否关闭、次数限制。

## 当前实现与目标的差距

| 项 | 现在 | 目标 |
|---|---|---|
| 传输 | JSONL 追加 + 文件 offset | SQLite 事件表 |
| 去重 | 各插件自己按 episode / 事件 ID 去重 | `consumer_receipts` 统一 |
| 事务 | 单库单写 | 业务库与凭据同事务 |
| outbox | 无 | 有 |

v0 的选择理由：插件要能在任意时刻重启、换端口，文件通道不会因此断线；代价是缺少跨消费者的原子去重。
