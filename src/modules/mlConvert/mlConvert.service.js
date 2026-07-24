import { convertToAffiliate, ML_ERROR } from "../../lib/mercadoLivre/mlAffiliate.service.js";
import { convertMessageText } from "../../lib/mercadoLivre/linkReplacer.js";

// Tradução dos erros de conversão para status HTTP. O front usa o 502 de
// credentials_expired para mandar o usuário renovar cookie/CSRF no painel.
const STATUS_BY_ERROR = {
  [ML_ERROR.UNSUPPORTED_STORE]: 400,
  [ML_ERROR.PRODUCT_NOT_FOUND]: 422,
  [ML_ERROR.MISSING_CREDENTIALS]: 409,
  [ML_ERROR.CREDENTIALS_EXPIRED]: 502,
  [ML_ERROR.RATE_LIMITED]: 429,
};

const MESSAGE_BY_ERROR = {
  [ML_ERROR.UNSUPPORTED_STORE]: "A URL não é do Mercado Livre",
  [ML_ERROR.PRODUCT_NOT_FOUND]: "Não foi possível identificar o produto nesse link",
  [ML_ERROR.MISSING_CREDENTIALS]:
    "Cadastre suas credenciais do Mercado Livre antes de converter links",
  [ML_ERROR.CREDENTIALS_EXPIRED]:
    "Suas credenciais do Mercado Livre expiraram. Atualize o cookie e o CSRF token no painel",
  [ML_ERROR.RATE_LIMITED]: "O Mercado Livre está limitando as requisições. Tente em instantes",
};

function toHttpError(type) {
  const error = new Error(
    MESSAGE_BY_ERROR[type] || "Não foi possível converter o link do Mercado Livre",
  );
  error.statusCode = STATUS_BY_ERROR[type] || 502;
  error.mlError = type;
  return error;
}

export default class MlConvertService {
  // Reusa o MlCredentialService: ele já valida o plano premium e busca as
  // credenciais do usuário.
  constructor(mlCredentialService) {
    this.mlCredentialService = mlCredentialService;
  }

  async #getCredentials(userId) {
    const credentials = await this.mlCredentialService.getCredentials(userId);

    if (!credentials.mlAffiliateTag || !credentials.cookieString) {
      throw toHttpError(ML_ERROR.MISSING_CREDENTIALS);
    }

    return credentials;
  }

  async convertUrl(userId, url) {
    const credentials = await this.#getCredentials(userId);
    const result = await convertToAffiliate(url, credentials);

    if (!result.affiliate) throw toHttpError(result.error.type);

    return { affiliate: result.affiliate, original: result.original };
  }

  // Converte todos os links do ML dentro de um texto de promoção — é exatamente
  // o que o bot faz antes de repassar a mensagem aos grupos.
  async convertText(userId, text) {
    const credentials = await this.#getCredentials(userId);
    const result = await convertMessageText(text, credentials, userId);

    if (result.failed) throw toHttpError(result.failed.type);

    return { text: result.text, hadMercadoLivre: result.hadMl };
  }
}
