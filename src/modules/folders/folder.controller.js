export default class FolderController {
  constructor(folderService) {
    this.folderService = folderService;
  }

  createFolder = async (req, res) => {
    const { nome } = req.body;
    const userId = req.user.id;

    if (!nome || !nome.trim()) {
      return res.status(400).json({ error: "Nome da pasta é obrigatório" });
    }

    try {
      const folder = await this.folderService.createFolder(userId, nome.trim());
      return res.status(201).json(folder);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  listFolders = async (req, res) => {
    const userId = req.user.id;

    try {
      const folders = await this.folderService.listFolders(userId);
      return res.json(folders);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
}
