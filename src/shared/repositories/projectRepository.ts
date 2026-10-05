import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import { createLoadRepair, type LoadRepairEvent } from "../domain/health";
import { IndexedDbService } from "../services/indexedDbService";

const FALLBACK_KEY = "latency-lab.workspace.v1";

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
  emit?: (event: LoadRepairEvent) => void,
): { project: LatencyProject; recovered: boolean } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return undefined;
  const projectId = value.id;
  const projectTitle = value.title;
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const parsedNodes = sourceNodes.map(parseNode);
  const nodes = parsedNodes.filter((node): node is RequestNode =>
    Boolean(node),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  let recovered =
    !Array.isArray(value.nodes) || nodes.length !== sourceNodes.length;
  if (recovered)
    emit?.(
      createLoadRepair({
        code: "node-dropped",
        projectId,
        projectTitle,
      }),
    );
  const safeNodes = nodes.map((node) => {
    const dependencyIds = node.dependencyIds.filter((id) => {
      if (id === node.id) {
        recovered = true;
        emit?.(
          createLoadRepair({
            code: "self-dependency",
            projectId,
            projectTitle,
            nodeId: node.id,
          }),
        );
        return false;
      }
      if (!nodeIds.has(id)) {
        recovered = true;
        emit?.(
          createLoadRepair({
            code: "dangling-dependency",
            projectId,
            projectTitle,
            nodeId: node.id,
          }),
        );
        return false;
      }
      return true;
    });
    let validFallback: string | undefined;
    if (node.fallbackNodeId) {
      if (node.fallbackNodeId === node.id) {
        recovered = true;
        emit?.(
          createLoadRepair({
            code: "self-fallback",
            projectId,
            projectTitle,
            nodeId: node.id,
          }),
        );
      } else if (!nodeIds.has(node.fallbackNodeId)) {
        recovered = true;
        emit?.(
          createLoadRepair({
            code: "dangling-fallback",
            projectId,
            projectTitle,
            nodeId: node.id,
          }),
        );
      } else {
        validFallback = node.fallbackNodeId;
      }
    }
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
  if (
    !Array.isArray(value.scenarios) ||
    scenarios.length !== scenarioSource.length
  ) {
    recovered = true;
    emit?.(
      createLoadRepair({
        code: "scenario-dropped",
        projectId,
        projectTitle,
      }),
    );
  }
  const now = Date.now();
  const concurrencyNormalized =
    value.concurrencyLimit !== undefined &&
    value.concurrencyLimit !== null &&
    (typeof value.concurrencyLimit !== "number" || value.concurrencyLimit <= 0);
  if (concurrencyNormalized)
    emit?.(
      createLoadRepair({
        code: "concurrency-normalized",
        projectId,
        projectTitle,
      }),
    );
  const timestampNormalized =
    !isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt);
  if (timestampNormalized)
    emit?.(
      createLoadRepair({
        code: "timestamp-normalized",
        projectId,
        projectTitle,
      }),
    );
  const project: LatencyProject = {
    id: projectId,
    title: projectTitle,
    nodes: safeNodes,
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit > 0
        ? Math.floor(value.concurrencyLimit)
        : null,
    scenarios,
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : now,
    updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : now,
  };
  return { project, recovered };
}

function parseWorkspace(
  value: unknown,
  emit?: (event: LoadRepairEvent) => void,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects))
    return undefined;
  const parsed = value.projects.map((entry) => parseProject(entry, emit));
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  if (projects.length !== parsed.length)
    emit?.(createLoadRepair({ code: "project-dropped" }));
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  if (activeProjectId !== value.activeProjectId)
    emit?.(createLoadRepair({ code: "active-reset" }));
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => entry?.recovered);
  return { document: { version: 1, activeProjectId, projects }, recovered };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  write(value: WorkspaceDocument): Promise<void>;
}

export type WorkspaceSource = "indexeddb" | "fallback" | "example";

export interface LoadedWorkspace {
  document: WorkspaceDocument;
  recovered: boolean;
  source: WorkspaceSource;
  repairs: LoadRepairEvent[];
}

export interface LayerRead {
  status: "ready" | "empty" | "damaged" | "unavailable";
  document: WorkspaceDocument | null;
  detail: string;
  updatedAt: number | null;
  repairs: LoadRepairEvent[];
}

