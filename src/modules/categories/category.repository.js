import { categories } from "../../db/schema.js";

export default class CategoryRepository {
  constructor(db) {
    this.db = db;
  }

  async createCategory(name) {
    return this.db.insert(categories).values({ name });
  }

  async listCategories() {
    return this.db.select().from(categories);
  }
}
