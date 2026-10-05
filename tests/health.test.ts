import { beforeEach, describe, expect, it } from "vitest";
import {
  applyHealthFixes,
  buildHealthReport,
  diffBudgets,
  type HealthReport,
  type LayerSnapshot,
} from "../src/shared/domain/health";
import { analyzeGraph } from "../src/shared/domain/graph";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type WorkspaceDocument,
} from "../src/shared/domain/types";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";

class MemoryStorage {
  value: unknown = undefined;
  failRead = false;
  async read(): Promise<unknown> {
    if (this.failRead) throw new Error("simulated IndexedDB unavailable");
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    this.value = structuredClone(value);
  }
}

function workspaceOf(...projects: LatencyProject[]): WorkspaceDocument {
  const first = projects[0] ?? EXAMPLE_PROJECT;
  return {
    version: 1,
    activeProjectId: first.id,
    projects: projects.length ? projects : [structuredClone(EXAMPLE_PROJECT)],
  };
}

function okLayer(document: WorkspaceDocument): LayerSnapshot {
  return { state: "ok", document, repairs: [] };
}

const emptyLayer: LayerSnapshot = { state: "empty" };

function scan(
  document: WorkspaceDocument,
  primary: LayerSnapshot,
  replica: LayerSnapshot,
): HealthReport {
  return buildHealthReport({
    document,
    primary,
    replica,
    mode: "expected",
    now: 1_000,
  });
}

describe("workspace health scan", () => {
  it("reports consistent layers and no issues for a healthy workspace", () => {
    const document = workspaceOf();
    const report = scan(document, okLayer(document), okLayer(document));
    expect(report.consistent).toBe(true);
    expect(report.issues).toHaveLength(0);
    expect(report.budgets[0]?.completionMs).toBeGreaterThan(0);
  });

  it("flags diverged layers and names the differing project", () => {
    const document = workspaceOf();
    const older = workspaceOf({
      ...structuredClone(EXAMPLE_PROJECT),
      title: "旧标题",
    });
    const report = scan(document, okLayer(document), okLayer(older));
    expect(report.consistent).toBe(false);
    const issue = report.issues.find(
      (entry) => entry.kind === "layer-divergence",
    );
    expect(issue?.message).toContain("旧标题");
    expect(issue?.fixable).toBe(true);
  });

  it("flags a layer that only exists on one side", () => {
    const document = workspaceOf();
    const report = scan(document, okLayer(document), emptyLayer);
    expect(report.consistent).toBe(false);
    expect(
      report.issues.some((entry) => entry.kind === "layer-divergence"),
    ).toBe(true);
  });

  it("marks consistency as unknown when a layer is unavailable but still scans", () => {
    const document = workspaceOf();
    const report = scan(document, { state: "unavailable" }, okLayer(document));
    expect(report.consistent).toBeNull();
    expect(report.layers.primary).toBe("unavailable");
    expect(report.issues).toHaveLength(0);
    expect(report.budgets).toHaveLength(1);
  });

  it("surfaces per-project load-time repairs from the authoritative layer", () => {
    const document = workspaceOf();
    const primary = okLayer(document);
    primary.repairs = [
      {
        projectId: EXAMPLE_PROJECT.id,
        projectTitle: EXAMPLE_PROJECT.title,
        repairs: ["「会话校验」移除了 1 条失效前置依赖"],
      },
    ];
    const report = scan(document, primary, okLayer(document));
    const issue = report.issues.find((entry) => entry.kind === "load-repair");
    expect(issue?.projectId).toBe(EXAMPLE_PROJECT.id);
    expect(issue?.message).toContain("失效前置依赖");
    expect(issue?.fixable).toBe(true);
  });

  it("locates dangling dependencies and fallback targets to project and node", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    const [session, , profile] = project.nodes;
    if (!session || !profile) throw new Error("fixture incomplete");
    session.dependencyIds = ["ghost-node"];
    profile.fallbackNodeId = "ghost-fallback";
    const document = workspaceOf(project);
    const report = scan(document, okLayer(document), okLayer(document));
    const dangling = report.issues.filter(
      (entry) => entry.kind === "dangling-reference",
    );
    expect(dangling).toHaveLength(2);
    expect(dangling[0]?.projectTitle).toBe(EXAMPLE_PROJECT.title);
    expect(dangling.map((entry) => entry.nodeId).sort()).toEqual([
      "profile",
      "session",
    ]);
    const fixed = applyHealthFixes(
      document,
      report.issues,
      dangling.map((entry) => entry.id),
    );
    expect(fixed.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(fixed.projects[0]?.nodes[2]?.fallbackNodeId).toBeUndefined();
    expect(scan(fixed, okLayer(fixed), okLayer(fixed)).issues).toHaveLength(0);
  });

  it("clamps out-of-range parameters back into the valid range", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    const [session] = project.nodes;
    if (!session) throw new Error("fixture incomplete");
    session.retryCount = 12;
    session.failureRate = 140;
    session.durationMs = -30;
    session.name = "   ";
    project.concurrencyLimit = 0;
    const document = workspaceOf(project);
    const report = scan(document, okLayer(document), okLayer(document));
    const outOfRange = report.issues.filter(
      (entry) => entry.kind === "out-of-range",
    );
    expect(outOfRange).toHaveLength(5);
    const fixed = applyHealthFixes(
      document,
      report.issues,
      outOfRange.map((entry) => entry.id),
    );
    const repaired = fixed.projects[0]?.nodes[0];
    expect(repaired?.retryCount).toBe(8);
    expect(repaired?.failureRate).toBe(100);
    expect(repaired?.durationMs).toBe(0);
    expect(repaired?.name).toBe("未命名节点");
    expect(fixed.projects[0]?.concurrencyLimit).toBeNull();
    expect(
      analyzeGraph(fixed.projects[0] ?? project).validation.errors,
    ).toHaveLength(0);
  });

  it("detects a dependency cycle and breaks it with a single fix", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    const [session, , profile] = project.nodes;
    if (!session || !profile) throw new Error("fixture incomplete");
    session.dependencyIds = ["profile"];
    const document = workspaceOf(project);
    const report = scan(document, okLayer(document), okLayer(document));
    const cycle = report.issues.find((entry) => entry.kind === "cycle");
    expect(cycle?.message).toContain("循环依赖");
    expect(cycle?.message).toContain("会话校验");
    expect(
      report.budgets[0]?.completionMs,
      "cyclic project cannot be simulated",
    ).toBeNull();
    const fixed = applyHealthFixes(
      document,
      report.issues,
      cycle ? [cycle.id] : [],
    );
    expect(analyzeGraph(fixed.projects[0] ?? project).cycle).toHaveLength(0);
    expect(simulateProject(fixed.projects[0] ?? project).entries).toHaveLength(
      project.nodes.length,
    );
  });

  it("fixes everything at once and reports the budget change", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    const [session, , profile] = project.nodes;
    if (!session || !profile) throw new Error("fixture incomplete");
    session.dependencyIds = ["profile"]; // 环：session → profile → session
    profile.retryCount = 99;
    const document = workspaceOf(project);
    const before = scan(document, okLayer(document), okLayer(document));
    const fixable = before.issues.filter((entry) => entry.fixable);
    expect(fixable.length).toBeGreaterThanOrEqual(2);
    const fixed = applyHealthFixes(
      document,
      before.issues,
      fixable.map((entry) => entry.id),
    );
    const after = scan(fixed, okLayer(fixed), okLayer(fixed));
    expect(after.issues).toHaveLength(0);
    const changes = diffBudgets(before.budgets, after.budgets, [
      EXAMPLE_PROJECT.id,
    ]);
    expect(changes[0]?.beforeMs).toBeNull();
    expect(changes[0]?.afterMs).toBeGreaterThan(0);
  });

  it("does not mutate the scanned document or issue list", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    const [session] = project.nodes;
    if (!session) throw new Error("fixture incomplete");
    session.dependencyIds = ["ghost"];
    session.retryCount = 42;
    const document = workspaceOf(project);
    const snapshot = structuredClone(document);
    const report = scan(document, okLayer(document), okLayer(document));
    applyHealthFixes(
      document,
      report.issues,
      report.issues.map((entry) => entry.id),
    );
    expect(document).toEqual(snapshot);
  });
});

