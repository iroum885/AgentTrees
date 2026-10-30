---
name: plugintree
description: 使用 PluginTree 查看、导出和维护"每次提问的思维链树"。当用户想看 Agent 某次提问是怎么一步步做下来的、想导出决策过程为 Markdown/HTML、想回填历史会话的思维链时使用。
---

# PluginTree 思维链树

PluginTree 通过 Plugin Hook 记录每次提问后的 Agent 行为（思考 / 决策 / 执行 / 询问 / 子代理），
按"提问 = 一棵树"组织，并提供本地浏览器页面实时展示。

整条链路不调用任何模型：节点标题、相对路径、完整命令与耗时都由固定规则生成。

插件目录（安装后）：`C:/Users/iroum/.minimax/plugins/plugintree/`
若该路径不存在，先在 `<dataDir>/plugins/` 下找 `plugintree` 目录。

数据目录：当前工作区下的 `.plugintree/`（事件原始记录、树 JSON、配置）。
工作区根目录取自 `MINIMAX_PROJECT_DIR` 环境变量，其次是当前工作目录。

## 何时使用

- "打开思维链树 / 让我看看你这次怎么做的"
- "导出这次提问的决策过程（Markdown / HTML）"
- "回填最近 N 个历史会话的思维链"

## 一、打开树图页面（最常用）

启动本地服务（后台常驻，Ctrl+C 退出）：

```bash
node "C:/Users/iroum/.minimax/plugins/plugintree/scripts/serve.mjs"
```

该命令会向 stdout 打印一行 JSON：`{"ok":true,"url":"http://127.0.0.1:47731/","port":47731,...}`。

按以下顺序操作：

1. **先启动服务并读到 URL**，再做任何后续动作。端口被占用时脚本会自动换一个空闲端口。
2. 用 Browser 工具在当前会话打开该 URL（用户明确要求"在浏览器里看"时，直接用 Browser 打开）。
3. 把 URL 告诉用户，并说明：实时采集从"下一次提问"开始；已有记录在左侧列表里。

参数：

- `--workspace <dir>` 指定工作区（默认取 `MINIMAX_PROJECT_DIR`，再退到当前目录）
- `--port <n>` 指定端口（默认读 `.plugintree/config.json` 的 `port`，默认 47731）

服务运行期间，每次新的提问都会自动生成树，并通过 SSE 实时推到页面。
树在每个 Hook 事件之后都会重写，所以节点是边干活边长出来的。

### 换一个工作区看

采集器把树写在**当前工作区**自己的 `.plugintree/` 里，所以换个工作区提问，
树就换了个地方。页面顶栏有工作区下拉框：

- **切换**：下拉框里选另一个工作区，回合列表、树、导出立刻跟着换。
- **自动跟随**（默认开）：Agent 在别的工作区干活时页面自动跟过去；手动切换会把它关掉。
- **只看新回合**：切过去后默认打开，已经结束的回合不再打扰，只留新的和正在进行的。
- 也可以在启动时指定：`node ".../serve.mjs" --workspace <dir>`。

接口（脚本化时用）：

```bash
GET  /api/workspaces          # 所有登记过的工作区 + 当前工作区
POST /api/workspace  {"path":"D:/path/to/project","follow":false}
POST /api/follow     {"enabled":true}
```

## 二、页面怎么读

页面不是一棵树状图，而是**一条居中的主轴 + 挂在两侧的分支**：

- **主路径永远在正中间**：提问在最上面，往下的每一层策略沿着画布正中的一条竖线排下去。
  顺着中间那条线往下读，就是这一轮的主线。
- **同一层里偏「做」的分支在左、偏「想」的分支在右**：执行节点开在主轴左侧，
  策略 / 思考类节点开在右侧，再往下继续往外扩。

节点含义：

- **根节点**是用户在消息框里发的那条消息。
- **策略节点**（💡）是该层的思路，标题是固定中文，例如 `策略：读取文件、搜索内容`。
- **执行节点**是一次具体操作，标题形如 `读取文件 .\config.yaml`；
  节点框内底部单独一行灰色小字是**耗时**。
- **每个节点都有分类**：执行节点左上角的角标写的是动作类别，而不是笼统的「执行」——
  `读`（读取文件）、`写`（写入文件）、`搜`（grep）、`找`（glob）、`执`（执行命令）、
  `技`（加载技能）、`令`（调用 MCP）、`代`（委派子代理）、`计`（任务清单）、
  `问`（向用户提问）、`忆`（提醒）……不同类别颜色不同。
- **MCP 调用会点名服务与动作**：`调用 WebNote：创建笔记`；
  **技能调用会点名技能**：`加载技能：plugintree`。
- **每个节点都有耗时**：执行节点是工具真正跑的时间，策略节点是模型思考的时间，
  根节点是提问之后 Agent 开始动作之前的等待。
- 打开一棵树时**默认停在根节点、缩放 100%**；想看全貌点工具栏「适应窗口」
  （主轴依然留在正中间）。
- **方向键**：上下沿主轴走，左右在左右车道之间切换。
- 新的提问一开始，页面会自动切到那一轮并跟随，节点随 Agent 的动作逐个出现。
- 右上角胶囊「Agent 正在思考 · 已等待 x」表示这一轮还没结束。
- 点击**执行节点** → 右侧详情面板显示一行完整命令（例如 `read: .\hello.txt`）与动作类别。
- 点击**策略节点** → 右侧详情面板显示策略原文与它产生的具体动作。

## 三、导出

优先用页面上的「导出 HTML / 导出 Markdown」按钮。命令行等价物：

```bash
node "C:/Users/iroum/.minimax/plugins/plugintree/scripts/serve.mjs" --port 47731
# 然后下载：
# http://127.0.0.1:47731/api/export?turn=<turnId>&format=md
# http://127.0.0.1:47731/api/export?turn=<turnId>&format=html
```

`turnId` 可以从 `GET /api/turns` 拿到（该接口返回 `{turns:[{turnId,question,...}]}`）。

导出文件是自包含的单文件 HTML 或 Markdown，可直接发给用户。

## 四、回填历史会话

```bash
node "C:/Users/iroum/.minimax/plugins/plugintree/scripts/backfill.mjs" --sessions 20
```

- `--sessions N`：回填最近 N 个会话（默认 20）
- `--all`：回填全部历史会话
- `--workspace <dir>`：指定归档到哪个工作区（历史会话没有工作区信息，默认归档到当前工作区）

回填是可重复执行的：同一次回填会覆盖同一批会话的记录，不会重复累积。

## 五、配置

配置文件：`<工作区>/.plugintree/config.json`

```json
{
  "port": 47731,
  "maxReasoningChars": 12000
}
```

- `port`：树图页面端口。
- `maxReasoningChars`：单条思考文本保留的最大字符数。

## 注意事项

- Hook 采集失败不会影响用户对话（Hook 一律 fail-open），但可能漏记该回合。
- Hook 用的代码在会话开始时就定下了：装完插件后，当前会话仍然跑着启动时那份快照，
  新会话才用上新版本。想立刻按新规则重建已有的树：
  `node "C:/Users/iroum/.minimax/plugins/plugintree/tools/rebuild.mjs" --workspace <dir>`
  （`tools/` 只在开发副本里有，插件安装目录不含它。）
- 没有任何模型调用，因此没有 API 费用，也不会读取 `config.yaml` 里的密钥。
- 不要把 `<工作区>/.plugintree/` 提交进版本库（数据量大且含对话内容）。
