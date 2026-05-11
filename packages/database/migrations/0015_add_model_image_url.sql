-- Migration 0015: add image_url column to models table
ALTER TABLE models ADD COLUMN IF NOT EXISTS image_url text;
