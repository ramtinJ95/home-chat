// The service worker: shows Home Chat's push notifications and opens the conversation when one is tapped.
// A classic script, so it has no imports; the payload matches PushMessage in src/api.d.ts.
{
  const worker = self as unknown as ServiceWorkerGlobalScope;
  interface PushMessage { title: string; body: string; chat?: string }

  worker.addEventListener('install', () => { void worker.skipWaiting(); });
  worker.addEventListener('activate', event => event.waitUntil(worker.clients.claim()));

  // Every push shows a notification: Safari revokes subscriptions whose pushes stay silent.
  worker.addEventListener('push', event => {
    const message = (event.data?.json() ?? {title: 'Home Chat', body: 'Something new is waiting.'}) as PushMessage;
    event.waitUntil(worker.registration.showNotification(message.title, {
      body: message.body, icon: '/icons/icon-192.png', tag: message.chat, data: {chat: message.chat},
    }));
  });

  worker.addEventListener('notificationclick', event => {
    event.notification.close();
    const chat = (event.notification.data as {chat?: string} | null)?.chat;
    event.waitUntil((async () => {
      const [open] = await worker.clients.matchAll({type: 'window', includeUncontrolled: true});
      if (open) {
        await open.focus();
        if (chat) open.postMessage({type: 'open-chat', chat});
        return;
      }
      await worker.clients.openWindow(chat ? '/?chat=' + encodeURIComponent(chat) : '/');
    })());
  });
}
