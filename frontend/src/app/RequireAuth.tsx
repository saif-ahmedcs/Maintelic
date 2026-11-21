import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ErrorState } from '../design/ErrorState';
import { Skeleton } from '../design/Skeleton';
import { Surface } from '../design/Surface';
import { restoreSession, useSession } from '../lib/auth/session';

export interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { status, user } = useSession();
  const location = useLocation();

  if (status === 'restoring') {
    return (
      <div className="flex min-h-screen items-center justify-center p-9">
        <Surface className="w-full max-w-sm">
          <Skeleton lines={4} height={16} />
        </Surface>
      </div>
    );
  }

  if (status === 'unreachable') {
    return (
      <div className="flex min-h-screen items-center justify-center p-9">
        <Surface className="w-full max-w-sm">
          <ErrorState
            error="We couldn't reach the server to confirm your session. You haven't been signed out — check your connection and try again."
            onRetry={() => void restoreSession()}
          />
        </Surface>
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (user?.mustChangePassword && location.pathname !== '/account') {
    return <Navigate to="/account" replace />;
  }

  return <>{children}</>;
}
