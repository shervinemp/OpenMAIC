import {
  RUNTIME_DSL_VERSION,
  type RuntimeRecord,
  type RuntimeRecordInit,
  type RuntimeSession,
} from '@openmaic/dsl';
import type { RuntimeSessionInit } from '@openmaic/storage';

/**
 * A minimal append-only runtime store: enough of the contract for the
 * learner-partition writes, with the store's ordering rules (per-session seq,
 * creation-ordered listings) preserved so tests exercise the real read path.
 */
export class FakeRuntimeStore {
  readonly sessions = new Map<string, RuntimeSession>();
  readonly records = new Map<string, RuntimeRecord[]>();
  private sessionCreatedAt = 0;
  private seq = new Map<string, number>();

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    if (this.sessions.has(init.id)) throw new Error(`session ${init.id} already exists`);
    this.sessionCreatedAt += 1;
    const session: RuntimeSession = {
      ...init,
      createdAt: new Date(this.sessionCreatedAt).toISOString(),
      updatedAt: new Date(this.sessionCreatedAt).toISOString(),
      runtimeDslVersion: RUNTIME_DSL_VERSION,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string): Promise<RuntimeSession | undefined> {
    return this.sessions.get(id);
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.stageId === stageId && session.learnerKey === learnerKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async appendRecord(init: RuntimeRecordInit): Promise<RuntimeRecord> {
    const next = (this.seq.get(init.sessionId) ?? 0) + 1;
    this.seq.set(init.sessionId, next);
    const record = { ...init, seq: next } as RuntimeRecord;
    this.records.set(init.sessionId, [...(this.records.get(init.sessionId) ?? []), record]);
    return record;
  }

  async listRecords(sessionId: string): Promise<RuntimeRecord[]> {
    return [...(this.records.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}
