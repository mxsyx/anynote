---
name: jsdoc-uncommitted-changes
overview: 仅针对本次 git 未提交的改动区域，把函数（含内部/箭头函数，不含新增到组件）的 JSDoc 补全 @param/@returns，并将改动区域内所有中文注释（JSDoc 与行内 //）统一改写为英文。
todos:
  - id: jsdoc-inventory
    content: 用 [mcp:codebase-memory-mcp] 的 detect_changes/get_file_outline 与 [skill:lsp-code-analysis] 盘点 124 个改动文件中的声明，产出“非组件函数 + 缺 @param/@returns”清单，并确认英文 JSDoc 规范
    status: completed
  - id: backend-packages
    content: 规范 cloudflare-backup、backup、backup-local、storage-sqlite 改动区域注释：中译英并补齐函数 JSDoc/@param/@returns
    status: completed
    dependencies:
      - jsdoc-inventory
  - id: sdk-packages
    content: 规范 protocol、plugin-sdk、extension-host、extension-tools、importer、types 改动区域注释：中译英并补齐函数 JSDoc/@param/@returns
    status: completed
    dependencies:
      - jsdoc-inventory
  - id: desktop-electron
    content: 规范 apps/desktop/electron 的 ipc.ts、main.cts、preload.cts、storage.ts：中译英并补齐函数 JSDoc/@param/@returns
    status: completed
    dependencies:
      - jsdoc-inventory
  - id: desktop-tsx
    content: 规范 apps/desktop/src 下 *.tsx：组件已有 JSDoc 中译英，非组件函数补齐 JSDoc/@param/@returns
    status: completed
    dependencies:
      - jsdoc-inventory
  - id: desktop-ts
    content: 规范 apps/desktop/src 的 api.ts、extension-state.ts、seed.ts 改动区域：中译英并补齐函数 JSDoc/@param/@returns
    status: completed
    dependencies:
      - jsdoc-inventory
  - id: verify-comments
    content: 复核：git diff 确认仅注释变化、无逻辑改动与中英混杂，并运行 eslint/tsc/vitest 通过
    status: completed
    dependencies:
      - backend-packages
      - sdk-packages
      - desktop-electron
      - desktop-tsx
      - desktop-ts
---

## 需求概述

针对当前工作区**尚未提交 git 的改动**（124 个被修改文件，`git diff` 约 2200 行新增）做一次注释规范化：把此前补充的中文注释统一为英文，并补全函数级 JSDoc。**只改注释，不改任何代码逻辑**，不触碰未在本次改动范围内的已提交代码。

## 核心功能

- **范围限定**：仅处理 `git diff` 涉及的区域/函数；已提交代码与无关文件不动。
- **补齐函数 JSDoc**：为非组件的函数补充 JSDoc，覆盖普通/导出函数、类方法、对象字面量方法、箭头函数常量与内部函数；React 组件不新增缺失的 JSDoc。
- **补全 @param/@returns**：所有含参数或有返回值的非组件函数，按签名顺序补 `@param`（参数名与描述）与 `@returns`；无参数/无返回值者不强行添加。
- **中译英**：改动区域内**所有**中文注释改为英文——既包括 `/** */` JSDoc，也包括行内 `//` 注释；组件已有的中文 JSDoc 同样翻译为英文。
- **保持不变**：不删除既有注释、不改命名与实现；遵循“注释与上方代码之间空一行”等既有规范，避免中英混杂。

## 视觉/呈现效果

最终代码中，本次改动涉及的所有函数与类都有语义清晰、术语一致的英文 JSDoc：导出 API 具备完整 `@param`/`@returns`，行内注释为英文说明，风格与仓库既有 JSDoc 保持一致。

## 技术栈

- 语言/工程：TypeScript 单仓多包（pnpm workspaces），`apps/*` 与 `packages/*`。
- 工具链：ESLint（`eslint.config.mjs`）、TypeScript（`tsconfig.*.json`）、Vitest（`vitest.config.ts`）、测试位于 `tests/`。

## 实施策略

本质是**跨 124 个文件的注释规范化**，采用“先定位、再分批、后校验”的策略：

1. **以 `git diff` 为唯一范围来源**：只分析并修改 diff 中的 `+` 行所对应函数/注释；不扩大范围到未改动的已提交代码。
2. **区分“函数”与“组件”**：React 组件识别为 PascalCase 且返回 JSX 的函数；其余（普通函数、导出函数、类方法、对象方法、箭头函数常量、内部函数）都算目标函数，需要 JSDoc + `@param`/`@returns`。组件只翻译已有 JSDoc，不新增。
3. **分批处理**：按包/目录分批（cloudflare/backup/storage 后端；protocol/plugin-sdk/extension-host/extension-tools/importer/types SDK；desktop electron；desktop 渲染层 tsx/ts），每批内部统一术语，降低上下文切换。
4. **保持纯注释变更**：仅调整注释文本/新增注释行，绝不触碰逻辑、签名、导入顺序。

### 关键决策与理由

- **翻译行内 `//` 注释**（用户已确认）：避免中英混杂，保持文件语言一致。
- **按签名推导 `@param` 而不是模板套用**：`@param` 名称必须与函数形参一致（含解构参数用属性名或整体名），避免文档失真。
- **单行 `/** ... \*/`保持简洁**：无参数/无返回值的工具函数维持单行摘要；有参数/返回值时展开为多行块并补`@param`/`@returns`（参照 `packages/protocol/src/image.ts`中`imageBlock` 的既有风格）。

