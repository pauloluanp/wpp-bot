import { eq, sql } from "drizzle-orm";
import { mlCredentials } from "../../db/schema.js";

export default class MlCredentialRepository {
  constructor(db) {
    this.db = db;
  }

  // `sessionRowId` é o id serial da sessão (sessions.id), não o nome da margem.
  async getBySessionId(sessionRowId) {
    const [row] = await this.db
      .select()
      .from(mlCredentials)
      .where(eq(mlCredentials.sessionId, sessionRowId));

    return row;
  }

  // Cria ou atualiza as credenciais da margem (1:1 por sessão). `session_id` é
  // único, então o conflito recai sobre ele e só atualizamos os campos + updated_at.
  async upsert(sessionRowId, { mlAffiliateTag, cookieString, csrfToken }) {
    const [row] = await this.db
      .insert(mlCredentials)
      .values({ sessionId: sessionRowId, mlAffiliateTag, cookieString, csrfToken })
      .onConflictDoUpdate({
        target: mlCredentials.sessionId,
        set: {
          mlAffiliateTag,
          cookieString,
          csrfToken,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
      .returning();

    return row;
  }
}
