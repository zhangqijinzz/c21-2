import { analyzeGraph } from "./graph";
import { simulateProject } from "./simulation";
import type {
  LatencyProject,
  RequestNode,
  SimulationMode,
  WorkspaceDocument,
} from "./types";

export type LayerState = "ok" | "empty" | "unavailable" | "invalid";

export interface ProjectRepairRecord {
  projectId: string;
  projectTitle: string;
  repairs: string[];
}

export interface LayerSnapshot {
  state: LayerState;
  document?: WorkspaceDocument;
  repairs?: ProjectRepairRecord[];
  detail?: string;
}

export type HealthIssueKind =
  | "layer-divergence"
  | "load-repair"
  | "dangling-reference"
  | "out-of-range"
  | "cycle";

export type IssueFix =
  | { type: "remove-dependency"; nodeId: string; dependencyId: string }
  | { type: "clear-fallback"; nodeId: string }
  | {
      type: "clamp-field";
      nodeId: string;
      field:
        "durationMs" | "jitterMs" | "timeoutMs" | "retryCount" | "failureRate";
      value: number;
    }
  | { type: "rename-node"; nodeId: string; name: string }
  | { type: "reset-concurrency" }
  | { type: "persist-document" };

export interface HealthIssue {
  id: string;
  kind: HealthIssueKind;
  projectId: string;
  projectTitle: string;
  nodeId?: string;
  nodeName?: string;
  message: string;
  fixable: boolean;
  fixLabel?: string;
  fix?: IssueFix;
}

export interface ProjectBudget {
  projectId: string;
  title: string;
  completionMs: number | null;
}

export interface HealthReport {
  scannedAt: number;
  layers: { primary: LayerState; replica: LayerState };
  consistent: boolean | null;
  issues: HealthIssue[];
  budgets: ProjectBudget[];
}

export interface BudgetChange {
  projectId: string;
  title: string;
  beforeMs: number | null;
  afterMs: number | null;
}

export const HEALTH_KIND_ORDER: HealthIssueKind[] = [
  "layer-divergence",
  "load-repair",
  "dangling-reference",
  "out-of-range",
  "cycle",
];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

function describeDivergence(
  primary: WorkspaceDocument,
  replica: WorkspaceDocument,
): string {
  const primaryById = new Map(primary.projects.map((item) => [item.id, item]));
  const replicaById = new Map(replica.projects.map((item) => [item.id, item]));
  const parts: string[] = [];
  for (const [id, project] of primaryById) {
    const other = replicaById.get(id);
    if (!other) parts.push(`「${project.title}」仅存在于浏览器数据库`);
    else if (stableStringify(project) !== stableStringify(other))
      parts.push(
        project.title !== other.title
          ? `「${project.title}」与恢复副本中的「${other.title}」内容不同`
          : `「${project.title}」两层内容不同`,
      );
  }
  for (const [id, project] of replicaById) {
    if (!primaryById.has(id))
      parts.push(`「${project.title}」仅存在于恢复副本`);
  }
  if (!parts.length && primary.activeProjectId !== replica.activeProjectId)
    parts.push("两层记录的活动项目不同");
  return parts.join("；") || "两层存储的工作区结构不一致";
}

