import * as Joi from 'joi';

// Example/placeholder values that must never be used as a real JWT_SECRET.
// Mirrors the KNOWN_INSECURE_ADMIN_PASSWORDS pattern in
// src/database/seeds/admin-seed-config.ts.
export const KNOWN_INSECURE_JWT_SECRETS = [
  'changeme',
  'change-me',
  'secret',
  'your-secret-key',
  'your-256-bit-secret',
  'example-secret-key-change-in-production',
] as const;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  POSTGRES_HOST: Joi.string().required(),
  POSTGRES_PORT: Joi.number().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),

  DEFAULT_ADMIN_EMAIL: Joi.string().email().allow('').optional(),
  DEFAULT_ADMIN_PASSWORD: Joi.string().allow('').optional(),

  JWT_SECRET: Joi.string()
    .min(32)
    .required()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string()
        .invalid(...KNOWN_INSECURE_JWT_SECRETS)
        .messages({
          'any.invalid':
            'JWT_SECRET must not be a known example/placeholder value in production.',
        }),
    }),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN_DAYS: Joi.number().default(7),

  AUTH_LOGIN_RATE_LIMIT: Joi.number().integer().min(1).optional(),
  AUTH_REFRESH_RATE_LIMIT: Joi.number().integer().min(1).optional(),
  DEFAULT_RATE_LIMIT: Joi.number().integer().min(1).optional(),
  CLIENT_ERROR_RATE_LIMIT: Joi.number().integer().min(1).optional(),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().required(),

  MQTT_HOST: Joi.string().required(),
  MQTT_PORT: Joi.number().required(),
  MQTT_BACKEND_PASSWORD: Joi.string().required(),
  // Optional override of the backend's stable MQTT client id (default
  // "maintelic-backend", see mqtt-connection-options.ts). Blank = default.
  MQTT_BACKEND_CLIENT_ID: Joi.string()
    .allow('')
    .pattern(/^[A-Za-z0-9._-]+$/)
    .max(128)
    .optional(),

  AI_INSIGHTS_ENABLED: Joi.boolean().default(false),
  GROQ_API_KEY: Joi.when('AI_INSIGHTS_ENABLED', {
    is: true,
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  GROQ_MODEL: Joi.string().default('llama-3.1-8b-instant'),
  AI_INSIGHTS_TIMEOUT_MS: Joi.number().integer().min(500).default(4000),
});
