import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from './RequireAuth';
import { restoreSession, useSession } from '../lib/auth/session';

vi.mock('../lib/auth/session', () => ({
  useSession: vi.fn(),
  restoreSession: vi.fn(),
}));

const mockedUseSession = vi.mocked(useSession);
const mockedRestoreSession = vi.mocked(restoreSession);

afterEach(cleanup);

function LoginProbe() {
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from;
  return <div>login screen{from ? `, from ${from.pathname}` : ''}</div>;
}

function renderProtected(initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireAuth>
              <div>secret content</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  it('shows a loading skeleton, not the protected content or the login screen, while restoring', () => {
    mockedUseSession.mockReturnValue({ status: 'restoring', user: null });

    renderProtected();

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.queryByText(/login screen/)).not.toBeInTheDocument();
  });

  it('shows a retry affordance, not the login redirect, when the backend is unreachable (P1-1)', () => {
    mockedUseSession.mockReturnValue({ status: 'unreachable', user: null });
    mockedRestoreSession.mockResolvedValue(undefined);

    renderProtected();

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.queryByText(/login screen/)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockedRestoreSession).toHaveBeenCalledTimes(1);
  });

  it('redirects to /login and remembers the intended path when signed out', () => {
    mockedUseSession.mockReturnValue({
      status: 'unauthenticated',
      user: null,
    });

    renderProtected('/protected');

    expect(
      screen.getByText('login screen, from /protected'),
    ).toBeInTheDocument();
  });

  it('renders the protected content once authenticated', () => {
    mockedUseSession.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', email: 'admin@plant.example', roles: ['ADMIN'] },
    });

    renderProtected();

    expect(screen.getByText('secret content')).toBeInTheDocument();
  });
});

function renderAtPath(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireAuth>
              <div>secret content</div>
            </RequireAuth>
          }
        />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <div>account screen</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth — forced password-change redirect (Phase 22)', () => {
  it('redirects away from any other route to /account when mustChangePassword is true', () => {
    mockedUseSession.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'admin@plant.example',
        roles: ['ADMIN'],
        mustChangePassword: true,
      },
    });

    renderAtPath('/protected');

    expect(screen.getByText('account screen')).toBeInTheDocument();
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('lets the user stay on /account itself instead of redirect-looping', () => {
    mockedUseSession.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'admin@plant.example',
        roles: ['ADMIN'],
        mustChangePassword: true,
      },
    });

    renderAtPath('/account');

    expect(screen.getByText('account screen')).toBeInTheDocument();
  });

  it('does not redirect once mustChangePassword is false', () => {
    mockedUseSession.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'admin@plant.example',
        roles: ['ADMIN'],
        mustChangePassword: false,
      },
    });

    renderAtPath('/protected');

    expect(screen.getByText('secret content')).toBeInTheDocument();
  });
});
