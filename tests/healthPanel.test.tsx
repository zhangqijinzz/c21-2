import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import LatencyLabView from "../src/features/workbench/LatencyLabView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_KEY = "latency-lab.workspace.v1";
const BACKUP_KEY = "latency-lab.workspace.backup.v1";

const damagedWorkspace = {
  version: 1,
  activeProjectId: "p-health",
  projects: [
    {
      id: "p-health",
      title: "体检演练",
      concurrencyLimit: null,
      scenarios: [],
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: "gateway",
          name: "网关",
          durationMs: 100,
          jitterMs: 0,
          dependencyIds: ["ghost-node"],
          timeoutMs: 500,
          retryCount: 99,
          failureRate: 10,
        },
        {
          id: "catalog",
          name: "目录",
          durationMs: 200,
          jitterMs: 0,
          dependencyIds: ["gateway"],
          timeoutMs: 800,
          retryCount: 0,
          failureRate: 0,
        },
      ],
    },
  ],
};

function findButton(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function storedWorkspace(): {
  projects: { nodes: { retryCount: number; dependencyIds: string[] }[] }[];
} {
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (!raw) throw new Error("workspace not persisted");
  return JSON.parse(raw) as ReturnType<typeof storedWorkspace>;
}

describe("health check module (ui)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    localStorage.clear();
  });

  it("scans without IndexedDB, fixes all issues with a rollback copy, then rolls back", async () => {
    // jsdom 没有 indexedDB：主存储不可用，体检必须依靠恢复副本完成
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(damagedWorkspace));
    await act(async () => {
      root = createRoot(container);
      root.render(<LatencyLabView />);
    });
    await flush();

    await click(
      container.querySelector('button[aria-label="工作区体检"]') as HTMLElement,
    );
    await flush();
    await flush();

    const text = () => container.textContent ?? "";
    expect(text()).toContain("浏览器数据库");
    expect(text()).toContain("不可用");
    expect(text()).toContain("一致性无法核查");
    // 载入时被自动修复的失效依赖
    expect(text()).toContain("载入时自动修复");
    expect(text()).toContain("失效前置依赖");
    // 参数越界定位到项目与节点
    expect(text()).toContain("参数越界");
    expect(text()).toContain("重试次数越界");
    expect(text()).toContain("网关");

    // 整体修复：先留回退副本，再写回存储并重新推演
    await click(findButton(container, "整体修复"));
    await flush();
    await flush();
    expect(text()).toContain("已修复 2 项");
    expect(text()).toContain("修复后完成预算变化");
    expect(text()).toContain("恢复可推演");
    expect(text()).toContain("回退到修复前");
    expect(localStorage.getItem(BACKUP_KEY)).toBeTruthy();
    const repaired = storedWorkspace();
    expect(repaired.projects[0]?.nodes[0]?.retryCount).toBe(8);
    expect(repaired.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(text()).not.toContain("重试次数越界");

    // 回退：恢复修复前的工作区并消耗回退副本
    await click(findButton(container, "回退到修复前"));
    await click(findButton(container, "回退工作区"));
    await flush();
    await flush();
    const restored = storedWorkspace();
    expect(restored.projects[0]?.nodes[0]?.retryCount).toBe(99);
    expect(localStorage.getItem(BACKUP_KEY)).toBeNull();
    expect(text()).toContain("重试次数越界");
  });
});
