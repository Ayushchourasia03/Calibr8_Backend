INSERT INTO "themes" ("slug", "name", "price", "previewColor", "isDefault")
VALUES
    ('default', 'Default', 0, '#2F7BFF', TRUE),
    ('orbit', 'Orbit', 450, '#35E6FF', FALSE),
    ('frost', 'Frost', 400, '#EEF0FA', FALSE),
    ('editorial', 'Editorial', 400, '#F7F4EE', FALSE),
    ('mono', 'Monochrome', 350, '#161616', FALSE),
    ('pearl', 'Pearl', 350, '#ECECEE', FALSE),
    ('arcade', 'Arcade', 800, '#FF2E97', FALSE),
    ('racer', 'Racer', 800, '#FF1E1E', FALSE),
    ('anime', 'Sakura Manga', 700, '#FF4F8B', FALSE),
    ('comic', 'Hero Comic', 700, '#E5232B', FALSE),
    ('storybook', 'Storybook Kingdom', 700, '#C9922E', FALSE)
ON CONFLICT ("slug") DO UPDATE
SET "name" = EXCLUDED."name",
    "price" = EXCLUDED."price",
    "previewColor" = EXCLUDED."previewColor",
    "isDefault" = EXCLUDED."isDefault";
