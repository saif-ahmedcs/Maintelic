import { useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { IconEye, IconEyeOff, IconLock, IconMail } from '@tabler/icons-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '../../design/Button';
import { Field } from '../../design/Field';
import { Heading } from '../../design/Heading';
import { Icon } from '../../design/Icon';
import { IndustrialGlobe } from '../../design/IndustrialGlobe';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import { signIn } from '../../lib/auth/session';
import { login } from './api';
import maintelicLogo from '../../assets/maintelic-logo.png';
import refineryBackdrop from '../../assets/refinery-night.png';
import './login.css';

const loginFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required')
    .pipe(z.email('Enter a valid email address')),
  password: z.string().min(1, 'Password is required'),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;
type FieldErrors = Partial<Record<keyof LoginFormValues, string>>;

interface IntendedLocationState {
  from?: { pathname: string; search?: string };
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = loginFormSchema.safeParse({ email, password });
    if (!result.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0] as keyof LoginFormValues | undefined;
        if (key && !nextErrors[key]) {
          nextErrors[key] = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setFormError(null);
      (nextErrors.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);

    try {
      const tokens = await login(result.data);
      await signIn(tokens);

      const state = location.state as IntendedLocationState | null;
      const from = state?.from;
      navigate(from ? `${from.pathname}${from.search ?? ''}` : '/', {
        replace: true,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setFormError('Email or password is not correct.');
      } else if (error instanceof ApiError && error.status === 429) {
        setFormError('Too many attempts. Wait a minute and try again.');
      } else if (error instanceof ApiError) {
        setFormError(toUserMessage(error).message);
      } else {
        setFormError('Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative isolate min-h-screen overflow-hidden">
      <div
        aria-hidden="true"
        className="login-backdrop absolute inset-0 -z-20"
        style={{ backgroundImage: `url(${refineryBackdrop})` }}
      />
      <div aria-hidden="true" className="login-scrim absolute inset-0 -z-10" />

      <div className="relative mx-auto grid min-h-screen w-full max-w-page items-center gap-10 px-5 py-12 sm:px-9 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)] lg:gap-8 xl:px-16">
        {/* On small screens the globe sits behind the card as ambient depth. */}
        <div
          aria-hidden="true"
          className="login-globe pointer-events-none absolute -right-[22%] top-[3%] -z-0 w-[88vw] max-w-[440px] opacity-60 sm:right-[-8%] sm:w-[60vw] lg:static lg:order-2 lg:mx-auto lg:w-full lg:max-w-[min(640px,76vh)] lg:opacity-100 lg:-translate-y-[6vh] lg:translate-x-[4vw] xl:translate-x-[9vw]"
        >
          <IndustrialGlobe />
        </div>

        <div className="relative z-10 mx-auto w-full max-w-[440px] lg:mx-0 lg:order-1">
          <div className="login-card rounded-card px-6 py-8 sm:px-9 sm:py-10">
            <header className="flex flex-col gap-4">
              <img
                src={maintelicLogo}
                alt="Maintelic"
                width={2048}
                height={682}
                className="login-reveal -ml-1 h-auto w-[min(100%,14.58rem)] object-contain"
              />

              <Heading
                level={1}
                scale="heading-lg"
                className="login-reveal !text-[clamp(2.5rem,9vw,3.5rem)]"
              >
                <span className="login-title">Sign in</span>
              </Heading>

              <p
                className="login-reveal font-display text-body font-normal text-text-silver/90"
                style={{ '--login-delay': '120ms' } as CSSProperties}
              >
                Enter your email and password to reach the plant console.
              </p>
            </header>

            <form
              className="mt-8 flex flex-col gap-5"
              onSubmit={handleSubmit}
              noValidate
            >
              <div
                className="login-reveal"
                style={{ '--login-delay': '180ms' } as CSSProperties}
              >
                <Field
                  label="Email"
                  variant="glass"
                  error={fieldErrors.email}
                  startAdornment={<Icon icon={IconMail} size={18} />}
                >
                  <input
                    ref={emailRef}
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
              </div>

              <div
                className="login-reveal"
                style={{ '--login-delay': '240ms' } as CSSProperties}
              >
                <Field
                  label="Password"
                  variant="glass"
                  error={fieldErrors.password}
                  startAdornment={<Icon icon={IconLock} size={18} />}
                  endAdornment={
                    <button
                      type="button"
                      aria-label={
                        showPassword ? 'Hide password' : 'Show password'
                      }
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((visible) => !visible)}
                      className="inline-flex size-9 items-center justify-center rounded-small text-text-silver/80 transition-colors duration-200 hover:text-text-platinum"
                    >
                      <Icon
                        icon={showPassword ? IconEyeOff : IconEye}
                        size={18}
                      />
                    </button>
                  }
                >
                  <input
                    ref={passwordRef}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              </div>

              {formError && (
                <p
                  role="alert"
                  className="rounded-small border border-accent-lavender/30 bg-accent-lavender/10 px-3 py-2 font-ui text-ui text-accent-lavender"
                >
                  {formError}
                </p>
              )}

              <div
                className="login-reveal"
                style={{ '--login-delay': '300ms' } as CSSProperties}
              >
                <Button
                  type="submit"
                  variant="signal"
                  size="lg"
                  loading={submitting}
                  className="w-full"
                >
                  Sign in
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
