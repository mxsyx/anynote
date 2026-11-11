# Rust 导入、下载与媒体重试

本文维护 Rust 接口、约束和验证方法；未完成工作统一见 [TODO](TODO.md)。

## 所有权与接入

- `anynote_services::importer::ImportService` 由后端服务持有；输入为 `ImportInput::{Url,Html,Markdown,File}`。`File` 是原生文件选择器交付的已打开句柄，不能由渲染层直接传路径获得文件访问权。
- `ImportOptions` 提供 page/article、预算收紧、保留原 HTML、目录授权 token 和待下载来源集合。目录授权通过 `authorize_directory` 注册，绑定 Notebook；撤销、过期或目标不符时拒绝。授权上限 8 个，30 分钟；本地相邻文件、内嵌图片与公网媒体经过同一资源 staging 和图片验证。
- `preview` 在后台工作线程运行，使用宿主 Tokio runtime；HTML 解析、文件/ZIP 操作为有界同步工作，不放到 GPUI 事件线程。`retry_media` 等待存储队列时使用 runtime 的 blocking pool，下载不占用 SQLite 写队列。媒体当前逐项流式处理，峰值并发为 1，不突破预算中的 4 路上限；没有另建任务状态机。
- `get_preview` 返回正文前 20,000 UTF-16 单元、标题和报告；内部保留完整正文及文件租约。当前报告是服务内数据，宿主接 IPC 时须做有界投影/分页，不能把含内嵌 URL 或全部重试上下文的报告直接装进 RM03 的 1 MiB 帧。
- 预览最多 4 个，绑定 Notebook 和 parent，30 分钟 TTL。`get_preview`、`preview`、`commit` 会清理过期项，宿主也可周期调用 `prune`。`discard`、过期清理、失败和服务销毁会释放临时目录；进程强杀后的临时目录不被当作可恢复预览。
- `commit` 是阻塞工作线程入口，只提交保留的 `CreateNode`、资源句柄及报告，不能更换目标、改正文或再次抓取。取消在进入写事务前检查；一旦写队列开始原子提交，之后到达的取消不撤销成功结果。UI/任务调用方应沿用 RM03 的 committing/终态及断线核对规则，接线归 RM28/29；采集消费归 RM12。

## HTML 与网络

HTML 使用 dom_query/html5ever 解析、dom_smoothie 正文提取和项目自有 Markdown 转换规则；只输出安全链接、文本、表格、列表、代码及内置视频卡，不把 HTML DOM 注入 UI。原始 HTML 是下载附件，宿主不得把它作为受信页面执行。

复现语料来自旧 `prepareImport`（Readability、DOMPurify、Turndown），覆盖 17 份逐字标题/正文/fallback 对比：中文/emoji、危险链接和脚本、嵌套/缺列/含竖线表格、列表、引用、畸形 HTML、未知标签、正文提取、空白、转义、代码语言和反引号。另覆盖懒加载、srcset/picture、YouTube 等白名单视频卡、直接音视频、附件选择、失败报告。`tests/fixtures/import/rm07-chatgpt.md` 保留旧 ChatGPT 卡片转换结果；Rust 采集导入按 Markdown 资源目的地改写，代码及卡片原文不改。

`network::download` 仅接受无用户名/密码的 HTTP(S)，验证全部 DNS 地址，连接固定到已验证地址，TLS 仍使用原主机名和默认可信根；禁用代理、自动跳转与 Referer。响应的实际 socket 地址必须与固定地址相同。最多 5 次跳转，每次重新检查 URL、DNS 和 socket。一个 30 秒内的 deadline 覆盖 DNS、全部跳转、headers、body 和写入背压；取消会丢弃网络 future。按 Content-Length 和逐块累计分别执行字节预算，不把完整媒体响应保留为内存/base64。

限制沿用入口区别：HTML 10 MiB；网页媒体 200 项、单项/响应 20 MiB、含原 HTML 总量 80 MiB；图片仅 PNG/JPEG/WebP 本地化，验证实际格式、有界 256 KiB 头部、16,384 边长和 40 MP 解码预算。普通单文件 50 MiB；Markdown 为 UTF-8、2,000,000 UTF-16 单元。DOM 另设 100,000 节点/256 深度上限，防止恶意结构耗尽递归。用户只能收紧预算。

目录授权保留 canonical path、文件身份与 capability 目录句柄；打开时重新核对授权根和文件身份，cap-std 阻止父路径竞态逃逸。拒绝绝对路径、`..`、百分号编码穿越、反斜线、NUL、任意远端/file URL、越界符号链接和特殊文件；允许目录内符号链接。Unix O_NONBLOCK 防止 FIFO 在 fstat 前卡住。

