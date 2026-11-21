# dsh-aftermath

![dsh-aftermath](assets/icon-96.png)

记录每轮对话里观测目录的文件变更：哪些被新建、删除、修改，大概是哪次工具调用改的。出问题时用它倒查。

DSH 插件。零依赖，不联网，不读文件内容。

> 不想看技术细节：直接看 [GUIDE.md](GUIDE.md)，照着做就行。

## 用法

装好后自动记录，不用管。查看有三种方式：

1. Plugins 页顶部标签栏点「变更记录」：最近 8 轮，点开看逐条变更与归因。不依赖对话，新开的窗口也能看。
2. 跟 agent 说一句「桌面图标怎么全白了」，它会调 `aftermath_history` 查。
3. 自己输 `/aftermath report --last 1` 看明细。

记录存在 `$DSH_HOME/state/aftermath/`。

## 「变更记录」标签页

- 每轮一行：`16:24 #50 新建 1 · 修改 4`，点开看逐条 `✔ 新建 ~\Desktop\a.txt 确定`；
- 观测目录内没变化但执行过写操作的那轮，显示黄色提示「可能改在别处」；
- 底部单列「命令提到、但不在观测目录内的路径」；
- 右上角「刷新」重读，数据与 `/aftermath report` 是同一份。

数据走插件注册的只读路由 `GET /aftermath/recent`（同源、只接 GET/HEAD、`cache-control: no-store`），所以不需要会话。没用详情页卡片的原因：`plugins.bundle.config` 槽位固定渲染在插件描述与 README 之后，放不下整页列表，所以用 `plugins.tab` 做独立标签页。

## 工作方式

很多事故不是 `write`/`edit` 工具造成的，而是 agent 跑了条 `pwsh`/`bash` 命令直接改磁盘，工具调用层的 hook 看不到。所以观测放在文件系统层：

- 每轮开始和结束各对观测目录做一次快照（桌面 48 条实测约 0.3 ms），做差得到变更列表；
- 记下每次工具调用的起止时刻（`tool/call` 与 `tool/result` 各带一个时间）；
- 用同一轮的调用证据给每条变更标归因，分四档：

| 档位 | 判据 |
| --- | --- |
| ✔ 确定 | 命令里出现该文件的绝对路径 |
| ◐ 很可能 | 命令在处理这个目录，或本轮只有它提到这个文件名 |
| ○ 时间窗内 | 改动 mtime 落在某次调用的起止区间内 |
| ？ 无法归因 | 没有证据；报告附该轮命令原文，自己判断 |

「时间窗内」分两级：先比单次调用自己的区间（窄，几乎不会错配到别的调用）；全不命中才退回整轮宽窗，那时只说明「这一轮里有人动过」。表格里分别写成 `○区间内` 和 `○时间窗内`，依据列写明是哪一级（`call-interval` / `turn-window`）。

观测根之外的线索：

- 根内没变化但执行过写操作时，留一条只含命令摘要的轻记录（`kind: quiet`），历史表里显示 `0（写过 N 条命令，根外？）`；
- 调用里出现过的绝对路径存进记录，报告单列「命令提到、但不在观测根内的路径」。不扫盘，只说命令提到过；
- 不想要轻记录，把 `recordQuietTurns` 设为 `false`。

判「写操作」的规则：

- 重定向落盘算写（`>` / `>>` / `2>` / `Out-File` 都认），目标路径计入证据；引号里的 `>` 是文本，不算；
- `/c/Users/...` 这类 Git Bash 路径翻成 `C:\Users\...` 再比对；
- `powershell -c "Get-Content x"` 是读、`powershell -c "Remove-Item x"` 是写：先看里面的动词，都对不上（如 `node build.js`）才保守算写；
- 只从命令参数和路径参数取证据，`content` / `prompt` 这类载荷文本不参与——否则某个工具的正文里碰巧写了 `Out-File` 和一条桌面路径，那个文件就会被误标成「确定」（真机记录里抓到过这种误判）。

只读命令提到路径不算证据；某个根这轮没扫全时整根跳过，不会把没扫到的报成删除。

报告示例：

```
第 12 轮 · 2026-11-17 20:41 · 会话 #7
共 4 处变更：删除 3 · 修改 1
归因：✔确定 2 · ◐很可能 1 · ○时间窗内 1 · ？无法归因 0

| 变更 | 条目 | 大小 | mtime | 归因 | 依据 |
| --- | --- | --- | --- | --- | --- |
| 删除 | Desktop\微信.lnk | 1.2 KB | 删除前 20:41:03 | ✔ 确定 | 命令里出现该绝对路径（bash） |
| 删除 | Desktop\QQ.lnk | 1.1 KB | 删除前 20:41:03 | ◐ 很可能 | 该调用在处理 Desktop\ 下的文件 |
| 修改 | Desktop\desktop.ini | 218 B | 20:41:04 | ○ 区间内 | 落在 bash 这次调用的起止区间内 |

## 报告健康度
- 快照耗时：本轮结束这次扫描 1 ms，覆盖 2 个根 / 446 个条目
- 归因分布：✔确定 2（50%） · ◐很可能 1（25%） · ○时间窗内 1（25%） · ？无法归因 0（0%）
- 时间证据：1 处 mtime 落在某次调用的起止区间内，0 处只落在整轮宽窗
- 调用区间：5 次调用、3 次写操作，3/3 拿到起止时刻（容差 1500 ms）

可能的症状：桌面图标变白/空白
  1) 检查快捷方式是否失效：powershell -c "..."
  2) 刷新图标缓存：ie4uinit.exe -show
```

