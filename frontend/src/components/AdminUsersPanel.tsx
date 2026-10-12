import { useId, useRef, useState, type FormEvent } from 'react';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { useAuthStore } from '../store/authStore.js';
import { usersService } from '../services/usersService.js';
import { analyticsService } from '../services/analyticsService.js';
import { apiErrorMessage } from '../utils/apiError.js';
import type { CreateUserRequest, Role, UserSummary } from '../types/index.js';
import { UserTokenUsageChart } from './charts/UserTokenUsageChart.js';
import { EmptyState, ErrorState, LoadingState, SectionCard, ScrollableTable } from './analytics/AnalyticsPrimitives.js';

type FieldErrors = Partial<Record<keyof CreateUserRequest, string>>;

const inputClass = 'mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

/** Same rules as the backend (CreateUserSchema), for earlier feedback; the server re-checks everything. */
function validate(form: CreateUserRequest): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = 'Full name is required';
  if (!form.email.trim()) errors.email = 'Email address is required';
  else if (!/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(form.email.trim())) errors.email = 'Enter a valid email address';
  if (!form.password) errors.password = 'Password is required';
  else if (form.password.length < 8) errors.password = 'Password must be at least 8 characters';
  else if (!/[A-Za-z]/.test(form.password) || !/[0-9]/.test(form.password)) errors.password = 'Password must contain at least one letter and one number';
  return errors;
}

/** Field errors the API returned for a 400 validation error, if any. */
function serverFieldErrors(err: unknown): FieldErrors {
  const fields = (err as { response?: { data?: { details?: { fields?: Array<{ field: string; message: string }> } } } }).response?.data?.details?.fields;
  const out: FieldErrors = {};
  for (const f of fields ?? []) if (['name', 'email', 'password', 'role'].includes(f.field)) out[f.field as keyof CreateUserRequest] ??= f.message;
  return out;
}

