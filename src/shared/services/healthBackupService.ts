import type { WorkspaceDocument } from "../domain/types";

const BACKUP_PREFIX = "latency-lab.health-backup.";
const BACKUP_INDEX_KEY = "latency-lab.health-backup.index";
const BACKUP_LIMIT = 5;

export interface HealthBackup {
  id: string;
  createdAt: number;
  reason: string;
  document: WorkspaceDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 副本只做结构校验，不做解析修复；回退时仍会经过正常载入流程。 */
function looksLikeDocument(value: unknown): value is WorkspaceDocument {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.projects) &&
    typeof value.activeProjectId === "string"
  );
}

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(BACKUP_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeIndex(ids: string[]): void {
  localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(ids));
}

export class HealthBackupService {
  create(document: WorkspaceDocument, reason: string): HealthBackup {
    const id = `backup-${crypto.randomUUID()}`;
    const backup: HealthBackup = {
      id,
      createdAt: Date.now(),
      reason,
      document: structuredClone(document),
    };
    localStorage.setItem(BACKUP_PREFIX + id, JSON.stringify(backup));
    const ids = [id, ...readIndex()].slice(0, BACKUP_LIMIT);
    for (const stale of readIndex().slice(BACKUP_LIMIT))
      localStorage.removeItem(BACKUP_PREFIX + stale);
    writeIndex(ids);
    return backup;
  }

  list(): HealthBackup[] {
    const backups: HealthBackup[] = [];
    for (const id of readIndex()) {
      try {
        const raw = localStorage.getItem(BACKUP_PREFIX + id);
        if (!raw) continue;
        const parsed: unknown = JSON.parse(raw);
        if (
          isRecord(parsed) &&
          typeof parsed.id === "string" &&
          typeof parsed.createdAt === "number" &&
          typeof parsed.reason === "string" &&
          looksLikeDocument(parsed.document)
        ) {
          backups.push({
            id: parsed.id,
            createdAt: parsed.createdAt,
            reason: parsed.reason,
            document: parsed.document,
          });
        }
      } catch {
        // 损坏的副本条目跳过，不影响其它副本与体检本身。
      }
    }
    return backups;
  }

  restore(id: string): WorkspaceDocument | null {
    try {
      const raw = localStorage.getItem(BACKUP_PREFIX + id);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && looksLikeDocument(parsed.document))
        return parsed.document;
    } catch {
      // 落到 null，由调用方提示。
    }
    return null;
  }

  remove(id: string): void {
    localStorage.removeItem(BACKUP_PREFIX + id);
    writeIndex(readIndex().filter((item) => item !== id));
  }
}
