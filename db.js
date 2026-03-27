import pg from 'pg'
import bcrypt from 'bcryptjs'

const { Pool } = pg

export const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5433,
  database: process.env.DB_NAME     || 'gql_notes',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
})

// ── Schema + seed ─────────────────────────────────────────────────────────────
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      priority   TEXT NOT NULL DEFAULT 'LOW',
      tags       TEXT[] NOT NULL DEFAULT '{}',
      owner_id   TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id              TEXT PRIMARY KEY,
      note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      filename        TEXT NOT NULL,
      mime_type       TEXT NOT NULL DEFAULT 'text/plain',
      attachment_type TEXT NOT NULL,
      url             TEXT NOT NULL,
      size_bytes      INT  NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS note_shares (
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role    TEXT NOT NULL CHECK (role IN ('EDITOR','VIEWER')),
      PRIMARY KEY (note_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      read       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  // Seed only if tables are empty
  const { rows } = await pool.query('SELECT COUNT(*) FROM users')
  if (rows[0].count !== '0') return

  const [h1, h2, h3] = await Promise.all([
    bcrypt.hash('alice123',  10),
    bcrypt.hash('bob123',    10),
    bcrypt.hash('carol123',  10),
  ])

  await pool.query(`
    INSERT INTO users (id, name, email, password_hash) VALUES
      ('u1', 'Alice', 'alice@example.com', $1),
      ('u2', 'Bob',   'bob@example.com',   $2),
      ('u3', 'Carol', 'carol@example.com', $3)
    ON CONFLICT DO NOTHING;`, [h1, h2, h3]
  )
  await pool.query(`

    INSERT INTO notes (id, title, body, priority, tags, owner_id) VALUES
      ('1', 'GraphQL Schema Design',
       'Product-driven schemas define the contract from the server side using strict input types, enums, and non-null constraints.',
       'HIGH', ARRAY['graphql','schema','api-design'], 'u1'),
      ('2', 'Consumer-Driven Contracts',
       'Clients declare exactly the fields they need. The server must satisfy those field-level contracts without breaking changes.',
       'MEDIUM', ARRAY['graphql','consumer-driven','contracts'], 'u2'),
      ('3', 'WebSocket Subscriptions',
       'Real-time events over a single persistent connection. One WS can multiplex multiple subscriptions simultaneously.',
       'LOW', ARRAY['websocket','real-time','subscriptions'], 'u3')
    ON CONFLICT DO NOTHING;

    INSERT INTO attachments (id, note_id, filename, mime_type, attachment_type, url, size_bytes) VALUES
      ('a1', '1', 'GraphQL Schema Design Patterns',   'video/youtube',    'VIDEO',   'https://www.youtube.com/watch?v=BcLNfwF04Kw',                          0),
      ('a2', '1', 'GraphQL Best Practices — Apollo',  'text/html',        'ARTICLE', 'https://www.apollographql.com/docs/apollo-server/schema/schema/',      0),
      ('a3', '2', 'Pact Contract Testing Guide.pdf',  'application/pdf',  'PDF',     'https://docs.pact.io',                                                 204800),
      ('a4', '3', 'WebSockets in 100 Seconds',        'video/youtube',    'VIDEO',   'https://www.youtube.com/watch?v=1BfCnjr_Vjg',                          0)
    ON CONFLICT DO NOTHING;
  `)

  console.log('✅  Database seeded — users: alice@example.com / alice123, bob@example.com / bob123, carol@example.com / carol123')
}

// ── Query helpers ─────────────────────────────────────────────────────────────
// Map snake_case DB columns → camelCase JS objects

const iso = (d) => d ? new Date(d).toISOString() : null

export function toNote(row) {
  return {
    id:        row.id,
    title:     row.title,
    body:      row.body,
    priority:  row.priority,
    tags:      row.tags,
    ownerId:   row.owner_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function toAttachment(row) {
  return {
    id:             row.id,
    noteId:         row.note_id,
    filename:       row.filename,
    mimeType:       row.mime_type,
    attachmentType: row.attachment_type,
    url:            row.url,
    sizeBytes:      row.size_bytes,
    createdAt:      iso(row.created_at),
  }
}

export function toUser(row) {
  return { id: row.id, name: row.name, email: row.email }
}

export function toShare(row) {
  return { noteId: row.note_id, userId: row.user_id, role: row.role }
}
