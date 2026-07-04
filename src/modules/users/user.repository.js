import { eq } from "drizzle-orm";
import { users } from "../../db/schema.js";

export default class UserRepository {
  constructor(db) {
    this.db = db;
  }

  async createUser({ name, email, passwordHash, age, planId }) {
    const [user] = await this.db
      .insert(users)
      .values({ name, email, passwordHash, age, planId })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
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
