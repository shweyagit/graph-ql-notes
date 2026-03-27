import 'dotenv/config'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createSchema, createYoga, Repeater } from 'graphql-yoga'
import { useServer } from 'graphql-ws/lib/use/ws'
import { WebSocketServer } from 'ws'
import Stripe from 'stripe'
import { datadogPlugin } from './datadog.js'

// No-op plugin when Datadog is not configured
function noopPlugin() { return {} }
import { pool, initDb, toNote, toAttachment, toUser, toShare } from './db.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// Auth / Permission helpers
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(context) {
  if (!context.userId) throw new Error('Unauthorized: please log in')
}

async function saveNotification(userId, type, message) {
  await pool.query(
    `INSERT INTO notifications (id, user_id, type, message) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [userId, type, message]
  )
}

async function getRole(noteId, userId) {
  const { rows } = await pool.query(
    'SELECT owner_id FROM notes WHERE id = $1', [noteId]
  )
  if (!rows.length) return null
  if (rows[0].owner_id === userId) return 'OWNER'

  const share = await pool.query(
    'SELECT role FROM note_shares WHERE note_id = $1 AND user_id = $2',
    [noteId, userId]
  )
  return share.rows[0]?.role ?? null
}


// ─────────────────────────────────────────────────────────────────────────────
// Pub/Sub
// ─────────────────────────────────────────────────────────────────────────────
const noteSubscribers    = new Set()
const visitorSubscribers = new Set()
let onlineCount = 0

function publishNote(event) {
  for (const cb of noteSubscribers) cb(event)
  sendWebhook(event)
}

// ── Outgoing Webhooks ────────────────────────────────────────────────────────
// Works just like Stripe: when something happens, we POST a signed JSON payload
// to a configured URL. The receiver can verify it came from us.
const WEBHOOK_URL    = process.env.WEBHOOK_URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'whsec_notes_default_secret'

async function sendWebhook(event) {
  if (!WEBHOOK_URL) return
  const payload = {
    id:        `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type:      `note.${event.action.toLowerCase()}`,   // note.created, note.updated, note.deleted
    created:   Math.floor(Date.now() / 1000),
    data:      { object: event.note },
  }

  // Sign the payload (same concept as Stripe's signature verification)
  const { createHmac } = await import('node:crypto')
  const timestamp = payload.created
  const body      = JSON.stringify(payload)
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex')

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Webhook-Signature': `t=${timestamp},v1=${signature}`,
      },
      body,
    })
    console.log(`\n📤 Webhook sent → ${payload.type}`)
    console.log(`   Event ID:  ${payload.id}`)
    console.log(`   Target:    ${WEBHOOK_URL}`)
    console.log(`   Response:  ${res.status}`)
  } catch (err) {
    console.error(`⚠️  Webhook delivery failed: ${err.message}`)
  }
}
function publishVisitorCount() {
  for (const cb of visitorSubscribers) cb(onlineCount)
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────
const typeDefs = /* GraphQL */ `

  # ── Enums ─────────────────────────────────────────────────────────────────
  # Product-driven: server owns all allowed values.
  # Sending an unknown value → schema error, resolver never runs.

  enum Priority {
    LOW
    MEDIUM
    HIGH
  }

  enum Role {
    OWNER   # created the note — full control
    EDITOR  # can read and update, cannot delete or share
    VIEWER  # read-only
  }

  # ── User type ──────────────────────────────────────────────────────────────
  type User {
    id:    ID!
    name:  String!
    email: String!
  }

  type AuthPayload {
    token: String!
    user:  User!
  }

  # ── NoteShare type ─────────────────────────────────────────────────────────
  # Represents one user's access to a note and their role.
  type NoteShare {
    noteId: ID!
    user:   User!
    role:   Role!
  }

  # Classifies what kind of study material the attachment is.
  # Enables filtering/display logic without parsing filenames.
  enum AttachmentType {
    VIDEO    # YouTube, Vimeo etc
    PDF      # downloadable document
    ARTICLE  # web article / blog post
    OTHER    # fallback
  }

  # ── Attachment type ───────────────────────────────────────────────────────
  # Sub-field of Note. Lives under its parent — no standalone query.
  # Testing target: cascade delete — remove note → attachments must be gone.
  type Attachment {
    id:             ID!
    noteId:         ID!
    filename:       String!
    mimeType:       String!
    attachmentType: AttachmentType!
    url:            String!
    sizeBytes:      Int!
    createdAt:      String!
  }

  # ── Core Note type ────────────────────────────────────────────────────────
  # attachments is a nested field — consumer decides whether to request it.
  # Consumer-driven: query notes { id title } gets no attachment data at all.
  # Consumer-driven: query notes { id title attachments { url } } gets exactly that.
  type Note {
    id:          ID!
    title:       String!
    body:        String!
    priority:    Priority!
    tags:        [String!]!
    attachments: [Attachment!]!   # nested sub-field — resolved separately
    owner:       User!            # who created the note
    sharedWith:  [NoteShare!]!    # other users with explicit access
    createdAt:   String!
    updatedAt:   String!
  }

  # ── Input types ───────────────────────────────────────────────────────────
  input CreateNoteInput {
    title:    String!      # mandatory — rejected at schema layer if absent
    body:     String!      # mandatory
    priority: Priority     # optional, defaults to LOW
    tags:     [String!]    # optional
  }

  input UpdateNoteInput {
    title:    String       # all optional — supports partial updates
    body:     String
    priority: Priority
    tags:     [String!]
  }

  input AddAttachmentInput {
    noteId:         ID!             # mandatory — must link to a parent note
    filename:       String!         # mandatory — human-readable label
    attachmentType: AttachmentType! # mandatory — enum, schema-validated
    url:            String!         # mandatory — the actual resource link
    mimeType:       String          # optional, defaults to text/plain
    sizeBytes:      Int             # optional, defaults to 0
  }

  # ── Event type ────────────────────────────────────────────────────────────
  type NoteEvent {
    action:        String!   # CREATED | UPDATED | DELETED | SHARED
    note:          Note!
    editorId:      ID        # userId who triggered the change
    sharedWithId:  ID        # userId the note was shared with (SHARED action)
    sharedUserIds: [ID!]     # userIds who had access (DELETED action)
  }

  # ── Queries ───────────────────────────────────────────────────────────────
  # hasAttachments: Boolean — existence check filter.
  # Lets consumers ask: "give me only notes that have study materials saved"
  # This is the key testable assertion:
  #   hasAttachments: true  → only notes with ≥1 attachment
  #   hasAttachments: false → only notes with 0 attachments
  type Query {
    notes(
      search:         String
      priority:       Priority
      hasAttachments: Boolean    # existence check — core test assertion
    ): [Note!]!

    note(id: ID!): Note

    # Direct attachment queries — useful for cascade delete verification
    # After deleteNote(id) → attachmentsByNote(noteId) must return []
    attachmentsByNote(noteId: ID!): [Attachment!]!

    # Returns the current user based on x-user-id header
    me: User

    # All registered users — useful for picking who to share with
    users: [User!]!

    # Unread notifications for the current user
    myNotifications: [UserNotification!]!
  }

  type UserNotification {
    id:        ID!
    type:      String!
    message:   String!
    read:      Boolean!
    createdAt: String!
  }

  # ── Mutations ─────────────────────────────────────────────────────────────
  type Mutation {
    createNote(input: CreateNoteInput!): Note!
    updateNote(id: ID!, input: UpdateNoteInput!): Note!

    # Cascade delete: removes the note AND all its attachments atomically.
    # The returned Note snapshot includes attachments at time of deletion —
    # useful for asserting what was deleted in tests.
    deleteNote(id: ID!): Note!

    addAttachment(input: AddAttachmentInput!): Attachment!
    removeAttachment(id: ID!): Attachment!

    # ── Role management ──────────────────────────────────────────────────────
    # Only OWNER can share, update permissions, or revoke access.
    shareNote(noteId: ID!, userId: ID!, role: Role!): NoteShare!
    updateNotePermission(noteId: ID!, userId: ID!, role: Role!): NoteShare!
    revokeNoteAccess(noteId: ID!, userId: ID!): NoteShare!

    # ── Auth ─────────────────────────────────────────────────────────────────
    markNotificationsRead: Boolean
    login(email: String!, password: String!): AuthPayload!
    register(name: String!, email: String!, password: String!): AuthPayload!

    # Share by email — owner types a user's email to grant access
    shareNoteByEmail(noteId: ID!, email: String!, role: Role!): NoteShare!
  }

  # ── Subscriptions ─────────────────────────────────────────────────────────
  # noteChanged fires on all note mutations including cascading deletes.
  # onlineCount tracks live WS connections — independent subscription.
  type Subscription {
    noteChanged: NoteEvent!
    onlineCount: Int!
  }
`

// ─────────────────────────────────────────────────────────────────────────────
// Resolvers
// ─────────────────────────────────────────────────────────────────────────────
const resolvers = {
  // ── Note field resolvers ─────────────────────────────────────────────────
  Note: {
    attachments: async (note) => {
      const { rows } = await pool.query(
        'SELECT * FROM attachments WHERE note_id = $1', [note.id]
      )
      return rows.map(toAttachment)
    },
    owner: async (note) => {
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE id = $1', [note.ownerId]
      )
      return rows[0] ? toUser(rows[0]) : null
    },
    sharedWith: async (note) => {
      const { rows } = await pool.query(
        `SELECT ns.*, u.id as uid, u.name, u.email
         FROM note_shares ns JOIN users u ON u.id = ns.user_id
         WHERE ns.note_id = $1`, [note.id]
      )
      return rows.map(r => ({
        noteId: r.note_id,
        user:   { id: r.uid, name: r.name, email: r.email },
        role:   r.role,
      }))
    },
  },

  Query: {
    notes: async (_, { search, priority, hasAttachments }, context) => {
      // Notes the user owns OR has been shared with
      let query = `
        SELECT DISTINCT n.* FROM notes n
        LEFT JOIN note_shares ns ON ns.note_id = n.id
        WHERE (n.owner_id = $1 OR ns.user_id = $1)
      `
      const params = [context.userId]
      let i = 2

      if (search?.trim()) {
        query += ` AND (n.title ILIKE $${i} OR n.body ILIKE $${i} OR $${i} ILIKE ANY(n.tags))`
        params.push(`%${search.trim()}%`)
        i++
      }
      if (priority) {
        query += ` AND n.priority = $${i}`
        params.push(priority)
        i++
      }
      if (hasAttachments === true) {
        query += ` AND EXISTS (SELECT 1 FROM attachments a WHERE a.note_id = n.id)`
      } else if (hasAttachments === false) {
        query += ` AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.note_id = n.id)`
      }

      const { rows } = await pool.query(query, params)
      return rows.map(toNote)
    },

    note: async (_, { id }, context) => {
      const role = await getRole(id, context.userId)
      if (!role) throw new Error(`Forbidden: you do not have access to note "${id}"`)
      const { rows } = await pool.query('SELECT * FROM notes WHERE id = $1', [id])
      return rows[0] ? toNote(rows[0]) : null
    },

    attachmentsByNote: async (_, { noteId }) => {
      const { rows } = await pool.query(
        'SELECT * FROM attachments WHERE note_id = $1', [noteId]
      )
      return rows.map(toAttachment)
    },

    me: async (_, __, context) => {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [context.userId])
      return rows[0] ? toUser(rows[0]) : null
    },

    users: async () => {
      const { rows } = await pool.query('SELECT * FROM users')
      return rows.map(toUser)
    },

    myNotifications: async (_, __, context) => {
      if (!context.userId) return []
      const { rows } = await pool.query(
        `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [context.userId]
      )
      return rows.map(r => ({ id: r.id, type: r.type, message: r.message, read: r.read, createdAt: new Date(r.created_at).toISOString() }))
    },
  },

  Mutation: {
    createNote: async (_, { input }, context) => {
      requireAuth(context)
      const { rows } = await pool.query(
        `INSERT INTO notes (id, title, body, priority, tags, owner_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
         RETURNING *`,
        [input.title, input.body, input.priority ?? 'LOW', input.tags ?? [], context.userId]
      )
      const note = toNote(rows[0])
      publishNote({ action: 'CREATED', note })
      return note
    },

    updateNote: async (_, { id, input }, context) => {
      const role = await getRole(id, context.userId)
      if (!['OWNER', 'EDITOR'].includes(role))
        throw new Error(`Forbidden: updating note "${id}" requires EDITOR or OWNER role`)

      const fields = []
      const params = []
      let i = 1
      if (input.title    != null) { fields.push(`title = $${i++}`);    params.push(input.title) }
      if (input.body     != null) { fields.push(`body = $${i++}`);     params.push(input.body) }
      if (input.priority != null) { fields.push(`priority = $${i++}`); params.push(input.priority) }
      if (input.tags     != null) { fields.push(`tags = $${i++}`);     params.push(input.tags) }
      fields.push(`updated_at = NOW()`)
      params.push(id)

      const { rows } = await pool.query(
        `UPDATE notes SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
      )
      if (!rows.length) throw new Error(`Note "${id}" not found`)
      const note = toNote(rows[0])
      publishNote({ action: 'UPDATED', note, editorId: context.userId })
      return note
    },

    deleteNote: async (_, { id }, context) => {
      const role = await getRole(id, context.userId)
      if (role !== 'OWNER')
        throw new Error(`Forbidden: only the OWNER can delete note "${id}"`)

      const { rows: noteRows } = await pool.query('SELECT * FROM notes WHERE id = $1', [id])
      if (!noteRows.length) throw new Error(`Note "${id}" not found`)

      // Capture shared user IDs before CASCADE deletes note_shares
      const { rows: shareRows } = await pool.query('SELECT user_id FROM note_shares WHERE note_id = $1', [id])
      const sharedUserIds = shareRows.map(r => r.user_id)

      await pool.query('DELETE FROM notes WHERE id = $1', [id])

      const note = toNote(noteRows[0])
      publishNote({ action: 'DELETED', note, sharedUserIds })

      // Persist notifications for shared users who may be offline
      const { rows: ownerRows } = await pool.query('SELECT name FROM users WHERE id = $1', [context.userId])
      const ownerName = ownerRows[0]?.name ?? 'Someone'
      await Promise.all(sharedUserIds.map(uid =>
        saveNotification(uid, 'DELETED', `${ownerName} deleted "${note.title}"`)
      ))
      return note
    },

    addAttachment: async (_, { input }, context) => {
      const { rows: noteRows } = await pool.query('SELECT id FROM notes WHERE id = $1', [input.noteId])
      if (!noteRows.length) throw new Error(`Note "${input.noteId}" not found`)

      const { rows } = await pool.query(
        `INSERT INTO attachments (id, note_id, filename, mime_type, attachment_type, url, size_bytes)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
        [input.noteId, input.filename, input.mimeType ?? 'text/plain',
         input.attachmentType, input.url, input.sizeBytes ?? 0]
      )
      await pool.query('UPDATE notes SET updated_at = NOW() WHERE id = $1', [input.noteId])
      const { rows: noteUpdated } = await pool.query('SELECT * FROM notes WHERE id = $1', [input.noteId])
      publishNote({ action: 'UPDATED', note: toNote(noteUpdated[0]) })
      return toAttachment(rows[0])
    },

    removeAttachment: async (_, { id }) => {
      const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [id])
      if (!rows.length) throw new Error(`Attachment "${id}" not found`)
      await pool.query('DELETE FROM attachments WHERE id = $1', [id])
      await pool.query('UPDATE notes SET updated_at = NOW() WHERE id = $1', [rows[0].note_id])
      const { rows: noteRows } = await pool.query('SELECT * FROM notes WHERE id = $1', [rows[0].note_id])
      if (noteRows.length) publishNote({ action: 'UPDATED', note: toNote(noteRows[0]) })
      return toAttachment(rows[0])
    },

    // ── Role management mutations ──────────────────────────────────────────
    shareNote: async (_, { noteId, userId, role }, context) => {
      if (await getRole(noteId, context.userId) !== 'OWNER')
        throw new Error(`Forbidden: only the OWNER can share note "${noteId}"`)

      if (userId === context.userId)
        throw new Error(`Cannot share a note with yourself`)

      const { rows: userRows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId])
      if (!userRows.length) throw new Error(`User "${userId}" not found`)

      await pool.query(
        `INSERT INTO note_shares (note_id, user_id, role) VALUES ($1, $2, $3)`,
        [noteId, userId, role]
      )
      return { noteId, user: toUser(userRows[0]), role }
    },

    updateNotePermission: async (_, { noteId, userId, role }, context) => {
      if (await getRole(noteId, context.userId) !== 'OWNER')
        throw new Error(`Forbidden: only the OWNER can update permissions on note "${noteId}"`)

      const { rows } = await pool.query(
        `UPDATE note_shares SET role = $1 WHERE note_id = $2 AND user_id = $3 RETURNING *`,
        [role, noteId, userId]
      )
      if (!rows.length) throw new Error(`User "${userId}" does not have access to note "${noteId}"`)
      const { rows: userRows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId])
      return { noteId, user: toUser(userRows[0]), role }
    },

    shareNoteByEmail: async (_, { noteId, email, role }, context) => {
      if (!context.userId) throw new Error('Unauthorized')
      if (await getRole(noteId, context.userId) !== 'OWNER')
        throw new Error('Forbidden: only the OWNER can share this note')

      const { rows: userRows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()])
      if (!userRows.length) throw new Error(`No user found with email "${email}"`)
      const targetUser = userRows[0]

      if (targetUser.id === context.userId) throw new Error('Cannot share a note with yourself')

      const existing = await pool.query(
        'SELECT 1 FROM note_shares WHERE note_id = $1 AND user_id = $2', [noteId, targetUser.id]
      )
      if (existing.rows.length) throw new Error(`${targetUser.name} already has access — update their permission instead`)

      await pool.query(
        'INSERT INTO note_shares (note_id, user_id, role) VALUES ($1, $2, $3)',
        [noteId, targetUser.id, role]
      )
      const { rows: noteRows } = await pool.query('SELECT * FROM notes WHERE id = $1', [noteId])
      if (noteRows.length) publishNote({ action: 'SHARED', note: toNote(noteRows[0]), sharedWithId: targetUser.id })

      // Persist notification for recipient (works even if offline)
      const { rows: ownerRows } = await pool.query('SELECT name FROM users WHERE id = $1', [context.userId])
      const ownerName = ownerRows[0]?.name ?? 'Someone'
      const noteTitle = noteRows[0] ? toNote(noteRows[0]).title : noteId
      await saveNotification(targetUser.id, 'SHARED', `${ownerName} shared "${noteTitle}" with you`)
      return { noteId, user: toUser(targetUser), role }
    },

    markNotificationsRead: async (_, __, context) => {
      if (!context.userId) return false
      await pool.query(`UPDATE notifications SET read = TRUE WHERE user_id = $1`, [context.userId])
      return true
    },

    login: async (_, { email, password }) => {
      const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email])
      const user = rows[0]
      if (!user) throw new Error('Invalid email or password')
      const valid = await bcrypt.compare(password, user.password_hash)
      if (!valid) throw new Error('Invalid email or password')
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' })
      return { token, user: toUser(user) }
    },

    register: async (_, { name, email, password }) => {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email])
      if (existing.rows.length) throw new Error('Email already in use')
      const hash = await bcrypt.hash(password, 10)
      const { rows } = await pool.query(
        `INSERT INTO users (id, name, email, password_hash)
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING *`,
        [name, email, hash]
      )
      const token = jwt.sign({ userId: rows[0].id }, JWT_SECRET, { expiresIn: '7d' })
      return { token, user: toUser(rows[0]) }
    },

    revokeNoteAccess: async (_, { noteId, userId }, context) => {
      if (await getRole(noteId, context.userId) !== 'OWNER')
        throw new Error(`Forbidden: only the OWNER can revoke access on note "${noteId}"`)

      const { rows } = await pool.query(
        `DELETE FROM note_shares WHERE note_id = $1 AND user_id = $2 RETURNING *`,
        [noteId, userId]
      )
      if (!rows.length) throw new Error(`User "${userId}" does not have access to note "${noteId}"`)
      const { rows: userRows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId])
      return { noteId, user: toUser(userRows[0]), role: rows[0].role }
    },
  },

  Subscription: {
    noteChanged: {
      subscribe: () =>
        new Repeater(async (push, stop) => {
          const cb = event => push(event)
          noteSubscribers.add(cb)
          await stop
          noteSubscribers.delete(cb)
        }),
      resolve: payload => payload,
    },

    onlineCount: {
      subscribe: () =>
        new Repeater(async (push, stop) => {
          onlineCount++
          publishVisitorCount()
          push(onlineCount)

          const cb = count => push(count)
          visitorSubscribers.add(cb)
          await stop
          visitorSubscribers.delete(cb)
          onlineCount = Math.max(0, onlineCount - 1)
          publishVisitorCount()
        }),
      resolve: payload => payload,
    },
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────
export function createApp() {
  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphiql: { subscriptionsProtocol: 'WS' },
    cors: { origin: '*' },
    plugins: [process.env.DD_API_KEY ? datadogPlugin() : noopPlugin()],
    context: ({ request }) => {
      const auth  = request?.headers?.get('authorization') ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (!token) return { userId: null }
      try {
        const decoded = jwt.verify(token, JWT_SECRET)
        return { userId: decoded.userId }
      } catch {
        return { userId: null }
      }
    },
  })

  // ── Stripe webhook setup ──────────────────────────────────────────────
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  // API key is required by the SDK constructor but unused for webhook verification.
  // We only call stripe.webhooks.constructEvent() which uses the webhook secret, not the API key.
  const stripe = stripeWebhookSecret ? new Stripe('sk_test_unused') : null

  const httpServer = createServer(async (req, res) => {
    // Serve frontend at root
    if (req.url === '/' && req.method === 'GET') {
      try {
        const html = await readFile(join(__dirname, 'index.html'), 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('index.html not found')
      }
      return
    }

    // Serve og.svg for social previews
    if (req.url === '/og.svg' && req.method === 'GET') {
      try {
        const svg = await readFile(join(__dirname, 'og.svg'), 'utf-8')
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' })
        res.end(svg)
      } catch {
        res.writeHead(404); res.end('not found')
      }
      return
    }

    // Handle Stripe webhook before yoga
    if (req.url === '/webhook/stripe' && req.method === 'POST') {
      if (!stripe || !stripeWebhookSecret) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'STRIPE_WEBHOOK_SECRET not configured' }))
        return
      }

      // Collect raw body (required for signature verification)
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks)

      try {
        const sig = req.headers['stripe-signature']
        const event = stripe.webhooks.constructEvent(rawBody, sig, stripeWebhookSecret)

        console.log(`\n⚡ Stripe webhook received:`)
        console.log(`   Event ID:   ${event.id}`)
        console.log(`   Type:       ${event.type}`)
        console.log(`   Created:    ${new Date(event.created * 1000).toISOString()}`)
        if (event.data?.object) {
          console.log(`   Object ID:  ${event.data.object.id ?? 'n/a'}`)
          console.log(`   Status:     ${event.data.object.status ?? 'n/a'}`)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ received: true }))
      } catch (err) {
        console.error(`⚠️  Stripe webhook error: ${err.message}`)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // ── Incoming note webhook receiver ─────────────────────────────────────
    // This is the "other side" — like YOUR server receiving Stripe events.
    // Verifies the signature, then takes automated action.
    if (req.url === '/webhook/notes' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString()

      // Verify signature (same concept as Stripe verification)
      const sigHeader = req.headers['x-webhook-signature'] || ''
      const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')))
      const { createHmac } = await import('node:crypto')
      const expected = createHmac('sha256', WEBHOOK_SECRET)
        .update(`${parts.t}.${rawBody}`)
        .digest('hex')

      if (parts.v1 !== expected) {
        console.error('⚠️  Note webhook signature mismatch — rejected')
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid signature' }))
        return
      }

      const event = JSON.parse(rawBody)
      console.log(`\n📥 Note webhook received & verified:`)
      console.log(`   Event ID:  ${event.id}`)
      console.log(`   Type:      ${event.type}`)
      console.log(`   Note:      "${event.data.object.title}"`)

      // ── Automated actions based on event type ──
      switch (event.type) {
        case 'note.created':
          console.log(`   ✅ Action:  Auto-tagged as webhook-verified`)
          break
        case 'note.updated':
          console.log(`   ✅ Action:  Change logged for audit trail`)
          break
        case 'note.deleted':
          console.log(`   ✅ Action:  Cleanup triggered`)
          break
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ received: true, action: `processed ${event.type}` }))
      return
    }

    // All other requests go to graphql-yoga
    yoga(req, res)
  })
  const wss = new WebSocketServer({ server: httpServer, path: yoga.graphqlEndpoint })

  useServer(
    {
      execute:   (args) => args.rootValue.execute(args),
      subscribe:  (args) => args.rootValue.subscribe(args),
      onSubscribe: async (ctx, msg) => {
        const { schema, execute, subscribe, contextFactory, parse, validate } = yoga.getEnveloped({
          ...ctx,
          req:    ctx.extra.request,
          socket: ctx.extra.socket,
          params: msg.payload,
        })
        const args = {
          schema,
          operationName:  msg.payload.operationName,
          document:       parse(msg.payload.query),
          variableValues: msg.payload.variables,
          contextValue:   await contextFactory(),
          rootValue:      { execute, subscribe },
        }
        const errors = validate(args.schema, args.document)
        if (errors.length) return errors
        return args
      },
    },
    wss
  )

  return { httpServer, wss }
}

// Start the server only when this file is run directly (not imported)
const isDirectRun = !process.argv[1] || import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  await initDb()
  const { httpServer } = createApp()
  const PORT = process.env.PORT || 4000
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n📝  Frontend     →  http://localhost:${PORT}/`)
    console.log(`🚀  GraphQL API  →  http://localhost:${PORT}/graphql`)
    console.log(`🔌  WebSocket    →  ws://localhost:${PORT}/graphql`)
    console.log(`🎨  GraphiQL IDE →  http://localhost:${PORT}/graphql`)
    console.log(`💳  Stripe Hook  →  http://localhost:${PORT}/webhook/stripe\n`)
    console.log(`Schema features:`)
    console.log(`  ✦  Enum              Priority { LOW | MEDIUM | HIGH }`)
    console.log(`  ✦  Enum              AttachmentType { VIDEO | PDF | ARTICLE | OTHER }`)
    console.log(`  ✦  Input types       CreateNoteInput / UpdateNoteInput / AddAttachmentInput`)
    console.log(`  ✦  Nested sub-field  Note.attachments → [Attachment!]!`)
    console.log(`  ✦  Cascade delete    deleteNote removes all child attachments`)
    console.log(`  ✦  Existence filter  notes(hasAttachments: true/false)`)
    console.log(`  ✦  Direct query      attachmentsByNote(noteId) for test assertions`)
    console.log(`  ✦  Subscriptions     noteChanged + onlineCount (multiplexed over 1 WS)\n`)
  })
}
