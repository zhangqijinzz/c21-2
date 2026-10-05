import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import type { LayerSnapshot, ProjectRepairRecord } from "../domain/health";
import { IndexedDbService } from "../services/indexedDbService";

const FALLBACK_KEY = "latency-lab.workspace.v1";
const BACKUP_KEY = "latency-lab.workspace.backup.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNode(value: unknown): RequestNode | undefined {
  if (!isRecord(value)) return undefined;
  const {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds,
    timeoutMs,
    retryCount,
    failureRate,
    fallbackNodeId,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !Array.isArray(dependencyIds)
  )
    return undefined;
  if (
    !isFiniteNumber(durationMs) ||
    !isFiniteNumber(jitterMs) ||
    !isFiniteNumber(timeoutMs) ||
    !isFiniteNumber(retryCount) ||
    !isFiniteNumber(failureRate)
  )
    return undefined;
  return {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds: dependencyIds.filter(
      (id): id is string => typeof id === "string",
    ),
    timeoutMs,
    retryCount,
    failureRate,
    ...(typeof fallbackNodeId === "string" ? { fallbackNodeId } : {}),
  };
}

function parseScenario(value: unknown): ScenarioSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.criticalPath)
  )
    return undefined;
  const { id, name, createdAt, concurrencyLimit, completionMs } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof createdAt !== "number" ||
    typeof completionMs !== "number"
  )
    return undefined;
  return {
    id,
    name,
    createdAt,
    completionMs,
    concurrencyLimit:
      typeof concurrencyLimit === "number" && concurrencyLimit > 0
        ? concurrencyLimit
        : null,
    nodes: value.nodes
      .map(parseNode)
      .filter((node): node is RequestNode => Boolean(node)),
    criticalPath: value.criticalPath.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function parseProject(
  value: unknown,
): { project: LatencyProject; repairs: string[] } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return undefined;
  const repairs: string[] = [];
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  if (!Array.isArray(value.nodes)) repairs.push("节点列表损坏，已按空链路恢复");
  const parsedNodes = sourceNodes.map(parseNode);
  const nodes = parsedNodes.filter((node): node is RequestNode =>
    Boolean(node),
  );
  if (nodes.length !== sourceNodes.length)
    repairs.push(`丢弃了 ${sourceNodes.length - nodes.length} 个损坏的节点`);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const safeNodes = nodes.map((node) => {
    const dependencyIds = node.dependencyIds.filter(
      (id) => id !== node.id && nodeIds.has(id),
    );
    const validFallback =
      node.fallbackNodeId &&
      node.fallbackNodeId !== node.id &&
      nodeIds.has(node.fallbackNodeId)
        ? node.fallbackNodeId
        : undefined;
    if (dependencyIds.length !== node.dependencyIds.length)
      repairs.push(
        `「${node.name}」移除了 ${node.dependencyIds.length - dependencyIds.length} 条失效前置依赖`,
      );
    if (validFallback !== node.fallbackNodeId)
      repairs.push(`「${node.name}」清除了失效的降级目标`);
    return {
      ...node,
      dependencyIds,
      ...(validFallback
        ? { fallbackNodeId: validFallback }
        : { fallbackNodeId: undefined }),
    };
  });
  const scenarioSource = Array.isArray(value.scenarios) ? value.scenarios : [];
  const scenarios = scenarioSource
    .map(parseScenario)
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  if (!Array.isArray(value.scenarios))
    repairs.push("方案快照列表损坏，已按空列表恢复");
  else if (scenarios.length !== scenarioSource.length)
    repairs.push(
      `丢弃了 ${scenarioSource.length - scenarios.length} 个损坏的方案快照`,
    );
  const rawLimit = value.concurrencyLimit;
  let concurrencyLimit: number | null = null;
  if (
    typeof rawLimit === "number" &&
    Number.isFinite(rawLimit) &&
    rawLimit > 0
  ) {
    concurrencyLimit = Math.floor(rawLimit);
    if (!Number.isInteger(rawLimit)) repairs.push("并发上限已取整");
  } else if (rawLimit !== undefined && rawLimit !== null) {
    repairs.push("并发上限无效，已重置为不限");
  }
  const now = Date.now();
  const project: LatencyProject = {
    id: value.id,
    title: value.title,
    nodes: safeNodes,
    concurrencyLimit,
    scenarios,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
  return { project, repairs };
}

interface WorkspaceParse {
  document: WorkspaceDocument;
  recovered: boolean;
  repairs: ProjectRepairRecord[];
}

function parseWorkspace(value: unknown): WorkspaceParse | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects))
    return undefined;
  const sourceProjects: unknown[] = value.projects;
  const parsed = sourceProjects.map(parseProject);
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; repairs: string[] } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  const repairs: ProjectRepairRecord[] = [];
  parsed.forEach((entry, index) => {
    if (entry) {
      if (entry.repairs.length)
        repairs.push({
          projectId: entry.project.id,
          projectTitle: entry.project.title,
          repairs: entry.repairs,
        });
      return;
    }
    const source: unknown = sourceProjects[index];
    repairs.push({
      projectId:
        isRecord(source) && typeof source.id === "string"
          ? source.id
          : `damaged-${index}`,
      projectTitle:
        isRecord(source) && typeof source.title === "string"
          ? source.title
          : "（无法识别的项目）",
      repairs: ["项目数据损坏，载入时已跳过"],
    });
  });
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => (entry?.repairs.length ?? 0) > 0);
  return {
    document: { version: 1, activeProjectId, projects },
    recovered,
    repairs,
  };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  write(value: WorkspaceDocument): Promise<void>;
}

