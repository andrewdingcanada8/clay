# Flagged pieces

Pieces flagged as problems in the published app ("⋯ → Flag a problem" in the
gallery) are stored in the artifact's database, collection `pieces`. Claude
copies each flagged row here as `<piece id>.json` (the row as stored, plus
`id`). The bench picks them up as cases named `flagged-<piece id>`:

    npm run bench -- --case flagged-<piece id>

The flag's saved view (kernel, quality, camera, section) says how the problem
was seen.