末尾「报告健康度」是这份记录自己的可信度：扫描耗时、覆盖条目数、四档各占多少、几次调用拿到了起止时刻、有没有被条数上限截断。

## 相比直接翻日志

会话日志记的是「发出了什么命令」，这个插件记的是「磁盘上留下了什么」，两份不重复：

| | 翻会话日志 | dsh-aftermath |
| --- | --- | --- |
| 内容 | 意图层：工具名、参数、命令原文、返回值 | 结果层：哪个文件被建/删/改、大小与 mtime |
| 要回答「这轮改了哪些文件」 | 得自己把命令逐条读一遍，再脑内模拟 `rm -rf`、`git checkout`、脚本内部调用的效果 | 直接给变更表，四类分好 |
| 命令失败了会怎样 | 日志里照样有那条命令和报错，容易当成「干过这件事」 | 磁盘没有变化，就不会出现在变更表里 |
| 覆盖范围 | `write`/`edit`、`bash`、`pwsh`、子代理、后台进程散在不同 step，得自己拼 | 只看磁盘结果，谁干的都要过这道账 |
| 判断是哪次调用造成的 | 日志时间戳是事件时刻，文件 mtime 是磁盘时刻，人工对时容易错 | 调用区间配对，依据列写明是哪一级 |
| 事后还查得到吗 | 长会话会被压缩/裁剪，早期工具输出可能已不在上下文里 | 独立 NDJSON 存档，`--since 2h` 一条命令，还能 grep / jq |
| 跨会话 | 每次对话各看各的 | 记录按日存、带会话短标，可横向对比 |

归因同样只能从工具调用文本取证据，和日志同源。差别是报告把事实（磁盘变更）和推测（归因档位）分开标注，标 `？` 就是没证据。

## 安装

三种方式，任选一种：

```bash
# 从 npm 装（推荐）
dsh plugin --profile <你的 profile> add dsh-aftermath

# 或从 GitHub 仓库装
dsh plugin --profile <你的 profile> add github:2-qing/dsh-aftermath
```

**Plugins → Add plugin → 选这个目录**也行。

要求 DSH `>=0.2.2-0 <0.3.0`、Node `>=22.12.0`。

## 设置

Plugins 页打开 dsh-aftermath 的详情，卡片里能改：总开关、观测目录（一行一个）、递归深度、保留天数、路径打码。总开关点一下即时写入；其余几项改完点保存。保存是逐字段写入的：某个字段被宿主拒绝就停在那一条并显示失败。保存后立即生效，不用重启。

卡片只剩总开关、没有其它字段时，多半是没加载到设置 schema（`link:` 安装、插件目录和依赖不在同一个盘时常见）。先跑 `/aftermath doctor`，它会打印 Config 是否导出、schema 从哪加载、宿主给本插件建的命名空间在不在；每次启动也会把同一份自检写到 `$DSH_HOME/state/aftermath/settings-probe.json`。这种情况先用下面的 yml 改配置。

## 配置（yml）

在 profile 的 `cordis.patch.yml` 里写 config，全部有默认值：

```yaml
- id: dsh-aftermath
  config:
    roots: [desktop, downloads, documents]   # 内置标识或绝对路径，支持 "id=路径"
    depth: 2                      # 0 = 只看根目录这一层
    exclude: ['node_modules', '~$*']
    extraRoots: ['D:\项目']
    retentionDays: 7
    maskHome: true                # 报告里把家目录打码成 ~
    intervalSlackMs: 1500         # 调用区间归因的容差（毫秒），0 = 严丝合缝
    followCwd: true               # 当前会话的工作目录自动算进观测根（大目录只看顶层）
    recordQuietTurns: true        # 根内没变化、但执行过写操作时，也记一条只有命令摘要的轻记录
```

内置标识：`desktop`、`downloads`、`documents`、`pictures`、`music`、`videos`，依次探测 `%USERPROFILE%\<名>`、`OneDrive\<名>`、中文名（`桌面`/`下载`）。

Windows 上桌面被 OneDrive 重定向很常见。插件不读注册表，路径靠别名探测加显式配置，跑 `/aftermath roots` 确认实际观测的目录对不对。

## 默认排除表

下面这些名字默认不扫（`exclude` 里写的是名字或通配，不是路径；大小写不敏感）：

