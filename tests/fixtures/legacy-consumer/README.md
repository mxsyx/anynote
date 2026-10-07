# 旧消费者 fixture

`consumer.ts` 固定了 Anynote 0.1.0 的公开调用面，供发布矩阵的旧消费者测试使用。

- 由 `pnpm run test:release:matrix` 复制到只含官方 tarball 的干净项目，用 `tsc`
  编译后实际运行。
- 只允许使用 `@anynote/plugin-sdk` 与 `@anynote/first-party-adapters` 的公开导出，
  不得引用仓库路径或内部模块。
- 改变公开调用面时，必须同步提升 `packages/protocol/src/release.ts` 中
  `legacyConsumers` 的契约版本并更新本文件，不能静默破坏旧消费者。
