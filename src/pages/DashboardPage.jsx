/**
 * Dashboard
 *
 * Landing page. Surfaces the things that matter at a glance:
 *
 *   1. "As of" caption — latest closed period (e.g. "As of March 2026")
 *   2. KPI row 1 — Cost, Accum Depr, NBV, Monthly Depr (from snapshot)
 *   3. KPI row 2 — Fully Depr, Disposed, Section A, Section B (lifecycle)
 *   4. Locations status row (CTA when empty)
 *   5. By-category breakdown table
 *   6. Acquisitions-by-year table with bar-chart distribution
 *
 * Data strategy:
 *   - Financial KPIs read from `v_assets_at_close` for the latest SAVED
 *     depreciation run. That's the IMMUTABLE snapshot — Dashboard numbers
 *     tie exactly to what was posted, never to live calc.
 *   - "Latest" comes from `depreciation_runs` (NOT `fiscal_periods.status`).
 *     The strict period-close workflow was dropped in the rebuild — a saved
 *     run IS the close signal, so Dashboard reads the most recent run
 *     directly. (Architecture decision #5 in the project doc.)
 *   - Lifecycle counts (Section A/B, disposed) come from the live `assets`
 *     table — those are point-in-time facts about the register, not
 *     period-end financials.
 *
 * If no run has been saved yet, fall back to a clear empty state — never
 * silently mix live and snapshot data.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmt$, fmtInt, fmtPct, fmtPeriodLabel, lastDayOfMonth } from '../lib/calculations';

export default function DashboardPage() {
  const [snapshot, setSnapshot]       = useState(null);
  const [allAssets, setAllAssets]     = useState(null);
  const [locations, setLocations]     = useState(null);
  const [asOfPeriod, setAsOfPeriod]   = useState(null);
  const [hasNoCloses, setHasNoCloses] = useState(false);
  const [error, setError]             = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Latest saved depreciation run — everything financial depends on this.
        // (Architecture decision #5: a saved run = the period close signal;
        // the obsolete fiscal_periods.status flag is no longer maintained.)
        const periodRes = await supabase
          .from('depreciation_runs')
          .select('fiscal_year, period')
          .order('fiscal_year', { ascending: false })
          .order('period', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cancelled) return;
        if (periodRes.error) throw periodRes.error;
        const period = periodRes.data;

        // Locations + lifecycle assets always fetched
        const [locsRes, lifeRes] = await Promise.all([
          supabase.from('locations').select('id, is_active'),
          supabase.from('assets').select('is_disposed, section'),
        ]);

        if (cancelled) return;
        if (locsRes.error) throw locsRes.error;
        if (lifeRes.error) throw lifeRes.error;

        setLocations(locsRes.data || []);
        setAllAssets(lifeRes.data || []);

        if (!period) {
          setHasNoCloses(true);
          setSnapshot([]);
          setAsOfPeriod(null);
          return;
        }

        setAsOfPeriod(period);

        const snapRes = await supabase
          .from('v_assets_at_close')
          .select(
            'asset_id, acquisition_date, acquisition_cost, accum_depr, nbv, ' +
            'monthly_depr, is_disposed, section, status_note, ' +
            'category_id, category_name'
          )
          .eq('fiscal_year', period.fiscal_year)
          .eq('period', period.period);

        if (cancelled) return;
        if (snapRes.error) throw snapRes.error;
        setSnapshot(snapRes.data || []);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // ---- error / loading ----
  if (error) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Dashboard</h1>
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load dashboard:</strong> {error}
        </div>
      </div>
    );
  }

  if (!snapshot || !allAssets || !locations) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Dashboard</h1>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </div>
    );
  }

  // ---- aggregates ----
  const totalCost    = sum(snapshot, a => a.acquisition_cost);
  const totalAccum   = sum(snapshot, a => a.accum_depr);
  const totalNBV     = sum(snapshot, a => a.nbv);
  const totalMonthly = sum(snapshot, a => a.monthly_depr);

  const activeAtClose = snapshot.filter(a => !a.is_disposed);
  const fullyDeprCount = activeAtClose.filter(a =>
    (a.status_note || '').toLowerCase().includes('fully')
    || (a.nbv != null && a.nbv <= 0.005)
  ).length;

  const disposedCount  = allAssets.filter(a =>  a.is_disposed).length;
  const sectionACount  = allAssets.filter(a => a.section === 'A').length;
  const sectionBCount  = allAssets.filter(a => a.section === 'B').length;

  const asOfCaption = asOfPeriod
    ? `As of ${fmtPeriodLabel(asOfPeriod.fiscal_year, asOfPeriod.period)} (${lastDayOfMonth(asOfPeriod.fiscal_year, asOfPeriod.period)})`
    : 'No depreciation runs saved yet';

  // ---- empty state ----
  if (hasNoCloses) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-1">Dashboard</h1>
        <p className="text-sm text-gray-500 mb-4">{asOfCaption}</p>
        <div className="px-4 py-3 bg-blue-50 text-blue-800 border border-blue-200 rounded text-sm leading-relaxed">
          <strong>No depreciation run saved yet.</strong>{' '}
          The Dashboard reads its financial totals from the latest saved
          depreciation run. Run and save a month from the Depreciation
          Engine to populate this view.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-lg font-semibold mb-1">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-5">{asOfCaption}</p>

      {/* Row 1 — financial totals */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard
          label="Total Cost"
          value={fmt$(totalCost)}
          sub={`${fmtInt(activeAtClose.length)} active assets`}
        />
        <StatCard
          label="Accum Depreciation"
          value={fmt$(totalAccum)}
          sub={`${fmtPct(totalCost > 0 ? totalAccum / totalCost : null)} of cost`}
        />
        <StatCard
          label="Net Book Value"
          value={fmt$(totalNBV)}
          sub={`${fmtPct(totalCost > 0 ? totalNBV / totalCost : null)} remaining`}
        />
        <StatCard
          label="Monthly Depr"
          value={fmt$(totalMonthly)}
          sub={`${fmt$(totalMonthly * 12)}/yr annualized`}
        />
      </div>

      {/* Row 2 — lifecycle counts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard
          label="Fully Depreciated"
          value={fmtInt(fullyDeprCount)}
          sub="NBV = $0, still active"
        />
        <StatCard
          label="Disposed"
          value={fmtInt(disposedCount)}
          sub={disposedCount === 0 ? 'none yet' : 'retired from register'}
        />
        <StatCard
          label="Section A (legacy)"
          value={fmtInt(sectionACount)}
          sub="pre-2022 assets"
        />
        <StatCard
          label="Section B (current)"
          value={fmtInt(sectionBCount)}
          sub="2022+ additions"
        />
      </div>

      {/* Row 3 — locations row OR empty-state CTA */}
      <LocationStatRow locations={locations} />

      {/* Category breakdown */}
      <CategoryBreakdownCard rows={snapshot} />

      {/* Acquisitions by year */}
      <AcquisitionsByYearCard rows={snapshot} />
    </div>
  );
}

