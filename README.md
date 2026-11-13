# dsh-exec

中文 | [English](README.en.md)

**在终端、脚本或 CI 里一行调用 DeepSeek Harness，并且会话会实时出现在桌面端侧边栏。**

```sh
dshx "把这个仓库的 lint 报错全部修掉"
dshx --cwd D:/repo --mode ptc "调研滚动闪烁的原因" > answer.txt
dshx --json "跑一遍测试" | jq -r 'select(.type=="final") | .text'
```

定位很简单：`codex exec` 那种形态，但它跑在**你自己的桌面端**里 —— 用你已经配好的模型、插件、技能和权限，结果既回到 stdout，也留在 GUI 里。

## 为什么不是 `dsh --profile headless`

headless profile 会写出完全合法的会话文件，但**侧边栏不扫描那个目录**：它读的是 `ctx.workspaceRegistry`，索引在内存里，只有**创建**会话的那个进程才会把会话 attach 到工作区。外部进程自己改 `workspace.json` 会被桌面端的内存副本覆盖掉。

所以这个插件把控制面注册在桌面 host 内部，每个会话都通过 `sessionController.create({ workspaceId, agentPreset })` 创建：工作区行被 upsert、会话在进程内 attach、UI 从第一个 token 起就能跟着更新。

代价说清楚：**桌面端必须开着**。没开时 `dshx` 会明确报"找不到 bridge 文件"，不会静默降级成 headless。

## 安装

```sh
dsh plugin --profile desktop add dsh-exec
```

带 client 半边的插件，装完/更新后**完全退出 App 再打开**（HMR 说 `applied` 不代表下次启动能加载）。

装好后设置面板里会多一个「命令行执行」页；命令行两个入口都可用：`dsh-exec` 和 `dshx`（同一个脚本）。

> 名字提示：`@why913/dshx` 这个包也声明了 `dshx` 命令（MCP/Skill 管理，功能不重叠）。两个都全局安装的话，用 `dsh-exec` 这个入口避开冲突。

## CLI

| 命令 | 作用 |
|---|---|
| `dshx "TASK"` | 建会话、跑任务、把最终回答打到 stdout |
| `dshx --cwd DIR "TASK"` | 指定工作目录（决定侧边栏分组） |
| `dshx --session ID "TASK"` | 续接已有会话 |
| `dshx --mode standard\|ptc\|minimal\|cordis "TASK"` | 显式选预设 |
| `dshx --model M --provider P --effort E "TASK"` | 仅本次运行覆盖模型 |
| `dshx --permission P --approval A "TASK"` | 仅本次运行的权限 / 审批 |
| `dshx --task-file PATH` | 从 UTF-8 文件读任务（`-` = stdin），**Windows 多行必用** |
| `dshx --json "TASK"` | stdout 输出 NDJSON 事件流（`codex exec --json` 风格） |
| `dshx --verbose "TASK"` | stderr 输出实时执行轨迹（opt-in） |
| `dshx --log RUN_ID` | 回放某次运行的执行记录（只含元数据，不 dump 回答） |
| `dshx --status` / `--runs` / `--stop RUN_ID` | 桥状态 / 运行列表 / 取消 |

**默认输出只有最终回答**，stderr 完全静默，所以 `dshx "TASK" > answer.txt` 是干净的。执行记录一律 opt-in。完成一轮退出码 0，否则 1。

### Windows 多行任务

`cmd.exe` 在第一个换行处截断命令行 —— 7000 字的 prompt 会变成第一段。这是 shell 的限制，不是插件的：

```powershell
$path = Join-Path $env:TEMP 'task.txt'
[System.IO.File]::WriteAllText($path, $task, [System.Text.UTF8Encoding]::new($false))
dshx --cwd 'D:/repo' --task-file $path
```

## 四个模式

宿主自带四个 Agent 预设，本质是四份插件清单；这里都能选（`--mode` 或设置页）：

