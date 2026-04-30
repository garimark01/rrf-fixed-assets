/**
 * Depreciation Engine — RRF
 *
 * Ported directly from the RHLC DepreciationPage with these adaptations:
 *
 *   RHLC                                   RRF
 *   ----                                   ---
 *   13 four-week periods                   12 calendar months (Jan..Dec)
 *   Stores → Categories → Assets           Categories → Assets (no store dim)
 *   Sage Intacct CSV (FAJ journal)         QuickBooks IIF (1 DR + 1 CR)
 *   tangible/intangible split (Depr/Amort) single Depreciation line
 *   Per-asset is_active + inactive count   (not implemented in RRF yet)
 *
 * Three-step wizard:
 *   1. Select Month — year/month/posting date/notes
 *   2. Preview — KPI summary, validation banner, drill-down by category
 *      (shows ALL non-disposed assets, with fully-depreciated rows grayed out)
 *   3. Confirm & Save — saves run + downloads IIF
 *
 * Run History tab — past runs with delete + re-download. A "saved run" is
 * the unit of record; "month closed" = there's a saved run for that month
 * (no separate strict close gate — Nathan's locked decision).
 *
 * IIF format (RRF-specific, locked decision):
 *   - 1 DR to 62400 for the month total
 *   - 1 CR to 13400 (single shared accum account)
 *   - DOCNUM = FA-{MonthAbbr}-{Year}, e.g. FA-Apr-2026
 *   - DATE   = posting date in MM/DD/YYYY
 *
 * Internal naming: variables still use `selPeriod`, `period`, `fiscal_periods`
 * etc. because those names are wired to the database schema. Only user-
 * visible labels say "Month".
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase, fetchAll } from '../lib/supabase';
import { useAppData } from '../hooks/useAppData';
import { useToast } from '../components/Toast';
import {
  calcPeriodDepr, calcAccumDepr,
  countPeriodsInService, getFiscalPeriodForDate,
  fmt$, fmtDate, fmtInt, fmtPeriodLabel,
} from '../lib/calculations';

// IIF account constants — single set since RRF doesn't split intangible
const IIF_EXPENSE_ACCT = '62400';
const IIF_ACCUM_ACCT   = '13400';

export default function DepreciationPage() {
  const {
    categories, fiscalPeriods, currentFP,
    loading: refLoading, getCategory, reload,
  } = useAppData();
  const showToast = useToast();

  // ---- wizard state ----
  const [selYear, setSelYear]       = useState(null);
  const [selPeriod, setSelPeriod]   = useState(null);
  const [postingDate, setPostingDate] = useState('');
  const [runNotes, setRunNotes]     = useState('');

  // ---- data state ----
  const [assets, setAssets]               = useState([]);
  const [existingRuns, setExistingRuns]   = useState([]);
  const [loading, setLoading]             = useState(true);

  // ---- preview state ----
  const [preview, setPreview]             = useState(null);
  const [expandedCats, setExpandedCats]   = useState(new Set());

  // ---- history state ----
  const [tab, setTab]                     = useState('wizard');
  const [historyRuns, setHistoryRuns]     = useState([]);
  const [historyDetail, setHistoryDetail] = useState(null);
  const [historyLines, setHistoryLines]   = useState([]);
  const [historyExpanded, setHistoryExpanded] = useState(new Set());

  // ---- saving state ----
  const [saving, setSaving] = useState(false);

  // ============================================================
  // Load data
  // ============================================================
  const loadData = useCallback(async () => {
    setLoading(true);
    const [allAssets, runsRes] = await Promise.all([
      fetchAll('assets'),
      supabase.from('depreciation_runs').select('*').order('fiscal_year', { ascending: false }).order('period', { ascending: false }),
    ]);
    setAssets(allAssets);
    setExistingRuns(runsRes.data || []);
    setHistoryRuns(runsRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Initialize selYear/selPeriod once currentFP arrives
  useEffect(() => {
    if (currentFP && selYear === null) {
      setSelYear(currentFP.fiscal_year);
      setSelPeriod(currentFP.period);
    }
  }, [currentFP, selYear]);

  // Auto-set posting date when period changes
  useEffect(() => {
    if (selYear && selPeriod) {
      const fp = fiscalPeriods.find(p => p.fiscal_year === selYear && p.period === selPeriod);
      if (fp) setPostingDate(fp.end_date);
    }
  }, [selYear, selPeriod, fiscalPeriods]);

  const years = [...new Set(fiscalPeriods.map(p => p.fiscal_year))].sort();

  const existingRun = useMemo(() => {
    return existingRuns.find(r => r.fiscal_year === selYear && r.period === selPeriod);
  }, [existingRuns, selYear, selPeriod]);

  // ============================================================
  // Calculate depreciation preview
  //
  // Two-pass approach (mirrors RHLC):
  //   1. Compute per-asset entry amounts for assets that ARE depreciating
  //      this month — that's the JE total.
  //   2. Collect ALL non-disposed assets (including fully-depreciated) per
  //      category so the drill-down can show them grayed out — that's how
  //      Nathan confirms "yes, asset X is fully depreciated, no entry expected".
  // ============================================================
  function calculatePreview() {
    if (!selYear || !selPeriod) return;

    // Prior month — wrap to previous year if January
    const priorMonth = selPeriod > 1
      ? { fiscal_year: selYear, period: selPeriod - 1 }
      : { fiscal_year: selYear - 1, period: 12 };

    // All non-disposed assets — this is what the drill-down shows
    const nonDisposed = assets.filter(a => !a.is_disposed);

    // Eligible = will book an entry this month
    const eligible = nonDisposed.filter(asset => {
      if (!asset.useful_life_months || asset.useful_life_months <= 0) return false;
      if (!asset.acquisition_cost || asset.acquisition_cost <= 0) return false;

      // Already fully depreciated as of prior month?
      const priorAccum = calcAccumDepr(asset, priorMonth.fiscal_year, priorMonth.period, fiscalPeriods);
      if (priorAccum >= Math.abs(asset.acquisition_cost) - 0.005) return false;

      // Must be in service by this month (months in service > 0)
      const mis = countPeriodsInService(asset, selYear, selPeriod, fiscalPeriods);
      if (mis <= 0) return false;

      return true;
    });

    // Per-asset entry amount (capped at remaining basis)
    const lines = eligible.map(asset => {
      const perMonth = calcPeriodDepr(asset);
      const accumBefore = calcAccumDepr(asset, priorMonth.fiscal_year, priorMonth.period, fiscalPeriods);
      const maxRemaining = Math.abs(asset.acquisition_cost) - accumBefore;
      const thisEntry = Math.min(perMonth, Math.max(maxRemaining, 0));

      return {
        asset,
        category_id: asset.category_id,
        location_id: asset.location_id,
        period_amount: Math.round(thisEntry * 100) / 100,
        per_period_full: perMonth, // pre-cap monthly rate
        prior_accum: accumBefore,
      };
    }).filter(l => l.period_amount > 0.005);

    // Snapshot lines — the persistence-time record of EVERY non-disposed asset
    // for this period, including ones that booked $0 (fully depreciated, not
    // yet in service). These rows give v_assets_at_close enough data to
    // reconstruct the complete period-end picture without needing to chase
    // each asset's most-recent run.
    //
    // The journal entry, IIF, and Dashboard "asset count" stat continue to use
    // `lines` (the filtered list of actual entries). Only the run_lines table
    // gets the full snapshot.
    const snapshotLines = nonDisposed.map(asset => {
      const perMonth = calcPeriodDepr(asset);
      const accumBefore = calcAccumDepr(asset, priorMonth.fiscal_year, priorMonth.period, fiscalPeriods);
      const maxRemaining = Math.abs(asset.acquisition_cost) - accumBefore;
      const thisEntry = (perMonth > 0 && maxRemaining > 0)
        ? Math.min(perMonth, maxRemaining)
        : 0;
      return {
        asset,
        category_id: asset.category_id,
        location_id: asset.location_id,
        period_amount: Math.round(thisEntry * 100) / 100,
        prior_accum: accumBefore,
      };
    });

    // entryMap: asset_id → entry amount, for the drill-down lookup
    const entryMap = {};
    for (const line of lines) {
      entryMap[line.asset.id] = line.period_amount;
    }

    // Group ALL non-disposed assets by category — drill-down wants this view
    const allByCategory = {};
    for (const a of nonDisposed) {
      if (!a.category_id) continue;
      if (!allByCategory[a.category_id]) allByCategory[a.category_id] = [];
      allByCategory[a.category_id].push(a);
    }

    // Build the per-category preview structure. We iterate categories that
    // appear in EITHER the eligible list OR the all-non-disposed list, so
    // categories with only fully-depreciated assets still show up.
    const byCategory = {};
    const allCatIds = new Set([
      ...lines.map(l => l.category_id),
      ...Object.keys(allByCategory),
    ]);

    for (const catId of allCatIds) {
      const cat = getCategory(catId);
      if (!cat) continue;
      const allAssets = allByCategory[catId] || [];

      // Per-month rate sums over only the assets that ARE depreciating
      // (fully-depreciated assets contribute 0 to the rate column)
      let perMonthTotal = 0;
      let entryTotal = 0;
      for (const a of allAssets) {
        const isDepreciating = entryMap[a.id] != null;
        if (isDepreciating) {
          perMonthTotal += calcPeriodDepr(a);
          entryTotal   += entryMap[a.id];
        }
      }

      byCategory[catId] = {
        cat,
        allAssets,                                    // every non-disposed asset in this cat
        depreciating_count: Object.keys(entryMap).filter(id => allAssets.some(a => a.id === id)).length,
        asset_count: allAssets.length,                // total displayed
        per_period_total: perMonthTotal,
        entry_total: Math.round(entryTotal * 100) / 100,
      };
    }

    const totalEntry = lines.reduce((s, l) => s + l.period_amount, 0);

    setPreview({
      lines,
      snapshotLines,
      entryMap,
      byCategory,
      priorMonth,
      totalEntry: Math.round(totalEntry * 100) / 100,
      assetCount: lines.length,
      categoryCount: Object.keys(byCategory).filter(k => byCategory[k].entry_total > 0).length,
    });
    setExpandedCats(new Set());
  }

  // ============================================================
  // Build IIF text — 1 DR + 1 CR collapsed
  // DOCNUM format: FA-{MonthAbbr}-{Year}, e.g. FA-Apr-2026
  // ============================================================
  function buildIIF(year, period, postingDateIso, totalAmount) {
    const dt = fmtDate(postingDateIso); // MM/DD/YYYY
    const docnum = `FA-${monthAbbrev(period)}-${year}`;
    const memo = `${monthAbbrev(period)} ${year} fixed assets`;
    const amt = totalAmount.toFixed(2);

    let out = '';
    out += '!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\n';
    out += '!SPL\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\n';
    out += '!ENDTRNS\n';
    out += `TRNS\tGENERAL JOURNAL\t${dt}\t${IIF_EXPENSE_ACCT}\t${amt}\t${docnum}\t${memo}\n`;
    out += `SPL\tGENERAL JOURNAL\t${dt}\t${IIF_ACCUM_ACCT}\t-${amt}\t${docnum}\t${memo}\n`;
    out += 'ENDTRNS\n';
    return out;
  }

  function downloadIIF(year, period, postingDateIso, totalAmount) {
    const text = buildIIF(year, period, postingDateIso, totalAmount);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FA-${monthAbbrev(period)}-${year}.iif`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // Save run + download IIF
  // ============================================================
  async function confirmAndSave() {
    if (!preview || saving) return;
    setSaving(true);

    try {
      // 1. Insert depreciation_run header
      const { data: runData, error: runErr } = await supabase
        .from('depreciation_runs')
        .insert([{
          fiscal_year: selYear,
          period: selPeriod,
          posting_date: postingDate,
          total_expense: preview.totalEntry,
          asset_count: preview.assetCount,
          iif_docnum: `FA-${monthAbbrev(selPeriod)}-${selYear}`,
          notes: runNotes || null,
        }])
        .select();
      if (runErr) throw runErr;

      const runId = runData[0].id;

      // 2. Insert run lines in batches of 500.
      // Persist EVERY non-disposed asset for the period (including $0 lines
      // for fully-depreciated and not-yet-in-service assets) so that
      // v_assets_at_close has a complete period-end record. The IIF and the
      // total_expense already booked above use only the lines that have a
      // real entry — `preview.lines`.
      const lineBatch = preview.snapshotLines.map(l => ({
        run_id: runId,
        asset_id: l.asset.id,
        category_id: l.category_id,
        location_id: l.location_id || null,
        period_expense: l.period_amount,
        accum_after_run: Math.round((l.prior_accum + l.period_amount) * 100) / 100,
        nbv_after_run: Math.round((l.asset.acquisition_cost - (l.prior_accum + l.period_amount)) * 100) / 100,
      }));

      for (let i = 0; i < lineBatch.length; i += 500) {
        const chunk = lineBatch.slice(i, i + 500);
        const { error: lineErr } = await supabase.from('depreciation_run_lines').insert(chunk);
        if (lineErr) throw lineErr;
      }

      // 3. Download IIF
      downloadIIF(selYear, selPeriod, postingDate, preview.totalEntry);

      showToast(`Run saved: ${monthAbbrev(selPeriod)} ${selYear} — ${preview.assetCount} assets, ${fmt$(preview.totalEntry)} total. IIF downloaded.`);

      setPreview(null);
      setRunNotes('');
      loadData();
    } catch (err) {
      console.error(err);
      showToast(`Error saving run: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  // ============================================================
  // Delete a run
  // ============================================================
  async function deleteRun(run) {
    if (!window.confirm(`Delete the ${monthAbbrev(run.period)} ${run.fiscal_year} depreciation run? This cannot be undone. The run lines will also be deleted.`)) return;
    const { error } = await supabase.from('depreciation_runs').delete().eq('id', run.id);
    if (error) {
      showToast(`Error deleting run: ${error.message}`, 'error');
      return;
    }
    showToast(`${monthAbbrev(run.period)} ${run.fiscal_year} run deleted.`);
    setHistoryDetail(null);
    setHistoryLines([]);
    loadData();
  }

  // ============================================================
  // Load run detail for drill-down
  // ============================================================
  async function loadRunDetail(run) {
    setHistoryDetail(run);
    setHistoryExpanded(new Set());
    const { data, error } = await supabase
      .from('depreciation_run_lines')
      .select('*')
      .eq('run_id', run.id);
    if (error) {
      showToast(`Error loading run detail: ${error.message}`, 'error');
      return;
    }
    setHistoryLines(data || []);
  }

  function redownloadIIF(run) {
    const totalAmount = run.total_expense ?? historyLines.reduce((s, l) => s + (l.period_expense || 0), 0);
    downloadIIF(run.fiscal_year, run.period, run.posting_date, totalAmount);
  }

  // ============================================================
  // Toggle helpers
  // ============================================================
  function toggleCat(id) {
    setExpandedCats(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleHistoryCat(id) {
    setHistoryExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ============================================================
  // Render: loading
  // ============================================================
  if (refLoading || loading) {
    return <div className="text-sm text-gray-400 p-4">Loading depreciation engine…</div>;
  }

  // ============================================================
  // Render: Category preview block (drill-down within wizard)
  //
  // Iterates ALL non-disposed assets in the category, not just the ones
  // that book an entry this month. Assets with no entry render in gray
  // — making "no entry expected, this asset is done" visually obvious.
  // ============================================================
  function renderCategoryPreview(catId) {
    const data = preview.byCategory[catId];
    const isOpen = expandedCats.has(catId);
    const cat = data.cat;
    const total = Math.round(data.entry_total * 100) / 100;
    const diff = data.per_period_total - data.entry_total;
    const hasDiff = Math.abs(diff) > 0.01;

    // How many of this cat's assets actually book an entry?
    const entryCount = data.allAssets.filter(a => preview.entryMap[a.id] != null).length;
    const skippedCount = data.allAssets.length - entryCount;

    return (
      <div key={catId} className="border-b border-gray-100 last:border-b-0">
        <div
          className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={() => toggleCat(catId)}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400 w-4">{isOpen ? '▼' : '▶'}</span>
            <span className="text-sm font-semibold">{cat.name}</span>
            <span className="text-[11px] text-gray-400 ml-2">
              ({entryCount} of {data.allAssets.length} depreciating
              {skippedCount > 0 && <>, <span className="text-gray-400">{skippedCount} fully depreciated</span></>})
            </span>
          </div>
          <div className="flex items-center gap-6 text-xs">
            <span className="text-gray-500">
              Monthly Rate: <span className="num font-semibold">{fmt$(data.per_period_total)}</span>
            </span>
            <span>
              This Month: <span className="num font-semibold">{fmt$(data.entry_total)}</span>
            </span>
            {hasDiff && (
              <span className="text-amber-600">
                Δ <span className="num font-semibold">{fmt$(diff)}</span>
              </span>
            )}
            <span className="font-bold num">{fmt$(total)}</span>
          </div>
        </div>

        {isOpen && (
          <div className="px-4 pb-3">
            {hasDiff && (
              <div className="ml-4 mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-[11.5px] text-amber-800">
                <span className="font-semibold">Difference explanation:</span>{' '}
                Monthly Rate is the standard rate for assets currently
                depreciating. This Month may differ when an asset reaches
                full depreciation in this month and only books a capped
                partial amount.
              </div>
            )}

            <table className="w-full text-[11.5px] ml-4">
              <thead>
                <tr className="text-[10px] uppercase text-gray-400 border-b border-gray-200">
                  <th className="text-left py-1 px-1.5 font-semibold">#</th>
                  <th className="text-left py-1 px-1.5 font-semibold">Asset</th>
                  <th className="text-left py-1 px-1.5 font-semibold">In-Service</th>
                  <th className="text-right py-1 px-1.5 font-semibold">Cost</th>
                  <th className="text-center py-1 px-1.5 font-semibold">Life (mo)</th>
                  <th className="text-right py-1 px-1.5 font-semibold">Monthly Rate</th>
                  <th className="text-right py-1 px-1.5 font-semibold">Prior Accum</th>
                  <th className="text-right py-1 px-1.5 font-semibold">This Month</th>
                </tr>
              </thead>
              <tbody>
                {data.allAssets
                  .slice()
                  .sort((a, b) => (a.asset_name || '').localeCompare(b.asset_name || ''))
                  .map(a => {
                    const entryAmount = preview.entryMap[a.id] ?? 0;
                    const perMonth = calcPeriodDepr(a);
                    const priorAccum = calcAccumDepr(a, preview.priorMonth.fiscal_year, preview.priorMonth.period, fiscalPeriods);
                    const isZero = entryAmount < 0.005;
                    const isCapped = !isZero && Math.abs(perMonth - entryAmount) > 0.005;
                    const rowClass = isZero
                      ? 'border-b border-gray-50 text-gray-300'
                      : 'border-b border-gray-50';
                    return (
                      <tr key={a.id} className={rowClass}>
                        <td className="py-1 px-1.5 num">{a.asset_number ?? '—'}</td>
                        <td className="py-1 px-1.5">
                          {a.asset_name}
                          {isZero && (
                            <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-50 text-amber-600 align-middle">
                              fully depreciated
                            </span>
                          )}
                        </td>
                        <td className="py-1 px-1.5">{fmtDate(a.in_service_date)}</td>
                        <td className="py-1 px-1.5 text-right num">{fmt$(a.acquisition_cost)}</td>
                        <td className="py-1 px-1.5 text-center">{a.useful_life_months || 0}</td>
                        <td className="py-1 px-1.5 text-right num">{fmt$(perMonth)}</td>
                        <td className="py-1 px-1.5 text-right num">{fmt$(priorAccum)}</td>
                        <td className={`py-1 px-1.5 text-right num font-semibold ${isCapped ? 'text-amber-600' : ''}`}>
                          {fmt$(entryAmount)}
                          {isCapped && (
                            <span className="text-[9px] ml-1" title="Capped — final partial month">⚠</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                <tr className="font-bold bg-gray-50 border-t-2 border-gray-300">
                  <td colSpan={5} className="py-1 px-1.5 text-right">{cat.name} Total</td>
                  <td className="py-1 px-1.5 text-right num">{fmt$(data.per_period_total)}</td>
                  <td className="py-1 px-1.5"></td>
                  <td className="py-1 px-1.5 text-right num">{fmt$(data.entry_total)}</td>
                </tr>
              </tbody>
            </table>

            {/* JE preview for this category */}
            <div className="ml-4 mt-3 p-3 bg-gray-50 rounded border border-gray-200">
              <div className="text-[10px] uppercase font-semibold text-gray-400 mb-1.5">
                JE Lines for {cat.name}
              </div>
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="text-[10px] uppercase text-gray-400 border-b border-gray-200">
                    <th className="text-left py-1 px-1.5 font-semibold">Account</th>
                    <th className="text-right py-1 px-1.5 font-semibold">Debit</th>
                    <th className="text-right py-1 px-1.5 font-semibold">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-100">
                    <td className="py-1 px-1.5">{cat.expense_account || IIF_EXPENSE_ACCT} — Depreciation Expense</td>
                    <td className="py-1 px-1.5 text-right num">{fmt$(data.entry_total)}</td>
                    <td className="py-1 px-1.5 text-right num text-gray-300">—</td>
                  </tr>
                  <tr className="border-b border-gray-100">
                    <td className="py-1 px-1.5">{cat.accum_account || IIF_ACCUM_ACCT} — Accumulated Depreciation</td>
                    <td className="py-1 px-1.5 text-right num text-gray-300">—</td>
                    <td className="py-1 px-1.5 text-right num">{fmt$(data.entry_total)}</td>
                  </tr>
                  <tr className="font-bold border-t-2 border-gray-300">
                    <td className="py-1 px-1.5">Total</td>
                    <td className="py-1 px-1.5 text-right num">{fmt$(total)}</td>
                    <td className="py-1 px-1.5 text-right num">{fmt$(total)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="text-[10px] text-gray-400 mt-2 leading-relaxed">
                Note: the actual IIF export collapses all categories into a single
                DR ({IIF_EXPENSE_ACCT}) and CR ({IIF_ACCUM_ACCT}) line —
                this per-category breakdown is for audit purposes only.
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ============================================================
  // Render: History detail drill-down
  // ============================================================
  function renderHistoryDetail() {
    if (!historyDetail) return null;
    const run = historyDetail;

    // Only show lines that booked an actual entry. The full snapshot
    // includes $0 placeholder lines for fully-depreciated and not-yet-
    // in-service assets — those are persisted so v_assets_at_close has
    // a complete period-end picture, but they're not part of the journal
    // entry breakdown that this view shows.
    const bookingLines = historyLines.filter(l => (l.period_expense || 0) > 0.005);

    // Group lines by category
    const byCategory = {};
    for (const line of bookingLines) {
      const catId = line.category_id;
      if (!byCategory[catId]) byCategory[catId] = { lines: [], total: 0 };
      byCategory[catId].lines.push(line);
      byCategory[catId].total += line.period_expense || 0;
    }

    const catIds = Object.keys(byCategory).sort((a, b) => {
      const ca = getCategory(a)?.name || '';
      const cb = getCategory(b)?.name || '';
      return ca.localeCompare(cb);
    });

    return (
      <div>
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => { setHistoryDetail(null); setHistoryLines([]); }}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            ← Back to Run History
          </button>
          <h3 className="text-sm font-semibold">
            {monthAbbrev(run.period)} {run.fiscal_year} — Run Detail
          </h3>
          <span className="text-[11px] text-gray-400">
            {bookingLines.length} line{bookingLines.length !== 1 ? 's' : ''} ·{' '}
            Posted {fmtDate(run.posting_date)} ·{' '}
            Run {new Date(run.run_date).toLocaleDateString()}
          </span>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-white border rounded-md p-3">
            <div className="text-[10px] uppercase text-gray-400 font-semibold">Asset Count</div>
            <div className="text-lg font-bold">{fmtInt(run.asset_count)}</div>
          </div>
          <div className="bg-white border rounded-md p-3">
            <div className="text-[10px] uppercase text-gray-400 font-semibold">Total Expense ({IIF_EXPENSE_ACCT}→{IIF_ACCUM_ACCT})</div>
            <div className="text-lg font-bold num">{fmt$(run.total_expense)}</div>
          </div>
          <div className="bg-white border rounded-md p-3">
            <div className="text-[10px] uppercase text-gray-400 font-semibold">IIF Doc#</div>
            <div className="text-sm font-mono mt-1">{run.iif_docnum}</div>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => redownloadIIF(run)}
            disabled={bookingLines.length === 0}
            className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-40"
          >
            Re-download IIF
          </button>
          <button
            onClick={() => deleteRun(run)}
            className="px-3 py-1.5 text-xs font-medium bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100"
          >
            Delete Run
          </button>
        </div>

        {run.notes && (
          <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded text-[11.5px] text-blue-800">
            <span className="font-semibold">Notes:</span> {run.notes}
          </div>
        )}

        {/* Per-category breakdown */}
        <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
            <span className="text-xs font-semibold uppercase text-gray-500">By Category</span>
          </div>
          {catIds.map(catId => {
            const data = byCategory[catId];
            const cat = getCategory(catId);
            const isOpen = historyExpanded.has(catId);
            return (
              <div key={catId} className="border-b border-gray-100 last:border-b-0">
                <div
                  className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-gray-50"
                  onClick={() => toggleHistoryCat(catId)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-400 w-4">{isOpen ? '▼' : '▶'}</span>
                    <span className="text-sm font-semibold">{cat?.name || '(unknown)'}</span>
                    <span className="text-[11px] text-gray-400">
                      ({data.lines.length} asset{data.lines.length !== 1 ? 's' : ''})
                    </span>
                  </div>
                  <div className="flex items-center gap-6 text-xs">
                    <span className="font-bold num">{fmt$(data.total)}</span>
                  </div>
                </div>

                {isOpen && (
                  <div className="px-4 pb-2">
                    <table className="w-full text-[11.5px] ml-6">
                      <thead>
                        <tr className="text-[10px] uppercase text-gray-400 border-b border-gray-200">
                          <th className="text-left py-1 px-1.5 font-semibold">Asset ID</th>
                          <th className="text-right py-1 px-1.5 font-semibold">Month Amount</th>
                          <th className="text-right py-1 px-1.5 font-semibold">Accum After</th>
                          <th className="text-right py-1 px-1.5 font-semibold">NBV After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.lines.map(line => (
                          <tr key={line.id || `${line.run_id}-${line.asset_id}`} className="border-b border-gray-50">
                            <td className="py-1 px-1.5 font-mono text-gray-500">{line.asset_id}</td>
                            <td className="py-1 px-1.5 text-right num">{fmt$(line.period_expense)}</td>
                            <td className="py-1 px-1.5 text-right num">{fmt$(line.accum_after_run)}</td>
                            <td className="py-1 px-1.5 text-right num">{fmt$(line.nbv_after_run)}</td>
                          </tr>
                        ))}
                        <tr className="font-bold bg-gray-50 border-t-2 border-gray-300">
                          <td className="py-1 px-1.5">Subtotal</td>
                          <td className="py-1 px-1.5 text-right num">{fmt$(data.total)}</td>
                          <td colSpan={2}></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ============================================================
  // Main render
  // ============================================================
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Depreciation Engine</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 mb-4 bg-gray-100 rounded p-0.5 w-fit">
        {[['wizard', 'New Run'], ['history', 'Run History']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => { setTab(key); if (key === 'history') setHistoryDetail(null); }}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors
              ${tab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            {label}
            {key === 'history' && historyRuns.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-gray-200 text-gray-600 px-1.5 rounded-full">{historyRuns.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ============================================================ */}
      {/* TAB: New Run Wizard */}
      {/* ============================================================ */}
      {tab === 'wizard' && (
        <div>
          {/* Step 1: Select Month */}
          <div className="bg-white border border-gray-200 rounded-md shadow-sm p-5 mb-4">
            <h2 className="text-sm font-semibold mb-3">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold mr-2">1</span>
              Select Month
            </h2>

            <div className="flex items-end gap-4 flex-wrap">
              <div>
                <label className="block text-[11px] text-gray-500 font-semibold mb-1">Year</label>
                <select
                  value={selYear || ''}
                  onChange={e => setSelYear(parseInt(e.target.value, 10))}
                  className="px-2 py-1.5 border rounded text-xs w-24"
                >
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 font-semibold mb-1">Month</label>
                <select
                  value={selPeriod || ''}
                  onChange={e => setSelPeriod(parseInt(e.target.value, 10))}
                  className="px-2 py-1.5 border rounded text-xs w-32"
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(p => (
                    <option key={p} value={p}>{monthAbbrev(p)} ({String(p).padStart(2,'0')})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 font-semibold mb-1">Posting Date</label>
                <input
                  type="date"
                  value={postingDate}
                  onChange={e => setPostingDate(e.target.value)}
                  className="px-2 py-1.5 border rounded text-xs"
                />
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="block text-[11px] text-gray-500 font-semibold mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={runNotes}
                  onChange={e => setRunNotes(e.target.value)}
                  placeholder="e.g., Monthly depreciation run"
                  className="px-2 py-1.5 border rounded text-xs w-full"
                />
              </div>
              <button
                onClick={calculatePreview}
                className="px-4 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Calculate Preview
              </button>
            </div>

            {/* Existing run warning */}
            {existingRun && (
              <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                <span className="font-semibold">⚠ A run already exists for {monthAbbrev(selPeriod)} {selYear}</span>
                <span className="ml-2">
                  (run {new Date(existingRun.run_date).toLocaleDateString()},
                  total {fmt$(existingRun.total_expense)}). Delete it from
                  Run History before saving a new one.
                </span>
              </div>
            )}

            {/* Selected month caption */}
            {selYear && selPeriod && (
              <div className="mt-3 text-[11px] text-gray-500">
                Month: <span className="font-semibold">{fmtPeriodLabel(selYear, selPeriod)}</span>
              </div>
            )}
          </div>

          {/* Step 2: Preview */}
          {preview && (
            <div className="bg-white border border-gray-200 rounded-md shadow-sm mb-4">
              <div className="p-5 border-b border-gray-100">
                <h2 className="text-sm font-semibold mb-3">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold mr-2">2</span>
                  Preview — {monthAbbrev(selPeriod)} {selYear}
                </h2>

                {/* Summary cards */}
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <div className="bg-gray-50 rounded-md p-3 border">
                    <div className="text-[10px] uppercase text-gray-400 font-semibold">Categories</div>
                    <div className="text-lg font-bold">{preview.categoryCount}</div>
                  </div>
                  <div className="bg-gray-50 rounded-md p-3 border">
                    <div className="text-[10px] uppercase text-gray-400 font-semibold">Assets Depreciating</div>
                    <div className="text-lg font-bold">{fmtInt(preview.assetCount)}</div>
                  </div>
                  <div className="bg-gray-50 rounded-md p-3 border">
                    <div className="text-[10px] uppercase text-gray-400 font-semibold">Posting Date</div>
                    <div className="text-lg font-bold">{fmtDate(postingDate)}</div>
                  </div>
                  <div className="bg-blue-50 rounded-md p-3 border border-blue-200">
                    <div className="text-[10px] uppercase text-blue-600 font-semibold">Total This Month</div>
                    <div className="text-lg font-bold num text-blue-800">{fmt$(preview.totalEntry)}</div>
                  </div>
                </div>

                {/* JE balance check */}
                <div className="text-[11px] text-green-700 bg-green-50 rounded px-3 py-1.5 border border-green-200">
                  ✓ JE balances: DR {IIF_EXPENSE_ACCT} {fmt$(preview.totalEntry)} = CR {IIF_ACCUM_ACCT} {fmt$(preview.totalEntry)}
                  <span className="ml-3 text-gray-400">(2 IIF lines collapsed from {preview.assetCount} per-asset rows)</span>
                </div>
              </div>

              {/* Per-category drill-down */}
              <div>
                <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                  <span className="text-xs font-semibold uppercase text-gray-500">By Category (click to expand)</span>
                </div>
                {Object.keys(preview.byCategory)
                  .sort((a, b) => {
                    const ca = preview.byCategory[a].cat.name;
                    const cb = preview.byCategory[b].cat.name;
                    return ca.localeCompare(cb);
                  })
                  .map(catId => renderCategoryPreview(catId))}
              </div>
            </div>
          )}

          {/* Step 3: Confirm & Save */}
          {preview && (
            <div className="bg-white border border-gray-200 rounded-md shadow-sm p-5">
              <h2 className="text-sm font-semibold mb-3">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold mr-2">3</span>
                Confirm & Export
              </h2>

              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={() => downloadIIF(selYear, selPeriod, postingDate, preview.totalEntry)}
                  className="px-4 py-2 text-xs font-medium bg-gray-100 text-gray-700 border border-gray-300 rounded hover:bg-gray-200"
                >
                  Download IIF Only (don't save run)
                </button>
                <button
                  onClick={confirmAndSave}
                  disabled={saving || !!existingRun}
                  className="px-4 py-2 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving…' : 'Save Run & Download IIF'}
                </button>
                {existingRun && (
                  <span className="text-xs text-amber-600">
                    Delete existing run for {monthAbbrev(selPeriod)} {selYear} before saving a new one.
                  </span>
                )}
              </div>

              <div className="mt-3 text-[11px] text-gray-400 leading-relaxed">
                Saving will record this run to the audit trail ({preview.assetCount} asset line{preview.assetCount !== 1 ? 's' : ''}).
                The IIF file (FA-{monthAbbrev(selPeriod)}-{selYear}.iif) will be downloaded
                for QuickBooks import — 1 DR to {IIF_EXPENSE_ACCT}, 1 CR to {IIF_ACCUM_ACCT}.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* TAB: Run History */}
      {/* ============================================================ */}
      {tab === 'history' && (
        <div>
          {historyDetail ? renderHistoryDetail() : (
            <>
              {historyRuns.length === 0 ? (
                <div className="bg-white border border-gray-200 rounded-md shadow-sm p-8 text-center">
                  <div className="text-4xl mb-3">📝</div>
                  <h2 className="text-base font-semibold mb-1">No depreciation runs yet</h2>
                  <p className="text-sm text-gray-500">Use the New Run tab to calculate and save your first depreciation entry.</p>
                </div>
              ) : (
                <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-3 py-2 font-semibold text-[11px] uppercase text-gray-500">Month</th>
                        <th className="text-left px-3 py-2 font-semibold text-[11px] uppercase text-gray-500">Posting Date</th>
                        <th className="text-left px-3 py-2 font-semibold text-[11px] uppercase text-gray-500">Run Date</th>
                        <th className="text-right px-3 py-2 font-semibold text-[11px] uppercase text-gray-500">Assets</th>
                        <th className="text-right px-3 py-2 font-semibold text-[11px] uppercase text-gray-500">Total</th>
                        <th className="text-left px-3 py-2 font-semibold text-[11px] uppercase text-gray-500">IIF Doc#</th>
                        <th className="text-right px-3 py-2 font-semibold text-[11px] uppercase text-gray-500">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRuns.map(run => (
                        <tr key={run.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                          <td className="px-3 py-2 font-semibold">{monthAbbrev(run.period)} {run.fiscal_year}</td>
                          <td className="px-3 py-2">{fmtDate(run.posting_date)}</td>
                          <td className="px-3 py-2 text-gray-500">{new Date(run.run_date).toLocaleDateString()}</td>
                          <td className="px-3 py-2 text-right num">{fmtInt(run.asset_count)}</td>
                          <td className="px-3 py-2 text-right num font-bold">{fmt$(run.total_expense)}</td>
                          <td className="px-3 py-2 font-mono text-gray-500">{run.iif_docnum || '—'}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => loadRunDetail(run)}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium mr-2"
                            >
                              Detail
                            </button>
                            <button
                              onClick={() => deleteRun(run)}
                              className="text-xs text-red-500 hover:text-red-700 font-medium"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================
function monthAbbrev(p) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][p - 1];
}
