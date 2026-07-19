-- Required by ON CONFLICT (locale, feed_key)
-- Reference CSV installs create the table without this unique key.

DELETE FROM v_b_tech_news_feeds a
USING v_b_tech_news_feeds b
WHERE a.ctid < b.ctid
  AND a.locale = b.locale
  AND a.feed_key = b.feed_key;

CREATE UNIQUE INDEX IF NOT EXISTS v_b_tech_news_feeds_locale_feed_key_uniq
  ON v_b_tech_news_feeds (locale, feed_key);
