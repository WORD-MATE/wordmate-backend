import { MySqlContainer } from '@testcontainers/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createConnection } from 'mysql2/promise';
import { GenericContainer, getContainerRuntimeClient } from 'testcontainers';

export interface TestInfra {
  databaseUrl: string;
  valkeyUrl: string;
  stop: () => Promise<void>;
}

export async function startTestInfra(): Promise<TestInfra> {
  try {
    await getContainerRuntimeClient();
  } catch {
    throw new Error('통합 테스트에는 Docker가 필요합니다. Docker를 실행한 뒤 다시 시도하세요.');
  }

  const [mysql, valkey] = await Promise.all([
    new MySqlContainer('mysql:8.4').withDatabase('wordmate').start(),
    new GenericContainer('valkey/valkey:9').withExposedPorts(6379).start(),
  ]);

  const databaseUrl = mysql.getConnectionUri();
  const connection = await createConnection({ uri: databaseUrl });
  await migrate(drizzle({ client: connection }), { migrationsFolder: './drizzle' });
  await connection.end();

  return {
    databaseUrl,
    valkeyUrl: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
    stop: async () => {
      await Promise.all([mysql.stop(), valkey.stop()]);
    },
  };
}
