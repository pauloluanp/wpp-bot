import { eq, asc } from "drizzle-orm";
import { users, plans } from "../../db/schema.js";

export default class UserRepository {
  constructor(db) {
    this.db = db;
  }

  // Lista os usuários para a área administrativa. Nunca expõe passwordHash e já
  // traz o nome do plano via leftJoin (planId pode ser nulo).
  async listUsers() {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        age: users.age,
        planId: users.planId,
        planName: plans.name,
      })
      .from(users)
      .leftJoin(plans, eq(users.planId, plans.id))
      .orderBy(asc(users.id));
  }

  async createUser({ name, email, passwordHash, age, planId, role }) {
    const [user] = await this.db
      .insert(users)
      .values({ name, email, passwordHash, age, planId, role })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        age: users.age,
        planId: users.planId,
      });

    return user;
  }

  async getUserByEmail(email) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));

    return user;
  }

  async getUserById(id) {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));

    return user;
  }

  async updateProfile(userId, { name, age }) {
    const [user] = await this.db
      .update(users)
      .set({ name, age })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        age: users.age,
        planId: users.planId,
      });

    return user;
  }

  async updatePassword(userId, passwordHash) {
    const [user] = await this.db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    return user;
  }

  async updatePlan(userId, planId) {
    const [user] = await this.db
      .update(users)
      .set({ planId })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        age: users.age,
        planId: users.planId,
      });

    return user;
  }
}
