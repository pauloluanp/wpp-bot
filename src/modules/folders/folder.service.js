export default class FolderService {
  constructor(folderRepository) {
    this.folderRepository = folderRepository;
  }

  async createFolder(userId, name) {
    const folder = await this.folderRepository.createFolder(userId, name);
    return { id: folder.id, nome: folder.name };
  }

  async listFolders(userId) {
    const folders = await this.folderRepository.listFolders(userId);
    // O front espera cada pasta no formato { id, nome }
    return folders.map((folder) => ({ id: folder.id, nome: folder.name }));
  }

  async updateFolder(userId, id, name) {
    const existsFolder = await this.folderRepository.getFolderById(id, userId);
    if (!existsFolder) {
      throw new Error("Pasta não encontrada");
    }

    const folder = await this.folderRepository.updateFolder(id, userId, name);
    return { id: folder.id, nome: folder.name };
  }

  async deleteFolder(userId, id) {
    const existsFolder = await this.folderRepository.getFolderById(id, userId);
    if (!existsFolder) {
      throw new Error("Pasta não encontrada");
    }

    // As margens da pasta não são apagadas: voltam para a pasta "Geral".
    await this.folderRepository.detachSessions(id, userId);
    await this.folderRepository.deleteFolder(id, userId);

    return { id };
  }
}
