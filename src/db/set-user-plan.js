import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { plans, users } from "./schema.js";
import UserRepository from "../modules/users/user.repository.js";

// Ferramenta de ADMIN para aplicar o plano de um usuário após a confirmação do
// pagamento (o fluxo do usuário é: solicitar via WhatsApp -> pagar -> admin roda
// este script). Uso:
//   npm run db:set-plan -- <email> <nomeOuIdDoPlano>
// Ex.:
//   npm run db:set-plan -- cliente@exemplo.com pro
//   npm run db:set-plan -- cliente@exemplo.com 3
const [email, planoArg] = process.argv.slice(2);

async function main() {
  if (!email || !planoArg) {
    console.error("Uso: npm run db:set-plan -- <email> <nomeOuIdDoPlano>");
    console.error("Ex.:  npm run db:set-plan -- cliente@exemplo.com pro");
    process.exit(1);
  }

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    console.error(`❌ Usuário com e-mail "${email}" não encontrado.`);
    process.exit(1);
  }

  // Aceita id numérico ou nome do plano (nomes são salvos em minúsculas).
  const ehId = /^\d+$/.test(planoArg);
  const [plan] = ehId
    ? await db.select().from(plans).where(eq(plans.id, Number(planoArg)))
    : await db
        .select()
        .from(plans)
        .where(eq(plans.name, planoArg.toLowerCase()));

  if (!plan) {
    const disponiveis = await db
      .select({ id: plans.id, name: plans.name })
      .from(plans);
    console.error(`❌ Plano "${planoArg}" não encontrado.`);
    console.error(
      "   Planos disponíveis:",
      disponiveis.map((p) => `${p.id}:${p.name}`).join(", ")
    );
    process.exit(1);
  }

  const userRepo = new UserRepository(db);
  const atualizado = await userRepo.updatePlan(user.id, plan.id);

  console.log(
    `✅ Plano de ${user.email} atualizado para "${plan.name}" (R$ ${plan.price}).`
  );
  console.log("   Usuário:", atualizado);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Erro ao aplicar o plano:", error);
    process.exit(1);
  });
