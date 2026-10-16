// The service worker: shows Home Chat's push notifications and opens the conversation when one is tapped.
// A classic script, so it has no import statements; an inline import type adds nothing to the output.
{
  const worker = self as unknown as ServiceWorkerGlobalScope;
  type PushMessage = import('../src/api.d.ts').PushMessage;

  worker.addEventListener('install', () => { void worker.skipWaiting(); });
  worker.addEventListener('activate', event => event.waitUntil(worker.clients.claim()));

  // Every push shows a notification: Safari revokes subscriptions whose pushes stay silent.
  worker.addEventListener('push', event => {
    const message = (event.data?.json() ?? {title: 'Home Chat', body: 'Something new is waiting.'}) as PushMessage;
    // Buttons show on desktop Edge and Chrome; elsewhere a tap opens the conversation. `actions` is missing from
    // TypeScript's NotificationOptions.
    const actions = message.routine ? [{action: 'pause', title: 'Pause routine'}, {action: 'open', title: 'Open'}] : [];
    event.waitUntil(worker.registration.showNotification(message.title, {
      body: message.body, icon: '/icons/icon-192.png', tag: message.chat, data: {chat: message.chat, routine: message.routine}, actions,
    } as NotificationOptions));
  });

  worker.addEventListener('notificationclick', event => {
    event.notification.close();
    const {chat, routine} = (event.notification.data ?? {}) as {chat?: string; routine?: string};
    // Pausing needs the signed-in page (its CSRF token), so the app does it once it shows the conversation.
    const pause = event.action === 'pause' ? routine : undefined;
    event.waitUntil((async () => {
      const [open] = await worker.clients.matchAll({type: 'window', includeUncontrolled: true});
      if (open) {
        await open.focus();
        if (chat) open.postMessage({type: 'open-chat', chat, pause});
        return;
      }
      const query = new URLSearchParams({...(chat && {chat}), ...(pause && {pause})}).toString();
      await worker.clients.openWindow(query ? '/?' + query : '/');
    })());
  });
}
