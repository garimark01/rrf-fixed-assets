/**
 * Reconciliation Page
 *
 * Side-by-side reconciliation of the FA Register against the QuickBooks
 * Balance Sheet. Variance < $1.00 = matched; otherwise flagged.
 *
 * Workflow:
 *   1. User picks a period (default: latest saved depreciation run)
 *   2. User drops a QB Balance Sheet .xlsx
 *   3. Parser locates the three FA lines by GL number prefix in column D:
 *        13300 → Furniture & Equipment cost
 *        13200 → Lease Hold Improvement cost
 *        13400 → Accumulated Depreciation (single shared)
 *      Value is read from column F (numeric).
 *   4. Book side is computed via the calc module against the selected period,
 *      grouped by category.cost_account.
 *   5. Side-by-side table with variances, color-coded.
 *
 * Tolerance: < $1.00 = green ✓; $1.00–$100 = amber; > $100 = red.
 *
 * Architecture notes:
 *   - Period source: same defaulting logic as AssetRegisterPage
 *     (latest saved run → current period → latest defined period).
 *     This is local state, not shared with Register — they can drift.
 *   - QB BS parsing is pure JS, no server roundtrip
 *   - Currently no persistence (recon attempts not saved). If we want
 *     audit history, that's a future enhancement: a `reconciliations`
 *     table that captures the upload + variances.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx-js-style';
import { supabase, fetchAll } from '../lib/supabase';
import { useToast } from '../components/Toast';
import {
  fmt$, fmtPeriodLabel, fmtDate,
  calcAccumDepr, getCurrentFiscalPeriod,
} from '../lib/calculations';
import { buildFaReconSnapshot, downloadReconSnapshot } from '../lib/reconSnapshot';

const TOLERANCE = 1.00;

// FA GL accounts — fixed per Nathan's confirmation
const ACCT_FE   = '13300';  // Furniture & Equipment
const ACCT_LHI  = '13200';  // Lease Hold Improvement
const ACCT_ACC  = '13400';  // Accumulated Depreciation

// Account label hints for display only — actual text comes from the file
const ACCT_LABEL = {
  [ACCT_FE]:  'Furniture and Equipment',
  [ACCT_LHI]: 'Lease Hold Improvement',
  [ACCT_ACC]: 'Accumulated Depreciation',
};

// Match a GL-coded label like "13300 · Furniture and Equipment".
// Anchored to start-of-string so we don't accidentally match "Total 12100 · Inventory Asset"
// or similar nested labels. Allows · or - or : as the separator.
const GL_PREFIX_RE = /^\s*(\d{4,5})\s*[·\-:]/;

// ============================================================
// Excel export styling — matches the convention used in ReportsPage
// (navy headers, light-blue subtotals, accounting number format).
// Inlined here to keep this page self-contained.
// ============================================================
const RECON_NAVY = '1E3A5F';
const RECON_LIGHT_BLUE = 'D5E8F0';
const RECON_FMT_ACCT = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';

const RECON_HEADER_STYLE = {
  font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
  fill: { fgColor: { rgb: RECON_NAVY } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: {
    top:    { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left:   { style: 'thin', color: { rgb: '000000' } },
    right:  { style: 'thin', color: { rgb: '000000' } },
  },
};
const RECON_SUBTOTAL_STYLE = {
  font: { bold: true, sz: 10 },
  fill: { fgColor: { rgb: RECON_LIGHT_BLUE } },
  border: {
    top:    { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
  },
};
const RECON_TOTAL_STYLE = {
  font: { bold: true, sz: 11 },
  fill: { fgColor: { rgb: RECON_LIGHT_BLUE } },
  border: {
    top:    { style: 'medium', color: { rgb: '000000' } },
    bottom: { style: 'double', color: { rgb: '000000' } },
  },
};
const RECON_TITLE_STYLE = {
  font: { bold: true, sz: 14, color: { rgb: RECON_NAVY } },
  alignment: { horizontal: 'left' },
};
const RECON_SUB_STYLE = {
  font: { sz: 10, color: { rgb: '666666' }, italic: true },
  alignment: { horizontal: 'left' },
};
const RECON_GREEN_STYLE = {
  font: { bold: true, color: { rgb: '15803D' }, sz: 10 },
  alignment: { horizontal: 'center' },
};
const RECON_AMBER_STYLE = {
  font: { bold: true, color: { rgb: 'B45309' }, sz: 10 },
  alignment: { horizontal: 'center' },
};
const RECON_RED_STYLE = {
  font: { bold: true, color: { rgb: 'B91C1C' }, sz: 10 },
};
const RECON_GREEN_TOTAL_STYLE = {
  font: { bold: true, color: { rgb: '15803D' }, sz: 11 },
  fill: { fgColor: { rgb: RECON_LIGHT_BLUE } },
  alignment: { horizontal: 'center' },
  border: {
    top:    { style: 'medium', color: { rgb: '000000' } },
    bottom: { style: 'double', color: { rgb: '000000' } },
  },
};
const RECON_AMBER_TOTAL_STYLE = {
  font: { bold: true, color: { rgb: 'B45309' }, sz: 11 },
  fill: { fgColor: { rgb: RECON_LIGHT_BLUE } },
  alignment: { horizontal: 'center' },
  border: {
    top:    { style: 'medium', color: { rgb: '000000' } },
    bottom: { style: 'double', color: { rgb: '000000' } },
  },
};
const RECON_NOTE_STYLE = {
  font: { sz: 10, italic: true, color: { rgb: 'B45309' } },
  alignment: { wrapText: true, vertical: 'top' },
};

function reconCell(v, style = null) {
  const c = { v };
  c.t = typeof v === 'number' ? 'n' : 's';
  if (style) c.s = { ...style };
  return c;
}
function reconNum(v, style = null) {
  const c = { v: typeof v === 'number' ? v : 0, t: 'n' };
  c.s = { ...(style || {}), numFmt: RECON_FMT_ACCT };
  return c;
}

export default function ReconciliationPage() {
  const showToast = useToast();
  const fileInputRef = useRef(null);

  // ---- reference data ----
  const [assets, setAssets]               = useState(null);
  const [categories, setCategories]       = useState(null);
  const [fiscalPeriods, setFiscalPeriods] = useState(null);
  const [savedRuns, setSavedRuns]         = useState(null);
  const [error, setError]                 = useState(null);

  // ---- selection ----
  const [selPeriod, setSelPeriod] = useState(null);

  // ---- upload state ----
  const [parsing, setParsing]   = useState(false);
  const [parseRes, setParseRes] = useState(null);  // { qb: {fe, lhi, acc, total}, fileName, postingDate? }
  const [parseError, setParseError] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // ============================================================
  // Initial load
  // ============================================================
  const load = useCallback(async () => {
    setError(null);
    try {
      const [assetsData, catsRes, fpRes, runsRes] = await Promise.all([
        fetchAll('v_assets_current'),
        supabase.from('categories').select('id, name, cost_account, accum_account, sort_order').order('sort_order'),
        supabase.from('fiscal_periods').select('fiscal_year, period, start_date, end_date').order('fiscal_year').order('period'),
        supabase.from('depreciation_runs').select('fiscal_year, period').order('fiscal_year', { ascending: false }).order('period', { ascending: false }),
      ]);
      if (catsRes.error) throw catsRes.error;
      if (fpRes.error)   throw fpRes.error;
      if (runsRes.error) throw runsRes.error;

      setAssets(assetsData);
      setCategories(catsRes.data || []);
      setFiscalPeriods(fpRes.data || []);
      setSavedRuns(runsRes.data || []);

      // Default period: latest saved run → current → latest defined
      setSelPeriod(prev => {
        if (prev) return prev;
        if (runsRes.data && runsRes.data.length > 0) {
          return { fiscal_year: runsRes.data[0].fiscal_year, period: runsRes.data[0].period };
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

  useEffect(() => { load(); }, [load]);

  // ============================================================
  // Book-side computation (memoized) — by category cost_account
  // ============================================================
  const book = useMemo(() => {
    if (!assets || !selPeriod || !fiscalPeriods || !categories) return null;
    const yr = selPeriod.fiscal_year;
    const pd = selPeriod.period;

    // Map category_id → GL account NUMBER (just the leading digits)
    // for fast lookup. cost_account is stored as a full label like
    // "13300 · Furniture and Equipment" — extract just "13300" so we can
    // match against the BS's GL-prefix scan and against our ACCT_FE/LHI
    // constants.
    const catCostAcct = new Map();
    for (const c of categories) {
      const raw = (c.cost_account || '').trim();
      const m = raw.match(/^(\d{4,5})/);
      catCostAcct.set(c.id, m ? m[1] : raw);
    }

    let costByAcct = {};   // { '13300': sum, '13200': sum }
    let costUnknown = 0;   // assets with no/unknown cost_account
    let totalAccum = 0;

    for (const a of assets) {
      if (a.is_disposed) continue;
      const cost = Number(a.acquisition_cost) || 0;
      const accum = calcAccumDepr(a, yr, pd, fiscalPeriods);
      const acct = catCostAcct.get(a.category_id);
      if (acct) {
        costByAcct[acct] = (costByAcct[acct] || 0) + cost;
      } else {
        costUnknown += cost;
      }
      totalAccum += accum;
    }

    const fe  = costByAcct[ACCT_FE]  || 0;
    const lhi = costByAcct[ACCT_LHI] || 0;
    const totalCost = fe + lhi + costUnknown;
    const totalNBV  = totalCost - totalAccum;

    return {
      fe:        round2(fe),
      lhi:       round2(lhi),
      accum:     round2(totalAccum),
      totalCost: round2(totalCost),
      totalNBV:  round2(totalNBV),
      costUnknown: round2(costUnknown),
    };
  }, [assets, categories, selPeriod, fiscalPeriods]);

  // ============================================================
  // Period dropdown options
  // ============================================================
  const periodOptions = useMemo(() => {
    if (!fiscalPeriods) return [];
    return [...fiscalPeriods].sort((a, b) => {
      if (a.fiscal_year !== b.fiscal_year) return b.fiscal_year - a.fiscal_year;
      return b.period - a.period;
    });
  }, [fiscalPeriods]);

  const savedKey = (yr, p) => `${yr}-${p}`;
  const savedSet = useMemo(
    () => new Set((savedRuns || []).map(r => savedKey(r.fiscal_year, r.period))),
    [savedRuns]
  );

  // ============================================================
  // QB BS file parsing
  // ============================================================
  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx') && !file.name.toLowerCase().endsWith('.xls')) {
      setParseError('Please upload an .xlsx or .xls file.');
      return;
    }
    setParsing(true);
    setParseError(null);
    setParseRes(null);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });

      // Locate FA accounts. We scan every row, look at cells in any column
      // for the GL_PREFIX pattern, but only ACCEPT it when it looks like the
      // canonical account row, not a totals/subtotals header.
      // Strategy: for each row, find the cell that matches GL_PREFIX_RE,
      // then take the FIRST numeric cell to the right of it as the value.
      const found = {}; // { '13300': value, ... }

      for (const row of rows) {
        if (!row) continue;
        for (let i = 0; i < row.length; i++) {
          const cell = row[i];
          if (typeof cell !== 'string') continue;
          const m = cell.match(GL_PREFIX_RE);
          if (!m) continue;
          const acct = m[1];
          if (acct !== ACCT_FE && acct !== ACCT_LHI && acct !== ACCT_ACC) continue;
          // Find the value — first numeric cell in this row at or after index i+1
          let val = null;
          for (let j = i + 1; j < row.length; j++) {
            if (typeof row[j] === 'number') { val = row[j]; break; }
            if (typeof row[j] === 'string') {
              const n = parseExcelNumber(row[j]);
              if (n != null) { val = n; break; }
            }
          }
          if (val != null && !(acct in found)) {
            found[acct] = val;
          }
          break; // one GL hit per row is enough
        }
      }

      // Try to extract the BS "as of" date from the sheet header (row 1 commonly)
      let asOfText = null;
      const firstRowText = (rows[0] || [])
        .filter(c => c != null)
        .map(c => String(c).trim())
        .join(' ');
      if (/\d/.test(firstRowText)) asOfText = firstRowText;

      const fe   = found[ACCT_FE];
      const lhi  = found[ACCT_LHI];
      // Accum depr typically comes through as negative on the BS — store its
      // absolute value because the FA register tracks accum as a positive #.
      const accRaw = found[ACCT_ACC];
      const acc  = accRaw != null ? Math.abs(accRaw) : null;

      const missing = [];
      if (fe  == null) missing.push(`${ACCT_FE} (${ACCT_LABEL[ACCT_FE]})`);
      if (lhi == null) missing.push(`${ACCT_LHI} (${ACCT_LABEL[ACCT_LHI]})`);
      if (acc == null) missing.push(`${ACCT_ACC} (${ACCT_LABEL[ACCT_ACC]})`);

      if (missing.length > 0) {
        throw new Error(`Could not find these account(s) on the BS: ${missing.join('; ')}.`);
      }

      const totalCost = fe + lhi;
      const totalNBV  = totalCost - acc;

      setParseRes({
        qb: {
          fe: round2(fe),
          lhi: round2(lhi),
          accum: round2(acc),
          accumRawSigned: round2(accRaw),
          totalCost: round2(totalCost),
          totalNBV: round2(totalNBV),
        },
        fileName: file.name,
        asOfText,
      });
      showToast('BS file parsed successfully.');
    } catch (e) {
      console.error(e);
      setParseError(e.message || String(e));
    } finally {
      setParsing(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    handleFile(file);
  }

  function onPick(e) {
    const file = e.target.files?.[0];
    handleFile(file);
    // Allow re-uploading the same file
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ============================================================
  // Render gates
  // ============================================================
  if (error) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Reconciliation</h1>
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load reference data:</strong> {error}
        </div>
      </div>
    );
  }
  if (!assets || !categories || !fiscalPeriods || !selPeriod) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Reconciliation</h1>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </div>
    );
  }

  const selKey = savedKey(selPeriod.fiscal_year, selPeriod.period);
  const selIsSaved = savedSet.has(selKey);
  const asOfFP = fiscalPeriods.find(p =>
    p.fiscal_year === selPeriod.fiscal_year && p.period === selPeriod.period
  );

  // ============================================================
  // Build recon rows when both sides are present
  // ============================================================
  const reconRows = parseRes && book ? [
    {
      label: `${ACCT_FE} · Furniture and Equipment`,
      bookValue: book.fe,
      qbValue:   parseRes.qb.fe,
    },
    {
      label: `${ACCT_LHI} · Lease Hold Improvement`,
      bookValue: book.lhi,
      qbValue:   parseRes.qb.lhi,
    },
    {
      label: `${ACCT_ACC} · Accumulated Depreciation`,
      bookValue: book.accum,
      qbValue:   parseRes.qb.accum,
      note: parseRes.qb.accumRawSigned < 0 ? '(BS shows as negative; comparing absolute value)' : null,
    },
  ] : null;

  const totals = parseRes && book ? {
    bookCost: book.fe + book.lhi,
    qbCost:   parseRes.qb.fe + parseRes.qb.lhi,
    bookNBV:  book.totalNBV,
    qbNBV:    parseRes.qb.totalNBV,
  } : null;

  const allMatched = reconRows
    ? reconRows.every(r => Math.abs(r.bookValue - r.qbValue) <= TOLERANCE)
    : false;

  // ============================================================
  // FA → Recon snapshot (JSON) — the sub-ledger handoff for the RRF Recon app.
  // Book-side only: does NOT require a QB upload. Uses the SAME figures as the
  // book preview / book column (gross by cost_account, pooled accum via
  // calcAccumDepr against the selected period), then flips the accum sign to
  // the BS contra convention on the way out. No fabricated numbers.
  // ============================================================
  function downloadSnapshot() {
    try {
      if (!assets || !categories || !fiscalPeriods || !selPeriod) return;
      const endISO = fiscalPeriods.find(p =>
        p.fiscal_year === selPeriod.fiscal_year && p.period === selPeriod.period
      )?.end_date;
      if (!endISO) {
        showToast('Selected period has no end_date defined in fiscal_periods.');
        return;
      }
      const snap = buildFaReconSnapshot({
        assets, categories, fiscalPeriods, selPeriod, periodEndISO: endISO,
      });
      const fname = downloadReconSnapshot(snap);
      if (snap.unmatched.cost !== 0) {
        showToast(`Downloaded ${fname} — ⚠ ${snap.unmatched.asset_count} asset(s) (${fmt$(snap.unmatched.cost)}) have no GL cost_account and were excluded.`);
      } else {
        showToast(`Downloaded ${fname}`);
      }
    } catch (e) {
      console.error(e);
      showToast(`Snapshot export failed: ${e.message || e}`);
    }
  }

  // ============================================================
  // Excel export
  // ============================================================
  function exportRecon() {
    if (!reconRows || !totals || !selPeriod) return;
    try {
      const yr = selPeriod.fiscal_year;
      const pd = selPeriod.period;
      const periodLabel = fmtPeriodLabel(yr, pd);

      const rows = [];
      // Title block
      rows.push([reconCell('Red Rock Foods, LLC — Fixed Asset Reconciliation', RECON_TITLE_STYLE)]);
      rows.push([reconCell(`As of ${periodLabel}${asOfFP ? ` (${fmtDate(asOfFP.end_date)})` : ''}`, RECON_SUB_STYLE)]);
      rows.push([reconCell(`FA Register vs. QuickBooks Balance Sheet${parseRes?.fileName ? ` · Source: ${parseRes.fileName}` : ''}`, RECON_SUB_STYLE)]);
      rows.push([reconCell(`Generated ${fmtDate(new Date().toISOString())} · Tolerance: $${TOLERANCE.toFixed(2)} · Status: ${allMatched ? 'MATCHED' : 'VARIANCE FOUND'}`, RECON_SUB_STYLE)]);
      rows.push([]);

      // Header
      const headers = ['GL Account', 'Book (FA Register)', 'QB (Balance Sheet)', 'Variance', 'Status'];
      rows.push(headers.map(h => reconCell(h, RECON_HEADER_STYLE)));

      // Account rows
      for (const r of reconRows) {
        const variance = r.bookValue - r.qbValue;
        const matched = Math.abs(variance) <= TOLERANCE;
        const varStyle = matched ? null
          : Math.abs(variance) <= 100 ? RECON_AMBER_STYLE
          : RECON_RED_STYLE;
        rows.push([
          reconCell(r.label),
          reconNum(r.bookValue),
          reconNum(r.qbValue),
          reconNum(variance, varStyle),
          reconCell(matched ? '✓ Match' : '✗ Variance',
            matched ? RECON_GREEN_STYLE : RECON_AMBER_STYLE),
        ]);
      }

      // Total cost row
      const costVar = totals.bookCost - totals.qbCost;
      const costMatched = Math.abs(costVar) <= TOLERANCE;
      rows.push([
        reconCell('Total Cost (Asset)', RECON_SUBTOTAL_STYLE),
        reconNum(totals.bookCost, RECON_SUBTOTAL_STYLE),
        reconNum(totals.qbCost, RECON_SUBTOTAL_STYLE),
        reconNum(costVar, RECON_SUBTOTAL_STYLE),
        reconCell('', RECON_SUBTOTAL_STYLE),
      ]);

      // NBV row
      const nbvVar = totals.bookNBV - totals.qbNBV;
      const nbvMatched = Math.abs(nbvVar) <= TOLERANCE;
      rows.push([
        reconCell('Net Book Value (Cost − Accum)', RECON_TOTAL_STYLE),
        reconNum(totals.bookNBV, RECON_TOTAL_STYLE),
        reconNum(totals.qbNBV, RECON_TOTAL_STYLE),
        reconNum(nbvVar, RECON_TOTAL_STYLE),
        reconCell(nbvMatched ? '✓ Match' : '✗ Variance',
          nbvMatched ? RECON_GREEN_TOTAL_STYLE : RECON_AMBER_TOTAL_STYLE),
      ]);

      // Footnote about unknown cost (if any)
      if (book.costUnknown > 0) {
        rows.push([]);
        rows.push([reconCell(
          `Note: ${fmt$(book.costUnknown)} of book cost is from assets whose category has no cost_account set — those won't tie to either GL bucket. Set cost_account in Admin → Categories.`,
          RECON_NOTE_STYLE
        )]);
      }

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [
        { wch: 38 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 14 },
      ];
      ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: 4 } },
        { s: { r: 3, c: 0 }, e: { r: 3, c: 4 } },
      ];
      // Merge the footnote across all columns if present
      if (book.costUnknown > 0) {
        const footRow = rows.length - 1;
        ws['!merges'].push({ s: { r: footRow, c: 0 }, e: { r: footRow, c: 4 } });
      }
      ws['!rows'] = [{ hpt: 22 }, { hpt: 16 }, { hpt: 16 }, { hpt: 16 }, { hpt: 8 }, { hpt: 26 }];
      ws['!freeze'] = { ySplit: 6 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Reconciliation');

      const filename = `RRF_Reconciliation_${yr}-${String(pd).padStart(2, '0')}${allMatched ? '_MATCHED' : '_VARIANCE'}.xlsx`;
      XLSX.writeFile(wb, filename, { cellStyles: true });
      showToast(`Downloaded ${filename}`);
    } catch (e) {
      console.error(e);
      showToast(`Export failed: ${e.message || e}`);
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">Reconciliation</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            FA Register vs. QuickBooks Balance Sheet · As of{' '}
            {fmtPeriodLabel(selPeriod.fiscal_year, selPeriod.period)}
            {asOfFP && <span className="text-gray-400"> ({fmtDate(asOfFP.end_date)})</span>}
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
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <label className="text-[11px] font-semibold text-gray-600">Period:</label>
        <select
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white font-medium"
          value={selKey}
          onChange={e => {
            const [yr, p] = e.target.value.split('-').map(Number);
            setSelPeriod({ fiscal_year: yr, period: p });
            // Clear any prior parse — the QB file is for a specific date
            // and may no longer apply
            setParseRes(null);
            setParseError(null);
          }}
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
        <span className="text-[11px] text-gray-400 ml-2">
          ✓ = saved depreciation run
        </span>
        <button
          onClick={downloadSnapshot}
          title="Download the FA book balances as a JSON snapshot for the RRF Recon app (book-side only; no QB upload needed)"
          className="ml-auto px-3 py-1.5 text-xs font-medium bg-slate-700 text-white rounded hover:bg-slate-800 flex-shrink-0"
        >
          ↓ Download recon snapshot (JSON)
        </button>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-md p-8 text-center transition-colors mb-5 ${
          dragOver ? 'border-blue-500 bg-blue-50'
          : parseRes ? 'border-green-300 bg-green-50/40'
          : 'border-gray-300 bg-white'
        }`}
      >
        {parsing ? (
          <div className="text-sm text-gray-500">Parsing…</div>
        ) : parseRes ? (
          <div>
            <div className="text-[10px] uppercase font-semibold text-green-700 tracking-wider mb-1">
              File Loaded
            </div>
            <div className="text-sm font-medium text-gray-700">{parseRes.fileName}</div>
            {parseRes.asOfText && (
              <div className="text-[11px] text-gray-500 mt-0.5">
                BS header: {parseRes.asOfText}
              </div>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              Replace file
            </button>
          </div>
        ) : (
          <div>
            <div className="text-sm text-gray-500 mb-2">
              Drop the QuickBooks Balance Sheet here
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Choose File
            </button>
            <div className="text-[11px] text-gray-400 mt-2">
              .xlsx or .xls export from QuickBooks
            </div>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={onPick}
          className="hidden"
        />
      </div>

      {parseError && (
        <div className="px-3 py-2 mb-4 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Parse error:</strong> {parseError}
          <div className="text-[12px] mt-1 text-red-600">
            Verify the file is a Balance Sheet export with GL-coded account labels
            (e.g. "13300 · Furniture and Equipment") in column D and values in column F.
          </div>
        </div>
      )}

      {/* Recon Result */}
      {reconRows && totals && (
        <>
          {/* Status banner */}
          {allMatched ? (
            <div className="px-4 py-3 mb-4 bg-green-50 border border-green-200 rounded text-sm flex items-center justify-between gap-4">
              <div>
                <span className="font-bold text-green-800">✓ Matched within tolerance</span>
                <span className="text-green-700 ml-2">
                  — All accounts within ${TOLERANCE.toFixed(2)} variance.
                </span>
              </div>
              <button
                onClick={exportRecon}
                className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 flex-shrink-0"
              >
                ↓ Export to Excel
              </button>
            </div>
          ) : (
            <div className="px-4 py-3 mb-4 bg-amber-50 border border-amber-200 rounded text-sm flex items-center justify-between gap-4">
              <div>
                <span className="font-bold text-amber-800">✗ Variance found</span>
                <span className="text-amber-700 ml-2">
                  — One or more accounts exceed the ${TOLERANCE.toFixed(2)} tolerance. Investigate below.
                </span>
              </div>
              <button
                onClick={exportRecon}
                className="px-3 py-1.5 text-xs font-medium bg-white border border-amber-300 text-amber-800 rounded hover:bg-amber-100 flex-shrink-0"
              >
                ↓ Export to Excel
              </button>
            </div>
          )}

          {/* Recon table */}
          <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold uppercase text-gray-500 tracking-wider">
                Account-Level Reconciliation
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                    <th className="text-left px-3 py-2 font-semibold">GL Account</th>
                    <th className="text-right px-3 py-2 font-semibold">Book (FA Register)</th>
                    <th className="text-right px-3 py-2 font-semibold">QB (Balance Sheet)</th>
                    <th className="text-right px-3 py-2 font-semibold">Variance</th>
                    <th className="text-center px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {reconRows.map(r => (
                    <ReconRow key={r.label} {...r} />
                  ))}

                  {/* Subtotals */}
                  <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                    <td className="px-3 py-2">Total Cost (Asset)</td>
                    <td className="px-3 py-2 text-right num">{fmt$(totals.bookCost)}</td>
                    <td className="px-3 py-2 text-right num">{fmt$(totals.qbCost)}</td>
                    <td className={`px-3 py-2 text-right num ${varianceColor(totals.bookCost - totals.qbCost)}`}>
                      {fmt$(totals.bookCost - totals.qbCost)}
                    </td>
                    <td />
                  </tr>

                  <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
                    <td className="px-3 py-2">Net Book Value (Cost − Accum)</td>
                    <td className="px-3 py-2 text-right num">{fmt$(totals.bookNBV)}</td>
                    <td className="px-3 py-2 text-right num">{fmt$(totals.qbNBV)}</td>
                    <td className={`px-3 py-2 text-right num ${varianceColor(totals.bookNBV - totals.qbNBV)}`}>
                      {fmt$(totals.bookNBV - totals.qbNBV)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {Math.abs(totals.bookNBV - totals.qbNBV) <= TOLERANCE
                        ? <span className="text-green-700 font-semibold text-[11px]">✓ Match</span>
                        : <span className="text-amber-700 font-semibold text-[11px]">✗ Variance</span>}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-[11px] text-gray-500">
              Tolerance: ${TOLERANCE.toFixed(2)}.{' '}
              {book.costUnknown > 0 && (
                <span className="text-amber-700 font-medium">
                  Note: {fmt$(book.costUnknown)} of book cost is from assets whose category
                  has no cost_account set — those won't tie to either GL bucket. Set
                  cost_account in Admin → Categories.
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {/* Empty state when no upload yet */}
      {!parseRes && !parseError && book && (
        <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50">
            <h2 className="text-sm font-semibold uppercase text-gray-500 tracking-wider">
              Book Side Preview ({fmtPeriodLabel(selPeriod.fiscal_year, selPeriod.period)})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                  <th className="text-left px-3 py-2 font-semibold">GL Account</th>
                  <th className="text-right px-3 py-2 font-semibold">Book Balance</th>
                </tr>
              </thead>
              <tbody>
                <BookRow label={`${ACCT_FE} · Furniture and Equipment`} value={book.fe} />
                <BookRow label={`${ACCT_LHI} · Lease Hold Improvement`} value={book.lhi} />
                <BookRow label={`${ACCT_ACC} · Accumulated Depreciation`} value={book.accum} />
                <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
                  <td className="px-3 py-2">Net Book Value</td>
                  <td className="px-3 py-2 text-right num">{fmt$(book.totalNBV)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-[11px] text-gray-500">
            Drop a QB Balance Sheet above to compare.
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Subcomponents
// ============================================================

function ReconRow({ label, bookValue, qbValue, note }) {
  const variance = bookValue - qbValue;
  const matched = Math.abs(variance) <= TOLERANCE;
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="px-3 py-2">
        <div>{label}</div>
        {note && <div className="text-[10px] text-gray-400 leading-tight mt-0.5">{note}</div>}
      </td>
      <td className="px-3 py-2 text-right num">{fmt$(bookValue)}</td>
      <td className="px-3 py-2 text-right num">{fmt$(qbValue)}</td>
      <td className={`px-3 py-2 text-right num ${varianceColor(variance)}`}>
        {fmt$(variance)}
      </td>
      <td className="px-3 py-2 text-center">
        {matched
          ? <span className="text-green-700 font-semibold text-[11px]">✓ Match</span>
          : <span className="text-amber-700 font-semibold text-[11px]">✗ Variance</span>}
      </td>
    </tr>
  );
}

function BookRow({ label, value }) {
  return (
    <tr className="border-b border-gray-100">
      <td className="px-3 py-2">{label}</td>
      <td className="px-3 py-2 text-right num">{fmt$(value)}</td>
    </tr>
  );
}

// ============================================================
// Helpers
// ============================================================

function round2(n) { return Math.round(n * 100) / 100; }

function varianceColor(v) {
  const abs = Math.abs(v);
  if (abs <= TOLERANCE) return 'text-gray-600';
  if (abs <= 100)       return 'text-amber-700 font-semibold';
  return 'text-red-700 font-semibold';
}

function parseExcelNumber(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  // Strip $ , spaces; handle parens-as-negative
  let neg = false;
  let cleaned = t.replace(/[\s$,]/g, '');
  if (/^\(.*\)$/.test(cleaned)) { neg = true; cleaned = cleaned.slice(1, -1); }
  if (cleaned === '' || cleaned === '-') return null;
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}
