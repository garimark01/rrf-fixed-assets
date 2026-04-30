import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ToastProvider } from './components/Toast';
import AppShell from './components/layout/AppShell';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import AssetRegisterPage from './pages/AssetRegisterPage';
import DepreciationPage from './pages/DepreciationPage';
import DisposalsPage from './pages/DisposalsPage';
import ReconciliationPage from './pages/ReconciliationPage';
import LocationsAdminPage from './pages/LocationsAdminPage';
import CategoriesAdminPage from './pages/CategoriesAdminPage';
import ReportsPage from './pages/ReportsPage';
import PlaceholderPage from './components/PlaceholderPage';

function ProtectedRoutes() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-400">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/assets" element={<AssetRegisterPage />} />
        <Route path="/depreciation" element={<DepreciationPage />} />

        <Route
          path="/disposals"
          element={<DisposalsPage />}
        />
        <Route
          path="/reconciliation"
          element={<ReconciliationPage />}
        />
        <Route
          path="/import"
          element={<PlaceholderPage title="Excel Import" buildOrder="TBD" description="Bulk add assets via CSV/XLSX upload. Preview with validation errors before committing." />}
        />
        <Route
          path="/reports"
          element={<ReportsPage />}
        />
        <Route
          path="/admin/locations"
          element={<LocationsAdminPage />}
        />
        <Route
          path="/admin/categories"
          element={<CategoriesAdminPage />}
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ProtectedRoutes />
      </ToastProvider>
    </AuthProvider>
  );
}