## `.anyclip` 与原子持久化

ZIP 使用与 RM08 归档共用的中央目录预检，只调整允许的条目名及入口预算。采集包最多 90 MiB、202 entries，manifest 1 MiB、正文 8 MiB，媒体沿用 200 项/20 MiB/80 MiB。预检先于 ZIP reader 的文件名去重，拒绝重复名、穿越、链接、加密、不支持压缩、分卷、重叠或越界数据；逐块解压继续核对实际大小、CRC、SHA-256。包体声明和实际条目必须完全一致。

严格验证 format/version、UUID、来源 URL/时间、缺失清单与 complete、资源路径/hash/数量/大小。canonical digest 先以 JS Number 语义格式化数值，再按 UTF-16 key 次序递归序列化；数组保持原序。`ryu-js` 用于 ECMAScript 数值表示，不能用默认 serde key 顺序或数值显示代替。

`WritableNotebook::commit_import` 复用 RM05 的 `validate_create/create_inside`、资源发布、修订及索引，在同一事务写入 `import_reports` 和 `capture_receipts`。采集 ID + digest 相同返回原 note；同 ID 不同 digest 拒绝。原 HTML 即使未出现在正文，也显式 pin 到导入修订及重试生成的修订。资源绑定允许 200 项媒体再加 1 项原 HTML。

失败回滚 SQL、正文、报告、回执、索引和 revision counter。遵循 RM05 的 CAS 发布语义：事务失败可能留下未引用 CAS 文件，不能删除可能被历史引用的字节；staging 目录则立即释放。原始资料、历史资源和未知插件状态不由导入器清理。

## 媒体重试

重试读取持久报告，在存储队列外下载，沿用原预算及已占用字节；新的目录授权需重新提供。取消整次重试会释放已完成/部分 staging，不提交半次结果。

提交时重新读当前笔记及报告：报告已被另一次重试修改则拒绝；对每个失败项核对唯一 marker、原占位文本和整行上下文，代码围栏内的文本不能被当作活动占位。用户改动占位行、删除/复制标记时跳过，其余段落/标题/标签保留。表格同一行中的多个标记按原位置倒序替换；分次重试更新仍失败项的行上下文。保存时再核对当前 revision，并将正文、资源、报告放在一个事务中。

旧报告中的未知字段和 linked/unsupported 状态可读取保留；没有可靠原占位上下文的条目安全跳过，不凭猜测覆盖正文。媒体解码、PDF 阅读和视频播放的完整功能仍由相应媒体组提供。

## 固定依赖与复现

新增主要固定版本为 dom_query 0.27.0、dom_smoothie 0.17.0（MIT）、reqwest 0.12.28/rustls 0.23.46（MIT/Apache-2.0）、cap-std 3.4.5（Apache-2.0/LLVM exception/MIT 可选）、ryu-js 1.0.2（Apache-2.0/BSL-1.0）。ZIP 2.4.2 与 RM08 共用 `deflate-miniz`；编码、时间、图片及 Markdown 复用锁文件版本。完整依赖与许可证清单由 `check-rust-workspace.py` 生成；不引入 JS 运行时，不增加 crate。API 依据可查 [dom_smoothie](https://docs.rs/dom_smoothie/0.17.0/dom_smoothie/) 和 [reqwest](https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html)。

```sh
# .build 旧 TS 参考产物需先按项目构建入口生成
node scripts/rust-import-reference.mjs
cargo test -p anynote-services --test import --offline --locked
cargo test -p anynote-services --lib --offline --locked network::tests
cargo test -p anynote-services --lib --offline --locked importer::
cargo build -p anynote-services --example import_probe --offline --locked
node scripts/rust-import-interop.mjs
node_modules/.bin/vitest run tests/web-import.test.mjs tests/capture.test.mjs tests/capture-components.test.mjs tests/extensions.test.mjs
```

网络单元测试仅在 loopback 上运行内部 transport fixture，不向生产下载器开放私网开关。`tls/cert.der` 和 `tls/key.der` 是专供不受信证书拒绝测试的公开合成密钥，不能用于实际服务。HTTP 流、拒绝自动跳转、固定地址、大小限制、写入故障、超时、取消和不受信 TLS 均有本机测试；生产公网 DNS/TLS、真实重定向/代理组合、连接中断及平台差异仍交 RM35。此次没有三平台、真实资料、GUI/任务集成、性能或 当前 F 任务 的通过结论。
