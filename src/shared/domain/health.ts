import { analyzeGraph } from "./graph";
import { simulateProject } from "./simulation";
import type {
  LatencyProject,
  RequestNode,
  SimulationMode,
  WorkspaceDocument,
} from "./types";

/** 载入解析阶段自动完成的修复记录（parseWorkspace 产生，体检时只读展示）。 */
export interface LoadRepairEvent {
  code:
    | "node-dropped"
    | "dangling-dependency"
    | "self-dependency"
    | "dangling-fallback"
    | "self-fallback"
    | "scenario-dropped"
    | "project-dropped"
    | "active-reset"
    | "concurrency-normalized"
    | "timestamp-normalized";
  projectId?: string;
  projectTitle?: string;
  nodeId?: string;
  detail: string;
}

export function createLoadRepair(
  event: Omit<LoadRepairEvent, "detail">,
): LoadRepairEvent {
  const where = event.projectTitle ?? event.projectId ?? "工作区";
  const node = event.nodeId ? `（节点 ${event.nodeId}）` : "";
  const detailByCode: Record<LoadRepairEvent["code"], string> = {
    "node-dropped": `${where}：结构损坏的节点${node}已在载入时丢弃`,
    "dangling-dependency": `${where}${node}：指向已不存在节点的依赖连线已移除`,
    "self-dependency": `${where}${node}：节点的自依赖已移除`,
    "dangling-fallback": `${where}${node}：指向已不存在节点的降级目标已清除`,
    "self-fallback": `${where}${node}：节点的自降级目标已清除`,
    "scenario-dropped": `${where}：无法识别的方案快照已在载入时丢弃`,
    "project-dropped": `无法识别的项目条目${event.projectId ? `（${event.projectId}）` : ""}已在载入时丢弃`,
    "active-reset": "活动项目指向无效位置，已重置为第一个项目",
    "concurrency-normalized": `${where}：并发上限已规范为正整数`,
    "timestamp-normalized": `${where}：缺失或非法的时间戳已补齐`,
  };
  return { ...event, detail: detailByCode[event.code] };
}

export type HealthIssueKind =
  | "dangling-reference"
  | "parameter-out-of-range"
  | "dependency-cycle"
  | "duplicate-node-id";

export type HealthIssueSeverity = "error" | "warning";

export interface HealthIssue {
  /** 稳定标识，修复后重扫前的同一项问题保持不变。 */
  id: string;
  kind: HealthIssueKind;
  severity: HealthIssueSeverity;
  projectId: string;
  projectTitle: string;
  nodeId?: string;
  nodeName?: string;
  field?: keyof RequestNode;
  message: string;
  fixLabel: string;
}

export interface ProjectHealth {
  projectId: string;
  projectTitle: string;
  nodeCount: number;
  issues: HealthIssue[];
  loadRepairs: LoadRepairEvent[];
}

export type LayerStatus = "ready" | "empty" | "damaged" | "unavailable";

export interface LayerSnapshot {
  status: LayerStatus;
  document: WorkspaceDocument | null;
  detail: string;
  updatedAt: number | null;
}

export interface HealthReport {
  scannedAt: number;
  /** 扫描只读取两层存储，不改动任何原始数据。 */
  readOnly: true;
  layers: {
    indexedDb: LayerSnapshot;
    fallback: LayerSnapshot;
    consistent: boolean;
    detail: string;
  };
  projects: ProjectHealth[];
  issues: HealthIssue[];
  loadRepairs: LoadRepairEvent[];
}

export interface BudgetChange {
  mode: SimulationMode;
  beforeMs: number | null;
  afterMs: number | null;
  deltaMs: number | null;
}

export interface FixOutcome {
  document: WorkspaceDocument;
  fixedIds: string[];
  report: HealthReport | null;
  budgets: BudgetChange[];
}

const MODES: SimulationMode[] = ["low", "expected", "high"];

function issueId(
  kind: HealthIssueKind,
  projectId: string,
  nodeId: string,
  field = "",
  extra = "",
): string {
  return `${kind}:${projectId}:${nodeId}:${field}:${extra}`;
}