// ============================================================
// Subcomponents
// ============================================================

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white border border-gray-200 rounded-md p-4 shadow-sm">
      <div className="text-[10px] uppercase font-semibold text-gray-400 tracking-wider mb-1">
        {label}
      </div>
      <div className="text-2xl font-bold num leading-tight mb-1" style={{ fontSize: '1.5rem' }}>
        {value}
      </div>
      <div className="text-[11px] text-gray-400">{sub}</div>
    </div>
  );
}

function LocationStatRow({ locations }) {
  if (locations.length === 0) {
    return (
      <div className="px-4 py-3 bg-blue-50 text-blue-800 border border-blue-200 rounded text-sm leading-relaxed mb-5">
        <strong>Locations not defined yet.</strong>{' '}
        Head to <b>Admin → Locations</b> to add physical locations (e.g. Line 1,
        Line 2, Warehouse, Office). Once defined, a "By Location" breakdown
        will appear here and in the register.
      </div>
    );
  }

  const activeLocs = locations.filter(l => l.is_active).length;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      <StatCard
        label="Locations Defined"
        value={fmtInt(locations.length)}
        sub={`${fmtInt(activeLocs)} active`}
      />
    </div>
  );
}

function CategoryBreakdownCard({ rows }) {
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.category_id) || {
      name: r.category_name,
      activeCount: 0, disposedCount: 0,
      cost: 0, accum: 0, nbv: 0, monthly: 0,
    };
    if (r.is_disposed) cur.disposedCount += 1; else cur.activeCount += 1;
    cur.cost    += r.acquisition_cost || 0;
    cur.accum   += r.accum_depr || 0;
    cur.nbv     += r.nbv || 0;
    cur.monthly += r.monthly_depr || 0;
    map.set(r.category_id, cur);
  }
  const cats = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));

  const totals = cats.reduce(
    (acc, c) => ({
      activeCount: acc.activeCount + c.activeCount,
      cost: acc.cost + c.cost,
      accum: acc.accum + c.accum,
      nbv: acc.nbv + c.nbv,
      monthly: acc.monthly + c.monthly,
    }),
    { activeCount: 0, cost: 0, accum: 0, nbv: 0, monthly: 0 },
  );

  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden mb-5">
      <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold uppercase text-gray-500 tracking-wider">By Category</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Category</th>
              <th className="text-center px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Active</th>
              <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Cost</th>
              <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Accum Depr</th>
              <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">NBV</th>
              <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Monthly Depr</th>
              <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">% Depr'd</th>
            </tr>
          </thead>
          <tbody>
            {cats.map(c => (
              <tr key={c.name} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <td className="px-3 py-2">{c.name}</td>
                <td className="px-3 py-2 text-center num">{fmtInt(c.activeCount)}</td>
                <td className="px-3 py-2 text-right num">{fmt$(c.cost)}</td>
                <td className="px-3 py-2 text-right num">{fmt$(c.accum)}</td>
                <td className="px-3 py-2 text-right num">{fmt$(c.nbv)}</td>
                <td className="px-3 py-2 text-right num">{fmt$(c.monthly)}</td>
                <td className="px-3 py-2 text-right num">
                  {fmtPct(c.cost > 0 ? c.accum / c.cost : null)}
                </td>
              </tr>
            ))}
            <tr className="bg-blue-50 border-t-2 border-blue-300 font-bold">
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 text-center num">{fmtInt(totals.activeCount)}</td>
              <td className="px-3 py-2 text-right num">{fmt$(totals.cost)}</td>
              <td className="px-3 py-2 text-right num">{fmt$(totals.accum)}</td>
              <td className="px-3 py-2 text-right num">{fmt$(totals.nbv)}</td>
              <td className="px-3 py-2 text-right num">{fmt$(totals.monthly)}</td>
              <td className="px-3 py-2 text-right num">
                {fmtPct(totals.cost > 0 ? totals.accum / totals.cost : null)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AcquisitionsByYearCard({ rows }) {
  const byYear = new Map();
  for (const a of rows) {
    if (!a.acquisition_date) continue;
    const yr = a.acquisition_date.slice(0, 4);
    const cur = byYear.get(yr) || { count: 0, cost: 0 };
    cur.count += 1;
    cur.cost  += a.acquisition_cost || 0;
    byYear.set(yr, cur);
  }

  const yearRows = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxCost  = yearRows.reduce((m, [, v]) => Math.max(m, v.cost), 0);

  if (yearRows.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden mb-5">
        <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50">
          <h2 className="text-sm font-semibold uppercase text-gray-500 tracking-wider">Acquisitions by Year</h2>
        </div>
        <div className="px-4 py-6 text-sm text-gray-400">
          No acquisition dates recorded yet.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden mb-5">
      <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold uppercase text-gray-500 tracking-wider">Acquisitions by Year</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Year</th>
              <th className="text-center px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Assets</th>
              <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Total Cost</th>
              <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase text-gray-500">Avg Cost</th>
              <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase text-gray-500" style={{ width: '40%' }}>Distribution</th>
            </tr>
          </thead>
          <tbody>
            {yearRows.map(([yr, v]) => {
              const pctWidth = maxCost > 0 ? (v.cost / maxCost) * 100 : 0;
              return (
                <tr key={yr} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-3 py-2">{yr}</td>
                  <td className="px-3 py-2 text-center num">{fmtInt(v.count)}</td>
                  <td className="px-3 py-2 text-right num">{fmt$(v.cost)}</td>
                  <td className="px-3 py-2 text-right num">
                    {fmt$(v.count > 0 ? v.cost / v.count : null)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="w-full h-2.5 bg-gray-100 rounded-sm overflow-hidden border border-gray-200">
                      <div
                        className="h-full bg-blue-600 transition-all"
                        style={{ width: `${pctWidth}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- utilities ----

function sum(arr, pick) {
  let total = 0;
  for (const x of arr) total += (pick(x) ?? 0);
  return total;
}
