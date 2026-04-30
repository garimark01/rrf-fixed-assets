/**
 * AssetModal
 *
 * Add/Edit dialog for a single asset. Used from the Asset Register page.
 *
 * Modes:
 *   - mode='add'  : fresh form, asset_number auto-suggested, section forced to 'B'
 *   - mode='edit' : pre-filled from an existing asset
 *
 * Anchored (legacy-balance) assets:
 *   - The lock condition is `legacy_accum_depr IS NOT NULL` — i.e. the asset
 *     was imported with an external accumulated-depreciation balance.
 *   - cost / useful_life / acquisition_date / in_service_date are LOCKED by
 *     default with a clearly-marked "Edit anyway (advanced)" toggle. Editing
 *     these would invalidate the anchor.
 *   - The toggle exists for genuine corrections (vendor confirms a different
 *     in-service date, original cost data was wrong) but the user gets a
 *     warning so they don't do it casually.
 *
 * Live calc preview:
 *   - Recomputes monthly_depr / months_in_service / accum / NBV / fully-depr-date
 *     as the user types. For anchored assets the live preview is replaced by
 *     a "Anchor Balance" card showing the migrated values.
 *
 * Validation:
 *   - asset_name, category, acquisition_date, in_service_date, cost > 0, life > 0 required
 *   - in_service_date >= acquisition_date
 *   - in_service_date can't fall in a closed period (only enforced on new
 *     assets or when the date moves on edit — non-changing dates pass through)
 *   - cost <= $10M sanity cap
 *   - asset_number uniqueness handled by DB; we surface the error friendly-style
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmt$, fmtInt, fmtDate } from '../lib/calculations';
import Modal from './Modal';

const SANITY_COST_CAP = 10_000_000;
const NEW_ASSET_DEFAULT_LIFE_YEARS = 5;

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function lastDayOfMonthDate(year, monthIdx) {
  // monthIdx 0-based; day 0 of next month = last day of this one
  return new Date(year, monthIdx + 1, 0);
}

export default function AssetModal({ mode, asset, onClose, onSaved }) {
  const isEdit = mode === 'edit';
  const isAnchored = isEdit && asset?.legacy_accum_depr != null;

  // Reference data
  const [categories, setCategories]     = useState([]);
  const [locations, setLocations]       = useState([]);
  const [closedPeriods, setClosedPeriods] = useState([]);
  const [refLoading, setRefLoading]     = useState(true);
  const [refError, setRefError]         = useState(null);

  // Form state
  const [assetNumber, setAssetNumber]         = useState('');
  const [assetName, setAssetName]             = useState('');
  const [description, setDescription]         = useState('');
  const [categoryId, setCategoryId]           = useState('');
  const [locationId, setLocationId]           = useState('');
  const [acquisitionDate, setAcquisitionDate] = useState('');
  const [inServiceDate, setInServiceDate]     = useState('');
  const [inServiceTouched, setInServiceTouched] = useState(false);
  const [costStr, setCostStr]                 = useState('');
  const [lifeYearsStr, setLifeYearsStr]       = useState('');

  const [unlockAnchored, setUnlockAnchored] = useState(false);
  const [saving, setSaving]                 = useState(false);
  const [saveError, setSaveError]           = useState(null);

  // ---- load reference data + initial values ----
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const [catsRes, locsRes, periodsRes] = await Promise.all([
        supabase.from('categories').select('id, name').order('sort_order'),
        supabase.from('locations').select('id, name, is_active').order('sort_order', { nullsFirst: false }),
        supabase.from('fiscal_periods').select('fiscal_year, period').eq('status', 'closed'),
      ]);

      if (cancelled) return;

      const firstError = catsRes.error?.message || locsRes.error?.message || periodsRes.error?.message;
      if (firstError) {
        setRefError(firstError);
        setRefLoading(false);
        return;
      }

      setCategories(catsRes.data || []);
      setLocations(locsRes.data || []);
      setClosedPeriods(periodsRes.data || []);

      if (isEdit && asset) {
        setAssetNumber(asset.asset_number != null ? String(asset.asset_number) : '');
        setAssetName(asset.asset_name || '');
        setDescription(asset.description || '');
        setCategoryId(asset.category_id || '');
        setLocationId(asset.location_id || '');
        setAcquisitionDate(asset.acquisition_date || '');
        setInServiceDate(asset.in_service_date || asset.acquisition_date || '');
        setInServiceTouched(true);
        setCostStr(asset.acquisition_cost != null ? String(asset.acquisition_cost) : '');
        setLifeYearsStr(asset.useful_life_years != null ? String(asset.useful_life_years) : '');
      } else {
        const numRes = await supabase.rpc('next_asset_number');
        if (cancelled) return;
        if (!numRes.error && numRes.data != null) {
          setAssetNumber(String(numRes.data));
        }
        const today = isoToday();
        setAcquisitionDate(today);
        setInServiceDate(today);
        setLifeYearsStr(String(NEW_ASSET_DEFAULT_LIFE_YEARS));
      }

      setRefLoading(false);
    }

    init().catch(e => {
      if (!cancelled) {
        setRefError(e.message || String(e));
        setRefLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [isEdit, asset]);

  // Auto-mirror in-service date until user touches it
  useEffect(() => {
    if (!inServiceTouched) setInServiceDate(acquisitionDate);
  }, [acquisitionDate, inServiceTouched]);

  const financialsLocked = isAnchored && !unlockAnchored;

  // ---- live calc preview ----
  const calc = useMemo(() => {
    const cost = parseFloat(costStr) || 0;
    const lifeYears = parseFloat(lifeYearsStr) || 0;
    const ulm = Math.round(lifeYears * 12);
    const monthly = ulm > 0 && cost > 0 ? cost / ulm : 0;

    const inSvc = parseISODate(inServiceDate);
    let mis = 0, accum = 0, nbv = cost, fullyDate = null;

    if (inSvc && ulm > 0 && cost > 0) {
      const today = new Date();
      const inSvcDate = new Date(inSvc.y, inSvc.m - 1, 1);
      const todayMonthEnd = lastDayOfMonthDate(today.getFullYear(), today.getMonth());
      if (inSvcDate <= todayMonthEnd) {
        mis = (today.getFullYear() - inSvc.y) * 12 + (today.getMonth() - (inSvc.m - 1)) + 1;
        mis = Math.max(0, Math.min(mis, ulm));
        accum = monthly * mis;
        nbv = Math.max(0, cost - accum);
      }
      const fdMonth = (inSvc.m - 1) + (ulm - 1);
      const fdY = inSvc.y + Math.floor(fdMonth / 12);
      const fdM = ((fdMonth % 12) + 12) % 12;
      fullyDate = lastDayOfMonthDate(fdY, fdM);
    }

    return { cost, lifeYears, ulm, monthly, mis, accum, nbv, fullyDate };
  }, [costStr, lifeYearsStr, inServiceDate]);

  // ---- closed-period helper ----
  const closedKeys = useMemo(() => {
    const set = new Set();
    for (const p of closedPeriods) set.add(`${p.fiscal_year}-${p.period}`);
    return set;
  }, [closedPeriods]);

  function isDateInClosedPeriod(iso) {
    const p = parseISODate(iso);
    if (!p) return false;
    return closedKeys.has(`${p.y}-${p.m}`);
  }

  // ---- validation ----
  function validate() {
    const errs = [];
    if (!assetName.trim()) errs.push('Asset Name is required.');
    if (!categoryId) errs.push('Category is required.');
    if (!acquisitionDate) errs.push('Acquisition Date is required.');
    if (!inServiceDate) errs.push('In-Service Date is required.');

    const cost = parseFloat(costStr);
    if (!cost || cost <= 0) errs.push('Acquisition Cost must be greater than 0.');
    if (cost > SANITY_COST_CAP) errs.push(`Acquisition Cost cannot exceed ${fmt$(SANITY_COST_CAP)}.`);

    const life = parseFloat(lifeYearsStr);
    if (!life || life <= 0) errs.push('Useful Life (Years) must be greater than 0.');

    if (acquisitionDate && inServiceDate && inServiceDate < acquisitionDate) {
      errs.push('In-Service Date cannot be earlier than Acquisition Date.');
    }

    const num = parseInt(assetNumber, 10);
    if (!Number.isInteger(num) || num <= 0) {
      errs.push('Asset # must be a positive whole number.');
    }

    if (inServiceDate && isDateInClosedPeriod(inServiceDate)) {
      const movedFromOriginal = isEdit && asset && asset.in_service_date !== inServiceDate;
      if (!isEdit || movedFromOriginal) {
        errs.push('In-Service Date falls in a closed period — choose a date in an open period or reopen the period first.');
      }
    }

    return errs;
  }

  // ---- save ----
  async function handleSave() {
    setSaveError(null);
    const errs = validate();
    if (errs.length) {
      setSaveError(errs[0]);
      return;
    }

    setSaving(true);

    const num = parseInt(assetNumber, 10);
    const cost = parseFloat(costStr);
    const lifeYears = parseFloat(lifeYearsStr);
    const ulm = Math.round(lifeYears * 12);

    try {
      if (isEdit && asset) {
        const baseUpdate = {
          asset_number: num,
          asset_name: assetName.trim(),
          description: description.trim() || null,
          category_id: categoryId,
          location_id: locationId || null,
        };
        const financialUpdate = financialsLocked ? {} : {
          acquisition_date: acquisitionDate,
          in_service_date: inServiceDate,
          acquisition_cost: cost,
          useful_life_years: lifeYears,
          useful_life_months: ulm,
        };

        const { error } = await supabase
          .from('assets')
          .update({ ...baseUpdate, ...financialUpdate })
          .eq('id', asset.id);

        if (error) throw error;
        onSaved(asset.id, `Updated asset #${num} — ${assetName.trim()}`);
      } else {
        const insertRow = {
          asset_number: num,
          asset_name: assetName.trim(),
          description: description.trim() || null,
          category_id: categoryId,
          location_id: locationId || null,
          acquisition_date: acquisitionDate,
          in_service_date: inServiceDate,
          acquisition_cost: cost,
          useful_life_years: lifeYears,
          useful_life_months: ulm,
          section: 'B',
        };

        const { data, error } = await supabase
          .from('assets')
          .insert(insertRow)
          .select('id')
          .single();

        if (error) throw error;
        onSaved(data.id, `Added asset #${num} — ${assetName.trim()}`);
      }

      onClose();
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.toLowerCase().includes('asset_number') || msg.toLowerCase().includes('unique')) {
        setSaveError(`Asset #${assetNumber} is already in use. Pick a different number.`);
      } else {
        setSaveError(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- render gates ----
  const title = isEdit ? `Edit Asset — #${asset?.asset_number ?? '?'}` : 'Add Asset';

  if (refError) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Error"
        width={500}
        footer={
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-50">
            Close
          </button>
        }
      >
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load form data:</strong> {refError}
        </div>
      </Modal>
    );
  }

  if (refLoading) {
    return (
      <Modal open onClose={onClose} title={title} width={620}>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      title={title}
      width={620}
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
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
          >
            {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Save Asset')}
          </button>
        </>
      }
    >
      {/* Anchored banner */}
      {isAnchored && (
        <div className="mb-4 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded text-[12.5px]">
          <div className="font-semibold text-slate-700 mb-1">
            Asset has a migrated balance anchor
          </div>
          <div className="text-slate-600 leading-relaxed">
            Cost, useful life, and dates are locked because this asset's
            depreciation is anchored at a migrated balance (legacy_accum_depr ={' '}
            <span className="num">{fmt$(asset?.legacy_accum_depr ?? 0)}</span>{' '}
            as of {fmtDate(asset?.legacy_as_of_date)}). Changing these would
            invalidate the anchor.
            {asset?.section === 'A' && <span className="text-gray-400"> (Cohort: Section A — legacy.)</span>}
            {asset?.section === 'B' && <span className="text-gray-400"> (Cohort: Section B — current.)</span>}
            <br />
            <label className="cursor-pointer text-blue-600 hover:text-blue-800 mt-1.5 inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={unlockAnchored}
                onChange={e => setUnlockAnchored(e.target.checked)}
              />
              Edit anyway (advanced)
            </label>
          </div>
        </div>
      )}

      {/* Asset # + Name */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Asset #" hint={isEdit ? '' : 'auto-suggested, override if needed'}>
          <input
            type="number"
            step={1}
            value={assetNumber}
            onChange={e => setAssetNumber(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
        <Field label="Asset Name" required>
          <input
            type="text"
            value={assetName}
            onChange={e => setAssetName(e.target.value)}
            placeholder="e.g. Brand New Stand Alone Blower"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          />
        </Field>
      </div>

      {/* Description */}
      <Field label="Description" hint="optional — vendor, model, invoice info">
        <input
          type="text"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="e.g. 5 HP 1600 CFM from VendorX, inv #12345"
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
        />
      </Field>

      {/* Category + Location */}
      <div className="grid grid-cols-2 gap-3 mb-3 mt-3">
        <Field label="Category" required>
          <select
            value={categoryId}
            onChange={e => setCategoryId(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-white"
          >
            <option value="">— Select category —</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Location" hint={locations.length === 0 ? 'No locations defined yet' : 'optional'}>
          <select
            value={locationId}
            onChange={e => setLocationId(e.target.value)}
            disabled={locations.length === 0}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-white disabled:bg-gray-100"
          >
            <option value="">— No location —</option>
            {locations.filter(l => l.is_active).map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Acquisition Date" required hint="when you bought it">
          <input
            type="date"
            value={acquisitionDate}
            onChange={e => setAcquisitionDate(e.target.value)}
            disabled={financialsLocked}
            className={`w-full px-2 py-1.5 text-sm border border-gray-300 rounded ${financialsLocked ? 'bg-gray-100 text-gray-500' : ''}`}
          />
        </Field>
        <Field label="In-Service Date" required hint="depreciation start — defaults to acquisition">
          <input
            type="date"
            value={inServiceDate}
            onChange={e => { setInServiceDate(e.target.value); setInServiceTouched(true); }}
            disabled={financialsLocked}
            className={`w-full px-2 py-1.5 text-sm border border-gray-300 rounded ${financialsLocked ? 'bg-gray-100 text-gray-500' : ''}`}
          />
        </Field>
      </div>

      {/* Cost + Life */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Acquisition Cost" required>
          <input
            type="number"
            step="0.01"
            value={costStr}
            onChange={e => setCostStr(e.target.value)}
            placeholder="0.00"
            disabled={financialsLocked}
            className={`w-full px-2 py-1.5 text-sm border border-gray-300 rounded ${financialsLocked ? 'bg-gray-100 text-gray-500' : ''}`}
          />
        </Field>
        <Field label="Useful Life (Years)" required>
          <input
            type="number"
            step="1"
            min="1"
            value={lifeYearsStr}
            onChange={e => setLifeYearsStr(e.target.value)}
            disabled={financialsLocked}
            className={`w-full px-2 py-1.5 text-sm border border-gray-300 rounded ${financialsLocked ? 'bg-gray-100 text-gray-500' : ''}`}
          />
        </Field>
      </div>

      {/* Calc preview / Anchor balance card */}
      {isAnchored ? (
        <AnchorBalanceCard asset={asset} />
      ) : (
        <CalcPreview calc={calc} />
      )}

      {/* Save error */}
      {saveError && (
        <div className="mt-3 px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
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

function CalcPreview({ calc }) {
  const muted = (n) => n <= 0;
  const fullyDateIso = calc.fullyDate
    ? `${calc.fullyDate.getFullYear()}-${String(calc.fullyDate.getMonth() + 1).padStart(2, '0')}-${String(calc.fullyDate.getDate()).padStart(2, '0')}`
    : null;

  return (
    <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded">
      <h4 className="text-[10px] uppercase font-semibold text-gray-500 tracking-wider mb-2">
        Live Calculation Preview
      </h4>
      <div className="grid grid-cols-4 gap-2">
        <PreviewCell label="Useful Life (Months)" value={calc.ulm > 0 ? `${fmtInt(calc.ulm)} months` : '—'} muted={muted(calc.ulm)} />
        <PreviewCell label="Monthly Depreciation" value={calc.monthly > 0 ? fmt$(calc.monthly) : '—'} muted={muted(calc.monthly)} />
        <PreviewCell label="Months in Service"   value={calc.mis > 0 ? `${fmtInt(calc.mis)} months` : '—'} muted={muted(calc.mis)} />
        <PreviewCell label="Accum Depr (to date)" value={calc.cost > 0 ? fmt$(calc.accum) : '—'} muted={muted(calc.cost)} />
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <PreviewCell label="NBV (to date)" value={calc.cost > 0 ? fmt$(calc.nbv) : '—'} muted={muted(calc.cost)} />
        <PreviewCell label="Fully depreciated on" value={fmtDate(fullyDateIso)} muted={!fullyDateIso} />
      </div>
    </div>
  );
}

function PreviewCell({ label, value, muted }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-gray-400 font-medium tracking-wider">{label}</div>
      <div className={`text-sm font-semibold num mt-0.5 ${muted ? 'text-gray-300' : 'text-gray-800'}`}>
        {value}
      </div>
    </div>
  );
}

function AnchorBalanceCard({ asset }) {
  const accum = asset.legacy_accum_depr || 0;
  const cost = asset.acquisition_cost || 0;
  const nbv = Math.max(0, cost - accum);

  return (
    <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded">
      <h4 className="text-[10px] uppercase font-semibold text-slate-600 tracking-wider mb-2">
        Anchor Balance (migrated)
      </h4>
      <div className="grid grid-cols-4 gap-2">
        <PreviewCell label="Anchor date" value={fmtDate(asset.legacy_as_of_date)} />
        <PreviewCell label="Anchor Accum" value={fmt$(accum)} />
        <PreviewCell label="Cost" value={fmt$(cost)} />
        <PreviewCell label="NBV at anchor" value={fmt$(nbv)} />
      </div>
      <div className="mt-2 text-[10px] text-gray-500 leading-relaxed">
        This card shows only the migrated baseline. Live depreciation past the
        anchor is added on the Asset Register and Dashboard — anchored assets
        continue depreciating on their normal monthly schedule.
      </div>
    </div>
  );
}
