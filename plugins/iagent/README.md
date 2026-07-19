# iAgent Codex Plugin

该插件通过本机 MCP/SSE 桥接，让 Codex 使用已登录的 iAgent 创意工坊生成图片和视频。API Key 只由浏览器调用 iAgent 网关，不会发送给 Codex 或插件进程。

```bash
codex plugin marketplace add nbb2025/iagent-codex-plugin --ref main
codex plugin add iagent@iagent
```

公开 Marketplace 不需要 GitHub 仓库账号或访问密钥。插件安装到用户本机并通过 `127.0.0.1` 连接浏览器，API Key 不会进入插件仓库或 Codex 上下文。

安装后新建 Codex 对话，然后输入：

```text
用 iAgent 生成一张 16:9、2K 的产品海报
```

首次调用会返回一个 `127.0.0.1` 连接地址。打开该地址并登录 iAgent 后，Codex 即可读取创意工坊配置和提交任务。多个 Codex 对话会复用同一个本机桥接进程。

生成工具会为每个新任务使用唯一的 `clientRequestId`，并把它作为可查询的任务 ID。同一 ID 的重放只会恢复原任务；调用结果未知时，插件不会擅自改写提示词或创建新 ID 重试。

更新已安装插件：

```bash
codex plugin marketplace upgrade iagent
codex plugin add iagent@iagent
```

安装或更新后请新建 Codex 对话，使最新工具定义和 Skill 生效。
