const API = 'https://sourcebook.uk/graphql'

const TYPE_ICONS = { VIDEO: '▶', ARTICLE: '📄', PDF: '📑', OTHER: '📎' }

let selectedType = 'ARTICLE'
let currentUrl   = ''

// ── Utilities ─────────────────────────────────────────────────────────────────

function view(name) {
  ['loading','login','save','success'].forEach(v => {
    document.getElementById(`view-${v}`).style.display = v === name ? '' : 'none'
  })
}

function showErr(id, msg) {
  const el = document.getElementById(id)
  el.textContent = msg
  el.style.display = 'block'
}
function clearErr(id) {
  const el = document.getElementById(id)
  el.textContent = ''
  el.style.display = 'none'
}

async function gql(query, variables, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res  = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) })
  if (!res.ok) throw new Error(`HTTP ${res.status} — is the server running?`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

// ── Type detection ─────────────────────────────────────────────────────────────

function detectType(url) {
  if (/youtube\.com|youtu\.be|vimeo\.com/i.test(url)) return 'VIDEO'
  if (/\.pdf($|\?)/i.test(url))                        return 'PDF'
  return 'ARTICLE'
}

function setType(type) {
  selectedType = type
  document.querySelectorAll('.type-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.type === type)
  )
  document.getElementById('res-icon').textContent = TYPE_ICONS[type]
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function doLogin() {
  const email    = document.getElementById('login-email').value.trim()
  const password = document.getElementById('login-password').value
  const btn      = document.getElementById('login-btn')
  clearErr('login-error')

  if (!email || !password) {
    showErr('login-error', 'Enter your email and password.')
    return
  }

  btn.disabled = true
  btn.textContent = 'Signing in…'

  try {
    const data = await gql(
      `mutation Login($e: String!, $p: String!) {
         login(email: $e, password: $p) { token user { name email } }
       }`,
      { e: email, p: password }
    )
    await chrome.storage.local.set({ sb_token: data.login.token, sb_name: data.login.user.name })
    showSaveView()
  } catch (err) {
    showErr('login-error', err.message)
    btn.disabled    = false
    btn.textContent = 'Sign in'
  }
}

async function logout() {
  await chrome.storage.local.remove(['sb_token','sb_name'])
  view('login')
}

// ── Save view ─────────────────────────────────────────────────────────────────

async function showSaveView() {
  view('loading')

  const { sb_token } = await chrome.storage.local.get('sb_token')
  if (!sb_token) { view('login'); return }

  // Verify token is still valid
  try {
    await gql(`query { me { id } }`, {}, sb_token)
  } catch (err) {
    // Token expired or server down
    await chrome.storage.local.remove(['sb_token','sb_name'])
    view('login')
    return
  }

  // Get URL — prefer pending (from right-click), else active tab
  let url = '', title = ''
  try {
    const stored = await chrome.storage.local.get(['pendingUrl','pendingTitle','pendingTs'])
    const fresh  = stored.pendingTs && (Date.now() - stored.pendingTs < 30000)
    if (stored.pendingUrl && fresh) {
      url   = stored.pendingUrl
      title = stored.pendingTitle || ''
      chrome.storage.local.remove(['pendingUrl','pendingTitle','pendingTs'])
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      url   = tab?.url   || ''
      title = tab?.title || ''
    }
  } catch (_) {}

  // Block internal URLs
  if (/^(chrome|chrome-extension|about|edge|brave):/.test(url)) { url = ''; title = '' }

  currentUrl = url
  setType(detectType(url))
  document.getElementById('res-name-input').value         = title
  document.getElementById('res-name-display').textContent = title || url || 'No URL detected'
  document.getElementById('res-url-display').textContent  = url   || '—'

  // Load topics
  const sel = document.getElementById('topic-select')
  try {
    const data = await gql(`query { notes { id title } }`, {}, sb_token)
    const notes = data.notes || []
    if (!notes.length) {
      sel.innerHTML = '<option value="">No topics yet — create one in the app first</option>'
    } else {
      sel.innerHTML = '<option value="">— pick a topic —</option>' +
        notes.map(n => `<option value="${n.id}">${n.title}</option>`).join('')
    }
  } catch (err) {
    sel.innerHTML = `<option value="">— failed to load topics —</option>`
    console.error('Topics error:', err)
  }

  view('save')
}

// ── Save ─────────────────────────────────────────────────────────────────────

async function doSave() {
  const noteId   = document.getElementById('topic-select').value
  const filename = document.getElementById('res-name-input').value.trim()
  const btn      = document.getElementById('save-btn')
  clearErr('save-error')

  if (!noteId)    { showErr('save-error', 'Please select a topic.'); return }
  if (!currentUrl){ showErr('save-error', 'No URL — open a page first.'); return }
  if (!filename)  { showErr('save-error', 'Please enter a resource name.'); return }

  btn.disabled    = true
  btn.textContent = 'Saving…'

  const { sb_token } = await chrome.storage.local.get('sb_token')

  try {
    await gql(
      `mutation Add($input: AddAttachmentInput!) { addAttachment(input: $input) { id } }`,
      { input: { noteId, filename, attachmentType: selectedType, url: currentUrl, sizeBytes: 0 } },
      sb_token
    )
    const topicName = document.getElementById('topic-select').selectedOptions[0]?.text || 'your topic'
    document.getElementById('success-sub').textContent = `Saved to "${topicName}"`
    view('success')
    setTimeout(() => window.close(), 1800)
  } catch (err) {
    showErr('save-error', err.message)
    btn.disabled    = false
    btn.textContent = 'Save to Sourcebook'
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  // Wire all event listeners here — no inline handlers allowed in MV3
  document.getElementById('login-btn').addEventListener('click', doLogin)
  document.getElementById('save-btn').addEventListener('click', doSave)
  document.getElementById('logout-btn').addEventListener('click', logout)

  document.querySelectorAll('.type-pill').forEach(btn => {
    btn.addEventListener('click', () => setType(btn.dataset.type))
  })

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('view-login').style.display !== 'none') doLogin()
  })

  const { sb_token } = await chrome.storage.local.get('sb_token')
  sb_token ? showSaveView() : view('login')
}

document.addEventListener('DOMContentLoaded', init)