function layerConsistency(
  primary: LayerSnapshot,
  replica: LayerSnapshot,
): { consistent: boolean | null; issue?: HealthIssue } {
  const states: LayerState[] = [primary.state, replica.state];
  if (states.includes("unavailable")) return { consistent: null };
  if (primary.state === "empty" && replica.state === "empty")
    return { consistent: true };
  if (primary.state === "ok" && replica.state === "ok") {
    const primaryDocument = primary.document;
    const replicaDocument = replica.document;
    if (!primaryDocument || !replicaDocument) return { consistent: null };
    if (stableStringify(primaryDocument) === stableStringify(replicaDocument))
      return { consistent: true };
    return {
      consistent: false,
      issue: {
        id: "layer-divergence:workspace",
        kind: "layer-divergence",
        projectId: "",
        projectTitle: "工作区",
        message: describeDivergence(primaryDocument, replicaDocument),
        fixable: true,
        fixLabel: "以当前工作区覆盖两层存储",
        fix: { type: "persist-document" },
      },
    };
  }
  const broken =
    primary.state === "invalid" && replica.state === "invalid"
      ? "两层存储的内容均损坏"
      : primary.state === "invalid"
        ? "浏览器数据库内容损坏"
        : replica.state === "invalid"
          ? "恢复副本内容损坏"
          : "";
  return {
    consistent: false,
    issue: {
      id: "layer-divergence:workspace",
      kind: "layer-divergence",
      projectId: "",
      projectTitle: "工作区",
      message: broken ? `${broken}，两层无法对齐` : "只有一层保存了工作区内容",
      fixable: true,
      fixLabel: "以当前工作区覆盖两层存储",
      fix: { type: "persist-document" },
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function inspectNodeFields(
  project: LatencyProject,
  node: RequestNode,
): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const base = {
    projectId: project.id,
    projectTitle: project.title,
    nodeId: node.id,
    nodeName: node.name,
  };
  const pushField = (
    field:
      "durationMs" | "jitterMs" | "timeoutMs" | "retryCount" | "failureRate",
    label: string,
    value: number,
    min: number,
    max: number,
    rangeLabel: string,
  ) => {
    const normalized =
      field === "retryCount" && Number.isFinite(value)
        ? Math.round(value)
        : value;
    const clamped = clamp(normalized, min, max);
    if (clamped === value && Number.isFinite(value)) return;
    issues.push({
      id: `out-of-range:${project.id}:${node.id}:${field}`,
      kind: "out-of-range",
      ...base,
      message: `${label}越界（当前 ${String(value)}，${rangeLabel}）`,
      fixable: true,
      fixLabel: `修正为 ${clamped}`,
      fix: { type: "clamp-field", nodeId: node.id, field, value: clamped },
    });
  };
  if (!node.name.trim())
    issues.push({
      id: `out-of-range:${project.id}:${node.id}:name`,
      kind: "out-of-range",
      ...base,
      nodeName: "（未命名）",
      message: "节点名称为空",
      fixable: true,
      fixLabel: "命名为「未命名节点」",
      fix: { type: "rename-node", nodeId: node.id, name: "未命名节点" },
    });
  pushField(
    "durationMs",
    "预计耗时",
    node.durationMs,
    0,
    Infinity,
    "需 ≥ 0 ms",
  );
  pushField("jitterMs", "延迟波动", node.jitterMs, 0, Infinity, "需 ≥ 0 ms");
  pushField("timeoutMs", "超时阈值", node.timeoutMs, 0, Infinity, "需 ≥ 0 ms");
  pushField("retryCount", "重试次数", node.retryCount, 0, 8, "允许 0–8 次");
  pushField("failureRate", "失败概率", node.failureRate, 0, 100, "允许 0–100%");
  return issues;
}

function inspectProject(project: LatencyProject): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const nodeIds = new Set(project.nodes.map((node) => node.id));
  for (const node of project.nodes) {
    for (const dependencyId of node.dependencyIds) {
      if (dependencyId === node.id) {
        issues.push({
          id: `dangling-reference:${project.id}:${node.id}:dep:${dependencyId}`,
          kind: "dangling-reference",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: "节点依赖了自身",
          fixable: true,
          fixLabel: "移除该自依赖",
          fix: {
            type: "remove-dependency",
            nodeId: node.id,
            dependencyId,
          },
        });
      } else if (!nodeIds.has(dependencyId)) {
        issues.push({
          id: `dangling-reference:${project.id}:${node.id}:dep:${dependencyId}`,
          kind: "dangling-reference",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: `前置依赖指向不存在的节点（${dependencyId}）`,
          fixable: true,
          fixLabel: "移除该引用",
          fix: {
            type: "remove-dependency",
            nodeId: node.id,
            dependencyId,
          },
        });
      }
    }
    if (node.fallbackNodeId) {
      if (node.fallbackNodeId === node.id) {
        issues.push({
          id: `dangling-reference:${project.id}:${node.id}:fallback`,
          kind: "dangling-reference",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: "降级目标指向自身",
          fixable: true,
          fixLabel: "清除降级目标",
          fix: { type: "clear-fallback", nodeId: node.id },
        });
      } else if (!nodeIds.has(node.fallbackNodeId)) {
        issues.push({
          id: `dangling-reference:${project.id}:${node.id}:fallback`,
          kind: "dangling-reference",
          projectId: project.id,
          projectTitle: project.title,
          nodeId: node.id,
          nodeName: node.name,
          message: `降级目标指向不存在的节点（${node.fallbackNodeId}）`,
          fixable: true,
          fixLabel: "清除降级目标",
          fix: { type: "clear-fallback", nodeId: node.id },
        });
      }
    }
    issues.push(...inspectNodeFields(project, node));
  }
  const limit = project.concurrencyLimit;
  if (
    limit !== null &&
    (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1)
  ) {
    issues.push({
      id: `out-of-range:${project.id}::concurrencyLimit`,
      kind: "out-of-range",
      projectId: project.id,
      projectTitle: project.title,
      message: `并发上限越界（当前 ${String(limit)}，需为正整数或不限）`,
      fixable: true,
      fixLabel: "重置为不限并发",
      fix: { type: "reset-concurrency" },
    });
  }
  const analysis = analyzeGraph(project);
  if (analysis.cycle.length) {
    const cycle = analysis.cycle;
    const closingNodeId = cycle[cycle.length - 2];
    const closingDependencyId = cycle[cycle.length - 1];
    const nameOf = (id: string) =>
      project.nodes.find((node) => node.id === id)?.name ?? id;
    const closingNode = project.nodes.find((node) => node.id === closingNodeId);
    issues.push({
      id: `cycle:${project.id}`,
      kind: "cycle",
      projectId: project.id,
      projectTitle: project.title,
      ...(closingNode
        ? { nodeId: closingNode.id, nodeName: closingNode.name }
        : {}),
      message: `检测到循环依赖：${cycle.map(nameOf).join(" → ")}`,
      fixable: Boolean(closingNodeId && closingDependencyId),
      fixLabel: `断开「${nameOf(closingNodeId ?? "")}」对「${nameOf(closingDependencyId ?? "")}」的依赖`,
      fix:
        closingNodeId && closingDependencyId
          ? {
              type: "remove-dependency",
              nodeId: closingNodeId,
              dependencyId: closingDependencyId,
            }
          : undefined,
    });
  }
  return issues;
}

function projectBudget(
  project: LatencyProject,
  mode: SimulationMode,
): ProjectBudget {
  const result = simulateProject(project, mode);
  return {
    projectId: project.id,
    title: project.title,
    completionMs:
      result.entries.length === project.nodes.length
        ? result.completionMs
        : null,
  };
}

export interface HealthScanInput {
  document: WorkspaceDocument;
  primary: LayerSnapshot;
  replica: LayerSnapshot;
  mode?: SimulationMode;
  now?: number;
}

export function buildHealthReport(input: HealthScanInput): HealthReport {
  const mode = input.mode ?? "expected";
  const issues: HealthIssue[] = [];
  const { consistent, issue: divergenceIssue } = layerConsistency(
    input.primary,
    input.replica,
  );
  if (divergenceIssue) issues.push(divergenceIssue);

  const authoritative =
    input.primary.state === "ok"
      ? input.primary
      : input.replica.state === "ok"
        ? input.replica
        : undefined;
  for (const record of authoritative?.repairs ?? []) {
    issues.push({
      id: `load-repair:${record.projectId}`,
      kind: "load-repair",
      projectId: record.projectId,
      projectTitle: record.projectTitle,
      message: `载入时自动修复：${record.repairs.join("；")}`,
      fixable: true,
      fixLabel: "将修复后的工作区写回存储",
      fix: { type: "persist-document" },
    });
  }

  for (const project of input.document.projects)
    issues.push(...inspectProject(project));

  return {
    scannedAt: input.now ?? Date.now(),
    layers: { primary: input.primary.state, replica: input.replica.state },
    consistent,
    issues,
    budgets: input.document.projects.map((project) =>
      projectBudget(project, mode),
    ),
  };
}

function patchProject(
  document: WorkspaceDocument,
  projectId: string,
  patch: (project: LatencyProject) => LatencyProject,
): WorkspaceDocument {
  return {
    ...document,
    projects: document.projects.map((project) =>
      project.id === projectId ? patch(project) : project,
    ),
  };
}

function patchNode(
  project: LatencyProject,
  nodeId: string,
  patch: (node: RequestNode) => RequestNode,
): LatencyProject {
  return {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === nodeId ? patch(node) : node,
    ),
  };
}

