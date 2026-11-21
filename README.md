# dsh-nvidia-nim

DeepSeek Harness 的 NVIDIA NIM 模型供给插件：在 DSH 里注册一条 `nvidia-nim` 模型路由，把
`https://integrate.api.nvidia.com/v1`（OpenAI Chat Completions 兼容）接到模型选择器，
并用一个可配置的 API Key 池承担限流与失败重试。

- 模型来源：插件配置里的模型列表 + 端点 `GET /models` 的模型目录（带缓存）。
- 密钥池：支持多个 Key，每个 Key 独立计时，互相不拖累。
- 每 Key 限流：每秒最多 1 次请求；每分钟最多 40 次请求；超限的请求排队等待，等窗口腾出位置再发。
- 失败重试：任何一次请求失败（网络、5xx、429、空响应等）先休眠 2 秒再发起；已经吐出内容后不再重发，避免重复输出。
- Key 健康度：被 401/403 拒绝的 Key 本次进程内不再使用；429 的 Key 按 `retry-after`（否则 1 分钟）冷却。

## 安装

插件目录本身就是 bundle（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。

1. 在 DSH Web 界面打开 **插件（Plugins）**，用 **添加插件（Add plugin）** 选择本目录
   `E:\codes\project_about\dsh-nvidia-nim-plugin`；
2. 启用后 DSH 会按 `cordis.patch.yml` 插入 `llm-nvidia-nim` 这一行，模型路由随即出现在模型选择器里。

行 id 固定为 `llm-nvidia-nim`，改配置时覆盖这一行即可，不需要重新安装。

## 配置 API Key（不要提交到 git）

按下面的顺序读取，全部为可选来源，重复的 Key 会自动去重：

| 来源 | 写法 | 说明 |
|---|---|---|
| 环境变量 | `apiKeyEnvs: [NVIDIA_NIM_API_KEY]` | 默认值就是 `NVIDIA_NIM_API_KEY`。一个变量里可以用逗号、分号或换行放多个 Key |
| Key 文件 | `keysFile: D:/secrets/nvidia-nim.keys` | 每行一个 Key，`#` 之后是注释。留空时默认尝试 `$DSH_HOME/nvidia-nim.keys` |
| 行内配置 | `apiKeys: [...]` | 只适合临时验证：它会写进 profile 的 patch 文件 |

`.gitignore` 已排除 `*.keys`、`nvidia-nim.keys`、`.env*` 和开发用的 `.tmp/`；本仓库不含任何 Key。

## 插件详情页（账号管理 / 模型筛选）

在 DeepSeek Harness 页面**点击左上角的「插件」**，进入 **dsh-nvidia-nim** 详情页即可管理（该卡片注册在 `plugins.bundle.config` 槽位，显示在描述与行之间；同时也保留在 **设置 → 插件 → dsh-nvidia-nim** 标签页）。卡片分两个标签页：

**账号（token）** — 管理每一个添加的密钥：

- **批量添加**：把多行文本粘进输入框，**每个非空行当作一个 Key**（去首尾空白、支持带引号），点“批量添加”即写入密钥文件；
  空行忽略、重复行跳过、含空格或不可见字符的行会被指出行号并忽略。添加后**不需要重载插件**，
  下一次模型请求就会参与轮换。
- **每个密钥一行**：显示掩码（如前 6 位与后 4 位）、备注名、状态点与状态文字（`可用` / `已暂停` / `不可用 · 原因` / `冷却中 N 秒` / `未测试`）。
- **单独测试**：每行有 **测试** 按钮，只对**这一个 Key** 发一次单 token 的 `chat/completions` 请求，结果直接显示在卡片顶部
  （`该密钥可用 · N 个模型` / `该密钥不可用 · 原因`），并更新该行的状态点。
- **标记状态**：每个密钥都可以 **暂停 / 恢复**（暂停的密钥保留在列表里但不参与轮换）、**置顶 / 取消置顶**（同时可用时优先选中）、
  **改备注**（自定义名字，留空清除）、**删除**。暂停与置顶、备注存在密钥文件旁的
  `nvidia-nim.keys.meta.json` 里，重启后仍在。
- **批量测试**：为每个 Key 各发一次单 token 请求，结果标在列表里。

**模型（model_id）** — 筛选对话模型选择器里可调用的模型：

