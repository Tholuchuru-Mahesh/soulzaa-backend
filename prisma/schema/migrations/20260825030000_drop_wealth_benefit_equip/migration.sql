-- Undo wealth_benefit_equips (20260825020000): equip state for Wealth Level
-- benefits now routes through the existing Backpack/Cosmetics inventory
-- (backpack_items / user's equipped item per type) instead of a standalone
-- Wealth-only table, so equipping a benefit actually shows up everywhere the
-- Backpack already renders equipped cosmetics (profile, chat, rooms). One
-- test row existed, from exercising the now-replaced feature — not real
-- user data.

DROP TABLE "wealth_benefit_equips";
