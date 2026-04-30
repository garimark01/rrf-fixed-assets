/**
 * Reports
 *
 * Self-contained Excel export center. Five reports, each with its own
 * parameters and download button:
 *
 *   1. Asset Register         — period selector (any saved run / FY+period)
 *   2. Depreciation Schedule  — period selector; two tabs (Snapshot, Forward Projection)
 *   3. Roll-forward           — period range (start FY+period → end FY+period)
 *   4. Acquisitions           — date range (against acquisition_date)
 *   5. Disposals              — date range (against disposal_date)
 *
 * Output: each report = its own .xlsx file via xlsx-js-style.
 * Styling matches the convention used elsewhere in Nathan's tools:
 *   - Navy headers (#1E3A5F) with white bold text
 *   - Light-blue subtotals (#D5E8F0)
 *   - Accounting number format on $$ columns
 *
 * Period defaults:
 *   - Single-period reports default to latest saved depreciation run, or
 *     current fiscal period if none saved.
 *   - Range reports default to YTD of the latest saved run (or YTD of
 *     current calendar year if none).
 *   - Date-range reports default to YTD calendar year.
 *
 * Data sources (consistent with Asset Register / Disposals / Reconciliation):
 *   - Assets: fetchAll('v_assets_current') — one row per asset with anchor +
 *     life inputs needed for live calc
 *   - Disposals: supabase.from('disposals').select('*')
 *   - Saved runs: supabase.from('depreciation_runs').select('fiscal_year, period')
 *     — used only to mark which periods have a saved close (✓ in dropdowns)
 *   - All math uses the calc module (single source of truth)
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import * as XLSX from 'xlsx-js-style';
import { supabase, fetchAll } from '../lib/supabase';
import { useToast } from '../components/Toast';
import {
  fmt$, fmtInt, fmtDate, fmtPeriodLabel,
  calcAccumDepr, calcPeriodDepr, countPeriodsInService,
  getCurrentFiscalPeriod, lastDayOfMonth,
} from '../lib/calculations';

// ============================================================
// Style constants for Excel output
// ============================================================
const NAVY = '1E3A5F';
const LIGHT_BLUE = 'D5E8F0';

const HEADER_STYLE = {
  font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
  fill: { fgColor: { rgb: NAVY } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: {
    top:    { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left:   { style: 'thin', color: { rgb: '000000' } },
    right:  { style: 'thin', color: { rgb: '000000' } },
  },
};

const SUBTOTAL_STYLE = {
  font: { bold: true, sz: 10 },
  fill: { fgColor: { rgb: LIGHT_BLUE } },
  border: {
    top:    { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
  },
};

const TOTAL_STYLE = {
  font: { bold: true, sz: 11 },
  fill: { fgColor: { rgb: LIGHT_BLUE } },
  border: {
    top:    { style: 'medium', color: { rgb: '000000' } },
    bottom: { style: 'double', color: { rgb: '000000' } },
  },
};

const TITLE_STYLE = {
  font: { bold: true, sz: 14, color: { rgb: NAVY } },
  alignment: { horizontal: 'left' },
};

const SUBTITLE_STYLE = {
  font: { sz: 10, color: { rgb: '666666' }, italic: true },
  alignment: { horizontal: 'left' },
};

// Accounting format: positive shown plain, negative in parens, zero as "-"
const FMT_ACCT = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
const FMT_INT = '#,##0';
const FMT_DATE = 'm/d/yyyy';

// ============================================================
// Cell helpers
// ============================================================
function cell(v, style = null, fmt = null) {
  const c = { v };
  if (typeof v === 'number') c.t = 'n';
  else if (v instanceof Date) { c.t = 'd'; }
  else c.t = 's';
  if (style) c.s = { ...style };
  if (fmt) {
    c.s = c.s || {};
    c.s.numFmt = fmt;
  }
  return c;
}

function $cell(v, style = null) {
  return cell(typeof v === 'number' ? v : 0, style, FMT_ACCT);
}
function intCell(v, style = null) {
  return cell(typeof v === 'number' ? v : 0, style, FMT_INT);
}
function dateCell(d, style = null) {
  if (!d) return cell('', style);
  // Pass an actual Date so Excel treats it as a date
  const parts = d.slice(0, 10).split('-');
  if (parts.length !== 3) return cell(d, style);
  const dt = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  return cell(dt, style, FMT_DATE);
}

function setColWidths(ws, widths) {
  ws['!cols'] = widths.map(w => ({ wch: w }));
}

function setRowHeights(ws, heights) {
  ws['!rows'] = heights.map(h => ({ hpt: h }));
}

function downloadWb(wb, filename) {
  XLSX.writeFile(wb, filename, { cellStyles: true });
}

// ============================================================
// Page component
// ============================================================
export default function ReportsPage() {
  const showToast = useToast();
  const [assets, setAssets] = useState(null);
  const [categories, setCategories] = useState(null);
  const [locations, setLocations] = useState(null);
  const [fiscalPeriods, setFiscalPeriods] = useState(null);
  const [savedRuns, setSavedRuns] = useState(null);
  const [disposals, setDisposals] = useState(null);
  const [error, setError] = useState(null);

  const [busyKey, setBusyKey] = useState(null);  // which report is currently exporting

  // Per-report parameters
  const [registerPeriod, setRegisterPeriod] = useState(null);   // {fiscal_year, period}
  const [scheduleStart, setScheduleStart] = useState(null);     // {fiscal_year, period}
  const [scheduleProjMonths, setScheduleProjMonths] = useState(12);
  const [rollStart, setRollStart] = useState(null);
  const [rollEnd, setRollEnd] = useState(null);
  const [acqStart, setAcqStart] = useState('');
  const [acqEnd, setAcqEnd] = useState('');
  const [dispStart, setDispStart] = useState('');
  const [dispEnd, setDispEnd] = useState('');

  // ---- load ----
  const load = useCallback(async () => {
    setError(null);
    try {
      const [aData, catsRes, locsRes, fpRes, runsRes, dispRes] = await Promise.all([
        fetchAll('v_assets_current'),
        supabase.from('categories').select('id, name, sort_order').order('sort_order'),
        supabase.from('locations').select('id, name, is_active, sort_order').order('sort_order', { nullsFirst: false }),
        supabase.from('fiscal_periods').select('fiscal_year, period, start_date, end_date').order('fiscal_year').order('period'),
        supabase.from('depreciation_runs').select('fiscal_year, period').order('fiscal_year', { ascending: false }).order('period', { ascending: false }),
        supabase.from('disposals').select('*').order('disposal_date', { ascending: false }),
      ]);
      if (catsRes.error) throw catsRes.error;
      if (locsRes.error) throw locsRes.error;
      if (fpRes.error) throw fpRes.error;
      if (runsRes.error) throw runsRes.error;
      // disposals table is optional — tolerate missing
      const disposalsList = dispRes.error ? [] : (dispRes.data || []);

      setAssets(aData);
      setCategories(catsRes.data || []);
      setLocations(locsRes.data || []);
      setFiscalPeriods(fpRes.data || []);
      setSavedRuns(runsRes.data || []);
      setDisposals(disposalsList);

      // Seed defaults
      const fps = fpRes.data || [];
      const runs = runsRes.data || [];
      const defaultPeriod = runs.length > 0
        ? { fiscal_year: runs[0].fiscal_year, period: runs[0].period }
        : (fps.length > 0
            ? (() => { const cur = getCurrentFiscalPeriod(fps); return { fiscal_year: cur.fiscal_year, period: cur.period }; })()
            : null);

      // Compute earliest valid roll-forward start (= latest anchor + 1) so
      // we don't seed an invalid pre-anchor default.
      let earliestStart = null;
      if (fps.length > 0) {
        let latestY = null, latestP = null;
        for (const a of (aData || [])) {
          if (!a.legacy_as_of_date) continue;
          const fp = fps.find(
            f => a.legacy_as_of_date >= f.start_date && a.legacy_as_of_date <= f.end_date
          );
          if (!fp) continue;
          if (latestY == null || fp.fiscal_year > latestY
              || (fp.fiscal_year === latestY && fp.period > latestP)) {
            latestY = fp.fiscal_year; latestP = fp.period;
          }
        }
        if (latestY != null) {
          let y = latestY, p = latestP + 1;
          if (p > 12) { p = 1; y += 1; }
          earliestStart = { fiscal_year: y, period: p };
        } else {
          earliestStart = { fiscal_year: fps[0].fiscal_year, period: fps[0].period };
        }
      }

      if (defaultPeriod) {
        setRegisterPeriod(prev => prev || defaultPeriod);
        setScheduleStart(prev => prev || defaultPeriod);
        // Roll-forward start defaults to earliestStart (anchor+1) — never
        // before the anchor, since that would silently produce wrong math.
        // If defaultPeriod is BEFORE earliestStart (shouldn't happen in
        // practice but guard anyway), fall back to earliestStart for end too.
        const rollStartDefault = earliestStart || defaultPeriod;
        const rollEndDefault = (() => {
          if (!earliestStart) return defaultPeriod;
          // If defaultPeriod is before earliestStart, use earliestStart for end
          if (defaultPeriod.fiscal_year < earliestStart.fiscal_year
              || (defaultPeriod.fiscal_year === earliestStart.fiscal_year
                  && defaultPeriod.period < earliestStart.period)) {
            return earliestStart;
          }
          return defaultPeriod;
        })();
        setRollStart(prev => prev || rollStartDefault);
        setRollEnd(prev => prev || rollEndDefault);
      }

      // Date-range defaults: YTD of current calendar year
      const today = new Date();
      const ytdStart = `${today.getFullYear()}-01-01`;
      const ytdEnd = today.toISOString().slice(0, 10);
      setAcqStart(prev => prev || ytdStart);
      setAcqEnd(prev => prev || ytdEnd);
      setDispStart(prev => prev || ytdStart);
      setDispEnd(prev => prev || ytdEnd);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ---- derived: list of all FY-period options for dropdowns ----
  const periodOptions = useMemo(() => {
    if (!fiscalPeriods) return [];
    const savedSet = new Set((savedRuns || []).map(r => `${r.fiscal_year}-${r.period}`));
    return fiscalPeriods.map(fp => ({
      key: `${fp.fiscal_year}-${fp.period}`,
      fiscal_year: fp.fiscal_year,
      period: fp.period,
      label: fmtPeriodLabel(fp.fiscal_year, fp.period),
      saved: savedSet.has(`${fp.fiscal_year}-${fp.period}`),
    }));
  }, [fiscalPeriods, savedRuns]);

  // ---- derived: earliest valid roll-forward START period ----
  // The roll-forward needs a reconstructable accum balance at the END of the
  // period BEFORE the start period. For anchored assets, we only have the
  // legacy_accum balance AT the anchor month — periods before that are
  // mathematically undefined (the migration didn't carry monthly history).
  //
  // So the earliest valid start period is: (latest anchor month across all
  // anchored assets) + 1. Any earlier start would silently use the anchor
  // balance as if it were the prior balance, which is the bug we just hit.
  const earliestRollStart = useMemo(() => {
    if (!assets || !fiscalPeriods || fiscalPeriods.length === 0) return null;
    let latestAnchorY = null, latestAnchorP = null;
    for (const a of assets) {
      if (!a.legacy_as_of_date) continue;
      const fp = fiscalPeriods.find(
        f => a.legacy_as_of_date >= f.start_date && a.legacy_as_of_date <= f.end_date
      );
      if (!fp) continue;
      if (latestAnchorY == null
          || fp.fiscal_year > latestAnchorY
          || (fp.fiscal_year === latestAnchorY && fp.period > latestAnchorP)) {
        latestAnchorY = fp.fiscal_year;
        latestAnchorP = fp.period;
      }
    }
    if (latestAnchorY == null) {
      // No anchored assets — earliest valid start is the earliest fiscal period
      const first = fiscalPeriods[0];
      return { fiscal_year: first.fiscal_year, period: first.period };
    }
    // Anchor + 1
    let y = latestAnchorY, p = latestAnchorP + 1;
    if (p > 12) { p = 1; y += 1; }
    return { fiscal_year: y, period: p };
  }, [assets, fiscalPeriods]);

  // Helper: is `period` strictly before `boundary`?
  function isBefore(period, boundary) {
    if (!period || !boundary) return false;
    if (period.fiscal_year < boundary.fiscal_year) return true;
    if (period.fiscal_year > boundary.fiscal_year) return false;
    return period.period < boundary.period;
  }

  // Asset rows recomputed for an arbitrary period — same logic as Register
  function computeAssetsAt(year, period) {
    if (!assets || !fiscalPeriods) return [];
    return assets.map(a => {
      const accum = calcAccumDepr(a, year, period, fiscalPeriods);
      const nbv = (a.acquisition_cost ?? 0) - accum;
      const monthly = calcPeriodDepr(a);
      const months = countPeriodsInService(a, year, period, fiscalPeriods);
      const isFully = (a.acquisition_cost > 0)
        && (accum >= Math.abs(a.acquisition_cost) - 0.005);
      return {
        ...a,
        accum_depr: accum,
        nbv,
        monthly_depr: monthly,
        months_in_service: months > 0 ? months : 0,
        is_fully_at_period: isFully,
      };
    });
  }

  // Sort helper used by every per-asset report
  function sortByNumber(list) {
    return [...list].sort((a, b) => {
      if (a.asset_number == null && b.asset_number == null) return 0;
      if (a.asset_number == null) return 1;
      if (b.asset_number == null) return -1;
      return a.asset_number - b.asset_number;
    });
  }

  // ============================================================
  // REPORT 1 — Asset Register
  // ============================================================
  function buildRegisterReport() {
    if (!registerPeriod) return null;
    const { fiscal_year: yr, period: pd } = registerPeriod;
    const list = sortByNumber(computeAssetsAt(yr, pd).filter(a => !a.is_disposed));

    const rows = [];
    // Title rows
    rows.push([cell('Red Rock Foods, LLC — Fixed Asset Register', TITLE_STYLE)]);
    rows.push([cell(`As of ${fmtPeriodLabel(yr, pd)} close (${fmtDate(lastDayOfMonth(yr, pd))})`, SUBTITLE_STYLE)]);
    rows.push([cell(`Generated ${fmtDate(new Date().toISOString())} · ${list.length} active assets`, SUBTITLE_STYLE)]);
    rows.push([]);

    // Header
    const headers = [
      'Asset #', 'Asset Name', 'Description', 'Category', 'Location', 'Section',
      'Acquired', 'In Service', 'Cost', 'Useful Life (mo)',
      'Months in Service', 'Monthly Depr', 'Accum Depr', 'NBV', 'Status',
    ];
    rows.push(headers.map(h => cell(h, HEADER_STYLE)));

    // Data rows
    let totalCost = 0, totalAccum = 0, totalNBV = 0, totalMonthly = 0;
    for (const a of list) {
      totalCost += a.acquisition_cost || 0;
      totalAccum += a.accum_depr || 0;
      totalNBV += a.nbv || 0;
      totalMonthly += a.monthly_depr || 0;
      const status = a.is_fully_at_period ? 'Fully Depr'
        : a.legacy_accum_depr ? 'Anchored' : 'Active';
      rows.push([
        cell(a.asset_number ?? ''),
        cell(a.asset_name || ''),
        cell(a.description || ''),
        cell(a.category_name || ''),
        cell(a.location_name || ''),
        cell(a.section || ''),
        dateCell(a.acquisition_date),
        dateCell(a.in_service_date),
        $cell(a.acquisition_cost),
        intCell(a.useful_life_months),
        intCell(a.months_in_service),
        $cell(a.monthly_depr),
        $cell(a.accum_depr),
        $cell(a.nbv),
        cell(status),
      ]);
    }

    // Total row
    rows.push([
      cell('TOTAL', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      cell('', TOTAL_STYLE),
      $cell(totalCost, TOTAL_STYLE),
      cell('', TOTAL_STYLE),
      cell('', TOTAL_STYLE),
      $cell(totalMonthly, TOTAL_STYLE),
      $cell(totalAccum, TOTAL_STYLE),
      $cell(totalNBV, TOTAL_STYLE),
      cell('', TOTAL_STYLE),
    ]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    setColWidths(ws, [10, 32, 38, 22, 18, 9, 12, 12, 14, 10, 10, 14, 14, 14, 12]);
    // Merge title row across columns for visual cleanliness
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: headers.length - 1 } },
    ];
    // Freeze panes below header row
    ws['!freeze'] = { ySplit: 5 };
    setRowHeights(ws, [22, 16, 16, 8, 28]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Register');
    return { wb, filename: `RRF_Asset_Register_${yr}-${String(pd).padStart(2, '0')}.xlsx` };
  }

  // ============================================================
  // REPORT 2 — Depreciation Schedule (Snapshot + Forward Projection)
  // ============================================================
  function buildScheduleReport() {
    if (!scheduleStart) return null;
    const { fiscal_year: yr, period: pd } = scheduleStart;
    const list = sortByNumber(computeAssetsAt(yr, pd).filter(a => !a.is_disposed));

    // -------- Tab 1: Snapshot --------
    const snapRows = [];
    snapRows.push([cell('Red Rock Foods, LLC — Depreciation Schedule (Snapshot)', TITLE_STYLE)]);
    snapRows.push([cell(`As of ${fmtPeriodLabel(yr, pd)} close`, SUBTITLE_STYLE)]);
    snapRows.push([cell(`Generated ${fmtDate(new Date().toISOString())} · ${list.length} active assets`, SUBTITLE_STYLE)]);
    snapRows.push([]);

    const snapHeaders = [
      'Asset #', 'Asset Name', 'Category', 'In Service', 'Cost',
      'Useful Life (mo)', 'Months in Service', 'Months Remaining',
      'Monthly Depr', 'Accum Depr', 'NBV',
    ];
    snapRows.push(snapHeaders.map(h => cell(h, HEADER_STYLE)));

    let sCost = 0, sMonthly = 0, sAccum = 0, sNBV = 0;
    for (const a of list) {
      const remaining = a.useful_life_months
        ? Math.max(0, a.useful_life_months - (a.months_in_service || 0))
        : 0;
      sCost += a.acquisition_cost || 0;
      sMonthly += a.monthly_depr || 0;
      sAccum += a.accum_depr || 0;
      sNBV += a.nbv || 0;
      snapRows.push([
        cell(a.asset_number ?? ''),
        cell(a.asset_name || ''),
        cell(a.category_name || ''),
        dateCell(a.in_service_date),
        $cell(a.acquisition_cost),
        intCell(a.useful_life_months),
        intCell(a.months_in_service),
        intCell(a.is_fully_at_period ? 0 : remaining),
        $cell(a.is_fully_at_period ? 0 : a.monthly_depr),
        $cell(a.accum_depr),
        $cell(a.nbv),
      ]);
    }
    snapRows.push([
      cell('TOTAL', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      $cell(sCost, TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      $cell(sMonthly, TOTAL_STYLE),
      $cell(sAccum, TOTAL_STYLE),
      $cell(sNBV, TOTAL_STYLE),
    ]);

    const ws1 = XLSX.utils.aoa_to_sheet(snapRows);
    setColWidths(ws1, [10, 32, 22, 12, 14, 10, 10, 10, 14, 14, 14]);
    ws1['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: snapHeaders.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: snapHeaders.length - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: snapHeaders.length - 1 } },
    ];
    ws1['!freeze'] = { ySplit: 5 };
    setRowHeights(ws1, [22, 16, 16, 8, 28]);

    // -------- Tab 2: Forward Projection --------
    // For each asset, project the NEXT N months of monthly depr starting
    // from period AFTER the snapshot period. If the asset will fully
    // depreciate inside the window, the final partial month books only
    // the remaining cost; subsequent months are 0.
    const projMonths = scheduleProjMonths || 12;
    const monthSeq = [];
    let py = yr, pp = pd;
    for (let i = 0; i < projMonths; i++) {
      pp += 1;
      if (pp > 12) { pp = 1; py += 1; }
      monthSeq.push({ year: py, period: pp, label: fmtPeriodLabel(py, pp) });
    }

    const projRows = [];
    projRows.push([cell('Red Rock Foods, LLC — Depreciation Forward Projection', TITLE_STYLE)]);
    projRows.push([cell(`Starting after ${fmtPeriodLabel(yr, pd)} close · ${projMonths} months forward`, SUBTITLE_STYLE)]);
    projRows.push([cell(`Generated ${fmtDate(new Date().toISOString())}`, SUBTITLE_STYLE)]);
    projRows.push([]);

    const projHeaders = [
      'Asset #', 'Asset Name', 'Category', 'Cost', 'Accum (start)',
      ...monthSeq.map(m => m.label),
      'Total Window',
    ];
    projRows.push(projHeaders.map(h => cell(h, HEADER_STYLE)));

    const monthlyTotals = new Array(monthSeq.length).fill(0);
    let windowGrandTotal = 0;
    for (const a of list) {
      const cost = a.acquisition_cost || 0;
      const startAccum = a.accum_depr || 0;
      const monthly = a.monthly_depr || 0;
      let runningAccum = startAccum;
      const monthValues = [];
      let assetWindowTotal = 0;
      for (let i = 0; i < monthSeq.length; i++) {
        if (monthly <= 0 || cost <= 0 || runningAccum >= cost - 0.005) {
          monthValues.push(0);
          continue;
        }
        const remaining = cost - runningAccum;
        const thisMonth = Math.min(monthly, remaining);
        monthValues.push(thisMonth);
        runningAccum += thisMonth;
        monthlyTotals[i] += thisMonth;
        assetWindowTotal += thisMonth;
      }
      windowGrandTotal += assetWindowTotal;

      projRows.push([
        cell(a.asset_number ?? ''),
        cell(a.asset_name || ''),
        cell(a.category_name || ''),
        $cell(cost),
        $cell(startAccum),
        ...monthValues.map(v => $cell(v)),
        $cell(assetWindowTotal),
      ]);
    }
    projRows.push([
      cell('TOTAL', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      ...monthlyTotals.map(v => $cell(v, TOTAL_STYLE)),
      $cell(windowGrandTotal, TOTAL_STYLE),
    ]);

    const ws2 = XLSX.utils.aoa_to_sheet(projRows);
    const projWidths = [10, 32, 22, 14, 14, ...monthSeq.map(() => 13), 14];
    setColWidths(ws2, projWidths);
    ws2['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: projHeaders.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: projHeaders.length - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: projHeaders.length - 1 } },
    ];
    ws2['!freeze'] = { ySplit: 5, xSplit: 5 };
    setRowHeights(ws2, [22, 16, 16, 8, 32]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Snapshot');
    XLSX.utils.book_append_sheet(wb, ws2, 'Forward Projection');
    return { wb, filename: `RRF_Depreciation_Schedule_${yr}-${String(pd).padStart(2, '0')}.xlsx` };
  }

  // ============================================================
  // REPORT 3 — Roll-forward (by category)
  // ============================================================
  function buildRollForwardReport() {
    if (!rollStart || !rollEnd || !categories || !disposals) return null;
    const sy = rollStart.fiscal_year, sp = rollStart.period;
    const ey = rollEnd.fiscal_year, ep = rollEnd.period;

    // Validate that start <= end
    if (sy > ey || (sy === ey && sp > ep)) return null;

    // Hard-block pre-anchor windows. The roll-forward needs a reconstructable
    // accum balance at the END of the period BEFORE the start period. For
    // anchored assets, periods before the anchor have no historical data —
    // the calc module returns the anchor balance for any pre-anchor query,
    // which silently produces wrong period_depr arithmetic. Refuse instead.
    if (earliestRollStart && isBefore(rollStart, earliestRollStart)) {
      // Throw a labeled error so the wrapper can display a precise message
      const msg = `Roll-forward cannot start before ${fmtPeriodLabel(earliestRollStart.fiscal_year, earliestRollStart.period)}. Earlier periods predate the migration anchor and have no reconstructable beginning balance. Earliest valid start: ${fmtPeriodLabel(earliestRollStart.fiscal_year, earliestRollStart.period)}.`;
      throw new Error(msg);
    }

    // "Beginning" = end of period BEFORE start period
    let bgnY = sy, bgnP = sp - 1;
    if (bgnP < 1) { bgnP = 12; bgnY -= 1; }

    // For each category, compute:
    //   beg_cost = sum of acquisition_cost for assets that EXISTED at end of bgn period
    //              (in_service_date <= end of bgn period AND not disposed by then)
    //   beg_accum = sum of calcAccumDepr at (bgnY, bgnP) for those same assets
    //   additions_cost = sum of acquisition_cost for assets first in service in window
    //   disposals_cost = sum of acquisition_cost for assets disposed in window
    //   disposals_accum_removed = sum of accum at disposal time (per disposal record)
    //   period_depr = (end accum - beg accum) + (accum that was removed via disposals)
    //                 — equivalently, sum of monthly_depr × months over window for active assets
    //                 We use the cleaner direct calc: end_accum + disposed_accum - beg_accum
    //   end_cost = beg_cost + additions_cost - disposals_cost
    //   end_accum = sum of calcAccumDepr at (ey, ep) for assets still alive at end
    //
    // We get a clean tie because end_accum = beg_accum + period_depr - disposed_accum_at_disposal

    const catRows = categories.map(c => ({
      id: c.id,
      name: c.name,
      beg_cost: 0,
      additions_cost: 0,
      disposals_cost: 0,
      end_cost: 0,
      beg_accum: 0,
      period_depr: 0,
      disposals_accum_removed: 0,
      end_accum: 0,
      beg_nbv: 0,
      end_nbv: 0,
    }));
    const catById = new Map(catRows.map(c => [c.id, c]));

    const bgnEnd = lastDayOfMonth(bgnY, bgnP);   // YYYY-MM-DD
    // Window for date comparisons: [first day of start period, last day of end period]
    const winStartDate = `${sy}-${String(sp).padStart(2, '0')}-01`;
    const winEndDate = lastDayOfMonth(ey, ep);

    const disposalsByAssetId = new Map();
    for (const d of disposals) disposalsByAssetId.set(d.asset_id, d);

    for (const a of (assets || [])) {
      const cat = catById.get(a.category_id);
      if (!cat) continue;
      const cost = a.acquisition_cost || 0;
      const inServ = a.in_service_date || a.acquisition_date;
      const disp = disposalsByAssetId.get(a.id);
      const disposalDate = disp?.disposal_date;

      const wasInServiceByBgn = inServ && inServ <= bgnEnd;
      const disposedByBgn = disposalDate && disposalDate <= bgnEnd;
      const acquiredInWindow = inServ && inServ >= winStartDate && inServ <= winEndDate;
      const disposedInWindow = disposalDate && disposalDate >= winStartDate && disposalDate <= winEndDate;
      const aliveAtEnd = inServ && inServ <= winEndDate && !(disposalDate && disposalDate <= winEndDate);

      // Beginning balances — assets in service at bgnEnd and not disposed by then
      if (wasInServiceByBgn && !disposedByBgn) {
        cat.beg_cost += cost;
        cat.beg_accum += calcAccumDepr(a, bgnY, bgnP, fiscalPeriods);
      }
      // Additions
      if (acquiredInWindow) cat.additions_cost += cost;
      // Disposals
      if (disposedInWindow) {
        cat.disposals_cost += cost;
        // Accum removed = NBV-at-disposal logic: disposals.proceeds aside, the
        // cost & accum both come off the books. We use disposal record's
        // implied accum if present (cost - nbv_at_disposal); fallback to
        // calc at end of prior month.
        let accumRemoved = 0;
        if (disp && disp.nbv_at_disposal != null) {
          accumRemoved = (cost) - (disp.nbv_at_disposal || 0);
        } else if (disposalDate) {
          // Fallback: accum at end of month before disposal
          const dParts = disposalDate.slice(0, 10).split('-');
          let dy = +dParts[0], dm = +dParts[1] - 1;
          if (dm < 1) { dm = 12; dy -= 1; }
          accumRemoved = calcAccumDepr(a, dy, dm, fiscalPeriods);
        }
        cat.disposals_accum_removed += accumRemoved;
      }
      // Ending balances
      if (aliveAtEnd) {
        cat.end_cost += cost;
        cat.end_accum += calcAccumDepr(a, ey, ep, fiscalPeriods);
      }
    }

    // Period depreciation = end_accum - beg_accum + disposals_accum_removed
    // (because disposed assets had their accum removed during the window)
    for (const c of catRows) {
      c.period_depr = c.end_accum - c.beg_accum + c.disposals_accum_removed;
      c.beg_nbv = c.beg_cost - c.beg_accum;
      c.end_nbv = c.end_cost - c.end_accum;
    }

    // Build sheet
    const rows = [];
    rows.push([cell('Red Rock Foods, LLC — Fixed Asset Roll-forward', TITLE_STYLE)]);
    rows.push([cell(`${fmtPeriodLabel(sy, sp)} through ${fmtPeriodLabel(ey, ep)}`, SUBTITLE_STYLE)]);
    rows.push([cell(`Beginning balance at ${fmtDate(bgnEnd)} · Generated ${fmtDate(new Date().toISOString())}`, SUBTITLE_STYLE)]);
    rows.push([]);

    // Cost section
    rows.push([cell('COST', { font: { bold: true, sz: 11, color: { rgb: NAVY } } })]);
    const costHeaders = ['Category', 'Beginning', 'Additions', 'Disposals', 'Ending'];
    rows.push(costHeaders.map(h => cell(h, HEADER_STYLE)));
    let tBeg = 0, tAdd = 0, tDisp = 0, tEnd = 0;
    for (const c of catRows) {
      const ending = c.beg_cost + c.additions_cost - c.disposals_cost;
      tBeg += c.beg_cost; tAdd += c.additions_cost; tDisp += c.disposals_cost; tEnd += ending;
      rows.push([
        cell(c.name),
        $cell(c.beg_cost),
        $cell(c.additions_cost),
        $cell(-c.disposals_cost),
        $cell(ending),
      ]);
    }
    rows.push([
      cell('Total Cost', TOTAL_STYLE),
      $cell(tBeg, TOTAL_STYLE),
      $cell(tAdd, TOTAL_STYLE),
      $cell(-tDisp, TOTAL_STYLE),
      $cell(tEnd, TOTAL_STYLE),
    ]);
    rows.push([]);

    // Accum section
    rows.push([cell('ACCUMULATED DEPRECIATION', { font: { bold: true, sz: 11, color: { rgb: NAVY } } })]);
    const accumHeaders = ['Category', 'Beginning', 'Period Depr', 'Disposals', 'Ending'];
    rows.push(accumHeaders.map(h => cell(h, HEADER_STYLE)));
    let aBeg = 0, aDepr = 0, aDispRm = 0, aEnd = 0;
    for (const c of catRows) {
      aBeg += c.beg_accum; aDepr += c.period_depr;
      aDispRm += c.disposals_accum_removed; aEnd += c.end_accum;
      rows.push([
        cell(c.name),
        $cell(c.beg_accum),
        $cell(c.period_depr),
        $cell(-c.disposals_accum_removed),
        $cell(c.end_accum),
      ]);
    }
    rows.push([
      cell('Total Accum Depr', TOTAL_STYLE),
      $cell(aBeg, TOTAL_STYLE),
      $cell(aDepr, TOTAL_STYLE),
      $cell(-aDispRm, TOTAL_STYLE),
      $cell(aEnd, TOTAL_STYLE),
    ]);
    rows.push([]);

    // NBV summary
    rows.push([cell('NET BOOK VALUE', { font: { bold: true, sz: 11, color: { rgb: NAVY } } })]);
    rows.push(['Category', 'Beginning NBV', 'Ending NBV'].map(h => cell(h, HEADER_STYLE)));
    let nBeg = 0, nEnd = 0;
    for (const c of catRows) {
      nBeg += c.beg_nbv; nEnd += c.end_nbv;
      rows.push([
        cell(c.name),
        $cell(c.beg_nbv),
        $cell(c.end_nbv),
      ]);
    }
    rows.push([
      cell('Total NBV', TOTAL_STYLE),
      $cell(nBeg, TOTAL_STYLE),
      $cell(nEnd, TOTAL_STYLE),
    ]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    setColWidths(ws, [28, 16, 16, 16, 16]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 4 } },
    ];
    ws['!freeze'] = { ySplit: 4 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Roll-forward');
    return { wb, filename: `RRF_Roll_Forward_${sy}-${String(sp).padStart(2, '0')}_to_${ey}-${String(ep).padStart(2, '0')}.xlsx` };
  }

  // ============================================================
  // REPORT 4 — Acquisitions
  // ============================================================
  function buildAcquisitionsReport() {
    if (!acqStart || !acqEnd || !assets) return null;
    const list = sortByNumber(
      assets
        .filter(a => {
          const d = a.acquisition_date || a.in_service_date;
          return d && d >= acqStart && d <= acqEnd;
        })
        .map(a => ({
          ...a,
          // For the acquisitions report, period-as-of doesn't matter — we
          // just show acquisition data, not running balances.
        }))
    );

    const rows = [];
    rows.push([cell('Red Rock Foods, LLC — Acquisitions', TITLE_STYLE)]);
    rows.push([cell(`Acquired between ${fmtDate(acqStart)} and ${fmtDate(acqEnd)}`, SUBTITLE_STYLE)]);
    rows.push([cell(`Generated ${fmtDate(new Date().toISOString())} · ${list.length} acquisitions`, SUBTITLE_STYLE)]);
    rows.push([]);

    const headers = [
      'Asset #', 'Asset Name', 'Description', 'Category', 'Location', 'Section',
      'Acquired', 'In Service', 'Cost', 'Useful Life (mo)',
    ];
    rows.push(headers.map(h => cell(h, HEADER_STYLE)));

    let total = 0;
    for (const a of list) {
      total += a.acquisition_cost || 0;
      rows.push([
        cell(a.asset_number ?? ''),
        cell(a.asset_name || ''),
        cell(a.description || ''),
        cell(a.category_name || ''),
        cell(a.location_name || ''),
        cell(a.section || ''),
        dateCell(a.acquisition_date),
        dateCell(a.in_service_date),
        $cell(a.acquisition_cost),
        intCell(a.useful_life_months),
      ]);
    }
    rows.push([
      cell('TOTAL', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      cell('', TOTAL_STYLE),
      $cell(total, TOTAL_STYLE),
      cell('', TOTAL_STYLE),
    ]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    setColWidths(ws, [10, 32, 38, 22, 18, 9, 12, 12, 14, 10]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: headers.length - 1 } },
    ];
    ws['!freeze'] = { ySplit: 5 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Acquisitions');
    return { wb, filename: `RRF_Acquisitions_${acqStart}_to_${acqEnd}.xlsx` };
  }

  // ============================================================
  // REPORT 5 — Disposals
  // ============================================================
  function buildDisposalsReport() {
    if (!dispStart || !dispEnd || !disposals || !assets) return null;
    const assetsById = new Map((assets || []).map(a => [a.id, a]));
    const list = (disposals || [])
      .filter(d => d.disposal_date && d.disposal_date >= dispStart && d.disposal_date <= dispEnd)
      .map(d => {
        const a = assetsById.get(d.asset_id) || {};
        return {
          ...d,
          asset_number: a.asset_number,
          asset_name: a.asset_name,
          category_name: a.category_name,
          location_name: a.location_name,
          acquisition_cost: a.acquisition_cost,
          in_service_date: a.in_service_date,
        };
      })
      .sort((x, y) => (x.disposal_date < y.disposal_date ? -1 : x.disposal_date > y.disposal_date ? 1 : 0));

    const rows = [];
    rows.push([cell('Red Rock Foods, LLC — Disposals', TITLE_STYLE)]);
    rows.push([cell(`Disposed between ${fmtDate(dispStart)} and ${fmtDate(dispEnd)}`, SUBTITLE_STYLE)]);
    rows.push([cell(`Generated ${fmtDate(new Date().toISOString())} · ${list.length} disposals`, SUBTITLE_STYLE)]);
    rows.push([]);

    const headers = [
      'Asset #', 'Asset Name', 'Category', 'Location', 'In Service', 'Cost',
      'Disposal Date', 'Method', 'Proceeds', 'NBV at Disposal', 'Gain / (Loss)', 'Notes',
    ];
    rows.push(headers.map(h => cell(h, HEADER_STYLE)));

    let tCost = 0, tProc = 0, tNBV = 0, tGL = 0;
    for (const d of list) {
      tCost += d.acquisition_cost || 0;
      tProc += d.proceeds || 0;
      tNBV += d.nbv_at_disposal || 0;
      tGL += d.gain_loss || 0;
      rows.push([
        cell(d.asset_number ?? ''),
        cell(d.asset_name || ''),
        cell(d.category_name || ''),
        cell(d.location_name || ''),
        dateCell(d.in_service_date),
        $cell(d.acquisition_cost),
        dateCell(d.disposal_date),
        cell(d.disposal_method || ''),
        $cell(d.proceeds),
        $cell(d.nbv_at_disposal),
        $cell(d.gain_loss),
        cell(d.notes || ''),
      ]);
    }
    rows.push([
      cell('TOTAL', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      $cell(tCost, TOTAL_STYLE),
      cell('', TOTAL_STYLE), cell('', TOTAL_STYLE),
      $cell(tProc, TOTAL_STYLE),
      $cell(tNBV, TOTAL_STYLE),
      $cell(tGL, TOTAL_STYLE),
      cell('', TOTAL_STYLE),
    ]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    setColWidths(ws, [10, 30, 22, 18, 12, 14, 12, 14, 14, 14, 14, 28]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: headers.length - 1 } },
    ];
    ws['!freeze'] = { ySplit: 5 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Disposals');
    return { wb, filename: `RRF_Disposals_${dispStart}_to_${dispEnd}.xlsx` };
  }

  // ---- generic export wrapper ----
  async function runReport(key, builder, validateMsg = null) {
    setBusyKey(key);
    try {
      // Allow a tiny delay so the busy state actually paints
      await new Promise(r => setTimeout(r, 30));
      const out = builder();
      if (!out) {
        showToast(validateMsg || 'Could not generate report — check parameters.');
        return;
      }
      downloadWb(out.wb, out.filename);
      showToast(`Downloaded ${out.filename}`);
    } catch (e) {
      console.error(e);
      showToast(`Export failed: ${e.message || e}`);
    } finally {
      setBusyKey(null);
    }
  }

  // ============================================================
  // Render
  // ============================================================
  if (error) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Reports</h1>
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load data:</strong> {error}
        </div>
      </div>
    );
  }
  if (!assets || !fiscalPeriods || !categories) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Reports</h1>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </div>
    );
  }

  const periodOptionsRev = [...periodOptions].reverse();   // newest first

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Reports</h1>
        <div className="text-xs text-gray-500">
          {fmtInt(assets.length)} assets · {fmtInt((disposals || []).length)} disposals on file
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">

        {/* Asset Register */}
        <ReportCard
          title="Asset Register"
          description="Full register snapshot at a selected period close. Cost, accumulated depreciation, NBV, and status per asset, with a grand total."
          busy={busyKey === 'register'}
          onExport={() => runReport('register', buildRegisterReport)}
        >
          <ParamRow label="As of period">
            <PeriodSelect
              value={registerPeriod}
              onChange={setRegisterPeriod}
              options={periodOptionsRev}
            />
          </ParamRow>
        </ReportCard>

        {/* Depreciation Schedule */}
        <ReportCard
          title="Depreciation Schedule"
          description="Two tabs. Snapshot: per-asset cost / accum / NBV / monthly / months remaining at selected period. Forward Projection: per-asset monthly depreciation projected forward N months."
          busy={busyKey === 'schedule'}
          onExport={() => runReport('schedule', buildScheduleReport)}
        >
          <ParamRow label="Starting period (snapshot)">
            <PeriodSelect
              value={scheduleStart}
              onChange={setScheduleStart}
              options={periodOptionsRev}
            />
          </ParamRow>
          <ParamRow label="Forward projection">
            <select
              value={scheduleProjMonths}
              onChange={e => setScheduleProjMonths(+e.target.value)}
              className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white"
            >
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
              <option value={24}>24 months</option>
              <option value={36}>36 months</option>
            </select>
          </ParamRow>
        </ReportCard>

        {/* Roll-forward */}
        <ReportCard
          title="Roll-forward"
          description="Period range. Beginning / Additions / Disposals / Ending for cost; Beginning / Period Depr / Disposals / Ending for accumulated depreciation. Grouped by category with totals."
          busy={busyKey === 'rollforward'}
          onExport={() => runReport('rollforward', buildRollForwardReport, 'Start period must be on or before end period.')}
          disabled={
            (rollStart && rollEnd && (rollStart.fiscal_year > rollEnd.fiscal_year ||
              (rollStart.fiscal_year === rollEnd.fiscal_year && rollStart.period > rollEnd.period)))
            || (earliestRollStart && rollStart && isBefore(rollStart, earliestRollStart))
          }
        >
          <ParamRow label="From">
            <PeriodSelect
              value={rollStart}
              onChange={setRollStart}
              options={periodOptionsRev}
              minPeriod={earliestRollStart}
            />
          </ParamRow>
          <ParamRow label="Through">
            <PeriodSelect value={rollEnd} onChange={setRollEnd} options={periodOptionsRev} />
          </ParamRow>
          {rollStart && rollEnd && (rollStart.fiscal_year > rollEnd.fiscal_year ||
            (rollStart.fiscal_year === rollEnd.fiscal_year && rollStart.period > rollEnd.period)) && (
            <div className="text-xs text-red-600">Start period must be on or before end period.</div>
          )}
          {earliestRollStart && rollStart && isBefore(rollStart, earliestRollStart) && (
            <div className="text-xs text-red-600 leading-relaxed">
              Cannot start before <strong>{fmtPeriodLabel(earliestRollStart.fiscal_year, earliestRollStart.period)}</strong>. Earlier periods predate the migration anchor and have no reconstructable beginning balance.
            </div>
          )}
          {earliestRollStart && (
            <div className="text-[11px] text-gray-500 leading-relaxed">
              Earliest valid start: {fmtPeriodLabel(earliestRollStart.fiscal_year, earliestRollStart.period)} (anchor + 1).
            </div>
          )}
        </ReportCard>

        {/* Acquisitions */}
        <ReportCard
          title="Acquisitions"
          description="All assets with an acquisition date (or in-service date if no acquisition date set) inside the selected window."
          busy={busyKey === 'acquisitions'}
          onExport={() => runReport('acquisitions', buildAcquisitionsReport, 'Pick a valid date range.')}
        >
          <ParamRow label="From">
            <DateInput value={acqStart} onChange={setAcqStart} />
          </ParamRow>
          <ParamRow label="Through">
            <DateInput value={acqEnd} onChange={setAcqEnd} />
          </ParamRow>
        </ReportCard>

        {/* Disposals */}
        <ReportCard
          title="Disposals"
          description="All disposed assets in the selected window. Cost, NBV at disposal, proceeds, gain/loss, and method."
          busy={busyKey === 'disposals'}
          onExport={() => runReport('disposals', buildDisposalsReport, 'Pick a valid date range.')}
        >
          <ParamRow label="From">
            <DateInput value={dispStart} onChange={setDispStart} />
          </ParamRow>
          <ParamRow label="Through">
            <DateInput value={dispEnd} onChange={setDispEnd} />
          </ParamRow>
        </ReportCard>

      </div>

      <div className="mt-6 text-[11px] text-gray-500 italic">
        Reports use the same calc module as the Asset Register and Depreciation
        Engine. Numbers tie to the Dashboard for the same period.
      </div>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================
