import { and, eq } from "drizzle-orm";
import { sessions } from "../../db/schema.js";

export default class SessionRepository {
  constructor(db) {
    this.db = db;
  }

  async createSession(userId, sessionId, sourceGroupPrefix, targetGroupPrefix) {
    return this.db.insert(sessions).values({
      userId,
      sessionId,
      sourceGroup: sourceGroupPrefix,
      targetGroup: targetGroupPrefix,
      status: false
    });
  }

  async startSession(sessionId, userId) {
    return this.db
      .update(sessions)
      .set({ status: true })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, userId)));
  }

  async stopSession(sessionId, userId) {
    return this.db
      .update(sessions)
      .set({ status: false })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, userId)));
  }

  

  async listSessions(userId) {
    return this.db.select().from(sessions).where(eq(sessions.userId, userId));
  }

  async deleteSession(sessionId, userId) {
    return this.db
      .delete(sessions)
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, userId)));
  }

  async updateSessionConfig(sessionId, userId, sourceGroup, targetGroup) {
    return this.db
      .update(sessions)
      .set({ sourceGroup, targetGroup })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, userId)));
  }

  async getSessionById(sessionId, userId) {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, userId)));
  }
}