- 列出端点目录与配置里的全部模型，勾选即启用；工具栏有 **全选** 与 **反选** 两个按钮，并显示 `已选 N/总数`。
- **全选 = 空选择 = 全部可用**（模型选择器不会因为空选而消失）。
- 勾选结果写到密钥文件旁的 `nvidia-nim.keys.models.json`，**不需要重载插件**，下一次模型选择器刷新即生效。
- **刷新模型**：重新拉取端点 `GET /models` 目录（消耗一次请求额度）。

实现方式：浏览器端无法直接写文件，所以 Host 半在 `127.0.0.1` 的 `19871–19875` 端口上起一个很小的管理服务，
标签页直接调用它。所有响应只返回掩码，不返回 Key 原文；服务只接受回环 `Host`、要求 `x-nvidia-nim-manager`
请求头，并且只对回环页面源、Electron 的 `null` 源和 DSH Desktop 的自有协议源放行 CORS（普通网站一律拒绝）。
任何本机进程仍然可以调用它 —— 但它们本来就能直接读密钥文件。设置 `managerEnabled: false` 可完全关闭这个服务。
页面以 https 打开而管理服务是 http 时，浏览器会拦截混合内容，标签页会提示服务不可用。

批量测试会真实消耗额度：每个 Key 一次请求 + 最多 1 个输出 token。`GET /models` 是公开接口（不需要 Key），
所以它不能用来判断 Key 是否有效，测试改用一次最小补全。

## 配置项

```yaml
- id: llm-nvidia-nim
  name: dsh-nvidia-nim
  config:
    baseURL: https://integrate.api.nvidia.com/v1
    apiKeyEnvs: [NVIDIA_NIM_API_KEY]
    requestsPerSecond: 1        # 每个 Key 每秒最多发起的请求数
    requestsPerMinute: 40       # 每个 Key 每分钟（滑动 60 秒）最多发起的请求数
    errorDelayMs: 2000          # 失败后休眠多久再发
    maxAttempts: 4              # 单个请求最多尝试几次（1 = 关闭插件内重试）
    models: []                  # 额外声明/覆盖的模型，排在选择器最前
    discoverModels: true        # 是否把 GET /models 的结果也列出来
```

完整字段与默认值见 `lib/config.js` 的 `FIELDS`；未知字段会直接报错，避免拼写错误被静默忽略。

| 字段 | 默认值 | 作用 |
|---|---|---|
| `provider` | `nvidia-nim` | 路由名（模型请求里的 `provider`） |
| `displayName` | `NVIDIA NIM` | 选择器里显示的名字 |
| `baseURL` | `https://integrate.api.nvidia.com/v1` | OpenAI 兼容端点，末尾斜杠会去掉 |
| `models` | `[]` | `{ id, name?, contextWindow?, maxTokens? }`；也可以直接写模型 id 字符串 |
| `discoverModels` | `true` | 是否用 `GET /models` 补全模型列表 |
| `discoveryCacheMs` | `600000` | 模型目录缓存时长；`0` 表示本次进程内只取一次 |
| `requestTimeoutMs` | `600000` | 单次请求总超时；`0` 关闭 |
| `idleTimeoutMs` | `180000` | 流式响应多久没有新数据就中止；`0` 关闭 |
| `defaultContextWindow` | `131072` | 未声明模型的上下文窗口 |
| `defaultMaxTokens` | `4096` | 请求没带输出上限时发送的值 |
| `maxTokensField` | `max_tokens` | 输出上限字段名，可改成 `max_completion_tokens` |
| `includeUsage` | `true` | 请求 `stream_options.include_usage`，让末帧带用量 |
| `extraHeaders` | `{}` | 额外的请求头（例如自建网关的鉴权头） |
| `managerEnabled` | `true` | 是否启动设置页使用的回环密钥管理服务（批量添加/测试/删除） |

## 限流与重试的具体行为

- **每 Key 每秒 1 次**：同一把 Key 上两次请求的发起时间至少间隔 1 秒（实现里留了 50ms 余量，
  实测间隔约 1.05 秒），排队请求不会挤在同一时刻。
- **每 Key 每分钟 40 次**：按滑动 60 秒窗口统计已经发出的请求；窗口满了就让请求等到最早的那次
  请求滑出窗口再发（即「最后一分钟里少于 40 次之后」）。
- **多 Key 调度**：每次请求选择「最快能发」的那把 Key，所以空闲 Key 会立刻被用上，繁忙 Key 不会
  阻塞其他 Key。两把 Key 可以真正并行。