function projectCompletion(
  project: LatencyProject,
  mode: SimulationMode,
): number | null {
  if (!project.nodes.length) return 0;
  const result = simulateProject(project, mode);
  return result.entries.length === project.nodes.length
    ? result.completionMs
    : null;
}

/** 参数越界检测，边界与 analyzeGraph 的校验保持一致。 */
function findRangeViolation(
  node: RequestNode,
): { field: keyof RequestNode; message: string } | null {
  if (node.durationMs < 0 || !Number.isFinite(node.durationMs))
    return { field: "durationMs", message: "耗时必须大于等于 0" };
  if (node.jitterMs < 0 || !Number.isFinite(node.jitterMs))
    return { field: "jitterMs", message: "波动范围必须大于等于 0" };
  if (node.timeoutMs < 0 || !Number.isFinite(node.timeoutMs))
    return { field: "timeoutMs", message: "超时必须大于等于 0" };
  if (
    !Number.isInteger(node.retryCount) ||
    node.retryCount < 0 ||
    node.retryCount > 8
  )
    return { field: "retryCount", message: "重试次数需在 0–8 次" };
  if (
    !Number.isFinite(node.failureRate) ||
    node.failureRate < 0 ||
    node.failureRate > 100
  )
    return { field: "failureRate", message: "失败概率需在 0–100%" };
  return null;
}

function clampNodeField(
  node: RequestNode,
  field: keyof RequestNode,
): RequestNode {
  switch (field) {
    case "durationMs":
      return { ...node, durationMs: Math.max(0, node.durationMs || 0) };
    case "jitterMs":
      return { ...node, jitterMs: Math.max(0, node.jitterMs || 0) };
    case "timeoutMs":
      return { ...node, timeoutMs: Math.max(0, node.timeoutMs || 0) };
    case "retryCount":
      return {
        ...node,
        retryCount: Math.min(8, Math.max(0, Math.trunc(node.retryCount || 0))),
      };
    case "failureRate":
      return {
        ...node,
        failureRate: Math.min(100, Math.max(0, node.failureRate || 0)),
      };
    default:
      return node;
  }
}

function scanProject(
  project: LatencyProject,
  loadRepairs: LoadRepairEvent[],
): ProjectHealth {
  const issues: HealthIssue[] = [];
  const nodeIds = new Set(project.nodes.map((node) => node.id));
  const firstIndexOfId = new Map<string, number>();
  project.nodes.forEach((node, index) => {
    if (!firstIndexOfId.has(node.id)) firstIndexOfId.set(node.id, index);
  });

  project.nodes.forEach((node, index) => {
    if (index > 0 && firstIndexOfId.get(node.id) !== index) {
      issues.push({
        id: issueId("duplicate-node-id", project.id, node.id),
        kind: "duplicate-node-id",
        severity: "error",
        projectId: project.id,
        projectTitle: project.title,
        nodeId: node.id,
        nodeName: node.name,
        message: `节点标识「${node.id}」重复，推演只能识别其中一个`,
        fixLabel: "重新生成节点标识",
      });
    }

    const violation = findRangeViolation(node);
    if (violation)
      issues.push({
        id: issueId(
          "parameter-out-of-range",
          project.id,
          node.id,
          violation.field,
        ),
        kind: "parameter-out-of-range",
        severity: "error",
        projectId: project.id,
        projectTitle: project.title,
        nodeId: node.id,
        nodeName: node.name,
        field: violation.field,
        message: `${node.name}：${violation.message}（当前值 ${String(node[violation.field])}）`,
        fixLabel: "收敛到合法范围",
      });

    for (const dependencyId of node.dependencyIds) {
      if (dependencyId === node.id)
        issues.push({
          id: issueId("dangling-reference", project.id, node.id, "self-dep"),
          kind: "dangling-reference",
          severity: "error",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: `${node.name}：节点不能依赖自身`,
          fixLabel: "移除自依赖",
        });
      else if (!nodeIds.has(dependencyId))
        issues.push({
          id: issueId(
            "dangling-reference",
            project.id,
            node.id,
            "dep",
            dependencyId,
          ),
          kind: "dangling-reference",
          severity: "error",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: `${node.name}：前置节点「${dependencyId}」已不存在`,
          fixLabel: "删除失效引用",
        });
    }
    if (node.fallbackNodeId) {
      if (node.fallbackNodeId === node.id)
        issues.push({
          id: issueId("dangling-reference", project.id, node.id, "self-fb"),
          kind: "dangling-reference",
          severity: "error",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: `${node.name}：降级目标不能是自身`,
          fixLabel: "移除自降级",
        });
      else if (!project.nodes.some((item) => item.id === node.fallbackNodeId))
        issues.push({
          id: issueId(
            "dangling-reference",
            project.id,
            node.id,
            "fb",
            node.fallbackNodeId,
          ),
          kind: "dangling-reference",
          severity: "error",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: `${node.name}：降级目标「${node.fallbackNodeId}」已不存在`,
          fixLabel: "删除失效降级",
        });
    }
  });

  const analysis = analyzeGraph(project);
  if (analysis.cycle.length >= 2) {
    const cycleNames = analysis.cycle.map(
      (id) => project.nodes.find((node) => node.id === id)?.name ?? id,
    );
    issues.push({
      id: issueId("dependency-cycle", project.id, analysis.cycle.join("→")),
      kind: "dependency-cycle",
      severity: "error",
      projectId: project.id,
      projectTitle: project.title,
      nodeId: analysis.cycle[0],
      message: `检测到循环依赖：${cycleNames.join(" → ")}`,
      fixLabel: `断开「${cycleNames[cycleNames.length - 2]} → ${cycleNames[cycleNames.length - 1]}」连线`,
    });
  }

  return {
    projectId: project.id,
    projectTitle: project.title,
    nodeCount: project.nodes.length,
    issues,
    loadRepairs,
  };
}

