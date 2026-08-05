CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS logs (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL,
    level VARCHAR(10) NOT NULL,
    service VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    attributes JSONB,
    PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);

CREATE TABLE IF NOT EXISTS logs_default PARTITION OF logs DEFAULT;

CREATE OR REPLACE FUNCTION create_partition_if_not_exists(start_date DATE)
RETURNS void AS $$
DECLARE
    partition_name TEXT;
    start_str TEXT;
    end_str TEXT;
BEGIN
    start_str := to_char(start_date, 'YYYY-MM-DD');
    end_str := to_char(start_date + INTERVAL '1 day', 'YYYY-MM-DD');
    partition_name := 'logs_' || to_char(start_date, 'YYYY_MM_DD');

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L);',
            partition_name,
            start_str,
            end_str
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

SELECT create_partition_if_not_exists(CURRENT_DATE);
SELECT create_partition_if_not_exists((CURRENT_DATE + 1)::DATE);
SELECT create_partition_if_not_exists((CURRENT_DATE + 2)::DATE);

CREATE INDEX IF NOT EXISTS idx_logs_service_ts ON logs (service, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs (level, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_attrs_gin ON logs USING GIN (attributes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);

CREATE TABLE IF NOT EXISTS api_keys (
    key_hash TEXT PRIMARY KEY,
    can_ingest BOOLEAN NOT NULL DEFAULT false,
    can_query BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP FUNCTION IF EXISTS drop_old_log_partitions(INTEGER);

CREATE OR REPLACE FUNCTION drop_old_log_partitions(retention_days INTEGER)
RETURNS void AS $$
DECLARE
    partition_record RECORD;
    cutoff_date DATE;
BEGIN
    cutoff_date := CURRENT_DATE - retention_days;

    FOR partition_record IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'logs'
          AND c.relname ~ '^logs_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
          AND to_date(replace(substring(c.relname FROM 6), '_', '-'), 'YYYY-MM-DD') < cutoff_date
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I;', partition_record.relname);
    END LOOP;
END;
$$ LANGUAGE plpgsql;
