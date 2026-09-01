export default class SessionController {
  constructor(sessionService) {
    this.sessionService = sessionService;
  }

  createSession = async (req, res) => {
    const { sessionId, sourceGroupPrefix, targetGroupPrefix, folderId, groupInviteLink } = req.body;
    const userId = req.user.id;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId obrigatório' });
    }

    // O front envia "geral" (pasta virtual padrão) ou o id numérico de uma pasta.
    // Qualquer valor não numérico é tratado como "sem pasta" (null).
    const normalizedFolderId =
      folderId != null && !Number.isNaN(Number(folderId))
        ? Number(folderId)
        : null;

    try {
      const session = await this.sessionService.createSession(
        userId,
        sessionId,
        sourceGroupPrefix,
        targetGroupPrefix,
        normalizedFolderId,
        groupInviteLink
      );
      return res.json(session);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  startSession = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    try {
      const session = await this.sessionService.startSession(sessionId, userId);
      return res.json(session);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  stopSession = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    try {
      const session = await this.sessionService.stopSession(sessionId, userId);
      return res.json(session);
    } catch (error) {
       return res.status(500).json({ error: error.message });
    }
  };

  listSessions = async (req, res) => {
    const userId = req.user.id;

    try {
      const sessions = await this.sessionService.listSessions(userId);
      
      const total = sessions.length;
      const active = sessions.filter(s => s.status).length;
      const inactive = total - active;

      return res.json({
        total,
        active,
        inactive,
        data: sessions
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  // `:id` aceita o id numérico da margem (caminho atual) ou o nome/slug
  // (fallback de compatibilidade com o front antigo).
  deleteSession = async (req, res) => {
    const { id: identificador } = req.params;
    const userId = req.user.id;
    try {
      const session = await this.sessionService.deleteSession(
        identificador,
        userId
      );
      return res.json(session);
    } catch (error) {
      const status = error.message === "Sessão não encontrada" ? 404 : 500;
      return res.status(status).json({ error: error.message });
    }
  };

  getQRCode = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    try {
      const result = await this.sessionService.getQRCode(sessionId, userId);
      
      if (!result) {
        return res.status(404).json({
          error: 'Timeout. QR Code não foi gerado a tempo, tente novamente.'
        });
      }

      if (result.status === 'CONNECTED') {
        return res.status(400).json({
          error: 'A sessão já está conectada. Crie uma nova sessão se desejar escanear novamente.'
        });
      }

      return res.json({ qr: result.qr });
    } catch (error) {
       return res.status(500).json({ error: error.message });
    }
  };

  updateSessionConfig = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    const { sourceGroup, targetGroup, delayMs } = req.body;

    try {
      const session = await this.sessionService.updateSessionConfig(
        sessionId,
        userId,
        sourceGroup,
        targetGroup,
        delayMs
      );

      return res.json(session);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  updateGroupInvite = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    const { groupInviteLink } = req.body;

    try {
      const result = await this.sessionService.updateGroupInvite(
        sessionId,
        userId,
        groupInviteLink
      );
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  sendPromo = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    const { imageBase64, caption } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 obrigatório' });
    }

    if (!caption || !caption.trim()) {
      return res.status(400).json({ error: 'caption obrigatória' });
    }

    try {
      const result = await this.sessionService.sendPromo(sessionId, userId, {
        imageBase64,
        caption: caption.trim(),
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  getPendingMessages = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    try {
      const pending = await this.sessionService.getPendingMessages(sessionId, userId);
      return res.json({ pending });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
}
