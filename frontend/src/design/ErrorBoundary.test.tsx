import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { ApiError } from '../lib/api/errors';
import { reportError } from '../lib/observability/errorReporter';

vi.mock('../lib/observability/errorReporter', () => ({
  reportError: vi.fn(),
}));

const mockedReportError = vi.mocked(reportError);

function Boom({ error }: { error: Error }): never {
  throw error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary (17.5)', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>safe content</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('safe content')).toBeInTheDocument();
  });

  it('shows a generic fallback for a plain thrown error, not the message or stack', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom error={new Error('exploded in render')} />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText('Something went wrong loading this.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('exploded in render')).not.toBeInTheDocument();
  });

  it('uses a custom fallbackMessage for non-API errors', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary fallbackMessage="This tile could not load.">
        <Boom error={new Error('boom')} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('This tile could not load.')).toBeInTheDocument();
  });

  it("shows an ApiError's own message and request ID instead of the fallback", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const apiError = new ApiError({
      status: 500,
      message: 'Database unavailable',
      requestId: 'req_789',
      path: '/work-orders',
    });

    render(
      <ErrorBoundary fallbackMessage="This tile could not load.">
        <Boom error={apiError} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Database unavailable')).toBeInTheDocument();
    expect(screen.getByText('Request ID: req_789')).toBeInTheDocument();
  });

  it('retries by re-rendering the same children, recovering once they stop throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();

    let shouldThrow = true;
    function Throws() {
      if (shouldThrow) {
        throw new Error('first render fails');
      }
      return <p>recovered content</p>;
    }

    render(
      <ErrorBoundary>
        <Throws />
      </ErrorBoundary>,
    );
    expect(
      screen.getByText('Something went wrong loading this.'),
    ).toBeInTheDocument();

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.getByText('recovered content')).toBeInTheDocument();
    expect(
      screen.queryByText('Something went wrong loading this.'),
    ).not.toBeInTheDocument();
  });

  describe('error reporting (27.1, 27.2)', () => {
    it('reports the caught error to the observability reporter', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('exploded in render');

      render(
        <ErrorBoundary>
          <Boom error={error} />
        </ErrorBoundary>,
      );

      expect(mockedReportError).toHaveBeenCalledTimes(1);
      expect(mockedReportError).toHaveBeenCalledWith(error);
    });

    it('reports the original ApiError instance, not a stringified copy, so the reporter can read its requestId', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const apiError = new ApiError({
        status: 500,
        message: 'Database unavailable',
        requestId: 'req_789',
        path: '/work-orders',
      });

      render(
        <ErrorBoundary>
          <Boom error={apiError} />
        </ErrorBoundary>,
      );

      expect(mockedReportError).toHaveBeenCalledWith(apiError);
    });

    it('still shows the fallback UI if the reporter itself throws (reporting must never cause a second crash)', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockedReportError.mockImplementationOnce(() => {
        throw new Error('reporter is broken');
      });

      expect(() =>
        render(
          <ErrorBoundary fallbackMessage="This tile could not load.">
            <Boom error={new Error('original crash')} />
          </ErrorBoundary>,
        ),
      ).not.toThrow();

      expect(screen.getByText('This tile could not load.')).toBeInTheDocument();
    });

    it('does not report anything when nothing throws', () => {
      render(
        <ErrorBoundary>
          <p>safe content</p>
        </ErrorBoundary>,
      );

      expect(mockedReportError).not.toHaveBeenCalled();
    });

    it('reports again on a second, different crash after a successful retry', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const user = userEvent.setup();
      let shouldThrow = true;
      let callCount = 0;
      function ThrowsTwice() {
        callCount += 1;
        if (shouldThrow) {
          throw new Error(`crash number ${callCount}`);
        }
        return <p>recovered content</p>;
      }

      render(
        <ErrorBoundary>
          <ThrowsTwice />
        </ErrorBoundary>,
      );
      expect(mockedReportError).toHaveBeenCalledTimes(1);

      shouldThrow = false;
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(screen.getByText('recovered content')).toBeInTheDocument();

      expect(mockedReportError).toHaveBeenCalledTimes(1);
    });
  });

  describe('accessibility (17.1)', () => {
    it('has no axe violations in the fallback UI, including when the reporter fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockedReportError.mockImplementationOnce(() => {
        throw new Error('reporter is broken');
      });

      const { container } = render(
        <ErrorBoundary fallbackMessage="This tile could not load.">
          <Boom error={new Error('boom')} />
        </ErrorBoundary>,
      );

      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
