# ADR-002 · Markdown 真源与连续编辑边界

状态：采用。[返回 ADR 索引](README.md)

## 背景

富编辑投影不能成为第二份持久化正文，未知语法与资源引用不能因编辑丢失。

## 决定

Markdown 是唯一正文。Rust 文档模型持有 source segments、稳定会话 BlockId、源范围和已知/opaque 块；GPUI 负责连续编辑投影，源码模式与富编辑共用事务、选区和唯一撤销历史。

无修改时全文字节相等；局部修改仅序列化修改范围，范围外保持字节相等。保留 CRLF、空白、BOM、reference definitions、未知 JSON 与资源引用；未知块保留原文并提供源码入口。

## 取舍与边界

渲染 AST 不写入持久层；复杂结构与原生输入须分别验证。格式和输入契约见 [Rust 编辑器设计](../RUST-EDITOR-DESIGN.md)，真实 IME/读屏见 [设备验收](../../development/TODO.md#f025)。
