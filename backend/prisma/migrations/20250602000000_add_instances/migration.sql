-- Add instance_id to models table
ALTER TABLE "models" ADD COLUMN "instance_id" INTEGER;

-- Create instances table
CREATE TABLE "instances" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "inbound_model_id" VARCHAR(255) NOT NULL,
  "inbound_source_id" INTEGER NOT NULL,
  "outbound_model_id" VARCHAR(255) NOT NULL,
  "stack_mode" VARCHAR(50) NOT NULL DEFAULT 'merged',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "instances_outbound_model_id_unique" UNIQUE ("outbound_model_id")
);

-- Create instance_members table
CREATE TABLE "instance_members" (
  "id" SERIAL PRIMARY KEY,
  "instance_id" INTEGER NOT NULL,
  "source_id" INTEGER NOT NULL,
  "weight" INTEGER NOT NULL DEFAULT 1,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "instance_members_instance_source_unique" UNIQUE ("instance_id", "source_id")
);

-- Add foreign key constraints
ALTER TABLE "instance_members" ADD CONSTRAINT "instance_members_instance_id_fkey"
  FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE CASCADE;