function applyIssueFix(
  document: WorkspaceDocument,
  issue: HealthIssue,
  now: number,
): WorkspaceDocument {
  const fix = issue.fix;
  if (!fix || fix.type === "persist-document") return document;
  const projectId = issue.projectId;
  if (!document.projects.some((project) => project.id === projectId))
    return document;
  switch (fix.type) {
    case "remove-dependency":
      return patchProject(document, projectId, (project) => ({
        ...patchNode(project, fix.nodeId, (node) => ({
          ...node,
          dependencyIds: node.dependencyIds.filter(
            (id) => id !== fix.dependencyId,
          ),
        })),
        updatedAt: now,
      }));
    case "clear-fallback":
      return patchProject(document, projectId, (project) => ({
        ...patchNode(project, fix.nodeId, (node) => ({
          ...node,
          fallbackNodeId: undefined,
        })),
        updatedAt: now,
      }));
    case "clamp-field":
      return patchProject(document, projectId, (project) => ({
        ...patchNode(project, fix.nodeId, (node) => ({
          ...node,
          [fix.field]: fix.value,
        })),
        updatedAt: now,
      }));
    case "rename-node":
      return patchProject(document, projectId, (project) => ({
        ...patchNode(project, fix.nodeId, (node) => ({
          ...node,
          name: fix.name,
        })),
        updatedAt: now,
      }));
    case "reset-concurrency":
      return patchProject(document, projectId, (project) => ({
        ...project,
        concurrencyLimit: null,
        updatedAt: now,
      }));
  }
}

export function applyHealthFixes(
  document: WorkspaceDocument,
  issues: HealthIssue[],
  ids: string[],
  now = Date.now(),
): WorkspaceDocument {
  const wanted = new Set(ids);
  let next = document;
  for (const issue of issues) {
    if (!wanted.has(issue.id) || !issue.fixable) continue;
    next = applyIssueFix(next, issue, now);
  }
  return next;
}

export function diffBudgets(
  before: ProjectBudget[],
  after: ProjectBudget[],
  projectIds: string[],
): BudgetChange[] {
  const changes: BudgetChange[] = [];
  for (const projectId of projectIds) {
    const previous = before.find((entry) => entry.projectId === projectId);
    const current = after.find((entry) => entry.projectId === projectId);
    const beforeMs = previous?.completionMs ?? null;
    const afterMs = current?.completionMs ?? null;
    if (beforeMs === null && afterMs === null && !previous && !current)
      continue;
    changes.push({
      projectId,
      title: current?.title ?? previous?.title ?? projectId,
      beforeMs,
      afterMs,
    });
  }
  return changes;
}
