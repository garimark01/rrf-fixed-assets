import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: '📊', label: 'Dashboard' },
    ],
  },
  {
    label: 'Assets',
    items: [
      { to: '/assets', icon: '📋', label: 'Asset Register' },
      { to: '/import', icon: '📥', label: 'Excel Import' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/depreciation', icon: '⚙️', label: 'Depreciation Engine' },
      { to: '/disposals',    icon: '🗑️', label: 'Disposals' },
      { to: '/reconciliation', icon: '✅', label: 'Reconciliation' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { to: '/reports', icon: '📄', label: 'Reports' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/admin/locations', icon: '📍', label: 'Locations' },
      { to: '/admin/categories', icon: '🏷️', label: 'Categories' },
    ],
  },
];

function NavItem({ to, icon, label }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-2 rounded text-[12.5px] font-medium transition-colors
        ${isActive
          ? 'bg-blue-600 text-white'
          : 'text-brand-300 hover:bg-brand-700 hover:text-brand-200'
        }`
      }
    >
      <span className="w-4 text-center text-sm">{icon}</span>
      {label}
    </NavLink>
  );
}

export default function AppShell() {
  const { user, signOut } = useAuth();

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="bg-brand-900 text-brand-100 px-6 h-12 flex items-center justify-between flex-shrink-0 border-b border-brand-800">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded bg-blue-600 text-white text-xs font-bold">
            FA
          </span>
          <h1 className="text-[15px] font-semibold tracking-tight">
            RRF Fixed Asset Manager
          </h1>
          <span className="text-[11px] text-brand-500 ml-1">v0.3</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-brand-400">
            Red Rock Foods, LLC
          </span>
          {user?.email && (
            <span className="text-[11px] text-brand-400 hidden md:inline">
              · {user.email}
            </span>
          )}
          <button
            onClick={signOut}
            className="text-[11px] text-brand-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-brand-700"
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className="w-52 bg-brand-800 flex-shrink-0 overflow-y-auto py-2 px-2">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-brand-500 px-3 pt-4 pb-1">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavItem key={item.to} {...item} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Main content area */}
        <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
