-- 1. تفعيل الإضافة الخاصة بالبحث النصي السريع (Trigram Matching)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. إنشاء الجدول الرئيسي المقسّم حسب التاريخ (Partitioned Table)
CREATE TABLE IF NOT EXISTS logs (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL,
    level VARCHAR(10) NOT NULL,
    service VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    attributes JSONB,
    PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);

-- 3. إنشاء Partition افتراضي (Catch-all) للحالات التي لا تقع ضمن النطاقات
CREATE TABLE IF NOT EXISTS logs_default PARTITION OF logs DEFAULT;

-- 4. إنشاء دالة تلقائية لإنشاء Partition زمني لليوم الحالي والغد (Dynamic Partition Creation)
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
            partition_name, start_str, end_str
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

-- 5. إنشاء Partitions لليوم والأيام القريبة القادمة تلقائياً
SELECT create_partition_if_not_exists(CURRENT_DATE);
SELECT create_partition_if_not_exists((CURRENT_DATE + 1)::DATE);
SELECT create_partition_if_not_exists((CURRENT_DATE + 2)::DATE);

-- 6. إنشاء الفهارس (Indexes) على الجدول الرئيسي (تطبق تلقائياً على كل الـ Partitions)
CREATE INDEX IF NOT EXISTS idx_logs_service_ts ON logs (service, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs (level, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_attrs_gin ON logs USING GIN (attributes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);