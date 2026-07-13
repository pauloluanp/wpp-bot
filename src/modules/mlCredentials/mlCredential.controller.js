export default class MlCredentialController {
  constructor(mlCredentialService) {
    this.mlCredentialService = mlCredentialService;
  }

  getCredentials = async (req, res) => {
    try {
      const credentials = await this.mlCredentialService.getCredentials(
        req.user.id
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
        { mlAffiliateTag, cookieString, csrfToken }
      );
      return res.json(credentials);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };
}
