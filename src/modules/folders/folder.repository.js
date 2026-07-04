import { eq } from "drizzle-orm";
import { folders } from "../../db/schema.js";

export default class FolderRepository {
  constructor(db) {
    this.db = db;
  }

  async createFolder(userId, name) {
    const [folder] = await this.db
      .insert(folders)
      .values({ name, userId })
      .returning({
        id: folders.id,
        name: folders.name,
        userId: folders.userId,
        createdAt: folders.createdAt,
      });

    return folder;
  }

  async listFolders(userId) {
    return this.db
      .select({
        id: folders.id,
        name: folders.name,
        createdAt: folders.createdAt,
      })
      .from(folders)
      .where(eq(folders.userId, userId));
  }
}
