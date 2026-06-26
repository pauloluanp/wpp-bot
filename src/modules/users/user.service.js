import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

export default class UserService {
  constructor(userRepository) {
    this.userRepository = userRepository;
  }

  async createUser({ name, email, password, age }) {
    const existsUser = await this.userRepository.getUserByEmail(email);
    if (existsUser) {
      const error = new Error("E-mail já cadastrado");
      error.statusCode = 409;
      throw error;
    }

    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const user = await this.userRepository.createUser({
      name,
      email,
      passwordHash,
      age,
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

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        age: user.age,
      },
    };
  }
}
