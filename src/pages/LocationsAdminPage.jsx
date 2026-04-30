/**
 * Locations Admin Page
 *
 * Full CRUD-ish for physical locations (e.g. Line 1, Line 2, Warehouse).
 * Locations are optional on every asset — if no locations are defined, the
 * Asset Register's "By Location" tab is hidden and the asset modal's
 * Location field is disabled.
 *
 * Operations:
 *   - Create new location (name + sort_order)
 *   - Edit existing (name + sort_order)
 *   - Toggle active/inactive (soft delete; preserves history on assets
 *     that already reference the location)
 *
 * No hard delete — flipping is_active off is enough to hide a location
 * from new asset assignments while keeping any historical references intact.
 *
 * Sort order: drives display order in the AssetModal dropdown and the
 * Asset Register's "By Location" tab. Lower numbers come first.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../components/Toast';
import { fmtInt } from '../lib/calculations';
import Modal from '../components/Modal';

export default function LocationsAdminPage() {
  const showToast = useToast();
  const [locations, setLocations]   = useState(null);
  const [usageCount, setUsageCount] = useState({}); // location_id → asset count
  const [error, setError]           = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  const [modal, setModal]           = useState(null); // { mode: 'add' | 'edit', target?: location }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [locsRes, usageRes] = await Promise.all([
        supabase.from('locations').select('*').order('sort_order', { nullsFirst: false }).order('name'),
        // Asset count per location — informational, helps you see what's in use
        supabase.from('assets').select('location_id'),
      ]);
      if (locsRes.error)  throw locsRes.error;
      if (usageRes.error) throw usageRes.error;

      const counts = {};
      for (const a of usageRes.data || []) {
        if (a.location_id) counts[a.location_id] = (counts[a.location_id] || 0) + 1;
      }
      setLocations(locsRes.data || []);
      setUsageCount(counts);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visibleLocations = useMemo(() => {
    if (!locations) return null;
    return showInactive ? locations : locations.filter(l => l.is_active);
  }, [locations, showInactive]);

  async function toggleActive(location) {
    const newActive = !location.is_active;
    const verb = newActive ? 'Activate' : 'Deactivate';

    // If deactivating and assets are referencing it, ask for confirmation.
    const refs = usageCount[location.id] || 0;
    if (!newActive && refs > 0) {
      const ok = window.confirm(
        `Deactivate "${location.name}"?\n\n` +
        `${refs} asset${refs !== 1 ? 's' : ''} currently reference this location. ` +
        `Existing references stay intact, but the location will no longer be available ` +
        `to assign to new or edited assets. Continue?`
      );
      if (!ok) return;
    }

    try {
      const { error } = await supabase
        .from('locations')
        .update({ is_active: newActive })
        .eq('id', location.id);
      if (error) throw error;
      showToast(`${verb}d: ${location.name}`);
      load();
    } catch (e) {
      showToast(`${verb} failed: ${e.message || String(e)}`, 'error');
    }
  }

  if (error) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Locations</h1>
        <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          <strong>Could not load locations:</strong> {error}
        </div>
      </div>
    );
  }
  if (!visibleLocations) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-3">Locations</h1>
        <div className="text-sm text-gray-400 p-4">Loading…</div>
      </div>
    );
  }

  const totalAll = locations.length;
  const totalActive = locations.filter(l => l.is_active).length;
  const totalInactive = totalAll - totalActive;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">Locations</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Optional physical locations (e.g. Line 1, Line 2, Warehouse, Office).
            Active locations appear in the Asset Modal and the Register's "By Location" tab.
          </p>
        </div>
        <button
          onClick={() => setModal({ mode: 'add' })}
          className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Add Location
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <span className="text-xs text-gray-400 ml-auto">
          {fmtInt(totalActive)} active
          {totalInactive > 0 && <> · {fmtInt(totalInactive)} inactive</>}
        </span>
      </div>

      {/* Empty state */}
      {visibleLocations.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-md shadow-sm p-8 text-center">
          {totalAll === 0 ? (
            <>
              <div className="text-sm text-gray-500 mb-2">No locations defined yet.</div>
              <button
                onClick={() => setModal({ mode: 'add' })}
                className="text-xs font-medium text-blue-600 hover:text-blue-800"
              >
                Add the first location →
              </button>
              <div className="text-[11px] text-gray-400 mt-2">
                Locations are optional — you can also leave them empty and skip the "By Location" view entirely.
              </div>
            </>
          ) : (
            <div className="text-sm text-gray-400">
              All locations are inactive. Toggle "Show inactive" above to see them.
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-md shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-[10px] uppercase text-gray-500">
                  <th className="text-left px-3 py-2 font-semibold">Name</th>
                  <th className="text-center px-3 py-2 font-semibold">Sort</th>
                  <th className="text-center px-3 py-2 font-semibold">Assets</th>
                  <th className="text-left px-3 py-2 font-semibold">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleLocations.map(loc => (
                  <tr key={loc.id} className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${loc.is_active ? '' : 'opacity-60'}`}>
                    <td className="px-3 py-2 font-medium">{loc.name}</td>
                    <td className="px-3 py-2 text-center num text-gray-500">
                      {loc.sort_order ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-center num">
                      {fmtInt(usageCount[loc.id] || 0)}
                    </td>
                    <td className="px-3 py-2">
                      {loc.is_active ? (
                        <span className="text-xs font-medium text-green-600">Active</span>
                      ) : (
                        <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded bg-gray-100 text-gray-600 uppercase tracking-wider">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => setModal({ mode: 'edit', target: loc })}
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggleActive(loc)}
                        className={`text-xs font-medium ml-3 ${
                          loc.is_active
                            ? 'text-red-500 hover:text-red-700'
                            : 'text-green-600 hover:text-green-800'
                        }`}
                      >
                        {loc.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {modal && (
        <LocationEditModal
          mode={modal.mode}
          location={modal.target}
          existingLocations={locations}
          onClose={() => setModal(null)}
          onSaved={(summary) => {
            showToast(summary);
            setModal(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// Add / Edit modal
// ============================================================

function LocationEditModal({ mode, location, existingLocations, onClose, onSaved }) {
  const isEdit = mode === 'edit';
  const [name, setName]               = useState(location?.name ?? '');
  const [sortOrderStr, setSortOrderStr] = useState(
    location?.sort_order != null ? String(location.sort_order) : ''
  );
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState(null);

  async function handleSave() {
    setSaveError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setSaveError('Name is required.');
      return;
    }

    // Uniqueness check (case-insensitive). Excludes self in edit mode.
    const dup = (existingLocations || []).some(l =>
      l.name.toLowerCase() === trimmed.toLowerCase()
      && (!isEdit || l.id !== location.id)
    );
    if (dup) {
      setSaveError(`A location named "${trimmed}" already exists.`);
      return;
    }

    let sortOrder = null;
    if (sortOrderStr.trim() !== '') {
      const n = parseInt(sortOrderStr, 10);
      if (isNaN(n)) {
        setSaveError('Sort order must be a whole number, or leave it blank.');
        return;
      }
      sortOrder = n;
    }

    setSaving(true);
    try {
      if (isEdit) {
        const { error } = await supabase
          .from('locations')
          .update({ name: trimmed, sort_order: sortOrder })
          .eq('id', location.id);
        if (error) throw error;
        onSaved(`Location updated: ${trimmed}`);
      } else {
        const { error } = await supabase
          .from('locations')
          .insert([{ name: trimmed, sort_order: sortOrder, is_active: true }]);
        if (error) throw error;
        onSaved(`Location added: ${trimmed}`);
      }
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const title = isEdit ? `Edit Location — ${location.name}` : 'Add Location';

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      title={title}
      width={500}
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
            {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Location')}
          </button>
        </>
      }
    >
      <Field label="Name" required>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Line 1, Warehouse, Office"
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded"
          autoFocus
        />
      </Field>

      <div className="mt-3">
        <Field label="Sort Order" hint="Optional — lower numbers display first; blank = end of list">
          <input
            type="number"
            step={1}
            value={sortOrderStr}
            onChange={e => setSortOrderStr(e.target.value)}
            placeholder="e.g. 10"
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