describe("repository inspection and backups", () => {
  beforeEach(() => localStorage.clear());

  it("inspects both layers read-only and keeps working when IndexedDB fails", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const document = workspaceOf();
    await repository.save(document);
    storage.failRead = true;
    const { primary, replica } = await repository.inspect();
    expect(primary.state).toBe("unavailable");
    expect(replica.state).toBe("ok");
    const report = buildHealthReport({
      document,
      primary,
      replica,
      mode: "expected",
    });
    expect(report.consistent).toBeNull();
    expect(report.issues).toHaveLength(0);
    // 扫描不改动任何一层
    expect(localStorage.getItem("latency-lab.workspace.v1")).toBeTruthy();
    storage.failRead = false;
    expect((await repository.inspect()).primary.state).toBe("ok");
  });

  it("reports load-time repairs for damaged stored data", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...EXAMPLE_PROJECT,
          nodes: [
            { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
            { damaged: true },
          ],
        },
      ],
    };
    const { primary } = await new ProjectRepository(storage).inspect();
    expect(primary.state).toBe("ok");
    expect(primary.repairs?.[0]?.projectId).toBe(EXAMPLE_PROJECT.id);
    expect(primary.repairs?.[0]?.repairs.join(" ")).toContain("失效前置依赖");
    expect(primary.repairs?.[0]?.repairs.join(" ")).toContain("损坏的节点");
  });

  it("marks unparseable layers as invalid without clearing them", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    localStorage.setItem("latency-lab.workspace.v1", "{not json");
    const { primary, replica } = await new ProjectRepository(storage).inspect();
    expect(primary.state).toBe("invalid");
    expect(replica.state).toBe("invalid");
    expect(localStorage.getItem("latency-lab.workspace.v1")).toBe("{not json");
  });

  it("round-trips a rollback backup and clears it", async () => {
    const repository = new ProjectRepository(new MemoryStorage());
    expect(await repository.loadBackup()).toBeNull();
    const document = workspaceOf();
    const backup = await repository.saveBackup(document);
    expect(backup.savedAt).toBeGreaterThan(0);
    const loaded = await repository.loadBackup();
    expect(loaded?.document).toEqual(document);
    await repository.clearBackup();
    expect(await repository.loadBackup()).toBeNull();
  });
});
