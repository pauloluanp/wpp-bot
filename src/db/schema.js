import {
  pgTable,
  serial,
  varchar,
  timestamp,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  age: integer("age"),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  sessionId: varchar("session_id", { length: 255 }),
  sourceGroup: varchar("source_group", { length: 255 }),
  targetGroup: varchar("target_group", { length: 255 }),
  status: boolean("status").default(false),
  categoryId: integer("category_id")
    .references(() => categories.id)
    .default(null),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }),
});
