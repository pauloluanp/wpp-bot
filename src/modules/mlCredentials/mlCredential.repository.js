import { eq, sql } from "drizzle-orm";
import { mlCredentials } from "../../db/schema.js";

export default class MlCredentialRepository {
  constructor(db) {
    this.db = db;
  }

  async getByUserId(userId) {
    const [row] = await this.db
      .select()
      .from(mlCredentials)
      .where(eq(mlCredentials.userId, userId));

    return row;
  }

  // Cria ou atualiza as credenciais do usuário (1:1). `user_id` é único, então
  // o conflito recai sobre ele e apenas atualizamos os campos + updated_at.
  async upsert(userId, { mlAffiliateTag, cookieString, csrfToken }) {
    const [row] = await this.db
      .insert(mlCredentials)
      .values({ userId, mlAffiliateTag, cookieString, csrfToken })
      .onConflictDoUpdate({
        target: mlCredentials.userId,
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
