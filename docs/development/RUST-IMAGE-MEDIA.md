# Rust 图片阅读、文档图片与版本（RM21）

2026-11-09：RM21.1–.3 的应用内实现与本地矩阵完成，状态见 [TODO](TODO.md#rm21)。本页记录实现边界；三平台原生选择器、真实照片、DPI、峰值内存及反复开关后的资源回收仍由 RM31/32 验收，不关闭 M6/INV-07 的整体验收。

## 入口与复用

- `anynote-editor/src/image.rs` 解析独立的 `![alt](anynote-resource:uuid)` 与 `core.image` v1。32–4096 宽度或留空自适应通过现有 Editor 事务修改，单次撤销；未知 JSON 数字/字段、directive 属性与换行保留。混排、远程 URL、非法或未来声明继续保持原文。
- `document_editor/images.rs` 接原生多选文件、剪贴板图片/文件路径、系统 `ExternalPaths` 拖入。文件读取、校验和编码在后台；完成后核对会话、generation、选区与原笔记身份。多图插入是一笔正文事务。图片块可调整显示宽度、打开阅读器、复制源码；跨笔记粘贴图片使用阅读器的“复制原图”，重新上传资源。
- `image/view.rs` 使用 Kit Button/Dialog/Input 和 GPUI canvas。适应、实际尺寸、缩放、拖动平移、视图旋转、区域批注、历史选择、原图复制/导出和旋转另存都有生产入口。键盘支持 `+/-`、`0`、`1`、`r`、方向键和 Escape。
- 保存复用 RM19 唯一 SaveController、CAS 和 WriteQueue；跨库复制、完整快照及开放导出复用 RM06/RM08，不再实现媒体数据库。开放导出按 MIME 保留图片扩展名。

## 解码和资源预算

支持当前 PNG/JPEG/WebP/SVG，并可读取 GIF/BMP/ICO/TIFF。当前阅读器是**静态预览**，多帧格式显示首帧；视图旋转不修改原始字节，旋转另存输出当前静态画面的 PNG 新版本。

| 边界              | 实现                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 输入              | 每张 50 MiB、边长 16384、40MP；旋转另存上限 24MP                                                                                |
| 批量导入/草稿复制 | 待保存与 Undo 保留项合计最多 32 张、100 MiB；超限保留原草稿并报错                                                               |
| 栅格解码          | image reader 分配限额 256 MiB；解码输出缓冲区上限 160 MiB；进程内串行解码                                                       |
| 预览              | 阶梯 640/1280/2560/4096；当前块请求 640、阅读器请求 2560；显示“实际尺寸”使用原图尺寸及窗口 scale factor，预览纹理仍有分辨率上限 |
| 可见块            | 单次渲染最多 8 个自动缩略图，其余可主动打开；淘汰项显式释放纹理；缩略图不长期持有原字节和 CPU 像素                              |
| SVG               | 最大 4 MiB；拒绝 DTD/实体；resvg 不执行脚本，禁用外部/文件/data image 解析；系统字体首次 SVG 预览时加载                         |
| EXIF              | 解码器方向只应用一次；有界读取相机/曝光/时间/尺寸等字段，未读取 GPS/MakerNote                                                   |

这些是分配和输入的程序限制，**不是进程 RSS 实测结论**。当前栅格缩略图需要在后台解码完整的受限原图再缩小，不是磁盘缩略图缓存、流式缩小或瓦片解码。过大图片明确拒绝；没有启动时扫描和解码整库媒体。

## 版本、批注与生命周期

每次读取冻结 `DocumentId + revision UUID + resource UUID`。`BeginRead` 在存储队列中验证权限、绑定与完整 hash，返回一个已验证的文件句柄；后续读取最多 256 KiB，并持续检查文件身份。避免每个分块重新计算整张图片 hash。读取 token 由调用方提前创建，RAII 在成功、失败、取消和关闭时发送 `EndRead`；后端最多 16 个句柄，并在后续请求时回收闲置 60 秒的兜底租约。后端重启使全部句柄失效。

上传是私有协议中的顺序分块，绑定笔记和 resource ID；50 MiB/32 项/100 MiB 限额及 30 分钟暂存有效期。文件路径不发送给后端。待保存字节由当前编辑器持有，实际保存前上传，CAS 事务将新 hash 与修订一起提交。失败或断线保留字节以供核对后重试，上传租约在保存流程结束时释放。

SaveController 除正文 generation 外记录媒体 generation；仅旋转而正文未变仍产生一个修订。ack/断线核对必须同时匹配正文和提交资源的 hash，不能把同正文、不同图片当成已保存。已撤销但尚未发布的图片暂留以支持 Redo。冲突“另存草稿”复制原修订绑定和待提交图片，确认新笔记保存后保留冲突原笔记。

矩形保存为原图方向下的归一化坐标，独立于缩放、平移、显示旋转和 DPI。批注记录固定 `target_asset_hash`；添加和删除核对当前修订与 hash。历史阅读只读；旧 hash 批注保留、标明旧版本，不绘制到新图。旋转另存复用 resource ID、产生新 hash，历史绑定与旧矩形不重写。历史面板展示最近 100 个包含该资源的修订。

关闭阅读器、切换笔记或淘汰缩略图取消任务、丢弃晚到回调、释放 CPU 缓冲区和 GPUI 纹理；无法在第三方解码器的一条同步调用内部强制中断，返回后检查取消标记。原图复制/导出直接使用该修订原字节，导出通过同目录临时文件与 rename 发布；不会导出显示旋转后的预览冒充原图。

## 本地验证

```sh
cargo test -p anynote-core -p anynote-editor -p anynote-storage --locked --offline
cargo test -p anynote-desktop --features ui-tests --lib --test image --test image_backend --test image_storage --test image_ui --locked --offline
cargo clippy -p anynote-desktop -p anynote-editor -p anynote-core -p anynote-storage -p anynote-services --all-targets --features anynote-desktop/ui-tests --locked --offline -- -D warnings
python3 scripts/check-rust-workspace.py
```

本次 core/editor/storage **127 项通过，2 个既有子进程辅助夹具 ignored**；desktop **41 项通过**，其中生产控件 GPUI 矩阵 2 项使用真实隔离后端。新增专项覆盖：格式/EXIF/恶意 SVG/预算/取消、DPI 与四种旋转的矩形往返；无损宽度事务；上传、CAS、旧版本字节、过期 hash/修订拒绝、句柄释放；跨库完整资源与批注闭包、完整快照、当前 Markdown 导出；粘贴/文件选择/外部拖入、宽度、缩放、选区与批注提交、原图复制/导出、旋转新版本、历史往返、冲突另存和关闭后的迟到结果。另有 archive/transfer **18 项通过**，五工程全目标 Clippy、定向 rustfmt、diff 空白及依赖边界（5 工程 / 844 包）检查通过。无损 JSON 模式下批注浮点坐标的 tagged-enum 反序列化已用 `serde_json::Number` 修复，并以真实协议往返验证。

临时日志在 `tmp/rm21-*.log`，原生隔离状态和合成图片在 `tmp/rm21/`。实际 macOS 构建打开了持久笔记、插入菜单与图片文件选择器；工具在路径确认时反复回到根目录，未完成原生图片画面/导出选择器/DPI/照片/内存验收。GPUI 平台模拟的文件选择、剪贴板及拖放不等于上述设备证据。没有接管个人资料，也未关闭 RM18/19 的系统退出、组合输入及平台限制。
