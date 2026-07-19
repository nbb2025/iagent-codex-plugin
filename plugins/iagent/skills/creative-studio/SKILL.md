---
name: iagent-creative-studio
description: 使用 iAgent 创意工坊生成图片或视频、选择可用模型与尺寸，并查询或停止生成任务。用户要求通过 iAgent 生图、生视频或查看 iAgent 创意模型时使用。
---

# iAgent Creative Studio

通过插件提供的 `iagent` MCP 工具操作用户已经登录的 iAgent 创意工坊。不要索取、读取或输出用户的 API Key。

## 连接浏览器

开始时调用 `iagent_studio_get_config`。如果工具提示没有已连接的 iAgent 浏览器：

1. 从工具错误中取得 `连接地址`。该地址只指向本机 `127.0.0.1`，且不包含 token。
2. 在 Codex 浏览器中打开连接地址。没有浏览器工具时，把它作为可点击链接交给用户打开。
3. 等网页完成登录并进入创意工坊后，再调用 `iagent_studio_get_config`。

连接地址中的 token 只用于本机 `127.0.0.1` 桥接，不要把它发送到其他服务或写入项目文件。

## 生成流程

1. 使用 `iagent_studio_get_config` 读取当前 Key 对应的可用模型和参数选项。
2. 每个新的生成任务先创建一个唯一的 UUID 风格 `clientRequestId`。图片调用 `iagent_generate_image`；视频调用 `iagent_generate_video`。用户没有指定模型时省略 `model`，让工作台沿用当前选择或第一个可用模型。
3. 图片尺寸有两种互斥模式：`sizeMode: "preset"` 时用 `size` 传 `auto` 或宽高比（如 `16:9`），再用 `resolution` 选择 `auto`、`1K`、`2K`、`4K`；`sizeMode: "custom"` 时用 `size` 传精确像素（如 `2048x1152`），必须省略 `resolution` 或设为 `auto`。不要同时用清晰度和自定义像素。
4. 视频 `resolution` 使用 `480p` 或 `720p`，时长范围为 1-15 秒。
5. 生成接口返回 `taskId` 后，使用 `iagent_generation_get_status` 查询，直到 `succeeded`、`done` 或 `error`。长任务不要高频轮询。
6. 用户要求终止时调用 `iagent_generation_stop`。

## 幂等与结果未知

图片和视频生成可能产生费用，必须把一次生成调用视为不可随意重复的操作：

- 同一次生成从首次提交、恢复到用户确认后的重放，必须始终复用原来的 `clientRequestId` 和完整原始参数。新的创作或明确要求再生成时才创建新 ID。
- `clientRequestId` 同时是该任务预期的 `taskId`。工具没有正常返回时，保留该 ID；可以在合理等待后用它调用一次 `iagent_generation_get_status`，但只有拿到明确任务记录才能宣称已提交。
- 工具调用超时、没有输出或最近任务列表中没有出现目标，都不证明请求未提交。终端中的自动折行也不代表提示词被截断。不得据此声称“没有提交”“不会扣费”或编造终端长度限制等原因。
- 结果仍不确定时，明确告诉用户“提交结果未知”，不要自动再次调用生成工具。需要重放时先征得用户确认，并且只能使用相同 `clientRequestId` 与完全相同的提示词和参数。
- 不要为了规避传输问题擅自压缩、翻译、改写提示词后重试；那会成为参数不同的新生成请求。不要用最近任务查询结果缺失作为自动重试依据。

生成结果保存在 iAgent 浏览器的创意工坊历史中。工具不会把体积很大的 base64 图片内容塞进 Codex 上下文；远程结果地址可从任务状态中返回。
