/**
 * RRF FA → Recon snapshot export  (schema 'gmf-fa-recon-snapshot/v1')
 *
 * Produces the JSON handoff the RRF Recon app imports as the SUB-LEDGER side of
 * its Fixed-Asset reconciliations. The book-side math here is IDENTICAL to
 * ReconciliationPage's `book` memo — same disposed filter, same cost_account
 * GL extraction, same live calcAccumDepr against the selected period, same
 * round2. This module only shapes those numbers into the agreed envelope.
 *
 * SCHEMA NAME — read before "fixing" it: the string stays 'gmf-fa-recon-snapshot/v1',
 * NOT 'rrf-...'. The RRF Recon app was cloned from GMF and its importer
 * (recon-app-RRF/app/src/lib/faSnapshotImport.js) hard-checks
 * `snap.schema === 'gmf-fa-recon-snapshot/v1'` and rejects anything else. The
 * entity code ('RRF') is what actually scopes the file to the right company;
 * the schema string is a shared envelope-version tag, not an entity tag.
 *
 * THE CONTRACT (must match the recon importer):
 *   - entity            : 'RRF'              -> recon entities.code (hard-stop on mismatch)
 *   - period_end_date   : ISO 'YYYY-MM-DD'   -> recon periods.period_end_date.
 *                         The recon keys on this and hard-stops on a mismatch,
 *                         so it MUST equal the QB Balance Sheet "as of" date.
 *   - accounts[].recon_amount is the ONLY figure the recon reconciles, and it
 *     carries the BALANCE-SHEET DISPLAY SIGN so subledger_balance == gl_balance
 *     ties with zero reconciling items:
 *         gross cost accounts (13xxx) -> POSITIVE
 *         13400 accum control         -> NEGATIVE  (contra-asset, as shown)
 *   - accounts[].gl_account matches the recon account `number` (RRF: 13300 F&E,
 *     13200 LHI, 13400 accum). The importer surfaces any unmatched GL rather
 *     than dropping them.
 *   - per-account accum_depr / nbv live under .ref and are REFERENCE ONLY: 13400
 *     is a single pooled GL account, so there is no per-category accum to tie.
 *
 * NO FABRICATION: every number is summed from the live register. Every cost
 * account appears even at $0.00. Assets whose category has no GL cost_account
 * are NOT silently dropped — their cost is surfaced under `unmatched`, and
 * excluded from totals.gross_cost so the per-account tie stays honest.
 */
import { calcAccumDepr } from './calculations';

const SCHEMA = 'gmf-fa-recon-snapshot/v1';   // shared envelope version — do NOT rename to rrf-* (see header)
const ENTITY_CODE = 'RRF';
const ENTITY_NAME = 'Red Rock Foods, LLC';
const ACCT_ACCUM = '13400';
const ACCT_ACCUM_LABEL = 'Accumulated Depreciation';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// First GL number in a category's cost_account ("13300 · ..." -> "13300").
function glOf(cat) {
  const m = (cat && cat.cost_account ? String(cat.cost_account) : '').trim().match(/^(\d{4,5})/);
  return m ? m[1] : null;
}

// ISO 'YYYY-MM-DD' -> QB-style "May 31, 26". Display only — the recon keys on
// the ISO date, not this label.
export function qbStyleLabel(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (!y || !m || !d) return String(iso);
  return `${months[m - 1]} ${d}, ${String(y).slice(-2)}`;
}

/**
 * Build the snapshot envelope object.
 *   assets        : rows from `assets` (or v_assets_current)
 *   categories    : rows from `categories` (need cost_account + sort_order)
 *   fiscalPeriods : rows from `fiscal_periods`
 *   selPeriod     : { fiscal_year, period }
 *   periodEndISO  : the selected fiscal period's end_date (ISO 'YYYY-MM-DD')
 */
