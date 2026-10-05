import { useEffect, useState } from "react";
import {
  Crosshair,
  Database,
  HardDrive,
  Layers,
  Link2Off,
  Repeat,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  BudgetChange,
  HealthIssue,
  HealthIssueKind,
  HealthReport,
  LayerState,
} from "../../shared/domain/health";
import { HEALTH_KIND_ORDER } from "../../shared/domain/health";
import type { LatencyProject } from "../../shared/domain/types";
import type { WorkspaceBackup } from "../../shared/repositories/projectRepository";

interface Props {
  report: HealthReport | null;
  scanning: boolean;
  fixing: boolean;
  budgetChanges: BudgetChange[];
  backup: WorkspaceBackup | null;
  projects: LatencyProject[];
  onScan: () => void;
  onFix: (ids: string[]) => void;
  onFixAll: () => void;
  onRollback: () => void;
  onLocate: (projectId: string) => void;
}

const groupMeta: Record<
  HealthIssueKind,
  { title: string; hint: string; icon: LucideIcon }
> = {
  "layer-divergence": {
    title: "存储层一致性",
    hint: "浏览器数据库与本地恢复副本是否保存着同一份内容",
    icon: Layers,
  },
  "load-repair": {
    title: "载入时自动修复",
    hint: "打开工作区时被静默修复、尚未写回存储的内容",
    icon: Wrench,
  },
  "dangling-reference": {
    title: "失效引用",
    hint: "依赖或降级目标指向了已不存在的节点",
    icon: Link2Off,
  },
  "out-of-range": {
    title: "参数越界",
    hint: "超出允许范围、会导致推演拒绝运行的参数",
    icon: TriangleAlert,
  },
  cycle: {
    title: "循环依赖",
    hint: "链路中首尾相接、无法排定顺序的依赖环",
    icon: Repeat,
  },
};

const layerStateMeta: Record<
  LayerState,
  { label: string; tone: "ok" | "idle" | "warn" | "bad" }
> = {
  ok: { label: "可读取", tone: "ok" },
  empty: { label: "空", tone: "idle" },
  unavailable: { label: "不可用", tone: "bad" },
  invalid: { label: "内容损坏", tone: "warn" },
};