| 条目 | 为什么排除 |
| --- | --- |
| `node_modules` | 依赖目录，动辄几万个文件；删了重装即可 |
| `.git` `.svn` `.vs` | 版本库与 IDE 的内部目录，改动不反映你自己的文件 |
| `~$*` | Office 打开文档时生成的锁文件，开合一次就变，天天报一堆「新建/删除」 |
| `Thumbs.db` `desktop.ini` `.DS_Store` | 系统/访达的缩略图与文件夹配置，被反复重写 |
| `$RECYCLE.BIN` | 回收站：删掉的文件会落到这里，扫进来会把「删除」再报一遍 |
| `System Volume Information` | 卷影副本等系统信息 |
| `dist` `build` `.next` `.turbo` `coverage` | 构建产物与覆盖率报告，文件多、删了能重新生成 |
| `__pycache__` `.venv` `venv` `.mypy_cache` `.pytest_cache` | Python 缓存与虚拟环境 |
| `target` | Rust / Maven 的构建目录 |

默认值是为了让报告可读：不排除的话，`cwd` 自动跟随一旦落在大仓库上，一轮扫描会从几十毫秒涨到几百毫秒，报告里还会塞满构建产物。

两种改法：

- 想加：把新名字写进 `exclude` 数组（yml 里这个数组是**整体替换**，不是追加）
- 想减：某个目录叫 `build` 但里面确实有你心疼的文件，把它从数组里去掉

被排除的目录**不进快照、也不进报告**——排除的语义是「当它不存在」，不是「看到但不记」。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/aftermath report [--last N] [--since 2h] [--root desktop] [--save]` | 变更明细与归因 |
| `/aftermath scan [--keep]` | 立刻扫描，与上次基线对比 |
| `/aftermath roots` | 打印解析出的观测根 |
| `/aftermath roots --suggest` | 列出常用目录哪些已经盯上、哪些还没，并给出可直接粘的 yml |
| `/aftermath roots --add <路径>` / `--remove <路径>` | 预览加/减之后会变成什么样子，并给出可粘贴的 yml（不替你改配置） |
| `/aftermath status` | 配置、存档位置、记录条数 |
| `/aftermath doctor` | 自检：设置命名空间是否就绪、schema 从哪加载 |
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

只记路径、大小、mtime，不读文件内容、不存正文；命令原文只保留 ≤180 字符的片段用于归因说明，命令里出现的绝对路径最多留 12 条（每条 ≤320 字符）。命令摘要落盘前会跑一遍脱敏，把 `Authorization:` / `Bearer` / `password=` / `--token=` / `ghp_` / `AKIA` / `sk-` 这类常见密钥模式的值打码成 `[redacted]`——这是卫生措施，不是安全边界，会话日志里本来就有完整命令。不启子进程，不联网，恢复命令只打印不执行。记录按 `retentionDays` 自动清理。

记录格式 `v: 2`。每条带 `kind`：`changes`（有变更）或 `quiet`（根内无变化但执行过写操作，只含命令摘要，不含变更表）。

### 声明了哪些能力

`dsh.capabilities` 声明 `fs:read`、`tools:register`、`network:ingress`；`dsh.labels` 声明 `remote-access`。

`network:ingress` 对应标签页那条只读路由：插件在运行时通过 `ctx.inject(['webServer'])` 动态注册 `GET /aftermath/recent`，dsh-standards 的静态检查看不到动态注册，会报一条 `C-11.5` 警告，属预期，声明是真实的。路由只接 GET/HEAD，只返回已落盘的记录（路径已按 `maskHome` 打码），没有写入或删除接口。

静态检查还会报一条 `C-11.2`（发现了 egress 触发点却未声明 `network:egress`）：它把客户端 `fetch('/aftermath/recent')` 当成了出网请求，但那是一次同源请求——GUI 和服务跑在同一个 loopback 端口，面板取的是本机自己注册的路由，不发往任何外部地址，所以不声明 `network:egress` 是对的。

## 已知限制

- 只覆盖配置的根和深度，根之外看不到磁盘状态；根外只能靠「命令文本提到过哪些路径」间接提示，命令没提到的就无从得知。
- 观测根没扫全（条目超上限、子目录读不到）时，那个根整根跳过，报告开头直接写「本轮观测不完整」，不会把没扫到的算成删除；这轮也不更新基线。
- `moved` 是启发式判断（同名 + 同大小 + mtime 相近），报告里会标注。
- 归因是证据强度分级，标 `？` 就是没有证据。
- 调用区间依赖宿主给出 `tool/result`：命令用 `Start-Process` 或 `&` 拉起后台进程时，改动会发生在区间结束之后，只能落到宽窗。
- 跨进程、跨会话的手动改动只能落进「时间窗内」或「无法归因」。
- 不自动还原：只存路径不存内容，还原是 rollback 类插件的事。

## 开发

```bash
npm test   # 142 个测试
```

零运行时依赖，只用 `node:` 内置模块。观测走 `ctx.on('session/event')`，`inject: ['tools']` 仅用于注册 `aftermath_history`。

## License

MIT
