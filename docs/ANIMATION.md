# ANIMATION.md — motion principles (TMA)

The project's motion *law*. Mechanics live in the `animate` / `gsap-scrolltrigger` skills; this file decides what's allowed.

## Philosophy
Restraint. Motion serves clarity and feedback, never decoration. Mobile / Telegram-native, must stay 60fps on a mid phone. If an animation doesn't help the user understand state, cut it.

## Durations & easing
- Enter: 150–250ms, ease-out exponential (`cubic-bezier(.16,1,.3,1)`). Exit: faster, ease-in.
- No bounce, no elastic, no spring overshoot.

## Allowed
- Card hover/press (subtle tilt/sheen), list stagger on load, sheet/section transitions, the character-card reveal (flip/scan), state pulses (running agent), progress/meter fills.

## Forbidden
- Animating CSS layout properties (animate transform/opacity only).
- Gradient-text shimmer, gratuitous parallax, looping ambient motion, anything that reads as AI-slop (see PRODUCT.md anti-references).

## Accessibility
- Always honor `prefers-reduced-motion`: kill non-essential motion, keep instant state changes.

## Brand fit
Dark/amber, per-character hues for the collectible cards. Motion should feel precise and technical, not playful-bouncy.
