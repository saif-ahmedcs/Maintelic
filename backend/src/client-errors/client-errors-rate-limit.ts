function clientErrorRateLimit(envVar: string, productionDefault: number) {
  return (): number => {
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') return productionDefault;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : productionDefault;
  };
}

export const CLIENT_ERROR_THROTTLE = {
  limit: clientErrorRateLimit('CLIENT_ERROR_RATE_LIMIT', 20),
  ttl: 60_000,
};
