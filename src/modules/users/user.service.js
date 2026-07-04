import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

export default class UserService {
  constructor(userRepository, planRepository) {
    this.userRepository = userRepository;
    this.planRepository = planRepository;
  }

  async createUser({ name, email, password, age, planId }) {
    const existsUser = await this.userRepository.getUserByEmail(email);
    if (existsUser) {
      const error = new Error("E-mail já cadastrado");
      error.statusCode = 409;
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
    });

    return { user, message: "Usuário criado com sucesso" };
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

    const plan = user.planId
      ? await this.planRepository.getPlanById(user.planId)
      : null;

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        age: user.age,
        planId: user.planId,
        plan: plan
          ? { id: plan.id, name: plan.name, price: plan.price }
          : null,
      },
    };
  }

  async updatePlan(userId, planId) {
    const plan = await this.planRepository.getPlanById(Number(planId));
    if (!plan) {
      const error = new Error("Plano informado não existe");
      error.statusCode = 400;
      throw error;
    }

    const user = await this.userRepository.updatePlan(userId, plan.id);
    return {
      user,
      plan: { id: plan.id, name: plan.name, price: plan.price },
      message: "Plano atualizado com sucesso",
    };
  }
}
