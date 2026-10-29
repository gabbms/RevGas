import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// O .sql fica ao lado deste módulo: em src/ (tsx/vitest) e em dist/ (o script
// "build" copia src/db/migrations para dist/db/migrations).
const MIGRATIONS = ['001_init.sql', '002_draft_presented.sql', '003_pending_receipts.sql', '004_receipt_links.sql'];

function loadMigration(name: string): string {
  return readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
}

export type Db = Database.Database;

/** Abre o banco, liga foreign_keys e aplica as migrações pendentes (PRAGMA user_version). */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') db.pragma('journal_mode = WAL');

  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = loadMigration(MIGRATIONS[i]!);
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}
