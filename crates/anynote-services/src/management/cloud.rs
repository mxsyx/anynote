use super::*;
impl Manager<'_> {
    pub(super) async fn execute_cloud(&mut self, operation: Operation) -> CloudResult<Outcome> {
        use Operation::*;
        let cancel = &self.cancel.network;
        let report = match operation {
            SaveConnection {
                name,
                endpoint,
                token,
            } => {
                let token = zeroize::Zeroizing::new(token);
                let connection = RecoveryConnection {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    endpoint,
                    allow_insecure: false,
                };
                // Test before persisting so permission errors remain actionable in the form.
                CloudClient::new(connection.clone(), &token)?
                    .test(cancel)
                    .await?;
                save_recovery_connection(&self.state, self.vault, connection.clone(), &token)?;
                Report::new("云连接已保存，令牌保存在系统凭据库。").line("连接", connection.name)
            }
            TestConnection { connection } => {
                let caps = self.client(&connection)?.test(cancel).await?;
                Report::new("云连接可用").line(
                    "采集设备",
                    if caps.has("capture-v1") {
                        "支持"
                    } else {
                        "当前服务不支持；备份仍可使用"
                    },
                )
            }
            Discover { connection, cursor } => {
                let page = self
                    .client(&connection)?
                    .discover(cursor.as_deref(), cancel)
                    .await?;
                let mut r = Report::new(format!("找到 {} 个云备份版本", page.backups.len()));
                for b in page.backups {
                    r = r
                        .line(
                            format!("{} · {}", b.name, b.created_at),
                            format!("{} 字节 · 版本 {}", b.database_bytes, b.snapshot_seq),
                        )
                        .action(
                            format!("恢复 {} · {}…", b.name, b.created_at),
                            CloudRestore {
                                connection: connection.clone(),
                                notebook: b.notebook_id,
                                lineage: b.lineage_id,
                                generation: b.id,
                                destination: PathBuf::new(),
                            },
                        );
                }
                for w in page.warnings {
                    r = r.line("提示", w);
                }
                if let Some(cursor) = page.cursor {
                    r = r.action(
                        "下一页云备份",
                        Discover {
                            connection,
                            cursor: Some(cursor),
                        },
                    );
                }
                r
            }
            AddCloud {
                connection,
                notebook,
                interval_minutes,
            } => {
                ensure(
                    (1..=43_200).contains(&interval_minutes)
                        && self.settings.local.len() + self.settings.cloud.len() < 100,
                    "TARGET_INPUT",
                )?;
                let client = self.client(&connection)?;
                client.test(cancel).await?;
                let c = recovery_connections(&self.state)?
                    .into_iter()
                    .find(|c| c.id == connection)
                    .ok_or_else(|| CloudError::new("CONNECTION_NOT_FOUND"))?;
                let id = notebook.clone();
                let (revision, name) = self
                    .queue
                    .submit(move |s| {
                        let b = s.notebook(&id)?;
                        Ok((b.lease_revision()?, b.read().metadata().name.clone()))
                    })?
                    .wait()?;
                ensure(
                    self.settings.cloud.iter().all(|t| {
                        t.identity.connection_id != connection || t.identity.notebook_id != notebook
                    }),
                    "TARGET_ALREADY_EXISTS",
                )?;
                let device_key = "management.device.id";
                let device = match self.state.read(device_key)? {
                    Some(b) => serde_json::from_slice(&b)?,
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        self.state.write(device_key, &serde_json::to_vec(&id)?)?;
                        id
                    }
                };
                let target = CloudTarget {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    identity: TransferIdentity {
                        connection_id: connection,
                        endpoint: c.endpoint,
                        notebook_id: notebook,
                        lineage_id: revision.lineage_id,
                        direction: Direction::Upload,
                        writer: Some(WriterIdentity {
                            device_id: device,
                            epoch: 1,
                        }),
                    },
                    interval_minutes,
                    paused: true,
                };
                target.identity.validate()?;
                let id = target.id.clone();
                self.settings.cloud.push(target);
                self.save()?;
                self.configure(&id)?;
                Report::new(
                    "云备份目标已保存，自动备份默认暂停。已有云端写入设备时，请先查看并明确接管。",
                )
                .action("立即备份", CloudBackup { target: id.clone() })
                .action("查看写入设备", WriterPreview { target: id })
            }
            CloudBackup { target } => self.backup_cloud(&target).await?,
            CloudRestore {
                connection,
                notebook,
                lineage,
                generation,
                destination,
            } => {
                ensure(
                    destination.is_absolute() && destination.is_dir(),
                    "RESTORE_DESTINATION",
                )?;
                let c = recovery_connections(&self.state)?
                    .into_iter()
                    .find(|c| c.id == connection)
                    .ok_or_else(|| CloudError::new("CONNECTION_NOT_FOUND"))?;
                let client = CloudClient::from_vault(c.clone(), self.vault)?;
                let identity = TransferIdentity {
                    connection_id: connection,
                    endpoint: c.endpoint,
                    notebook_id: notebook,
                    lineage_id: lineage,
                    direction: Direction::Download,
                    writer: None,
                };
                let mut session = TransferSession::open(self.directory, identity)?;
                let meta =
                    restore(&client, &mut session, &generation, &destination, cancel).await?;
                return Ok(self.restored_outcome(&destination, &meta));
            }
            Devices { connection } => {
                let devices = self.client(&connection)?.capture_devices(cancel).await?;
                let mut r = Report::new(format!("{} 台采集设备", devices.len()));
                for d in devices {
                    r = r.line(
                        &d.id,
                        format!(
                            "笔记本 {} · {} · 到期 {}",
                            d.notebook_id,
                            if d.revoked == 0 {
                                "可用"
                            } else {
                                "已撤销"
                            },
                            d.expires_at
                        ),
                    );
                    if d.revoked == 0 {
                        r = r.action(
                            format!("撤销 {}…", d.id),
                            RevokeDevice {
                                connection: connection.clone(),
                                device: d.id,
                            },
                        );
                    }
                }
                r
            }
            RevokeDevice { connection, device } => {
                let client = self.client(&connection)?;
                ensure(
                    client
                        .capture_devices(cancel)
                        .await?
                        .iter()
                        .any(|d| d.id == device && d.revoked == 0),
                    "DEVICE_CHANGED",
                )?;
                client.revoke_capture_device(&device, cancel).await?;
                Report::new("设备采集权限已撤销")
            }
            RetentionSave {
                target,
                keep,
                days,
                weeks,
                months,
            } => {
                self.cloud(&target)?;
                save_remote_retention(
                    &self.state,
                    &target,
                    &RetentionPolicy {
                        keep,
                        calendar: CalendarRetention {
                            daily_days: days,
                            weekly_weeks: weeks,
                            monthly_months: months,
                        },
                    },
                )?;
                Report::new("保留策略已保存。执行清理前仍需预览并确认。")
            }
            other => self.cloud_target_operation(other).await?,
        };
        Ok(Outcome::new(TaskStatus::Completed, report))
    }
    async fn cloud_target_operation(&mut self, operation: Operation) -> CloudResult<Report> {
        use Operation::*;
        let target = match &operation {
            CloudStatus { target }
            | WriterPreview { target }
            | WriterTakeover { target, .. }
            | WriterResume { target }
            | RetentionPreview { target }
            | RetentionApply { target, .. }
            | RetentionResume { target }
            | RetentionRecover { target, .. }
            | Maintenance { target }
            | ReleaseLegacyLock { target, .. }
            | PairDevice { target }
            | ConsumeCaptures { target } => target.clone(),
            _ => return Err(CloudError::new("INVALID_OPERATION")),
        };
        let t = self.cloud(&target)?;
        let client = self.client(&t.identity.connection_id)?;
        let mut session = TransferSession::open(self.directory, t.identity.clone())?;
        let cancel = &self.cancel.network;
        Ok(match operation {
            CloudStatus { .. } => {
                let c = session.cursor()?;
                let mut r = Report::new("云备份本机状态")
                    .line("最后确认的版本", &c.last_generation)
                    .line("已确认序号", c.last_ack_seq)
                    .line(
                        "待确认版本",
                        c.pending_generation.as_deref().unwrap_or("无"),
                    );
                if c.pending_generation.is_some() {
                    r = r.action(
                        "核对并继续上传",
                        CloudBackup {
                            target: target.clone(),
                        },
                    );
                }
                if pending_takeover(&session)?.is_some() {
                    r = r.action(
                        "核对接管结果",
                        WriterResume {
                            target: target.clone(),
                        },
                    );
                }
                if let Some(p) = pending_retention(&session)? {
                    r = r.line("清理计划", format!("{} · {:?}", p.plan_id, p.phase));
                    if p.phase != RetentionPhase::Planned {
                        r = r.action("继续已确认清理", RetentionResume { target });
                    }
                }
                r
            }
            WriterPreview { .. } => {
                let w = remote_writer(&client, &session, cancel).await?;
                let mut r = Report::new(if w.owns(&t.identity) {
                    "本设备拥有云端写入权限"
                } else {
                    "其他设备拥有云端写入权限"
                })
                .line("设备", &w.device_id)
                .line("版本", w.writer_epoch)
                .line("最新备份", &w.head);
                if !w.owns(&t.identity) {
                    r = r.action(
                        "接管云端写入…",
                        WriterTakeover {
                            target,
                            head: w.head,
                            epoch: w.writer_epoch,
                            request: uuid::Uuid::new_v4().to_string(),
                        },
                    );
                }
                r
            }
            WriterTakeover {
                head,
                epoch,
                request,
                ..
            } => {
                let outcome = takeover_writer(
                    &client,
                    &mut session,
                    &TakeoverRequest {
                        request_id: request,
                        expected_head: head,
                        expected_writer_epoch: epoch,
                    },
                    true,
                    cancel,
                )
                .await?;
                self.rebind_writer(&target, outcome)?
            }
            WriterResume { .. } => {
                let outcome = resume_takeover(&client, &mut session, cancel).await?;
                self.rebind_writer(&target, outcome)?
            }
            RetentionPreview { .. } => {
                let policy = remote_retention_policy(&self.state, &target)?;
                let p = preview_retention(&client, &mut session, &policy, cancel).await?;
                let mut r = Report::new(format!(
                    "计划删除 {} 个版本，预计释放 {} 字节；保护 {} 个版本，宽限 {} 小时。",
                    p.remove.len(),
                    p.reclaim_bytes,
                    p.protected.len(),
                    p.grace_hours
                ));
                for v in p.remove.iter().take(200) {
                    r = r.line(&v.id, format!("{} · {}", v.created_at, v.status));
                }
                if p.remove.len() > 200 {
                    r = r.line(
                        "其余版本",
                        format!(
                            "另有 {} 个版本；请缩小保留策略后重新预览。",
                            p.remove.len() - 200
                        ),
                    );
                } else {
                    r = r.action("执行此清理计划…", RetentionApply { target, plan: p.id });
                }
                r
            }
            RetentionApply { plan, .. } => retention_report(
                &target,
                apply_retention(&client, &mut session, &plan, true, cancel).await?,
            ),
            RetentionResume { .. } => retention_report(
                &target,
                resume_retention(&client, &mut session, cancel).await?,
            ),
            RetentionRecover { plan, .. } => retention_report(
                &target,
                recover_retention(&client, &mut session, &plan, true, cancel).await?,
            ),
            Maintenance { .. } => {
                let d = maintenance_diagnostics(&client, &session, cancel).await?;
                let state = remote_retention_state(&client, &session, cancel).await?;
                let mut r = Report::new(if d.notebook_locked {
                    "云端维护进行中"
                } else {
                    "云端当前未锁定"
                });
                if let Some(p) = state.active_plan {
                    r = r.line("活动计划", &p.id).action(
                        "恢复维护任务…",
                        RetentionRecover {
                            target: target.clone(),
                            plan: p.id,
                        },
                    );
                }
                if let Some(p) = d.plan {
                    r = r
                        .line("已处理对象", p.object_cursor)
                        .line("已处理版本", p.generation_cursor);
                    if d.legacy_lock
                        && p.execution_owner.is_none()
                        && let Some(execution) = p.execution_id
                    {
                        r = r.action(
                            "确认旧请求停止并释放锁…",
                            ReleaseLegacyLock {
                                target,
                                plan: p.id,
                                execution,
                            },
                        );
                    }
                }
                r
            }
            ReleaseLegacyLock {
                plan, execution, ..
            } => {
                release_legacy_maintenance_lock(&client, &session, &plan, &execution, true, cancel)
                    .await?;
                Report::new("旧维护锁已释放")
            }
            PairDevice { .. } => {
                let p = client
                    .pair_capture_device(&t.identity.notebook_id, &t.identity.lineage_id, cancel)
                    .await?;
                Report::new("在采集扩展中输入配对码；到期后请重新生成。")
                    .line("配对码", p.code)
                    .line("到期时间", p.expires_at)
            }
            ConsumeCaptures { .. } => {
                let count = consume_captures(
                    &client,
                    &session,
                    self.queue,
                    &t.identity.notebook_id,
                    &self.temporary()?,
                    cancel,
                )
                .await?;
                Report::new(format!(
                    "已接收 {count} 项采集内容。云备份提交后才会标为已备份。"
                ))
            }
            _ => return Err(CloudError::new("INVALID_OPERATION")),
        })
    }
    fn rebind_writer(&mut self, target: &str, outcome: TakeoverOutcome) -> CloudResult<Report> {
        let t = self
            .settings
            .cloud
            .iter_mut()
            .find(|t| t.id == target)
            .ok_or_else(|| CloudError::new("TARGET_NOT_FOUND"))?;
        t.identity = outcome.identity;
        t.paused = true;
        self.save()?;
        self.configure(target)?;
        Ok(Report::new(
            "云端写入已由本设备接管。自动备份保持暂停，可核对后手动启用。",
        ))
    }
    pub(super) async fn backup_cloud(&self, target: &str) -> CloudResult<Report> {
        let t = self.cloud(target)?;
        let client = self.client(&t.identity.connection_id)?;
        let mut session = TransferSession::open(self.directory, t.identity.clone())?;
        if session.cursor()?.pending_generation.is_none() {
            (self.progress)(Report::new("正在捕获云备份切面"));
            let caps = client.test(&self.cancel.network).await?;
            let pending = if caps.has("capture-v1") {
                client
                    .pending_capture_acks(
                        &t.identity.notebook_id,
                        &t.identity.lineage_id,
                        &self.cancel.network,
                    )
                    .await?
            } else {
                Vec::new()
            };
            let temporary = self.temporary()?;
            let notebook = t.identity.notebook_id.clone();
            let cancel = self.cancel.storage.clone();
            let mut frozen = self
                .queue
                .submit(move |s| s.capture_snapshot(&notebook, &temporary, &cancel))?
                .wait()?;
            let head = session.cursor()?.last_generation;
            let now: chrono::DateTime<chrono::Utc> = std::time::SystemTime::now().into();
            prepare_upload_with_projection(
                &mut session,
                &mut frozen,
                &head,
                &now.to_rfc3339(),
                UploadProjection {
                    browse: caps.has("browse-snapshot-v1"),
                    captures: caps.has("capture-v1").then_some(&pending),
                },
                &self.cancel.storage,
            )?;
        }
        (self.progress)(Report::new("正在上传并核对云端提交结果"));
        let cursor = resume_upload(&client, &mut session, &self.cancel.network).await?;
        Ok(Report::new("云备份已确认提交")
            .line("版本", cursor.last_generation)
            .line("序号", cursor.last_ack_seq))
    }
}
fn retention_report(target: &str, p: RetentionProgress) -> Report {
    let r = Report::new(if p.completed {
        "云端清理已完成"
    } else {
        "本批次清理已完成，仍有剩余内容"
    })
    .line("计划", p.plan_id)
    .line("释放字节", p.reclaimed_bytes.unwrap_or(0))
    .line("处理版本", p.processed_generations.unwrap_or(0));
    if p.completed {
        r
    } else {
        r.action(
            "继续已确认的清理",
            Operation::RetentionResume {
                target: target.into(),
            },
        )
    }
}
