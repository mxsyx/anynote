# 开发

本目录按开发、回归、专项验收和发行组织，只维护可重复使用的指南与检查要求。当前任务状态见根目录 [TODO](../../TODO.md)，新增能力见 [远期扩展](FUTURE-TODO.md)；实施经过、完成摘要和单次验证结果不在本目录保存。

## 开发与维护

- [当前遗留问题](../../TODO.md)：实现缺口、已知缺陷和未完成验收，按 P0–P3 排列。
- [远期扩展](FUTURE-TODO.md)：尚未纳入当前交付的新增能力与可选优化。
- [开发工具与 CI](DEVELOPMENT-WORKFLOW.md)：Rust、浏览器扩展与 Worker 的构建和检查入口。
- [文档与任务维护](DOCUMENTATION.md)：文档归属、问题清单及临时产物规则。
- [Rust 桌面开发入口](RUST-DESKTOP-DEVELOPMENT.md)：工具链、隔离数据目录、原生依赖和验证命令。
- [保留 TS 构建与 Rust 互通](RETAINED-TS-INTEROP.md)：浏览器/Worker 独立构建及协议验证。
- [迁移基线与语料使用](RUST-MIGRATION-BASELINE.md)：冻结语料与隔离参考环境的重建方法。
- [旧桌面退役与消费者接续](RUST-LEGACY-RETIREMENT.md)：删除边界、参考工具和保留业务断言。

## 回归与验收

- [系统 PDF 预览](PDF-SYSTEM-WEBVIEW.md)：系统查看器、修订资源、导出和跨平台交互验收。

- [功能与操作验收清单](RUST-MIGRATION-INVENTORY.md)：固定功能范围与工具所需的操作分组。
- [原生回归与性能](RUST-NATIVE-REGRESSION.md)：跨层回归入口、性能预算和证据边界。
- [三平台设备验收](RUST-DEVICE-ACCEPTANCE.md)：平台批次、真实窗口及人工操作要求。
- [物理盘与灾难恢复](RUST-DISASTER-ACCEPTANCE.md)：物理故障、便携恢复和独立设备验证。
- [真实云验收](RUST-CLOUD-ACCEPTANCE.md)：受控部署、故障注入与真实老化接续。
- [公网下载验收](RUST-NETWORK-ACCEPTANCE.md)：DNS/TLS 环境准备与实际连接边界验证。
- [Cloudflare 部署与协议验收](validation/CLOUD-ACCEPTANCE.md)：测试服务配置、协议检查及老化样本接续。

## 打包与发行

- [固定发行验收表](RUST-RELEASE-SCOPE.md)：任务完成后仍必须保留的检查范围与证据要求。
- [发行矩阵](RELEASE-MATRIX.md)：目标平台、产物和数据协议版本。
- [发行凭据](RELEASE-CREDENTIALS.md)：签名身份、配置预检和真实验证边界。
- [原生候选打包](RUST-NATIVE-RELEASE.md)：打包、资源、签名和安装命令。
- [最终候选复核](RUST-RELEASE-ACCEPTANCE.md)：证据格式、检查器、接管和发布顺序。

## 阅读与维护约定

开发时先查工程入口，按改动选择回归与专项验收；发行时再核对固定范围、身份、候选包和最终复核。文档中的 RM/INV 编号用于对应固定验收范围与工具输出，不表示实施阶段或完成状态。

架构及功能设计见 [设计索引](../design/README.md)，产品用法见 [功能索引](../features/README.md)。单次报告、基准和截图放入 `tmp/`；持续云老化状态使用专用状态目录，正式发行证据归档到受控长期位置。
