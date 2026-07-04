import "dotenv/config";
import { db } from "./index.js";
import { sql } from "drizzle-orm";

// Script idempotente para reconciliar o banco após a falha do `drizzle-kit push`
// (a ordem gerada tentava remover uma constraint que o DROP TABLE ... CASCADE já
// havia removido). Pode ser rodado quantas vezes precisar: só aplica o que falta.
const steps = [
  {
    label: "Garantindo tabela plans",
    query: sql`CREATE TABLE IF NOT EXISTS "plans" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" varchar(100) NOT NULL,
      "price" integer NOT NULL,
      "details" jsonb,
      "created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "plans_name_unique" UNIQUE ("name")
    )`,
  },
  {
    label: "Garantindo tabela folders",
    query: sql`CREATE TABLE IF NOT EXISTS "folders" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" varchar(255) NOT NULL,
      "user_id" integer,
      "created_at" timestamp DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    label: "Garantindo coluna sessions.folder_id",
    query: sql`ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "folder_id" integer`,
  },
  {
    label: "Garantindo coluna users.plan_id",
    query: sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_id" integer`,
  },
  {
    label: "Garantindo FK folders.user_id -> users.id",
    query: sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_user_id_users_id_fk') THEN
        ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "users"("id");
      END IF;
    END $$`,
  },
  {
    label: "Garantindo FK sessions.folder_id -> folders.id",
    query: sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_folder_id_folders_id_fk') THEN
        ALTER TABLE "sessions" ADD CONSTRAINT "sessions_folder_id_folders_id_fk"
          FOREIGN KEY ("folder_id") REFERENCES "folders"("id");
      END IF;
    END $$`,
  },
  {
    label: "Garantindo FK users.plan_id -> plans.id",
    query: sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_plan_id_plans_id_fk') THEN
        ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk"
          FOREIGN KEY ("plan_id") REFERENCES "plans"("id");
      END IF;
    END $$`,
  },
  {
    label: "Removendo coluna legada sessions.category_id",
    query: sql`ALTER TABLE "sessions" DROP COLUMN IF EXISTS "category_id"`,
  },
  {
    label: "Removendo tabela legada categories",
    query: sql`DROP TABLE IF EXISTS "categories" CASCADE`,
  },
];

async function repair() {
  console.log("🔧 Reconciliando o schema do banco...\n");

  for (const step of steps) {
    await db.execute(step.query);
    console.log(`   ✅ ${step.label}`);
  }

  console.log("\n🔧 Schema reconciliado com sucesso.");
}

repair()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Erro ao reconciliar o schema:", error);
    process.exit(1);
  });