export function buildFaReconSnapshot({ assets, categories, fiscalPeriods, selPeriod, periodEndISO }) {
  if (!assets || !categories || !fiscalPeriods || !selPeriod) {
    throw new Error('buildFaReconSnapshot: missing required inputs.');
  }
  if (!periodEndISO) {
    throw new Error('buildFaReconSnapshot: no period_end_date — the selected fiscal period has no end_date.');
  }
  const yr = selPeriod.fiscal_year;
  const pd = selPeriod.period;

  // Ordered cost-account list (mirrors ReconciliationPage's book grouping):
  // by sort_order, one entry per GL number, categories without a GL prefix
  // skipped (they can't reconcile to a bucket).
  const costAccts = [];
  const seen = new Set();
  for (const c of [...categories].sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))) {
    const gl = glOf(c);
    if (!gl || seen.has(gl)) continue;
    seen.add(gl);
    costAccts.push({ gl, label: c.name });
  }
  const glSet = new Set(costAccts.map(c => c.gl));
  const catGl = new Map(categories.map(c => [c.id, glOf(c)]));

  const grossByGl = {}, accumByGl = {}, countByGl = {};
  for (const gl of glSet) { grossByGl[gl] = 0; accumByGl[gl] = 0; countByGl[gl] = 0; }
  let unmatchedCost = 0, unmatchedCount = 0, totalAccum = 0, totalCount = 0;

  for (const a of assets) {
    if (a.is_disposed) continue;                              // off the books
    const cost = Number(a.acquisition_cost) || 0;
    const accum = calcAccumDepr(a, yr, pd, fiscalPeriods);    // 0 for non-depreciating
    const gl = catGl.get(a.category_id);
    totalAccum += accum;
    totalCount += 1;
    if (gl && glSet.has(gl)) {
      grossByGl[gl] += cost;
      accumByGl[gl] += accum;
      countByGl[gl] += 1;
    } else {
      unmatchedCost += cost;
      unmatchedCount += 1;
    }
  }

  // Gross rows (POSITIVE). Every account present, even at $0.00.
  const accounts = costAccts.map(c => {
    const gross = round2(grossByGl[c.gl]);
    const accum = round2(accumByGl[c.gl]);
    return {
      gl_account: c.gl,
      label: c.label,
      kind: 'gross',
      recon_amount: gross,                          // -> subledgers.subledger_balance (+)
      asset_count: countByGl[c.gl],
      ref: { accum_depr: accum, nbv: round2(gross - accum) },   // reference only
    };
  });

  const grossTotal = round2(accounts.reduce((s, r) => s + r.recon_amount, 0));
  const accumTotal = round2(totalAccum);

  // Single pooled accum control — NEGATIVE to match the BS contra sign.
  accounts.push({
    gl_account: ACCT_ACCUM,
    label: ACCT_ACCUM_LABEL,
    kind: 'accum_control',
    recon_amount: round2(-accumTotal),              // -> subledgers.subledger_balance (contra)
    ref: { note: 'pooled across all categories; per-category accum is on the gross rows (reference only)' },
  });

  return {
    schema: SCHEMA,
    entity: ENTITY_CODE,
    entity_name: ENTITY_NAME,
    period_end_date: String(periodEndISO).slice(0, 10),
    period_label: qbStyleLabel(periodEndISO),
    snapshot_taken_at: new Date().toISOString(),
    source: { app: 'rrf-fixed-assets', fiscal_year: yr, period: pd },
    totals: {
      gross_cost: grossTotal,            // matched accounts only
      accum_depr: accumTotal,            // magnitude (positive)
      nbv: round2(grossTotal - accumTotal),
      asset_count: totalCount,
    },
    unmatched: { cost: round2(unmatchedCost), asset_count: unmatchedCount },
    accounts,
  };
}

// Trigger a browser download of the snapshot as pretty-printed JSON.
// Returns the filename used.
export function downloadReconSnapshot(snapshot) {
  const fname = `RRF_FA_recon_snapshot_${snapshot.period_end_date}.json`;
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return fname;
}
