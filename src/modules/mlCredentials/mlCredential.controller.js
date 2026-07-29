export default class MlCredentialController {
  constructor(mlCredentialService) {
    this.mlCredentialService = mlCredentialService;
  }

  // `:id` na rota é o nome da margem (sessions.sessionId).
  getCredentials = async (req, res) => {
    try {
      const credentials = await this.mlCredentialService.getCredentials(
        req.user.id,
        req.params.id
      );
      return res.json(credentials);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };

  saveCredentials = async (req, res) => {
    const { mlAffiliateTag, cookieString, csrfToken } = req.body;

    try {
      const credentials = await this.mlCredentialService.saveCredentials(
        req.user.id,
        req.params.id,
        { mlAffiliateTag, cookieString, csrfToken }
      );
      return res.json(credentials);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };
}
