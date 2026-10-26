# agenthuddle.net (not published)

Landing page + waitlist for agenthuddle.net. On hold: Agent Huddle is personal-use only for now, until the
AI providers' terms on using subscription logins from a third-party app are settled (see the chat of
2026-10-25). Before publishing, change the copy to match whatever is decided (subscriptions vs API keys,
which agents are named), then: create the D1 database `agenthuddle-site` from schema.sql, put its id in
wrangler.jsonc, set the WAITLIST_SECRET secret, and attach agenthuddle.net + www to the Worker.
