import {
  buildBackendMqttOptions,
  buildMqttUrl,
  DEFAULT_MQTT_BACKEND_CLIENT_ID,
  MQTT_BACKEND_USERNAME,
  resolveBackendMqttClientId,
} from './mqtt-connection-options';

const config = { host: 'broker', port: 1883, password: 'pw' };

describe('buildBackendMqttOptions (BJM-3)', () => {
  it('uses a persistent session (clean: false) so the broker queues QoS 1 messages while the backend is away', () => {
    expect(buildBackendMqttOptions(config).clean).toBe(false);
  });

  it('uses a fixed client id, the same on every start, so the broker can find the session again', () => {
    const first = buildBackendMqttOptions(config).clientId;
    const second = buildBackendMqttOptions(config).clientId;

    expect(first).toBe(DEFAULT_MQTT_BACKEND_CLIENT_ID);
    expect(second).toBe(first);
  });

  it('never produces an empty client id (MQTT.js rejects clean: false without one)', () => {
    for (const clientId of [undefined, '', '   ']) {
      const options = buildBackendMqttOptions({ ...config, clientId });
      expect(options.clientId).toBe(DEFAULT_MQTT_BACKEND_CLIENT_ID);
    }
  });

  it('lets the client id be overridden, trimmed', () => {
    expect(
      buildBackendMqttOptions({ ...config, clientId: '  backend-2 ' }).clientId,
    ).toBe('backend-2');
  });

  it('keeps the subscription at QoS 1, which only has effect with a persistent session', () => {
    expect(buildBackendMqttOptions(config).subscribeOptions).toEqual({
      qos: 1,
    });
  });

  it('keeps the broker credentials and URL', () => {
    expect(buildBackendMqttOptions(config)).toMatchObject({
      url: 'mqtt://broker:1883',
      username: MQTT_BACKEND_USERNAME,
      password: 'pw',
    });
  });
});

describe('resolveBackendMqttClientId', () => {
  it('falls back to the default for null as well', () => {
    expect(resolveBackendMqttClientId(null)).toBe(
      DEFAULT_MQTT_BACKEND_CLIENT_ID,
    );
  });
});

describe('buildMqttUrl', () => {
  it('builds an mqtt:// URL', () => {
    expect(buildMqttUrl('localhost', '1883')).toBe('mqtt://localhost:1883');
  });
});
