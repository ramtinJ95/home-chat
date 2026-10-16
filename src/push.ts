import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import type { PushMessage, User } from './api.d.ts';
import { atomicJson, readJson, serialSave } from './files.ts';
import type { PushSubscriptionInput } from './policy.ts';

interface StoredSubscription extends PushSubscriptionInput { user: User }
interface VapidKeys { publicKey: string; privateKey: string }

// More devices than a household has; the oldest goes first.
const MAX_DEVICES = 10;

// Web Push for every signed-in device. The VAPID key pair identifies this server to the push services; it is made on
// first start and kept on the data volume, so subscriptions survive restarts and rebuilds.
export async function createPush(directory: string, subject: string, send: typeof fetch = fetch) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const vapidPath = join(directory, 'vapid.json');
  const subscriptionsPath = join(directory, 'subscriptions.json');
  let vapid = await readJson<VapidKeys>(vapidPath);
  if (!vapid) { vapid = webpush.generateVAPIDKeys(); await atomicJson(vapidPath, vapid); }
  const keys = vapid;
  let subscriptions = await readJson<StoredSubscription[]>(subscriptionsPath) ?? [];
  const save = serialSave(subscriptionsPath, () => subscriptions);

  async function deliver(subscription: StoredSubscription, message: PushMessage): Promise<void> {
    // web-push only builds the encrypted, signed request; fetch sends it, so it goes through the egress proxy like
    // every other outgoing request.
    const request = webpush.generateRequestDetails(subscription, JSON.stringify(message),
      {vapidDetails: {subject, ...keys}, TTL: 24 * 60 * 60, urgency: 'high'});
    // fetch sets Content-Length itself from the body.
    const {'Content-Length': _length, ...headers} = request.headers;
    const response = await send(request.endpoint, {method: request.method, headers, body: request.body && new Uint8Array(request.body),
      signal: AbortSignal.timeout(10_000)});
    // 404 and 410 mean the browser dropped this subscription for good.
    if (response.status === 404 || response.status === 410) {
      subscriptions = subscriptions.filter(item => item.endpoint !== subscription.endpoint);
      await save();
    } else if (!response.ok) {
      // Endpoints are capability URLs and stay out of the log.
      console.warn(`Push delivery failed (HTTP ${response.status})`);
    }
  }

  return {
    publicKey: keys.publicKey,
    // The app re-sends its subscription on every load; only a device new to this user gets the confirmation.
    async subscribe(user: User, subscription: PushSubscriptionInput): Promise<void> {
      const existing = subscriptions.find(item => item.endpoint === subscription.endpoint);
      if (existing?.user === user && existing.keys.auth === subscription.keys.auth && existing.keys.p256dh === subscription.keys.p256dh) return;
      // A device that changes hands is the new user's alone.
      const others = subscriptions.filter(item => item.endpoint !== subscription.endpoint);
      const mine = others.filter(item => item.user === user);
      const added = {...subscription, user};
      subscriptions = [...others.filter(item => item.user !== user), ...mine.slice(-(MAX_DEVICES - 1)), added];
      await save();
      if (existing?.user !== user) {
        deliver(added, {title: 'Notifications are on', body: 'Home Chat will tell you here when a reply is ready.'})
          .catch(() => console.warn('Push delivery failed'));
      }
    },
    async unsubscribe(user: User, endpoint: string): Promise<void> {
      subscriptions = subscriptions.filter(item => !(item.user === user && item.endpoint === endpoint));
      await save();
    },
    // A notification that cannot be delivered never fails the turn that caused it.
    notify(user: User, message: PushMessage): void {
      for (const subscription of subscriptions.filter(item => item.user === user)) {
        deliver(subscription, message).catch(() => console.warn('Push delivery failed'));
      }
    },
  };
}
