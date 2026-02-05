-- Add full-text search capability to entities table
-- Uses a generated tsvector column for efficient searching

-- Add the search_vector column (generated from name and description)
ALTER TABLE entities ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS entities_search_idx ON entities USING gin(search_vector);
