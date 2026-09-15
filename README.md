# Pi Notes

让 Pi 直接使用你的 Markdown 笔记。根笔记按属性提供全文或摘要，子文件夹作为入口，AI 再用现有工具按需浏览、读取或搜索。

可以连接整个 Obsidian 库，也可以只连接其中的一个文件夹；无需 Obsidian 插件。

## 开始使用

在本仓库目录执行：

```bash
npm install --ignore-scripts
pi install .
```

安装后重新启动 Pi，输入 `/notes` 设置笔记目录。

配置是**全局的**。自动注入的笔记会随请求发送给当前模型，请选择适合共享的目录。插件不会迁移或修改现有的 USER.md。

## 写一篇笔记

```yaml
---
description: 用户的协作偏好与表达习惯。
purpose: >-
  这是对用户的持续建模，用于理解用户并辅助沟通与判断。
  结合当前情境使用，区分明确偏好与推断，当前明确要求优先。
defaultopen: true
---
```

在 frontmatter 之后正常写 Markdown 正文。三个字段都是可选的：

| 字段 | 作用 | 未填写时 |
| --- | --- | --- |
| `description` | 说明笔记内容，以及何时值得读取 | 保留文件名和路径 |
| `purpose` | 说明笔记对 AI 的价值和使用方式 | 省略定位说明 |
| `defaultopen` | `true` 注入完整正文；`false` 只提供摘要 | `false` |

`purpose` 在两种模式下都提供。`defaultopen` 使用 YAML 布尔值，不要写成带引号的 `"false"` 或 `"true"`。普通 Obsidian 属性如 `tags`、`aliases` 可以继续保留。

示例笔记见 [`examples/vault/`](examples/vault/)，完整注入版式见 [设计说明](DESIGN.md#默认上下文示意)。

## 日常操作

| 命令 | 用途 |
| --- | --- |
| `/notes` | 查看当前目录、注入概况，进入预览或更换目录 |
| `/notes set <目录>` | 直接设置目录；支持相对路径、`~`、空格和外层引号 |
| `/notes preview` | 查看本插件将提供的完整笔记上下文 |
| `/notes clear` | 停用后续默认注入，保留笔记文件和已有会话历史 |
| `/notes help` | 查看命令与配置文件位置 |

预览是只读界面，不会把预览内容追加进对话。方向键滚动，PageUp / PageDown 翻页，Escape 返回；遵循 Pi 中对应按键的自定义绑定。当前回复结束后可使用这些命令。

### 自动发现与更新

- 只发现所选目录的直接子项：普通 `.md` 文件和子文件夹。
- 忽略隐藏文件、隐藏目录、符号链接条目及非 Markdown 文件。显式配置的根目录本身可以是符号链接。
- 子目录中的 `defaultopen: true` 不会触发跨层级自动注入。AI 可以从文件夹入口继续深入。
- 每次开始处理新提示前检查根目录，复用未变化笔记的解析结果。同一轮工具调用期间保持该轮默认注入快照。
- 文件搜索、zg、双链读取和笔记修改沿用当前 Pi 环境的工具与任务授权。此插件不添加搜索索引或权限沙箱。

### 配置与异常

默认配置文件是 `~/.pi/agent/notes.json`，遵循 `PI_CODING_AGENT_DIR`。`/notes set` 会保存规范化的绝对目录路径。通常只需用命令配置；手工调整注入预算时，配置格式如下（目录为示例）：

```json
{
  "directory": "/example/vault/AI",
  "maxContextBytes": 262144
}
```

`directory: null` 表示停用。预算按 UTF-8 字节计，默认 **256 KiB**，可设为 1 KiB 到 16 MiB；这是笔记块的上限，不是模型 token 数，也不保证当前模型剩余空间足够。

- 单篇 frontmatter 超过 64 KiB、属性无效、文件不可读或全文文件超过预算时，保留路径并标明未展开原因，不注入该篇正文。
- 笔记块总量超预算、目录不可读或配置损坏时，该轮不注入笔记块，明确告知上下文不可用。不会悄悄截断全文，也不会回用旧笔记块。
- 配置损坏时请按提示修复 `notes.json`；命令不会覆盖无法解析的配置。YAML 别名引用、自定义标签和重复字段会被拒绝。

RPC 下预览通过 UI 通知返回；print / JSON 模式的命令输出写入 stderr，不污染 stdout 协议。

## 开发与验证

```bash
npm run check
npm test
npm run test:integration
npm run test:tui
npm run bench
```

集成测试使用真实 Pi 进程和本地测试模型端，无外部模型调用；TUI 测试需要 tmux。两者在隔离配置下运行，原始记录保存在 `.artifacts/`。

可选真实模型验证：

```bash
npm run test:live
```

此命令使用现有 Pi 默认模型与该提供方认证的临时副本，最多 8 次模型请求，单次任务等待上限 150 秒。测试结束删除临时认证文件；原始请求和结果保存在 `.artifacts/`。该入口面向已有认证的内置提供方，自定义提供方配置不会被自动复制。

已验证的环境与覆盖范围见 [验证记录](docs/verification.md)。首版在 Pi 0.85.1、Node.js 26.1.0、macOS 上验证；其他环境需要补测。
