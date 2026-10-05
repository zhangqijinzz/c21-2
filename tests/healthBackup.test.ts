import { beforeEach, describe, expect, it } from "vitest";
import { HealthBackupService } from "../src/shared/services/healthBackupService";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

function exampleDocument(title: string): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [{ ...structuredClone(EXAMPLE_PROJECT), title }],
  };
}

describe("health backup service", () => {
  beforeEach(() => localStorage.clear());

  it("creates, lists, restores and removes rollback copies", () => {
    const service = new HealthBackupService();
    const backup = service.create(exampleDocument("修复前"), "整体修复前备份");
    expect(backup.reason).toBe("整体修复前备份");
    const listed = service.list();
    expect(listed).toHaveLength(1);
    const restored = service.restore(backup.id);
    expect(restored?.projects[0]?.title).toBe("修复前");
    service.remove(backup.id);
    expect(service.list()).toHaveLength(0);
    expect(service.restore(backup.id)).toBeNull();
  });

  it("keeps at most five copies and drops the oldest", () => {
    const service = new HealthBackupService();
    for (let index = 0; index < 7; index += 1)
      service.create(exampleDocument(`v${index}`), `备份 ${index}`);
    const listed = service.list();
    expect(listed).toHaveLength(5);
    expect(listed[0]?.reason).toBe("备份 6");
    expect(listed[4]?.reason).toBe("备份 2");
  });

  it("skips corrupted entries without throwing", () => {
    const service = new HealthBackupService();
    const backup = service.create(exampleDocument("好"), "有效副本");
    localStorage.setItem("latency-lab.health-backup.backup-corrupt", "{broken");
    const indexRaw = localStorage.getItem("latency-lab.health-backup.index");
    const ids = JSON.parse(indexRaw ?? "[]") as string[];
    localStorage.setItem(
      "latency-lab.health-backup.index",
      JSON.stringify(["backup-corrupt", ...ids]),
    );
    expect(service.list().map((item) => item.id)).toEqual([backup.id]);
  });
});
