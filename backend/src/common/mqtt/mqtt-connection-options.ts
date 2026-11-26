export const MQTT_BACKEND_USERNAME = 'backend';

export const DEFAULT_MQTT_BACKEND_CLIENT_ID = 'maintelic-backend';

export function buildMqttUrl(host: string, port: string | number): string {
  return `mqtt://${host}:${port}`;
}

export interface BackendMqttConnectionConfig {
  host: string;
  port: string | number;
  password: string;
  clientId?: string;
}

export interface BackendMqttOptions {
  url: string;
  username: string;
  password: string;
  clientId: string;
  clean: false;
  subscribeOptions: { qos: 1 };
}

export function resolveBackendMqttClientId(clientId?: string | null): string {
  const trimmed = clientId?.trim();
  return trimmed ? trimmed : DEFAULT_MQTT_BACKEND_CLIENT_ID;
}

export function buildBackendMqttOptions(
  config: BackendMqttConnectionConfig,
): BackendMqttOptions {
  return {
    url: buildMqttUrl(config.host, config.port),
    username: MQTT_BACKEND_USERNAME,
    password: config.password,
    clientId: resolveBackendMqttClientId(config.clientId),
    clean: false,
    subscribeOptions: { qos: 1 },
  };
}