- **失败重试**：`fetch` 抛错、非 2xx（408/429/5xx 等）、流在中途断掉、空响应都算失败；休眠
  `errorDelayMs`（默认 2000ms）后重发，最多 `maxAttempts` 次。401/403 时如果还有其他可用 Key，
  会换 Key 重试。已经向调用方吐出文本/推理/工具调用之后不再重发，此时失败交给
  `dsh-llm-retry` 在 agent 步骤级别处理。
- **模型目录请求同样受限**：`GET /models` 也走同一个 Key 池和同样的限流。

## 在 DSH 中使用

- 聊天界面的模型选择器里会出现 `NVIDIA NIM` 分组（模型来自配置 + 端点目录）；
- 想让新会话默认用它，把 `agent-default-model` 指向该路由：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: nvidia-nim
    model: z-ai/glm-5.3-flash   # 用选择器里实际存在的 id
```

## 请求转换

- 会话历史按 OpenAI Chat Completions 组装：首条 system 原样发送；中途变化的 system 变成
  `<system-reminder>` 用户消息；developer（工具增删）消息不发送，因为这条路由每次都声明完整工具表。
- 助手历史只回放可见文本和工具调用，不回放推理内容。
- 响应里的 `reasoning_content` / `reasoning` / `thinking` 增量映射为推理块，`content` 映射为文本块，
  `tool_calls` 按 provider index 各自成为一个工具块（交错的参数片段也能正确归档）。
- 用量按 DSH 的口径拆分：`prompt_tokens` 扣掉 `cached_tokens` 记作输入，缓存命中单独记录。
- 本路由声明为纯文本模型，图片会由 DSH 统一替换成占位文本后再发出。

## 测试与验证

```powershell
node --test "test/*.test.mjs"     # 单元测试：限流窗口、密钥解析、SSE 分帧、流式翻译、失败重试
node scripts/live-check.mjs       # 用真实 Key 跑一次：模型目录 → 一次回答 → 观测发起间隔
```

`scripts/live-check.mjs` 只从环境变量或 key 文件读密钥，不会打印密钥本身；任一检查失败就以非 0 退出。

本机实跑记录（2026-11-21，`https://integrate.api.nvidia.com/v1`）：

- `GET /models` 返回 33 个模型，模型选择器直接可用；
- `z-ai/glm-5.3-flash` 的推理块、文本块、工具调用（`get_weather`，参数 `{"city":"San Francisco"}`）、
  用量统计均正确映射；
- 单 Key 并发 4 个请求，实际发起时刻为 `0ms / 1057ms / 2112ms / 3170ms`，间隔 ≈1.05 秒；
- 两把 Key 同时发起，两组请求互不等待；
- 连接被拒时按 `2000ms` 间隔重试，4 次尝试的总耗时 6026ms；
- 不存在的模型返回 `UNKNOWN_MODEL`（HTTP 404）。

密钥管理服务在运行中的 DSH 上验证过（`http://127.0.0.1:19871`）：

- `GET /state` 只返回掩码（`nvapi-…V7kP`）与来源标签，响应中不含 Key 原文；
- `POST /keys/add` 一次加入 2 行，重复行被计数跳过，池立即从 1 把变成 4 把（无需重载）；
- `POST /keys/test` 对真实端点逐个测试：真 Key `ok=true, 200, 33 个模型`，伪造 Key `ok=false, 403, AUTH`；
- `POST /keys/remove` 删掉那一行并让池恢复原状；
- 缺少标记请求头、或 `Host` 非回环的请求返回 403；只有回环页面源拿到 CORS 许可。

## 已知限制

- 只支持文本模型；图片输入会以占位符呈现给模型。
- 未声明 `systemPromptUpdate` / `toolUpdate`，所以中途的 system 变化会以 reminder 形式发送，
  工具表每次完整发送。
- 推理强度（`reasoningEffort`）不发给端点：各家 NIM 推理模型对思考开关的字段名不一致，
  交给模型默认行为。若请求显式指定了推理强度，DSH 会在发起前以 `UNSUPPORTED_REASONING_EFFORT` 拒绝。
- 模型目录来自 `GET /models`，只反映该 Key 账号可见的模型；未被目录列出的模型仍可手写进 `models`。
- 被判定为鉴权失败（401/403）的 Key 只在本进程内禁用，DSH 重启后重新尝试。