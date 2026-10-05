import { describe, expect, it } from "vitest";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";
import {
  applyAllFixes,
  applyFix,
  measureBudgets,
  scanWorkspace,
  type HealthReport,
  type LayerSnapshot,
  type LoadRepairEvent,
} from "../src/shared/domain/health";
import { simulateProject } from "../src/shared/domain/simulation";

function documentWith(project = EXAMPLE_PROJECT): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: project.id,
    projects: [structuredClone(project)],
  };
}

function readyLayer(document: WorkspaceDocument): LayerSnapshot {
  return {
    status: "ready",
    document: structuredClone(document),
    detail: "",
    updatedAt: 1,
  };
}

function consistentLayers(document: WorkspaceDocument): HealthReport["layers"] {
  return {
    indexedDb: readyLayer(document),
    fallback: readyLayer(document),
    consistent: true,
    detail: "一致",
  };
}

function brokenLayers(document: WorkspaceDocument): HealthReport["layers"] {
  return {
    indexedDb: readyLayer(document),
    fallback: {
      status: "unavailable",
      document: null,
      detail: "浏览器数据库不可用",
      updatedAt: null,
    },
    consistent: false,
    detail: "不一致",
  };
}

describe("workspace health scan", () => {
  it("reports a clean workspace when layers match and graph is valid", () => {
    const document = documentWith();
    const report = scanWorkspace(document, consistentLayers(document), []);
    expect(report.layers.consistent).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.readOnly).toBe(true);
  });

  it("flags mismatched storage layers", () => {
    const document = documentWith();
    const report = scanWorkspace(document, brokenLayers(document), []);
    expect(report.layers.consistent).toBe(false);
    expect(report.layers.fallback.status).toBe("unavailable");
  });

  it("detects dangling dependencies and fallbacks pointing to missing nodes", () => {
    const document = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: [
        { ...EXAMPLE_PROJECT.nodes[0]!, dependencyIds: ["ghost"] },
        {
          ...EXAMPLE_PROJECT.nodes[1]!,
          fallbackNodeId: "phantom",
        },
      ],
    });
    const report = scanWorkspace(document, consistentLayers(document), []);
    const kinds = report.issues.map((issue) => issue.kind);
    expect(kinds.filter((kind) => kind === "dangling-reference")).toHaveLength(
      2,
    );
    expect(report.issues[0]?.projectId).toBe(EXAMPLE_PROJECT.id);
    expect(report.issues[0]?.nodeId).toBeDefined();
  });

  it("detects out-of-range parameters with field-level locations", () => {
    const document = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: [
        { ...EXAMPLE_PROJECT.nodes[0]!, durationMs: -50 },
        { ...EXAMPLE_PROJECT.nodes[1]!, retryCount: 12 },
      ],
    });
    const report = scanWorkspace(document, consistentLayers(document), []);
    const rangeIssues = report.issues.filter(
      (issue) => issue.kind === "parameter-out-of-range",
    );
    expect(rangeIssues.map((issue) => issue.field)).toContain("durationMs");
    expect(rangeIssues.map((issue) => issue.field)).toContain("retryCount");
  });

  it("detects dependency cycles", () => {
    const document = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["profile"] } : node,
      ),
    });
    const report = scanWorkspace(document, consistentLayers(document), []);
    expect(
      report.issues.some((issue) => issue.kind === "dependency-cycle"),
    ).toBe(true);
  });

  it("detects duplicate node ids", () => {
    const a = { ...EXAMPLE_PROJECT.nodes[0]!, dependencyIds: [] };
    const b = { ...EXAMPLE_PROJECT.nodes[1]!, id: a.id, dependencyIds: [] };
    const document = documentWith({ ...EXAMPLE_PROJECT, nodes: [a, b] });
    const report = scanWorkspace(document, consistentLayers(document), []);
    expect(
      report.issues.some((issue) => issue.kind === "duplicate-node-id"),
    ).toBe(true);
  });

  it("surfaces load-time auto repairs grouped by project", () => {
    const document = documentWith();
    const repairs: LoadRepairEvent[] = [
      {
        code: "dangling-dependency",
        projectId: EXAMPLE_PROJECT.id,
        projectTitle: EXAMPLE_PROJECT.title,
        nodeId: "session",
        detail: "载入时修复",
      },
    ];
    const report = scanWorkspace(document, consistentLayers(document), repairs);
    expect(report.projects[0]?.loadRepairs).toHaveLength(1);
    expect(report.loadRepairs).toHaveLength(1);
  });

  it("does not mutate the scanned document", () => {
    const document = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: [{ ...EXAMPLE_PROJECT.nodes[0]!, dependencyIds: ["ghost"] }],
    });
    const snapshot = structuredClone(document);
    scanWorkspace(document, consistentLayers(document), []);
    expect(document).toEqual(snapshot);
  });
});

