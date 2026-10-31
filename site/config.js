// Site settings the owner edits. This file is public: never put a Stripe key (secret or publishable) here.

// SUPPORT_EMAIL: the address strangers can write to (install trouble, questions, a past payment).
// Leave it empty to hide every "Email us" line: the pages then point to GitHub and the in-app "Report a problem"
// instead. It is shown on the public site, so use an address meant for that.
const SUPPORT_EMAIL = "support@theyoapp.com";

// DOWNLOAD_TAG: the GitHub release new visitors download. A tag (vX.Y.Z) pins the Mac buttons and the
// Windows and Linux installers to that release, even when it is not marked latest. "" uses /releases/latest.
// To move it: change DOWNLOAD_TAG here, then put that same tag in the plain links (they work with JavaScript
// off) in site/index.html (every Download href, plus install.ps1 and install.sh), site/support.html
// (install.ps1 and install.sh) and site/thanks.html (the Download href). The smoke test reads this constant
// and checks those links. It does not keep its own copy of the tag.
const DOWNLOAD_TAG = "v0.1.778";

// SUPPORT_ONCE_LINK: the Stripe Payment Link behind "Chip in" (Support Yo), a one-time, pay-what-you-want price,
// e.g. "https://buy.stripe.com/<id>". Its "After payment" setting should redirect to https://theyoapp.com/thanks.
// While it's empty, every Chip in button stays hidden and only "Sponsor monthly" shows. Only
// https://buy.stripe.com/ and https://donate.stripe.com/ links are accepted; anything else is ignored.
const SUPPORT_ONCE_LINK = "";

// SPONSOR_LINK: GitHub Sponsors, behind "Sponsor monthly". The plain hrefs in index.html and thanks.html repeat
// it so they work with JavaScript off; the smoke test compares them. Only https://github.com/sponsors/<name> works.
const SPONSOR_LINK = "https://github.com/sponsors/JuniorSua";

window.YO_SITE = Object.freeze({
  SUPPORT_EMAIL,
  DOWNLOAD_TAG,
  SUPPORT_ONCE_LINK,
  SPONSOR_LINK,
});
