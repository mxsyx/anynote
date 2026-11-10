use super::*;
use crate::local_backup::{Checkpoint, LocalBackupService, NativeVolumes, Observer};
impl Manager<'_> {
    pub(super) fn execute_local(&mut self, operation: Operation) -> CloudResult<Outcome> {
        use Operation::*;
        let purge = matches!(operation, Operation::CleanupPurge { .. });
        let report = match operation {
            AttachRestored { path } => {
                let meta = self
                    .queue
                    .submit(move |catalog| catalog.attach_directory(&path))?
                    .wait()?;
                Report::new("已恢复的笔记本已登记到工作区").line("笔记本", meta.name)
            }
            ConnectLocal { directory, name } => {
                ensure(
                    directory.join("AnynoteBackup/backup-root.json").is_file(),
                    "BACKUP_ROOT_MISSING",
                )?;
                let target =
                    crate::local_backup::initialize_target(&directory, &[], &NativeVolumes)
                        .map_err(local_error)?;
                let id = target.id.clone();
                if let Some(prior) = self.settings.local.iter_mut().find(|t| t.target.id == id) {
                    prior.target = target;
                    prior.paused = true;
                } else {
                    ensure(
                        !name.trim().is_empty()
                            && name.len() <= 240
                            && self.settings.local.len() + self.settings.cloud.len() < 100,
                        "TARGET_INPUT",
                    )?;
                    self.settings.local.push(LocalTarget {
                        name,
                        target,
                        notebooks: vec![],
                        interval_minutes: 60,
                        paused: true,
                    });
                }
                self.save()?;
                self.configure(&id)?;
                Report::new("备份磁盘已连接；可以浏览、校验或恢复其中的笔记本。").action(
                    "浏览本地备份",
                    LocalContents {
                        target: id,
                        offset: 0,
                    },
                )
            }
            LocalContents { target, offset } => {
                let t = self.local(&target)?;
                let books = crate::local_backup::list_backups(&t.target, &NativeVolumes)
                    .map_err(local_error)?;
                let mut report = Report::new(format!("{} 个本地备份", books.len()));
                for (id, name, completed) in books.iter().skip(offset).take(25).cloned() {
                    report = report
                        .line(&name, completed)
                        .action(
                            format!("校验 {name}"),
                            LocalVerify {
                                target: target.clone(),
                                notebook: id.clone(),
                            },
                        )
                        .action(
                            format!("恢复 {name}…"),
                            LocalRestore {
                                target: target.clone(),
                                notebook: id,
                                destination: PathBuf::new(),
                            },
                        );
                }
                if offset + 25 < books.len() {
                    report = report.action(
                        "下一页本地备份",
                        LocalContents {
                            target,
                            offset: offset + 25,
                        },
                    );
                }
                report
            }
            UpdateLocal {
                target,
                notebooks,
                interval_minutes,
            } => {
                ensure(
                    !notebooks.is_empty()
                        && notebooks.len() <= 100
                        && (1..=43_200).contains(&interval_minutes),
                    "TARGET_INPUT",
                )?;
                let books = self.books()?;
                ensure(
                    notebooks
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        == notebooks.len()
                        && notebooks
                            .iter()
                            .all(|id| books.iter().any(|b| &b.id == id && !b.unavailable)),
                    "NOTEBOOK_SELECTION",
                )?;
                let t = self
                    .settings
                    .local
                    .iter_mut()
                    .find(|t| t.target.id == target)
                    .ok_or_else(|| CloudError::new("TARGET_NOT_FOUND"))?;
                t.notebooks = notebooks;
                t.interval_minutes = interval_minutes;
                t.paused = true;
                self.save()?;
                self.configure(&target)?;
                Report::new("备份范围已更新，自动备份暂停。核对范围后可重新启用。")
            }
            Integrity { notebook } => {
                let temporary = self.temporary()?;
                let cancel = self.cancel.storage.clone();
                (self.progress)(Report::new("正在捕获一致切面并检查数据库和资源"));
                let mut cut = self
                    .queue
                    .submit(move |s| s.capture_snapshot(&notebook, &temporary, &cancel))?
                    .wait()?;
                cut.prepare(SnapshotMode::Preservation, &self.cancel.storage)?;
                ReadonlyNotebook::open(cut.path(), Some(cut.notebook_id()))?.integrity_check()?;
                Report::new("完整性检查通过")
            }
            CleanupPreview {
                notebook,
                keep,
                days,
            } => {
                let id = notebook.clone();
                let p = self
                    .queue
                    .submit(move |s| s.preview_cleanup(&id, keep, days))?
                    .wait()?;
                let mut r = Report::new(format!(
                    "可隔离 {} 份快照，共 {} 字节。预览 5 分钟内有效。",
                    p.files.len(),
                    p.bytes
                ));
                for f in p.files.iter().take(200) {
                    r = r.line(&f.path, format!("{} 字节", f.size));
                }
                if !p.files.is_empty() {
                    r = r.action(
                        "隔离这些快照…",
                        CleanupApply {
                            notebook,
                            plan: p.id,
                        },
                    );
                }
                r
            }
            CleanupApply { notebook, plan } => {
                let id = notebook.clone();
                let p = plan.clone();
                // Save the recovery identity before mutation, including failure/partial rollback.
                (self.progress)(Report::new("正在隔离快照").action(
                    "恢复隔离快照",
                    CleanupRecover {
                        notebook: notebook.clone(),
                        plan: plan.clone(),
                    },
                ));
                match self
                    .queue
                    .submit(move |s| s.apply_cleanup(&id, &p, true))?
                    .wait()
                {
                    Ok(r) => Report::new(format!(
                        "已隔离 {} 份快照（{} 字节），尚未永久删除。",
                        r.quarantined, r.bytes
                    ))
                    .action(
                        "恢复隔离快照",
                        CleanupRecover {
                            notebook: notebook.clone(),
                            plan: plan.clone(),
                        },
                    )
                    .action("永久删除隔离快照…", CleanupPurge { notebook, plan }),
                    Err(e) => {
                        return Ok(Outcome::new(
                            TaskStatus::Failed,
                            Report::new(format!("隔离未完成：{e}。保留回执供恢复。"))
                                .action("恢复隔离快照", CleanupRecover { notebook, plan }),
                        ));
                    }
                }
            }
            CleanupRecover { notebook, plan } | CleanupPurge { notebook, plan } => {
                let id = notebook.clone();
                let path = self.queue.submit(move |s| s.notebook_path(&id))?.wait()?;
                if purge {
                    let r = purge_cleanup(&path, &notebook, &plan, true)?;
                    let report = Report::new(format!(
                        "已释放 {} 字节；剩余 {} 个文件。",
                        r.reclaimed_bytes,
                        r.pending.len()
                    ));
                    if let Some(error) = r.error {
                        return Ok(Outcome::new(
                            TaskStatus::Failed,
                            report
                                .line("失败原因", error)
                                .action("恢复剩余快照", CleanupRecover { notebook, plan }),
                        ));
                    }
                    report
                } else {
                    Report::new(format!(
                        "已恢复 {} 份快照",
                        recover_cleanup(&path, &notebook, &plan)?
                    ))
                }
            }
            AddLocal {
                directory,
                name,
                notebooks,
                interval_minutes,
            } => {
                ensure(
                    !name.trim().is_empty()
                        && name.len() <= 240
                        && !notebooks.is_empty()
                        && notebooks.len() <= 100
                        && (1..=43_200).contains(&interval_minutes),
                    "TARGET_INPUT",
                )?;
                ensure(
                    self.settings.local.len() + self.settings.cloud.len() < 100,
                    "TARGET_LIMIT",
                )?;
                let books = self.books()?;
                ensure(
                    notebooks
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        == notebooks.len()
                        && notebooks
                            .iter()
                            .all(|id| books.iter().any(|b| &b.id == id && !b.unavailable)),
                    "NOTEBOOK_SELECTION",
                )?;
                let sources = books
                    .iter()
                    .map(|b| b.path.clone())
                    .chain(std::iter::once(self.directory.join("workspace")))
                    .collect::<Vec<_>>();
                let target =
                    crate::local_backup::initialize_target(&directory, &sources, &NativeVolumes)
                        .map_err(local_error)?;
                ensure(
                    self.settings.local.iter().all(|t| t.target.id != target.id),
                    "TARGET_ALREADY_EXISTS",
                )?;
                let id = target.id.clone();
                self.settings.local.push(LocalTarget {
                    name,
                    target,
                    notebooks,
                    interval_minutes,
                    paused: true,
                });
                self.save()?;
                self.configure(&id)?;
                Report::new("本地备份目标已保存，自动备份默认暂停。")
                    .action("立即备份", LocalBackup { target: id.clone() })
                    .action(
                        "启用自动备份",
                        SetPaused {
                            target: id,
                            paused: false,
                        },
                    )
            }
            LocalBackup { target } => return self.backup_local(&target),
            LocalVerify { target, notebook } => {
                let t = self.local(&target)?;
                let r = LocalBackupService::default()
                    .verify(
                        &t.target,
                        &notebook,
                        &self.temporary()?,
                        &self.cancel.storage,
                        &NativeVolumes,
                    )
                    .map_err(local_error)?;
                let mut report = Report::new(format!(
                    "校验{}：{} / {} 个文件",
                    if r.status == "passed" {
                        "通过"
                    } else {
                        "未通过"
                    },
                    r.verified_files,
                    r.checked_files
                ))
                .line("数据库", &r.database_check);
                for issue in r.issues.iter().take(200) {
                    report = report.line(&issue.path, &issue.message);
                }
                return Ok(Outcome::new(
                    if r.status == "passed" {
                        TaskStatus::Completed
                    } else if r.status == "interrupted" {
                        TaskStatus::Cancelled
                    } else {
                        TaskStatus::Failed
                    },
                    report,
                ));
            }
            LocalRestore {
                target,
                notebook,
                destination,
            } => {
                let t = self.local(&target)?;
                let meta = LocalBackupService::default()
                    .restore(
                        &t.target,
                        &notebook,
                        &destination,
                        &self.cancel.storage,
                        &NativeVolumes,
                    )
                    .map_err(local_error)?;
                return Ok(self.restored_outcome(&destination, &meta));
            }
            ArchiveRestore {
                archive,
                destination,
            } => {
                let meta =
                    crate::archive::import_archive(&archive, &destination, &self.cancel.storage)?;
                return Ok(self.restored_outcome(&destination, &meta));
            }
            _ => return Err(CloudError::new("INVALID_OPERATION")),
        };
        Ok(Outcome::new(TaskStatus::Completed, report))
    }
    pub(super) fn restored_outcome(&self, destination: &Path, meta: &NotebookMeta) -> Outcome {
        let path = destination.join(&meta.id);
        let report = Report::new("备份已恢复为新笔记本")
            .line("笔记本", &meta.name)
            .line("位置", path.display());
        match self.register_restored(destination, meta) {
            Ok(()) => Outcome::new(TaskStatus::Completed, report),
            Err(e) => Outcome::new(
                TaskStatus::Interrupted,
                report
                    .line(
                        "登记未完成",
                        format!("{}；新库已保存，请勿重复恢复。", e.code),
                    )
                    .action("登记已恢复笔记本", Operation::AttachRestored { path }),
            ),
        }
    }
    pub(super) fn register_restored(
        &self,
        destination: &Path,
        meta: &NotebookMeta,
    ) -> CloudResult<()> {
        let path = destination.join(&meta.id);
        self.queue
            .submit(move |catalog| {
                catalog.refresh_catalog()?;
                catalog.attach_directory(&path)
            })?
            .wait()?;
        Ok(())
    }
    pub(super) fn backup_local(&self, target: &str) -> CloudResult<Outcome> {
        let t = self.local(target)?;
        ensure(!t.notebooks.is_empty(), "NOTEBOOK_SELECTION")?;
        let mut service = LocalBackupService::default();
        let temporary = self.temporary()?;
        let mut report = Report::new(format!("备份分组：{}", t.name));
        let mut status = TaskStatus::Completed;
        for (ix, notebook) in t.notebooks.iter().enumerate() {
            (self.progress)(
                report
                    .clone()
                    .line("进度", format!("{} / {}", ix + 1, t.notebooks.len())),
            );
            let mut observer = Progress {
                progress: self.progress,
                notebook,
            };
            let result = service.backup_observed(
                &t.target,
                self.queue,
                notebook,
                &temporary,
                &self.cancel.storage,
                &NativeVolumes,
                &mut observer,
            );
            report = match result {
                Ok(r) => report.line(
                    notebook,
                    format!(
                        "已提交 · 复制 {} 字节 · {}",
                        r.copied_bytes,
                        if r.pending_cleanup {
                            "旧文件清理待续"
                        } else {
                            "完成"
                        }
                    ),
                ),
                Err(e) => {
                    status = match e.code.as_str() {
                        "CANCELLED" if status != TaskStatus::Failed => TaskStatus::Cancelled,
                        "TARGET_OFFLINE" if status != TaskStatus::Failed => TaskStatus::Interrupted,
                        _ => TaskStatus::Failed,
                    };
                    report.line(notebook, format!("{}：{}", e.code, e.message))
                }
            };
            report = report.action(
                format!("校验 {notebook}"),
                Operation::LocalVerify {
                    target: target.into(),
                    notebook: notebook.clone(),
                },
            );
            if self.cancel.storage.check().is_err() {
                if ix + 1 < t.notebooks.len() {
                    if status != TaskStatus::Failed {
                        status = TaskStatus::Cancelled;
                    }
                    for remaining in &t.notebooks[ix + 1..] {
                        report = report.line(remaining, "未执行（已取消）");
                    }
                }
                break;
            }
        }
        Ok(Outcome::new(status, report))
    }
}
struct Progress<'a> {
    progress: &'a dyn Fn(Report),
    notebook: &'a str,
}
impl Observer for Progress<'_> {
    fn checkpoint(&mut self, point: Checkpoint) -> crate::local_backup::Result<()> {
        let stage = match point {
            Checkpoint::PendingWritten => "已记录备份计划",
            Checkpoint::BeforeFileWrite => "正在复制文件",
            Checkpoint::FilesWritten => "正在校验文件",
            Checkpoint::BeforeManifest => "正在提交备份",
            Checkpoint::ManifestPublished => "备份已提交",
            Checkpoint::BeforeCleanup => "正在清理旧备份文件",
        };
        (self.progress)(Report::new(stage).line("笔记本", self.notebook));
        Ok(())
    }
}