describe("health fixes", () => {
  it("removes a dangling reference for a single issue", () => {
    const document = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: [
        { ...EXAMPLE_PROJECT.nodes[0]!, dependencyIds: ["ghost"] },
        ...EXAMPLE_PROJECT.nodes.slice(1),
      ],
    });
    const report = scanWorkspace(document, consistentLayers(document), []);
    const issue = report.issues.find(
      (item) => item.kind === "dangling-reference",
    )!;
    const fixed = applyFix(document, issue.id, 100);
    expect(
      fixed.projects[0]?.nodes.find((node) => node.id === "session")
        ?.dependencyIds,
    ).toEqual([]);
    const rescanned = scanWorkspace(fixed, consistentLayers(fixed), []);
    expect(rescanned.issues).toEqual([]);
  });

  it("clamps out-of-range parameters into legal bounds", () => {
    const document = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: [
        {
          ...EXAMPLE_PROJECT.nodes[0]!,
          durationMs: -10,
          failureRate: 250,
          dependencyIds: [],
        },
      ],
    });
    const { document: fixed, fixedIds } = applyAllFixes(document, 100);
    // 一个节点一次只收敛一个字段，两轮修复全部归零/封顶。
    expect(fixedIds.length).toBe(2);
    const node = fixed.projects[0]?.nodes[0];
    expect(node?.durationMs).toBe(0);
    expect(node?.failureRate).toBe(100);
  });

  it("breaks a cycle by removing the closing edge and clears residual dangling edges", () => {
    const cyclic = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["profile"] } : node,
      ),
    };
    const document = documentWith(cyclic);
    const { document: fixed, fixedIds } = applyAllFixes(document, 100);
    const rescanned = scanWorkspace(fixed, consistentLayers(fixed), []);
    expect(rescanned.issues).toEqual([]);
    // 断开闭环边后 profile → session 是合法边，无需追加修复。
    expect(fixedIds).toHaveLength(1);
    expect(simulateProject(fixed.projects[0]!).entries.length).toBe(
      fixed.projects[0]!.nodes.length,
    );
  });

  it("reassigns duplicate node ids and keeps references intact", () => {
    const a = { ...EXAMPLE_PROJECT.nodes[0]!, dependencyIds: [] };
    const b = {
      ...EXAMPLE_PROJECT.nodes[1]!,
      id: a.id,
      dependencyIds: [],
    };
    const document = documentWith({ ...EXAMPLE_PROJECT, nodes: [a, b] });
    const { document: fixed } = applyAllFixes(document, 100);
    const ids = fixed.projects[0]?.nodes.map((node) => node.id) ?? [];
    expect(new Set(ids).size).toBe(2);
  });

  it("fix all is idempotent on an already healthy workspace", () => {
    const document = documentWith();
    const { document: fixed, fixedIds } = applyAllFixes(document, 100);
    expect(fixedIds).toEqual([]);
    expect(fixed).toEqual(document);
  });
});

describe("budget deltas after repair", () => {
  it("turns an un-simulatable project into a budget and reports numeric changes", () => {
    const unSimulatable = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: [
        { ...EXAMPLE_PROJECT.nodes[0]!, dependencyIds: ["ghost"] },
        ...EXAMPLE_PROJECT.nodes.slice(1),
      ],
    });
    expect(simulateProject(unSimulatable.projects[0]!).entries).toHaveLength(0);
    const { document: repaired, fixedIds } = applyAllFixes(unSimulatable, 100);
    expect(fixedIds.length).toBe(1);
    const budgets = measureBudgets(unSimulatable, repaired, [
      EXAMPLE_PROJECT.id,
    ]);
    expect(budgets).toHaveLength(3);
    for (const change of budgets) {
      expect(change.beforeMs).toBeNull();
      expect(change.afterMs).not.toBeNull();
      expect(change.deltaMs).toBeNull();
    }

    const slower = documentWith({
      ...EXAMPLE_PROJECT,
      nodes: [
        { ...EXAMPLE_PROJECT.nodes[0]!, durationMs: 2800 },
        ...EXAMPLE_PROJECT.nodes.slice(1),
      ],
    });
    // 2800ms 的耗时在 800ms 超时下被截断，两侧都可推演，差值为负的可核查数值。
    const direct = measureBudgets(slower, documentWith(), [EXAMPLE_PROJECT.id]);
    const expected = direct.find((change) => change.mode === "expected")!;
    expect(expected.beforeMs).not.toBeNull();
    expect(expected.afterMs).not.toBeNull();
    expect(expected.deltaMs).not.toBeNull();
    expect(expected.deltaMs!).toBeLessThan(0);
  });
});
