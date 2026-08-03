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
    label: "Garantindo coluna sessions.user_id",
    query: sql`ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "user_id" integer`,
  },
  {
    label: "Garantindo coluna sessions.folder_id",
    query: sql`ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "folder_id" integer`,
  },
  {
    label: "Garantindo coluna sessions.convert_link",
    query: sql`ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "convert_link" boolean DEFAULT false NOT NULL`,
  },
  {
    label: "Garantindo coluna sessions.group_invite_link",
    query: sql`ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "group_invite_link" varchar(500)`,
  },
  {
    label: "Garantindo coluna users.plan_id",
    query: sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_id" integer`,
  },
  {
    label: "Garantindo coluna users.role",
    query: sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" varchar(20) DEFAULT 'user' NOT NULL`,
  },
  {
    // Cria a tabela já no formato novo (por sessão) em bancos zerados. Em bancos
    // que já tinham a versão por-usuário, os passos seguintes fazem a migração.
    label: "Garantindo tabela ml_credentials",
    query: sql`CREATE TABLE IF NOT EXISTS "ml_credentials" (
      "id" serial PRIMARY KEY NOT NULL,
      "session_id" integer,
      "ml_affiliate_tag" varchar(255),
      "cookie_string" text,
      "csrf_token" text,
      "created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
      "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    // Migração user_id -> session_id (idempotente). Ordem: adiciona session_id,
    // remove constraints antigas, descarta linhas por-usuário órfãs, dropa user_id.
    label: "Migrando ml_credentials para session_id",
    query: sql`ALTER TABLE "ml_credentials" ADD COLUMN IF NOT EXISTS "session_id" integer`,
  },
  {
    label: "Removendo constraints legadas de ml_credentials.user_id",
    query: sql`DO $$ BEGIN
      ALTER TABLE "ml_credentials" DROP CONSTRAINT IF EXISTS "ml_credentials_user_id_users_id_fk";
      ALTER TABLE "ml_credentials" DROP CONSTRAINT IF EXISTS "ml_credentials_user_id_unique";
    END $$`,
  },
  {
    // Linhas antigas (por usuário) não têm session_id e não têm como ser mapeadas.
    label: "Descartando credenciais órfãs (sem session_id)",
    query: sql`DELETE FROM "ml_credentials" WHERE "session_id" IS NULL`,
  },
  {
    label: "Removendo coluna legada ml_credentials.user_id",
    query: sql`ALTER TABLE "ml_credentials" DROP COLUMN IF EXISTS "user_id"`,
  },
  {
    label: "Garantindo ml_credentials.session_id NOT NULL",
    query: sql`ALTER TABLE "ml_credentials" ALTER COLUMN "session_id" SET NOT NULL`,
  },
  {
    label: "Garantindo UNIQUE ml_credentials.session_id",
    query: sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ml_credentials_session_id_unique') THEN
        ALTER TABLE "ml_credentials" ADD CONSTRAINT "ml_credentials_session_id_unique" UNIQUE ("session_id");
      END IF;
    END $$`,
  },
  {
    label: "Garantindo FK ml_credentials.session_id -> sessions.id",
    query: sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ml_credentials_session_id_sessions_id_fk') THEN
        ALTER TABLE "ml_credentials" ADD CONSTRAINT "ml_credentials_session_id_sessions_id_fk"
          FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;
      END IF;
    END $$`,
  },
  {
    label: "Garantindo FK sessions.user_id -> users.id",
    query: sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_user_id_users_id_fk') THEN
        ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "users"("id");
      END IF;
    END $$`,
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
