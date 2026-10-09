import { useAsyncData } from '../hooks/useAsyncData.js';
import { usersService } from '../services/usersService.js';
import { EmptyState, ErrorState, LoadingState, SectionCard, ScrollableTable } from './analytics/AnalyticsPrimitives.js';

export function AdminUsersPanel() {
  const { data: users, loading, error, reload } = useAsyncData(() => usersService.listAll(), []);

  return (
    <SectionCard
      title="All users"
      description="Visible only to ADMIN accounts. The backend enforces this with a role check on GET /api/users, independent of this page even rendering."
    >
      {loading && <LoadingState label="Loading all users..." />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && users && users.length === 0 && <EmptyState message="No users found." />}
      {!loading && !error && users && users.length > 0 && (
        <ScrollableTable label="Users">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-gray-200 text-gray-600">
                <th scope="col" className="py-2 pr-4">ID</th>
                <th scope="col" className="py-2 pr-4">Email</th>
                <th scope="col" className="py-2 pr-4">Role</th>
                <th scope="col" className="py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 tabular-nums">{u.id}</td>
                  <td className="py-2 pr-4 break-all">{u.email}</td>
                  <td className="py-2 pr-4 uppercase text-xs font-semibold">{u.role}</td>
                  <td className="py-2 whitespace-nowrap">{new Date(u.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      )}
    </SectionCard>
  );
}
