# Rust 静态内置业务（RM20）

2026-11-09。接续 RM19 的唯一正文、历史、保存会话，使用现有 schema v5 / 写队列及 RM07 下载器。没有新增插件宿主、manifest 注册、脚本执行、WASM 或 dylib 加载。

## 原生入口与声明块

编辑器“插入”菜单、slash 和原生插入菜单提供阅读卡片、提示块、折叠块。“阅读”菜单提供创建阅读记录、阅读模板、UTF-16 统计、同步/异步相关阅读索引、阅读目标、整理记录、公开文本和笔记本偏好。阅读菜单需持久笔记；临时草稿可编辑声明块。

静态白名单：

| type / version              | 展示         | 可编辑字段         |
| --------------------------- | ------------ | ------------------ |
| `garden.reading.card` / `1` | 阅读 callout | `quote`、`thought` |
| `core.callout` / `1`        | 提示块       | `title`、`body`    |
| `core.details` / `1`        | 可折叠内容   | `title`、`body`    |

后两项是原生固定 schema，不声称识别任意用户插件的同名 presentation。其他 type、未来 version、非法 JSON 或非字符串已知字段仍保留原文，并提供源码、复制、原生文件选择器导出。已知块同样可访问原文。

字段窗口在打开时绑定 BlockId / generation，提交时拒绝过期正文；字符串限制为 2000 UTF-16 单元。使用既有 `Document::set_directive_field` 序列化，保留原始头尾围栏、换行、version、未知属性、未知 JSON、精确数值与资源引用。整组字段为一个 RM16 事务，正文与源码共用撤销历史。展开状态仅属于窗口，不写入 Markdown。

带 `data-anynote-card="1"` 的单根 HTML 卡片由 `anynote-editor::capture_card` 离线解析。限制 256 KiB、2000 节点、32 层；仅允许原采集文本标签，未知/主动内容回退原文。原生投影呈现文本、强调、层级、横纵布局，以及白名单颜色、尺寸、间距、边框、圆角、字重、行高和对齐，不执行事件属性、CSS URL、脚本或远程媒体。长度、颜色和数值先解析为受限数据，再用于 GPUI 绘制；所有原始属性仍保留。采用原生文本/布局语义，非通用 CSS 浏览器；逐像素对照与真实窗口视觉验收仍待完成。解析在投影更新时执行，渲染时使用同 generation 投影。

## 业务、原子提交与异步响应

`anynote-core::builtin` 定义固定命令和偏好 DTO；`anynote-services::builtin` 负责业务；`notebook::builtin` 负责 CAS、状态和回执。

- 创建阅读记录使用固定标题/Markdown 模板，创建新笔记并打开新窗口；原笔记不变。
- 统计使用 `encode_utf16().count()`，与旧 JavaScript `body.length` 一致，包括换行和代理对。
- 两种相关阅读索引均查询当前 Notebook 的“阅读记录”，最多 5 条，使用已有搜索排序/片段和截断信息；分别保留原有标题。写库使用独占租约，查询在其拥有的写队列连接上执行，不能另开只读连接。
- 阅读目标保留 heading / goal / enabled；禁用时正文不产生修订。
- 整理次数按 Notebook 计数，保留未知 state 字段；安全整数耗尽或非法状态拒绝执行。
- 公开文本地址由用户输入，最长 4000 字节；复用 RM07 下载器的 DNS/地址校验、逐跳重定向、peer pinning、取消、响应和字节预算。限定 128 KiB / 10 秒、UTF-8，以及纯文本、Markdown 或 JSON MIME。失败不追加正文。

运行前 flush 当前 RM19 会话。后端工作任务有上限，网络等待不阻塞协议主循环。操作请求包含固定 Notebook/note/revision/head 和 operation UUID。SHA-256 请求摘要绑定回执；重试相同 UUID 返回已提交结果，替换请求内容则拒绝。提交时再次核对 note revision/head；正文、不可变修订、FTS、整理状态、回执、changes/content_seq 在同一事务发布，失败全部回滚。

操作期间允许输入，但暂停该窗口的自动保存和切笔记/关窗完成。返回时验证 session epoch、原笔记、generation 和 IME；无新编辑则通过同一编辑事务接纳正文并推进保存基线，有新编辑则保留本地草稿和远端结果供冲突核对。超时/断线保留原 operation UUID，重试同一回执。窗口内撤销可撤销追加正文；已经提交的 Notebook 整理次数是业务记录，不随正文撤销回减。

回执在 Notebook 中持久化，进程重启后服务调用可继续核对。当前窗口待执行命令没有跨进程草稿日志；系统强制退出仍受 RM19 生命周期边界约束。

## 静态偏好与版本转换

