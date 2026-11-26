import { randomUUID } from 'node:crypto';
import mqtt, { MqttClient } from 'mqtt';
import { ServerMqtt } from '@nestjs/microservices';
import {
  buildBackendMqttOptions,
  buildMqttUrl,
  MQTT_BACKEND_USERNAME,
} from './../src/common/mqtt/mqtt-connection-options';
import { poll } from './utils/poll';
import { connectAsSimulator } from './utils/mqtt';


const TELEMETRY_PATTERN = 'factory/+/asset/+/telemetry';

type Reading = { seq: number; run: string };

interface RunningBackend {
  server: ServerMqtt;
  received: Reading[];
}

function buildOptions(clientId: string, overrides: { clean?: boolean } = {}) {
  return {
    ...buildBackendMqttOptions({
      host: process.env.MQTT_HOST as string,
      port: process.env.MQTT_PORT as string,
      password: process.env.MQTT_BACKEND_PASSWORD as string,
      clientId,
    }),
    ...overrides,
  };
}

async function startBackend(
  options: ReturnType<typeof buildOptions>,
): Promise<RunningBackend> {
  const received: Reading[] = [];
  const server = new ServerMqtt(options);
  server.addHandler(
    TELEMETRY_PATTERN,
    async (data: Reading) => {
      received.push(data);
    },
    true,
  );
  await new Promise<void>((resolve, reject) => {
    server.listen((err?: unknown) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { server, received };
}

function mqttClientOf(server: ServerMqtt): MqttClient {
  return (server as unknown as { mqttClient: MqttClient }).mqttClient;
}

async function stopBackend(backend: RunningBackend): Promise<void> {
  const client = mqttClientOf(backend.server);
  const closed = new Promise<void>((resolve) => client.once('close', resolve));
  backend.server.close();
  await closed;
}

function publishAcked(
  client: MqttClient,
  topic: string,
  payload: Reading,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

async function discardSession(clientId: string): Promise<void> {
  const client = mqtt.connect(
    buildMqttUrl(
      process.env.MQTT_HOST as string,
      process.env.MQTT_PORT as string,
    ),
    {
      clientId,
      clean: true,
      username: MQTT_BACKEND_USERNAME,
      password: process.env.MQTT_BACKEND_PASSWORD,
      reconnectPeriod: 0,
    },
  );
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  await client.endAsync();
}

describe('MQTT persistent session for the backend subscriber (BJM-3, e2e)', () => {
  let simulator: MqttClient;
  const clientIds: string[] = [];

  const newClientId = () => {
    const id = `maintelic-backend-e2e-${randomUUID()}`;
    clientIds.push(id);
    return id;
  };

  const newTopic = () =>
    `factory/${randomUUID()}/asset/${randomUUID()}/telemetry`;

  beforeAll(async () => {
    simulator = await connectAsSimulator();
  });

  afterAll(async () => {
    await simulator?.endAsync(true);
    for (const id of clientIds) {
      await discardSession(id);
    }
  });

  it('delivers every reading published while the backend was down, in order, after it reconnects', async () => {
    const clientId = newClientId();
    const topic = newTopic();
    const run = randomUUID();
    const options = buildOptions(clientId);

    const first = await startBackend(options);
    await publishAcked(simulator, topic, { seq: 0, run });
    await poll(async () => (first.received.length >= 1 ? true : null));

    // The backend goes away (deploy, crash, network drop) ...
    await stopBackend(first);

    // ... and the simulator keeps publishing meanwhile.
    const whileDown = [1, 2, 3, 4, 5];
    for (const seq of whileDown) {
      await publishAcked(simulator, topic, { seq, run });
    }

    // The backend comes back with the same options, as a restart does.
    const second = await startBackend(options);
    try {
      await poll(async () =>
        second.received.filter((r) => r.run === run).length >= whileDown.length
          ? true
          : null,
      );
      expect(
        second.received.filter((r) => r.run === run).map((r) => r.seq),
      ).toEqual(whileDown);
    } finally {
      await stopBackend(second);
    }
  });

  it('keeps queueing across several consecutive outages of the same backend', async () => {
    const clientId = newClientId();
    const topic = newTopic();
    const run = randomUUID();
    const options = buildOptions(clientId);

    const first = await startBackend(options);
    await stopBackend(first);
    await publishAcked(simulator, topic, { seq: 1, run });

    // Restart #1 receives the backlog, then goes down again.
    const second = await startBackend(options);
    await poll(async () => (second.received.length >= 1 ? true : null));
    await stopBackend(second);
    await publishAcked(simulator, topic, { seq: 2, run });

    // Restart #2 must receive only what it missed since restart #1.
    const third = await startBackend(options);
    try {
      await poll(async () => (third.received.length >= 1 ? true : null));
      expect(third.received.map((r) => r.seq)).toEqual([2]);
      expect(second.received.map((r) => r.seq)).toEqual([1]);
    } finally {
      await stopBackend(third);
    }
  });

  it("queues a backlog larger than Mosquitto's default 1000-message limit (max_queued_messages)", async () => {
    // Mosquitto drops the newest messages once an offline client's queue is
    // full. 1000 is the default, only a few minutes of telemetry, so
    // docker/mosquitto.conf raises it; this fails if that setting is lost.
    const clientId = newClientId();
    const topic = newTopic();
    const run = randomUUID();
    const options = buildOptions(clientId);
    const backlog = 1500;

    const first = await startBackend(options);
    await stopBackend(first);

    await Promise.all(
      Array.from({ length: backlog }, (_, i) =>
        publishAcked(simulator, topic, { seq: i, run }),
      ),
    );

    const second = await startBackend(options);
    try {
      await poll(
        async () => (second.received.length >= backlog ? true : null),
        { timeoutMs: 15000 },
      );
      expect(second.received).toHaveLength(backlog);
      expect(new Set(second.received.map((r) => r.seq)).size).toBe(backlog);
    } finally {
      await stopBackend(second);
    }
  }, 30000);

  it('control: a clean-session subscriber loses everything published while it was away', async () => {
    // Documents the failure this ticket fixes, and proves the tests above can
    // tell the difference: with the same client id but clean: true the broker
    // throws the session away on disconnect.
    const clientId = newClientId();
    const topic = newTopic();
    const run = randomUUID();
    const options = buildOptions(clientId, { clean: true });

    const first = await startBackend(options);
    await stopBackend(first);

    await publishAcked(simulator, topic, { seq: 1, run });

    const second = await startBackend(options);
    try {
      // A marker published after the reconnect proves the subscription is
      // live, so the absence of the earlier message is a loss, not lag.
      await publishAcked(simulator, topic, { seq: 99, run });
      await poll(async () => (second.received.length >= 1 ? true : null));
      expect(second.received.map((r) => r.seq)).toEqual([99]);
    } finally {
      await stopBackend(second);
    }
  });
});
