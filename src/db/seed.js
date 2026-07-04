import "dotenv/config";
import { db } from "./index.js";
import { plans } from "./schema.js";

// Planos padrão do sistema. A coluna `details` (jsonb) guarda a descrição,
// os recursos e os limites de cada plano.
const defaultPlans = [
  {
    name: "básico",
    price: 100,
    details: {
      descricao: "Ideal para quem está começando a automatizar.",
      recursos: [
        "Painel de monitoramento básico",
        "Replicação de mídia simples",
        "Suporte por e-mail",
      ],
      limites: {
        sessoes: 1,
        pastas: 3,
      },
    },
  },
  {
    name: "pro",
    price: 200,
    details: {
      descricao: "Para profissionais que precisam escalar a operação.",
      recursos: [
        "Delay inteligente anti-ban",
        "Reencaminhamento por tipo de segmento",
        "Suporte prioritário",
      ],
      limites: {
        sessoes: 5,
        pastas: 10,
      },
    },
  },
  {
    name: "premium",
    price: 300,
    details: {
      descricao: "Para grandes operações e agências.",
      recursos: [
        "Sessões ilimitadas",
        "Painel de mensagens customizado",
        "API de integração e webhooks",
        "Suporte dedicado",
      ],
      limites: {
        sessoes: -1, // -1 = ilimitado
        pastas: -1,
      },
    },
  },
];

async function seedPlans() {
  console.log("🌱 Populando a tabela de planos...");

  for (const plan of defaultPlans) {
    await db
      .insert(plans)
      .values(plan)
      .onConflictDoUpdate({
        target: plans.name,
        set: { price: plan.price, details: plan.details },
      });

    console.log(`   ✅ Plano "${plan.name}" (R$ ${plan.price}) garantido.`);
  }

  console.log("🌱 Seed de planos concluído.");
}

seedPlans()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Erro ao rodar o seed de planos:", error);
    process.exit(1);
  });