export interface WorkspaceBackup {
  savedAt: number;
  document: WorkspaceDocument;
}

export class ProjectRepository {
  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<{ document: WorkspaceDocument; recovered: boolean }> {
    try {
      const stored = parseWorkspace(await this.storage.read());
      if (stored) return stored;
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) {
        try {
          const fallback = parseWorkspace(JSON.parse(local) as unknown);
          if (fallback) return { ...fallback, recovered: true };
        } catch {
          localStorage.removeItem(FALLBACK_KEY);
        }
      }
    } catch {
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) {
        try {
          const fallback = parseWorkspace(JSON.parse(local) as unknown);
          if (fallback) return { ...fallback, recovered: true };
        } catch {
          localStorage.removeItem(FALLBACK_KEY);
        }
      }
    }
    return {
      document: {
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      },
      recovered: true,
    };
  }

  async save(document: WorkspaceDocument): Promise<void> {
    let indexedDbError: unknown;
    try {
      await this.storage.write(document);
    } catch (error) {
      indexedDbError = error;
    }
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(document));
    } catch (error) {
      if (!indexedDbError) throw error;
    }
    if (indexedDbError) throw indexedDbError;
  }

  /**
   * 只读体检：分别读取两层存储并解析，不写入、不清理任何数据。
   * 浏览器数据库不可用时仍然返回恢复副本一侧的结果。
   */
  async inspect(): Promise<{ primary: LayerSnapshot; replica: LayerSnapshot }> {
    const [primary, replica] = await Promise.all([
      this.inspectLayer(() => this.storage.read()),
      this.inspectLayer(() => {
        if (typeof localStorage === "undefined")
          throw new Error("本地恢复副本不可用");
        return Promise.resolve(localStorage.getItem(FALLBACK_KEY));
      }),
    ]);
    return { primary, replica };
  }

  private async inspectLayer(
    read: () => Promise<unknown>,
  ): Promise<LayerSnapshot> {
    let raw: unknown;
    try {
      raw = await read();
    } catch (error) {
      return {
        state: "unavailable",
        detail: error instanceof Error ? error.message : "读取失败",
      };
    }
    if (raw === null || raw === undefined) return { state: "empty" };
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        return { state: "invalid", detail: "内容不是有效的 JSON" };
      }
    }
    const parsed = parseWorkspace(value);
    if (!parsed) return { state: "invalid", detail: "工作区结构不完整" };
    return {
      state: "ok",
      document: parsed.document,
      repairs: parsed.repairs,
    };
  }

  /** 修复前留档：把当前工作区写入独立的回退副本。 */
  async saveBackup(document: WorkspaceDocument): Promise<WorkspaceBackup> {
    const backup: WorkspaceBackup = {
      savedAt: Date.now(),
      document: structuredClone(document),
    };
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
    return backup;
  }

  async loadBackup(): Promise<WorkspaceBackup | null> {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || typeof value.savedAt !== "number") return null;
      const parsed = parseWorkspace(value.document);
      if (!parsed) return null;
      return { savedAt: value.savedAt, document: parsed.document };
    } catch {
      return null;
    }
  }

  async clearBackup(): Promise<void> {
    try {
      localStorage.removeItem(BACKUP_KEY);
    } catch {
      // 回退副本清理失败不影响主流程
    }
  }
}
