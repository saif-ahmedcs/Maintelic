import mqtt from 'mqtt';
import { buildMqttUrl } from './../src/common/mqtt/mqtt-connection-options';
import { MQTT_SIMULATOR_USERNAME } from './utils/mqtt';

async function attemptConnect(
  options: Parameters<typeof mqtt.connect>[1],
): Promise<'connected' | Error> {
  const client = mqtt.connect(
    buildMqttUrl(
      process.env.MQTT_HOST as string,
      process.env.MQTT_PORT as string,
    ),
    { connectTimeout: 5000, reconnectPeriod: 0, ...options },
  );

  const outcome = await new Promise<'connected' | Error>((resolve) => {
    client.once('connect', () => resolve('connected'));
    client.once('error', (err) => resolve(err));
  });

  client.end(true);
  return outcome;
}

describe('MQTT broker authentication (e2e)', () => {
  it('refuses a client that connects with no credentials', async () => {
    const outcome = await attemptConnect({});
    expect(outcome).not.toBe('connected');
  });

  it('refuses a client that connects with a wrong password for a known user', async () => {
    const outcome = await attemptConnect({
      username: MQTT_SIMULATOR_USERNAME,
      password: 'definitely-not-the-real-password',
    });
    expect(outcome).not.toBe('connected');
  });
});
