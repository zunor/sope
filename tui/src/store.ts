// SPDX-License-Identifier: MIT
// Saved sessions, in one SQLite database for every directory:
// $XDG_DATA_HOME/sope/sope.db (~/.local/share/sope/sope.db), or $SOPE_DB.
//
//   session   one row per conversation, keyed to the directory it ran in;
//             history is what the model remembers (sope_agent_history),
//             time_deleted marks one closed from its tab (kept, hidden)
//   message   the transcript as the TUI shows it, one row per entry
//
// WAL lets several sope processes in the same directory share the file.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Message } from "./ui/chat";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  directory     TEXT NOT NULL,
  title         TEXT NOT NULL,
  history       TEXT NOT NULL DEFAULT '[]',
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  context       INTEGER NOT NULL DEFAULT 0,
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL,
  time_deleted  INTEGER
);
CREATE INDEX IF NOT EXISTS session_directory_idx ON session (directory, time_deleted, time_created);
CREATE TABLE IF NOT EXISTS message (
  session_id    TEXT NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  data          TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);`;

export function defaultDbPath(env = process.env): string {
  if (env.SOPE_DB) return env.SOPE_DB;
  const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "sope", "sope.db");
}

export interface StoredSession {
  id: string;
  title: string;
  history: string;
  tokensIn: number;
  tokensOut: number;
  context: number;
  updated: number;
}

/** What a session saves: everything but the transcript, which goes row by row. */
export interface SessionState {
  title: string;
  /** Omitted when it could not be read (a turn was running): the saved one stays. */
  history?: string;
  tokensIn: number;
  tokensOut: number;
  context: number;
}

/** A transcript entry as saved: the message without its in-memory identity. */
export type SavedMessage = Omit<Message, "id" | "version">;

export class Store {
  readonly #db: Database;

  constructor(path = defaultDbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
    const { user_version } = this.#db.query("PRAGMA user_version").get() as { user_version: number };
    if (user_version > SCHEMA_VERSION) throw new Error(`${path} was written by a newer sope (schema ${user_version})`);
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** Opens the database, or returns null (with the reason) when it cannot: sessions then live for this run only. */
  static open(path = defaultDbPath()): { store: Store | null; error?: string } {
    try {
      return { store: new Store(path) };
    } catch (err) {
      return { store: null, error: `${path}: ${(err as Error).message}` };
    }
  }

  /** The directory's sessions that were not closed, oldest first. */
  list(directory: string): StoredSession[] {
    return this.#db
      .query(
        `SELECT id, title, history, tokens_in AS tokensIn, tokens_out AS tokensOut, context, time_updated AS updated
         FROM session WHERE directory = ? AND time_deleted IS NULL ORDER BY time_created, rowid`,
      )
      .all(directory) as StoredSession[];
  }

  /** The directory's sessions without their contents, for picking one: newest first, with transcript sizes. */
  summaries(directory: string): Array<{ id: string; title: string; updated: number; messages: number }> {
    return this.#db
      .query(
        `SELECT s.id, s.title, s.time_updated AS updated, (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS messages
         FROM session s WHERE s.directory = ? AND s.time_deleted IS NULL ORDER BY s.time_updated DESC, s.rowid DESC`,
      )
      .all(directory) as Array<{ id: string; title: string; updated: number; messages: number }>;
  }

  get(id: string): StoredSession | null {
    return (this.#db
      .query(
        `SELECT id, title, history, tokens_in AS tokensIn, tokens_out AS tokensOut, context, time_updated AS updated
         FROM session WHERE id = ? AND time_deleted IS NULL`,
      )
      .get(id) ?? null) as StoredSession | null;
  }

  messages(sessionId: string): SavedMessage[] {
    const rows = this.#db.query("SELECT data FROM message WHERE session_id = ? ORDER BY seq").all(sessionId) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as SavedMessage);
  }

  create(id: string, directory: string, title: string, now = Date.now()): void {
    this.#db.query("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)").run(id, directory, title, now, now);
  }

  /**
   * Saves a session: its state, the transcript entries that changed
   * (`changed`: seq → entry) and how many entries it has now (later ones
   * are dropped, e.g. after /clear).
   */
  save(id: string, state: SessionState, changed: Map<number, SavedMessage>, length: number, now = Date.now()): void {
    const update = this.#db.query(
      `UPDATE session SET title = ?, history = COALESCE(?, history), tokens_in = ?, tokens_out = ?, context = ?, time_updated = ? WHERE id = ?`,
    );
    const upsert = this.#db.query("INSERT INTO message (session_id, seq, data) VALUES (?, ?, ?) ON CONFLICT (session_id, seq) DO UPDATE SET data = excluded.data");
    const trim = this.#db.query("DELETE FROM message WHERE session_id = ? AND seq >= ?");
    this.#db.transaction(() => {
      update.run(state.title, state.history ?? null, state.tokensIn, state.tokensOut, state.context, now, id);
      for (const [seq, m] of changed) upsert.run(id, seq, JSON.stringify(m));
      trim.run(id, length);
    })();
  }

  /** Closes a session for good as far as the tabs go; the rows stay. */
  delete(id: string, now = Date.now()): void {
    this.#db.query("UPDATE session SET time_deleted = ? WHERE id = ?").run(now, id);
  }

  close(): void {
    this.#db.close();
  }
}
