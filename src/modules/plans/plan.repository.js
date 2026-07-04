import { asc, eq } from "drizzle-orm";
import { plans } from "../../db/schema.js";

export default class PlanRepository {
  constructor(db) {
    this.db = db;
  }

  async listPlans() {
    return this.db.select().from(plans).orderBy(asc(plans.price));
  }

  async getPlanById(id) {
    const [plan] = await this.db.select().from(plans).where(eq(plans.id, id));
    return plan;
  }

  // Plano padrão = o mais barato (básico). Usado no cadastro de novos usuários.
  async getDefaultPlan() {
    const [plan] = await this.db
      .select()
      .from(plans)
      .orderBy(asc(plans.price))
      .limit(1);
    return plan;
  }
}
