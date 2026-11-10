# 原生编辑器与内置能力

Rust 文档内核持有唯一 Markdown 正文、事务和历史；GPUI 提供连续编辑与源码入口。源码和富编辑共用撤销历史、选区映射和保存会话，未知语法保留原文。详情见 [编辑器设计](../design/RUST-EDITOR-DESIGN.md) 与 [保存会话](../development/RUST-DOCUMENT-SESSION.md)。

## 内置能力

callout/details、采集卡片、阅读记录、统计、检索追加和媒体偏好使用静态内置业务，不安装或执行插件。数据版本、原子回执和未知业务保全见 [内置业务契约](../development/RUST-BUILTIN-BUSINESS.md)。

图片、PDF、白板和视频分别使用 [图片阅读](../development/RUST-IMAGE-MEDIA.md)、[PDF 阅读](../development/RUST-PDF-READER.md)、[白板契约](../development/RUST-BOARD-VIEW.md) 与 [WebView/视频](../development/RUST-WEBVIEW-VIDEO.md)。资源绑定笔记修订；历史阅读不能意外取当前资源。

## 使用边界

保存失败保留草稿并提供恢复路径；不承诺防抖期间未提交输入可在进程崩溃后恢复。白板完整动作、编辑器复杂结构和系统退出保存仍有 [未完成任务](../development/TODO.md#rust-migration)。平台输入、读屏、DPI、视频实际播放和最终发行须分别验收。
