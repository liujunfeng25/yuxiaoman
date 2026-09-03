import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresDatabase, postgresPlaceholders } from "../database.js";
import { createDatabase, migrateDatabase } from "../db.js";
import {
  assertTestDatabaseTargetIsolated,
  createTestDatabase,
} from "./test-database.js";

test("测试数据库防误连按 host、port、database 比较并忽略账号", () => {
  assert.throws(
    () => assertTestDatabaseTargetIsolated(
      "postgresql://test_user:test_password@DB.EXAMPLE.COM/app_test?sslmode=require",
      "postgres://runtime_user:runtime_password@db.example.com:5432/app_test",
    ),
    /target the same PostgreSQL database/u,
  );
  assert.throws(
    () => assertTestDatabaseTargetIsolated(
      "postgresql://test_user@localhost/app_test",
      "postgresql://runtime_user@127.0.0.1:5432/app_test",
    ),
    /target the same PostgreSQL database/u,
  );

  assert.doesNotThrow(() => assertTestDatabaseTargetIsolated(
    "postgresql://test_user@db.example.com:5433/app_test",
    "postgresql://runtime_user@db.example.com:5432/app_test",
  ));
  assert.doesNotThrow(() => assertTestDatabaseTargetIsolated(
    "postgresql://test_user@db.example.com/app_test",
    "postgresql://runtime_user@db.example.com/app_runtime",
  ));
});

test("postgresPlaceholders 只转换 SQL 代码中的问号", () => {
  const cases = [
    {
      source: "SELECT ? AS first, ? AS second",
      expected: "SELECT $1 AS first, $2 AS second",
    },
    {
      source: "SELECT '?' AS literal, 'it''s ?' AS escaped, ? AS value",
      expected: "SELECT '?' AS literal, 'it''s ?' AS escaped, $1 AS value",
    },
    {
      source: 'SELECT "identifier?" FROM sample WHERE id = ?',
      expected: 'SELECT "identifier?" FROM sample WHERE id = $1',
    },
    {
      source: "SELECT ? -- keep ? in a line comment\n/* keep ? in a block comment */ WHERE id = ?",
      expected: "SELECT $1 -- keep ? in a line comment\n/* keep ? in a block comment */ WHERE id = $2",
    },
    {
      source: "SELECT $$ keep ? $$, $body$ keep ? too $body$, ? AS value",
      expected: "SELECT $$ keep ? $$, $body$ keep ? too $body$, $1 AS value",
    },
    {
      source: "SELECT payload ?? 'enabled', ? AS value",
      expected: "SELECT payload ? 'enabled', $1 AS value",
    },
  ];

  for (const { source, expected } of cases) {
    assert.equal(postgresPlaceholders(source), expected);
  }
});

test("嵌套事务失败只回滚 savepoint，外层事务仍可提交", async () => {
  const database = await createTestDatabase("database_savepoint");
  try {
    await database.execute(`
      CREATE TABLE adapter_transaction_probe (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL
      )
    `);

    await database.transaction(async (outer) => {
      await outer.prepare(
        "INSERT INTO adapter_transaction_probe (id, label) VALUES (?, ?)",
      ).run(1, "outer-before");

      await assert.rejects(
        outer.transaction(async (inner) => {
          await inner.prepare(
            "INSERT INTO adapter_transaction_probe (id, label) VALUES (?, ?)",
          ).run(2, "inner-rolled-back");
          throw new Error("expected nested rollback");
        }),
        /expected nested rollback/u,
      );

      assert.deepEqual(
        await outer.prepare<{ id: number; label: string }>(
          "SELECT id, label FROM adapter_transaction_probe ORDER BY id",
        ).all(),
        [{ id: 1, label: "outer-before" }],
      );

      await outer.prepare(
        "INSERT INTO adapter_transaction_probe (id, label) VALUES (?, ?)",
      ).run(3, "outer-after");
    });

    assert.deepEqual(
      await database.prepare<{ id: number; label: string }>(
        "SELECT id, label FROM adapter_transaction_probe ORDER BY id",
      ).all(),
      [
        { id: 1, label: "outer-before" },
        { id: 3, label: "outer-after" },
      ],
    );
  } finally {
    await database.close();
  }
});

