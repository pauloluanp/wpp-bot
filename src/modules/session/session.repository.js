import { eq } from "drizzle-orm";
import { sessions } from "../../db/schema.js";

export default class SessionRepository {
  constructor(db) {
    this.db = db;
  }

  async createSession(sessionId, sourceGroupPrefix, targetGroupPrefix) {
    return this.db.insert(sessions).values({
      sessionId,
      sourceGroup: sourceGroupPrefix,
    targetGroup: targetGroupPrefix,
    });
  }

  async startSession(sessionId) {
    return this.db
      .update(sessions)
      .set({ status: true })
      .where(eq(sessions.sessionId, sessionId));
  }

  async stopSession(sessionId) {
    return this.db
      .update(sessions)
      .set({ status: false })
      .where(eq(sessions.sessionId, sessionId));
  }

  

  async listSessions() {
    return this.db.select().from(sessions);
  }

  async deleteSession(sessionId) {
    return this.db
      .delete(sessions)
      .where(eq(sessions.sessionId, sessionId));
  }

  async updateSessionConfig(sessionId, sourceGroup, targetGroup) {
    return this.db
      .update(sessions)
      .set({ sourceGroup, targetGroup })
      .where(eq(sessions.sessionId, sessionId));
  }

  async getSessionById(sessionId) {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId));
  }
}