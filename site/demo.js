// Interactive Yo demo for the landing page. Plain JS, no dependencies. All replies are scripted.
(() => {
  const root = document.querySelector("[data-demo]");
  if (!root) return;

  const MODELS = {
    claude: { name: "Claude", plan: "Max", color: "#d97757" },
    chatgpt: { name: "ChatGPT", plan: "Plus", color: "#10a37f" },
  };

  const ICON = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const icon = (name, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  const ROUTINE_POOL = [
    ["Morning brief", "Weekdays 7am"],
    ["Price watch", "Daily"],
    ["Weekly review", "Fri 4pm"],
    ["Inbox sweep", "Hourly"],
    ["Bill check", "1st of month"],
  ];

  // ---------------------------------------------------------------- Agents
  const AGENTS = [
    {
      id: "yo",
      name: "Yo",
      model: "claude",
      time: "9:14 AM",
      preview: "holding a table for 4. ok to book?",
      status: "waiting",
      messages: [
        { k: "time", t: "Today 9:12 AM" },
        {
          k: "user",
          t: "find a dinner spot for 4 this friday near union square. under $60 a head, somewhere we can actually talk",
        },
        { k: "agent", t: "on it. checking what's open friday around 7." },
        {
          k: "steps",
          items: [
            ["Searched", "31 places with a table for 4 · Fri 7–8pm"],
            ["Filtered", "under $60 a head · 4.5★ and up · quiet"],
            ["Shortlisted", "3 picks · menus and photos saved"],
          ],
        },
        {
          k: "agent",
          t: "my pick is Juniper & Rye: seasonal, about $48 a head, 4.7★, and reviewers keep saying it's easy to talk there. I'm holding 7:30.",
        },
        {
          k: "card",
          id: "book",
          kicker: "Needs your OK",
          title: "Book Juniper & Rye · Fri 7:30 PM · 4 people",
          body: "No deposit. Free cancellation until Thursday.",
          primary: "Book it",
          secondary: "Show the others",
        },
      ],
      plan: [
        ["Search tables for Friday", "done"],
        ["Filter by budget and noise", "done"],
        ["Shortlist 3 places", "done"],
        ["Book after you approve", "wait"],
      ],
      screen: {
        url: "opentable.com/r/juniper-and-rye",
        title: "Juniper & Rye · Friday",
        lines: ["Party of 4 · 7:30 PM", "Table held for 10 minutes", "$$ · Seasonal · 4.7★"],
      },
      routines: [ROUTINE_POOL[0], ROUTINE_POOL[4]],
      suggest: [
        "what's on my calendar tomorrow?",
        "find a cheaper flight to miami",
        "remind me to call mom sunday",
      ],
      actions: {
        book: {
          primary: {
            result: "✓ Booked",
            run: (a) => [
              [
                900,
                {
                  k: "agent",
                  t: "booked. the confirmation is in my inbox, and it's on your calendar for friday.",
                },
              ],
              [0, () => finish(a, "booked. juniper & rye, fri 7:30")],
              [
                0,
                () =>
                  setScreen(a, {
                    title: "Reservation confirmed",
                    lines: ["Juniper & Rye · Fri 7:30 PM", "Party of 4", "Added to your calendar"],
                  }),
              ],
            ],
          },
          secondary: {
            keep: true,
            run: () => [
              [
                900,
                {
                  k: "agent",
                  t: "the other two: Lantern House (thai, $40, 4.5★, a bit loud) and Bistro Calla ($55, 4.6★, small plates). still holding Juniper & Rye.",
                },
              ],
            ],
          },
        },
      },
    },
    {
      id: "researcher",
      name: "Researcher",
      model: "chatgpt",
      time: "8:40 AM",
      preview: "brief saved: 3 standing desks under $700",
      status: "idle",
      messages: [
        { k: "time", t: "Today 8:31 AM" },
        { k: "user", t: "compare the three best standing desks under $700. sources please" },
        { k: "agent", t: "reading the big review sites plus a few long-term owner threads." },
        {
          k: "table",
          title: "Standing desks under $700",
          rows: [
            ["Arc Lift V2 · 48×30", "$599 · best overall"],
            ["Maple Rise Bamboo", "$579 · best value"],
            ["Steadi E7", "$489 · budget pick"],
          ],
          foot: "14 sources · full brief saved to files/desks.md",
        },
        {
          k: "agent",
          t: "short version: the Arc if you can stretch, the Steadi if you can't. want me to watch for a sale?",
        },
        {
          k: "card",
          id: "watch",
          kicker: "Suggestion",
          title: "Watch the Arc Lift V2 for a price drop",
          body: "Checks every morning and messages you if it drops under $540.",
          primary: "Watch it",
          secondary: "No thanks",
        },
      ],
      plan: [
        ["Collect reviews and owner reports", "done"],
        ["Score stability, noise, warranty", "done"],
        ["Write the brief with sources", "done"],
      ],
      screen: {
        url: "files/desks.md",
        title: "Standing desks: the brief",
        lines: [
          "1. Arc Lift V2: steadiest at full height",
          "2. Maple Rise: quiet motor, 10-yr warranty",
          "3. Steadi E7: wobbles a little above 45in",
        ],
      },
      routines: [],
      suggest: ["which one is quietest?", "find me a monitor arm too", "summarize this in 3 bullets"],
      actions: {
        watch: {
          primary: {
            result: "✓ Watching",
            run: (a) => [
              [800, { k: "agent", t: "done. I'll check every morning and ping you if it drops." }],
              [0, () => addRoutine(a, ["Price watch · Arc Lift V2", "Daily"])],
              [0, () => finish(a, "watching the arc lift for a sale")],
            ],
          },
          secondary: {
            result: "Skipped",
            run: (a) => [
              [700, { k: "agent", t: "got it. the brief is in files if you need it later." }],
              [0, () => settle(a)],
            ],
          },
        },
      },
    },
    {
      id: "chief-of-staff",
      name: "Chief of Staff",
      model: "claude",
      time: "Yesterday",
      preview: "ok to message Priya about team sync?",
      status: "waiting",
      messages: [
        { k: "time", t: "Yesterday 6:02 PM" },
        { k: "user", t: "i'm out tuesday and wednesday next week. clear it and let people know" },
        { k: "agent", t: "on it. you have 6 things on those days." },
        {
          k: "steps",
          items: [
            ["Moved", "3 meetings to thursday · everyone's free"],
            ["Declined", "2 optional ones, with a short note"],
            ["Set", "out-of-office for tue–wed"],
            ["Flagged", "1 you run · team sync needs a host"],
          ],
        },
        { k: "agent", t: "team sync needs someone to run it. Priya hosted last time. want me to ask her?" },
        {
          k: "card",
          id: "ask",
          kicker: "Needs your OK",
          title: "Message Priya",
          body: "“hey! I'm out tue–wed. could you run team sync on tuesday? the agenda is in the doc.”",
          primary: "Send",
          secondary: "Edit first",
        },
      ],
      plan: [
        ["Find everything on tue–wed", "done"],
        ["Move or decline each one", "done"],
        ["Set out-of-office", "done"],
        ["Ask Priya to host team sync", "wait"],
      ],
      screen: {
        url: "calendar.google.com/week",
        title: "Week of Oct 5",
        lines: ["Tue · Out of office", "Wed · Out of office", "Thu · 3 meetings moved here"],
      },
      routines: [ROUTINE_POOL[2]],
      suggest: ["what's my week look like?", "book a dentist appointment", "who haven't i replied to?"],
      actions: {
        ask: {
          primary: {
            result: "✓ Sent",
            run: (a) => [
              [900, { k: "agent", t: "sent. I'll tell you when she replies." }],
              [2600, { k: "agent", t: "Priya said yes 🙌 team sync is covered." }],
              [0, () => finish(a, "priya's hosting team sync")],
            ],
          },
          secondary: {
            keep: true,
            run: () => [[700, { k: "agent", t: "sure. tell me what to change and I'll redraft it." }]],
          },
        },
      },
    },
    {
      id: "shopper",
      name: "Shopper",
      model: "chatgpt",
      time: "Yesterday",
      preview: "cart ready: $38.50. approve?",
      status: "waiting",
      messages: [
        { k: "time", t: "Yesterday 2:47 PM" },
        { k: "user", t: "reorder the coffee beans from last month, but check if anyone has them cheaper" },
        { k: "agent", t: "found them in your order history: Northbound Roasters, Lantern blend, 2 lb." },
        {
          k: "table",
          title: "Same beans, 3 stores",
          rows: [
            ["Northbound (direct)", "$44.00 · ships Mon"],
            ["Grove Market", "$38.50 · arrives Thu"],
            ["Pantry & Co.", "$41.20 · arrives Fri"],
          ],
          foot: "Prices include shipping.",
        },
        { k: "agent", t: "Grove Market is $5.50 cheaper and gets here sooner. the cart is ready." },
        {
          k: "card",
          id: "buy",
          kicker: "Purchase · needs your OK",
          title: "Buy Lantern blend, 2 lb · $38.50",
          body: "Grove Market · Visa ending 4242 · arrives Thursday",
          primary: "Approve",
          secondary: "Not now",
        },
      ],
      plan: [
        ["Find last month's order", "done"],
        ["Compare 3 stores", "done"],
        ["Fill the cart", "done"],
        ["Check out after you approve", "wait"],
      ],
      screen: {
        url: "grovemarket.com/checkout",
        title: "Checkout",
        lines: ["Lantern blend, 2 lb × 1", "Shipping: free", "Total $38.50"],
      },
      routines: [],
      suggest: ["get paper towels too", "is there a coupon?", "what did i spend on coffee this year?"],
      actions: {
        buy: {
          primary: {
            result: "✓ Approved",
            run: (a) => [
              [
                1000,
                {
                  k: "agent",
                  t: "ordered. the tracking number is in my notes, and I'll tell you when it ships.",
                },
              ],
              [
                0,
                () =>
                  setScreen(a, {
                    title: "Order placed",
                    lines: ["Order #GM-20817", "Arrives Thursday", "Receipt saved to files"],
                  }),
              ],
              [0, () => finish(a, "ordered. arrives thursday")],
            ],
          },
          secondary: {
            result: "Not now",
            run: (a) => [
              [700, { k: "agent", t: "no problem. I'll leave it in the cart." }],
              [0, () => settle(a, "left the beans in the cart")],
            ],
          },
        },
      },
    },
    {
      id: "travel",
      name: "Travel Planner",
      model: "claude",
      time: "Mon",
      preview: "lisbon plan ready. hold the flight?",
      status: "waiting",
      messages: [
        { k: "time", t: "Monday 7:20 PM" },
        { k: "user", t: "plan 3 days in lisbon in november. flights from JFK under $600" },
        { k: "agent", t: "nov 13–16 is the cheapest long weekend. here's the plan:" },
        {
          k: "table",
          title: "Lisbon · Nov 13–16",
          rows: [
            ["Flight · nonstop", "$548 round trip"],
            ["Stay · Alfama, 3 nights", "$396 total"],
            ["Day 1", "Alfama, viewpoints, fado dinner"],
            ["Day 2", "Belém, LX Factory, river sunset"],
            ["Day 3", "Day trip to Sintra"],
          ],
          foot: "Saved to files/lisbon.md",
        },
        { k: "agent", t: "fares like this usually last a day or two. want me to hold the flight?" },
        {
          k: "card",
          id: "hold",
          kicker: "Needs your OK",
          title: "Hold the flight for 24 hours · $548",
          body: "Free hold. Nothing is charged.",
          primary: "Hold it",
          secondary: "Not yet",
        },
      ],
      plan: [
        ["Find the cheapest weekend", "done"],
        ["Pick a stay near the sights", "done"],
        ["Draft the day-by-day", "done"],
        ["Hold the flight after you approve", "wait"],
      ],
      screen: {
        url: "google.com/travel/flights",
        title: "JFK ⇄ LIS · Nov 13–16",
        lines: ["Nonstop · 6h 55m", "Round trip $548", "Price is low for these dates"],
      },
      routines: [],
      suggest: ["add a food tour", "find a cheaper hotel", "what's the weather like then?"],
      actions: {
        hold: {
          primary: {
            result: "✓ Held",
            run: (a) => [
              [
                900,
                { k: "agent", t: "held until tomorrow 7:20 PM. I'll remind you an hour before it expires." },
              ],
              [0, () => finish(a, "flight held until tomorrow")],
            ],
          },
          secondary: {
            result: "Not yet",
            run: (a) => [
              [700, { k: "agent", t: "ok. I'll keep an eye on the price in the meantime." }],
              [0, () => settle(a, "watching lisbon fares")],
            ],
          },
        },
      },
    },
    {
      id: "builder",
      name: "Builder",
      model: "chatgpt",
      time: "Sun",
      preview: "needs you to sign in to the bank",
      status: "waiting",
      messages: [
        { k: "time", t: "Sunday 11:05 AM" },
        { k: "user", t: "every month, download my bank csv and add it to my budget sheet" },
        { k: "agent", t: "wrote the script and tested it on last month's export. it works." },
        {
          k: "agent",
          t: "one thing: the bank wants you to sign in with a 2FA code. can you take over for a sec?",
        },
        {
          k: "card",
          id: "login",
          kicker: "Needs you · Login",
          title: "Sign in to First Harbor Bank",
          body: "Take over its screen, sign in, then hand it back.",
          primary: "Take over",
          secondary: "Later",
        },
      ],
      plan: [
        ["Write the export script", "done"],
        ["Test on August's CSV", "done"],
        ["Sign in to the bank (needs you)", "wait"],
        ["Import September", ""],
        ["Schedule it monthly", ""],
      ],
      screen: {
        url: "online.firstharbor.com/login",
        title: "Sign in",
        lines: ["Username", "Password", "6-digit code from your phone"],
      },
      routines: [],
      suggest: ["show me the script", "categorize my spending", "make a chart of september"],
      actions: {
        login: {
          primary: { result: "In control", run: (a) => [[0, () => takeOver(a)]] },
          secondary: {
            keep: true,
            run: () => [
              [
                700,
                { k: "agent", t: "ok. I'll leave the login page open. tap Take over when you're ready." },
              ],
            ],
          },
        },
      },
    },
    {
      id: "inbox",
      name: "Inbox Manager",
      model: "claude",
      time: "Sat",
      preview: "inbox at 0. 1 reply waiting for you",
      status: "waiting",
      messages: [
        { k: "time", t: "Saturday 10:30 AM" },
        { k: "user", t: "the inbox got away from me this week. clean it up?" },
        { k: "agent", t: "on it. 63 unread since monday." },
        {
          k: "steps",
          items: [
            ["Archived", "38 newsletters, receipts, and promos"],
            ["Unsubscribed", "7 lists you never open"],
            ["Drafted", "5 replies in your voice · waiting for you"],
            ["Flagged", "1 from your landlord · lease renewal"],
          ],
        },
        {
          k: "agent",
          t: "the landlord one needs an answer by friday. I drafted a reply asking to keep the same rate.",
        },
        {
          k: "card",
          id: "send",
          kicker: "Needs your OK",
          title: "Reply to Dana (landlord)",
          body: "“Hi Dana, thanks for the renewal offer. We'd love to stay. Could we keep the current rate for another 12 months?”",
          primary: "Send",
          secondary: "Not yet",
        },
      ],
      plan: [
        ["Read 63 unread threads", "done"],
        ["Archive and unsubscribe", "done"],
        ["Draft replies", "done"],
        ["Send the landlord reply", "wait"],
      ],
      screen: {
        url: "mail.google.com",
        title: "Inbox: 0 unread",
        lines: ["38 archived · 7 unsubscribed", "5 drafts waiting for you", "Dana: lease renewal (flagged)"],
      },
      routines: [ROUTINE_POOL[3]],
      suggest: ["show me the other drafts", "unsubscribe from more", "what needs me this week?"],
      actions: {
        send: {
          primary: {
            result: "✓ Sent",
            run: (a) => [
              [
                900,
                {
                  k: "agent",
                  t: "sent. the other 4 drafts are in your drafts folder whenever you want them.",
                },
              ],
              [0, () => finish(a, "sent to dana. 4 drafts left")],
            ],
          },
          secondary: {
            result: "Held",
            run: (a) => [
              [700, { k: "agent", t: "ok, it's in drafts. I'll remind you thursday." }],
              [0, () => settle(a, "reply to dana is in drafts")],
            ],
          },
        },
      },
    },
  ];

  const REPLIES = [
    [
      /flight|trip|travel|hotel|vacation/i,
      "I'll check fares and stays and come back with a short list. I won't book anything until you say so.",
    ],
    [
      /buy|order|price|cheap|coupon|cart/i,
      "I'll compare prices and fill the cart. Nothing gets bought until you tap Approve.",
    ],
    [
      /remind|calendar|meeting|schedule|appointment|week/i,
      "done. it's on your calendar, and I'll nudge you the day before.",
    ],
    [
      /email|inbox|reply|draft|unsubscribe/i,
      "I'll draft it in your voice and hold it for you to read first.",
    ],
    [/code|script|automate|chart|sheet/i, "I'll write it on my computer, test it, and show you the result."],
    [/thank|thx|great|nice|cool/i, "anytime 🙂"],
  ];

  // ----------------------------------------------------------------- State
  let active = AGENTS[0];
  let paneOpen = !window.matchMedia("(max-width: 860px)").matches;
  let newCount = 0;
  let notedScripted = false;
  for (const a of AGENTS) {
    a.cardState = {};
    a.control = false;
  }

  // ------------------------------------------------------------------ DOM
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const avatarSrc = (a) => `/assets/avatars/${a.avatar ?? a.id}.svg`;

  root.innerHTML = `
    <aside class="a-side">
      <div class="a-side-top">
        <div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>
        <button class="icon-btn" data-new aria-label="New agent" title="New agent">${icon("plus")}</button>
      </div>
      <label class="a-search">${icon("search", 14)}<input data-search placeholder="Search agents" aria-label="Search agents" /></label>
      <div class="a-list" data-list role="list"></div>
      <div class="a-me"><b>YOU</b><span>You</span></div>
    </aside>
    <section class="a-chat">
      <header class="a-chat-head">
        <img data-head-avatar alt="" width="36" height="36" />
        <span class="a-chat-title" data-head-name></span>
        <span class="a-status" data-head-status></span>
        <div class="a-head-right">
          <button class="icon-btn" data-toggle-pane aria-label="Toggle computer" title="Its computer">${icon("monitor")}</button>
        </div>
      </header>
      <div class="a-msgs" data-msgs aria-live="polite"></div>
      <div class="a-suggest" data-suggest></div>
      <form class="a-composer" data-form>
        <button type="button" class="icon-btn" aria-label="Attach" tabindex="-1">${icon("plus")}</button>
        <input data-input autocomplete="off" aria-label="Message" />
        <button type="button" class="a-model" data-model aria-haspopup="true" aria-expanded="false"></button>
        <button type="submit" class="a-send" data-send aria-label="Send" disabled>${icon("up")}</button>
        <div class="a-menu" data-menu hidden role="menu"></div>
      </form>
    </section>
    <aside class="a-pane" data-pane>
      <div class="a-pane-inner">
        <div class="a-pane-head">
          <span><span data-pane-name></span><span class="a-live" data-live>Live</span></span>
          <button class="icon-btn" data-close-pane aria-label="Close computer">${icon("x", 15)}</button>
        </div>
        <div class="a-pane-body">
          <button class="a-screen" data-screen aria-label="Its screen"></button>
          <div class="a-screen-row"><span data-screen-label></span><button class="a-link" data-takeover></button></div>
          <p class="a-h">Plan</p>
          <ul class="a-plan" data-plan></ul>
          <p class="a-h">Routines</p>
          <div data-routines></div>
          <button class="a-add" data-add-routine>+ New routine</button>
        </div>
      </div>
    </aside>`;

  const $ = (sel) => root.querySelector(sel);
  const list = $("[data-list]");
  const msgs = $("[data-msgs]");
  const input = $("[data-input]");
  const send = $("[data-send]");
  const menu = $("[data-menu]");
  const modelBtn = $("[data-model]");

  // ------------------------------------------------------------- Rendering
  function renderList() {
    const q = $("[data-search]").value.trim().toLowerCase();
    list.innerHTML = "";
    for (const a of AGENTS) {
      if (q && !a.name.toLowerCase().includes(q)) continue;
      const b = el("button", `a-item${a === active ? " is-on" : ""}`);
      b.setAttribute("role", "listitem");
      b.innerHTML = `<img src="${avatarSrc(a)}" alt="" width="44" height="44" />
        <span style="min-width:0">
          <span class="a-item-row"><span class="a-item-name"></span><span class="a-item-time"></span></span>
          <span class="a-item-prev">${a.status === "waiting" ? '<i class="dot-need"></i>' : ""}<span></span></span>
        </span>`;
      b.querySelector(".a-item-name").textContent = a.name;
      b.querySelector(".a-item-time").textContent = a.time;
      b.querySelector(".a-item-prev span").textContent = a.preview;
      b.addEventListener("click", () => select(a));
      list.appendChild(b);
    }
  }

  function renderHead() {
    $("[data-head-avatar]").src = avatarSrc(active);
    $("[data-head-name]").textContent = active.name;
    const st = $("[data-head-status]");
    const label = {
      idle: "Idle",
      working: "Working…",
      waiting: "Waiting for you",
      paused: "Paused · you're in control",
    };
    st.textContent = label[active.status];
    st.className = `a-status${active.status === "working" ? " is-working" : ""}${active.status === "waiting" || active.status === "paused" ? " is-waiting" : ""}`;
    input.placeholder = `Message ${active.name}`;
    const m = MODELS[active.model];
    modelBtn.innerHTML = `<i style="background:${m.color}"></i><span class="a-model-name">${m.name} · ${m.plan}</span>${icon("down", 13)}`;
    $("[data-toggle-pane]").classList.toggle("is-on", paneOpen);
  }

  function msgNode(a, m) {
    if (m.k === "time") return el("div", "a-time", m.t);
    if (m.k === "sys") {
      const n = el("div", "a-sys", "<span></span>");
      n.firstChild.textContent = m.t;
      return n;
    }
    if (m.k === "user" || m.k === "agent") {
      const n = el("div", `a-msg ${m.k === "user" ? "mine" : "bot"}`, '<div class="a-bub"></div>');
      n.firstChild.textContent = m.t;
      return n;
    }
    if (m.k === "steps") {
      const n = el("div", "a-steps");
      for (const [b, s] of m.items) {
        const r = el("div", "a-step", "<i>✓</i><b></b><em>→</em><span></span>");
        r.querySelector("b").textContent = b;
        r.querySelector("span").textContent = s;
        n.appendChild(r);
      }
      return n;
    }
    if (m.k === "table") {
      const n = el(
        "div",
        "a-card",
        '<div class="a-card-title"></div><table class="a-table"></table><div class="a-card-body"></div>',
      );
      n.querySelector(".a-card-title").textContent = m.title;
      for (const [l, r] of m.rows) {
        const tr = el("tr", "", "<td></td><td></td>");
        tr.children[0].textContent = l;
        tr.children[1].textContent = r;
        n.querySelector("table").appendChild(tr);
      }
      n.querySelector(".a-card-body").textContent = m.foot;
      return n;
    }
    if (m.k === "card") {
      const state = a.cardState[m.id];
      const n = el(
        "div",
        `a-card${state ? " is-done" : ""}`,
        `<div class="a-card-kicker"></div><div class="a-card-title"></div><div class="a-card-body"></div>
         <div class="a-card-actions"><button class="a-btn a-btn-ghost" data-act="secondary"></button><button class="a-btn a-btn-primary" data-act="primary"></button></div>`,
      );
      n.dataset.card = m.id;
      n.querySelector(".a-card-kicker").textContent = m.kicker;
      n.querySelector(".a-card-title").textContent = m.title;
      n.querySelector(".a-card-body").textContent = m.body;
      n.querySelector('[data-act="primary"]').textContent = m.primary;
      n.querySelector('[data-act="secondary"]').textContent = m.secondary;
      if (state) n.appendChild(Object.assign(el("div", "a-card-result"), { textContent: state }));
      n.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => act(a, m.id, btn.dataset.act));
      });
      return n;
    }
    return el("div");
  }

  function renderMsgs() {
    msgs.innerHTML = "";
    for (const m of active.messages) {
      const n = msgNode(active, m);
      n.style.animation = "none";
      msgs.appendChild(n);
    }
    if (active.typing) msgs.appendChild(typingNode());
    msgs.style.scrollBehavior = "auto";
    msgs.scrollTop = msgs.scrollHeight;
    msgs.style.scrollBehavior = "";
  }

  function typingNode() {
    const n = el("div", "a-msg bot", '<div class="a-typing"><i></i><i></i><i></i></div>');
    n.dataset.typing = "1";
    return n;
  }

  function renderSuggest() {
    const s = $("[data-suggest]");
    s.innerHTML = "";
    for (const t of active.suggest ?? []) {
      const b = el("button", "");
      b.type = "button";
      b.textContent = t;
      b.addEventListener("click", () => userSays(t));
      s.appendChild(b);
    }
  }

  function renderPane() {
    root.classList.toggle("no-pane", !paneOpen);
    $("[data-pane-name]").textContent = `${active.name}'s computer`;
    $("[data-live]").hidden = active.status !== "working" && !active.control;
    const sc = active.screen;
    const screen = $("[data-screen]");
    screen.classList.toggle("is-control", active.control);
    screen.innerHTML = `<div class="a-browser"><div class="a-url"><i></i><i></i><i></i><span></span></div><div class="a-page"><strong></strong></div></div>
      <svg class="a-cursor" data-cursor viewBox="0 0 24 24"><path d="M4 3l16 7.5-7 1.8L9.5 20z" fill="#fff" stroke="#1d1d1f" stroke-width="1.5" stroke-linejoin="round"/></svg>
      ${active.control ? '<span class="a-control-tag">You\'re in control</span>' : ""}`;
    screen.querySelector(".a-url span").textContent = sc.url;
    screen.querySelector(".a-page strong").textContent = sc.title;
    sc.lines.forEach((l, i) => {
      const s = el("span", i === 0 ? "hl" : "");
      s.textContent = l;
      screen.querySelector(".a-page").appendChild(s);
    });
    $("[data-screen-label]").textContent = active.control
      ? "You have the keyboard"
      : `${active.name}'s screen`;
    $("[data-takeover]").textContent = active.control ? "Hand back" : "Take over";

    const plan = $("[data-plan]");
    plan.innerHTML = "";
    if (!active.plan.length)
      plan.appendChild(Object.assign(el("li", ""), { textContent: "No plan yet. Give it a job." }));
    for (const [t, s] of active.plan) plan.appendChild(Object.assign(el("li", s), { textContent: t }));

    const rs = $("[data-routines]");
    rs.innerHTML = "";
    for (const r of active.routines) {
      const b = el(
        "button",
        `a-routine${r.off ? " is-off" : ""}`,
        `<i>${icon("clock", 14)}</i><span></span><small></small>`,
      );
      b.querySelector("span").textContent = r[0];
      b.querySelector("small").textContent = r.off ? "Paused" : r[1];
      b.title = r.off ? "Resume routine" : "Pause routine";
      b.addEventListener("click", () => {
        r.off = !r.off;
        renderPane();
      });
      rs.appendChild(b);
    }
    const next = ROUTINE_POOL.find((p) => !active.routines.some((r) => r[0] === p[0]));
    const add = $("[data-add-routine]");
    add.textContent = next ? "+ New routine" : "All routines added";
    add.disabled = !next;
  }

  function renderModelMenu() {
    menu.innerHTML = "<p>Runs on your subscription</p>";
    for (const [id, m] of Object.entries(MODELS)) {
      const b = el(
        "button",
        id === active.model ? "is-on" : "",
        `<i style="background:${m.color}"></i>${m.name}<small>${m.plan}</small>`,
      );
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.addEventListener("click", () => switchModel(id));
      menu.appendChild(b);
    }
  }

  function renderAll() {
    renderList();
    renderHead();
    renderMsgs();
    renderSuggest();
    renderPane();
  }

  // --------------------------------------------------------------- Actions
  function select(a) {
    if (a === active) return;
    active = a;
    closeMenu();
    if (window.matchMedia("(max-width: 860px)").matches) paneOpen = false;
    renderAll();
  }

  function push(a, m) {
    a.messages.push(m);
    if (a !== active) return;
    msgs.querySelector("[data-typing]")?.remove();
    msgs.appendChild(msgNode(a, m));
    if (a.typing) msgs.appendChild(typingNode());
    msgs.scrollTop = msgs.scrollHeight;
  }

  function setTyping(a, on) {
    a.typing = on;
    if (a !== active) return;
    msgs.querySelector("[data-typing]")?.remove();
    if (on) {
      msgs.appendChild(typingNode());
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  function setStatus(a, status, preview) {
    a.status = status;
    if (preview) {
      a.preview = preview;
      a.time = "Now";
    }
    renderList();
    if (a === active) {
      renderHead();
      renderPane();
    }
  }

  function setScreen(a, patch) {
    Object.assign(a.screen, patch);
    if (a === active) renderPane();
  }

  function addRoutine(a, r) {
    a.routines.push(r);
    if (a === active) renderPane();
  }

  // Marks the waiting plan steps done and the agent idle.
  function finish(a, preview) {
    for (const p of a.plan) if (p[1] !== "done") p[1] = "done";
    setStatus(a, "idle", preview);
  }

  // The user said no: drop the waiting step back to pending and go idle.
  function settle(a, preview) {
    for (const p of a.plan) if (p[1] === "wait" || p[1] === "active") p[1] = "";
    setStatus(a, "idle", preview);
  }

  // Runs a script: a list of [delayMs, message | fn]. Shows typing before each message.
  function play(a, steps) {
    let t = 0;
    for (const [delay, item] of steps) {
      if (typeof item === "function") {
        t += delay;
        setTimeout(item, t);
        continue;
      }
      setTimeout(() => setTyping(a, true), t);
      t += delay || 600;
      setTimeout(() => {
        setTyping(a, false);
        push(a, item);
      }, t);
    }
  }

  // "Things to try" checklist next to the demo.
  const tourDone = new Set();
  function tour(step) {
    if (tourDone.has(step)) return;
    tourDone.add(step);
    document.querySelector(`[data-tour-step="${step}"]`)?.classList.add("is-done");
    const total = document.querySelectorAll("[data-tour-step]").length;
    const count = document.querySelector("[data-tour-count]");
    if (count) count.textContent = `${tourDone.size} of ${total}`;
    const bar = document.querySelector("[data-tour-bar]");
    if (bar) bar.style.width = `${(tourDone.size / total) * 100}%`;
    if (tourDone.size === total) document.querySelector("[data-tour-done]")?.removeAttribute("hidden");
  }

  function act(a, cardId, which) {
    const action = a.actions?.[cardId]?.[which];
    if (!action || a.cardState[cardId]) return;
    if (which === "primary" && cardId !== "login") tour("approve");
    if (!action.keep) {
      a.cardState[cardId] = action.result;
      const n = msgs.querySelector(`[data-card="${cardId}"]`);
      if (n && a === active) {
        n.classList.add("is-done");
        n.appendChild(Object.assign(el("div", "a-card-result"), { textContent: action.result }));
      }
      if (which === "primary" && action.result !== "In control") {
        const waiting = a.plan.find((p) => p[1] === "wait");
        if (waiting) waiting[1] = "active";
        setStatus(a, "working");
      }
    }
    play(a, action.run(a));
  }

  function takeOver(a) {
    tour("takeover");
    a.control = true;
    paneOpen = true;
    push(a, { k: "sys", t: `You took over ${a.name}'s computer` });
    if (a.id === "builder" && !a.signedIn) {
      setScreen(a, {
        title: "Sign in",
        lines: ["Username ········", "Password ········", "Code  4 8 2 · 1 9 _"],
      });
    }
    setStatus(a, "paused");
    moveCursor();
  }

  function handBack(a) {
    a.control = false;
    push(a, { k: "sys", t: "You handed control back" });
    if (a.id === "builder" && !a.signedIn) {
      a.signedIn = true;
      if (!a.cardState.login) {
        a.cardState.login = "✓ Signed in";
        const n = msgs.querySelector('[data-card="login"]');
        n?.classList.add("is-done");
        n?.appendChild(Object.assign(el("div", "a-card-result"), { textContent: a.cardState.login }));
      }
      a.plan[2][1] = "done";
      a.plan[3][1] = "active";
      setScreen(a, {
        url: "online.firstharbor.com/accounts",
        title: "Checking ····4410",
        lines: ["Download: September.csv", "84 transactions", "Exporting…"],
      });
      setStatus(a, "working");
      play(a, [
        [
          1600,
          {
            k: "agent",
            t: "thanks, I'm in. pulled september: 84 transactions, categorized and added to “Budget 2026”.",
          },
        ],
        [
          0,
          () =>
            setScreen(a, {
              url: "sheets.google.com/budget-2026",
              title: "Budget 2026 · September",
              lines: ["84 rows added", "Groceries $612 · Dining $284", "Rent $2,150"],
            }),
        ],
        [
          900,
          {
            k: "agent",
            t: "saved it as a routine for the 1st of every month. if the bank asks for a code again, I'll ping you.",
          },
        ],
        [0, () => addRoutine(a, ["Bank → budget sheet", "1st of month"])],
        [0, () => finish(a, "september added to your budget")],
      ]);
      return;
    }
    setStatus(a, a.plan.some((p) => p[1] === "wait") ? "waiting" : "idle");
  }

  function moveCursor() {
    const c = $("[data-cursor]");
    if (!c) return;
    c.style.left = `${20 + Math.random() * 60}%`;
    c.style.top = `${25 + Math.random() * 50}%`;
  }

  function switchModel(id) {
    closeMenu();
    if (id === active.model) return;
    active.model = id;
    tour("model");
    const m = MODELS[id];
    push(active, { k: "sys", t: `Now on ${m.name} · ${m.plan}. Same memory, same computer.` });
    renderHead();
  }

  function userSays(text) {
    const a = active;
    const t = text.trim();
    if (!t) return;
    push(a, { k: "user", t });
    tour("message");
    input.value = "";
    send.disabled = true;
    const short = t.length > 34 ? `${t.slice(0, 32)}…` : t;
    a.plan.push([short.charAt(0).toUpperCase() + short.slice(1), "active"]);
    setStatus(a, "working");
    const reply =
      REPLIES.find(([re]) => re.test(t))?.[1] ??
      "on it. I'll work on this on my computer and check back if I need you.";
    const tick = setInterval(() => a === active && moveCursor(), 700);
    const steps = [[1100, { k: "agent", t: reply }]];
    if (!notedScripted) {
      notedScripted = true;
      steps.push([
        0,
        () =>
          push(a, { k: "sys", t: "This demo's replies are scripted. The real Yo actually does the work." }),
      ]);
    }
    steps.push([
      1500,
      () => {
        clearInterval(tick);
        const p = a.plan.findLast((x) => x[1] === "active");
        if (p) p[1] = "done";
        setStatus(a, a.plan.some((x) => x[1] === "wait") ? "waiting" : "idle", reply.slice(0, 48));
      },
    ]);
    play(a, steps);
  }

  function newAgent() {
    if (newCount >= 3) return;
    newCount += 1;
    const a = {
      id: `new-${newCount}`,
      avatar: "yo",
      name: newCount === 1 ? "New agent" : `New agent ${newCount}`,
      model: "claude",
      time: "Now",
      preview: "say hi to your new agent",
      status: "idle",
      messages: [
        { k: "time", t: "Just now" },
        { k: "agent", t: "hi! I'm your new agent. what should I call myself, and what's my first job?" },
      ],
      plan: [],
      screen: {
        url: "about:blank",
        title: "Computer is ready",
        lines: ["Browser, terminal, and files", "Booted in 28 seconds"],
      },
      routines: [],
      suggest: ["call yourself Max. find me a gym nearby", "you're my meal planner", "track my package"],
      cardState: {},
      control: false,
    };
    AGENTS.splice(newCount - 1, 0, a);
    $("[data-search]").value = "";
    select(a);
    input.focus({ preventScroll: true });
  }

  function closeMenu() {
    menu.hidden = true;
    modelBtn.setAttribute("aria-expanded", "false");
  }

  // ---------------------------------------------------------------- Events
  $("[data-search]").addEventListener("input", renderList);
  $("[data-new]").addEventListener("click", newAgent);
  input.addEventListener("input", () => {
    send.disabled = !input.value.trim();
  });
  $("[data-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    userSays(input.value);
  });
  modelBtn.addEventListener("click", () => {
    const open = menu.hidden;
    if (open) renderModelMenu();
    menu.hidden = !open;
    modelBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest("[data-menu], [data-model]")) closeMenu();
  });
  $("[data-toggle-pane]").addEventListener("click", () => {
    paneOpen = !paneOpen;
    renderHead();
    renderPane();
  });
  $("[data-close-pane]").addEventListener("click", () => {
    paneOpen = false;
    renderHead();
    renderPane();
  });
  const toggleControl = () => (active.control ? handBack(active) : takeOver(active));
  $("[data-takeover]").addEventListener("click", toggleControl);
  $("[data-screen]").addEventListener("click", () => {
    if (active.control) moveCursor();
    else toggleControl();
  });
  $("[data-add-routine]").addEventListener("click", () => {
    const next = ROUTINE_POOL.find((p) => !active.routines.some((r) => r[0] === p[0]));
    if (next) addRoutine(active, [...next]);
  });

  // Appearance switch in the fake menu bar: flips the window and the wallpaper together.
  const desk = document.querySelector("[data-desk]");
  const appearance = document.querySelector("[data-appearance]");
  appearance?.addEventListener("click", () => {
    const light = !root.classList.contains("theme-light");
    root.classList.toggle("theme-light", light);
    root.classList.toggle("theme-dark", !light);
    desk?.classList.toggle("is-light", light);
    document.querySelector("[data-appearance-label]").textContent = light ? "Light" : "Dark";
    appearance.setAttribute("aria-label", `Switch the demo to ${light ? "dark" : "light"} mode`);
  });

  // Menu bar clock shows the visitor's real time.
  const clock = document.querySelector("[data-clock]");
  const tickClock = () => {
    if (!clock) return;
    const now = new Date();
    const day = now.toLocaleDateString(undefined, { weekday: "short" });
    clock.textContent = `${day} ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  };
  tickClock();
  setInterval(tickClock, 30_000);

  // -------------------------------------------------------------- First run
  // What a new user sees first: "Connect your model", then the first agent's "Let's set up my computer" chat.
  // Commands and wording follow apps/web/src/components/connect and setup. Skipping lands on the crew.
  const CONNECT = {
    claude: {
      name: "Claude",
      blurb: "Claude Pro or Max",
      steps: [
        [
          "Install Claude Code",
          "Already have Claude Code? Skip this step.",
          "curl -fsSL https://claude.ai/install.sh | bash",
        ],
        [
          "Make a sign-in token for Yo",
          "Your browser opens: sign in with the Claude account you want Yo to use.",
          "claude setup-token",
        ],
        ["Paste the token here", "Yo keeps it in your Mac's Keychain.", null],
      ],
    },
    chatgpt: {
      name: "ChatGPT",
      blurb: "ChatGPT Plus, Pro, Business or Enterprise",
      steps: [
        ["Install Codex", "Already have Codex? Skip this step.", "npm install -g @openai/codex"],
        [
          "Sign in with ChatGPT, just for Yo",
          "A separate sign-in kept in its own folder, so the Codex sign-in you already use keeps working.",
          "mkdir -p ~/.yo/codex && CODEX_HOME=~/.yo/codex codex login",
        ],
        [
          "Yo connects on its own",
          "When the browser says you're signed in, this turns green by itself.",
          null,
        ],
      ],
    },
  };
  const CHECKS = [
    ["Memory", "32 GB", "Plenty of room for my computer and your apps."],
    ["Memory for my computer", "4 GB", "Enough for a full browser and a terminal."],
    ["Processor", "Apple M2, 8 cores", "Apple silicon runs my computer natively and quickly."],
    ["Free disk space", "120 GB", "Plenty of space."],
    ["macOS version", "macOS 15", "Up to date."],
  ];
  const yoAvatar = '<img src="/assets/avatars/yo.svg" alt="" width="32" height="32" />';
  const first = el("div", "a-first");
  first.setAttribute("role", "region");
  first.setAttribute("aria-label", "First run");
  root.appendChild(first);
  let firstProvider = null;

  const firstFrame = (body) => {
    first.innerHTML = `<div class="a-first-top"><div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>
      <button type="button" class="a-first-skip" data-first-skip>Skip to the app</button></div>
      <div class="a-first-body">${body}</div>`;
    first.querySelector("[data-first-skip]").addEventListener("click", () => endFirst());
    first.scrollTop = 0;
  };
  const q = (sel) => first.querySelector(sel);

  function firstPick() {
    firstFrame(`<div class="a-first-center">
      <img src="/assets/logo.svg" alt="" width="52" height="52" />
      <h3>Connect your model</h3>
      <p>Yo runs on the plan you already pay for. Pick one to start. You can add the other later.</p>
      <div class="a-first-picks">
        ${Object.entries(CONNECT)
          .map(
            ([id, p]) =>
              `<button type="button" class="a-first-pick" data-pick="${id}"><i style="background:${MODELS[id].color}"></i><b>${p.name}</b><small>${p.blurb}</small></button>`,
          )
          .join("")}
      </div></div>`);
    first.querySelectorAll("[data-pick]").forEach((b) => {
      b.addEventListener("click", () => firstSteps(b.dataset.pick));
    });
  }

  function firstSteps(id) {
    firstProvider = id;
    const p = CONNECT[id];
    firstFrame(`<div class="a-first-col">
      <button type="button" class="a-link" data-back>← Back</button>
      <h3><i style="background:${MODELS[id].color}"></i>Connect ${p.name}</h3>
      <ol class="a-first-steps">
        ${p.steps
          .map(
            ([title, text, cmd], i) => `<li><span class="n">${i + 1}</span><div><b>${title}</b><p>${text}</p>
              ${cmd ? `<div class="a-cmd"><code></code><button type="button" class="a-link" data-copy-cmd>Copy</button></div>` : ""}
              ${!cmd && id === "claude" ? '<div class="a-token"><input aria-label="Token" placeholder="Paste the token" data-token /><button type="button" class="a-btn a-btn-primary" data-connect>Connect</button></div>' : ""}
              </div></li>`,
          )
          .join("")}
      </ol>
      <div class="a-first-status" data-status role="status"><i></i><span></span></div>
      <button type="button" class="a-btn a-btn-brand" data-continue hidden>Continue</button>
    </div>`);
    const cmds = p.steps.filter((s) => s[2]).map((s) => s[2]);
    first.querySelectorAll(".a-cmd").forEach((box, i) => {
      box.querySelector("code").textContent = cmds[i];
      box.querySelector("[data-copy-cmd]").addEventListener("click", (e) => {
        navigator.clipboard?.writeText(cmds[i]).catch(() => {});
        e.target.textContent = "Copied";
      });
    });
    q("[data-back]").addEventListener("click", firstPick);
    const status = q("[data-status]");
    const setStatus = (state, text) => {
      status.className = `a-first-status is-${state}`;
      status.querySelector("span").textContent = text;
    };
    const connected = () => {
      setStatus("ok", `${p.name} is connected`);
      q("[data-continue]").hidden = false;
      q("[data-continue]").focus({ preventScroll: true });
      first.scrollTo({ top: first.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    };
    q("[data-continue]").addEventListener("click", firstChat);
    if (id === "claude") {
      setStatus("idle", "Waiting for the token");
      q("[data-connect]").addEventListener("click", () => {
        q("[data-token]").value = "•••••••••••••••••••••••";
        q("[data-connect]").disabled = true;
        setTimeout(connected, 500);
      });
    } else {
      setStatus("wait", "Waiting for you to sign in… (in this demo, it signs in by itself)");
      setTimeout(() => {
        if (firstProvider === id && q("[data-status]") === status) connected();
      }, 2600);
    }
  }

  function agentLine(html) {
    const n = el("div", "a-first-line", `${yoAvatar}<div class="a-first-say">${html}</div>`);
    q("[data-chat]").appendChild(n);
    scrollFirst();
    return n;
  }
  // Follow the conversation inside the window only; never scroll the page under the visitor.
  function scrollFirst() {
    if (q("[data-chat]").children.length > 1)
      first.scrollTo({ top: first.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }
  function userLine(text) {
    const n = el("div", "a-msg mine", '<div class="a-bub"></div>');
    n.firstChild.textContent = text;
    q("[data-chat]").appendChild(n);
    scrollFirst();
  }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const later = (ms, fn) => setTimeout(fn, reduce ? 0 : ms);

  function firstChat() {
    active = AGENTS[0];
    active.model = firstProvider ?? "claude";
    firstFrame(`<div class="a-first-chat" data-chat></div>`);
    const greet =
      agentLine(`<p class="lead">Looks like we have a model connected. Let's set up my computer.</p>
      <p>I work on a computer of my own, with its own desktop and browser, so your files stay private unless you share them. Where should it run?</p>
      <div class="a-where">
        <button type="button" data-where="local"><b>This Mac</b><span>Runs here in a small virtual machine. I'll check this Mac first.</span><em class="ok">Free</em></button>
        <button type="button" data-where="home"><b>Home server</b><span>Your own always-on PC at home. I keep working while your Mac sleeps.</span><em class="warn">Advanced</em></button>
        <button type="button" disabled><b>Cloud</b><span>We'll let you know when it's ready.</span><em>Coming soon</em></button>
      </div>`);
    greet.querySelectorAll("[data-where]").forEach((b) => {
      b.addEventListener("click", () => {
        greet.querySelectorAll("[data-where]").forEach((x) => {
          x.disabled = true;
          x.classList.toggle("is-on", x === b);
        });
        if (b.dataset.where === "local") firstLocal();
        else firstHome();
      });
    });
  }

  function firstHome() {
    userLine("Home server");
    later(500, () => {
      const n =
        agentLine(`<p>Good pick if you have a PC that's always on. It's the advanced path: in the app I walk you
        through it step by step (Docker, Yo's source and a private SSH tunnel). For this demo, let's run it on this Mac.</p>
        <div class="a-row"><button type="button" class="a-btn a-btn-brand" data-use-local>Use this Mac instead</button></div>`);
      n.querySelector("[data-use-local]").addEventListener("click", (e) => {
        e.target.disabled = true;
        firstLocal();
      });
    });
  }

  function firstLocal() {
    userLine("This Mac");
    later(500, () => {
      const n = agentLine(`<p>Let me check this Mac against what my computer needs.</p>
        <ul class="a-checks">${CHECKS.map(() => "<li><i></i><b></b><span></span><small></small></li>").join("")}</ul>`);
      n.querySelectorAll(".a-checks li").forEach((li, i) => {
        const [label, value, detail] = CHECKS[i];
        li.querySelector("b").textContent = label;
        li.querySelector("span").textContent = value;
        li.querySelector("small").textContent = detail;
        later(250 + i * 220, () => li.classList.add("is-pass"));
      });
      later(250 + CHECKS.length * 220 + 300, () => {
        const r =
          agentLine(`<p>This Mac is a great fit, and everything I need is installed. The first start downloads my
          computer (about 1 GB) and takes a few minutes. It uses up to 5 GB of memory, only while it's on.</p>
          <div class="a-row"><button type="button" class="a-btn a-btn-brand" data-start>Start my computer</button></div>`);
        r.querySelector("[data-start]").addEventListener("click", (e) => {
          e.target.hidden = true;
          firstBoot();
        });
      });
    });
  }

  function firstBoot() {
    const STEPS = ["Start the virtual machine", "Get my computer ready", "Connect to my computer"];
    const n = agentLine(
      `<ul class="a-checks a-boot">${STEPS.map(() => "<li><i></i><b></b></li>").join("")}</ul>`,
    );
    const items = [...n.querySelectorAll("li")];
    items.forEach((li, i) => {
      li.querySelector("b").textContent = STEPS[i];
    });
    items.forEach((li, i) => {
      later(i * 700, () => li.classList.add("is-run"));
      later(i * 700 + 650, () => li.classList.replace("is-run", "is-pass"));
    });
    later(STEPS.length * 700 + 200, () => {
      const d =
        agentLine(`<p>My computer is live. From here on it's really me answering, on your model. What should we do first?</p>
        <div class="a-row"><button type="button" class="a-btn a-btn-brand" data-done>Start chatting →</button></div>`);
      d.querySelector("[data-done]").addEventListener("click", () => endFirst());
    });
  }

  function endFirst() {
    if (first.hidden) return;
    first.hidden = true;
    root.classList.remove("is-first");
    renderAll();
  }
  root.classList.add("is-first");
  firstPick();

  // Hooks for the rest of the page: open an agent, or hand a task to the best-suited one.
  const ROUTES = [
    [/coffee|buy|order|price|cheap|cart|reorder|groceries/i, "shopper"],
    [/inbox|email|reply|unsubscribe|mail/i, "inbox"],
    [/trip|flight|travel|hotel|weekend|vacation/i, "travel"],
    [/calendar|meeting|schedule|week|remind/i, "chief-of-staff"],
    [/research|compare|best|review|sources/i, "researcher"],
    [/code|script|automate|spreadsheet|sheet|csv/i, "builder"],
  ];
  window.yoDemo = {
    open(id) {
      endFirst();
      const a = AGENTS.find((x) => x.id === id);
      if (a) select(a);
    },
    ask(text) {
      const id = ROUTES.find(([re]) => re.test(text))?.[1] ?? "yo";
      this.open(id);
      setTimeout(() => userSays(text), 450);
    },
  };

  renderAll();
})();
