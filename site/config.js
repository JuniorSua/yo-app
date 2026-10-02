// Site settings the owner edits. This file is public: never put a Stripe key (secret or publishable) here.
//
// STRIPE_PAYMENT_LINK: the Stripe Payment Link for the $10 "Support Yo" button, e.g. "https://buy.stripe.com/abc123".
// Leave it empty until the link exists: the button then shows "Payments coming soon" instead of a dead link.
// Only https://buy.stripe.com/ links are accepted; anything else is ignored. See site/README.md.
const STRIPE_PAYMENT_LINK = "";

window.YO_SITE = Object.freeze({ STRIPE_PAYMENT_LINK });