| 模式 | 是什么 | 适合 |
|---|---|---|
| `standard` | 全功能编码 Agent：文件编辑、Shell、检索、Skills、计划、子代理 | 大多数任务（默认） |
| `ptc` | 标准模式全量 + Code Mode SDK：模型写一段 TypeScript 编排多步工具调用，五次往返变一次 | 复杂多步任务 |
| `minimal` | 只有持久 bash + 编辑器，固定提示词，无压缩无子代理 | 基准测试、控制变量 |
| `cordis` | 标准模式 + `cordis_*` 自指工具：能检视、挂载、替换自己运行时里的插件 | 写插件、造自定义预设 |

界面上 `ptc` 和 `minimal` 默认藏在「代码工作工具」开关后面，但预设 id 本身可用，所以 `--mode` 直接选得到。

**这是这个插件和官方一次性 headless 最实质的区别。** `dsh --profile headless "TASK"` 走的是 `@deepseek-ai/dsh-headless`（一个直接跑 core Agent/Session 的 bundle，没有 Host 层），它的组合里**没有 `agent-preset-registry`** —— 可以自己验：

```sh
dsh --profile headless --dump-config | grep preset   # 只有 permission-presets
dsh --profile web      --dump-config | grep preset   # agent-preset-registry 在这里
```

预设只存在于 web/desktop 那套组合里。`dsh-exec` 是在桌面进程内通过 `sessionController.create({ agentPreset })` 建会话的，所以等于把那四个预设借出来给命令行用：同一个 `dshx`，换个 `--mode` 就是另一种 Agent。

## 和别的"headless 命令行"比

| | `codex exec` | `claude -p` | `dsh --profile headless` | `dshx` |
|---|---|---|---|---|
| 一行调用、stdout 出最终回答 | ✅ | ✅ | ✅ | ✅ |
| 会话留在**同一个** GUI 里、能点进去继续 | 各自 CLI 的会话，不进 DSH | 各自 CLI 的会话，不进 DSH | ❌ 侧边栏看不见 | ✅ 侧边栏实时更新 |
| 可选 Agent 预设 | — 一套 | — 一套 | ❌ 组合里没有 preset registry | ✅ standard / ptc / minimal / cordis |
| 复用本机已配好的模型、插件、技能、权限 | — | — | ✅ | ✅ |
| 流式事件给程序消费 | 自家 JSON 格式 | 自家 stream-json | — | ✅ `--json`（NDJSON） |
| 长任务静默期的心跳 | — | — | — | ✅ `progress{alive:true}` |

"—" 是"这个工具没有这个概念"，不是缺点：`codex exec` 和 `claude -p` 各自有成熟的会话体系，只是那套体系不在 DSH 里。最后一行针对的是 Gemini 这类会长时间 429 的 provider —— 静默 5 分钟到底是"在等"还是"挂了"，只有心跳能回答。

## 默认值是"中性"的

这个包会装到**别人的机器**上，所以出厂默认不绑定作者的任何偏好：

- **不固定模型**（`defaultModel: ''`）。留空 = 沿用桌面端当前模型。只有你填了模型并打开 `enforceDefaults`，新会话才会被 `selectModel` 钉住 —— 硬编码一个别人机器上没有的模型会让每次运行都失败。
- **权限 `workspace-write` + 审批 `never`**：够干活，也不会在无人值守时卡在审批弹窗上。`danger-full-access` 是**单次运行的选择**（`--permission danger-full-access`），不是默认值。
- 不传 `--model` / `--effort` 就一个都不发，不会被隐藏默认值影响。

想改本机默认值：打开设置页保存即可，**不必**改 YAML——存到 `<DSH_HOME>/plugin-data/dsh-exec/config.json`，叠加在 profile 的 `cordis.patch.yml` 之上（「恢复配置默认值」会删掉这个文件）。当然想直接改 YAML 也行，那一层是 profile 自己的，优先级比这个文件低。

## 设置页

`设置 → 命令行执行`（中英双语，跟随界面语言）：

- 默认模式（四个预设）、默认模型 / 模型来源 / 思考档位
- 是否把新会话强制钉在上面那个模型
- 权限、审批策略、是否自动创建工作区
- 心跳间隔、并发上限
- 保存 / 恢复配置默认值

页面上同时显示桥状态（在线、运行中、累计运行、429 重试次数、pid 与端口）。

## HTTP API

全部走回环地址；除标注外需要 `Authorization: Bearer <token>`（token 在 `<DSH_HOME>/storages/dsh-exec.json`，权限 0600，从不进入渲染进程）。

