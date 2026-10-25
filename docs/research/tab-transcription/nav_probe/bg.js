// 量測用的最小插件：點圖示開始錄那個分頁；nav_probe.mjs 透過 CDP 呼叫下面的函式。
let tabId = null;

chrome.action.onClicked.addListener(async (tab) => {
  if (tabId !== null) return; // 錄音中在別的分頁點圖示：只拿到那個分頁的 activeTab
  tabId = tab.id;
  await chrome.offscreen.createDocument({ url: 'off.html', reasons: ['USER_MEDIA'], justification: 'probe' }).catch(() => {});
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await chrome.runtime.sendMessage({ target: 'off', type: 'start', streamId });
});

// 錄音軌狀態、上次呼叫以來的最大音量，和現在能不能注入程式到被錄的分頁。
globalThis.probe = async () => {
  const level = await chrome.runtime.sendMessage({ target: 'off', type: 'level' });
  let inject;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href });
    inject = `ok ${r.result}`;
  } catch (e) {
    inject = `err ${e.message}`;
  }
  return { ...level, inject };
};
globalThis.capture = async (id) => {
  try {
    await chrome.tabCapture.getMediaStreamId({ targetTabId: id });
    return 'ok';
  } catch (e) {
    return `err ${e.message}`;
  }
};
globalThis.activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id;
