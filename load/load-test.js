import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL = 'http://localhost:4000/graphql';

const headers = {
    'Content-Type': 'application/json',
};

// Custom metrics — appear in Datadog under k6.* namespace
const graphqlErrors   = new Counter('graphql_errors');
const graphqlDuration = new Trend('graphql_op_duration', true);  // true = milliseconds
const graphqlErrorRate = new Rate('graphql_error_rate');

// ── QUERIES ──────────────────────────────────────────
const GET_NOTES = `
  query GetNotes($hasAttachments: Boolean, $priority: Priority, $search: String) {
    notes(hasAttachments: $hasAttachments, priority: $priority, search: $search) {
      id
      title
      body
      priority
      createdAt
    }
  }
`;

const GET_NOTE = `
  query GetNote($id: ID!) {
    note(id: $id) {
      id
      title
      body
      priority
      createdAt
    }
  }
`;

// ── ERROR-GENERATING MUTATIONS ────────────────────────
// These target non-existent IDs so the resolver throws, producing real GraphQL errors
const DELETE_MISSING_NOTE = `
  mutation DeleteMissing($id: ID!) {
    deleteNote(id: $id) { id title }
  }
`;

const UPDATE_MISSING_NOTE = `
  mutation UpdateMissing($id: ID!) {
    updateNote(id: $id, input: { title: "ghost" }) { id title }
  }
`;

// ── OPTIONS ───────────────────────────────────────────
export const options = {
    // Datadog tags applied to every metric emitted by this test
    tags: {
        testid: 'gql-notes-load',
        service: 'gql-notes',
        env: __ENV.DD_ENV || 'development',
    },
    scenarios: {
        get_notes_load: {
            executor: 'ramping-vus',
            startVUs: 2,
            stages: [
                { duration: '15s', target: 100 },
                { duration: '30s', target:5000 },
                { duration: '30s', target: 5000 },
                { duration: '20s', target: 100},
            ],
        },
    },
    thresholds: {
        http_req_duration:  ['p(95)<500'],   // 95th percentile under 500 ms
        http_req_failed:    ['rate<0.01'],   // error rate under 1 %
        graphql_error_rate: ['rate<0.01'],   // GraphQL-level errors under 1 %
    },
};

// ── HELPERS ───────────────────────────────────────────
function graphqlPost(query, variables, operationName) {
    return http.post(
        BASE_URL,
        JSON.stringify({ query, variables }),
        {
            headers,
            tags: { operation: operationName || 'anonymous' },
        }
    );
}

function checkGraphQL(res, label, operationName) {
    const start = Date.now();
    let hasErrors = false;

    try {
        const body = JSON.parse(res.body);
        hasErrors = Array.isArray(body.errors) && body.errors.length > 0;
        if (hasErrors) {
            graphqlErrors.add(1, { operation: operationName || label });
        }
    } catch (_) {
        hasErrors = true;
        graphqlErrors.add(1, { operation: operationName || label, reason: 'parse_error' });
    }

    graphqlErrorRate.add(hasErrors);
    graphqlDuration.add(res.timings.duration, { operation: operationName || label });

    check(res, {
        [`${label} — status 200`]: (r) => r.status === 200,
        [`${label} — no errors`]:  () => !hasErrors,
    });
}

// ── TEST SCENARIOS ────────────────────────────────────
export default function () {
    const scenario = Math.random();

    if (scenario < 0.4) {
        // 40% — get all notes, no filters
        const res = graphqlPost(GET_NOTES, {}, 'GetNotes');
        checkGraphQL(res, 'GetNotes — no filter', 'GetNotes');

    } else if (scenario < 0.6) {
        // 20% — filter by priority
        const priorities = ['LOW', 'MEDIUM', 'HIGH'];
        const priority = priorities[Math.floor(Math.random() * priorities.length)];
        const res = graphqlPost(GET_NOTES, { priority }, 'GetNotesByPriority');
        checkGraphQL(res, `GetNotes — priority ${priority}`, 'GetNotesByPriority');

    } else if (scenario < 0.75) {
        // 15% — filter by hasAttachments
        const res = graphqlPost(GET_NOTES, { hasAttachments: true }, 'GetNotesWithAttachments');
        checkGraphQL(res, 'GetNotes — hasAttachments', 'GetNotesWithAttachments');

    } else if (scenario < 0.9) {
        // 15% — search
        const terms = ['meeting', 'todo', 'important', 'review'];
        const search = terms[Math.floor(Math.random() * terms.length)];
        const res = graphqlPost(GET_NOTES, { search }, 'GetNotesBySearch');
        checkGraphQL(res, 'GetNotes — search', 'GetNotesBySearch');

    } else if (scenario < 0.95) {
        // 5% — get single note by ID
        const res = graphqlPost(GET_NOTE, { id: '1' }, 'GetNote');
        checkGraphQL(res, 'GetNote — by ID', 'GetNote');

    } else if (scenario < 0.975) {
        // 2.5% — delete non-existent note → resolver throws → real GraphQL error
        const res = graphqlPost(DELETE_MISSING_NOTE, { id: '99999' }, 'DeleteMissingNote');
        checkGraphQL(res, 'DeleteNote — not found', 'DeleteMissingNote');

    } else {
        // 2.5% — update non-existent note → resolver throws → real GraphQL error
        const res = graphqlPost(UPDATE_MISSING_NOTE, { id: '99999' }, 'UpdateMissingNote');
        checkGraphQL(res, 'UpdateNote — not found', 'UpdateMissingNote');
    }

    sleep(2);
}