test("嵌套事务拒绝新的事务选项且不执行回调", async () => {
  const database = await createTestDatabase("database_nested_options");
  try {
    await database.transaction(async (outer) => {
      let callbackInvoked = false;

      await assert.rejects(
        outer.transaction(
          async () => {
            callbackInvoked = true;
          },
          { isolationLevel: "serializable" },
        ),
        /nested .*transaction.*options|transaction options.*nested/iu,
      );

      assert.equal(callbackInvoked, false);
    });
  } finally {
    await database.close();
  }
});

test("createSchema false 遇到不存在的 schema 时不会回落到 public", async () => {
  const connectionString = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(connectionString, "TEST_DATABASE_URL is required for PostgreSQL adapter tests");

  const schema = `yxm_missing_${randomUUID().replaceAll("-", "")}`;
  const outcome = await createPostgresDatabase({
    connectionString,
    schema,
    createSchema: false,
    max: 1,
    applicationName: "yuxiaoman-test-missing-schema",
  }).then(
    (database) => ({ database, error: undefined }),
    (error: unknown) => ({ database: undefined, error }),
  );

  if (outcome.database) {
    await outcome.database.close();
    assert.fail("createPostgresDatabase unexpectedly connected through public schema");
  }

  assert.ok(outcome.error instanceof Error);
});

test("旧预约媒体约束升级后允许启动后仪表盘照片", async () => {
  const database = await createTestDatabase("booking_media_v2");
  try {
    await database.execute(`
      ALTER TABLE booking_media
        DROP CONSTRAINT IF EXISTS booking_media_kind_check_v2;
      ALTER TABLE booking_media
        ADD CONSTRAINT booking_media_kind_check CHECK (
          kind IN (
            'vehicle_front_left', 'vehicle_front_right', 'vehicle_rear_left',
            'vehicle_rear_right', 'license_front', 'license_back'
          )
        );
    `);

    await migrateDatabase(database);

    const constraint = await database.prepare<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'booking_media'::regclass
        AND conname = 'booking_media_kind_check_v2'
    `).get();
    assert.match(constraint?.definition ?? "", /dashboard_started/u);

    const user = await database.prepare<{ id: string }>("SELECT id FROM users ORDER BY id LIMIT 1").get();
    assert.ok(user?.id);
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO booking_media (
        id, user_id, booking_id, kind, storage_key, mime_type,
        size_bytes, width, height, created_at, bound_at, expires_at
      ) VALUES (?, ?, NULL, 'dashboard_started', ?, 'image/jpeg', 1, 1, 1, ?, NULL, ?)
    `).run(randomUUID(), user.id, `booking-dashboard-${randomUUID()}.jpg`, now, now);
  } finally {
    await database.close();
  }
});

test("生产环境默认只迁移结构而不写入合成演示数据", async () => {
  const connectionString = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(connectionString, "TEST_DATABASE_URL is required for PostgreSQL adapter tests");

  const previousNodeEnv = process.env.NODE_ENV;
  const previousYuxiaomanEnv = process.env.YUXIAOMAN_ENV;
  const schema = `yxm_production_seed_${randomUUID().replaceAll("-", "")}`;
  let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.YUXIAOMAN_ENV;
    database = await createDatabase({
      connectionString,
      schema,
      createSchema: true,
      dropSchemaOnClose: true,
      max: 1,
      applicationName: "yuxiaoman-test-production-seed-boundary",
    });

    const table = await database.prepare<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'users'
    `).get(schema);
    const vehicles = await database.prepare<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM vehicles",
    ).get();

    assert.equal(table?.table_name, "users");
    assert.equal(vehicles?.count, "0");
  } finally {
    if (database) await database.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousYuxiaomanEnv === undefined) delete process.env.YUXIAOMAN_ENV;
    else process.env.YUXIAOMAN_ENV = previousYuxiaomanEnv;
  }
});
