/**
 * Categories Admin Page
 *
 * Edit-only CRUD for the two seeded categories: Furniture & Equipment and
 * Lease Hold Improvement. The category set itself is fixed — RRF chart of
 * accounts has exactly these two FA categories, and the reconciliation
 * parser plus IIF builder both depend on the GL codes resolving to the
 * BS layout. Adding/deleting categories is intentionally not supported.
 *
 * What you can edit:
 *   - cost_account     (e.g. "13300 · Furniture and Equipment")
 *   - accum_account    (e.g. "13400 · Accumulated Depreciation")
 *   - expense_account  (e.g. "62400 · Depreciation Expense")
 *
 * Format note: store these as full GL-coded labels matching exactly what
 * QuickBooks calls them, so the IIF import resolves accounts cleanly.
 * The Reconciliation page extracts the leading GL number for matching,
 * so any "{number} · {description}" or "{number} - {description}" form
 * works for recon — but QB needs the exact label for the IIF.
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';

export default function CategoriesAdminPage() {
  const showToast = useToast();
  const [categories, setCategories] = useState(null);
  const [error, setError]           = useState(null);
  const [editTarget, setEditTarget] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await supabase
        .from('categories')
        .select('*')
        .order('sort_order');
      if (res.error) throw res.error;
      setCategories(res.data || []);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Categories</h1>
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load categories:</strong> {error}
        </div>
      </div>
    );
  }
  if (!categories) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Categories</h1>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Categories</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          GL accounts for the {categories.length} fixed asset categor{categories.length === 1 ? 'y' : 'ies'}.
          Match these labels to your QuickBooks chart of accounts so IIF imports resolve cleanly.
        </p>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                <th className="text-left px-3 py-2 font-semibold">Category</th>
                <th className="text-left px-3 py-2 font-semibold">Cost Account</th>
                <th className="text-left px-3 py-2 font-semibold">Accumulated Depr Account</th>
                <th className="text-left px-3 py-2 font-semibold">Depreciation Expense Account</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {categories.map(c => (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2 num">
                    {c.cost_account || <span className="text-red-500">— missing —</span>}
                  </td>
                  <td className="px-3 py-2 num">
                    {c.accum_account || <span className="text-red-500">— missing —</span>}
                  </td>
                  <td className="px-3 py-2 num">
                    {c.expense_account || <span className="text-red-500">— missing —</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => setEditTarget(c)}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 bg-gray-50 border-t border-gray-200 text-[11px] text-gray-500">
          Categories are fixed at these {categories.length}. Add/delete is not supported because
          downstream tools (Reconciliation, IIF) assume this exact set.
        </div>
      </div>

      {/* Edit modal */}
      {editTarget && (
        <CategoryEditModal
          category={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={(summary) => {
            showToast(summary);
            setEditTarget(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// Edit modal
// ============================================================

function CategoryEditModal({ category, onClose, onSaved }) {
  const [costAcct, setCostAcct]       = useState(category.cost_account || '');
  const [accumAcct, setAccumAcct]     = useState(category.accum_account || '');
  const [expenseAcct, setExpenseAcct] = useState(category.expense_account || '');
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState(null);

  async function handleSave() {
    setSaveError(null);
    if (!costAcct.trim() || !accumAcct.trim() || !expenseAcct.trim()) {
      setSaveError('All three GL account fields are required.');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from('categories')
        .update({
          cost_account:    costAcct.trim(),
          accum_account:   accumAcct.trim(),
          expense_account: expenseAcct.trim(),
        })
        .eq('id', category.id);
      if (error) throw error;
      onSaved(`${category.name} updated.`);
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      title={`Edit Category — ${category.name}`}
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
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded text-[12px] text-blue-800 leading-relaxed">
        Use the exact GL account label as it appears in your QuickBooks chart of accounts
        — typically <span className="font-mono">"{`{number}`} · {`{description}`}"</span>.
        The Reconciliation parser extracts just the leading number; QuickBooks IIF imports
        match on the full label.
      </div>

      <Field label="Cost Account" required hint="The asset register GL — e.g. 13300 · Furniture and Equipment">
        <input
          type="text"
          value={costAcct}
          onChange={e => setCostAcct(e.target.value)}
          placeholder="13300 · Furniture and Equipment"
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded num"
        />
      </Field>

      <div className="mt-3">
        <Field label="Accumulated Depreciation Account" required hint="Often shared across categories — e.g. 13400">
          <input
            type="text"
            value={accumAcct}
            onChange={e => setAccumAcct(e.target.value)}
            placeholder="13400 · Accumulated Depreciation"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded num"
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Depreciation Expense Account" required hint="P&L account hit by the monthly depreciation IIF">
          <input
            type="text"
            value={expenseAcct}
            onChange={e => setExpenseAcct(e.target.value)}
            placeholder="62400 · Depreciation Expense"
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded num"
          />
        </Field>
      </div>

      {saveError && (
        <div className="mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded text-[12.5px] text-red-700">
          <strong>Could not save:</strong> {saveError}
        </div>
      )}
    </Modal>
  );
}

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
