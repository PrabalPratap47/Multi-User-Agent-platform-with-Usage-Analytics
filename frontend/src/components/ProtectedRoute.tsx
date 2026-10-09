import React from 'react';
import { useAuthStore } from '../store/authStore.js';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: 'admin' | 'user';
}

export function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  const { isAuthenticated, user } = useAuthStore();

  if (!isAuthenticated || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <p className="text-xl text-gray-600 mb-4">Not authenticated</p>
          <a href="/login" className="text-blue-600 hover:text-blue-800">
            Go to login
          </a>
        </div>
      </div>
    );
  }

  if (requiredRole && user.role !== requiredRole) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <p className="text-xl text-gray-600 mb-4">Access denied</p>
          <p className="text-gray-500">You need {requiredRole} role to access this page</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
