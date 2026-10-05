import { useCallback, useMemo, useState } from "react";
import type { ProjectRepository } from "../../shared/repositories/projectRepository";
import {
  applyAllFixes,
  applyFix,
  measureBudgets,
  scanWorkspace,
  type BudgetChange,
  type HealthIssue,
  type HealthReport,
  type LoadRepairEvent,
} from "../../shared/domain/health";
import {
  HealthBackupService,
  type HealthBackup,
} from "../../shared/services/healthBackupService";
import type { WorkspaceDocument } from "../../shared/domain/types";

export interface FixSummary {
  fixedIds: string[];
  changedProjectIds: string[];
  budgets: BudgetChange[];
  backupId: string;
}

export type LayerSyncDirection = "to-fallback" | "to-indexeddb";

interface UseHealthCheckOptions {
  repository: ProjectRepository;
  /** 当前主文档（仅用于触发重新扫描；修复动作内部以传入的最新文档为准）。 */
  document: WorkspaceDocument | null;
  /** 修复/回退后把新文档交回主编排持久化（IndexedDB + 恢复副本一起写），返回保存结果。 */
  onCommit: (document: WorkspaceDocument) => Promise<void>;
}

function uniqueLoadRepairs(groups: LoadRepairEvent[][]): LoadRepairEvent[] {
  const seen = new Set<string>();
  const result: LoadRepairEvent[] = [];
  for (const group of groups) {
    for (const event of group) {
      const key = [event.code, event.projectId ?? "", event.nodeId ?? ""].join(
        "|",
      );
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(event);
    }
  }
  return result;
}

function describeLayers(
  indexedDbStatus: HealthReport["layers"]["indexedDb"]["status"],
  fallbackStatus: HealthReport["layers"]["fallback"]["status"],
  consistent: boolean,
): string {
  if (consistent) return "浏览器数据库与本地恢复副本内容一致";
  if (indexedDbStatus === "unavailable")
    return "浏览器数据库不可用，本次体检仅基于本地恢复副本完成";
  if (indexedDbStatus === "ready" && fallbackStatus === "ready")
    return "两层都可读取，但项目内容不一致";
  if (indexedDbStatus === "ready" && fallbackStatus !== "ready")
    return "仅浏览器数据库可用，恢复副本缺失或损坏";
  if (indexedDbStatus !== "ready" && fallbackStatus === "ready")
    return "仅本地恢复副本可用，浏览器数据库缺失或损坏";
  return "两层存储都无法读取";
}

