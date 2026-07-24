export default class MlConvertController {
  constructor(mlConvertService) {
    this.mlConvertService = mlConvertService;
  }

  // Aceita { url } para converter um link único ou { text } para converter todos
  // os links do Mercado Livre dentro do texto de uma promoção.
  convert = async (req, res) => {
    const { url, text } = req.body || {};

    if (!url && !text) {
      return res.status(400).json({ error: 'Informe "url" ou "text"' });
    }

    try {
      const result = url
        ? await this.mlConvertService.convertUrl(req.user.id, url)
        : await this.mlConvertService.convertText(req.user.id, text);

      return res.json(result);
    } catch (error) {
      return res
        .status(error.statusCode || 500)
        .json({ error: error.message, type: error.mlError });
    }
  };
}