新记录全部采用点分键，位于既有 `extension_data` 的固定 `anynote.builtin` namespace：

| key                                | schema | 用途                                             |
| ---------------------------------- | ------ | ------------------------------------------------ |
| `notebook.preferences`             | 1      | 阅读目标、白板/视频/HTML 开关、remote embed 同意 |
| `reading.session`                  | 1      | `visits`、`lastTitle` 与保留字段                 |
| `reading.receipt.<operation UUID>` | 1      | 请求摘要与已提交笔记                             |

偏好按 revision CAS 保存，非法值、未知 schema 不覆盖。首次读取兼容已有 `anynote.whiteboard/enabled`、`anynote.video/enabled`、`anynote.html-import/enabled`、`anynote.video/remoteEmbed` 布尔记录；原记录不删除。旧 `set_core_setting` 固定 API 转发到同一偏好所有者。后续 RM26/RM27/RM28 应读取 `builtin_preferences()`，不能另建偏好状态。已有显式 remoteEmbed 同意保留；没有同意记录的新 Notebook 默认关闭，保存偏好本身不联网。

`migrate_state` 复用 RM13 的完整 manifest + checksum + schema 校验：`garden.preferences` 0.1.0 的 `target` 映射为 `goal`；0.1.1 保留 `goal`；`garden.session` 0.1.0/schema1 的 `runs` 映射为 `visits`，0.1.1/schema2 保留 `visits`。只向不存在的原生状态写入，避免覆盖用户后续设置。原始状态、source revision 和逆映射由既有 RM13 保全契约负责；正式接管时 RM14 仍需调用转换并核对结果，不能仅凭 extension ID 自动转换。

存在旧 garden 状态而原生状态尚未转换时，后端偏好入口、偏好写入、目标追加和整理命令拒绝使用默认值，保留原数据。转换失败不把次数重置为零，也不覆盖未知版本。底层偏好初始值读取仅供经过校验的转换器合并旧媒体开关；实际业务入口必须先通过 `ensure_builtin_migrated()`。

## 首方 adapter 归属与未知业务阻塞

按 `packages/first-party-adapters/src/index.ts` 当前全部 capability 核对：

| 能力                                                                                                                                                                                                                                                                            | 静态业务归属                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `whiteboard.get`、`whiteboard.save`                                                                                                                                                                                                                                             | RM05 存储 / RM26 白板；开关来自本契约          |
| `video.insert`、`video.fetchMeta`                                                                                                                                                                                                                                               | RM27；视频及远程同意来自本契约                 |
| `import.start`、`import.preview`、`import.getPreview`、`import.commit`、`import.retryMedia`、`import.report`                                                                                                                                                                    | RM07 服务 / RM28 原生导入；HTML 开关来自本契约 |
| `backup.configure`、`backup.listTargets`、`backup.setScope`、`backup.setSchedule`、`backup.info`、`backup.preview`、`backup.run`、`backup.runGroup`、`backup.verify`、`backup.restore`、`backup.removeTarget`、`backup.deleteNotebookBackup`、`backup.getTask`、`backup.cancel` | RM09 服务 / RM29 宿主；不创建 adapter 执行层   |

九份已知 JSON 样例使用冻结的规范化 manifest + checksum（`tests/fixtures/builtin/known-manifests.json`）；首方 TS 样例/adapter 源码使用 RM01 `known-plugins.json` 的路径 + SHA-256。仅用于分类，不注册其中的 commands/nodes，不执行迁移脚本。

**仍阻止迁移完整性放行**：实际用户插件/必需脚本未盘点。未知 ID、修改过的 checksum、非冻结版本以及任意用户 details schema 均不能声称已经内置；保全目录/状态和 unknown_entries，逐项确认业务归属或列为阻塞。仓库九份样例通过不等于真实用户插件迁移通过。RM37 清理旧设施前须继续完成此清单。

## 验证

本轮测试与平台观察记录见 [RM20 实施记录](IMPLEMENTATION.md#rm20)。主要复现命令：

```sh
cargo test -p anynote-editor --test builtin
cargo test -p anynote-services --test builtin
cargo test -p anynote-storage --lib builtin
cargo test -p anynote-desktop --features ui-tests --lib
cargo test -p anynote-desktop --test backend
python3 scripts/check-rust-workspace.py
```

测试覆盖冻结卡片字段/围栏、原生输入与共享撤销、展开/复制、未知/未来数据、采集白名单/结构预算、UTF-16、检索追加、幂等创建与计数、CAS、事务回滚、取消/私网拒绝、状态版本映射、精确 checksum、真实后端进程及重开。测试资料位于 `tmp/rm20/`（后端测试沿用 `tmp/rm03/`），可删除；没有使用真实个人资料或真实公开服务成功下载作为证据。
