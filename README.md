# qingClaw

**qingClaw** 是一个个人 coding agent：基于 [badlogic/pi-mono](https://github.com/badlogic/pi-mono)
（世界级开源 coding agent，MIT 协议）改造，fork 基线为上游提交 `3ffc2b43`。

> Agent 其实并不神秘：`agent = workflow + loop + tools`。
> qingClaw 的目标是在理解原理的基础上，拥有一个真正属于自己的、可长期使用的编码智能体。

## 个性化改造内容

| 改造 | 说明 | 代码 |
|---|---|---|
| **/goal 长目标循环**（自研） | 设定长期目标后，agent 每轮停下时若目标未完成会被自动唤醒继续推进，直到调用 `goal_complete` 才结束。状态随会话持久化，重启自动恢复；带 30 轮防呆上限 | [`extensions/qingclaw-goal.ts`](extensions/qingclaw-goal.ts) |
| **校内大模型平台接入** | 通过 `models.json` 自定义 OpenAI 兼容 Provider（任意 base_url + 模型列表），无需改动核心代码；处理了 reasoning 参数兼容性 | 见下方配置 |
| **品牌化** | 利用 pi-mono 内建的 `piConfig.name` 机制（运行时读取 package.json）改为 qingClaw，配置目录与上游保持兼容 | `packages/coding-agent/package.json` |
| **Windows / 弱网构建指南** | 跳过原生模块编译、绕过被墙的模型列表生成、代理安装 fd/rg 搜索工具 | 见下文构建一节 |

## /goal 长目标循环

```
/goal 测试覆盖率达到 90%      # 设定目标，agent 开始自主推进
/goal                        # 查看状态（已自动续跑几轮）
/goal stop                   # 停止循环
```

- agent 侧入口：`set_goal` / `goal_complete` 两个工具（LLM 通过 function calling 调用）
- 自动唤醒机制：监听 `agent_end` 事件后**轮询 `ctx.isIdle()`**，等运行时真正空闲再发送续跑消息
- 会话内持久化：`pi.appendEntry` 存储目标状态，`session_start` 时恢复
- 防呆：连续 30 轮未见 `goal_complete` 则暂停自动续跑，避免目标不可达时无限消耗 token

**实现过程中踩到的一个值得记录的坑**：在 `agent_end` 事件处理器里直接调用
`pi.sendUserMessage()` 会抛 `Agent is already processing`（此刻运行时仍视为处理中）；
而带 `deliverAs: "followUp"` 排队的消息在 agent 停止后**不会被冲刷**（队列失去了下一次驱动时机）。
最终方案是轮询等待空闲后直接发送（空闲时发送会立即触发新一轮）。该行为已通过 RPC 模式
端到端测试验证：6 轮自动续跑后干净收尾，无死循环。

> 注意：自动续跑依赖常驻运行时（TUI / RPC 模式）；`--print` 单发模式处理完即退出，不会续跑。

## 构建与运行

前置要求：Node.js >= 20、npm。

```bash
git clone https://github.com/brittanylove/qing-claw.git
cd qing-claw

# 1) 安装运行时依赖
#    --omit=dev   跳过 devDependencies（其中的 canvas 需要本机 C++ 工具链编译，运行时并不需要）
#    --ignore-scripts 跳过 husky 等生命周期脚本
npm install --omit=dev --ignore-scripts

# 2) 补装构建工具（tsgo 编译器与文件操作工具，--no-save 不污染 package.json）
npm install --no-save --ignore-scripts @typescript/native-preview shx typescript tsx

# 3) 按依赖顺序编译（跳过 ai 包 build 脚本里的 generate-models，
#    它会访问 models.dev / openrouter 等外网源；仓库内已自带完整的 models.generated.ts）
cd packages/tui   && npx tsgo -p tsconfig.build.json && cd ../..
cd packages/ai    && npx tsgo -p tsconfig.build.json && cd ../..
cd packages/agent && npx tsgo -p tsconfig.build.json && cd ../..
cd packages/coding-agent && npx tsgo -p tsconfig.build.json && npm run copy-assets && cd ../..

# 4) 运行（在任意工作目录）
node packages/coding-agent/dist/cli.js
```

在中国大陆网络环境下，克隆与推送 GitHub 需要为 git 配置代理：

```bash
git config http.https://github.com/.proxy http://127.0.0.1:7890
```

pi 启动时会自动从 GitHub 下载 `fd` / `rg` 两个搜索工具，网络不通会警告超时
（不影响聊天）。可手动下载 Windows 版解压，将 `fd.exe`、`rg.exe` 放入
`~/.pi/agent/bin/` 即可。

## 配置模型（任意 OpenAI 兼容平台）

编辑 `~/.pi/agent/models.json`，添加自定义 Provider（以校内平台为例）：

```json
{
  "providers": {
    "ustc": {
      "baseUrl": "https://api.llm.ustc.edu.cn/v1",
      "api": "openai-completions",
      "apiKey": "sk-你的key",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "thinkingFormat": "openai"
      },
      "models": [
        { "id": "deepseek-flash", "name": "DeepSeek Flash", "reasoning": true,
          "contextWindow": 1000000, "maxTokens": 32768 }
      ]
    }
  }
}
```

设置默认模型（`~/.pi/agent/settings.json`）：

```json
{
  "defaultProvider": "ustc",
  "defaultModel": "deepseek-flash"
}
```

启用 /goal 扩展（二选一）：

- 将 `extensions/qingclaw-goal.ts` 复制到 `~/.pi/agent/extensions/`（全局自动发现）；
- 或在 `~/.pi/agent/settings.json` 中注册路径：

```json
{ "extensions": ["/绝对路径/qing-claw/extensions/qingclaw-goal.ts"] }
```

## 测试

RPC 模式端到端验证 goal 循环（启动常驻 agent，发送一个需多次唤醒的目标，
观察其被自动续跑直至 `goal_complete`）：

```bash
node scripts/rpc-goal-test.mjs
```

可通过环境变量覆盖 provider/model：`PI_PROVIDER`、`PI_MODEL`。

## 目录结构

```
├─ extensions/
│  └─ qingclaw-goal.ts        # 自研 /goal 长目标循环扩展
├─ scripts/
│  └─ rpc-goal-test.mjs       # goal 循环 RPC 端到端测试
└─ packages/
   ├─ ai/                     # 统一 LLM API、模型注册、各 Provider 实现（上游）
   ├─ agent/                  # agent 内核：消息循环、工具调度（上游）
   ├─ coding-agent/           # CLI 主体：TUI、会话、read/edit/bash 工具（上游，已品牌化）
   ├─ tui/                    # 终端界面组件库（上游）
   └─ mom/                    # IM 接入模块（上游，未启用）
```

## 致谢与许可

- 上游项目 [badlogic/pi-mono](https://github.com/badlogic/pi-mono) 由 Mario Zechner 开发，MIT 协议，
  感谢其出色的设计与文档。本仓库的 `packages/` 核心能力全部来自上游。
- qingClaw 的个性化改动（`extensions/`、`scripts/`、品牌化、文档）同样以 MIT 协议发布。
- 学习过程参考了 [Learn-OpenClaw](https://github.com/user/Learn-OpenClaw) 教程的思路
  （Agent = workflow + loop + tools）。
