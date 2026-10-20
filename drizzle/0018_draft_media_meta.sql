-- 0018: what the server read from a video when it was stored (duration, codecs,
-- frame rate, whether its index comes first) and its cover, so the composer and
-- the providers check a video against each platform's rules without reading it
-- again.
ALTER TABLE `draft_media` ADD COLUMN `meta_json` text;
