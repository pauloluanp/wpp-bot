import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

// Autoriza apenas administradores. Deve rodar SEMPRE após o authMiddleware, que
// popula req.user.id a partir do token. O papel é lido do banco (não do token)
// para refletir promoções/rebaixamentos na hora, sem depender de novo login.
export async function adminMiddleware(req, res, next) {
  try {
    const [user] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, req.user.id));

    if (!user || user.role !== "admin") {
      return res
        .status(403)
        .json({ error: "Acesso restrito a administradores" });
    }

    return next();
  } catch (error) {
    return res.status(500).json({ error: "Erro ao verificar permissão" });
  }
}
