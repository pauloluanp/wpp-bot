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

  updateFolder = async (req, res) => {
    const { nome } = req.body;
    const userId = req.user.id;
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Id da pasta inválido" });
    }

    if (!nome || !nome.trim()) {
      return res.status(400).json({ error: "Nome da pasta é obrigatório" });
    }

    try {
      const folder = await this.folderService.updateFolder(
        userId,
        id,
        nome.trim(),
      );
      return res.json(folder);
    } catch (error) {
      const status = error.message === "Pasta não encontrada" ? 404 : 500;
      return res.status(status).json({ error: error.message });
    }
  };

  deleteFolder = async (req, res) => {
    const userId = req.user.id;
    const id = Number(req.params.id);

    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Id da pasta inválido" });
    }

    try {
      const folder = await this.folderService.deleteFolder(userId, id);
      return res.json(folder);
    } catch (error) {
      const status = error.message === "Pasta não encontrada" ? 404 : 500;
      return res.status(status).json({ error: error.message });
    }
  };
}