function durationLabel(value: number): string {
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function IssueRow({
  issue,
  locatable,
  disabled,
  onFix,
  onLocate,
}: {
  issue: HealthIssue;
  locatable: boolean;
  disabled: boolean;
  onFix: (ids: string[]) => void;
  onLocate: (projectId: string) => void;
}) {
  return (
    <div className="health-issue">
      <div className="health-issue-locator">
        <span className="health-chip">{issue.projectTitle}</span>
        {issue.nodeName && (
          <span className="health-chip health-chip-node">{issue.nodeName}</span>
        )}
        {locatable && (
          <button
            className="icon-button"
            title={`打开项目 ${issue.projectTitle}`}
            aria-label={`打开项目 ${issue.projectTitle}`}
            onClick={() => onLocate(issue.projectId)}
          >
            <Crosshair size={13} />
          </button>
        )}
      </div>
      <p className="health-issue-message">{issue.message}</p>
      <div className="health-issue-actions">
        {issue.fixable ? (
          <>
            <span className="health-fix-label">{issue.fixLabel}</span>
            <button
              className="button button-neutral health-fix-button"
              disabled={disabled}
              onClick={() => onFix([issue.id])}
            >
              修复
            </button>
          </>
        ) : (
          <span className="health-fix-label health-fix-manual">需手动处理</span>
        )}
      </div>
    </div>
  );
}

export default function HealthPanel({
  report,
  scanning,
  fixing,
  budgetChanges,
  backup,
  projects,
  onScan,
  onFix,
  onFixAll,
  onRollback,
  onLocate,
}: Props) {
  const [confirmRollback, setConfirmRollback] = useState(false);
  useEffect(() => {
    onScan();
  }, [onScan]);

  const issues = report?.issues ?? [];
  const fixableCount = issues.filter((issue) => issue.fixable).length;
  const affectedProjects = new Set(
    issues.map((issue) => issue.projectId).filter(Boolean),
  ).size;
  const projectIds = new Set(projects.map((project) => project.id));
  const bothEmpty =
    report?.layers.primary === "empty" && report?.layers.replica === "empty";

  return (
    <section className="module-page health-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">06 / HEALTH CHECK</span>
          <h1>工作区体检</h1>
          <p>只读扫描两层本地存储与全部项目，修复前自动保留回退副本。</p>
        </div>
        <div className="health-heading-actions">
          <button
            className="button button-neutral"
            onClick={onScan}
            disabled={scanning || fixing}
          >
            <ScanLine size={14} /> {scanning ? "扫描中…" : "重新扫描"}
          </button>
          <button
            className="button button-primary"
            onClick={onFixAll}
            disabled={!fixableCount || scanning || fixing}
          >
            <Wrench size={14} /> 整体修复
            {fixableCount > 0 ? `（${fixableCount}）` : ""}
          </button>
        </div>
      </div>

      {!report && (
        <div className="health-scanning">
          <Stethoscope size={18} />
          {scanning ? "正在扫描工作区…" : "等待扫描"}
        </div>
      )}

      {report && (
        <>
          <div className="health-layers">
            <div className="health-layer">
              <span className="health-layer-icon">
                <Database size={16} />
              </span>
              <div>
                <strong>浏览器数据库</strong>
                <small>IndexedDB 主存储</small>
              </div>
              <em
                className={`health-layer-state state-${layerStateMeta[report.layers.primary].tone}`}
              >
                {layerStateMeta[report.layers.primary].label}
              </em>
            </div>
            <div className="health-layer">
              <span className="health-layer-icon">
                <HardDrive size={16} />
              </span>
              <div>
                <strong>本地恢复副本</strong>
                <small>localStorage 版本化副本</small>
              </div>
              <em
                className={`health-layer-state state-${layerStateMeta[report.layers.replica].tone}`}
              >
                {layerStateMeta[report.layers.replica].label}
              </em>
            </div>
            <div
              className={`health-consistency ${
                bothEmpty
                  ? "tone-idle"
                  : report.consistent === null
                    ? "tone-warn"
                    : report.consistent
                      ? "tone-ok"
                      : "tone-bad"
              }`}
            >
              {bothEmpty
                ? "两层均为空，首次修改后会自动写入。"
                : report.consistent === null
                  ? "一层存储不可用，一致性无法核查；其余检查已基于可用数据完成。"
                  : report.consistent
                    ? "两层内容一致。"
                    : "两层内容不一致，可整体修复对齐。"}
              <span className="health-scan-time">
                扫描于 {timeLabel(report.scannedAt)}
              </span>
            </div>
          </div>

          <div className="health-summary">
            <article className="health-stat">
              <span>发现问题</span>
              <strong>{String(issues.length).padStart(2, "0")}</strong>
              <small>覆盖 {affectedProjects} 个项目</small>
            </article>
            <article className="health-stat">
              <span>可自动修复</span>
              <strong>{String(fixableCount).padStart(2, "0")}</strong>
              <small>逐项或整体修复</small>
            </article>
            <article className="health-stat">
              <span>检查项目</span>
              <strong>{String(projects.length).padStart(2, "0")}</strong>
              <small>
                {projects.reduce(
                  (total, project) => total + project.nodes.length,
                  0,
                )}{" "}
                个请求节点
              </small>
            </article>
            <article className="health-stat">
              <span>回退副本</span>
              <strong>{backup ? "已保留" : "—"}</strong>
              <small>
                {backup
                  ? `创建于 ${timeLabel(backup.savedAt)}`
                  : "修复时自动创建"}
              </small>
            </article>
          </div>

          {issues.length === 0 && (
            <div className="health-empty">
              <span className="health-empty-icon">
                <ShieldCheck size={22} />
              </span>
              <h2>体检通过</h2>
              <p>两层存储与所有项目的引用、参数、链路结构均未发现问题。</p>
            </div>
          )}

          {HEALTH_KIND_ORDER.map((kind) => {
            const group = issues.filter((issue) => issue.kind === kind);
            if (!group.length) return null;
            const meta = groupMeta[kind];
            const Icon = meta.icon;
            return (
              <section className="health-group" key={kind}>
                <div className="health-group-head">
                  <span className="health-group-icon">
                    <Icon size={15} />
                  </span>
                  <div>
                    <h2>{meta.title}</h2>
                    <p>{meta.hint}</p>
                  </div>
                  <em>{group.length} 项</em>
                </div>
                {group.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    locatable={projectIds.has(issue.projectId)}
                    disabled={fixing || scanning}
                    onFix={onFix}
                    onLocate={onLocate}
                  />
                ))}
              </section>
            );
          })}

          {budgetChanges.length > 0 && (
            <section className="health-group">
              <div className="health-group-head">
                <span className="health-group-icon">
                  <ScanLine size={15} />
                </span>
                <div>
                  <h2>修复后完成预算变化</h2>
                  <p>按当前预算假设重新推演受影响项目</p>
                </div>
              </div>
              {budgetChanges.map((change) => {
                const delta =
                  change.beforeMs !== null && change.afterMs !== null
                    ? change.afterMs - change.beforeMs
                    : null;
                return (
                  <div className="health-budget-row" key={change.projectId}>
                    <span className="health-chip">{change.title}</span>
                    <span className="health-budget-values">
                      {change.beforeMs === null
                        ? "无法推演"
                        : durationLabel(change.beforeMs)}
                      <b>→</b>
                      {change.afterMs === null
                        ? "仍无法推演"
                        : durationLabel(change.afterMs)}
                    </span>
                    <em
                      className={`health-budget-delta ${
                        delta === null
                          ? "tone-idle"
                          : delta < 0
                            ? "tone-ok"
                            : delta > 0
                              ? "tone-bad"
                              : "tone-idle"
                      }`}
                    >
                      {delta === null
                        ? change.beforeMs === null && change.afterMs !== null
                          ? "恢复可推演"
                          : "—"
                        : delta === 0
                          ? "预算不变"
                          : `${delta < 0 ? "↓" : "↑"} ${durationLabel(Math.abs(delta))}`}
                    </em>
                  </div>
                );
              })}
            </section>
          )}

          {backup && (
            <div className="health-backup">
              <span>
                <RotateCcw size={14} />
                回退副本创建于 {timeLabel(backup.savedAt)}
                ，包含修复前的工作区内容。
              </span>
              <button
                className="button button-neutral"
                disabled={fixing}
                onClick={() => setConfirmRollback(true)}
              >
                回退到修复前
              </button>
            </div>
          )}
        </>
      )}

      {confirmRollback && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rollback-health-title"
          >
            <span className="dialog-icon">
              <RotateCcw size={18} />
            </span>
            <h2 id="rollback-health-title">回退到修复前的工作区？</h2>
            <p>
              当前工作区将被 {backup ? timeLabel(backup.savedAt) : ""}{" "}
              创建的副本覆盖，此操作会立即保存。
            </p>
            <div>
              <button
                className="button button-neutral"
                onClick={() => setConfirmRollback(false)}
              >
                取消
              </button>
              <button
                className="button button-danger"
                onClick={() => {
                  onRollback();
                  setConfirmRollback(false);
                }}
              >
                回退工作区
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
