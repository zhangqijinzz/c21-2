import { useEffect } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  CloudOff,
  Database,
  HardDrive,
  History,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react";
import type {
  BudgetChange,
  HealthIssue,
  HealthReport,
  LayerStatus,
  LoadRepairEvent,
} from "../../shared/domain/health";
import type { HealthBackup } from "../../shared/services/healthBackupService";
import type { FixSummary, LayerSyncDirection } from "./useHealthCheck";

interface Props {
  report: HealthReport | null;
  scanning: boolean;
  fixingId: string;
  fixingAll: boolean;
  syncing: LayerSyncDirection | null;
  lastFix: FixSummary | null;
  backups: HealthBackup[];
  notice: string;
  onScan: () => void;
  onFix: (issue: HealthIssue) => void;
  onFixAll: () => void;
  onSyncLayers: (direction: LayerSyncDirection) => void;
  onRestoreBackup: (id: string) => void;
  onRemoveBackup: (id: string) => void;
  onOpenProject: (id: string, nodeId?: string) => void;
}

const issueKindLabels: Record<HealthIssue["kind"], string> = {
  "dangling-reference": "失效引用",
  "parameter-out-of-range": "参数越界",
  "dependency-cycle": "循环链路",
  "duplicate-node-id": "节点标识重复",
};

const layerStatusLabels: Record<LayerStatus, string> = {
  ready: "可读取",
  empty: "为空",
  damaged: "已损坏",
  unavailable: "不可用",
};

function layerStatusClass(status: LayerStatus): string {
  return status === "ready"
    ? "is-ready"
    : status === "empty"
      ? "is-empty"
      : "is-broken";
}

