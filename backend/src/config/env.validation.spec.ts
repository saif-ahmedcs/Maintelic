import {
  envValidationSchema,
  KNOWN_INSECURE_JWT_SECRETS,
} from './env.validation';

const baseEnv = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'u',
  POSTGRES_PASSWORD: 'p',
  POSTGRES_DB: 'db',
  JWT_SECRET: 'x'.repeat(32),
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  MQTT_HOST: 'localhost',
  MQTT_PORT: '1883',
  MQTT_BACKEND_PASSWORD: 'mqtt-backend-test-password',
};

describe('envValidationSchema — AI insights', () => {
  it('defaults to disabled and needs no GROQ_API_KEY', () => {
    const { error, value } = envValidationSchema.validate(baseEnv);
    expect(error).toBeUndefined();
    expect(value.AI_INSIGHTS_ENABLED).toBe(false);
    expect(value.GROQ_MODEL).toBe('llama-3.1-8b-instant');
    expect(value.AI_INSIGHTS_TIMEOUT_MS).toBe(4000);
  });

  it('accepts an empty GROQ_API_KEY while disabled', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      AI_INSIGHTS_ENABLED: 'false',
      GROQ_API_KEY: '',
    });
    expect(error).toBeUndefined();
  });

  it('fails at boot when enabled without a GROQ_API_KEY', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      AI_INSIGHTS_ENABLED: 'true',
      GROQ_API_KEY: '',
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('GROQ_API_KEY');
  });

  it('passes when enabled with a key', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      AI_INSIGHTS_ENABLED: 'true',
      GROQ_API_KEY: 'gsk_test',
    });
    expect(error).toBeUndefined();
  });
});

describe('envValidationSchema — MQTT auth', () => {
  it('fails to boot without MQTT_BACKEND_PASSWORD (no default — the broker denies anonymous connections)', () => {
    const { MQTT_BACKEND_PASSWORD: _omit, ...withoutPassword } = baseEnv;
    const { error } = envValidationSchema.validate(withoutPassword);
    expect(error).toBeDefined();
    expect(error?.message).toContain('MQTT_BACKEND_PASSWORD');
  });

  it('fails to boot with a blank MQTT_BACKEND_PASSWORD', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      MQTT_BACKEND_PASSWORD: '',
    });
    expect(error).toBeDefined();
  });

  it('boots with MQTT_BACKEND_PASSWORD set', () => {
    const { error } = envValidationSchema.validate(baseEnv);
    expect(error).toBeUndefined();
  });
});

describe('envValidationSchema — production JWT_SECRET boot check', () => {
  it('fails to boot in production with a secret shorter than 32 characters', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(31),
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('JWT_SECRET');
  });

  it.each(KNOWN_INSECURE_JWT_SECRETS)(
    'fails to boot in production with the known placeholder value %p',
    (placeholder) => {
      const { error } = envValidationSchema.validate({
        ...baseEnv,
        NODE_ENV: 'production',
        JWT_SECRET: placeholder,
      });
      expect(error).toBeDefined();
    },
  );

  it('rejects a known placeholder in production even when it is 32+ characters on its own (not just caught by the length rule)', () => {
    const longPlaceholder = 'example-secret-key-change-in-production';
    expect(longPlaceholder.length).toBeGreaterThanOrEqual(32);
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'production',
      JWT_SECRET: longPlaceholder,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('placeholder');
  });

  it('allows a known placeholder value outside production as long as it is 32+ characters (existing dev behavior preserved)', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'development',
      JWT_SECRET: 'example-secret-key-change-in-production',
    });
    expect(error).toBeUndefined();
  });

  it('boots in production with a long, unique secret', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'a-sufficiently-long-and-unique-production-secret',
    });
    expect(error).toBeUndefined();
  });

  it('still enforces the 32-character minimum outside production (existing behavior preserved)', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'development',
      JWT_SECRET: 'x'.repeat(31),
    });
    expect(error).toBeDefined();
  });
});

describe('envValidationSchema — admin seed variables', () => {
  it('does not inject default admin credentials', () => {
    const { value } = envValidationSchema.validate(baseEnv);
    expect(value.DEFAULT_ADMIN_EMAIL).toBeUndefined();
    expect(value.DEFAULT_ADMIN_PASSWORD).toBeUndefined();
  });

  it('still boots when the seed variables are present but blank', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      DEFAULT_ADMIN_EMAIL: '',
      DEFAULT_ADMIN_PASSWORD: '',
    });
    expect(error).toBeUndefined();
  });
});
