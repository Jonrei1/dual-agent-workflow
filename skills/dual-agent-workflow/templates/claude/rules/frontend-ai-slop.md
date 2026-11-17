---
paths:
  - "**/*.{tsx,jsx,vue,svelte,astro,html,css,scss}"
---

# Frontend: no AI slop

Applies to every page, component and style Claude writes or changes. It overrides the style
suggestions of taste-skill and ui-ux-pro-max: use those for direction and lookups, never as a
reason to ship a pattern below. Source: https://www.paralect.com/blog/signs-of-ai-slop-in-design

## Before building a component
1. Reuse the project's components, tokens, fonts, icons and spacing. Read neighbouring screens first.
2. Start from the real content and the user's task on that screen, then pick the layout. Never
   start from a template shape (hero, three cards, testimonials, CTA).
3. Use real data or a truthful empty/loading/error state. No placeholder numbers.

## Never ship (unless an exception below applies)
- Default purple/blue/indigo gradients, gradient-filled headline words, neon accents outside the palette.
- Decorative glows, blurred blobs, dot or grid backgrounds, floating ornaments, noise textures.
- Glassmorphism on ordinary cards; heavy drop shadows; the same large radius on everything.
- Every section wrapped in a card, cards inside cards, the generic three-column icon feature grid.
- Dashboard stat cards with invented numbers, arrows or trend colours.
- Fake LIVE/ONLINE badges, invented logos, testimonials, ratings, user counts or partners.
- An all-caps eyebrow label above every heading; buzzword copy ("seamless", "supercharge",
  "unlock", "next-level", "AI-powered" without a fact behind it).
- Emoji used as icons; badges, pills, dividers and sparkles that carry no information.
- Fade-in/slide-up on every element, staggered reveals, pulsing dots, hover lift on static cards.
  Motion only for feedback or state change, and always behind `prefers-reduced-motion`.
- Tiny grey text, contrast under WCAG AA, crowded or uniform spacing with no hierarchy.
- Inert controls: links to `#`, buttons without handlers, hover-only actions, fake tabs or toggles.
- Mobile layouts that only stack the desktop columns, clip, or scroll sideways.
- Looks that drop focus rings, labels, semantics or error messages.

## Exceptions
Keep a flagged style only when the user's request, a reference design or the existing brand
tokens call for it, and record the reason in the UI audit. Fake facts, controls that pretend to
work and inaccessible UI are never exceptions.

## Done means
The rendered page was inspected at 375, 768 and 1440 px widths, after the last edit, and no
item above remains without a recorded exception.
