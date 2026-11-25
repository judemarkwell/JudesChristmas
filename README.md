# 🎄 Gift Circles

Family wishlists that keep the surprise. Everyone signs in with Google, joins a circle (like "Markwell Family") by invite link, and keeps their own wishlist and sizes. Everyone in the circle can see who's buying what, except the person the gift is for.

Live at **https://judemarkwell.github.io/JudesChristmas/**

## How it works

| Tab | What it does |
| --- | --- |
| 🏡 **Family** | Everyone in your circle, with wish counts and upcoming birthdays. Tap someone to see their list and sizes, and claim a gift. Admins see who's waiting to join. |
| 🎁 **My list** | Your wishes: add, edit and remove them, plus your sizes, favorites, "please don't buy" list and pay-back handles. You never see claims on your own list. |
| 🛷 **Shopping** | Everything you've claimed, for everyone, with a "bought" checkbox. |
| 📸 **Memories** | The circle's photo scrapbook, by year. |

The account button (top right) switches circles, opens circle settings (invite link, approvals, members, admins), and signs out.

**Joining:** an admin copies the invite link from circle settings and sends it out. Whoever opens it signs in and taps **Ask to join**, and an admin lets them in. Making a new link stops the old one from working.

**The surprise rule** is enforced by the database (`firestore.rules`), not just hidden in the page: claims on your list can be read only by people who share a circle with you, and never by you.

## Firebase setup (one time)

Already done for the `christmas-circle` project:

1. Created the project and a web app. The config is in `js/config.js` (safe to publish: it only identifies the project).
2. Authentication → Sign-in method → **Google** enabled.
3. Authentication → Settings → Authorized domains → **judemarkwell.github.io** added.
4. Firestore Database created in production mode.

Still to do:

5. **Firestore Database → Rules**: paste in all of `firestore.rules`, then click **Publish**. Paste it again whenever this file changes.

No paid plan is needed. Photos are shrunk to under ~850 KB and stored in the database itself.

## Editing

- `js/app.js`: the screens
- `js/store.js`: everything that talks to Firebase
- `js/mock-store.js`: an offline stand-in for testing
- `js/links.js`: reads pasted product links, removes tracking junk, and pulls a title from the address when it has one (`node tests/links.test.mjs` tests it)
- `css/styles.css`: the look (colors, fonts and motion are variables at the top)
- `data/items.json`: Jude's original list, offered once as "Import my starter list" when the name matches `starterListFor` in `js/config.js`

### Test without Firebase

Serve the folder and add `?mock` to the address. Add `&as=name` to be different people, and use two tabs to test inviting and claiming:

```bash
python3 -m http.server 8000
# http://localhost:8000/?mock&as=jude
# http://localhost:8000/?mock&as=mom
```

### Phone check

Run this before pushing UI changes. It opens every screen and form at phone sizes against a test family. It simulates the on-screen keyboard both the Android way (page shrinks) and the iPhone or in-app way (keyboard covers the page). It fails if a field or the Save button is hidden, a tap target is under 44px, the page scrolls sideways, or there's a script error.

```bash
pip install playwright && playwright install chromium
python3 tests/mobile_check.py
```

### Rules tests

`tests/rules.test.mjs` walks through founding a circle, inviting, approving, claiming and removing someone, and checks the rules allow and refuse the right things. It needs Java and the Firestore emulator, so run it on your own computer. The commands are at the top of the file.
