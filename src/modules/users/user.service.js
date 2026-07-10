import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

// Papéis válidos de usuário. "user" é o padrão (comum); "admin" pode cadastrar
// novos usuários.
const VALID_ROLES = ["admin", "user"];

export default class UserService {
  constructor(userRepository, planRepository) {
    this.userRepository = userRepository;
    this.planRepository = planRepository;
  }

  async createUser({ name, email, password, age, planId, role }) {
    const existsUser = await this.userRepository.getUserByEmail(email);
    if (existsUser) {
      const error = new Error("E-mail já cadastrado");
      error.statusCode = 409;
      throw error;
    }

    // Papel: usa o informado (se válido) ou cai no padrão "user" quando ausente.
    const resolvedRole = role ? role : "user";
    if (!VALID_ROLES.includes(resolvedRole)) {
      const error = new Error(
        `Papel inválido. Valores aceitos: ${VALID_ROLES.join(", ")}`
      );
      error.statusCode = 400;
      throw error;
    }

    // Define o plano: usa o informado (se válido) ou cai no plano padrão (básico).
    let resolvedPlanId = null;
    if (planId) {
      const plan = await this.planRepository.getPlanById(Number(planId));
      if (!plan) {
        const error = new Error("Plano informado não existe");
        error.statusCode = 400;
        throw error;
      }
      resolvedPlanId = plan.id;
    } else {
      const defaultPlan = await this.planRepository.getDefaultPlan();
      resolvedPlanId = defaultPlan ? defaultPlan.id : null;
    }

    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const user = await this.userRepository.createUser({
      name,
      email,
      passwordHash,
      age,
      planId: resolvedPlanId,
      role: resolvedRole,
    });

    return { user, message: "Usuário criado com sucesso" };
  }

  // Lista todos os usuários (uso administrativo). Retorna o total junto para o
  // painel, no mesmo formato { total, data } usado em outras listagens do front.
  async listUsers() {
    const data = await this.userRepository.listUsers();
    return { total: data.length, data };
  }

  async login({ email, password }) {
    const user = await this.userRepository.getUserByEmail(email);
    if (!user) {
      const error = new Error("E-mail ou senha inválidos");
      error.statusCode = 401;
      throw error;
    }

    const passwordIsValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordIsValid) {
      const error = new Error("E-mail ou senha inválidos");
      error.statusCode = 401;
      throw error;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      const error = new Error("JWT_SECRET não configurado");
      error.statusCode = 500;
      throw error;
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      secret,
      { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
    );

    return {
      token,
      user: await this.#buildUserResponse(user),
    };
  }

  // Monta o objeto público do usuário (sem hash de senha) já com o plano embutido.
  async #buildUserResponse(user) {
    const plan = user.planId
      ? await this.planRepository.getPlanById(user.planId)
      : null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      age: user.age,
      planId: user.planId,
      plan: plan
        ? {
            id: plan.id,
            name: plan.name,
            price: plan.price,
            details: plan.details,
          }
        : null,
    };
  }

  async getMe(userId) {
    const user = await this.userRepository.getUserById(userId);
    if (!user) {
      const error = new Error("Usuário não encontrado");
      error.statusCode = 404;
      throw error;
    }

    return this.#buildUserResponse(user);
  }

  async updateProfile(userId, { name, age }) {
    const current = await this.userRepository.getUserById(userId);
    if (!current) {
      const error = new Error("Usuário não encontrado");
      error.statusCode = 404;
      throw error;
    }

    // Mantém o valor atual quando o campo não é enviado.
    const updated = await this.userRepository.updateProfile(userId, {
      name: name !== undefined ? name : current.name,
      age: age !== undefined ? age : current.age,
    });

    return {
      user: await this.#buildUserResponse(updated),
      message: "Perfil atualizado com sucesso",
    };
  }

  async changePassword(userId, { currentPassword, newPassword }) {
    if (!newPassword || newPassword.length < 6) {
      const error = new Error("A nova senha deve ter ao menos 6 caracteres");
      error.statusCode = 400;
      throw error;
    }

    const user = await this.userRepository.getUserById(userId);
    if (!user) {
      const error = new Error("Usuário não encontrado");
      error.statusCode = 404;
      throw error;
    }

    const currentIsValid = await bcrypt.compare(
      currentPassword || "",
      user.passwordHash
    );
    if (!currentIsValid) {
      const error = new Error("Senha atual incorreta");
      error.statusCode = 401;
      throw error;
    }

    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);
    await this.userRepository.updatePassword(userId, passwordHash);

    return { message: "Senha alterada com sucesso" };
  }
}
