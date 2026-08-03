import { and, eq } from "drizzle-orm";
import { sessions } from "../../db/schema.js";

export default class SessionRepository {
  constructor(db) {
    this.db = db;
  }

  async createSession(userId, sessionId, sourceGroupPrefix, targetGroupPrefix, folderId = null, groupInviteLink = null) {
    return this.db.insert(sessions).values({
      userId,
      sessionId,
      sourceGroup: sourceGroupPrefix,
      targetGroup: targetGroupPrefix,
      folderId,
      groupInviteLink,
      status: false
    });
  }

  // Liga/desliga o modo de conversão da margem. Derivado: fica true quando a
  // margem passa a ter credenciais do Mercado Livre cadastradas.
  async setConvertLink(sessionId, userId, convertLink) {
    return this.db
      .update(sessions)
      .set({ convertLink })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, userId)));
  }

  // Define o link de grupo (convite) da margem — anexado/substituído no final das
  // mensagens repassadas.
  async setGroupInviteLink(sessionId, userId, groupInviteLink) {
    return this.db
      .update(sessions)
      .set({ groupInviteLink })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, userId)));
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
