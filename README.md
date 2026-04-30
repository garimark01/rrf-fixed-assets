# RRF Fixed Asset Manager

Web-based fixed asset management for Red Rock Foods, LLC. Built directly off
the RHLC Fixed Asset Manager pattern (JSX + Tailwind + Supabase) with
RRF-specific adaptations:

| | RHLC | RRF |
|---|---|---|
| Entities | 31+ Marco's Pizza stores | Single entity |
| Fiscal calendar | 13 four-week periods | 12 calendar months |
| Store dimension | required | optional Location |
| Accounting system | Sage Intacct | QuickBooks |
| JE output format | Sage FAJ CSV | QuickBooks IIF (1 DR + 1 CR) |
| Asset categories | 9 | 2 (Furniture & Equipment, Lease Hold Improvement) |

## Stack

- React 18 + Vite + JSX (no TypeScript)
- Tailwind CSS for styling
- Supabase for auth + Postgres
- Papaparse for CSV (kept available for future Excel import / report exports)
- xlsx-js-style for upcoming Reports page exports

## Setup

```bash
npm install
cp .env.example .env.local
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

## Project structure

```
src/
  App.jsx                       # routes + auth gate + providers
  main.jsx                      # entry
  index.css                     # Tailwind + .num utility class

  components/
    Toast.jsx                   # ToastProvider + useToast
    Modal.jsx                   # generic modal wrapper
    PlaceholderPage.jsx         # placeholder for not-yet-built pages
    AssetModal.jsx              # add/edit asset (anchor-aware)
    layout/
      AppShell.jsx              # header + sidebar + Outlet

  hooks/
    useAuth.jsx                 # Supabase auth context
    useAppData.js               # categories, locations, fiscal periods, settings

  lib/
    supabase.js                 # client + fetchAll paginator
    calculations.js             # depreciation math (RRF-flavored)

  pages/
    LoginPage.jsx
    DashboardPage.jsx           # snapshot KPIs + lifecycle counts + breakdowns
    AssetRegisterPage.jsx       # 4 tab views, filters, status badges
    DepreciationPage.jsx        # 3-step wizard + Run History
```

## Build status

- ✅ Foundation (Tailwind, Supabase, auth, hooks, calc module)
- ✅ Dashboard
- ✅ Asset Register + Asset Modal
- ✅ Depreciation Engine (3-step wizard + Run History)
- 🔲 Disposals, Reconciliation, Import, Reports, Data Health
- 🔲 Locations admin, Categories admin, Fiscal Calendar admin

The placeholder pages exist for everything else and toast "coming soon"
when their nav links are clicked.
