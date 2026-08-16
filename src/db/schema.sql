CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS logs (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL,
    level VARCHAR(10) NOT NULL,
    service VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    attributes JSONB,
    rollup_processed BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);

ALTER TABLE logs
ADD COLUMN IF NOT EXISTS rollup_processed BOOLEAN NOT NULL DEFAULT true;

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
        CREATE TEMP TABLE logs_partition_move AS
        SELECT *
        FROM logs_default
        WHERE timestamp >= start_date::timestamptz
          AND timestamp < (start_date + INTERVAL '1 day')::timestamptz;

        DELETE FROM logs_default
        WHERE timestamp >= start_date::timestamptz
          AND timestamp < (start_date + INTERVAL '1 day')::timestamptz;

        EXECUTE format(
            'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L);',
            partition_name,
            start_str,
            end_str
        );

        INSERT INTO logs (id, timestamp, level, service, message, attributes)
        SELECT id, timestamp, level, service, message, attributes
        FROM logs_partition_move;

        DROP TABLE logs_partition_move;
    END IF;
END;
$$ LANGUAGE plpgsql;

SELECT create_partition_if_not_exists(day::DATE)
FROM generate_series(CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE + INTERVAL '2 days', INTERVAL '1 day') AS day;

CREATE INDEX IF NOT EXISTS idx_logs_service_ts ON logs (service, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs (level, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_attrs_gin ON logs USING GIN (attributes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_logs_rollup_pending ON logs (timestamp, id) WHERE rollup_processed = false;

CREATE TABLE IF NOT EXISTS log_rollups_minute (
    bucket_start TIMESTAMPTZ NOT NULL,
    service VARCHAR(255) NOT NULL,
    level VARCHAR(10) NOT NULL,
    count BIGINT NOT NULL,
    PRIMARY KEY (bucket_start, service, level)
);

CREATE INDEX IF NOT EXISTS idx_rollups_service_bucket ON log_rollups_minute (service, bucket_start);
CREATE INDEX IF NOT EXISTS idx_rollups_level_bucket ON log_rollups_minute (level, bucket_start);

CREATE TABLE IF NOT EXISTS log_rollups_hour (
    bucket_start TIMESTAMPTZ NOT NULL,
    service VARCHAR(255) NOT NULL,
    level VARCHAR(10) NOT NULL,
    count BIGINT NOT NULL,
    PRIMARY KEY (bucket_start, service, level)
);

CREATE INDEX IF NOT EXISTS idx_rollups_hour_service_bucket ON log_rollups_hour (service, bucket_start);
CREATE INDEX IF NOT EXISTS idx_rollups_hour_level_bucket ON log_rollups_hour (level, bucket_start);

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
