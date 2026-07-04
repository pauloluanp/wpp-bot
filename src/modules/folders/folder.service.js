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
}
