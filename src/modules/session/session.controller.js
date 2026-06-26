export default class SessionController {
  constructor(sessionService) {
    this.sessionService = sessionService;
  }

  createSession = async (req, res) => {
    const { sessionId, sourceGroupPrefix, targetGroupPrefix } = req.body;
    const userId = req.user.id;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId obrigatório' });
    }

    try {
      const session = await this.sessionService.createSession(
        userId,
        sessionId,
        sourceGroupPrefix,
        targetGroupPrefix
      );
      return res.json(session);
    } catch (error) {
      return res.status(500).json({ error: error.message });
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

  deleteSession = async (req, res) => {
    const { id: sessionId } = req.params;
    const userId = req.user.id;
    try {
      const session = await this.sessionService.deleteSession(sessionId, userId);
      return res.json(session);
    } catch (error) {
      return res.status(500).json({ error: error.message });
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
