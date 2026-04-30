/**
 * RRF Fixed Asset Manager — Depreciation Calculation Engine
 *
 * Ported directly from the RHLC calculation module, with RRF-specific
 * adaptations:
 *
 *   Field name           RHLC                       RRF
 *   ----------           ----                       ---
 *   per-period rate      estimated_value /          acquisition_cost /
 *                        life_periods               useful_life_months
 *   import anchor        import_fiscal_year +       legacy_as_of_date
 *                        import_period              (a real date)
 *   anchor balance       imported_accum_depr        legacy_accum_depr
 *   period start         purchase_date              in_service_date
 *
 *   Calendar             13 four-week periods       12 calendar months
 *
 * Anchor semantics are identical: the asset's accumulated depreciation
 * balance AT THE END OF the anchor period (import period for RHLC, the month
 * containing legacy_as_of_date for RRF) is the migrated balance, and we
 * resume normal monthly depreciation starting the period AFTER that.
 *
 * Cap rule: accumulated depreciation never exceeds acquisition_cost. The
 * final period of an asset's useful life books a partial amount if the
 * monthly rate would otherwise overshoot — mirrors RHLC's behavior and
 * lines up with Nathan's "land exactly at cost" expectation.
 */

const PERIODS_PER_YEAR = 12;

// ============================================================
// Per-period straight-line rate
// ============================================================
export function calcPeriodDepr(asset) {
  if (!asset.useful_life_months || asset.useful_life_months <= 0) return 0;
  if (!asset.acquisition_cost || asset.acquisition_cost <= 0) return 0;
  return asset.acquisition_cost / asset.useful_life_months;
}

// ============================================================
// Date → fiscal period lookup
// ============================================================
export function getFiscalPeriodForDate(dateStr, fiscalPeriods) {
  if (!dateStr) return null;
  for (const fp of fiscalPeriods) {
    if (dateStr >= fp.start_date && dateStr <= fp.end_date) return fp;
  }
  return null;
}

// ============================================================
// Number of periods from (startYear, startPeriod) through (endYear, endPeriod),
// INCLUSIVE of both endpoints. Returns 0 if the range is empty / inverted.
// ============================================================
export function countPeriodsBetween(startYear, startPeriod, endYear, endPeriod) {
  if (startYear > endYear || (startYear === endYear && startPeriod > endPeriod)) return 0;
  return (endYear - startYear) * PERIODS_PER_YEAR + (endPeriod - startPeriod + 1);
}

// ============================================================
// How many periods of depreciation should be on the books for `asset`
// AS OF the end of (throughYear, throughPeriod)?
//
// Two paths:
//   1. Anchored asset (legacy_as_of_date is set): start counting the month
//      AFTER the anchor month. The anchor balance covers everything through
//      the anchor month itself.
//   2. Unanchored asset: full-month convention from in_service_date — the
//      in-service month is month 1.
//
// Inactive-period subtraction (RHLC's `inactive_periods_count`) isn't
// implemented in RRF yet — the column doesn't exist. If/when it's added,
// the same `Math.max(raw - inactive, 0)` pattern from RHLC would apply.
// ============================================================
export function countPeriodsInService(asset, throughYear, throughPeriod, fiscalPeriods) {
  if (asset.legacy_as_of_date) {
    // Anchored — count periods AFTER the anchor month.
    const anchorFP = getFiscalPeriodForDate(asset.legacy_as_of_date, fiscalPeriods);
    if (!anchorFP) return 0;
    return countPeriodsBetween(
      anchorFP.fiscal_year,
      anchorFP.period + 1,
      throughYear,
      throughPeriod
    );
  }
  // Unanchored — count from the in-service period inclusive.
  if (!asset.in_service_date) return 0;
  const startFP = getFiscalPeriodForDate(asset.in_service_date, fiscalPeriods);
  if (!startFP) return 0;
  return countPeriodsBetween(
    startFP.fiscal_year,
    startFP.period,
    throughYear,
    throughPeriod
  );
}

// ============================================================
// Accumulated depreciation through the end of (throughYear, throughPeriod).
// Caps at acquisition_cost.
// ============================================================
export function calcAccumDepr(asset, throughYear, throughPeriod, fiscalPeriods) {
  const perPeriod = calcPeriodDepr(asset);
  if (perPeriod === 0) return 0;
  const importedBase = asset.legacy_accum_depr || 0;
  const periodsRun = countPeriodsInService(asset, throughYear, throughPeriod, fiscalPeriods);
  if (periodsRun <= 0) return importedBase;
  const total = importedBase + (perPeriod * periodsRun);
  return Math.min(total, Math.abs(asset.acquisition_cost));
}

// ============================================================
// Net Book Value through period end.
// ============================================================
export function calcNBV(asset, throughYear, throughPeriod, fiscalPeriods) {
  return asset.acquisition_cost - calcAccumDepr(asset, throughYear, throughPeriod, fiscalPeriods);
}

// ============================================================
// "Current" fiscal period — the one whose date range contains today,
// or the latest defined period if today falls outside the calendar.
// ============================================================
export function getCurrentFiscalPeriod(fiscalPeriods) {
  const today = new Date().toISOString().slice(0, 10);
  const current = getFiscalPeriodForDate(today, fiscalPeriods);
  if (current) return current;
  const sorted = [...fiscalPeriods].sort((a, b) => {
    if (a.fiscal_year !== b.fiscal_year) return b.fiscal_year - a.fiscal_year;
    return b.period - a.period;
  });
  return sorted[0] || { fiscal_year: 2026, period: 1 };
}

// ============================================================
// Display helpers — matching RHLC's formatting conventions exactly
// ============================================================

export function fmt$(val) {
  if (val == null || isNaN(val)) return '$0.00';
  const neg = val < 0;
  const abs = Math.abs(val);
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `($${s})` : `$${s}`;
}

export function fmtDate(d) {
  if (!d) return '';
  const parts = d.slice(0, 10).split('-');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`;
  return d;
}

export function fmtInt(val) {
  if (val == null || isNaN(val)) return '0';
  return Math.round(val).toLocaleString();
}

export function fmtPct(ratio) {
  if (ratio == null || isNaN(ratio) || !isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Format a (year, period) pair for display: "April 2026", "January 2026", etc. */
export function fmtPeriodLabel(year, period) {
  if (year == null || period == null) return '';
  const d = new Date(Date.UTC(year, period - 1, 1));
  return d.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Last day of a (year, period) pair as YYYY-MM-DD. */
export function lastDayOfMonth(year, period) {
  const d = new Date(Date.UTC(year, period, 0));
  return d.toISOString().slice(0, 10);
}
