import { createClient } from '@supabase/supabase-js';

// ============================================================
// Supabase client.
// Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local
// (or a deployed env). No fallback values in source — keys are
// project-specific and shouldn't be committed.
// ============================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Supabase env vars missing. Copy .env.example to .env.local and fill in ' +
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

/**
 * Fetch ALL rows from a table, bypassing Supabase's default 1,000-row limit.
 * Paginates in chunks of 1,000 and concatenates. Used by the Asset Register
 * (411 assets at last count, headed up over time) and the Depreciation
 * preview (same dataset).
 *
 * Usage:
 *   const all = await fetchAll('assets');
 *   const filtered = await fetchAll('assets', { column: 'category_id', value: catId });
 *   const cols = await fetchAll('assets', null, 'id, asset_name, acquisition_cost');
 */
export async function fetchAll(table, filter = null, selectCols = '*') {
  const PAGE = 1000;
  let allData = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase.from(table).select(selectCols).range(from, from + PAGE - 1);
    if (filter) query = query.eq(filter.column, filter.value);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;
    allData = allData.concat(data);
    hasMore = data.length === PAGE;
    from += PAGE;
  }

  return allData;
}
