// Sourcebook Service Worker
const CACHE = 'sourcebook-v2'
const PRECACHE = ['/', '/manifest.json']

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)

  // Bypass for non-GET, GraphQL, and webhooks
  if (request.method !== 'GET') return
  if (url.pathname.startsWith('/graphql')) return
  if (url.pathname.startsWith('/webhook')) return

  // Navigation requests (including share target /?...) → cached index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/').then(cached => cached || fetch(request))
    )
    return
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response
        const clone = response.clone()
        caches.open(CACHE).then(cache => cache.put(request, clone))
        return response
      })
    })
  )
})
