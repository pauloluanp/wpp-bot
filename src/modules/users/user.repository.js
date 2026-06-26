import { eq } from "drizzle-orm";
import { users } from "../../db/schema.js";

export default class UserRepository {
  constructor(db) {
    this.db = db;
  }

  async createUser({ name, email, passwordHash, age }) {
    const [user] = await this.db
      .insert(users)
      .values({ name, email, passwordHash, age })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        age: users.age,
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
}
