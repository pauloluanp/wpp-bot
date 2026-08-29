import { and, eq } from "drizzle-orm";
import { folders, sessions } from "../../db/schema.js";

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

  async getFolderById(id, userId) {
    const [folder] = await this.db
      .select({
        id: folders.id,
        name: folders.name,
        userId: folders.userId,
      })
      .from(folders)
      .where(and(eq(folders.id, id), eq(folders.userId, userId)));

    return folder;
  }

  async updateFolder(id, userId, name) {
    const [folder] = await this.db
      .update(folders)
      .set({ name })
      .where(and(eq(folders.id, id), eq(folders.userId, userId)))
      .returning({
        id: folders.id,
        name: folders.name,
      });

    return folder;
  }

  /**
   * Solta as margens da pasta (folder_id = NULL), fazendo com que voltem para a
   * pasta virtual "Geral". Precisa rodar ANTES do delete: a FK
   * sessions.folder_id -> folders.id é ON DELETE NO ACTION, então excluir uma
   * pasta que ainda tenha margens estoura violação de chave estrangeira.
   */
  async detachSessions(folderId, userId) {
    return this.db
      .update(sessions)
      .set({ folderId: null })
      .where(and(eq(sessions.folderId, folderId), eq(sessions.userId, userId)));
  }

  async deleteFolder(id, userId) {
    const [folder] = await this.db
      .delete(folders)
      .where(and(eq(folders.id, id), eq(folders.userId, userId)))
      .returning({ id: folders.id });

    return folder;
  }
}
