import { updateSessionConfig } from "../../manager.js";

// Planos que liberam a integração com o Mercado Livre. O backend é a autoridade
// real (o front apenas esconde o recurso para quem não tem acesso).
const PREMIUM_PLANS = ["premium"];

export default class MlCredentialService {
  constructor(
    mlCredentialRepository,
    userRepository,
    planRepository,
    sessionRepository
  ) {
    this.mlCredentialRepository = mlCredentialRepository;
    this.userRepository = userRepository;
    this.planRepository = planRepository;
    this.sessionRepository = sessionRepository;
  }

  // Garante que o usuário existe e tem plano premium; caso contrário lança 403.
  async #assertPremium(userId) {
    const user = await this.userRepository.getUserById(userId);
    if (!user) {
      const error = new Error("Usuário não encontrado");
      error.statusCode = 404;
      throw error;
    }

    const plan = user.planId
      ? await this.planRepository.getPlanById(user.planId)
      : null;

    if (!plan || !PREMIUM_PLANS.includes(plan.name)) {
      const error = new Error(
        "Recurso disponível apenas para assinantes do plano Premium"
      );
      error.statusCode = 403;
      throw error;
    }
  }

  // Confirma que a margem (nome) pertence ao usuário e devolve a linha da sessão
  // (com o id serial usado como chave das credenciais).
  async #resolveOwnedSession(userId, sessionName) {
    const rows = await this.sessionRepository.getSessionById(sessionName, userId);
    const session = rows?.[0];
    if (!session) {
      const error = new Error("Margem não encontrada");
      error.statusCode = 404;
      throw error;
    }
    return session;
  }

  // Monta a resposta pública, sempre com os três campos (strings vazias quando
  // ainda não há credenciais salvas), no formato que o front espera.
  #toResponse(row) {
    return {
      mlAffiliateTag: row?.mlAffiliateTag ?? "",
      cookieString: row?.cookieString ?? "",
      csrfToken: row?.csrfToken ?? "",
    };
  }

  async getCredentials(userId, sessionName) {
    await this.#assertPremium(userId);
    const session = await this.#resolveOwnedSession(userId, sessionName);
    const row = await this.mlCredentialRepository.getBySessionId(session.id);
    return this.#toResponse(row);
  }

  async saveCredentials(userId, sessionName, { mlAffiliateTag, cookieString, csrfToken }) {
    await this.#assertPremium(userId);
    const session = await this.#resolveOwnedSession(userId, sessionName);

    if (!mlAffiliateTag || !mlAffiliateTag.trim()) {
      const error = new Error("A ML_AFFILIATE_TAG é obrigatória");
      error.statusCode = 400;
      throw error;
    }

    const trimmedTag = mlAffiliateTag.trim();
    const trimmedCookie = (cookieString ?? "").trim();
    const trimmedCsrf = (csrfToken ?? "").trim();

    const row = await this.mlCredentialRepository.upsert(session.id, {
      mlAffiliateTag: trimmedTag,
      cookieString: trimmedCookie,
      csrfToken: trimmedCsrf,
    });

    // A margem só converte de fato com tag + cookie (sem cookie, a conversão
    // descartaria tudo). O flag `convert_link` deriva disso: marca no banco (para
    // o badge/estado) e atualiza a sessão em execução para valer sem reiniciar.
    const converts = Boolean(trimmedTag && trimmedCookie);
    await this.sessionRepository.setConvertLink(sessionName, userId, converts);
    updateSessionConfig(sessionName, { convertLink: converts });

    return this.#toResponse(row);
  }
}
