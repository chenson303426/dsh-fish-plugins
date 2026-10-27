# dsh-desire · 鱼的欲望

**欲望回答「我现在想得到或做什么」。它只影响活动选择与欲求形成，不直接改心情或感情。**

```
欲望：我现在想得到或做什么？
mood：我现在感觉怎样？
feeling：我对谁什么态度、什么事还挂着？
life：我最终安排并经历了什么？
```

## 两层

- **底层：七维需要**（0~100，越高越值得优先满足）
- **上层：具体欲求**（"想把昨天那章接着读完"）

七维：恢复 / 自主 / 胜任 / 联结 / 探索 / 享受 / 表达。初始都是 20。

## 规则（v1）

- 纯时间累积最多推到 60，再高须有具体事件
- 单个普通事件变化 ≤ ±10，同一原因去重
- 普通沉默**不抬高联结**
- 满足只减一定幅度，**不强制归零**
- 欲求：同时活跃最多 3 个；小欲求 24h 过期；过期/放弃都不扣分
- 每天最多 2 个新候选，允许零候选

## 与 life 的接口

```
GET  /dsh-desire/active
POST /dsh-desire/score       { candidates:[{title,kind}] } → needFit/goalFit/reasonIds
POST /dsh-desire/link-plan   { desireId, planId, expectedOutcome }
POST /dsh-desire/outcome     { eventId, activityId, result, evidenceRefs }
GET  /dsh-desire/state
POST /dsh-desire/config
```

life 先检查睡眠/条件/约定，再用欲望打分。

## 注入

只给一个当前最相关的欲求，一行、≤60 字、不含数字：

```
【想做】想把昨天那章接着读完。
```

## 配置

`~/.dsh/desire-config.json`：`enabled` / `targetSession` / `injectOrder` / `dailyCandidates` / `maxActive` / `tickSeconds` / `model`。

## 已知限制

- 需要 life 与 availability 的状态文件才能判断"在上班/在睡"，读不到就按清醒空闲算
- 每日候选依赖模型；模型不可用时静默跳过，不影响其他功能
