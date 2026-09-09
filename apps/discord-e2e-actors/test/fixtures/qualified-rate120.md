# Ordinary fixture B integration

Base: `fc66027938992038888d48638f58f2c49a77f8c2`.
Input archive SHA-256: `4d5ed8c749d51c053499f69a138ec265a5aa5c8061eb29962aed2f42089c39ac`.
B audio SHA-256: `1e897e9a115703266446cd8dea2856e1f39fc9bae2399782aa0805847dcf4173`.

The retained [generation record](generation.qualified-rate120.v1.json) losslessly encodes original TSV lines, including speech whitespace,
and records their SHA-256. It is input provenance. Its A audio entry describes a regenerated candidate that was
not installed; the original repository A bytes and both source texts are retained.
Only B audio is installed. The ordinary manifest changes only its fixture set ID,
B audio hash, and B duration. Thresholds, required terms, timestamps, summary and
scenario semantics are unchanged. Live fixtures remain unchanged.

The generation record reports 48.918417 seconds. The supplied manifest used
48919 ms (ceil of ffprobe duration). The unchanged repository `inspectOggOpus`
validator measures 48918 ms using rounded Ogg granules; the manifest uses that
exact value under the authorized metadata correction. No validator is relaxed.

Operator-supplied diagnostic `acoustic-rate120-db29f408-1889-4dbb-9f9f-428e66b3140b`
on reviewed Platform `bcb` / Gateway `3e0`: batch WER 1/69, CER 5/358;
live WER 3/69, CER 12/358; all required terms present; 2446/2446 ACK;
finalizeComplete. This is diagnostic evidence, not a full Discord PASS.
Prior `262a` / `2c82` missing-term failures remain frozen. No additional acoustic
tuning or provider calls are part of this integration.
