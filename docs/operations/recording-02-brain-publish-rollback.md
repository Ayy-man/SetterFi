# Recording shot list — Publish and roll back the Brain

**State: Recording required.** This file is an executable shot list, not evidence that a recording
exists.

## Shots

1. Open the Brain draft and read the complete diff.
2. Run the safety and regression suites against the draft evidence.
3. Publish with the required reason and show the persisted version and audit receipt.
4. Open the generated trace on the changed behavior.
5. Roll back through the registered action and show the restored snapshot and audit receipt.

## Proof before accepting the recording

- The recording distinguishes checker evidence from unavailable engine evidence.
- Publish and rollback each show their own persisted snapshot and audit receipt.
