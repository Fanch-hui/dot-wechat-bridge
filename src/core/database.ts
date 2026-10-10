export class Database {
  constructor(readonly binding: D1Database) {}
  statement(sql: string, values: unknown[] = []) {
    return this.binding.prepare(sql).bind(...values);
  }
  async one<T>(sql: string, values: unknown[] = []): Promise<T | null> {
    return this.statement(sql, values).first<T>();
  }
  async all<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.statement(sql, values).all<T>();
    return result.results;
  }
  async run(sql: string, values: unknown[] = []) {
    return this.statement(sql, values).run();
  }
  async get(key: string) {
    const row = await this.one<{value:string}>("SELECT value FROM settings WHERE key=?", [key]);
    return row?.value ?? null;
  }
}