export function useHealthCheck({
  repository,
  document,
  onCommit,
}: UseHealthCheckOptions) {
  const backupsService = useMemo(() => new HealthBackupService(), []);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [fixingId, setFixingId] = useState("");
  const [fixingAll, setFixingAll] = useState(false);
  const [syncing, setSyncing] = useState<LayerSyncDirection | null>(null);
  const [lastFix, setLastFix] = useState<FixSummary | null>(null);
  const [backups, setBackups] = useState<HealthBackup[]>(() =>
    backupsService.list(),
  );
  const [notice, setNotice] = useState("");

  /** 只读扫描。targetDocument 缺省时扫描当前主文档；修复后传入新文档避免闭包旧值。 */
  const scan = useCallback(
    async (targetDocument?: WorkspaceDocument) => {
      const scanTarget = targetDocument ?? document;
      if (!scanTarget) return;
      setScanning(true);
      setNotice("");
      try {
        const layers = await repository.readLayers();
        const consistent =
          layers.indexedDb.status === "ready" &&
          layers.fallback.status === "ready" &&
          JSON.stringify(layers.indexedDb.document) ===
            JSON.stringify(layers.fallback.document);
        const layerInfo = {
          indexedDb: layers.indexedDb,
          fallback: layers.fallback,
          consistent,
          detail: describeLayers(
            layers.indexedDb.status,
            layers.fallback.status,
            consistent,
          ),
        };
        const loadRepairs = uniqueLoadRepairs([
          layers.indexedDb.repairs,
          layers.fallback.repairs,
        ]);
        setReport(
          scanWorkspace(structuredClone(scanTarget), layerInfo, loadRepairs),
        );
      } finally {
        setScanning(false);
      }
    },
    [document, repository],
  );

  const buildFixSummary = useCallback(
    (
      before: WorkspaceDocument,
      after: WorkspaceDocument,
      fixedIds: string[],
      backupId: string,
    ): FixSummary => {
      const changedProjectIds = new Set<string>();
      for (const id of fixedIds) {
        const projectId = id.split(":")[1];
        if (projectId) changedProjectIds.add(projectId);
      }
      return {
        fixedIds,
        changedProjectIds: [...changedProjectIds],
        budgets: measureBudgets(before, after, changedProjectIds),
        backupId,
      };
    },
    [],
  );

  const fixIssue = useCallback(
    async (issue: HealthIssue) => {
      const before = document;
      if (!before) return;
      setFixingId(issue.id);
      const after = applyFix(before, issue.id);
      if (after === before) {
        setNotice("该问题已不存在，无需修复。");
        return;
      }
      try {
        const backup = backupsService.create(
          before,
          `修复前备份：${issue.message}`,
        );
        await onCommit(after);
        setLastFix(buildFixSummary(before, after, [issue.id], backup.id));
        setBackups(backupsService.list());
        setNotice(`已修复：${issue.message}`);
        await scan(after);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? `操作失败，已取消修复：${error.message}`
            : "操作失败，已取消修复",
        );
      } finally {
        setFixingId("");
      }
    },
    [backupsService, buildFixSummary, document, onCommit, scan],
  );

  const fixAll = useCallback(async () => {
    const before = document;
    if (!before) return;
    const { document: after, fixedIds } = applyAllFixes(before);
    if (!fixedIds.length) {
      setNotice("没有需要修复的问题。");
      return;
    }
    setFixingAll(true);
    try {
      const backup = backupsService.create(before, "整体修复前备份");
      await onCommit(after);
      setLastFix(buildFixSummary(before, after, fixedIds, backup.id));
      setBackups(backupsService.list());
      setNotice(`已整体修复 ${fixedIds.length} 项问题。`);
      await scan(after);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `操作失败，已取消整体修复：${error.message}`
          : "操作失败，已取消整体修复",
      );
    } finally {
      setFixingAll(false);
    }
  }, [backupsService, buildFixSummary, document, onCommit, scan]);

  const syncLayers = useCallback(
    async (direction: LayerSyncDirection) => {
      if (!document) return;
      setSyncing(direction);
      setLastFix(null);
      try {
        if (direction === "to-fallback") {
          repository.writeFallback(document);
          setNotice("已用浏览器数据库覆盖本地恢复副本。");
        } else {
          await repository.save(document);
          setNotice("已用当前工作区写回浏览器数据库。");
        }
        await scan(document);
      } catch (error) {
        setNotice(
          error instanceof Error ? `同步失败：${error.message}` : "同步失败",
        );
      } finally {
        setSyncing(null);
      }
    },
    [document, repository, scan],
  );

  const restoreBackup = useCallback(
    async (backupId: string) => {
      const restored = backupsService.restore(backupId);
      if (!restored) {
        setNotice("该副本无法读取，可能已损坏。");
        return;
      }
      try {
        await onCommit(restored);
        setLastFix(null);
        setNotice("已回退到修复前的副本，已重新推演。");
        await scan(restored);
      } catch (error) {
        setNotice(
          error instanceof Error ? `回退失败：${error.message}` : "回退失败",
        );
      }
    },
    [backupsService, onCommit, scan],
  );

  const removeBackup = useCallback(
    (backupId: string) => {
      backupsService.remove(backupId);
      setBackups(backupsService.list());
    },
    [backupsService],
  );

  return {
    report,
    scanning,
    fixingId,
    fixingAll,
    syncing,
    lastFix,
    backups,
    notice,
    setNotice,
    scan,
    fixIssue,
    fixAll,
    syncLayers,
    restoreBackup,
    removeBackup,
  };
}
