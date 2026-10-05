import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

class MemoryStorage {
  value: unknown = undefined;
  fail = false;
  async read(): Promise<unknown> {
    if (this.fail) throw new Error("simulated IndexedDB unavailable");
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    if (this.fail) throw new Error("simulated IndexedDB unavailable");
    this.value = structuredClone(value);
  }
}

function exampleDocument(): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [structuredClone(EXAMPLE_PROJECT)],
  };
}

describe("health-oriented repository layer inspection", () => {
  beforeEach(() => localStorage.clear());

  it("reads both layers without mutating any stored data", async () => {
    const storage = new MemoryStorage();
    const document = exampleDocument();
    storage.value = structuredClone(document);
    localStorage.setItem("latency-lab.workspace.v1", JSON.stringify(document));
    const repository = new ProjectRepository(storage);
    const layers = await repository.readLayers();
    expect(layers.indexedDb.status).toBe("ready");
    expect(layers.fallback.status).toBe("ready");
    // 原始数据保持不变。
    expect(storage.value).toEqual(document);
    expect(localStorage.getItem("latency-lab.workspace.v1")).toBe(
      JSON.stringify(document),
    );
  });

  it("marks IndexedDB unavailable and still inspects the fallback copy", async () => {
    const document = exampleDocument();
    localStorage.setItem("latency-lab.workspace.v1", JSON.stringify(document));
    const repository = new ProjectRepository(new MemoryStorage());
    (repository as unknown as { storage: MemoryStorage }).storage.fail = true;
    const layers = await repository.readLayers();
    expect(layers.indexedDb.status).toBe("unavailable");
    expect(layers.fallback.status).toBe("ready");
    expect(layers.fallback.document?.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
  });

  it("reports damaged layers and empty layers distinctly", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 1, projects: [{ id: 1 }] };
    localStorage.setItem("latency-lab.workspace.v1", "{not-json");
    const layers = await new ProjectRepository(storage).readLayers();
    expect(layers.indexedDb.status).toBe("damaged");
    expect(layers.fallback.status).toBe("damaged");

    localStorage.removeItem("latency-lab.workspace.v1");
    storage.value = undefined;
    const empty = await new ProjectRepository(storage).readLayers();
    expect(empty.indexedDb.status).toBe("empty");
    expect(empty.fallback.status).toBe("empty");
  });

  it("records repair events when parsing dangling edges and malformed rows", async () => {
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
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.source).toBe("indexeddb");
    const codes = loaded.repairs.map((event) => event.code);
    expect(codes).toContain("dangling-dependency");
    expect(codes).toContain("node-dropped");
    expect(loaded.repairs[0]?.projectId).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.repairs[0]?.detail.length).toBeGreaterThan(0);
  });

  it("loads from fallback with repair events when IndexedDB throws", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    localStorage.setItem(
      "latency-lab.workspace.v1",
      JSON.stringify(exampleDocument()),
    );
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.source).toBe("fallback");
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
  });

  it("writes the fallback copy directly when syncing toward localStorage", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const repository = new ProjectRepository(storage);
    repository.writeFallback(exampleDocument());
    const layers = await repository.readLayers();
    expect(layers.fallback.status).toBe("ready");
    expect(storage.value).toBeUndefined();
  });
});
