# 功能与操作验收清单

本表保留 INV-01–24 及 146 个操作的固定核对范围，不记录实施状态。当前缺口见根目录 [TODO](../../TODO.md)，证据汇总见[发行验收表](RUST-RELEASE-SCOPE.md)。

## 功能范围

每项都要核对实际可用行为、数据保全和失败处理。仅有预览、只读保留或局部测试，不代表整项通过。

| 编号   | 必须核对的行为                                                                           |
| ------ | ---------------------------------------------------------------------------------------- |
| INV-01 | 创建、重命名与切换笔记本；外部库原位置编辑，移出工作区不删文件，失联后可恢复。           |
| INV-02 | 目录关系与排序、深层导航、跨库复制和移动；失败保留来源，重试不重复复制。                 |
| INV-03 | 保存、输入法、切换与退出；新输入不被旧结果覆盖，失败保留草稿。                           |
| INV-04 | 连续编辑与源码、格式与插入命令、列表、表格、链接、块移动、图片尺寸和撤销。               |
| INV-05 | 阅读、大纲、属性、内部链接、反向链接及历史；恢复产生新版本并保留原历史。                 |
| INV-06 | 库内和跨库搜索、筛选、取消、预览、PDF 与批注定位；过期结果不覆盖新结果。                 |
| INV-07 | 图片缩放、平移、旋转、说明、区域批注和原图导出；另存产生新资源，旧版本保留。             |
| INV-08 | PDF 分页、缩放、文字选择、查找、批注、关联笔记及旧批注重定位；取消和切换不串页。         |
| INV-09 | 白板原有可达工具与交互、嵌图、绑定、组合、样式、撤销、预览及显式保存；只读不算替代。     |
| INV-10 | 视频卡片、用户允许后的远程播放、已有元数据离线显示和关闭释放。                           |
| INV-11 | 网页与 HTML 导入、相邻文件授权、预览确认、媒体失败报告与重试；保留用户后续编辑。         |
| INV-12 | 文件、完整归档、仅当前内容、Markdown 目录或压缩包的导入导出；预算、取消与完整性。        |
| INV-13 | 云端目标、手动与自动备份、暂停、历史恢复、接管及明确清理；重试不误发布或删除。           |
| INV-14 | 磁盘备份目标、范围、调度、空间预览、完整校验、恢复与移除；保护旧有效副本。               |
| INV-15 | 独立云连接、损坏诊断、原件保全、快照或归档恢复、清理预览与完整性检查。                   |
| INV-16 | 任务进度、失败详情、取消、重试、重启历史和诊断；记录有界并脱敏。                         |
| INV-17 | 浏览器配对、撤销、采集包、媒体与卡片导入，以及与云端采集和浏览互通。                     |
| INV-18 | 修改提案、明确应用、有条件撤销与重复请求处理；不据此宣称已有模型服务。                   |
| INV-19 | 原生菜单、快捷键、焦点路由与插入命令，保留适用的平台菜单行为。                           |
| INV-20 | 单实例、唤醒、休眠恢复、关闭退出、文件选择、显示缩放与辅助技术。                         |
| INV-21 | 系统安全凭据、失败提示与旧凭据保全；不降级明文，不向网页视图暴露秘密。                   |
| INV-22 | 笔记本工作区布局与切换、亮暗主题、中文、窗口尺寸、空态、错误、加载、焦点和减少动态效果。 |
| INV-23 | 已知阅读工具与内容块内置，保留设置和用户内容；未知程序不执行。                           |
| INV-24 | 最终桌面移除旧运行宿主与动态插件；浏览器扩展和云端仍可独立构建、部署及互通。             |

## 操作覆盖检查表

下表仅保留清单生成工具需要的操作标识及分组顺序，用于防止遗漏或重复归属，不描述函数实现或源码位置。其冻结范围与[迁移基线](RUST-MIGRATION-BASELINE.md)一致；退役操作仍需核对数据保全和业务替代。

