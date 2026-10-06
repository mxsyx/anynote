import { useState } from "react";
import type { LocalVerificationReport } from "@anynote/types";

/** Display labels for verification statuses. */
const statuses = {
  checking: "正在完整校验",
  passed: "完整校验通过",
  failed: "校验发现异常",
  interrupted: "校验已中断",
};

/** Show a local backup verification report (stats, timing, and a paginated issue list). */
export default function LocalVerificationDetails({
  report,
}: {
  report: LocalVerificationReport;
}) {
  const [limit, setLimit] = useState(50);
  return (
    <section aria-label="备份校验报告">
      <p>
        {statuses[report.status]} · 已检查 {report.checkedFiles}/
        {report.totalFiles} 个文件， 通过 {report.verifiedFiles} 个，发现{" "}
        {report.issues.length} 项异常。
      </p>
      {report.status === "interrupted" && (
        <p role="status">校验未完成，结果仅覆盖已检查文件。</p>
      )}
      {report.finishedAt && (
        <p className="muted">
          校验时间：{new Date(report.finishedAt).toLocaleString("zh-CN")} · 耗时{" "}
          {(report.durationMs / 1000).toFixed(1)} 秒
        </p>
      )}
      {!!report.issues.length && (
        <details>
          <summary>查看文件异常（{report.issues.length} 项）</summary>
          <ul>
            {report.issues.slice(0, limit).map((issue) => (
              <li key={`${issue.path}:${issue.code}`}>
                <p className="local-backup-path">{issue.path}</p>
                <p>
                  {issue.message} <small>（{issue.code}）</small>
                </p>
                {issue.actualSize !== undefined && issue.expected && (
                  <p>
                    预计 {issue.expected.size} 字节，实际 {issue.actualSize}{" "}
                    字节。
                  </p>
                )}
              </li>
            ))}
          </ul>
          {report.issues.length > limit && (
            <button
              className="secondary"
              onClick={() => setLimit((n) => n + 50)}
            >
              再显示 50 项
            </button>
          )}
        </details>
      )}
    </section>
  );
}
