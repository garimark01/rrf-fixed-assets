/**
 * Disposals Page
 *
 * List of all recorded disposals + entry point to record new ones.
 *
 * Each row: asset #, asset name, disposal date, proceeds, NBV at disposal,
 * gain/loss, IIF doc#, recorded date, actions (re-download IIF, reverse).
 *
 * Reverse:
 *   - Confirms with user
 *   - Sets assets.is_disposed = false
 *   - Deletes the disposals row
 *   - No automatic IIF reversal — user books that in QB manually
 *   - Behavior matches Depreciation Run delete (delete, don't soft-mark)
 *
 * Filters:
 *   - Search box (asset name / number / notes)
 *   - Year filter (disposal date year)
 *
 * Empty state: clear CTA pointing to "+ Record Disposal".
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../components/Toast';
import { fmt$, fmtInt, fmtDate } from '../lib/calculations';
import DisposeModal from '../components/DisposeModal';

const DEFAULT_ACCUM_ACCT = '13400';
const DEFAULT_GAIN_LOSS_ACCT = '69000';

function monthAbbrev(period) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][period - 1];
}

export default function DisposalsPage() {
  const showToast = useToast();
  const [disposals, setDisposals]   = useState(null);
  const [assetsById, setAssetsById] = useState({});
  const [categories, setCategories] = useState({});
  const [settings, setSettings]     = useState({});
  const [error, setError]           = useState(null);

  const [search, setSearch]         = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [showModal, setShowModal]   = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [dRes, aRes, cRes, sRes] = await Promise.all([
        supabase.from('disposals').select('*').order('disposal_date', { ascending: false }).order('created_at', { ascending: false }),
        supabase.from('assets').select('id, asset_number, asset_name, description, category_id'),
        supabase.from('categories').select('id, name, cost_account, accum_account'),
        supabase.from('settings').select('key, value'),
      ]);
      if (dRes.error) throw dRes.error;
      if (aRes.error) throw aRes.error;
      if (cRes.error) throw cRes.error;
      // settings is tolerated

      const aMap = {};
      for (const a of aRes.data || []) aMap[a.id] = a;
      setAssetsById(aMap);

      const cMap = {};
      for (const c of cRes.data || []) cMap[c.id] = c;
      setCategories(cMap);

      if (sRes.data) {
        const sMap = {};
        for (const r of sRes.data) sMap[r.key] = r.value;
        setSettings(sMap);
      }

      setDisposals(dRes.data || []);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ============================================================
  // Filtering
  // ============================================================
  const filtered = useMemo(() => {
    if (!disposals) return [];
    let list = disposals;

    if (yearFilter) {
      list = list.filter(d => (d.disposal_date || '').slice(0, 4) === yearFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(d => {
        const a = assetsById[d.asset_id];
        const haystack = [
          a?.asset_name || '',
          String(a?.asset_number ?? ''),
          a?.description || '',
          d.notes || '',
          d.iif_docnum || '',
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    return list;
  }, [disposals, assetsById, yearFilter, search]);

  // Year list for the filter dropdown
  const years = useMemo(() => {
    if (!disposals) return [];
    const set = new Set();
    for (const d of disposals) {
      if (d.disposal_date) set.add(d.disposal_date.slice(0, 4));
    }
    return [...set].sort().reverse();
  }, [disposals]);

  // Aggregates for the summary strip
  const summary = useMemo(() => {
    let proceeds = 0, nbv = 0, gl = 0;
    for (const d of filtered) {
      proceeds += d.proceeds || 0;
      nbv      += d.nbv_at_disposal || 0;
      gl       += d.gain_loss || 0;
    }
    return { count: filtered.length, proceeds, nbv, gl };
  }, [filtered]);

  // ============================================================
  // Reverse a disposal
  // ============================================================
  async function reverseDisposal(disposal) {
    const a = assetsById[disposal.asset_id];
    const label = a ? `#${a.asset_number ?? '?'} — ${a.asset_name}` : 'this asset';
    const confirmMsg =
      `Reverse the disposal of ${label}?\n\n` +
      `This will:\n` +
      `  • Restore the asset to active status\n` +
      `  • Delete the disposal record (${disposal.iif_docnum})\n\n` +
      `This does NOT reverse the IIF entry — you'll need to reverse that\n` +
      `manually in QuickBooks. Continue?`;

    if (!window.confirm(confirmMsg)) return;

    try {
      // 1. Restore asset
      const { error: updErr } = await supabase
        .from('assets')
        .update({ is_disposed: false })
        .eq('id', disposal.asset_id);
      if (updErr) throw updErr;

      // 2. Delete disposal row
      const { error: delErr } = await supabase
        .from('disposals')
        .delete()
        .eq('id', disposal.id);
      if (delErr) throw delErr;

      showToast(`Disposal of ${label} reversed.`);
      load();
    } catch (e) {
      showToast(`Could not reverse: ${e.message || String(e)}`, 'error');
    }
  }

  // ============================================================
  // Re-download IIF for an existing disposal
  // ============================================================
  function redownloadIIF(disposal) {
    const a = assetsById[disposal.asset_id];
    const c = a ? categories[a.category_id] : null;
    if (!a) {
      showToast('Could not re-build IIF — asset record missing.', 'error');
      return;
    }
    if (!c || !c.cost_account) {
      showToast(`Category for asset #${a.asset_number ?? '?'} is missing cost_account; cannot rebuild IIF.`, 'error');
      return;
    }

    const text = buildIIFFromRecord(disposal, a, c, settings);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${disposal.iif_docnum}.iif`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('IIF re-downloaded.');
  }

  // ============================================================
  // Render gates
  // ============================================================
  if (error) {
    const looksLikeMissingTable = error.toLowerCase().includes('disposals')
      || error.toLowerCase().includes('relation');
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Disposals</h1>
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load disposals:</strong> {error}
          {looksLikeMissingTable && (
            <div className="mt-2 text-[12px]">
              The <code className="bg-red-100 px-1 rounded">disposals</code> table may not be set up yet.
              Run the SQL migration <code className="bg-red-100 px-1 rounded">migration_disposals.sql</code> in
              your Supabase SQL editor first, then refresh this page.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!disposals) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Disposals</h1>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Disposals</h1>
        <button
          onClick={() => setShowModal(true)}
          className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Record Disposal
        </button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <SummaryCard label="Disposals" value={fmtInt(summary.count)} sub={yearFilter ? `in ${yearFilter}` : 'all-time'} />
        <SummaryCard label="Total Proceeds" value={fmt$(summary.proceeds)} />
        <SummaryCard label="Total NBV at Disposal" value={fmt$(summary.nbv)} />
        <SummaryCard
          label="Net Gain / (Loss)"
          value={fmt$(summary.gl)}
          tone={summary.gl > 0.005 ? 'green' : summary.gl < -0.005 ? 'red' : 'gray'}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={yearFilter}
          onChange={e => setYearFilter(e.target.value)}
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white"
        >
          <option value="">All years</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <input
          className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white flex-1 min-w-[200px]"
          type="text"
          placeholder="Search asset name, number, doc#, notes..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="text-xs text-gray-500 num ml-auto">
          {fmtInt(filtered.length)} of {fmtInt(disposals.length)} disposals
        </div>
      </div>

      {/* Table or empty state */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-md shadow-sm p-8 text-center">
          {disposals.length === 0 ? (
            <>
              <div className="text-sm text-gray-500 mb-2">No disposals recorded yet.</div>
              <button
                onClick={() => setShowModal(true)}
                className="text-xs font-medium text-blue-600 hover:text-blue-800"
              >
                Record the first disposal →
              </button>
            </>
          ) : (
            <div className="text-sm text-gray-400">No disposals match the current filters.</div>
          )}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                  <th className="text-left px-2 py-2 font-semibold">#</th>
                  <th className="text-left px-2 py-2 font-semibold">Asset</th>
                  <th className="text-left px-2 py-2 font-semibold">Disposal Date</th>
                  <th className="text-right px-2 py-2 font-semibold">Cost</th>
                  <th className="text-right px-2 py-2 font-semibold">Accum</th>
                  <th className="text-right px-2 py-2 font-semibold">NBV</th>
                  <th className="text-right px-2 py-2 font-semibold">Proceeds</th>
                  <th className="text-right px-2 py-2 font-semibold">Gain / (Loss)</th>
                  <th className="text-left px-2 py-2 font-semibold">IIF Doc#</th>
                  <th className="text-left px-2 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(d => {
                  const a = assetsById[d.asset_id];
                  return (
                    <tr key={d.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-2 py-1.5 num text-gray-400">
                        {a?.asset_number ?? '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="leading-tight">
                          {a?.asset_name || <span className="text-red-400">(asset deleted)</span>}
                        </div>
                        {d.notes && (
                          <div className="text-[11px] text-gray-400 leading-tight mt-0.5">
                            {d.notes.length > 60 ? d.notes.slice(0, 60) + '…' : d.notes}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">{fmtDate(d.disposal_date)}</td>
                      <td className="px-2 py-1.5 text-right num">{fmt$(d.cost_at_disposal)}</td>
                      <td className="px-2 py-1.5 text-right num">{fmt$(d.accum_at_disposal)}</td>
                      <td className="px-2 py-1.5 text-right num">{fmt$(d.nbv_at_disposal)}</td>
                      <td className="px-2 py-1.5 text-right num">{fmt$(d.proceeds)}</td>
                      <td className={`px-2 py-1.5 text-right num font-semibold ${
                        d.gain_loss > 0.005 ? 'text-green-700'
                        : d.gain_loss < -0.005 ? 'text-red-700'
                        : 'text-gray-600'
                      }`}>
                        {fmt$(d.gain_loss)}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-gray-500">
                        {d.iif_docnum}
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          onClick={() => redownloadIIF(d)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          IIF
                        </button>
                        <button
                          onClick={() => reverseDisposal(d)}
                          className="text-xs text-red-500 hover:text-red-700 font-medium ml-3"
                        >
                          Reverse
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-blue-50 font-bold border-t-2 border-blue-300">
                  <td colSpan={3} className="px-2 py-2">{fmtInt(filtered.length)} disposals</td>
                  <td colSpan={2} />
                  <td className="px-2 py-2 text-right num">{fmt$(summary.nbv)}</td>
                  <td className="px-2 py-2 text-right num">{fmt$(summary.proceeds)}</td>
                  <td className={`px-2 py-2 text-right num ${
                    summary.gl > 0.005 ? 'text-green-700'
                    : summary.gl < -0.005 ? 'text-red-700'
                    : 'text-gray-700'
                  }`}>
                    {fmt$(summary.gl)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showModal && (
        <DisposeModal
          onClose={() => setShowModal(false)}
          onSaved={(rec) => {
            const a = assetsById[rec.asset_id];
            const label = a ? `#${a.asset_number ?? '?'} — ${a.asset_name}` : 'asset';
            showToast(`Disposal recorded: ${label}. IIF downloaded.`);
            setShowModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// IIF rebuild for re-download (mirrors DisposeModal.buildIIF)
// ============================================================
function buildIIFFromRecord(disposal, asset, cat, settings) {
  const dt = fmtDate(disposal.posting_date);
  const docnum = disposal.iif_docnum;
  const memo = `Disposal #${asset.asset_number ?? '?'} — ${asset.asset_name}`;

  const accumAcct = (cat && cat.accum_account) || DEFAULT_ACCUM_ACCT;
  const costAcct  = cat.cost_account;
  const glAcct    = (settings && settings.gl_gain_loss_account) || DEFAULT_GAIN_LOSS_ACCT;

  const accumAmt = Number(disposal.accum_at_disposal).toFixed(2);
  const costAmt  = Number(disposal.cost_at_disposal).toFixed(2);
  const gl       = Number(disposal.gain_loss);

  let out = '';
  out += '!TRNS\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\n';
  out += '!SPL\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\n';
  out += '!ENDTRNS\n';
  out += `TRNS\tGENERAL JOURNAL\t${dt}\t${accumAcct}\t${accumAmt}\t${docnum}\t${memo}\n`;
  out += `SPL\tGENERAL JOURNAL\t${dt}\t${costAcct}\t-${costAmt}\t${docnum}\t${memo}\n`;
  if (Math.abs(gl) > 0.005) {
    if (gl < 0) {
      out += `SPL\tGENERAL JOURNAL\t${dt}\t${glAcct}\t${Math.abs(gl).toFixed(2)}\t${docnum}\t${memo}\n`;
    } else {
      out += `SPL\tGENERAL JOURNAL\t${dt}\t${glAcct}\t-${gl.toFixed(2)}\t${docnum}\t${memo}\n`;
    }
  }
  out += 'ENDTRNS\n';
  return out;
}

// ============================================================
// Subcomponents
// ============================================================

function SummaryCard({ label, value, sub, tone }) {
  const toneClass =
    tone === 'green' ? 'text-green-700'
    : tone === 'red' ? 'text-red-700'
    : '';
  return (
    <div className="bg-white border border-gray-200 rounded-md p-4 shadow-sm">
      <div className="text-[10px] uppercase font-semibold text-gray-400 tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-bold num leading-tight ${toneClass}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}