### 性能与可靠性

- 纯文本编辑，无运行时性能影响；重点在**准确性与可验证性**：以 `git diff --stat` 与行级 diff 复核“仅注释变化”，配合 lint/typecheck/测试确保无破坏。

### 风险控制

- 文件量大（124 个），逐批推进并每批自检，避免遗漏。
- 不引入新依赖、不做无关重构；保留既有注释不删除。

## 实施注意事项

- 注释与上方代码之间空一行；`@param` 顺序与函数签名一致；`@returns` 仅在确有返回值时添加（含返回 `null`、抛出异常场景用文字说明）。
- 术语统一（如 notebook、generation、epoch、writer、resource、manifest、digest 等沿用现有英文用词），避免逐文件翻译不一致。
- 只依据 diff 行定位目标，禁止顺带翻译未在本次改动中的已提交中文注释。
- 校验命令：`eslint`、`tsc`（对应 tsconfig）、`vitest run`；并用 `git diff` 确认无逻辑差异。

## 架构与目录结构

本次为注释规范化，不改变系统架构。涉及文件（仅 uncommitted 改动，按包分组）：

```
apps/cloudflare-backup/src/   # index.ts, maintenance-coordinator.ts, maintenance.ts, retention-policy.ts
apps/desktop/electron/        # ipc.ts, main.cts, preload.cts, storage.ts
apps/desktop/src/ (tsx)       # Backlinks.tsx, BackupTargets.tsx, CloudRecovery.tsx, DocumentView.tsx,
                              # ExtensionCleanupPanel.tsx, ExtensionCommands.tsx, ExtensionDataControls.tsx,
                              # ExtensionDirectoryBrowser.tsx, ExtensionPage.tsx, ExtensionSettingsForm.tsx,
                              # ExtensionUpdateSettings.tsx, HostedExtensionsPanel.tsx, ImageBlockEditor.tsx,
                              # ImportDialog.tsx, ImportReport.tsx, LocalBackup.tsx, LocalBackupReview.tsx,
                              # LocalBackupScope.tsx, LocalCleanup.tsx, LocalVerificationDetails.tsx,
                              # NotebookTransferDialog.tsx, PdfReader.tsx, PluginBlock.tsx, RemoteMaintenance.tsx,
                              # ResourceImage.tsx, RichEditor.tsx, SourceEditor.tsx, TaskCenter.tsx,
                              # WhiteboardEditor.tsx, main.tsx
apps/desktop/src/ (ts)        # api.ts, extension-state.ts, seed.ts
packages/backup-local/src/    # files.ts, filesystem.ts, index.ts, verification.ts
packages/backup/src/          # connection.ts, file-logical.ts, file-s3.ts, file-snapshot.ts, local-capture.ts,
                              # local.ts, logical.ts, manage.ts, providers.ts, recovery.ts, restore-task.ts,
                              # s3-control.ts, s3-maintenance.ts, scheduler.ts, service.ts
packages/extension-host/src/  # bundled.ts, contracts.ts, examples/reading-template.ts, index.ts, node.ts,
                              # protocol.ts, rpc.ts, worker.ts
packages/extension-tools/src/ # cli.ts, commands.ts, manifest.ts, migrations.ts, network.ts, search-context.ts,
                              # settings.ts, signature.ts, templates.ts
packages/importer/src/        # html.ts, network.ts, worker.ts
packages/plugin-sdk/src/      # contracts.ts, declarative.ts, examples/reading-template.ts, host.ts, index.ts,
                              # local-backup.ts, proposals.ts, script-runner.ts, script-state.ts, script-worker.ts
packages/protocol/src/        # cloud-objects.ts, extension-directory.ts, html-decode.ts, image.ts, markdown.ts, rich.ts
packages/storage-sqlite/src/  # archive-jobs.ts, archive-stream.ts, archive-validation-worker.ts, backup-revision.ts,
                              # cleanup.ts, extension-catalog.ts, extension-cleanup.ts, extension-data.ts,
                              # extension-directories.ts, extension-download.ts, extension-settings.ts,
                              # extension-signature.ts, extension-updates.ts, index.ts, open-export.ts, operations.ts,
                              # organization.ts, schema.ts, script-commands.ts, script-network.ts, search.ts,
                              # temporary-jobs.ts, transfer.ts, workspace.ts
packages/types/src/           # extension-cleanup.ts, index.ts, local-backup.ts, runtime.ts
```

## Agent Extensions

### MCP

- **codebase-memory-mcp**
  - Purpose: 用 `detect_changes` 把当前 git diff 精确映射到文件与影响范围，并用 `get_file_outline` 逐文件列出声明（函数/类/接口/常量），确保 124 个文件的改动区域无遗漏。
  - Expected outcome: 得到“文件 → 声明”的完整清单，作为补齐 JSDoc 与 @param/@returns 的执行依据，并以 `check_index_coverage` 复核覆盖。

### Skill

- **lsp-code-analysis**
  - Purpose: 对每个改动文件获取语义级文件大纲与符号种类，准确区分“React 组件”与“需补 JSDoc 的普通函数/方法/箭头函数”，避免把组件误当目标或漏掉内部函数。
  - Expected outcome: 产出可信的“非组件函数”清单，指导分批补齐 JSDoc、@param/@returns。
