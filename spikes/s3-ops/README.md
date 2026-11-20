# Spike S3: op rebase

Throwaway prototype. The write-up and decision are in [docs/spikes/S3-op-rebase.md](../../docs/spikes/S3-op-rebase.md).

```bash
npx vitest run spikes/s3-ops                 # example and property tests, 3,000 cases per property
RUNS=100000 npx vitest run spikes/s3-ops     # the full run quoted in the write-up
node spikes/s3-ops/src/bench.ts              # rebase timing on a 20k-row sheet (N=rows, K=ops per task)
```

A failing property prints the shrunk base state and both op sequences.
