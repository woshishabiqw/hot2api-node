-- CreateTable
CREATE TABLE "sources" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "base_url" TEXT NOT NULL,
    "protocol" VARCHAR(50) NOT NULL DEFAULT 'openai',
    "api_key" TEXT NOT NULL DEFAULT '',
    "weight" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "max_concurrent" INTEGER NOT NULL DEFAULT 1000000,
    "current_concurrent" INTEGER NOT NULL DEFAULT 0,
    "total_requests" BIGINT NOT NULL DEFAULT 0,
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "last_check_at" TIMESTAMP(6),
    "last_check_status_code" INTEGER,
    "last_check_detail" TEXT,
    "status" VARCHAR(50) NOT NULL DEFAULT 'unknown',
    "quota_limit" INTEGER NOT NULL DEFAULT 1000000,
    "quota_used" INTEGER NOT NULL DEFAULT 0,
    "strip_tools" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_group" TEXT,
    "balance_group" TEXT,
    "stack_mode" VARCHAR(50),
    "api_keys" TEXT,
    "api_urls" TEXT,
    "last_probe_at" TIMESTAMP(6),

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "models" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "model_id" VARCHAR(255) NOT NULL,
    "source_model_id" VARCHAR(255),
    "model_alias" VARCHAR(255),
    "input_price" DOUBLE PRECISION NOT NULL DEFAULT 0.025,
    "input_price_cache" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "output_price" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "max_tokens" INTEGER NOT NULL DEFAULT 4096,
    "is_vision" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "supports_tools" BOOLEAN NOT NULL DEFAULT true,
    "supports_json" BOOLEAN NOT NULL DEFAULT true,
    "supports_fim" BOOLEAN NOT NULL DEFAULT false,
    "max_concurrent" INTEGER NOT NULL DEFAULT 100,
    "model_group" TEXT NOT NULL DEFAULT 'default',
    "completion_price" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "rate_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_groups" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "rate_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_groups_name_key" ON "model_groups"("name");

-- CreateTable
CREATE TABLE "model_concurrent_tracker" (
    "user_id" INTEGER NOT NULL,
    "model_id" VARCHAR(255) NOT NULL,
    "current_concurrent" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "model_concurrent_tracker_pkey" PRIMARY KEY ("user_id","model_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'user',
    "quota_limit" INTEGER NOT NULL DEFAULT 0,
    "quota_used" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_requests" BIGINT NOT NULL DEFAULT 0,
    "total_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'CNY',
    "quota_type" VARCHAR(20) NOT NULL DEFAULT 'currency',
    "second_password_hash" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateTable
CREATE TABLE "user_keys" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "max_concurrent" INTEGER NOT NULL DEFAULT 500,
    "current_concurrent" INTEGER NOT NULL DEFAULT 0,
    "total_requests" BIGINT NOT NULL DEFAULT 0,
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "rate_limit" INTEGER NOT NULL DEFAULT 60,
    "last_used_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model_limit" TEXT NOT NULL DEFAULT 'all',
    "group_limit" TEXT NOT NULL DEFAULT 'all',
    "expires_at" TIMESTAMP(6),
    "quota_limit" INTEGER NOT NULL DEFAULT 0,
    "quota_used" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'CNY',
    "quota_type" VARCHAR(20) NOT NULL DEFAULT 'tokens',
    "encrypted_key" TEXT,

    CONSTRAINT "user_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "user_key_id" INTEGER,
    "source_id" INTEGER,
    "model" VARCHAR(255),
    "protocol" VARCHAR(50),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_creation_tokens" INTEGER NOT NULL DEFAULT 0,
    "uncached_tokens" INTEGER NOT NULL DEFAULT 0,
    "status_code" INTEGER,
    "latency_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "has_thinking" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_request_logs_created_at" ON "request_logs"("created_at");

-- CreateIndex
CREATE INDEX "idx_request_logs_model" ON "request_logs"("model");

-- CreateIndex
CREATE INDEX "idx_request_logs_model_created_at" ON "request_logs"("model", "created_at");

-- CreateIndex
CREATE INDEX "idx_request_logs_source_id_created_at" ON "request_logs"("source_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_request_logs_user_id" ON "request_logs"("user_id");

-- CreateIndex
CREATE INDEX "idx_request_logs_user_id_created_at" ON "request_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_request_logs_user_id_created_at_covering" ON "request_logs"("user_id", "created_at", "total_tokens", "cost");

-- CreateTable
CREATE TABLE "dispatch_rules" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "strategy" VARCHAR(50) NOT NULL DEFAULT 'round_robin',
    "model_filter" TEXT,
    "source_filter" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "dispatch_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "rate_limit_tracker" (
    "key_id" INTEGER NOT NULL,
    "window_start" INTEGER NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_tracker_pkey" PRIMARY KEY ("key_id","window_start")
);

-- CreateTable
CREATE TABLE "user_daily_model_stats" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "model" VARCHAR(255) NOT NULL,
    "requests" BIGINT NOT NULL DEFAULT 0,
    "tokens" BIGINT NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_daily_model_stats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_daily_model_stats_user_id_date_model_key" UNIQUE ("user_id", "date", "model")
);

-- CreateIndex
CREATE INDEX "idx_user_daily_model_stats_user_date" ON "user_daily_model_stats"("user_id", "date");

-- CreateIndex
CREATE INDEX "idx_user_daily_model_stats_user_model" ON "user_daily_model_stats"("user_id", "model");

-- CreateTable
CREATE TABLE "user_hourly_model_stats" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "hour" VARCHAR(13) NOT NULL,
    "model" VARCHAR(255) NOT NULL,
    "requests" BIGINT NOT NULL DEFAULT 0,
    "tokens" BIGINT NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_hourly_model_stats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_hourly_model_stats_user_id_hour_model_key" UNIQUE ("user_id", "hour", "model")
);

-- CreateIndex
CREATE INDEX "idx_user_hourly_model_stats_user_hour" ON "user_hourly_model_stats"("user_id", "hour");

-- CreateIndex
CREATE INDEX "idx_user_hourly_model_stats_user_model" ON "user_hourly_model_stats"("user_id", "model");
