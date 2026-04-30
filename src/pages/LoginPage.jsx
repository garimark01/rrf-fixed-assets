import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      // AuthProvider will detect the new session and re-render the app.
    } catch (err) {
      setError(err.message || 'Could not sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md bg-white border border-gray-200 rounded-lg shadow-sm p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-md bg-brand-900 text-white flex items-center justify-center font-bold text-base tracking-wider">
            FA
          </div>
          <div>
            <div className="text-lg font-semibold">Fixed Asset Manager</div>
            <div className="text-xs text-gray-500">Red Rock Foods, LLC</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-gray-600">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold text-gray-600">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          {error && (
            <div className="px-3 py-2 text-sm bg-red-50 text-red-700 border border-red-200 rounded">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
