import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const plans = pgTable("plans", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  price: integer("price").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  // Papel do usuário: "admin" (pode cadastrar novos usuários) ou "user" (comum).
  role: varchar("role", { length: 20 }).notNull().default("user"),
  age: integer("age"),
  planId: integer("plan_id").references(() => plans.id),
});

export const folders = pgTable("folders", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  userId: integer("user_id").references(() => users.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  sessionId: varchar("session_id", { length: 255 }),
  sourceGroup: varchar("source_group", { length: 255 }),
  targetGroup: varchar("target_group", { length: 255 }),
  status: boolean("status").default(false),
  // Quando true, a margem só repassa promoções do Mercado Livre (com link de
  // afiliado). Quando false, repassa todas as mensagens como estão.
  convertLink: boolean("convert_link").notNull().default(false),
  folderId: integer("folder_id").references(() => folders.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// Credenciais do Mercado Livre por margem/sessão (1:1). Usadas para gerar os
// links de afiliado. `cookie_string`/`csrf_token` são longos e expiram
// periodicamente. Ter credenciais é o que faz a margem "converter".
export const mlCredentials = pgTable("ml_credentials", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .references(() => sessions.id)
    .notNull()
    .unique(),
  mlAffiliateTag: varchar("ml_affiliate_tag", { length: 255 }),
  cookieString: text("cookie_string"),
  csrfToken: text("csrf_token"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});