function ReportCard({ title, description, busy, onExport, disabled, children }) {
  const btnDisabled = busy || disabled;
  return (
    <div className="bg-white border border-gray-200 rounded-md shadow-sm p-4">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          <div className="text-xs text-gray-500 mt-0.5">{description}</div>
        </div>
        <button
          onClick={onExport}
          disabled={btnDisabled}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors flex-shrink-0 ${
            busy
              ? 'bg-gray-200 text-gray-500 cursor-wait'
              : disabled
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {busy ? 'Generating…' : '↓ Download Excel'}
        </button>
      </div>
      <div className="mt-3 space-y-2 max-w-md">
        {children}
      </div>
    </div>
  );
}

function ParamRow({ label, children }) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-xs text-gray-600 w-44 flex-shrink-0">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function PeriodSelect({ value, onChange, options, minPeriod = null }) {
  if (!value) {
    return (
      <select disabled className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-gray-50 w-full">
        <option>—</option>
      </select>
    );
  }
  const cur = `${value.fiscal_year}-${value.period}`;
  function isInvalid(opt) {
    if (!minPeriod) return false;
    if (opt.fiscal_year < minPeriod.fiscal_year) return true;
    if (opt.fiscal_year > minPeriod.fiscal_year) return false;
    return opt.period < minPeriod.period;
  }
  return (
    <select
      value={cur}
      onChange={e => {
        const [y, p] = e.target.value.split('-').map(Number);
        onChange({ fiscal_year: y, period: p });
      }}
      className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white w-full"
    >
      {options.map(opt => (
        <option key={opt.key} value={opt.key}>
          {opt.label}{opt.saved ? '  ✓' : ''}{isInvalid(opt) ? '  (pre-anchor)' : ''}
        </option>
      ))}
    </select>
  );
}

function DateInput({ value, onChange }) {
  return (
    <input
      type="date"
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white w-full"
    />
  );
}
