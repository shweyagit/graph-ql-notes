import http from 'k6/http';
import { check, sleep } from 'k6'

const BASE_URL = 'http://localhost:4000';

export const options = {
    // Datadog tags applied to every metric emitted by this test
    tags: {
        testid: 'gql-notes-smoke',
        service: 'gql-notes',
        env: __ENV.DD_ENV || 'development',
    },
    vus: 10,
    duration: '10s',
    thresholds: {
        http_req_duration: ['p(95)<100'],
        http_reqs:         ['count>20', 'rate>2.7'],
        http_req_receiving:['p(95)<400'],
        http_req_failed:   ['rate<0.1'],
        vus:               ['value>9'],
    }
}

export default function () {
    const res = http.get(BASE_URL, { tags: { endpoint: 'homepage' } });
    check(res, {
        'status is 200':  (r) => r.status === 200,
        'page is HomePage': (r) => r.body.includes('Study Notes'),
    });
    sleep(1)
}