| 路由 | 方法 | 用途 |
|---|---|---|
| `/dsh-exec/status.json` | GET | 桥状态、计数、生效配置（免 token，且不含运行详情） |
| `/dsh-exec/runs.json` | GET | 运行列表 |
| `/dsh-exec/runs.json` | POST | `{task, cwd?, sessionId?, mode?, model?, provider?, effort?, permission?, approval?}` → 202 + run |
| `/dsh-exec/runs.json` | POST | `{action:"stop", runId}` → 取消 |
| `/dsh-exec/events.jsonl?runId=…&since=N` | GET | NDJSON 流，可从 `since` 重放；`snapshot=1` 回放后立即关闭 |
| `/dsh-exec/config.json` | GET | 生效配置（免 token） |
| `/dsh-exec/config.json` | PUT | 保存默认值；需要同源或 bearer token |

响应里从不包含任务正文，也不包含 token。

## 429 不是崩溃

Gemini 系列会频繁返回 `429 RESOURCE_EXHAUSTED`。它只终止那一次尝试：重试层等 30–300 秒后在同一个 turn 里重跑同一步。等待期间会话日志几乎不动，这种安静很容易被误读成"进程死了"。

所以桥每 `heartbeatMs`（默认 15 秒）发一个 `progress` 帧，带 `elapsedMs`、`silentMs`、`steps`、`retries` 和 `alive: true`，外加带 provider 错误码的 `retry` 帧。`dshx` 会明说"Gemini 正常现象，turn 还在跑"。**判断存活看心跳，不要看日志安静不安静。**

## 退出取证：谁关掉了 DSH

host 会在 `<DSH_HOME>/storages/` 写两个文件：

| 文件 | 行为 |
|---|---|
| `dsh-exec-heartbeat.json` | 每 `lifecycle.heartbeatMs`（20 秒）覆盖写：pid、ppid、uptime、RSS、堆、活跃运行数 |
| `dsh-exec-lifecycle.jsonl` | 追加式关键事件，超过 `lifecycle.maxLogBytes`（512 KB）轮转 |

记录的事件：`start`、`before-quit`（**带调用方堆栈**）、`window-close`、`window-all-closed`、`will-quit`、`quit`、`exit`、`signal`、`uncaught`、`unhandled-rejection`、`os-shutdown` / `os-suspend` / `os-resume`。

下次启动会判定上一个进程：

| 判定 | 证据 | 含义 |
|---|---|---|
| `clean` | `before-quit` → `quit`/`exit` 且晚于最后一次心跳 | 正常退出；堆栈指出是谁发起的（托盘菜单、更新器、菜单项） |
| `killed` | 心跳是新的，但**没有任何**退出事件 | `TerminateProcess`（任务管理器 / 清理工具）、硬崩、断电 |
| `crashed` | 有 `uncaught` 记录 | host 未捕获异常 |
| `unknown` | 心跳远早于下次启动 | 机器睡眠 / 关机，或心跳早就停了 |

用 `dshx --status` 看 `lastExit`。`TerminateProcess` 无法指名凶手（Windows 不告诉受害者），但能证明"不是通过它自己的菜单退出的" —— 这通常就是关键区别。

## 已知边界

- **只有 desktop profile 有这些服务。** `sessionController` / `workspaceRegistry` / `webServer` / `agents` 不是文档化的插件 API；web / headless / acp profile 里它们不存在，插件会安静地不激活。跨版本可能碎，`engines.dsh` 只声明验证过的范围（`0.2.x`）。
- 事件流在内存里，有上限（`maxEventBuffer`）。缓冲滚掉之前用 `since` 重连。
- `stop` 是请求取消；已经在飞的一步可能先跑完。
- 桌面端必须运行，没有 headless 兜底。

## 开发

```sh
node tests/offline.cjs     # 假 ctx + 假 webServer，不起真实进程
```

覆盖：配置归一化与分层、请求校验、事件投影、四个路由、token / 回环 / 同源授权、工作区 + 预设 + 权限接线、只在被要求时覆盖模型、实时 NDJSON、`turn/end` 上的 `final`、免 token 状态的脱敏、bridge 文件清理、HMR 重载复用 token。

## License

MIT
