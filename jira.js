import 'dotenv/config';

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = process.env;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) {
  console.error('Missing required env vars. Copy .env.example to .env and fill in your Jira credentials.');
  process.exit(1);
}

const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

async function jiraFetch(path, options = {}) {
  const url = `${JIRA_BASE_URL.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Basic ${AUTH}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API error ${res.status} for ${path}: ${body}`);
  }
  return res.json();
}

async function jiraSearch(jql, fields = ['summary', 'status']) {
  const data = await jiraFetch('/rest/api/3/search/jql', {
    method: 'POST',
    body: { jql, maxResults: 50, fields },
  });
  return data.issues;
}

async function getProject() {
  const project = await jiraFetch(`/rest/api/3/project/${JIRA_PROJECT_KEY}`);
  return {
    name: project.name,
    key: project.key,
    description: project.description,
    lead: project.lead?.displayName ?? 'Unknown',
    category: project.projectCategory?.name ?? 'None',
  };
}

async function getIssues() {
  const jql = `project=${JIRA_PROJECT_KEY} ORDER BY created DESC`;
  const issues = await jiraSearch(jql, ['summary', 'status', 'issuetype', 'assignee', 'priority']);
  return issues.map((issue) => ({
    key: issue.key,
    type: issue.fields.issuetype?.name ?? 'Unknown',
    summary: issue.fields.summary,
    status: issue.fields.status?.name ?? 'Unknown',
    assignee: issue.fields.assignee?.displayName ?? 'unassigned',
    priority: issue.fields.priority?.name ?? 'None',
  }));
}

async function getEpics() {
  const jql = `project=${JIRA_PROJECT_KEY} AND issuetype=Epic ORDER BY created DESC`;
  const issues = await jiraSearch(jql, ['summary', 'status']);
  return issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status?.name ?? 'Unknown',
  }));
}

async function getSprints() {
  // First find the board for this project
  const boardData = await jiraFetch(`/rest/agile/1.0/board?projectKeyOrId=${JIRA_PROJECT_KEY}`);
  if (!boardData.values?.length) {
    return [];
  }
  const boardId = boardData.values[0].id;
  const sprintData = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future`);
  return (sprintData.values ?? []).map((sprint) => ({
    name: sprint.name,
    state: sprint.state,
    startDate: sprint.startDate ?? null,
    endDate: sprint.endDate ?? null,
  }));
}

async function main() {
  console.log('Fetching Jira data...\n');

  // If project key doesn't resolve, list available projects to help the user
  try {
    await jiraFetch(`/rest/api/3/project/${JIRA_PROJECT_KEY}`);
  } catch {
    console.log(`Project key "${JIRA_PROJECT_KEY}" not found. Listing available projects:\n`);
    try {
      const projects = await jiraFetch('/rest/api/3/project');
      for (const p of projects) {
        console.log(`   - ${p.key}: ${p.name}`);
      }
    } catch (e) {
      console.log(`   Could not list projects: ${e.message}`);
    }
    console.log('\nUpdate JIRA_PROJECT_KEY in .env and try again.');
    return;
  }

  const [project, issues, epics, sprints] = await Promise.allSettled([
    getProject(),
    getIssues(),
    getEpics(),
    getSprints(),
  ]);

  // Project info
  if (project.status === 'fulfilled') {
    const p = project.value;
    console.log(`📋 Project: ${p.name} (${p.key})`);
    console.log(`   Lead: ${p.lead}`);
    console.log(`   Category: ${p.category}`);
    if (p.description) console.log(`   Description: ${typeof p.description === 'string' ? p.description : JSON.stringify(p.description)}`);
  } else {
    console.log(`📋 Project: Failed to fetch — ${project.reason.message}`);
  }

  console.log('');

  // Sprints
  if (sprints.status === 'fulfilled') {
    const active = sprints.value.filter((s) => s.state === 'active');
    const future = sprints.value.filter((s) => s.state === 'future');
    if (active.length) {
      for (const s of active) {
        const dates = s.startDate && s.endDate
          ? ` (${s.startDate.slice(0, 10)} - ${s.endDate.slice(0, 10)})`
          : '';
        console.log(`🏃 Active Sprint: ${s.name}${dates}`);
      }
    } else {
      console.log('🏃 No active sprints');
    }
    if (future.length) {
      console.log(`   ${future.length} future sprint(s): ${future.map((s) => s.name).join(', ')}`);
    }
  } else {
    console.log(`🏃 Sprints: Failed to fetch — ${sprints.reason.message}`);
  }

  console.log('');

  // Epics
  if (epics.status === 'fulfilled') {
    const list = epics.value;
    console.log(`📌 Epics (${list.length}):`);
    if (list.length === 0) {
      console.log('   No epics found');
    }
    for (const e of list) {
      console.log(`   - ${e.key}: ${e.summary} [${e.status}]`);
    }
  } else {
    console.log(`📌 Epics: Failed to fetch — ${epics.reason.message}`);
  }

  console.log('');

  // Issues
  if (issues.status === 'fulfilled') {
    const list = issues.value;
    console.log(`📝 Issues (${list.length}):`);
    if (list.length === 0) {
      console.log('   No issues found');
    }
    for (const i of list) {
      console.log(`   - ${i.key} [${i.type}] ${i.summary} — ${i.status} (${i.assignee})`);
    }
  } else {
    console.log(`📝 Issues: Failed to fetch — ${issues.reason.message}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
