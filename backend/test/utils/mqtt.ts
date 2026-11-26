import mqtt, { MqttClient } from 'mqtt';
import { Transport } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import {
  buildBackendMqttOptions,
  buildMqttUrl,
  DEFAULT_MQTT_BACKEND_CLIENT_ID,
} from './../../src/common/mqtt/mqtt-connection-options';

export const MQTT_SIMULATOR_USERNAME = 'simulator';

type BackendMqttTestOptions = Omit<
  ReturnType<typeof buildBackendMqttOptions>,
  'clean'
> & { clean: boolean };

export function backendMqttMicroserviceOptions(): {
  transport: Transport.MQTT;
  options: BackendMqttTestOptions;
} {
  return {
    transport: Transport.MQTT,
    options: {
      ...buildBackendMqttOptions({
        host: process.env.MQTT_HOST as string,
        port: process.env.MQTT_PORT as string,
        password: process.env.MQTT_BACKEND_PASSWORD as string,
        clientId: `${DEFAULT_MQTT_BACKEND_CLIENT_ID}-e2e-${randomUUID()}`,
      }),
      clean: true,
    },
  };
}

export async function connectAsSimulator(): Promise<MqttClient> {
  const client = mqtt.connect(
    buildMqttUrl(
      process.env.MQTT_HOST as string,
      process.env.MQTT_PORT as string,
    ),
    {
      username: MQTT_SIMULATOR_USERNAME,
      password: process.env.MQTT_SIMULATOR_PASSWORD,
    },
  );
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  return client;
}
