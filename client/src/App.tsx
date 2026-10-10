import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Login from '@/pages/login';
import OverviewPage from '@/pages/overview';
import ControllersPage from '@/pages/controllers';
import AnalyticsPage from '@/pages/analytics';
import SettingsPage from '@/pages/settings';
import DeviceHistoryPage from '@/pages/device-history';
import CropCyclePage from '@/pages/crop-cycle';
import { AppShell } from '@/components/layout/app-shell';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';
import { ApiError } from '@/lib/api';
import { AiAssistant } from '@/components/ai-assistant';

// Any 401 from the API (expired/invalid token) dispatches a global event so
// the AuthProvider can drop the stale token and bounce back to the login
// screen, instead of every screen showing a silent failed-request state.
function handleAuthError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    // Wrong password on the login form also returns 401 — don't wipe session.
    if (error.url.includes("/auth/login")) return;
    window.dispatchEvent(new Event("mushking:unauthorized"));
  }
}

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: handleAuthError,
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 401) {
          handleAuthError(error);
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={OverviewPage} />
        <Route path="/dashboard" component={OverviewPage} />
        <Route path="/controllers" component={ControllersPage} />
        <Route path="/crop-cycle" component={CropCyclePage} />
        <Route path="/analytics" component={AnalyticsPage} />
        <Route path="/device-history" component={DeviceHistoryPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function Gate() {
  const { token } = useAuth();
  return token ? <Router /> : <Login />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <Gate />
            </WouterRouter>
            <AiAssistant />
            <Toaster />
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
