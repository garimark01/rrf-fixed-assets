export default function PlaceholderPage({ title, description, buildOrder }) {
  return (
    <div>
      <h1 className="text-lg font-semibold mb-4">{title}</h1>
      <div className="bg-white border border-gray-200 rounded-md shadow-sm p-6 max-w-2xl">
        <div className="text-base font-semibold mb-2">Coming soon</div>
        {description && (
          <p className="text-sm text-gray-500 mb-3 leading-relaxed">{description}</p>
        )}
        {buildOrder !== undefined && (
          <div className="inline-block px-2 py-0.5 text-2xs font-mono uppercase tracking-wide rounded bg-gray-100 text-gray-500 border border-gray-200">
            Build order: {buildOrder}
          </div>
        )}
      </div>
    </div>
  );
}
