export default function OrdersLoading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading your orders…</span>
      <div className="skeleton skeleton-title" />
      {Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton skeleton-row" aria-hidden="true" />)}
    </div>
  );
}
