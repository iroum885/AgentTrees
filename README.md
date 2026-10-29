# plugintree —— 思维链树

把 Agent 每次回答后的**思考、决策、执行、询问**记录下来，按"一次提问 = 一棵树"组织，
在本地浏览器里实时展示成一棵可展开的树。

```
用户：帮我看下配置文件
└─ 策略：读取文件
   └─ 执行：读取文件 .\config.yaml        [1.2s]
      └─ 策略：写入文件
         └─ 执行：写入文件 .\config.yaml   [0.3s]
```

---

## 它是怎么工作的

| 层 | 机制 | 产出 |
|---|---|---|
| 采集 | MiniMax Code **Plugin Hook**（11 个事件） | `<工作区>/.plugintree/events/<session>.jsonl` |
| 取思考 | Hook 的 `transcript_path` 增量尾读 | assistant 的 `thinking` / `text` 块 |
| 机械建树 | 按 `turn_id` 切分回合，按事件顺序折叠 | 每回合一棵忠实事件树 |
| 展示 | 本地 HTTP + SSE + 零依赖前端 | 浏览器里的实时树图 |

关键点：**Hook 本身拿不到 Agent 的思考文本**，但它的 stdin 带着 `transcript_path`，
指向一份 Claude 兼容的 transcript。采集器对它做增量尾读（按字节偏移，只读新增部分），
把 `thinking` 块抽出来落到事件流里。

树在**每个 Hook 事件之后**都会重写一次，所以 Agent 还在干活的时候，页面上的节点
就已经一个一个长出来了，不用等这一轮结束。

整条链路**不调用任何模型**：节点标题、文件路径、命令与耗时全部由固定规则生成。

### 建树规则

- **根节点 = 用户在消息框里发出的那条消息**（不是 Agent 的提问）。
  问卷场景下运行时会把 `Q: <Agent 的问题>` / `A: <用户的回答>` 一起塞进一条 user 消息，
  取的是 **A 段**；多个回答合并成**一个**根节点。没有真人消息的系统通知回合直接跳过。
- **思考步骤层层递进**：每个策略节点是上一个策略节点的子节点。
- **本层执行聚成下一层策略**：两次思考之间发生的工具执行，成为**后一个**策略节点的证据子节点。
- **向用户提问本身是策略节点**（`ask_user`、权限请求），不是执行节点。
- **执行节点标题是确定性的中文**：`读取文件 .\a.txt`、`执行命令：ls -la`、`写入文件 .\b.txt`。
- **策略节点标题也是确定性的中文**：由它产出的动作聚合而来，例如 `策略：读取文件、写入文件 等3项`；
  没有子动作时回退到思考原文的首句。
- **文件路径一律相对工作区**：`<工作区>/a/b.txt` → `.\a\b.txt`；工作区外的路径保留绝对形式。
- **每个节点都有耗时**，节点框内单独一行灰色小字（`耗时 1.2s`）：
  - 执行节点 = 工具真正跑的时间；
  - 策略节点 = 模型思考的时间（从上一个动作结束算到下一个动作开始）；
  - 根节点 = 从提问到 Agent 第一个动作之间的等待。
  模型思考是实实在在的等待时间，所以它和执行耗时一样被记在卡片上。

## 安装

```bash
node scripts/install.mjs
```

装到 `<dataDir>/plugins/plugintree/`（默认 `C:/Users/iroum/.minimax/plugins/plugintree/`）。
装完 MiniMax Code 会自动识别，插件默认启用。

要求：Node.js 18+（本机实测 v24）、Windows / macOS / Linux。

## 使用

```bash
# 启动树图页面（后台常驻），会打印一行 JSON 含访问地址
node "C:/Users/iroum/.minimax/plugins/plugintree/scripts/serve.mjs"

# 回填最近 20 个历史会话
node "C:/Users/iroum/.minimax/plugins/plugintree/scripts/backfill.mjs" --sessions 20
```

页面提供：左侧回合列表（可搜索 / 按实时与历史筛选）、中间可平移缩放的树图、
右侧节点详情、单树导出 HTML / Markdown。

- 打开一棵树时**默认停在根节点、缩放 100%**，卡片上的字一眼能看清；
  想一眼看全整棵树就点工具栏的「适应窗口」。
- **实时跟随最新一轮**：新的提问一开始，页面就切到那一轮，节点随 Agent 的动作逐个出现。
  自己点开某一轮旧树就会停止跟随；再点回最上面那条即可恢复跟随。
- 页面右上角的胶囊提示「Agent 正在思考 · 已等待 x」表示这一轮还没结束，
  等待时长一直在走——思考的时候不会触发任何 Hook，这段时间只能这样显示。
- 点击**执行节点** → 详情面板显示一行完整命令，例如 `read: .\hello.txt`。
- 点击**策略节点** → 详情面板显示策略原文。
- 节点框内底部单独一行灰色小字是这个节点的耗时，执行与思考都有。

Agent 侧通过插件自带的 `plugintree` Skill 完成同样的操作。

## 数据布局

```
<工作区>/.plugintree/
  config.json                     # 端口等运行参数
  events/<session_id>.jsonl       # 实时采集的规范化事件
  events-history/<session_id>.jsonl
  trees/<turn_id>.json            # 每回合一棵树
  state/                          # transcript 字节偏移、回合状态
```

事件类型：`session_start` `session_end` `user_prompt` `reasoning` `tool_call`
`tool_result` `permission` `subagent_start` `subagent_stop` `stop` `compact`。

`.plugintree/` 含完整对话内容，**不要提交进版本库**。

## 配置

`<工作区>/.plugintree/config.json`：

```json
{
  "port": 47731,
  "maxReasoningChars": 12000
}
```

- `port`：树图页面端口。
- `maxReasoningChars`：单条思考文本保留的最大字符数。

## 开发

```bash
node tools/selftest.mjs            # 90 项自检：标签映射、Hook 采集、建树、耗时、导出
node tools/validate-package.mjs    # 插件包静态校验（清单/钩子契约/路径安全）
node tools/rebuild.mjs             # 按当前规则重建全部树（改过建树规则后跑）
node tools/list-trees.mjs          # 列出工作区里的树
node tools/show-tree.mjs <turnId>  # 打印一棵树的大纲
node tools/diagnose.mjs            # 回填质量诊断
node tools/inspect-roots.mjs       # 检查每棵树的根节点是不是用户消息
node tools/check-sse.mjs           # 验证 SSE 实时推送
node tools/export-sample.mjs       # 重新生成 exports/ 里的样例导出
```

`tools/` 只在开发时用，不随插件安装。

## 已知限制

- **实时性以 Hook 触发为准**：思考文本依赖 transcript 落盘，所以一次思考的节点
  会在**下一个** Hook 事件到来时才出现在页面上（通常就是紧接着的工具调用）。
  一次长思考期间不会有任何 Hook 触发，页面这时显示「正在思考 · 已等待 x」。
- **历史会话没有工作区信息**：回填的树统一归档到运行回填时的工作区；工作区外的文件路径保持绝对形式。
- **耗时来自时间戳之差**：实时采集取 PreToolUse→PostToolUse 的间隔，思考耗时取
  相邻事件之间的时间差，历史回填取 `messages.jsonl` 里 `toolCall` 与 `toolResult`
  消息的时间差。缺时间戳的事件会沿用最近一次已知的时间戳。
- **数据体积**：树里内嵌完整思考原文，回填几十个会话后 `.plugintree/` 可达几十 MB。
  已放在 `.gitignore`，但别把它同步到网盘或 CI 缓存。
