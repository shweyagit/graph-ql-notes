import { createServer } from 'node:http'
import { createSchema, createYoga, Repeater } from 'graphql-yoga'
import { useServer } from 'graphql-ws/lib/use/ws'
import { WebSocketServer } from 'ws'

// ─────────────────────────────────────────────────────────────────────────────
// In-memory store
// ─────────────────────────────────────────────────────────────────────────────
let notes = [
  {
    id: '1',
    title: 'GraphQL Schema Design',
    body: 'Product-driven schemas define the contract from the server side using strict input types, enums, and non-null constraints.',
    priority: 'HIGH',
    tags: ['graphql', 'schema', 'api-design'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: '2',
    title: 'Consumer-Driven Contracts',
    body: 'Clients declare exactly the fields they need. The server must satisfy those field-level contracts without breaking changes.',
    priority: 'MEDIUM',
    tags: ['graphql', 'consumer-driven', 'contracts'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: '3',
    title: 'WebSocket Subscriptions',
    body: 'Real-time events over a single persistent connection. One WS can multiplex multiple subscriptions simultaneously.',
    priority: 'LOW',
    tags: ['websocket', 'real-time', 'subscriptions'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

// Attachments are stored separately and linked by noteId.
// This is intentional — it makes cascading delete testable:
// delete a note → query attachments by noteId → must return []
let attachments = [
  {
    id: 'a1',
    noteId: '1',
    filename: 'GraphQL Schema Design Patterns',
    mimeType: 'video/youtube',
    attachmentType: 'VIDEO',
    url: 'https://www.youtube.com/watch?v=BcLNfwF04Kw',
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'a2',
    noteId: '1',
    filename: 'GraphQL Best Practices — Apollo Docs',
    mimeType: 'text/html',
    attachmentType: 'ARTICLE',
    url: 'https://www.apollographql.com/docs/apollo-server/schema/schema/',
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'a3',
    noteId: '2',
    filename: 'Pact Contract Testing Guide.pdf',
    mimeType: 'application/pdf',
    attachmentType: 'PDF',
    url: 'https://docs.pact.io',
    sizeBytes: 204800,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'a4',
    noteId: '3',
    filename: 'WebSockets in 100 Seconds',
    mimeType: 'video/youtube',
    attachmentType: 'VIDEO',
    url: 'https://www.youtube.com/watch?v=1BfCnjr_Vjg',
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
  },
]

let nextNoteId       = 4
let nextAttachmentId = 5

// ─────────────────────────────────────────────────────────────────────────────
// Pub/Sub
// ─────────────────────────────────────────────────────────────────────────────
const noteSubscribers    = new Set()
const visitorSubscribers = new Set()
let onlineCount = 0

function publishNote(event) {
  for (const cb of noteSubscribers) cb(event)
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
    action: String!   # CREATED | UPDATED | DELETED
    note:   Note!
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
  // ── Note field resolver for attachments ─────────────────────────────────
  // This is what makes attachments a true nested/sub-field.
  // GraphQL calls this resolver only when the consumer requests attachments.
  // Consumer-driven: if client doesn't ask for attachments, this never runs.
  Note: {
    attachments: (note) => attachments.filter(a => a.noteId === note.id),
  },

  Query: {
    notes: (_, { search, priority, hasAttachments }) => {
      let result = notes

      if (search && search.trim()) {
        const q = search.toLowerCase()
        result = result.filter(n =>
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q)  ||
          n.tags.some(t => t.toLowerCase().includes(q))
        )
      }

      if (priority) {
        result = result.filter(n => n.priority === priority)
      }

      // hasAttachments existence check
      // true  → only notes that have at least 1 attachment
      // false → only notes with no attachments at all
      if (hasAttachments === true) {
        result = result.filter(n => attachments.some(a => a.noteId === n.id))
      } else if (hasAttachments === false) {
        result = result.filter(n => !attachments.some(a => a.noteId === n.id))
      }

      return result
    },

    note: (_, { id }) => notes.find(n => n.id === id) ?? null,

    // Direct query for cascade delete verification in tests
    attachmentsByNote: (_, { noteId }) =>
      attachments.filter(a => a.noteId === noteId),
  },

  Mutation: {
    createNote: (_, { input }) => {
      const note = {
        id:        String(nextNoteId++),
        title:     input.title,
        body:      input.body,
        priority:  input.priority ?? 'LOW',
        tags:      input.tags ?? [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      notes.push(note)
      publishNote({ action: 'CREATED', note })
      return note
    },

    updateNote: (_, { id, input }) => {
      const idx = notes.findIndex(n => n.id === id)
      if (idx === -1) throw new Error(`Note "${id}" not found`)
      notes[idx] = {
        ...notes[idx],
        ...(input.title    != null && { title:    input.title }),
        ...(input.body     != null && { body:     input.body }),
        ...(input.priority != null && { priority: input.priority }),
        ...(input.tags     != null && { tags:     input.tags }),
        updatedAt: new Date().toISOString(),
      }
      publishNote({ action: 'UPDATED', note: notes[idx] })
      return notes[idx]
    },

    deleteNote: (_, { id }) => {
      const idx = notes.findIndex(n => n.id === id)
      if (idx === -1) throw new Error(`Note "${id}" not found`)

      // Snapshot note with its attachments BEFORE deletion
      // so the subscription event carries full context
      const deletedNote = {
        ...notes[idx],
        _attachmentsAtDeletion: attachments.filter(a => a.noteId === id),
      }

      // ── Cascade delete ───────────────────────────────────────────────────
      // Remove all attachments belonging to this note first.
      // After this line: attachmentsByNote(noteId: id) must return []
      attachments = attachments.filter(a => a.noteId !== id)

      // Then remove the note itself
      notes.splice(idx, 1)

      publishNote({ action: 'DELETED', note: deletedNote })
      return deletedNote
    },

    addAttachment: (_, { input }) => {
      const note = notes.find(n => n.id === input.noteId)
      if (!note) throw new Error(`Note "${input.noteId}" not found`)

      const attachment = {
        id:             `a${nextAttachmentId++}`,
        noteId:         input.noteId,
        filename:       input.filename,
        mimeType:       input.mimeType ?? 'text/plain',
        attachmentType: input.attachmentType,
        url:            input.url,
        sizeBytes:      input.sizeBytes ?? 0,
        createdAt:      new Date().toISOString(),
      }
      attachments.push(attachment)

      // Update note's updatedAt so consumers know it changed
      const noteIdx = notes.findIndex(n => n.id === input.noteId)
      notes[noteIdx].updatedAt = new Date().toISOString()
      publishNote({ action: 'UPDATED', note: notes[noteIdx] })

      return attachment
    },

    removeAttachment: (_, { id }) => {
      const idx = attachments.findIndex(a => a.id === id)
      if (idx === -1) throw new Error(`Attachment "${id}" not found`)
      const [deleted] = attachments.splice(idx, 1)

      // Reflect the change on the parent note
      const noteIdx = notes.findIndex(n => n.id === deleted.noteId)
      if (noteIdx !== -1) {
        notes[noteIdx].updatedAt = new Date().toISOString()
        publishNote({ action: 'UPDATED', note: notes[noteIdx] })
      }

      return deleted
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
const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  graphiql: { subscriptionsProtocol: 'WS' },
  cors: { origin: '*' },
})

const httpServer = createServer(yoga)
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

const PORT = process.env.PORT || 4000
httpServer.listen(PORT, () => {
  console.log(`\n🚀  GraphQL API  →  http://localhost:${PORT}/graphql`)
  console.log(`🔌  WebSocket    →  ws://localhost:${PORT}/graphql`)
  console.log(`🎨  GraphiQL IDE →  http://localhost:${PORT}/graphql\n`)
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