function parseFallbackRaw(raw: string | null): {
  document: WorkspaceDocument;
  repairs: LoadRepairEvent[];
} | null {
  if (!raw) return null;
  const repairs: LoadRepairEvent[] = [];
  try {
    const parsed = parseWorkspace(JSON.parse(raw) as unknown, (event) =>
      repairs.push(event),
    );
    return parsed ? { document: parsed.document, repairs } : null;
  } catch {
    return null;
  }
}

export class ProjectRepository {
  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<LoadedWorkspace> {
    try {
      const repairs: LoadRepairEvent[] = [];
      const stored = parseWorkspace(await this.storage.read(), (event) =>
        repairs.push(event),
      );
      if (stored)
        return {
          ...stored,
          source: "indexeddb",
          repairs,
        };
      const local = parseFallbackRaw(this.readFallbackRaw());
      if (local)
        return {
          document: local.document,
          recovered: true,
          source: "fallback",
          repairs: local.repairs,
        };
      if (localStorage.getItem(FALLBACK_KEY) !== null)
        localStorage.removeItem(FALLBACK_KEY);
    } catch {
      const local = parseFallbackRaw(this.readFallbackRaw());
      if (local)
        return {
          document: local.document,
          recovered: true,
          source: "fallback",
          repairs: local.repairs,
        };
    }
    return {
      document: {
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      },
      recovered: true,
      source: "example",
      repairs: [],
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

  /** 只读探测两层存储；任何一层异常都不抛出，体检在浏览器数据库不可用时仍可完成。 */
  async readLayers(): Promise<{ indexedDb: LayerRead; fallback: LayerRead }> {
    const fallbackRaw = this.readFallbackRaw();
    let fallback: LayerRead;
    if (fallbackRaw === null) {
      fallback = {
        status: "empty",
        document: null,
        detail: "本地恢复副本尚未生成",
        updatedAt: null,
        repairs: [],
      };
    } else {
      const parsed = parseFallbackRaw(fallbackRaw);
      fallback = parsed
        ? {
            status: "ready",
            document: parsed.document,
            detail: "恢复副本可读取",
            updatedAt: this.layerUpdatedAt(parsed.document),
            repairs: parsed.repairs,
          }
        : {
            status: "damaged",
            document: null,
            detail: "恢复副本内容损坏，无法解析",
            updatedAt: null,
            repairs: [],
          };
    }

    try {
      const repairs: LoadRepairEvent[] = [];
      const raw = await this.storage.read();
      if (raw === undefined || raw === null) {
        return {
          indexedDb: {
            status: "empty",
            document: null,
            detail: "浏览器数据库中暂无项目",
            updatedAt: null,
            repairs: [],
          },
          fallback,
        };
      }
      const parsed = parseWorkspace(raw, (event) => repairs.push(event));
      if (!parsed)
        return {
          indexedDb: {
            status: "damaged",
            document: null,
            detail: "浏览器数据库内容损坏，无法解析",
            updatedAt: null,
            repairs,
          },
          fallback,
        };
      return {
        indexedDb: {
          status: "ready",
          document: parsed.document,
          detail: "浏览器数据库可读取",
          updatedAt: this.layerUpdatedAt(parsed.document),
          repairs,
        },
        fallback,
      };
    } catch (error) {
      return {
        indexedDb: {
          status: "unavailable",
          document: null,
          detail:
            error instanceof Error
              ? `浏览器数据库不可用：${error.message}`
              : "浏览器数据库不可用",
          updatedAt: null,
          repairs: [],
        },
        fallback,
      };
    }
  }

  /** 用一份文档同步覆盖本地恢复副本（浏览器数据库不可用时也能收敛两层差异）。 */
  writeFallback(document: WorkspaceDocument): void {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(document));
  }

  private readFallbackRaw(): string | null {
    try {
      return localStorage.getItem(FALLBACK_KEY);
    } catch {
      return null;
    }
  }

  private layerUpdatedAt(document: WorkspaceDocument): number | null {
    return document.projects.reduce<number | null>(
      (latest, project) =>
        latest === null || project.updatedAt > latest
          ? project.updatedAt
          : latest,
      null,
    );
  }
}
