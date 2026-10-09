import { useState } from 'react';
import { useAuthStore } from '../store/authStore.js';
import { useAuth } from '../hooks/useAuth.js';
import { Navbar } from './Navbar.js';
import { MyUsageLogs } from './MyUsageLogs.js';
import { AdminUsersPanel } from './AdminUsersPanel.js';
import { AgentRunsPanel } from './AgentRunsPanel.js';
import { ProtectedRoute } from './ProtectedRoute.js';
import { OverviewSection } from './analytics/OverviewSection.js';
import { AgentUsageSection } from './analytics/AgentUsageSection.js';
import { TokenConsumptionSection } from './analytics/TokenConsumptionSection.js';
import { PerformanceSection } from './analytics/PerformanceSection.js';
import { CvClassificationSection } from './analytics/CvClassificationSection.js';
import { ExternalAgentLogsTab } from './analytics/ExternalAgentLogsTab.js';
import { CvProcessingTab } from './cv/CvProcessingTab.js';
import { SentimentTab } from './sentiment/SentimentTab.js';

export function Dashboard() {
  const { user } = useAuthStore();
  const { logout } = useAuth();
  const [activeTab, setActiveTab] = useState('analytics');

  const isAdmin = user?.role === 'admin';
  const tabs = isAdmin
    ? ['analytics', 'my-records', 'agent-runs', 'cv-processing', 'sentiment', 'external-logs', 'admin-users']
    : ['analytics', 'my-records', 'agent-runs', 'cv-processing', 'sentiment', 'external-logs'];

  const handleLogout = async () => {
    await logout();
    window.location.href = '/';
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <Navbar onLogout={handleLogout} />

      <main className="max-w-7xl mx-auto px-4 py-6 sm:py-8">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-800">Dashboard</h1>
          <p className="text-gray-600 mt-2 break-words">
            Welcome, {user?.email} ({user?.role})
            {isAdmin && ' — viewing data across all users'}
          </p>
        </div>

        {/* Tabs */}
        <nav aria-label="Dashboard sections" className="flex flex-wrap gap-x-1 sm:gap-x-4 gap-y-1 mb-6 border-b border-gray-300">
          {tabs.map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              aria-current={activeTab === tab ? 'page' : undefined}
              className={`px-3 sm:px-4 py-2 text-sm sm:text-base font-medium border-b-2 whitespace-nowrap ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-600 hover:text-gray-800'
              }`}
            >
              {tab.replace('-', ' ').toUpperCase()}
            </button>
          ))}
        </nav>

        {/* Tab Content */}
        {activeTab === 'analytics' && (
          <div className="space-y-6">
            <OverviewSection />
            <AgentUsageSection />
            <TokenConsumptionSection isAdmin={isAdmin} />
            <PerformanceSection />
            <CvClassificationSection />
          </div>
        )}
        {activeTab === 'my-records' && <MyUsageLogs isAdmin={isAdmin} />}
        {activeTab === 'agent-runs' && <AgentRunsPanel isAdmin={isAdmin} />}
        {activeTab === 'cv-processing' && <CvProcessingTab />}
        {activeTab === 'sentiment' && <SentimentTab />}
        {activeTab === 'external-logs' && <ExternalAgentLogsTab />}
        {activeTab === 'admin-users' && (
          <ProtectedRoute requiredRole="admin">
            <AdminUsersPanel />
          </ProtectedRoute>
        )}
      </main>
    </div>
  );
}
