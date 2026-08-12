# P0a — Pi 0.84.1 扩展加载与工具替换语义探针

日期: 2026-08-12
探针: `p0a-probe.ts` (sha256 `1351180048d4ffced956b89075bb2bfd31ba150ae171d77212af7c3fdbe51ec1`)
驱动: `p0a-driver.mjs` (sha256 `3826b75acd72e685662ca79f9c57404ee6256b5bd23d289a7525742d0d47cf16`)
确定性 runner: `run-p0a.mjs` (sha256 `ce4e94ea52d7bf0153a520c59b0d35d61ba5ddf99e84c08e70623257f290c112`)

## 范围

P0a 只回答两个问题（Phase 0 拆分后的问题 1-2）：

1. 显式 `--extension` 与 `--no-extensions`（禁用发现）能否共存？
2. `--no-builtin-tools` + 同名工具注册能否完整替换内置工具，是否存在 fail-open 路径？

沙箱后端本身（Bubblewrap/Gondolin）属于 P0b，不在本探针范围。

## 环境（与 phase-0-inputs.md 钉定基线一致）

| 输入 | 实测值 |
| --- | --- |
| Pi | `@earendil-works/pi-coding-agent@0.84.1` |
| Node.js | `v24.14.0` |
| 内核 | `7.0.0-28-generic` |
| 运行方式 | 全局安装 `pi` CLI，`--mode rpc`，offline，独立 fixture profile |

## 实验矩阵

所有实验使用独立 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` fixture，
临时空 `HOME`、最小环境、`PI_OFFLINE=1 PI_TELEMETRY=0`，工作目录
`spikes/p0a/workspace`。没有传递 provider 凭据，也没有 provider 调用。

### A1 — 显式扩展在 `--no-extensions` 下加载 ✅

命令:
```sh
pi --mode rpc --no-session --no-extensions \
   --extension spikes/p0a/p0a-probe.ts \
   --no-builtin-tools --tools read,write,edit,ls,grep,find,bash \
   --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve
