import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { getCurrentFiscalPeriod } from '../lib/calculations';

/**
 * Shared hook that loads reference data (categories, locations, fiscal periods)
 * and exposes the current fiscal period. Used by every page that needs to
 * resolve category/location IDs to names or check what period we're in.
 *
 * RRF-specific differences from RHLC:
 *   - `locations` instead of `stores` (optional, can be empty)
 *   - 12-period calendar (RHLC has 13)
 *   - `settings` table is loaded but tolerated if missing (deployment quirk)
 */
export function useAppData() {
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [fiscalPeriods, setFiscalPeriods] = useState([]);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    const [catsRes, locsRes, fpsRes, setsRes] = await Promise.all([
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('locations').select('*').order('sort_order', { nullsFirst: false }),
      supabase.from('fiscal_periods').select('*').order('fiscal_year').order('period'),
      supabase.from('settings').select('key, value'),
    ]);

    setCategories(catsRes.data || []);
    setLocations(locsRes.data || []);
    setFiscalPeriods(fpsRes.data || []);

    // Settings table is optional — tolerate it being missing.
    if (setsRes.data) {
      const map = {};
      for (const r of setsRes.data) map[r.key] = r.value;
      setSettings(map);
    } else if (setsRes.error) {
      console.warn('Settings table unavailable, continuing without:', setsRes.error.message);
      setSettings({});
    }

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const currentFP = fiscalPeriods.length > 0
    ? getCurrentFiscalPeriod(fiscalPeriods)
    : { fiscal_year: 2026, period: 1 };

  function getCategory(id) { return categories.find(c => c.id === id); }
  function getCategoryByName(name) {
    const n = (name || '').trim().toLowerCase();
    return categories.find(c => c.name.toLowerCase() === n);
  }
  function getLocation(id) { return locations.find(l => l.id === id); }

  return {
    categories, locations, fiscalPeriods, settings, currentFP, loading,
    reload: load,
    getCategory, getCategoryByName, getLocation,
  };
}
