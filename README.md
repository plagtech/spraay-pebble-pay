# Spraay Pay for Pebble

A PebbleOS watchapp for approving or denying [x402](https://www.x402.org/) USDC payments on Base from your wrist. Part of [Spraay Device Pay](https://github.com/plagtech/spraay-device-pay).

Runs on all Pebble platforms: aplite, basalt, chalk, diorite, and emery.

## How it works

```text
 Polling endpoint        Phone (PebbleKit JS)             Watch (C)
       │  pending x402         │                              │
       ├──────────────────────►│  amount, service, URL        │
       │                       ├─────────────────────────────►│  UP = Approve
       │                       │  decision                    │  DOWN = Deny
 Payment endpoint              │◄─────────────────────────────┤
       │  on approval only     │                              │
       │◄──────────────────────┤                              │
       ├──────────────────────►│  Payment sent / Denied       │
       │  result               ├─────────────────────────────►│
```

- **Watchapp** (`src/c/main.c`) shows each request, sends your decision, shows the result, and keeps the last 5 payments in a scrollable list. That list is the app's home screen.
- **Companion** (`src/pkjs/index.js`) polls for requests, relays them to the watch, calls the payment endpoint on approval, and keeps a log of the last 50 on the phone.

The companion holds no private keys. Your payment endpoint does the wallet signing.

PebbleKit JS only runs while the watchapp is open, and a phone cannot receive webhooks directly. Requests are collected by polling every 10 seconds while the app is open, so a webhook source needs a service that stores its requests for the polling endpoint.

## Build

Requires the Pebble SDK, or Docker as shown below.

```sh
pebble build
pebble install --emulator basalt
```

Or with no local SDK, using Docker:

```sh
docker run --rm -v "$PWD:/pebble" -w /pebble rebble/pebble-sdk pebble build
```

To install on a watch, enable the developer connection in the Pebble phone app:

```sh
pebble install --phone <phone-ip>
```

## Settings

Open the app's settings in the Pebble phone app, or run `pebble emu-app-config` in the emulator.

| Setting             | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| Polling endpoint    | Returns pending payment requests.                                           |
| Payment endpoint    | Signs and settles an approved payment.                                      |
| API token           | Optional. Sent to both as `Authorization: Bearer <token>`.                  |
| Allow Base Sepolia  | Accepts testnet payments. They are labeled `TEST` on the watch.             |

Endpoints must use HTTPS. Plain HTTP is allowed only for `localhost`, `127.0.0.1`, and `10.0.2.2`, for local development. The token is stored unencrypted in the phone app's storage, so use one that can only reach these two endpoints.

## Endpoint contract

### Polling: `GET <polling endpoint>`

Returns `204`, or `200` with a list of pending requests:

```json
{
  "requests": [
    {
      "id": "req_123",
      "url": "https://api.example.com/v1/data",
      "service": "Example Data",
      "challenge": {
        "x402Version": 2,
        "accepts": [
          {
            "scheme": "exact",
            "network": "eip155:8453",
            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "amount": "250000",
            "payTo": "0xRecipient"
          }
        ]
      }
    }
  ]
}
```

`challenge` is the x402 `PaymentRequired` body. `service` is optional and defaults to the URL's host. Each `id` must be unique, because a request is shown only once. A denied request is dropped on the phone and the server is not told, so expire unanswered requests on the server.

### Payment: `POST <payment endpoint>`

Sent only after an explicit approval, and never retried. The `Idempotency-Key` header carries the request `id`.

```json
{
  "id": "req_123",
  "url": "https://api.example.com/v1/data",
  "requirement": { "scheme": "exact", "network": "eip155:8453", "amount": "250000" },
  "challenge": {}
}
```

`requirement` is the exact entry the user approved. Pay that one and no other.

| Response                                                     | Shown on the watch |
| ------------------------------------------------------------ | ------------------ |
| 2xx with `{ "status": "settled", "txHash": "0x..." }`        | Payment sent       |
| 2xx with `{ "status": "failed" }`, or any 4xx except 408     | Payment failed     |
| Anything else, including a timeout or a 5xx                  | Status unknown     |

## Safety behavior

- **The amount comes from the challenge.** Only `exact` USDC at the pinned contract on Base is accepted, and the cheapest match is used. A request with no match is rejected.
- **Amounts are never truncated.** One too long to display is rejected.
- **Silence is a denial.** A request unanswered for 60 seconds is denied, and so is the Back button.
- **A decision applies only to the request on screen.** Each one carries that request's ID.
- **Approve ignores presses in the first 750 ms,** in case a press was under way when the request appeared.
- **A request is shown once and paid at most once.** An unclear outcome is shown as unknown instead of being retried.
- **The endpoint is trusted.** The service name and URL shown come from the polling endpoint, and the payment endpoint holds the signing authority. It should enforce its own spending limits and verify the recipient, for example with `PolicyEngine` from Spraay Device Pay.

## License

[MIT](./LICENSE) © Plagtech
