-- migrate:up
--
-- Typo-tolerant search over dish and stall names.
--
-- WHY TRIGRAMS AND NOT FULL-TEXT SEARCH
--
-- Postgres full-text is the reflex answer and it is the wrong one for this
-- menu. `to_tsvector` stems against a language dictionary, and the dictionary
-- is English. Almost every dish here is a transliteration:
--
--   momo / momos / momoz        no stemmer links these
--   paneer tikka / panir tika   spelling varies by who typed the menu
--   biryani / biriyani / birani  all three appear on real signage
--
-- A stemmer turns "running" into "run". It has nothing to say about "biriyani",
-- so full-text search would return zero results for the commonest spellings and
-- the failure would be invisible — an empty list looks exactly like a court
-- that genuinely has no biryani.
--
-- Trigram similarity compares three-character windows, so it does not care what
-- language a word is from or whether anyone spelled it the way we stored it.
-- That is the right tool for a menu typed by sixty different stall owners.
--
-- WHY THE INDEX IS NOT OPTIONAL
--
-- `similarity(name, 'momo') > 0.3` without an index is a sequential scan over
-- every menu item in the database for every keystroke. It is fast on the four
-- stalls in the dev seed and quadratic misery in a real court. GIN with
-- `gin_trgm_ops` is what makes `%` and `ILIKE '%…%'` index-assisted.
--
-- pg_trgm ships with the `postgresql-contrib` package and is available on RDS,
-- Cloud SQL, Supabase, Neon and Azure without a support ticket. It is the least
-- exotic extension there is.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Dish names. The one that makes "search momo, get every stall selling one"
-- possible at all.
CREATE INDEX menu_item_name_trgm ON menu_item USING gin (name gin_trgm_ops);

-- Stall names, so "wow" still finds Wow Momo by name rather than only through
-- its dishes. Cheap: there are orders of magnitude fewer stalls than dishes.
CREATE INDEX vendor_name_trgm ON vendor USING gin (name gin_trgm_ops);

-- Descriptions are DELIBERATELY NOT INDEXED.
--
-- "Steamed dumplings with a chilli dip" contains neither "momo" nor anything a
-- diner would type, and indexing prose pulls in every filler word — a search
-- for "chilli" would return every dish whose description mentions a chilli
-- somewhere, ranked above the one actually called Chilli Momo. Names are what
-- people search; descriptions are what they read afterwards.

-- migrate:down
DROP INDEX IF EXISTS menu_item_name_trgm;
DROP INDEX IF EXISTS vendor_name_trgm;
-- The extension is deliberately left in place. Dropping it would fail if
-- anything else has come to depend on it, and an unused extension costs
-- nothing.
