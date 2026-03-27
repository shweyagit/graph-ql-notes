chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-to-sourcebook',
    title: 'Save to Sourcebook',
    contexts: ['page', 'link']
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save-to-sourcebook') return
  const url   = info.linkUrl || info.pageUrl
  const title = tab?.title || ''
  // Store in local so popup can pick it up when user clicks the icon
  chrome.storage.local.set({ pendingUrl: url, pendingTitle: title, pendingTs: Date.now() })
})
