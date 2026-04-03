import { mysqlTable, int, varchar, timestamp, boolean } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

export const users = mysqlTable("users", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }),
  age: int("age"),
});

export const sessions = mysqlTable("sessions", {
  id: int("id").primaryKey().autoincrement(),
  sessionId: varchar("session_id", { length: 255 }),
  sourceGroup: varchar("source_group", { length: 255 }),
  targetGroup: varchar("target_group", { length: 255 }),
  status: boolean("status").default(false) ,
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});