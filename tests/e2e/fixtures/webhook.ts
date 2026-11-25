import { EventEmitter } from 'node:events';

export const callbackHost = 'public-callback.test';
export const callbackAddress = { address: '93.184.216.34', family: 4 };
export interface Delivery {
  url: string;
  headers: Record<string, string>;
  body: string;
  addresses: { address: string; family: number }[];
}

interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  lookup: (host: string, options: { all: true }, found: (error: Error | null, addresses: Delivery['addresses']) => void) => void;
}

export function webhookRequest(attempts: string[], deliveries: Delivery[]) {
  return (url: URL, options: RequestOptions, receive: (response: EventEmitter & { statusCode: number }) => void) => {
    attempts.push(url.href);
    const request = new EventEmitter();
    return Object.assign(request, {
      end(body: string) {
        queueMicrotask(() => {
          if (url.href !== `https://${callbackHost}/events` || options.method !== 'POST') {
            request.emit('error', new Error('Unexpected webhook endpoint'));
            return;
          }
          options.lookup(url.hostname, { all: true }, (error, addresses) => {
            if (error) {
              request.emit('error', error);
              return;
            }
            deliveries.push({ url: url.href, headers: options.headers, body, addresses });
            const payload = JSON.parse(body);
            const response = Object.assign(new EventEmitter(), { statusCode: 200 });
            receive(response);
            const output = payload.type === 'verification' ? { challenge: payload.challenge } : {};
            response.emit('data', Buffer.from(JSON.stringify(output)));
            response.emit('end');
          });
        });
      },
      destroy(error: Error) { request.emit('error', error); },
    });
  };
}
