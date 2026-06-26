import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const [, token] = authHeader?.split(" ") || [];

  if (!token) {
    return res.status(401).json({ error: "Usuário não autorizado" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "JWT_SECRET não configurado" });
  }

  try {
    req.user = jwt.verify(token, secret);
    return next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expirado" });
    }

    return res.status(403).json({ error: "Token inválido" });
  }
}