/**
 * 扫描工作区文档。纯读操作，不修改传入对象。
 * loadRepairs 来自两层解析阶段的自动修复记录。
 */
export function scanWorkspace(
  document: WorkspaceDocument,
  layers: HealthReport["layers"],
  loadRepairs: LoadRepairEvent[],
  now = Date.now(),
): HealthReport {
  const indexedDbRepairs = loadRepairs.filter(
    (event) => event.projectId !== undefined,
  );
  const projects = document.projects.map((project) =>
    scanProject(
      project,
      indexedDbRepairs.filter((event) => event.projectId === project.id),
    ),
  );
  return {
    scannedAt: now,
    readOnly: true,
    layers,
    projects,
    issues: projects.flatMap((project) => project.issues),
    loadRepairs,
  };
}

function touch(project: LatencyProject, now: number): LatencyProject {
  return { ...project, updatedAt: now };
}

function mapProject(
  document: WorkspaceDocument,
  projectId: string,
  update: (project: LatencyProject) => LatencyProject,
  now: number,
): WorkspaceDocument {
  return {
    ...document,
    projects: document.projects.map((project) =>
      project.id === projectId ? touch(update(project), now) : project,
    ),
  };
}

/**
 * 应用单项修复。返回新文档；问题已不存在时原样返回。
 * 修复动作幂等：重复执行不会继续改动数据。
 */
