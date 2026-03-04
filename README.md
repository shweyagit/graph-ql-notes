# Notes — GraphQL + WebSocket

A minimal full-stack app with one entity (Note), full CRUD, and real-time subscriptions over WebSocket.

## Stack
- **Backend**: Node.js + `graphql-yoga` + `graphql-ws` + `ws`
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **Protocol**: `graphql-transport-ws` over WebSocket

## Setup

```bash
npm install
npm start
```

Then open `index.html` in your browser (double-click or use Live Server).

## API

**Endpoint**: `http://localhost:4000/graphql`
**WebSocket**: `ws://localhost:4000/graphql`
**GraphiQL IDE**: http://localhost:4000/graphql

### Schema

```graphql
type Note {
  id: ID!
  title: String!
  body: String!
  createdAt: String!
  updatedAt: String!
}

type NoteEvent {
  action: String!   # CREATED | UPDATED | DELETED
  note: Note!
}

# Queries
notes: [Note!]!
note(id: ID!): Note

# Mutations
createNote(title: String!, body: String!): Note!
updateNote(id: ID!, title: String, body: String): Note!
deleteNote(id: ID!): Note!

# Subscription
noteChanged: NoteEvent!
```

## Test with the playground

Open two browser tabs with `index.html`. Create/edit/delete in one tab and watch the other update live via WebSocket subscription.

You can also test using the GQL+WS Playground HTML file with:
- Endpoint: `http://localhost:4000/graphql`
- WS URL: `ws://localhost:4000/graphql`