```

证据 (`a1.log`):
- `=== extension evaluated ===` + 7 个工具 `registered tool:*` + `[session_start]`
- `get_commands` 的精确命令集为 `llama,p0a`
- `getAllTools()` 的精确工具集为 7 个工具，全部 `source=cli`，且实际
  `sourceInfo.path` 均为哈希固定的 `p0a-probe.ts`
- `getActiveTools` 的精确集合也是这 7 个工具

### A2a — `--no-extensions` 阻止自动发现 ✅

命令: 无 `--extension`，在 `workspace/.pi/extensions/auto-discovered.ts`
放置会写日志的扩展，并和 A2b 一样传 `--approve`；两者只在
`--no-extensions` 上有关键差异。

证据: `p0a-discovered.log` **未生成**（扩展未加载），精确命令集只有
`llama`。无工具 attestor 同时证明 `getAllTools()` 精确包含 7 个 inactive
builtin，`getActiveTools()` 为空，没有 `llama` 或其他扩展工具。

### A2b — 对照组：发现机制本身工作 ✅

命令: 无 `--no-extensions`，加 `--approve`。

证据: `p0a-discovered.log` 出现 `auto-discovered extension LOADED`，精确命令集
为 `auto-discovered,llama`。
证明 A2a 的阴性结果是 `--no-extensions` 开关生效，而非发现机制失效。

### B1 — 漏注册工具的 fail-open ⚠️ 关键发现

命令: `P0A_SKIP_TOOLS=write`（扩展不注册 write），其余同 A1。

证据 (`b1.log`):
```
[cmd:p0a] getActiveTools=["read","write","edit","ls","grep","find","bash"]
[cmd:p0a] tool:write source=builtin   ← 内置 write 被重新激活
[cmd:p0a] tool:read  source=cli       ← 其余均为扩展
```

**结论: `--no-builtin-tools` + `--tools` 同时使用时，`--tools` 的 allowlist 会
重新激活同名内置工具，除非扩展注册了同名工具覆盖它。漏注册 = fail-open。**

### B2 — `--no-builtin-tools` 单独使用 ✅

命令: 同 A1 但去掉 `--tools`。

证据 (`b2.log`): 7 个工具全部 `source=cli` 且 active，无内置残留。

### B3 — RPC 直接 bash 被扩展完整接管 ✅

命令: `P0A_BASH_OVERRIDE=1`，user_bash handler 返回固定 `result`
(`P0A_EXTENSION_OWNED_BASH`)。RPC 发送 `{"type":"bash","command":"echo P0A_BASH_PROBE_OK"}`。

证据 (`b3.log` + RPC 输出):
```
[user_bash] event command="echo P0A_BASH_PROBE_OK" cwd=... excludeFromContext=false
response data.output = "P0A_EXTENSION_OWNED_BASH\n"   ← 不是真实命令输出
```

**结论: RPC 直接 bash 触发 `user_bash` 事件，扩展返回 `{operations}` 或
`{result}` 即可完整接管执行。**

### C1/C2 — 显式扩展工具名冲突双顺序拒绝 ✅

哈希固定的 `p0a-collision.ts` 也注册 `write`。Runner 分别以
`probe → collision` 和 `collision → probe` 两种顺序显式加载。

证据: 两次都在 RPC 初始化前非零退出，错误精确归因到 `Tool "write"
conflicts with`，且包含两个扩展路径。Pi 0.84.1 的 ResourceLoader 因而提供
需要的重复注册拒绝；`getAllTools()` 本身不能用来发现被遮蔽的重复注册。

## 发现汇总

| # | 发现 | 严重性 |
| --- | --- | --- |
| 1 | 显式 `--extension` 与 `--no-extensions` 共存，加载成功 | 利好 |
| 2 | 同名注册的扩展工具覆盖内置工具（`source=cli`），模型/工具走 registry | 利好 |
| 3 | RPC 直接 bash 走 `user_bash` 事件，扩展可完整接管 | 利好 |
| 4 | **`--no-builtin-tools` + `--tools` 存在 fail-open：漏注册工具名会重新激活内置同名工具** | **严重** |
| 5 | `--no-extensions` 不阻止内置 inline 扩展加载（`llama` 命令仍出现）；它只注册命令不注册工具，不污染工具集 | 需记录 |
| 6 | `getActiveTools()`/`getAllTools()` 在 `ExtensionAPI` 上，不在 `ExtensionContext` 上 | API 备忘 |
| 7 | 显式扩展的重复工具注册在 RPC 前失败，且两个加载顺序都失败 | 安全前提（须钉定） |

## 对 MVP 的强制约束（P0a 产出）

1. **hitch-sandbox 扩展必须注册全部 7 个工具**
   `read, write, edit, ls, grep, find, bash`（以及 `hitch_publish`）。
   漏一个 = `--tools` allowlist 会把内置同名工具重新激活 = 模型可绕过沙箱执行主机文件/进程操作。

2. **启动 attestation 必须逐工具校验来源**
   在接收任何 prompt 之前，调用 `getAllTools()`，对精确工具集合逐项断言
   `sourceInfo.source`、`sourceInfo.path`、schema 和 manifest 成员关系，任一
   `builtin`、错误来源、缺失或多余工具都拒绝启动（fail closed）。重复注册
   则依赖钉定 ResourceLoader 在 RPC 前拒绝，并保留双顺序回归测试。

3. **`user_bash` 是直接 bash 的唯一接管点**
   RPC `bash` 命令、`!`/`!!` 前缀都走该事件。扩展必须注册 `user_bash` handler
   并返回沙箱 operations，否则直接 bash 走内置本地执行。

4. **扩展清单 attestation 要包含内置 inline 扩展**
   `--no-extensions` 下 `llama`（inline llama.cpp router）仍加载。MVP 若不允许，
   需要确认禁用方式；若接受，需记录其命令清单且证明它不注册任何工具。

5. **Hitch 生产启动不使用 CLI `--tools` 重新激活同名名称**
   B2 证明仅使用 `--no-builtin-tools` 时，扩展工具正常激活且没有内置残留。
   Hitch 在所有显式扩展加载后，通过 mandatory extension API 设置精确 active
   allowlist，并逐项完成 source/schema/manifest attestation。这样漏注册会变成
   missing-tool 致命失败，而不是由 CLI allowlist 恢复 builtin。若未来重新加入
   CLI `--tools`，必须保留第 1、2 条全量注册和逐来源证明。

## 遗留验证点（不在 P0a 范围）

- 模型发起工具调用（非 RPC bash）实际执行路径的 live 验证 —— 源码级已确认
  registry 覆盖（`agent-session.js` `_refreshToolRegistry`），live 冒烟留给 P3。
- `hitch_publish` 作为第 8 个工具的注册与调用语义（P4 媒体）。
- `--no-approve` 是否完整阻止 AGENTS.md/context 文件加载（P1 配置固化时确认）。
- Bubblewrap/Gondolin 后端本身（P0b）。

## 复现

完整的无凭据确定性矩阵：

```sh
node spikes/p0a/run-p0a.mjs
```

命令失败即返回非零；成功时重写 content-free
`spikes/p0a/P0A-EVIDENCE.json`，包括精确运行时版本、探针/runner 哈希和
Pi 安装树哈希、全部 fixture 哈希和每项 sanitized outcome。Runner 对命令、
全部工具、active 工具和来源路径做精确集合断言，不只检查存在性。

原始单项驱动复现：

```sh
cd spikes/p0a/workspace
P0A_LOG=../a1.log PI_CODING_AGENT_DIR=../fixture/profile \
PI_CODING_AGENT_SESSION_DIR=../fixture/sessions \
timeout 60 node ../p0a-driver.mjs -- \
  --mode rpc --no-session --no-extensions \
  --extension ../p0a-probe.ts \
  --no-builtin-tools --tools read,write,edit,ls,grep,find,bash \
  --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve
```
