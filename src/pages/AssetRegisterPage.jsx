/**
 * Asset Register
 *
 * Working register view of all assets, with a period selector that lets the
 * user view register state as of any fiscal period end.
 *
 * Data source:
 *   - Assets pulled from v_assets_current (one row per asset, with anchor +
 *     life inputs needed for live calc)
 *   - For the selected period, accum_depr / nbv / monthly_depr /
 *     months_in_service are recomputed via the calc module against that
 *     (fiscal_year, period) pair. Pre-anchor periods just show the anchor
 *     balance — matches RHLC's pattern.
 *   - Saved depreciation_runs are read only to TAG which periods have a
 *     saved Dashboard close (✓ in the dropdown). The numbers themselves
 *     come from the calc module either way.
 *
 * Default period selection on first load:
 *   1. Latest saved depreciation run (so register ties to dashboard)
 *   2. Falling back to the current fiscal period
 *   3. Falling back to the latest defined fiscal period
 *
 * Four tab views:
 *   - All Assets        — single flat table with grand total
 *   - By Category       — grouped per category, collapsible, with subtotals + grand total
 *   - By Year Acquired  — grouped per acquisition year, collapsible, with subtotals + grand total
 *   - By Location       — only shown when locations exist; collapsible
 *
 * Grouped views default to all-collapsed each time the view changes.
 *
 * Filter bar: Period, Category, Section A/B, Status (Active / Fully Depr), Search.
 *
 * Status badge logic (recomputed for the selected period):
 *   - Disposed     → red "Disposed"   (from raw asset record)
 *   - Fully depr   → amber "Fully Depr" (accum >= cost AT the selected period)
 *   - Anchored     → slate "Anchored" (legacy_accum_depr is set)
 *   - Otherwise    → green text "Active" (no pill, reserves visual weight)
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase, fetchAll } from '../lib/supabase';
import { useToast } from '../components/Toast';
import {
  fmt$, fmtInt, fmtDate, fmtPeriodLabel,
  calcAccumDepr, calcPeriodDepr, countPeriodsInService,
  getCurrentFiscalPeriod,
} from '../lib/calculations';
import AssetModal from '../components/AssetModal';
import DisposeModal from '../components/DisposeModal';

export default function AssetRegisterPage() {
  const showToast = useToast();
  const [assets, setAssets]         = useState(null);
  const [categories, setCategories] = useState(null);
  const [locations, setLocations]   = useState(null);
  const [fiscalPeriods, setFiscalPeriods] = useState(null);
  const [savedRuns, setSavedRuns]   = useState(null);
  const [error, setError]           = useState(null);

  // Period selector — what (fiscal_year, period) the table is "as of".
  // Defaults to the latest saved depreciation run, or the current fiscal
  // period if no runs are saved yet. Set on first load.
  const [selPeriod, setSelPeriod]   = useState(null); // { fiscal_year, period } | null

  const [view, setView]         = useState('all');
  const [catFilter, setCatFilter]   = useState('');
  const [locFilter, setLocFilter]   = useState('');
  const [secFilter, setSecFilter]   = useState('');
  const [statFilter, setStatFilter] = useState('');
  const [search, setSearch]         = useState('');

  // Collapse state for grouped views. Set holds keys of EXPANDED groups
  // (empty Set = all collapsed, which is the default each time you switch
  // into a grouped view). Reset whenever the view tab changes.
  const [expanded, setExpanded] = useState(() => new Set());
  useEffect(() => { setExpanded(new Set()); }, [view]);

  function toggleGroup(key) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function expandAll(keys) { setExpanded(new Set(keys)); }
  function collapseAll() { setExpanded(new Set()); }

  // Modal state
  const [modalMode, setModalMode]   = useState(null);   // 'add' | 'edit' | null
  const [editTarget, setEditTarget] = useState(null);
  const [disposeAssetId, setDisposeAssetId] = useState(null);  // asset id when dispose modal is open

  const loadAssets = useCallback(async () => {
    setError(null);
    try {
      const [assetsData, catsRes, locsRes, fpRes, runsRes] = await Promise.all([
        fetchAll('v_assets_current'),
        supabase.from('categories').select('id, name').order('sort_order'),
        supabase.from('locations').select('id, name, is_active, sort_order').order('sort_order', { nullsFirst: false }),
        supabase.from('fiscal_periods').select('fiscal_year, period, start_date, end_date').order('fiscal_year').order('period'),
        supabase.from('depreciation_runs').select('fiscal_year, period').order('fiscal_year', { ascending: false }).order('period', { ascending: false }),
      ]);
      if (catsRes.error) throw catsRes.error;
      if (locsRes.error) throw locsRes.error;
      if (fpRes.error)   throw fpRes.error;
      if (runsRes.error) throw runsRes.error;

      // Sort by asset_number ascending, nulls last
      const sorted = [...assetsData].sort((a, b) => {
        if (a.asset_number == null && b.asset_number == null) return 0;
        if (a.asset_number == null) return 1;
        if (b.asset_number == null) return -1;
        return a.asset_number - b.asset_number;
      });
      setAssets(sorted);
      setCategories(catsRes.data || []);
      setLocations(locsRes.data || []);
      setFiscalPeriods(fpRes.data || []);
      setSavedRuns(runsRes.data || []);

      // Seed the default selected period ONCE on first load:
      //   1. Latest saved depreciation run (so register ties to dashboard)
      //   2. Failing that, current fiscal period
      //   3. Failing that, the latest defined fiscal period
      // Don't overwrite if already set (preserves user's choice on re-load).
      setSelPeriod(prev => {
        if (prev) return prev;
        if (runsRes.data && runsRes.data.length > 0) {
          const r = runsRes.data[0];
          return { fiscal_year: r.fiscal_year, period: r.period };
        }
        if (fpRes.data && fpRes.data.length > 0) {
          const cur = getCurrentFiscalPeriod(fpRes.data);
          return { fiscal_year: cur.fiscal_year, period: cur.period };
        }
        return null;
      });
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  // ---- modal openers ----
  function openAdd() {
    setEditTarget(null);
    setModalMode('add');
  }
  function openEdit(a) {
    setEditTarget({
      id: a.id,
      asset_number: a.asset_number,
      asset_name: a.asset_name,
      description: a.description,
      category_id: a.category_id,
      location_id: a.location_id,
      acquisition_date: a.acquisition_date,
      in_service_date: a.in_service_date,
      acquisition_cost: a.acquisition_cost,
      useful_life_years: a.useful_life_years,
      useful_life_months: a.useful_life_months,
      legacy_accum_depr: a.legacy_accum_depr,
      legacy_as_of_date: a.legacy_as_of_date,
      section: a.section,
    });
    setModalMode('edit');
  }
  function closeModal() { setModalMode(null); setEditTarget(null); }
  function handleSaved(_id, summary) {
    showToast(summary);
    loadAssets();
  }

  // ---- period-based recompute ----
  // Replace `accum_depr`, `nbv`, `monthly_depr`, and `months_in_service` on
  // each asset to reflect the END of the selected fiscal period. Everything
  // else (name, category, location, anchor info, status flags) carries over
  // from v_assets_current unchanged.
  //
  // For periods before an asset's anchor / in-service date, calcAccumDepr
  // returns the anchor balance (or 0) — matches RHLC's "early periods just
  // show what was there" behavior.
  const assetsForPeriod = useMemo(() => {
    if (!assets || !selPeriod || !fiscalPeriods) return null;
    const yr = selPeriod.fiscal_year;
    const pd = selPeriod.period;
    return assets.map(a => {
      const accum   = calcAccumDepr(a, yr, pd, fiscalPeriods);
      const nbv     = (a.acquisition_cost ?? 0) - accum;
      const monthly = calcPeriodDepr(a);
      const months  = countPeriodsInService(a, yr, pd, fiscalPeriods);
      // Recompute fully-depr status flag for the selected period
      const isFullyAtPeriod =
        (a.acquisition_cost > 0)
        && (accum >= Math.abs(a.acquisition_cost) - 0.005);
      return {
        ...a,
        accum_depr: Math.round(accum * 100) / 100,
        nbv: Math.round(nbv * 100) / 100,
        monthly_depr: Math.round(monthly * 100) / 100,
        months_in_service: months > 0 ? months : null,
        // Override status_note for the selected period — the original value
        // from v_assets_current reflects today's calc, not the selected one
        status_note: isFullyAtPeriod ? 'fully' : (a.status_note || ''),
      };
    });
  }, [assets, selPeriod, fiscalPeriods]);

  // ---- filtering ----
  const filtered = useMemo(() => {
    if (!assetsForPeriod) return [];
    let f = assetsForPeriod;
    if (catFilter) f = f.filter(a => a.category_name === catFilter);
    if (locFilter === '__missing__') f = f.filter(a => !a.location_id);
    else if (locFilter) f = f.filter(a => a.location_id === locFilter);
    if (secFilter) f = f.filter(a => a.section === secFilter);
    if (statFilter === 'fully-dep') {
      f = f.filter(a =>
        (a.status_note || '').toLowerCase().includes('fully')
        || (a.nbv != null && a.nbv <= 0.005)
      );
    } else if (statFilter === 'active') {
      f = f.filter(a => !a.is_disposed && !(
        (a.status_note || '').toLowerCase().includes('fully')
        || (a.nbv != null && a.nbv <= 0.005)
      ));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      f = f.filter(a =>
        ((a.asset_name || '') + ' ' + (a.description || '')).toLowerCase().includes(q)
      );
    }
    return f;
  }, [assetsForPeriod, catFilter, locFilter, secFilter, statFilter, search]);

  // Group keys for the current grouped view — used by Expand All.
  // Computed BEFORE the early-return guards so hooks run in the same order
  // on every render. Tolerates the loading state (locations/view-derived
  // values are evaluated defensively).
  const effectiveViewSafe = (view === 'by-location' && (locations?.length ?? 0) === 0) ? 'all' : view;
  const groupKeys = useMemo(() => {
    if (effectiveViewSafe === 'by-category') {
      return [...new Set(filtered.map(r => r.category_name))];
    }
    if (effectiveViewSafe === 'by-year') {
      return [...new Set(filtered.map(r => r.acquisition_date ? r.acquisition_date.slice(0, 4) : 'Unknown'))];
    }
    if (effectiveViewSafe === 'by-location') {
      return [...new Set(filtered.map(r => r.location_id || '__unset__'))];
    }
    return [];
  }, [effectiveViewSafe, filtered]);

  // ---- render gates ----
  if (error) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Asset Register</h1>
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load register:</strong> {error}
        </div>
      </div>
    );
  }
  if (!assets || !categories || !locations || !fiscalPeriods || !selPeriod) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Asset Register</h1>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </div>
    );
  }

  const locationsExist = locations.length > 0;
  const effectiveView = effectiveViewSafe;

  const isGrouped = effectiveView !== 'all';
  const allExpanded = isGrouped && groupKeys.length > 0 && groupKeys.every(k => expanded.has(k));

  // Period dropdown options — every fiscal period, newest first.
  // Saved runs get a "✓ saved" tag so it's clear which ones tie to a Dashboard close.
  const savedKey = (yr, p) => `${yr}-${p}`;
  const savedSet = new Set((savedRuns || []).map(r => savedKey(r.fiscal_year, r.period)));
  const periodOptions = [...fiscalPeriods]
    .sort((a, b) => {
      if (a.fiscal_year !== b.fiscal_year) return b.fiscal_year - a.fiscal_year;
      return b.period - a.period;
    });
  const selKey = savedKey(selPeriod.fiscal_year, selPeriod.period);
  const selIsSaved = savedSet.has(selKey);
  const asOfDate = (() => {
    const fp = fiscalPeriods.find(p =>
      p.fiscal_year === selPeriod.fiscal_year && p.period === selPeriod.period
    );
    return fp ? fp.end_date : null;
  })();

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">Asset Register</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            As of {fmtPeriodLabel(selPeriod.fiscal_year, selPeriod.period)}
            {asOfDate && <span className="text-gray-400"> ({fmtDate(asOfDate)})</span>}
            {selIsSaved && (
              <span className="ml-2 inline-block px-1.5 py-0.5 text-[9px] font-semibold rounded bg-green-100 text-green-700 uppercase tracking-wider">
                Saved Close
              </span>
            )}
            {!selIsSaved && (
              <span className="ml-2 inline-block px-1.5 py-0.5 text-[9px] font-semibold rounded bg-slate-100 text-slate-600 uppercase tracking-wider">
                Calculated
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => showToast('Excel export coming soon.', 'warning')}
            className="px-3 py-1.5 text-xs font-medium bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
          >
            Export to Excel
          </button>
          <button
            onClick={openAdd}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            + Add Asset
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 mb-4 bg-gray-100 rounded p-0.5 w-fit">
        <Tab label="All Assets"     active={effectiveView === 'all'}         onClick={() => setView('all')} />
        <Tab label="By Category"    active={effectiveView === 'by-category'} onClick={() => setView('by-category')} />
        {locationsExist && (
          <Tab label="By Location"  active={effectiveView === 'by-location'} onClick={() => setView('by-location')} />
        )}
        <Tab label="By Year Acquired" active={effectiveView === 'by-year'}   onClick={() => setView('by-year')} />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Period selector */}
        <select
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white font-medium"
          value={selKey}
          onChange={e => {
            const [yr, p] = e.target.value.split('-').map(Number);
            setSelPeriod({ fiscal_year: yr, period: p });
          }}
          title="View register as of the end of this fiscal period"
        >
          {periodOptions.map(p => {
            const k = savedKey(p.fiscal_year, p.period);
            const saved = savedSet.has(k);
            return (
              <option key={k} value={k}>
                {fmtPeriodLabel(p.fiscal_year, p.period)}{saved ? ' ✓' : ''}
              </option>
            );
          })}
        </select>

        <select
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white"
          value={catFilter}
          onChange={e => setCatFilter(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>

        {locationsExist && (
          <select
            className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white"
            value={locFilter}
            onChange={e => setLocFilter(e.target.value)}
          >
            <option value="">All locations</option>
            <option value="__missing__">— Missing location —</option>
            {locations.filter(l => l.is_active).map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}

        <select
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white"
          value={secFilter}
          onChange={e => setSecFilter(e.target.value)}
        >
          <option value="">All sections</option>
          <option value="A">Section A (legacy cohort)</option>
          <option value="B">Section B (current cohort)</option>
        </select>

        <select
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white"
          value={statFilter}
          onChange={e => setStatFilter(e.target.value)}
        >
          <option value="">All status</option>
          <option value="active">Active</option>
          <option value="fully-dep">Fully Depreciated</option>
        </select>

        <input
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white flex-1 min-w-[200px]"
          type="text"
          placeholder="Search name or description..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <div className="text-xs text-gray-500 num ml-auto">
          {fmtInt(filtered.length)} of {fmtInt(assets.length)} assets
        </div>
        {isGrouped && groupKeys.length > 0 && (
          <button
            onClick={() => allExpanded ? collapseAll() : expandAll(groupKeys)}
            className="px-2 py-1.5 text-xs font-medium text-blue-600 hover:text-blue-800"
            title={allExpanded ? 'Collapse all groups' : 'Expand all groups'}
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>

      {/* Body */}
      {effectiveView === 'all'         && <AllAssetsTable rows={filtered} onEdit={openEdit} onDispose={(a) => setDisposeAssetId(a.id)} onAction={msg => showToast(msg, 'warning')} />}
      {effectiveView === 'by-category' && <ByCategoryTable rows={filtered} onEdit={openEdit} onDispose={(a) => setDisposeAssetId(a.id)} onAction={msg => showToast(msg, 'warning')} expanded={expanded} onToggle={toggleGroup} />}
      {effectiveView === 'by-year'     && <ByYearTable rows={filtered} onEdit={openEdit} onDispose={(a) => setDisposeAssetId(a.id)} onAction={msg => showToast(msg, 'warning')} expanded={expanded} onToggle={toggleGroup} />}
      {effectiveView === 'by-location' && <ByLocationTable rows={filtered} locations={locations} onEdit={openEdit} onDispose={(a) => setDisposeAssetId(a.id)} onAction={msg => showToast(msg, 'warning')} expanded={expanded} onToggle={toggleGroup} />}

      {/* Modal */}
      {modalMode && (
        <AssetModal
          mode={modalMode}
          asset={editTarget}
          onClose={closeModal}
          onSaved={handleSaved}
        />
      )}

      {disposeAssetId && (
        <DisposeModal
          preselectedAssetId={disposeAssetId}
          onClose={() => setDisposeAssetId(null)}
          onSaved={(rec) => {
            showToast('Disposal recorded. IIF downloaded.');
            setDisposeAssetId(null);
            loadAssets();
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function Tab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded transition-colors
        ${active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
    >
      {label}
    </button>
  );
}

function StatusBadge({ a }) {
  const isFully = (a.status_note || '').toLowerCase().includes('fully')
    || (a.nbv != null && a.nbv <= 0.005);

  if (a.is_disposed) {
    return <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-red-100 text-red-700 uppercase tracking-wider">Disposed</span>;
  }
  if (isFully) {
    return <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-100 text-amber-700 uppercase tracking-wider">Fully Depr</span>;
  }
  if (a.legacy_accum_depr != null) {
    return <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-slate-100 text-slate-600 uppercase tracking-wider">Anchored</span>;
  }
  return <span className="text-xs font-medium text-green-600">Active</span>;
}

function AssetActions({ a, onEdit, onDispose }) {
  return (
    <div className="whitespace-nowrap">
      <button
        onClick={() => onEdit(a)}
        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
      >
        Edit
      </button>
      {!a.is_disposed && (
        <button
          onClick={() => onDispose(a)}
          className="text-xs text-gray-500 hover:text-gray-700 font-medium ml-3"
        >
          Dispose
        </button>
      )}
    </div>
  );
}

function aggregate(rows) {
  let cost = 0, accum = 0, nbv = 0, monthly = 0;
  for (const r of rows) {
    cost    += r.acquisition_cost || 0;
    accum   += r.accum_depr || 0;
    nbv     += r.nbv || 0;
    monthly += r.monthly_depr || 0;
  }
  return { cost, accum, nbv, monthly };
}

function groupBy(arr, pick) {
  const m = new Map();
  for (const x of arr) {
    const k = pick(x);
    const cur = m.get(k);
    if (cur) cur.push(x); else m.set(k, [x]);
  }
  return m;
}

function EmptyCard({ message }) {
  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm p-6 text-center text-sm text-gray-400">
      {message}
    </div>
  );
}

function Chevron({ open }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`inline-block text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="M3 1.5 L7 5 L3 8.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GroupHeader({ open, onToggle, label, count, cost, accum, nbv }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center px-4 py-2.5 border-b border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      aria-expanded={open}
    >
      <span className="mr-2"><Chevron open={open} /></span>
      <h3 className="text-sm font-semibold flex-1">
        {label}
        <span className="text-gray-400 font-normal ml-2">
          — {fmtInt(count)} {count === 1 ? 'asset' : 'assets'}
        </span>
      </h3>
      <div className="hidden md:flex items-center gap-5 text-[11px] text-gray-500">
        <span>Cost <span className="num font-medium text-gray-700 ml-1">{fmt$(cost)}</span></span>
        <span>Accum <span className="num font-medium text-gray-700 ml-1">{fmt$(accum)}</span></span>
        <span>NBV <span className="num font-medium text-gray-700 ml-1">{fmt$(nbv)}</span></span>
      </div>
    </button>
  );
}

// ============================================================
// Row component
// ============================================================

function AssetTr({ a, showCat, showLoc, onEdit, onDispose }) {
  // Tooltip text combines name + description so users can see the whole thing on hover.
  const tooltip = a.description
    ? `${a.asset_name}\n\n${a.description}`
    : a.asset_name;
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="px-2 py-1.5 num text-gray-400">{a.asset_number ?? '—'}</td>
      <td className="px-2 py-1.5" title={tooltip}>
        <div className="w-[280px]">
          <div className="leading-tight truncate">{a.asset_name}</div>
          {a.description && (
            <div className="text-[11px] text-gray-400 leading-tight mt-0.5 truncate">
              {a.description}
            </div>
          )}
        </div>
      </td>
      {showCat && <td className="px-2 py-1.5 whitespace-nowrap">{a.category_name}</td>}
      {showLoc && (
        <td className="px-2 py-1.5 whitespace-nowrap">
          {a.location_name ?? <span className="text-gray-300">—</span>}
        </td>
      )}
      <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(a.acquisition_date)}</td>
      <td className="px-2 py-1.5 text-right num">{fmt$(a.acquisition_cost)}</td>
      <td className="px-2 py-1.5 text-center num">{a.useful_life_years ?? '—'}</td>
      <td className="px-2 py-1.5 text-center num">
        {a.months_in_service != null ? Math.round(a.months_in_service) : '—'}
      </td>
      <td className="px-2 py-1.5 text-right num">{fmt$(a.monthly_depr)}</td>
      <td className="px-2 py-1.5 text-right num">{fmt$(a.accum_depr)}</td>
      <td className="px-2 py-1.5 text-right num">{fmt$(a.nbv)}</td>
      <td className="px-2 py-1.5"><StatusBadge a={a} /></td>
      <td className="px-2 py-1.5"><AssetActions a={a} onEdit={onEdit} onDispose={onDispose} /></td>
    </tr>
  );
}

// ============================================================
// Tables
// ============================================================

function AllAssetsTable({ rows, onEdit, onDispose, onAction }) {
  if (rows.length === 0) return <EmptyCard message="No assets match the current filters." />;
  const totals = aggregate(rows);

  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
              <th className="text-left px-2 py-2 font-semibold">#</th>
              <th className="text-left px-2 py-2 font-semibold">Asset Name</th>
              <th className="text-left px-2 py-2 font-semibold">Category</th>
              <th className="text-left px-2 py-2 font-semibold">Location</th>
              <th className="text-left px-2 py-2 font-semibold">Acquired</th>
              <th className="text-right px-2 py-2 font-semibold">Cost</th>
              <th className="text-center px-2 py-2 font-semibold">UL (yr)</th>
              <th className="text-center px-2 py-2 font-semibold">Mos</th>
              <th className="text-right px-2 py-2 font-semibold">Monthly</th>
              <th className="text-right px-2 py-2 font-semibold">Accum</th>
              <th className="text-right px-2 py-2 font-semibold">NBV</th>
              <th className="text-left px-2 py-2 font-semibold">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(a => (
              <AssetTr key={a.id} a={a} showCat showLoc onEdit={onEdit} onDispose={onDispose} />
            ))}
            <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
              <td colSpan={5} className="px-2 py-2">{fmtInt(rows.length)} assets</td>
              <td className="px-2 py-2 text-right num">{fmt$(totals.cost)}</td>
              <td colSpan={2} />
              <td className="px-2 py-2 text-right num">{fmt$(totals.monthly)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(totals.accum)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(totals.nbv)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ByCategoryTable({ rows, onEdit, onDispose, onAction, expanded, onToggle }) {
  if (rows.length === 0) return <EmptyCard message="No assets match the current filters." />;
  const groups = groupBy(rows, r => r.category_name);
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const grand = aggregate(rows);

  return (
    <>
      {ordered.map(([catName, list]) => {
        const sub = aggregate(list);
        const open = expanded.has(catName);
        return (
          <div key={catName} className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden mb-4">
            <GroupHeader
              open={open}
              onToggle={() => onToggle(catName)}
              label={catName}
              count={list.length}
              cost={sub.cost}
              accum={sub.accum}
              nbv={sub.nbv}
            />
            {open && (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                      <th className="text-left px-2 py-2 font-semibold">#</th>
                      <th className="text-left px-2 py-2 font-semibold">Asset Name</th>
                      <th className="text-left px-2 py-2 font-semibold">Location</th>
                      <th className="text-left px-2 py-2 font-semibold">Acquired</th>
                      <th className="text-right px-2 py-2 font-semibold">Cost</th>
                      <th className="text-center px-2 py-2 font-semibold">UL</th>
                      <th className="text-center px-2 py-2 font-semibold">Mos</th>
                      <th className="text-right px-2 py-2 font-semibold">Monthly</th>
                      <th className="text-right px-2 py-2 font-semibold">Accum</th>
                      <th className="text-right px-2 py-2 font-semibold">NBV</th>
                      <th className="text-left px-2 py-2 font-semibold">Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(a => (
                      <AssetTr key={a.id} a={a} showCat={false} showLoc onEdit={onEdit} onDispose={onDispose} />
                    ))}
                    <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                      <td colSpan={4} className="px-2 py-2">{catName} subtotal</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.cost)}</td>
                      <td colSpan={2} />
                      <td className="px-2 py-2 text-right num">{fmt$(sub.monthly)}</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.accum)}</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.nbv)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <div className="bg-white border border-blue-300 rounded-md shadow-sm overflow-hidden">
        <table className="w-full text-[12.5px]">
          <tbody>
            <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
              <td colSpan={4} className="px-2 py-2">Grand Total — {fmtInt(rows.length)} assets</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.cost)}</td>
              <td colSpan={2} />
              <td className="px-2 py-2 text-right num">{fmt$(grand.monthly)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.accum)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.nbv)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function ByYearTable({ rows, onEdit, onDispose, onAction, expanded, onToggle }) {
  if (rows.length === 0) return <EmptyCard message="No assets match the current filters." />;
  const groups = groupBy(rows, r => r.acquisition_date ? r.acquisition_date.slice(0, 4) : 'Unknown');
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    if (a === 'Unknown') return 1;
    if (b === 'Unknown') return -1;
    return a.localeCompare(b);
  });
  const grand = aggregate(rows);

  return (
    <>
      {ordered.map(([yr, list]) => {
        const sub = aggregate(list);
        const open = expanded.has(yr);
        return (
          <div key={yr} className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden mb-4">
            <GroupHeader
              open={open}
              onToggle={() => onToggle(yr)}
              label={yr}
              count={list.length}
              cost={sub.cost}
              accum={sub.accum}
              nbv={sub.nbv}
            />
            {open && (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                      <th className="text-left px-2 py-2 font-semibold">#</th>
                      <th className="text-left px-2 py-2 font-semibold">Asset Name</th>
                      <th className="text-left px-2 py-2 font-semibold">Category</th>
                      <th className="text-left px-2 py-2 font-semibold">Location</th>
                      <th className="text-left px-2 py-2 font-semibold">Acquired</th>
                      <th className="text-right px-2 py-2 font-semibold">Cost</th>
                      <th className="text-center px-2 py-2 font-semibold">UL</th>
                      <th className="text-center px-2 py-2 font-semibold">Mos</th>
                      <th className="text-right px-2 py-2 font-semibold">Monthly</th>
                      <th className="text-right px-2 py-2 font-semibold">Accum</th>
                      <th className="text-right px-2 py-2 font-semibold">NBV</th>
                      <th className="text-left px-2 py-2 font-semibold">Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(a => (
                      <AssetTr key={a.id} a={a} showCat showLoc onEdit={onEdit} onDispose={onDispose} />
                    ))}
                    <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                      <td colSpan={5} className="px-2 py-2">{yr} subtotal</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.cost)}</td>
                      <td colSpan={2} />
                      <td className="px-2 py-2 text-right num">{fmt$(sub.monthly)}</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.accum)}</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.nbv)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <div className="bg-white border border-blue-300 rounded-md shadow-sm overflow-hidden">
        <table className="w-full text-[12.5px]">
          <tbody>
            <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
              <td colSpan={5} className="px-2 py-2">Grand Total — {fmtInt(rows.length)} assets</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.cost)}</td>
              <td colSpan={2} />
              <td className="px-2 py-2 text-right num">{fmt$(grand.monthly)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.accum)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.nbv)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function ByLocationTable({ rows, locations, onEdit, onDispose, onAction, expanded, onToggle }) {
  if (rows.length === 0) return <EmptyCard message="No assets match the current filters." />;
  const groups = groupBy(rows, r => r.location_id || '__unset__');
  const orderedKeys = [
    ...locations.filter(l => groups.has(l.id)).map(l => l.id),
    ...(groups.has('__unset__') ? ['__unset__'] : []),
  ];
  const grand = aggregate(rows);

  return (
    <>
      {orderedKeys.map(key => {
        const list = groups.get(key) || [];
        const label = key === '__unset__'
          ? '(No location)'
          : (locations.find(l => l.id === key)?.name ?? '(deleted location)');
        const sub = aggregate(list);
        const open = expanded.has(key);
        return (
          <div key={key} className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden mb-4">
            <GroupHeader
              open={open}
              onToggle={() => onToggle(key)}
              label={label}
              count={list.length}
              cost={sub.cost}
              accum={sub.accum}
              nbv={sub.nbv}
            />
            {open && (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                      <th className="text-left px-2 py-2 font-semibold">#</th>
                      <th className="text-left px-2 py-2 font-semibold">Asset Name</th>
                      <th className="text-left px-2 py-2 font-semibold">Category</th>
                      <th className="text-left px-2 py-2 font-semibold">Acquired</th>
                      <th className="text-right px-2 py-2 font-semibold">Cost</th>
                      <th className="text-center px-2 py-2 font-semibold">UL</th>
                      <th className="text-center px-2 py-2 font-semibold">Mos</th>
                      <th className="text-right px-2 py-2 font-semibold">Monthly</th>
                      <th className="text-right px-2 py-2 font-semibold">Accum</th>
                      <th className="text-right px-2 py-2 font-semibold">NBV</th>
                      <th className="text-left px-2 py-2 font-semibold">Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(a => (
                      <AssetTr key={a.id} a={a} showCat showLoc={false} onEdit={onEdit} onDispose={onDispose} />
                    ))}
                    <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                      <td colSpan={4} className="px-2 py-2">{label} subtotal</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.cost)}</td>
                      <td colSpan={2} />
                      <td className="px-2 py-2 text-right num">{fmt$(sub.monthly)}</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.accum)}</td>
                      <td className="px-2 py-2 text-right num">{fmt$(sub.nbv)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <div className="bg-white border border-blue-300 rounded-md shadow-sm overflow-hidden">
        <table className="w-full text-[12.5px]">
          <tbody>
            <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
              <td colSpan={4} className="px-2 py-2">Grand Total — {fmtInt(rows.length)} assets</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.cost)}</td>
              <td colSpan={2} />
              <td className="px-2 py-2 text-right num">{fmt$(grand.monthly)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.accum)}</td>
              <td className="px-2 py-2 text-right num">{fmt$(grand.nbv)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
