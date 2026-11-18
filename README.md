# dsh-aftermath

记录 AI 每轮对话对观测目录的文件改动。出事之后可以倒查：改了哪些文件、大概是哪条命令改的、怎么恢复。

DSH 插件，零依赖，不联网，不读文件内容。

## 用法

装上就不用管，它自己记。出事之后：

1. 直接跟 agent 说「桌面图标怎么全白了」，它会调 `aftermath_history` 查上一轮删了什么；
2. 或者自己输 `/aftermath report --last 1` 看明细；
3. 记录存在 `$DSH_HOME/state/aftermath/`。

## 工作方式

很多事故不是 `write`/`edit` 工具造成的，而是 agent 跑了一条 `pwsh`/`bash` 命令直接改磁盘——只在工具调用层做 hook 看不到这类改动。所以 aftermath 在文件系统层观测：

- 每轮开始和结束各对观测目录做一次快照（桌面 48 条实测约 0.3 ms），做差得到变更列表；
- 拿同一轮捕获的 `tool/call`（工具名和参数原文）给每条变更标归因；
- 归因分四档，报告里逐条标注：

| 档位 | 判据 |
| --- | --- |
| ✔ 确定 | 命令里出现该文件的绝对路径 |
| ◐ 很可能 | 命令在处理这个目录，或本轮只有它提到这个文件名 |
| ○ 时间窗内 | 改动 mtime 落在某次调用后 8 秒内 |
| ？ 无法归因 | 没有证据。报告会写明，并附上该轮命令原文供自己判断 |

两条规则：只读命令不算证据（`Get-Content a.txt` 提到路径但不会把 a.txt 标成「确定」）；某个目录这轮扫描失败时整根跳过，不会误报一排「删除」。

报告长这样：

```
第 12 轮 · 2026-11-17 20:41 · 会话 #7
共 4 处变更：删除 3 · 修改 1
归因：✔确定 2 · ◐很可能 1 · ○时间窗内 1 · ？无法归因 0

| 变更 | 条目 | 大小 | 时间 | 归因 | 依据 |
| --- | --- | --- | --- | --- | --- |
| 删除 | Desktop\微信.lnk | 1.2 KB | 20:41:03 | ✔ 确定 | 命令里出现该绝对路径（bash） |
| 删除 | Desktop\QQ.lnk | 1.1 KB | 20:41:03 | ◐ 很可能 | 该调用在处理 Desktop\ 下的文件 |
| 修改 | Desktop\desktop.ini | 218 B | 20:41:04 | ○ 时间窗内 | 改动时间落在 bash 调用后 8s 内 |

可能的症状：桌面图标变白/空白
  1) 检查快捷方式是否失效：powershell -c "..."
  2) 刷新图标缓存：ie4uinit.exe -show
```

## 安装

**Plugins → Add plugin → 选这个目录**。要求 DSH `>=0.2.2-0 <0.3.0`、Node `>=22.12.0`。

## 设置

Plugins 页打开 dsh-aftermath 的详情，卡片里能改：

- 总开关（关掉立即停止快照，历史记录保留可查）
- 观测目录（一行一个，内置标识或绝对路径）
- 递归深度、保留天数、路径打码

保存是逐字段写入的：某个字段被宿主拒绝就停在那一条并显示失败，不会显示「已保存」。所有字段保存后立即生效，不用重启。

宿主不提供 configForms 服务时，卡片只显示一段说明，插件照常工作，可以改用下面的 yml 配置。

## 配置（yml）

在 profile 的 `cordis.patch.yml` 里写 config，全部有默认值：

```yaml
- id: dsh-aftermath
  config:
    roots: [desktop, downloads]   # 内置标识或绝对路径，支持 "id=路径"
    depth: 2                      # 0 = 只看根目录这一层
    exclude: ['node_modules', '~$*']
    extraRoots: ['D:\项目']
    retentionDays: 7
    maskHome: true                # 报告里把家目录打码成 ~
```

内置标识：`desktop`、`downloads`、`documents`、`pictures`、`music`、`videos`，依次探测 `%USERPROFILE%\<名>`、`OneDrive\<名>`、中文名（`桌面`/`下载`）。

Windows 上桌面被 OneDrive 重定向很常见。插件不读注册表，路径靠别名探测加显式配置，跑 `/aftermath roots` 确认实际观测的目录对不对。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/aftermath report [--last N] [--since 2h] [--root desktop] [--save]` | 变更明细与归因 |
| `/aftermath scan [--keep]` | 立刻扫描，与上次基线对比 |
| `/aftermath roots` | 打印解析出的观测根 |
| `/aftermath status` | 配置、存档位置、记录条数 |
| `/aftermath help` | 帮助 |

`--save` 把完整报告写到 `$DSH_HOME/state/aftermath/reports/`。

## 给 agent 的工具

`aftermath_history`（只读，参数 `since` / `root` / `limit`）。装上之后 agent 可以自己查「上一轮删了什么」，不用你翻日志。

## 存档与隐私

```
$DSH_HOME/state/aftermath/
├── baseline.json              最近一次快照（空闲期对比用）
├── turns/2026-11-17.ndjson    逐轮变更记录
└── reports/                   --save 的报告
```

只记路径、大小、mtime，不读文件内容、不存正文；命令输出只保留 ≤180 字符的片段用于归因说明。不启子进程，不联网，恢复命令只打印不执行。记录按 `retentionDays` 自动清理。

## 已知限制

- 只覆盖配置的根和深度，根之外的改动看不到。
- `moved` 是启发式判断（同名 + 同大小 + mtime 相近），报告里会标注。
- 归因是证据强度分级，标 `？` 就是没有证据。
- 跨进程、跨会话的手动改动只能落进「时间窗内」或「无法归因」。
- 不自动还原：只存路径不存内容，还原是 rollback 类插件的事。

## 开发

```bash
npm test   # 70 个测试
```

零运行时依赖，只用 `node:` 内置模块。观测走 `ctx.on('session/event')`，`inject: ['tools']` 仅用于注册 `aftermath_history`。

## License

MIT
