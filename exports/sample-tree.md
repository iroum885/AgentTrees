# 本仓库用到了哪些 hook

- 回合 ID: `6246d615-bf62-496a-83ba-0c13eadafdae`
- 会话 ID: `mvs_13711a403a1d40058929939025627be3`
- 来源: 实时采集
- 时间: 2026-10-30 14:41:06
- 节点数: 20

- ❓ **提问**: 本仓库用到了哪些 hook
  > 耗时：726ms
  - 💡 **策略**: 策略：执行命令、搜索内容
    > 耗时：2.7s
    > 决策意图：我来看一下这个仓库的目录结构和 hook 相关文件。
    > The user asks: "本仓库用到了哪些 hook" — which hooks are used in this repository. Let me explore the repo. Let me look at the working directory D:\workspace\projects\plugintree. Note there's a plugintree skill available. The repo is called "plugintree". The user asks about hooks used in this repo. Let me s…
    > 产生的动作：
      - 执行命令：执行命令：Get-ChildItem -Path 'D:\worksp…
        > 为什么：Let me look at the working directory D:\workspace\projects\plugintree.
        > 决定性信息（用户提问）：本仓库用到了哪些 hook
      - 搜索内容：搜索内容：hook
        > 为什么：Let me search for hook definitions.
        > 决定性信息（前序执行结果）：d----- hooks
    - ⚙️ **执行命令**: 执行命令：Get-ChildItem -Path 'D:\worksp…  _(ok)_
      > 命令：`bash: Get-ChildItem -Path 'D:\workspace\projects\plugintree' -Force | Select-Object Mode, Name | Format-Table -AutoSize`
      > 耗时：4.9s
      > 为什么：Let me look at the working directory D:\workspace\projects\plugintree.
      > 决定性信息（用户提问）：本仓库用到了哪些 hook
    - 🔍 **搜索内容**: 搜索内容：hook  _(ok)_
      > 命令：`grep: hook @ .`
      > 耗时：916ms
      > 为什么：Let me search for hook definitions.
      > 决定性信息（前序执行结果）：d----- hooks
    - 💡 **策略**: 策略：执行命令、读取文件
      > 耗时：3.2s
      > 决策意图：仓库里有一个 `hooks/` 目录和 `.minimax-plugin/plugin.json`，我展开看看具体配置。
      > Let's look at the hooks directory and .minimax-plugin/plugin.json, and the README. 仓库里有一个 `hooks/` 目录和 `.minimax-plugin/plugin.json`，我展开看看具体配置。
      > 产生的动作：
        - 执行命令：执行命令：Get-ChildItem -Path 'D:\worksp…
          > 为什么：Let's look at the hooks directory and .minimax-plugin/plugin.json, and the README.
          > 决定性信息（前序执行结果）：d----- .minimax-plugin
        - 读取文件：读取文件 .\hooks\hooks.json
          > 为什么：仓库里有一个 `hooks/` 目录和 `.minimax-plugin/plugin.json`，我展开看看具体配置。
          > 决定性信息（前序执行结果）：D:\workspace\projects\plugintree\hooks\hooks.json 3347
      - ⚙️ **执行命令**: 执行命令：Get-ChildItem -Path 'D:\worksp…  _(ok)_
        > 命令：`bash: Get-ChildItem -Path 'D:\workspace\projects\plugintree\hooks' -Recurse -Force | Select-Object FullName, Length | Format-Table -AutoSize; Write-Output '--- .minimax-plugin ---'; Get-ChildItem -Path 'D:\workspace\projects\plugintree\.minimax-plugin' -Recurse -Force | Select-Object FullName, Length | Format-Table -AutoSize`
        > 耗时：3.4s
        > 为什么：Let's look at the hooks directory and .minimax-plugin/plugin.json, and the README.
        > 决定性信息（前序执行结果）：d----- .minimax-plugin
      - 📖 **读取文件**: 读取文件 .\hooks\hooks.json  _(ok)_
        > 命令：`read: .\hooks\hooks.json`
        > 耗时：665ms
        > 为什么：仓库里有一个 `hooks/` 目录和 `.minimax-plugin/plugin.json`，我展开看看具体配置。
        > 决定性信息（前序执行结果）：D:\workspace\projects\plugintree\hooks\hooks.json 3347
      - 💡 **策略**: 策略：读取文件
        > 耗时：3.2s
        > Now let's look at plugin.json and README, and the collect.mjs to understandwhat the hook does.
        > 产生的动作：
          - 读取文件：读取文件 .\.minimax-plugin\plugin.json
            > 为什么：Now let's look at plugin.json and README, and the collect.mjs to understandwhat the hook does.
            > 决定性信息（前序执行结果）：D:\workspace\projects\plugintree\.minimax-plugin\plugin.json 706
          - 读取文件：读取文件 .\scripts\collect.mjs
            > 为什么：Now let's look at plugin.json and README, and the collect.mjs to understandwhat the hook does.
            > 决定性信息（前序执行结果）：8→ "command": "node \"${PLUGIN_ROOT}/scripts/collect.mjs\"",
        - 📖 **读取文件**: 读取文件 .\.minimax-plugin\plugin.json  _(ok)_
          > 命令：`read: .\.minimax-plugin\plugin.json`
          > 耗时：1.3s
          > 为什么：Now let's look at plugin.json and README, and the collect.mjs to understandwhat the hook does.
          > 决定性信息（前序执行结果）：D:\workspace\projects\plugintree\.minimax-plugin\plugin.json 706
        - 📖 **读取文件**: 读取文件 .\scripts\collect.mjs  _(ok)_
          > 命令：`read: .\scripts\collect.mjs`
          > 耗时：683ms
          > 为什么：Now let's look at plugin.json and README, and the collect.mjs to understandwhat the hook does.
          > 决定性信息（前序执行结果）：8→ "command": "node \"${PLUGIN_ROOT}/scripts/collect.mjs\"",
        - 💡 **策略**: 策略：搜索内容
          > 耗时：3.7s
          > Now let me check the README for hook documentation, and also check whether the repo has any other hook-related definitions (e.g., in scripts/lib/registry.mjs, serve.mjs). The grep found "hook" in scripts/serve.mjs, README.md, skills/plugintree/SKILL.md, ui/app.js, scripts/lib/registry.mjs, tools/se…
          > 产生的动作：
            - 搜索内容：搜索内容：hook
              > 为什么：Let me grep for hook mentions in those filesto see context.
              > 决定性信息（前序执行结果）：3→ * plugintree hook collector.
          - 🔍 **搜索内容**: 搜索内容：hook  _(ok)_
            > 命令：`grep: hook @ .`
            > 耗时：658ms
            > 为什么：Let me grep for hook mentions in those filesto see context.
            > 决定性信息（前序执行结果）：3→ * plugintree hook collector.
          - 💡 **策略**: 策略：搜索内容
            > 耗时：11.6s
            > The exports/sample-tree.html is just a sample export containing past session data, not relevant. Let me also check scripts/install.mjs — it may install hooks into a settings file. And check tools/validate-package.mjs which validates hook contract. Also check the SKILL.md for hook mentions. Let me l…
            > 产生的动作：
              - 搜索内容：搜索内容：hook
                > 为什么：Let me also check scripts/install.mjs — it may install hooks into a settings file.
                > 决定性信息（前序执行结果）：.\.minimax-plugin\plugin.json:19: "hooks": ["hooks/hooks.json"]
              - 搜索内容：搜索内容：hook
                > 为什么：Let me look at install.mjs to see if there's a hook registrationelsewhere.
                > 决定性信息（前序执行结果）：.\README.md:200-node tools/validate-package.mjs # 插件包静态校验（清单/钩子契约/路径安全）
            - 🔍 **搜索内容**: 搜索内容：hook  _(ok)_
              > 命令：`grep: hook @ .\scripts\install.mjs`
              > 耗时：1.3s
              > 为什么：Let me also check scripts/install.mjs — it may install hooks into a settings file.
              > 决定性信息（前序执行结果）：.\.minimax-plugin\plugin.json:19: "hooks": ["hooks/hooks.json"]
            - 🔍 **搜索内容**: 搜索内容：hook  _(ok)_
              > 命令：`grep: hook @ .\tools\validate-package.mjs`
              > 耗时：739ms
              > 为什么：Let me look at install.mjs to see if there's a hook registrationelsewhere.
              > 决定性信息（前序执行结果）：.\README.md:200-node tools/validate-package.mjs # 插件包静态校验（清单/钩子契约/路径安全）
            - 💡 **策略**: 策略：搜索内容
              > 耗时：4.3s
              > So the plugin uses MiniMax Code Plugin Hooks with 11 events, all pointing at the same command handler: `node "${PLUGIN_ROOT}/scripts/collect.mjs"`. Let me also check the SKILL.md mention of hook and confirm no other hook systems (like git hooks). Also check .git/hooks — that's just default git samp…
              > 产生的动作：
                - 搜索内容：搜索内容：SessionStart|UserPromptSubmit|PreCompact
                  > 为什么：Let's grep for "SessionStart" across the repo.
                  > 决定性信息（前序执行结果）：validate-package.mjs:261- 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
              - 🔍 **搜索内容**: 搜索内容：SessionStart|UserPromptSubmit|PreCompact  _(ok)_
                > 命令：`grep: SessionStart|UserPromptSubmit|PreCompact @ .`
                > 耗时：685ms
                > 为什么：Let's grep for "SessionStart" across the repo.
                > 决定性信息（前序执行结果）：validate-package.mjs:261- 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
              - 💡 **策略**: 策略：执行命令
                > 耗时：8.4s
                > Everything is confirmed. The repository is a MiniMax Code Plugin ("plugintree"), and its only hook mechanism is the Plugin Hook defined in `hooks/hooks.json`, registered in `.minimax-plugin/plugin.json` via `"hooks": ["hooks/hooks.json"]`. 11 hook events, all routed to the same command handler `scr…
                > 产生的动作：
                  - 执行命令：执行命令：Get-ChildItem -Path 'D:\worksp…
                    > 为什么：Actually let me quickly check that .git/hooks only contains .samplefiles.
                    > 决定性信息（前序执行结果）：.\hooks\hooks.json:2- "hooks": {
                - ⚙️ **执行命令**: 执行命令：Get-ChildItem -Path 'D:\worksp…  _(ok)_
                  > 命令：`bash: Get-ChildItem -Path 'D:\workspace\projects\plugintree\.git\hooks' -Force -File | Select-Object Name, Length | Format-Table -AutoSize`
                  > 耗时：1.7s
                  > 为什么：Actually let me quickly check that .git/hooks only contains .samplefiles.
                  > 决定性信息（前序执行结果）：.\hooks\hooks.json:2- "hooks": {
                - 💡 **策略**: 策略：Confirmed: only .sampl…
                  > 耗时：8.2s
                  > 决策意图：##结论
                  > Confirmed: only .sample files (git defaults), no active git hooks. Now write the finalanswer. ##结论 本仓库只有**一套 hook 机制**：MiniMax Code 的 **Plugin Hook**，定义在 `hooks/hooks.json`，由 `.minimax-plugin/plugin.json:19` 的 `"hooks": ["hooks/hooks.json"]` 注册。除此之外没有任何 git hook、npm script 之类的其他 hook（`.git/hooks/` …