function CreateUserDialog({ onCreated }: { onCreated: (user: UserSummary) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const empty: CreateUserRequest = { name: '', email: '', password: '', role: 'user' };
  const [form, setForm] = useState<CreateUserRequest>(empty);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (field: keyof CreateUserRequest) => (value: string) => setForm(f => ({ ...f, [field]: value }));

  const open = () => {
    setForm(empty);
    setErrors({});
    setFormError(null);
    dialog.current?.showModal();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const found = validate(form);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return; // values are kept so they can be corrected
    setSaving(true);
    try {
      const user = await usersService.create({ ...form, name: form.name.trim(), email: form.email.trim() });
      dialog.current?.close();
      onCreated(user);
    } catch (err) {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) {
        const message = apiErrorMessage(err, 'The account could not be created.');
        if (/already exists/.test(message)) setErrors({ email: message });
        else setFormError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const field = (name: keyof CreateUserRequest, label: string, input: JSX.Element) => (
    <div>
      <label htmlFor={`${titleId}-${name}`} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      {input}
      {errors[name] && (
        <p id={`${titleId}-${name}-error`} className="mt-1 text-sm text-red-700">
          {errors[name]}
        </p>
      )}
    </div>
  );
  const described = (name: keyof CreateUserRequest) => ({
    id: `${titleId}-${name}`,
    'aria-invalid': !!errors[name],
    'aria-describedby': errors[name] ? `${titleId}-${name}-error` : undefined,
  });

  return (
    <>
      <button type="button" onClick={open} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
        Create User
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={e => {
          if (saving) e.preventDefault();
        }}
        className="w-[calc(100%-2rem)] max-w-md rounded-lg p-0 shadow-xl backdrop:bg-gray-900/50"
      >
        <form onSubmit={submit} noValidate className="space-y-3 p-5">
          <h4 id={titleId} className="text-lg font-semibold text-gray-900">
            Create a user account
          </h4>
          {field('name', 'Full name', <input {...described('name')} type="text" autoComplete="off" value={form.name} onChange={e => set('name')(e.target.value)} className={inputClass} />)}
          {field('email', 'Email address', <input {...described('email')} type="email" autoComplete="off" value={form.email} onChange={e => set('email')(e.target.value)} className={inputClass} />)}
          {field(
            'password',
            'Password (at least 8 characters, with a letter and a number)',
            <input {...described('password')} type="password" autoComplete="new-password" value={form.password} onChange={e => set('password')(e.target.value)} className={inputClass} />
          )}
          {field(
            'role',
            'Role',
            <select {...described('role')} value={form.role} onChange={e => set('role')(e.target.value as Role)} className={`${inputClass} bg-white`}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          )}
          {formError && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              disabled={saving}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Creating...' : 'Create user'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function ChangePasswordButton({ user, isSelf, onChanged }: { user: UserSummary; isSelf: boolean; onChanged: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const who = user.name ? `${user.name} (${user.email})` : user.email;

  const open = () => {
    setPassword('');
    setConfirm('');
    setErrors({});
    setFormError(null);
    dialog.current?.showModal();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    // Same password rule as account creation; the server re-checks it.
    const found = {
      password: validate({ name: 'x', email: 'x@x.x', password, role: 'user' }).password,
      confirm: confirm !== password ? 'The passwords do not match' : undefined,
    };
    setErrors(found);
    setFormError(null);
    if (found.password || found.confirm) return;
    setSaving(true);
    try {
      const { sessionsSignedOut } = await usersService.changePassword(user.id, password);
      dialog.current?.close();
      onChanged(
        isSelf
          ? 'Your password was changed. Your other sessions were signed out; this one stays logged in.'
          : `Password changed for ${user.email}. ${sessionsSignedOut === 1 ? '1 active session was' : `${sessionsSignedOut} active sessions were`} signed out.`
      );
    } catch (err) {
      const fields = serverFieldErrors(err);
      if (fields.password) setErrors({ password: fields.password });
      else setFormError(apiErrorMessage(err, 'The password could not be changed. Nothing was changed.'));
    } finally {
      setSaving(false);
    }
  };

  const fieldProps = (name: 'password' | 'confirm') => ({
    id: `${titleId}-${name}`,
    type: 'password',
    autoComplete: 'new-password',
    'aria-invalid': !!errors[name],
    'aria-describedby': errors[name] ? `${titleId}-${name}-error` : undefined,
    className: inputClass,
  });
  const fieldError = (name: 'password' | 'confirm') =>
    errors[name] && (
      <p id={`${titleId}-${name}-error`} className="mt-1 text-sm text-red-700">
        {errors[name]}
      </p>
    );

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label={`Change password for ${who}`}
        className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        Change password
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={e => {
          if (saving) e.preventDefault();
        }}
        className="w-[calc(100%-2rem)] max-w-md rounded-lg p-0 shadow-xl backdrop:bg-gray-900/50"
      >
        <form onSubmit={submit} noValidate className="space-y-3 p-5 text-left">
          <h4 id={titleId} className="text-lg font-semibold text-gray-900">
            Change password
          </h4>
          <p className="text-sm text-gray-700">
            New password for <strong className="break-all">{who}</strong>.{' '}
            {isSelf ? 'Your other sessions will be signed out.' : 'They will be signed out of every active session and must log in with the new password.'}
          </p>
          <div>
            <label htmlFor={`${titleId}-password`} className="block text-sm font-medium text-gray-700">
              New password (at least 8 characters, with a letter and a number)
            </label>
            <input {...fieldProps('password')} value={password} onChange={e => setPassword(e.target.value)} />
            {fieldError('password')}
          </div>
          <div>
            <label htmlFor={`${titleId}-confirm`} className="block text-sm font-medium text-gray-700">
              Confirm new password
            </label>
            <input {...fieldProps('confirm')} value={confirm} onChange={e => setConfirm(e.target.value)} />
            {fieldError('confirm')}
          </div>
          {formError && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              disabled={saving}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : 'Change password'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function DeleteUserButton({ user, onDeleted }: { user: UserSummary; onDeleted: (user: UserSummary) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = user.name ? `${user.name} (${user.email})` : user.email;

  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const updated = await usersService.remove(user.id);
      dialog.current?.close();
      onDeleted(updated);
    } catch (err) {
      setError(apiErrorMessage(err, 'The account could not be deleted. Nothing was changed.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          dialog.current?.showModal();
        }}
        aria-label={`Delete user ${who}`}
        className="rounded-md border border-red-200 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
      >
        Delete user
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={e => {
          if (deleting) e.preventDefault();
        }}
        className="w-[calc(100%-2rem)] max-w-md rounded-lg p-0 shadow-xl backdrop:bg-gray-900/50"
      >
        <div className="space-y-3 p-5">
          <h4 id={titleId} className="text-lg font-semibold text-gray-900">
            Delete this user?
          </h4>
          <p className="text-sm text-gray-700">
            <strong className="break-all">{who}</strong> will no longer be able to log in, and any active sessions end immediately.
          </p>
          <p className="text-sm text-gray-600">
            Their CVs, results and usage history are kept for analytics. The account is shown as deactivated and its email cannot be reused.
          </p>
          {error && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              disabled={deleting}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete user'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

export function AdminUsersPanel() {
  const currentUserId = useAuthStore(state => state.user?.id);
  const [version, setVersion] = useState(0);
  const { data: users, loading, error, reload } = useAsyncData(() => usersService.listAll(), [version]);
  // Admin-only endpoint (requireAdmin on the backend); totals are computed server-side.
  const usage = useAsyncData(() => analyticsService.getByUser(), [version]);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (message: string) => {
    setNotice(message);
    setVersion(v => v + 1);
  };

  return (
    <div className="space-y-6">
      <SectionCard title="Token usage per user" description="Total tokens (input + output) recorded for each active user's AI calls.">
        {(usage.loading || loading) && !(usage.data && users) && <LoadingState label="Loading token usage..." />}
        {usage.error && <ErrorState message={usage.error} onRetry={usage.reload} />}
        {usage.data && users && users.length > 0 && <UserTokenUsageChart users={users} usage={usage.data} />}
      </SectionCard>

      <SectionCard
        title="All users"
        description="Visible only to ADMIN accounts. The backend enforces this with a role check on every /api/users request, independent of this page even rendering."
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <CreateUserDialog onCreated={user => refresh(`Created ${user.role === 'admin' ? 'admin' : 'user'} account ${user.email}.`)} />
          {notice && (
            <p role="status" className="rounded border border-green-200 bg-green-50 px-3 py-1.5 text-sm text-green-800">
              {notice}
            </p>
          )}
        </div>
        {loading && !users && <LoadingState label="Loading all users..." />}
        {!loading && error && <ErrorState message={error} onRetry={reload} />}
        {users && users.length === 0 && <EmptyState message="No users found." />}
        {users && users.length > 0 && (
          <ScrollableTable label="Users">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-200 text-gray-600">
                  <th scope="col" className="py-2 pr-4">ID</th>
                  <th scope="col" className="py-2 pr-4">Name</th>
                  <th scope="col" className="py-2 pr-4">Email</th>
                  <th scope="col" className="py-2 pr-4">Role</th>
                  <th scope="col" className="py-2 pr-4">Status</th>
                  <th scope="col" className="py-2 pr-4">Created</th>
                  {/* `relative`: keeps the absolutely positioned sr-only text inside the table's scroll box. */}
                  <th scope="col" className="relative py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={`border-b border-gray-100 ${u.status === 'deactivated' ? 'text-gray-600' : ''}`}>
                    <td className="py-2 pr-4 tabular-nums">{u.id}</td>
                    <td className="py-2 pr-4 break-words">{u.name ?? '—'}</td>
                    <td className="py-2 pr-4 break-all">{u.email}</td>
                    <td className="py-2 pr-4 uppercase text-xs font-semibold">{u.role}</td>
                    <td className="py-2 pr-4">
                      {u.status === 'deactivated' ? (
                        <span className="rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">Deactivated</span>
                      ) : (
                        <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">Active</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{new Date(u.createdAt).toLocaleString()}</td>
                    <td className="py-2 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {u.status === 'active' && <ChangePasswordButton user={u} isSelf={u.id === currentUserId} onChanged={refresh} />}
                        {u.status === 'active' && u.id !== currentUserId && (
                          <DeleteUserButton user={u} onDeleted={deleted => refresh(`Deleted ${deleted.email}: the account is deactivated and can no longer log in.`)} />
                        )}
                        {u.id === currentUserId && <span className="text-xs text-gray-600">You</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        )}
      </SectionCard>
    </div>
  );
}
