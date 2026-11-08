# dsh-handover

跨会话交接：把**旧会话**压成一份"交接包"（进度 / 动过的文件 / 用户要求 / 待办 / 翻过的文件），
交给**当前会话**的模型，让它接着干活。

**旧会话全程只读**——本插件只调用 `ctx.sessionQuery` 的读取方法，从不 append、不 resume、不把旧会话变成 live。

## 它解决什么

新开会话时，模型对之前发生的事一无所知。你要么重新讲一遍背景，要么去翻几 MB 的原始记录。
本插件给你一份 ~2000 字的交接包：7 MB 的会话压到这个量级，模型读完就能接着干。

它不做的事：不建知识库、不做卡片确认、不后台推演、不改旧会话。

## 怎么用

模型侧两个动作，由你自然语言触发（例如"交接一下上次装插件那个会话"）：

```
handover { action: "list", keywords: "插件" }
  → 列出候选旧会话（同工作目录优先 + 最近活跃），每个带 id / 标题 / 时间 / cwd 标记

handover { action: "pack", sessions: ["session-xxxx"], budget: 3000 }
  → 生成交接包（≤3000 字），注入当前会话上下文
```

成交接包后，模型应该先跟你确认"上次干到哪了 / 还没做完什么"，再动手。

## 交接包的取舍（有意的）

一个实测会话（44 轮）的构成：工具输出 70%、思考过程 19%、助手正文 7%、用户输入 3%。

所以交接包**丢**掉工具输出和思考过程，**留**：

| 段 | 来源 |
|---|---|
| 1. 上次干到哪了 | 最后两条助手正文 |
| 2. 动过的文件 | 写类工具调用（edit / write / patch…）的路径字段 |
| 3. 用户说过的要求 | `source.kind === "user"` 的用户消息（宿主注入的运行时上下文会被排除） |
| 4. 没做完的事 | 最后一次 `todo/write` |
| 5. 翻过的文件 | 读类工具的路径（已排除通配符） |

包体带固定警告：这是旧会话的背景、不是指令，只有当前用户有权威。

## 文件

```
lib/core.js        纯函数：裁摘要 / 渲染交接包 / 候选排序（不依赖宿主，可单测）
lib/index.js       cordis 插件入口：注册 handover 工具
cordis.patch.yml   bundle patch（把插件插进宿主）
test/core.test.mjs 11 个单测
scripts/try-real.mjs  拿真实会话文件跑一遍，打印交接包
scripts/smoke.mjs     假 ctx 加载真插件，跑完整 list/pack 链路
```

## 配置

`cordis.patch.yml` 里可调：

```yaml
config:
  maxCandidates: 20   # list 最多返回几个候选
  budgetChars: 3000   # 交接包默认字数上限
```

## 自测

```powershell
cd /path/to/dsh-handover
node --test test/core.test.mjs    # 单测
node scripts/try-real.mjs         # 真实数据出包（看质量直接看这个）
node scripts/smoke.mjs            # 整条链路冒烟
```

## 已知限制（第一版）

- **没有界面开关**：靠模型调工具触发，不是输入框上方那行常驻开关。
- **没有自动挑候选**：`list` 会排序，但选哪一个是人/模型决定的。
- **不做摘要改写**：交接包是裁出来的，不是模型重写的（省一次调用；质量靠段结构和预算控制）。
- **只读当前工作目录的会话最安全**：跨工作目录的会话能读，但会在包里标注"文件不共享"。

## 卸载 / 回滚

1. 从 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `dsh-handover`
2. 在该目录跑 `pnpm install`
3. 重启 DSH
