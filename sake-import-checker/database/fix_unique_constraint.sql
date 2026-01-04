-- Fix: Add UNIQUE constraint on reported_product_name for upsert to work
-- This allows batch UPDATE using upsert() with onConflict

-- Check if constraint already exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sake_imports_reported_product_name_key'
    ) THEN
        -- Add UNIQUE constraint
        ALTER TABLE sake_imports
        ADD CONSTRAINT sake_imports_reported_product_name_key
        UNIQUE (reported_product_name);

        RAISE NOTICE 'UNIQUE constraint added successfully';
    ELSE
        RAISE NOTICE 'UNIQUE constraint already exists';
    END IF;
END $$;
