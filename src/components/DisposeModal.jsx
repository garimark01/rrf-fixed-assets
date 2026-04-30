/**
 * DisposeModal
 *
 * Records a disposal of a single asset. Opens either:
 *   - From the Asset Register's "Dispose" button (asset pre-selected)
 *   - From the Disposals page's "+ Record Disposal" button (asset picker shown)
 *
 * Disposal model:
 *   - Disposal value = NBV at the END of the prior month (no partial-month
 *     accrual). So a disposal on Apr 15 uses the March 31 NBV.
 *   - This means a disposal can be recorded any day of a month and the
 *     financial values are deterministic — they don't shift based on
 *     when within the month you record it.
 *
 * Gain/loss:
 *   - Gain  = proceeds > NBV  (CR 69000)
 *   - Loss  = proceeds < NBV  (DR 69000)
 *   - Even  = proceeds == NBV (no 69000 line)
 *
 * IIF (proceeds-side intentionally excluded — Nathan books proceeds in QB):
 *   - DR  category.accum_account (or 13400)   for accum_at_disposal
 *   - CR  category.cost_account               for cost_at_disposal
 *   - Plug to 69000 to balance:
 *       loss → DR 69000 |abs(gain_loss)|
 *       gain → CR 69000 |gain_loss|
 *
 * On save:
 *   1. Insert disposals row (financial record)
 *   2. UPDATE assets SET is_disposed = true
 *   3. Download IIF
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  fmt$, fmtDate, calcAccumDepr, getFiscalPeriodForDate,
} from '../lib/calculations';
import Modal from './Modal';

const DEFAULT_ACCUM_ACCT = '13400';
const DEFAULT_GAIN_LOSS_ACCT = '69000';

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function priorMonthOf(year, period) {
  return period === 1
    ? { fiscal_year: year - 1, period: 12 }
    : { fiscal_year: year,     period: period - 1 };
}

function monthAbbrev(period) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][period - 1];
}

export default function DisposeModal({
  preselectedAssetId = null,   // optional — when invoked from Asset Register
  onClose,
  onSaved,                      // (disposalRecord) => void
}) {
  // ---- reference data ----
  const [assets, setAssets]               = useState(null);
  const [categories, setCategories]       = useState([]);
  const [fiscalPeriods, setFiscalPeriods] = useState([]);
  const [settings, setSettings]           = useState({});
  const [refLoading, setRefLoading]       = useState(true);
  const [refError, setRefError]           = useState(null);

  // ---- form state ----
  const [assetId, setAssetId]             = useState(preselectedAssetId || '');
  const [disposalDate, setDisposalDate]   = useState(isoToday());
  const [postingDate, setPostingDate]     = useState(isoToday());
  const [proceedsStr, setProceedsStr]     = useState('');
  const [notes, setNotes]                 = useState('');

  const [saving, setSaving]               = useState(false);
  const [saveError, setSaveError]         = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [aRes, cRes, fpRes, sRes] = await Promise.all([
          supabase
            .from('assets')
            .select('id, asset_number, asset_name, description, category_id, ' +
                    'acquisition_cost, useful_life_months, in_service_date, ' +
                    'legacy_accum_depr, legacy_as_of_date, is_disposed')
            .eq('is_disposed', false)
            .order('asset_number', { nullsFirst: false }),
          supabase.from('categories').select('*').order('sort_order'),
          supabase.from('fiscal_periods').select('*').order('fiscal_year').order('period'),
          supabase.from('settings').select('key, value'),
        ]);
        if (cancelled) return;
        if (aRes.error)   throw aRes.error;
        if (cRes.error)   throw cRes.error;
        if (fpRes.error)  throw fpRes.error;
        // settings is tolerated if missing
        setAssets(aRes.data || []);
        setCategories(cRes.data || []);
        setFiscalPeriods(fpRes.data || []);
        if (sRes.data) {
          const m = {};
          for (const r of sRes.data) m[r.key] = r.value;
          setSettings(m);
        }
        setRefLoading(false);
      } catch (e) {
        if (!cancelled) {
          setRefError(e.message || String(e));
          setRefLoading(false);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const selectedAsset = useMemo(
    () => assets?.find(a => a.id === assetId) || null,
    [assets, assetId]
  );

  const selectedCat = useMemo(
    () => categories.find(c => c.id === selectedAsset?.category_id) || null,
    [categories, selectedAsset]
  );

  // ============================================================
  // Calculation: NBV at disposal = NBV at end of prior month
  // ============================================================
  const calc = useMemo(() => {
    if (!selectedAsset || !disposalDate || fiscalPeriods.length === 0) return null;

    const dispFP = getFiscalPeriodForDate(disposalDate, fiscalPeriods);
    if (!dispFP) {
      return { error: `Disposal date ${fmtDate(disposalDate)} is outside the fiscal calendar.` };
    }

    // Prior-month close balance — NBV reflects depreciation through the
    // month BEFORE the disposal month.
    const prior = priorMonthOf(dispFP.fiscal_year, dispFP.period);

    // If the asset wasn't yet in service by the prior month-end, NBV = cost
    // (no depreciation accrued). This handles the edge case where someone
    // tries to dispose an asset placed in service the same month or later.
    const cost = Number(selectedAsset.acquisition_cost) || 0;
    const accum = calcAccumDepr(selectedAsset, prior.fiscal_year, prior.period, fiscalPeriods);
    const nbv = Math.max(0, cost - accum);

    const proceeds = parseFloat(proceedsStr) || 0;
    const gainLoss = +(proceeds - nbv).toFixed(2);

    // Validate: in-service date must be on or before disposal date
    if (selectedAsset.in_service_date && selectedAsset.in_service_date > disposalDate) {
      return {
        error: `Disposal date is before the asset's in-service date (${fmtDate(selectedAsset.in_service_date)}).`,
      };
    }

    return {
      cost: +cost.toFixed(2),
      accum: +accum.toFixed(2),
      nbv: +nbv.toFixed(2),
      proceeds: +proceeds.toFixed(2),
      gainLoss,
      priorMonth: prior,
      dispFP,
    };
  }, [selectedAsset, disposalDate, proceedsStr, fiscalPeriods]);

  // ============================================================
  // IIF builder
  //
  // Lines built (proceeds line intentionally omitted):
  //   DR  accum_account                accum_at_disposal
  //   CR  cost_account                 cost_at_disposal
  //   plus a balancing line to gain/loss:
  //     loss  → DR gain_loss_account |gain_loss|
  //     gain  → CR gain_loss_account  gain_loss
  //
  // IIF requires DR == CR. With proceeds-line omitted:
  //   DR side: accum + (proceeds + |loss|)? → we omit proceeds, so:
  //   DR accum + (loss?  abs(GL) : 0)
  //   CR cost  + (gain?  GL : 0)
  // ============================================================
  function buildIIF(disposal, asset, cat) {
    const dt = fmtDate(disposal.posting_date);
    const docnum = disposal.iif_docnum;
    const memo = `Disposal #${asset.asset_number ?? '?'} — ${asset.asset_name}`;

    const accumAcct = (cat && cat.accum_account) || DEFAULT_ACCUM_ACCT;
    const costAcct  = (cat && cat.cost_account)  || null; // surfaced as error if missing
    const glAcct    = settings.gl_gain_loss_account || DEFAULT_GAIN_LOSS_ACCT;

    const accumAmt = disposal.accum_at_disposal.toFixed(2);
    const costAmt  = disposal.cost_at_disposal.toFixed(2);
    const gl       = disposal.gain_loss;

    let out = '';
    out += '!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\n';
    out += '!SPL\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\n';
    out += '!ENDTRNS\n';

    // TRNS = first line (DR accum, positive)
    out += `TRNS\tGENERAL JOURNAL\t${dt}\t${accumAcct}\t${accumAmt}\t${docnum}\t${memo}\n`;
    // SPL = CR cost (negative)
    out += `SPL\tGENERAL JOURNAL\t${dt}\t${costAcct}\t-${costAmt}\t${docnum}\t${memo}\n`;

    // Plug to gain/loss
    if (Math.abs(gl) > 0.005) {
      if (gl < 0) {
        // Loss — DR 69000 with abs(gl)
        out += `SPL\tGENERAL JOURNAL\t${dt}\t${glAcct}\t${Math.abs(gl).toFixed(2)}\t${docnum}\t${memo}\n`;
      } else {
        // Gain — CR 69000 with gl
        out += `SPL\tGENERAL JOURNAL\t${dt}\t${glAcct}\t-${gl.toFixed(2)}\t${docnum}\t${memo}\n`;
      }
    }
    out += 'ENDTRNS\n';
    return out;
  }

  function downloadIIF(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // Save
  // ============================================================
  async function handleSave() {
    if (!selectedAsset || !calc || calc.error) return;
    setSaveError(null);

    const cat = selectedCat;
    if (!cat || !cat.cost_account) {
      setSaveError(
        `Category "${cat?.name || '?'}" is missing a cost_account in the categories table. ` +
        `Set it via Admin → Categories before disposing assets in this category.`
      );
      return;
    }

    setSaving(true);
    try {
      const dispFP = calc.dispFP;
      const docnum = `DISP-${monthAbbrev(dispFP.period)}-${dispFP.fiscal_year}-${selectedAsset.asset_number ?? selectedAsset.id.slice(0, 8)}`;

      // 1. Insert disposals row
      const disposalRecord = {
        asset_id:          selectedAsset.id,
        disposal_date:     disposalDate,
        posting_date:      postingDate,
        proceeds:          calc.proceeds,
        cost_at_disposal:  calc.cost,
        accum_at_disposal: calc.accum,
        nbv_at_disposal:   calc.nbv,
        gain_loss:         calc.gainLoss,
        iif_docnum:        docnum,
        notes:             notes || null,
      };

      const { data: inserted, error: insErr } = await supabase
        .from('disposals')
        .insert([disposalRecord])
        .select()
        .single();
      if (insErr) throw insErr;

      // 2. Mark asset as disposed
      const { error: updErr } = await supabase
        .from('assets')
        .update({ is_disposed: true })
        .eq('id', selectedAsset.id);
      if (updErr) throw updErr;

      // 3. Download IIF
      const iifText = buildIIF(inserted, selectedAsset, cat);
      downloadIIF(iifText, `${docnum}.iif`);

      onSaved && onSaved(inserted);
    } catch (e) {
      console.error(e);
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  // ============================================================
  // Render
  // ============================================================
  if (refError) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Error"
        width={500}
        footer={<button onClick={onClose} className="px-3 py-1.5 text-xs font-medium bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-50">Close</button>}
      >
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load form data:</strong> {refError}
          {refError.includes('disposals') && (
            <div className="mt-2 text-[12px]">
              The <code className="bg-red-100 px-1 rounded">disposals</code> table may not be set up.
              Run the SQL migration <code className="bg-red-100 px-1 rounded">migration_disposals.sql</code> in Supabase.
            </div>
          )}
        </div>
      </Modal>
    );
  }
  if (refLoading) {
    return (
      <Modal open onClose={onClose} title="Record Disposal" width={620}>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </Modal>
    );
  }

  const canSave =
    selectedAsset &&
    calc && !calc.error &&
    proceedsStr.trim() !== '' &&  // require explicit entry (use 0 if free)
    !saving;

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      title="Record Disposal"
      width={640}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save & Download IIF'}
          </button>
        </>
      }
    >
      {/* Asset selection */}
      <Field label="Asset" required>
        {preselectedAssetId ? (
          <div className="px-2 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded">
            {selectedAsset
              ? <>#{selectedAsset.asset_number ?? '?'} — {selectedAsset.asset_name}</>
              : <span className="text-gray-400">Loading asset…</span>}
          </div>
        ) : (
          <select
            value={assetId}
            onChange={e => setAssetId(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-white"
          >
            <option value="">— Select an asset to dispose —</option>
            {(assets || []).map(a => (
              <option key={a.id} value={a.id}>
                #{a.asset_number ?? '?'} — {a.asset_name}
              </option>
            ))}
          </select>
        )}
      </Field>

      {selectedAsset && (
        <div className="mt-3 px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[12.5px] leading-relaxed">
          <div><span className="text-gray-500">Cost:</span> <span className="num font-medium">{fmt$(selectedAsset.acquisition_cost)}</span></div>
          <div><span className="text-gray-500">Category:</span> {selectedCat?.name || <span className="text-gray-400">—</span>}</div>
          <div><span className="text-gray-500">In Service:</span> {fmtDate(selectedAsset.in_service_date)}</div>
          {selectedAsset.description && (
            <div className="text-gray-500 mt-1">{selectedAsset.description}</div>
          )}
        </div>
      )}

      {/* Dates */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="Disposal Date" required hint="Used to derive prior-month close NBV">
          <input
            type="date"
            value={disposalDate}
            onChange={e => setDisposalDate(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Posting Date" required hint="Date on the IIF entry">
          <input
            type="date"
            value={postingDate}
            onChange={e => setPostingDate(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
      </div>

      {/* Proceeds */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="Proceeds" required hint="Sale price (0 if scrapped/discarded)">
          <input
            type="number"
            step="0.01"
            value={proceedsStr}
            onChange={e => setProceedsStr(e.target.value)}
            placeholder="0.00"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded num"
          />
        </Field>
      </div>

      {/* Notes */}
      <div className="mt-3">
        <Field label="Notes" hint="Optional — buyer, reason, asset tag, etc.">
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
            placeholder="Sold to ABC Salvage; pickup confirmed by D. Smith"
          />
        </Field>
      </div>

      {/* Calc preview */}
      {calc && !calc.error && (
        <div className="mt-4 px-3 py-3 bg-blue-50 border border-blue-200 rounded">
          <div className="text-[10px] font-semibold uppercase text-blue-800 tracking-wider mb-2">
            Calculation Preview — based on{' '}
            {calc.priorMonth.period}/{calc.priorMonth.fiscal_year} close
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[12.5px]">
            <PreviewCell label="Cost"        value={fmt$(calc.cost)} />
            <PreviewCell label="Accum Depr"  value={fmt$(calc.accum)} />
            <PreviewCell label="NBV"         value={fmt$(calc.nbv)} bold />
            <PreviewCell label="Proceeds"    value={fmt$(calc.proceeds)} />
          </div>
          <div className="mt-3 pt-2 border-t border-blue-200 flex items-baseline gap-3">
            <div className="text-[11px] font-semibold uppercase text-blue-800 tracking-wider">
              {calc.gainLoss > 0.005 ? 'Gain' : calc.gainLoss < -0.005 ? 'Loss' : 'Even'}
            </div>
            <div className={`num font-bold text-base ${
              calc.gainLoss > 0.005 ? 'text-green-700'
              : calc.gainLoss < -0.005 ? 'text-red-700'
              : 'text-gray-600'
            }`}>
              {fmt$(calc.gainLoss)}
            </div>
            <div className="text-[11px] text-gray-500 ml-auto">
              proceeds − NBV
            </div>
          </div>

          {/* IIF preview lines */}
          <div className="mt-3 pt-2 border-t border-blue-200">
            <div className="text-[10px] font-semibold uppercase text-blue-800 tracking-wider mb-1.5">
              IIF Preview
            </div>
            <table className="w-full text-[12px]">
              <tbody>
                <IIFRow
                  acct={(selectedCat?.accum_account) || DEFAULT_ACCUM_ACCT}
                  desc="Accumulated Depreciation"
                  dr={calc.accum}
                  cr={null}
                />
                <IIFRow
                  acct={selectedCat?.cost_account || <span className="text-red-600 font-semibold">missing!</span>}
                  desc="Asset Cost"
                  dr={null}
                  cr={calc.cost}
                />
                {Math.abs(calc.gainLoss) > 0.005 && (
                  <IIFRow
                    acct={settings.gl_gain_loss_account || DEFAULT_GAIN_LOSS_ACCT}
                    desc={calc.gainLoss > 0 ? 'Gain on Disposal' : 'Loss on Disposal'}
                    dr={calc.gainLoss < 0 ? Math.abs(calc.gainLoss) : null}
                    cr={calc.gainLoss > 0 ? calc.gainLoss : null}
                  />
                )}
              </tbody>
            </table>
            <div className="text-[10px] text-gray-500 mt-1.5">
              Proceeds line intentionally omitted — book proceeds separately in QuickBooks.
            </div>
          </div>
        </div>
      )}

      {calc && calc.error && (
        <div className="mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded text-[12.5px] text-red-700">
          {calc.error}
        </div>
      )}

      {saveError && (
        <div className="mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded text-[12.5px] text-red-700">
          <strong>Could not save:</strong> {saveError}
        </div>
      )}
    </Modal>
  );
}

// ============================================================
// Subcomponents
// ============================================================

function Field({ label, required, hint, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold text-gray-600">
        {label}
        {required && <span className="text-red-600"> *</span>}
        {hint && <span className="text-gray-400 font-normal ml-1">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function PreviewCell({ label, value, bold }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider">{label}</div>
      <div className={`num ${bold ? 'font-bold text-base' : ''}`}>{value}</div>
    </div>
  );
}

function IIFRow({ acct, desc, dr, cr }) {
  return (
    <tr className="border-b border-blue-100 last:border-b-0">
      <td className="py-0.5 pr-2 num text-gray-700">{acct}</td>
      <td className="py-0.5 pr-2 text-gray-500">{desc}</td>
      <td className="py-0.5 pr-2 text-right num">
        {dr != null ? fmt$(dr) : <span className="text-gray-300">—</span>}
      </td>
      <td className="py-0.5 text-right num">
        {cr != null ? fmt$(cr) : <span className="text-gray-300">—</span>}
      </td>
    </tr>
  );
}
