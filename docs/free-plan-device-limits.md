# How many devices one send reaches on the free plan

Two Cloudflare limits apply to a single `POST /push/send`, because the whole fan-out happens
inside one Worker invocation.

## Subrequests

Every push POST is an external `fetch`, and the free plan allows 50 of those per invocation,
so **a free-plan send tops out at 50 devices.** Past the 50th, the remaining sends fail into
`failures` and `delivered` says honestly how far the fan-out got. KV traffic is metered
separately, as internal-service calls with a 1,000-per-request budget on free, which this
arithmetic never approaches.

On the paid plan the limit is 10,000 and configurable beyond that, which moves the ceiling
out of a personal deployment's range entirely.

## CPU

`/push/send` does one ES256 signature and one aes128gcm encryption per subscription, all in
one invocation, against the free plan's 10 ms CPU budget. Measured against local `workerd`
(`wrangler dev`) on an Apple M2 Max, median of 41 requests per row, with the identical request
minus the per-subscription crypto subtracted so what is left is the fan-out itself:

| subscriptions | fan-out CPU |
|---|---|
| 1 | 0.12 ms |
| 5 | 0.65 ms |
| 20 | 2.4 ms |
| 50 | 6.1 ms |
| 100 | 11.9 ms |

It is linear: about 0.12 ms per subscription on top of roughly 0.2 ms of fixed work. The
crypto alone crosses 10 ms at around 80 subscriptions on that desktop CPU, and Cloudflare's
edge hardware is generally slower per core, so on the free plan the CPU ceiling lands in the
same region as the subrequest one.

The failure modes differ, and that difference matters more than the numbers. Running out of
subrequests still returns an honest `SendResult`. Running out of CPU terminates the invocation
partway through the loop and returns an error, so the `delivered` count that would have told
you what happened is gone.

## The short version

**The free plan is comfortable to about 20 devices, has real margin to 50, and 50 is the hard
edge** — set by subrequests, with CPU close behind. Past that the paid plan is required, and
it is the plan rather than the code that is the limit.

There is deliberately no batching of the fan-out across invocations. Splitting it would trade
a limit you can read off a table for a partial-delivery failure mode you would have to debug,
and the honest fix for "more devices than the free plan allows" is a plan that allows more.
