ALTER TABLE services ADD COLUMN image_url text;
ALTER TABLE gallery_images ADD COLUMN is_logo boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX gallery_single_logo ON gallery_images (is_logo) WHERE is_logo;