| 归属                   | 核对标识                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作区/组织            | `listNotebooks`, `createNotebook`, `renameNotebook`, `openNotebookDirectory`, `detachNotebookDirectory`, `listNodes`, `createNode`, `moveNode`, `placeNode`, `trashNode`, `restoreNode`, `transferNode`                                                                                                                                                                                                                                                             |
| 文档/历史/检索         | `getNote`, `saveNote`, `history`, `restoreRevision`, `search`, `searchWorkspace`, `cancelSearch`, `getBacklinks`                                                                                                                                                                                                                                                                                                                                                    |
| 资源/PDF/图片          | `importFile`, `getAsset`, `getAssetInfo`, `getAssetRange`, `addResource`, `saveImageVersion`, `listAnnotations`, `addAnnotation`, `deleteAnnotation`, `createPdfNote`, `reanchorAnnotation`, `beginPdfIndex`, `indexPdf`                                                                                                                                                                                                                                            |
| 导入/采集              | `getImportReport`, `startImport`, `previewImport`, `previewCaptureFile`, `chooseImportDirectory`, `revokeImportDirectory`, `discardImportPreview`, `getImportPreview`, `commitImportPreview`, `retryImportMedia`, `pairCaptureDevice`, `listCaptureDevices`, `revokeCaptureDevice`                                                                                                                                                                                  |
| 内置媒体               | `saveWhiteboard`, `getWhiteboard`, `insertVideo`, `fetchVideoMeta`, `getExtensionSettings`, `setExtensionSetting`                                                                                                                                                                                                                                                                                                                                                   |
| 归档/快照/恢复         | `importArchive`, `exportArchive`, `exportMarkdown`, `snapshot`, `listSnapshots`, `restoreSnapshot`, `archiveExportBudget`, `exportArchiveFile`, `exportMarkdownFile`, `importArchiveFile`, `diagnoseNotebook`, `preserveNotebookEvidence`                                                                                                                                                                                                                           |
| 远端备份/维护          | `configureBackup`, `listBackupTargets`, `startBackup`, `queryPendingGeneration`, `listRemoteBackups`, `restoreRemoteBackup`, `testBackupConnection`, `setBackupSchedule`, `getBackupPolicy`, `setBackupPolicy`, `reportBackupEnvironment`, `remoteWriter`, `takeoverRemoteWriter`, `previewRemoteRetention`, `applyRemoteRetention`, `remoteRetentionState`, `configureCloudRecovery`, `listCloudRecoveryConnections`, `discoverCloudBackups`, `restoreCloudBackup` |
| 本地备份               | `configureLocalBackup`, `listLocalBackupTargets`, `setLocalBackupSchedule`, `startLocalBackup`, `verifyLocalBackup`, `restoreLocalBackup`, `removeLocalBackupTarget`, `deleteLocalNotebookBackup`, `previewLocalBackup`, `getLocalBackupInfo`, `setLocalBackupScope`, `startLocalBackupGroup`                                                                                                                                                                       |
| 任务/清理/诊断/提案    | `listTasks`, `cancelTask`, `retryTask`, `previewCleanup`, `applyCleanup`, `inspectIntegrity`, `getIntegrityReport`, `reportDiagnostic`, `getDiagnostics`, `getDiagnosticsSettings`, `setDiagnosticsSettings`, `clearDiagnostics`, `proposePatch`, `applyProposal`, `undoProposal`                                                                                                                                                                                   |
| 插件安装/命令/签名信任 | `installExtension`, `listExtensions`, `configureExtension`, `uninstallExtension`, `listExtensionCommands`, `runExtensionCommand`, `previewExtension`, `configurePublisher`, `listPublishers`, `downloadExtension`, `checkExtensionUpdate`, `installDownloadedExtension`, `cancelExtensionDownloads`                                                                                                                                                                 |
| 插件目录/更新          | `listExtensionDirectories`, `saveExtensionDirectory`, `removeExtensionDirectory`, `fetchExtensionDirectory`, `downloadDirectoryExtension`, `getExtensionUpdateSettings`, `configureExtensionUpdates`, `checkExtensionUpdates`, `listExtensionUpdateSources`, `cancelExtensionUpdateCheck`                                                                                                                                                                           |
| 插件设置/数据/托管     | `getInstalledExtensionSettings`, `saveInstalledExtensionSettings`, `getExtensionDataOverview`, `previewExtensionDataMigration`, `previewExtensionDataRestore`, `applyExtensionDataReview`, `listExtensionDataNamespaces`, `previewExtensionDataCleanup`, `applyExtensionDataCleanup`, `listHostedExtensions`, `configureHostedExtension`, `executeHostedExtensionCommand`                                                                                           |
