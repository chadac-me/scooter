---
name: scooter-imagegen
description: Generating or editing an image. Use when the user asks for a picture, illustration, icon, photo, diagram-as-image, or an edit of an existing image — not for SVG/mermaid diagrams, which the sandbox can already draw itself.
---

# Generating images

Call `generate_image(prompt)`. It writes the result into your sandbox under
`/workspace/images/` and gives you back the path(s) — `view_image` one to check it
before showing or linking it to the user.

- You are capped at a number of images per day, stated in the tool's own
  description along with which backends and models this deployment has enabled.
- You usually don't need `backend` or `model` — leave them unset and one is picked
  for you. Name a `backend` only when the user asks for a specific one, or a
  specific model needs a param the current pick doesn't support; naming it makes
  that backend the ONLY candidate, so a request that doesn't fit is rejected
  outright rather than silently landing on a different backend.
- `params` (quality, size, seed, …) is specific to the chosen model; see the tool's
  description for what each enabled model accepts. A mismatch comes back with that
  model's schema in the error.
- To edit or vary an existing image (uploaded or one you generated earlier), pass
  its path as `reference_image_path`.
- A 404/disabled error means this deployment has not turned on any image backend,
  not that the feature is broken.