export function applyFix(
  document: WorkspaceDocument,
  issueIdValue: string,
  now = Date.now(),
): WorkspaceDocument {
  for (const project of document.projects) {
    const health = scanProject(project, []);
    const issue = health.issues.find((item) => item.id === issueIdValue);
    if (!issue || !issue.nodeId) continue;

    if (issue.kind === "dangling-reference") {
      return mapProject(
        document,
        project.id,
        (current) => ({
          ...current,
          nodes: current.nodes.map((node) => {
            if (node.id !== issue.nodeId) return node;
            const validIds = new Set(current.nodes.map((item) => item.id));
            return {
              ...node,
              dependencyIds: node.dependencyIds.filter(
                (id) => id !== node.id && validIds.has(id),
              ),
              fallbackNodeId:
                node.fallbackNodeId &&
                node.fallbackNodeId !== node.id &&
                validIds.has(node.fallbackNodeId)
                  ? node.fallbackNodeId
                  : undefined,
            };
          }),
        }),
        now,
      );
    }

    if (issue.kind === "parameter-out-of-range" && issue.field) {
      const field = issue.field;
      return mapProject(
        document,
        project.id,
        (current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === issue.nodeId ? clampNodeField(node, field) : node,
          ),
        }),
        now,
      );
    }

    if (issue.kind === "dependency-cycle") {
      const cycle = analyzeGraph(project).cycle;
      if (cycle.length < 2) return document;
      const from = cycle[cycle.length - 2];
      const to = cycle[cycle.length - 1];
      if (!from || !to) return document;
      return mapProject(
        document,
        project.id,
        (current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === to
              ? {
                  ...node,
                  dependencyIds: node.dependencyIds.filter((id) => id !== from),
                }
              : node,
          ),
        }),
        now,
      );
    }

    if (issue.kind === "duplicate-node-id") {
      return mapProject(
        document,
        project.id,
        (current) => {
          const firstIndex = current.nodes.findIndex(
            (node) => node.id === issue.nodeId,
          );
          const usedIds = new Set(
            current.nodes
              .slice(0, firstIndex >= 0 ? firstIndex : 0)
              .map((node) => node.id),
          );
          let nextId = crypto.randomUUID();
          while (usedIds.has(nextId)) nextId = crypto.randomUUID();
          let replaced = false;
          return {
            ...current,
            nodes: current.nodes.map((node) => {
              if (node.id !== issue.nodeId || replaced) return node;
              replaced = true;
              return { ...node, id: nextId };
            }),
          };
        },
        now,
      );
    }
  }
  return document;
}

/** 整体修复：逐项应用直到没有可修复问题，返回实际修复的问题标识（按修复顺序）。 */
export function applyAllFixes(
  document: WorkspaceDocument,
  now = Date.now(),
): { document: WorkspaceDocument; fixedIds: string[] } {
  let current = document;
  const fixedIds: string[] = [];
  for (let guard = 0; guard < 200; guard += 1) {
    const remaining = current.projects.flatMap(
      (project) => scanProject(project, []).issues,
    );
    if (!remaining.length) break;
    const nextId = remaining[0]?.id;
    if (!nextId) break;
    fixedIds.push(nextId);
    current = applyFix(current, nextId, now);
  }
  return { document: current, fixedIds };
}

/** 重新推演受影响项目，给出三种情境下完成预算；修复前后任一侧无法推演则该侧为 null，差值仅在两侧可推演时给出。 */
export function measureBudgets(
  before: WorkspaceDocument,
  after: WorkspaceDocument,
  changedProjectIds: Iterable<string>,
): BudgetChange[] {
  const ids = [...new Set(changedProjectIds)];
  return MODES.map((mode) => {
    let beforeTotal = 0;
    let afterTotal = 0;
    let beforeReady = true;
    let afterReady = true;
    for (const projectId of ids) {
      const beforeProject = before.projects.find(
        (project) => project.id === projectId,
      );
      const afterProject = after.projects.find(
        (project) => project.id === projectId,
      );
      if (!beforeProject || !afterProject) continue;
      const beforeResult = simulateProject(beforeProject, mode);
      const afterResult = simulateProject(afterProject, mode);
      if (beforeResult.entries.length === beforeProject.nodes.length)
        beforeTotal += beforeResult.completionMs;
      else beforeReady = false;
      if (afterResult.entries.length === afterProject.nodes.length)
        afterTotal += afterResult.completionMs;
      else afterReady = false;
    }
    return {
      mode,
      beforeMs: beforeReady ? beforeTotal : null,
      afterMs: afterReady ? afterTotal : null,
      deltaMs: beforeReady && afterReady ? afterTotal - beforeTotal : null,
    };
  });
}

/** 对当前项目快速取一次指定情境完成预算（无法推演时为 null）。 */
export function projectBudget(
  project: LatencyProject,
  mode: SimulationMode = "expected",
): number | null {
  return projectCompletion(project, mode);
}
