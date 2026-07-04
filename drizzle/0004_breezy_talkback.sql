ALTER TABLE "categories" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "categories" CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_category_id_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "category_id";