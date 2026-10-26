# Agent Huddle Privacy Policy

*Draft — to be reviewed by a solicitor before Agent Huddle is sold. Last updated: [EFFECTIVE DATE].*

## Who we are

[COMPANY NAME] ("we", "us") makes Agent Huddle. For the personal data we handle ourselves (described below), we are the data controller under UK data protection law (the UK GDPR and the Data Protection Act 2018). Contact: hello@agenthuddle.net, [ADDRESS]. [ICO registration number: [ICO NUMBER].]

## The short version

- Agent Huddle runs on your Mac. Your conversations, attached images, settings and connected tokens are stored **on your Mac, encrypted**, and are **not sent to us**.
- When you talk to an agent, your messages and anything the agent reads are sent **from your Mac to that agent's provider** (for example Anthropic, OpenAI, Google, xAI or Cursor), under your own account with them and their privacy policy.
- We only receive the data needed to sell you a licence, provide support, and [deliver updates].

## Data that stays on your Mac

Agent Huddle stores the following in your Mac user account, in an encrypted database whose key is kept in your macOS Keychain:

- chat rooms, messages and agents' replies;
- images you attach;
- your settings, the repositories you connect, and tokens you add (such as a GitHub token or API keys);
- sign-in sessions for the Agent Huddle window and your phone.

Files in the repositories you connect are kept in a working folder on your Mac so the agents can work on them; these aren't encrypted by Agent Huddle (macOS FileVault encrypts your whole disk if you turn it on). Each agent keeps its own login, which is stored by that agent's software, not by us.

We don't have access to any of this. Deleting Agent Huddle's folder (`~/Library/Application Support/Agent Huddle`) and its Keychain item deletes it.

## Data sent to AI providers

When an agent works on a request, Agent Huddle sends that agent your message, recent conversation in the room, attached images, and the instructions it needs. The agent may then read files in the room's folder and send them to its provider. This happens between your Mac and the provider, under your account and the provider's terms and privacy policy. We don't see or store it, and we aren't responsible for how providers handle it. Please check each provider's policy, especially before connecting confidential code or personal data.

## Phone access

Phone access is optional. If you turn it on, you create an Agent Huddle account and your phone reaches your Mac through our relay at app.agenthuddle.net, which runs on Cloudflare.

- **What the relay stores:** your email address and whether you've confirmed it, a salted hash of your password (never the password itself), the names you give your Macs, sign-in sessions, recent failed sign-in attempts (to stop password guessing), single-use links we've emailed you (only a hash of each, until it's used or expires), and, if you turn on notifications on a device, that device's push address from its browser maker. It keeps these until you delete your account or remove the Mac or device.
- **Emails:** we email you only to confirm your address and to reset your password when you ask. They're sent through Cloudflare Email Service from noreply@agenthuddle.net. We don't send marketing email from the relay.
- **Notifications:** if you turn them on, your Mac encrypts each notification for that one device before it leaves the Mac. The relay passes it to your browser's push service (Apple, Google or Mozilla), which delivers it; neither we nor they can read it. They can see that a notification was sent to your device and when.
- **What the relay can't read:** everything between your phone and your Mac (pages, messages, images, files) is end-to-end encrypted with keys made on your phone and your Mac when you pair them by QR code. The relay only passes on encrypted data, and it never receives the pairing secret or those keys. It does see when your phone and Mac connect, their IP addresses and roughly how much data passes, which Cloudflare logs briefly to run the service.
- **Your own relay:** if you use the advanced option to run a Cloudflare Tunnel on your own Cloudflare account instead, that traffic doesn't touch our relay; it's encrypted in transit (HTTPS) and Cloudflare's privacy policy applies.

## Data we collect

| What | Why | Legal basis | How long |
|---|---|---|---|
| Name, email address, licence and order details | To sell you a licence, send receipts and licence keys, and handle refunds | Contract | [6 years after purchase, for tax records] |
| Payment details | Handled by [PAYMENT PROVIDER], our seller of record; we don't see your card details | Contract | Per [PAYMENT PROVIDER]'s policy |
| Phone access account: email address, password hash, Mac names, sign-in sessions, failed sign-in attempts | To let your phone reach your Mac through our relay, and keep accounts secure | Contract / legitimate interests | Until you delete the account or remove the Mac; failed attempts for 15 minutes |
| Messages you send us for support, and anything you choose to include (such as logs) | To help you | Contract / legitimate interests | [2 years after the conversation ends] |
| IP address, app version and Mac type when the app checks for or downloads an update (from updates.agenthuddle.net, on Cloudflare) | To deliver updates securely | Legitimate interests | As kept in Cloudflare's standard logs |
| [Website analytics] | [To understand how our website is used] | [Consent / legitimate interests] | [ ] |

Agent Huddle doesn't include advertising, and [doesn't send usage analytics or crash reports to us / only sends crash reports if you choose to].

## Sharing

We share personal data only with:

- [PAYMENT PROVIDER], to process payments and tax;
- [EMAIL / SUPPORT PROVIDER], to send emails and handle support;
- [HOSTING PROVIDER], to host our website and updates;
- Cloudflare, which runs the phone relay (it only ever carries end-to-end encrypted data between your phone and your Mac), sends our account emails and hosts app updates;
- Apple, Google or Mozilla, only if you turn on notifications, to deliver them (encrypted) to your device;
- professional advisers, and authorities where the law requires it.

We don't sell personal data.

## International transfers

Some of these providers may process data outside the UK. Where they do, we rely on adequacy regulations or the UK International Data Transfer Agreement/Addendum to protect it.

## Your rights

You have the right to ask for a copy of your personal data, to have it corrected or deleted, to restrict or object to how we use it, and to have it transferred to you or someone else. Where we rely on consent, you can withdraw it at any time. Contact hello@agenthuddle.net; we'll reply within one month.

If you're unhappy with how we've handled your data, you can complain to the Information Commissioner's Office (ico.org.uk), but we'd appreciate the chance to sort it out first.

## Security

The data on your Mac is encrypted with a 256-bit key held in your Keychain. Agent Huddle's background processes only listen on your Mac (127.0.0.1), and agents run in a sandbox that can't read Agent Huddle's own data. We protect the data we hold with access controls and encryption in transit.

## Children

Agent Huddle isn't intended for anyone under 18.

## Changes

We'll update this policy when how we handle data changes, and tell you about significant changes in the app or by email.
