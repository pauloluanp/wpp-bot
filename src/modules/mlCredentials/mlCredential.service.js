// Planos que liberam a integração com o Mercado Livre. O backend é a autoridade
// real (o front apenas esconde a tela para quem não tem acesso).
const PREMIUM_PLANS = ["premium"];

export default class MlCredentialService {
  constructor(mlCredentialRepository, userRepository, planRepository) {
    this.mlCredentialRepository = mlCredentialRepository;
    this.userRepository = userRepository;
    this.planRepository = planRepository;
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

  // Monta a resposta pública, sempre com os três campos (strings vazias quando
  // ainda não há credenciais salvas), no formato que o front espera.
  #toResponse(row) {
    return {
      mlAffiliateTag: row?.mlAffiliateTag ?? "",
      cookieString: row?.cookieString ?? "",
      csrfToken: row?.csrfToken ?? "",
    };
  }

  async getCredentials(userId) {
    await this.#assertPremium(userId);
    const row = await this.mlCredentialRepository.getByUserId(userId);
    return this.#toResponse(row);
  }

  async saveCredentials(userId, { mlAffiliateTag, cookieString, csrfToken }) {
    await this.#assertPremium(userId);

    if (!mlAffiliateTag || !mlAffiliateTag.trim()) {
      const error = new Error("A ML_AFFILIATE_TAG é obrigatória");
      error.statusCode = 400;
      throw error;
    }

    const row = await this.mlCredentialRepository.upsert(userId, {
      mlAffiliateTag: mlAffiliateTag.trim(),
      cookieString: (cookieString ?? "").trim(),
      csrfToken: (csrfToken ?? "").trim(),
    });

    return this.#toResponse(row);
  }
}