function formatMs(value: number | null): string {
  if (value === null) return "无法推演";
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function BudgetDeltaRow({ change }: { change: BudgetChange }) {
  const modeLabels: Record<BudgetChange["mode"], string> = {
    low: "乐观",
    expected: "预期",
    high: "保守",
  };
  const delta = change.deltaMs;
  return (
    <div className="budget-delta-row">
      <span>{modeLabels[change.mode]}</span>
      <em>
        {formatMs(change.beforeMs)} → {formatMs(change.afterMs)}
      </em>
      <b
        className={
          delta === null
            ? ""
            : delta < 0
              ? "delta-down"
              : delta > 0
                ? "delta-up"
                : "delta-flat"
        }
      >
        {delta === null
          ? "—"
          : delta === 0
            ? "±0 ms"
            : `${delta > 0 ? "+" : ""}${Math.round(delta)} ms`}
      </b>
    </div>
  );
}

export default function HealthPanel({
  report,
  scanning,
  fixingId,
  fixingAll,
  syncing,
  lastFix,
  backups,
  notice,
  onScan,
  onFix,
  onFixAll,
  onSyncLayers,
  onRestoreBackup,
  onRemoveBackup,
  onOpenProject,
}: Props) {
  useEffect(() => {
    if (!report && !scanning) onScan();
  }, [report, scanning, onScan]);

  const issueCount = report?.issues.length ?? 0;
  const repairCount = report?.loadRepairs.length ?? 0;
  const projectRepairKeys = new Set(
    (report?.projects ?? []).flatMap((project) =>
      project.loadRepairs.map(
        (repair) =>
          `${repair.code}:${repair.projectId ?? ""}:${repair.nodeId ?? ""}`,
      ),
    ),
  );
  const workspaceRepairs = (report?.loadRepairs ?? []).filter(
    (repair) =>
      !projectRepairKeys.has(
        `${repair.code}:${repair.projectId ?? ""}:${repair.nodeId ?? ""}`,
      ),
  );

  return (
    <section className="module-page health-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">06 / WORKSPACE HEALTH</span>
          <h1>工作区体检</h1>
          <p>
            只读扫描两层本地数据，列出可核查的问题；修复前会先留下可回退副本。
          </p>
        </div>
        <button
          className="button button-primary"
          onClick={onScan}
          disabled={scanning}
        >
          {scanning ? (
            <RefreshCw size={15} className="spin" />
          ) : (
            <ScanLine size={15} />
          )}
          {scanning ? "正在扫描…" : "重新扫描"}
        </button>
      </div>

      {notice && <div className="warning-strip">{notice}</div>}

      {!report && (
        <div className="empty-card">
          <Stethoscope size={26} />
          <h3>开始一次体检</h3>
          <p>扫描只读取浏览器数据库与本地恢复副本，不会改动任何原始数据。</p>
        </div>
      )}

      {report && (
        <>
          <div className="health-summary">
            <article className="metric-card">
              <span>
                待修复问题 <AlertTriangle size={16} />
              </span>
              <strong>{String(issueCount).padStart(2, "0")}</strong>
              <small>失效引用 · 参数越界 · 循环链路</small>
            </article>
            <article className="metric-card">
              <span>
                载入时自动修复 <History size={16} />
              </span>
              <strong>{String(repairCount).padStart(2, "0")}</strong>
              <small>发生在过往载入，本次仅核对</small>
            </article>
            <article className="metric-card">
              <span>
                两层一致性{" "}
                {report.layers.consistent ? (
                  <ShieldCheck size={16} />
                ) : (
                  <CloudOff size={16} />
                )}
              </span>
              <strong>{report.layers.consistent ? "一致" : "不一致"}</strong>
              <small>{report.layers.detail}</small>
            </article>
            <article className="metric-card health-action-card">
              <span>
                整体处理 <Wrench size={16} />
              </span>
              <p>逐项修复或一次处理全部问题，每一步都可回退。</p>
              <button
                className="button button-lime"
                onClick={onFixAll}
                disabled={fixingAll || issueCount === 0}
              >
                <Wrench size={14} />
                {fixingAll ? "修复中…" : "整体修复全部问题"}
              </button>
            </article>
          </div>

          <div className="health-layers">
            <h2>两层存储</h2>
            <div className="layer-cards">
              <div
                className={`layer-card ${layerStatusClass(report.layers.indexedDb.status)}`}
              >
                <span className="layer-icon">
                  <Database size={18} />
                </span>
                <div>
                  <strong>浏览器数据库 · IndexedDB</strong>
                  <small>{report.layers.indexedDb.detail}</small>
                  {report.layers.indexedDb.updatedAt && (
                    <em>
                      最近更新 {formatTime(report.layers.indexedDb.updatedAt)}
                    </em>
                  )}
                </div>
                <span className="layer-badge">
                  {layerStatusLabels[report.layers.indexedDb.status]}
                </span>
              </div>
              <div className="layer-link">
                <ArrowLeftRight size={16} />
                <i
                  className={
                    report.layers.consistent ? "is-ready" : "is-broken"
                  }
                />
              </div>
              <div
                className={`layer-card ${layerStatusClass(report.layers.fallback.status)}`}
              >
                <span className="layer-icon">
                  <HardDrive size={18} />
                </span>
                <div>
                  <strong>本地恢复副本 · localStorage</strong>
                  <small>{report.layers.fallback.detail}</small>
                  {report.layers.fallback.updatedAt && (
                    <em>
                      最近更新 {formatTime(report.layers.fallback.updatedAt)}
                    </em>
                  )}
                </div>
                <span className="layer-badge">
                  {layerStatusLabels[report.layers.fallback.status]}
                </span>
              </div>
            </div>
            {!report.layers.consistent && (
              <div className="layer-sync-row">
                <span>两层内容不同步，选择保留哪一份（另一份将被覆盖）：</span>
                <button
                  className="text-action"
                  disabled={
                    syncing !== null ||
                    report.layers.indexedDb.status !== "ready"
                  }
                  onClick={() => onSyncLayers("to-fallback")}
                >
                  {syncing === "to-fallback"
                    ? "同步中…"
                    : "以浏览器数据库为准 →"}
                </button>
                <button
                  className="text-action"
                  disabled={
                    syncing !== null ||
                    report.layers.fallback.status !== "ready"
                  }
                  onClick={() => onSyncLayers("to-indexeddb")}
                >
                  {syncing === "to-indexeddb"
                    ? "写回中…"
                    : "← 以恢复副本为准写回数据库"}
                </button>
              </div>
            )}
          </div>

          {lastFix && (
            <div className="budget-delta-panel">
              <h2>修复后重新推演 · 完成预算变化</h2>
              {lastFix.budgets.map((change) => (
                <BudgetDeltaRow key={change.mode} change={change} />
              ))}
              <small>
                已自动保存修复前副本，可在下方“回退副本”中一键还原。
              </small>
            </div>
          )}

          <div className="health-projects">
            <h2>项目清单</h2>
            {workspaceRepairs.length > 0 && (
              <div className="health-workspace-block">
                <strong>工作区级载入修复</strong>
                <ul className="repair-list">
                  {workspaceRepairs.map((repair) => (
                    <li key={`${repair.code}-${repair.projectId ?? ""}`}>
                      <History size={13} />
                      <span>{repair.detail}</span>
                      <em>载入时自动修复</em>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.projects.map((project) => (
              <div className="health-project-block" key={project.projectId}>
                <div className="health-project-head">
                  <button
                    className="archive-project-name"
                    onClick={() => onOpenProject(project.projectId)}
                  >
                    <i />
                    {project.projectTitle}
                    <em>{project.nodeCount} 节点</em>
                  </button>
                  <span
                    className={`graph-health ${project.issues.length ? "danger" : ""}`}
                  >
                    <i />
                    {project.issues.length
                      ? `${project.issues.length} 项问题`
                      : "检查通过"}
                  </span>
                </div>

                {project.loadRepairs.length > 0 && (
                  <ul className="repair-list">
                    {project.loadRepairs.map((repair: LoadRepairEvent) => (
                      <li key={`${repair.code}-${repair.nodeId ?? ""}`}>
                        <History size={13} />
                        <span>{repair.detail}</span>
                        <em>载入时自动修复</em>
                      </li>
                    ))}
                  </ul>
                )}

                {project.issues.length > 0 && (
                  <ul className="issue-list">
                    {project.issues.map((issue) => (
                      <li key={issue.id} className={issue.severity}>
                        <span className="issue-kind">
                          {issueKindLabels[issue.kind]}
                        </span>
                        <span className="issue-message">{issue.message}</span>
                        <span className="issue-actions">
                          {issue.nodeId && (
                            <button
                              className="text-action"
                              onClick={() =>
                                onOpenProject(project.projectId, issue.nodeId)
                              }
                            >
                              定位节点 ↗
                            </button>
                          )}
                          <button
                            className="button button-neutral issue-fix-button"
                            onClick={() => onFix(issue)}
                            disabled={fixingId === issue.id}
                          >
                            {fixingId === issue.id ? "修复中…" : issue.fixLabel}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          <div className="health-backups">
            <h2>回退副本</h2>
            {backups.length === 0 ? (
              <p className="muted-hint">
                <CheckCircle2 size={14} />{" "}
                还没有修复动作；每次修复前都会自动在此保留一份副本。
              </p>
            ) : (
              <div className="archive-table">
                <div className="archive-table-head">
                  <span>创建时间</span>
                  <span>用途</span>
                  <span>操作</span>
                </div>
                {backups.map((backup) => (
                  <div className="archive-table-row" key={backup.id}>
                    <span>{formatTime(backup.createdAt)}</span>
                    <span>{backup.reason}</span>
                    <span className="archive-actions">
                      <button
                        className="button button-neutral"
                        onClick={() => onRestoreBackup(backup.id)}
                      >
                        <Undo2 size={13} /> 回退
                      </button>
                      <button
                        className="icon-button danger-button"
                        title="删除该副本"
                        aria-label="删除该副本"
                        onClick={() => onRemoveBackup(backup.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="privacy-note">
            <span className="privacy-symbol">⌑</span>
            <span>
              <strong>只读扫描</strong>{" "}
              体检过程不修改浏览器数据库与恢复副本；仅当你确认修复或同步时才写入，且修复前先备份。
            </span>
          </div>
        </>
      )}
    </section>
  );
}
