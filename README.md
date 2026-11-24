# 🎄 Jude's Christmas Wishlist

A small, mobile-friendly wishlist site where family can browse what Jude wants, claim gifts without spoiling the surprise, find cheaper alternatives, and keep a scrapbook of Christmas memories.

Plain HTML, CSS and JavaScript. There's no build step, so it runs on GitHub Pages as-is.

## Sections

| Tab | Who it's for | What it does |
| --- | --- | --- |
| 🎁 **Catalog** | Everyone | All wishlist items, with category filters, search, priority hearts, item links and **Cheaper options** (budget picks, a price-comparison search and Amazon price history). |
| 🧝 **Elf Shop** | Family only | Who claimed what, what's been bought, and what's still up for grabs. It's locked behind a family code. |
| 📸 **Memories** | Everyone | Photos grouped by year, polaroid style. Add photos from your phone or by link. |

### Keeping it a surprise ("Elf mode")

Claims are **hidden by default**. Jude's view of the catalog never shows what's been claimed, and the Elf Shop tab says "No peeking!" Family members tap **I'm an elf**, enter the family code, and then:

- see claim status on every catalog card, plus a **Hide claimed** toggle,
- can claim, mark as bought, add a note for other elves, or release a gift,
- see the full Elf Shop dashboard.

Elf mode is remembered on that device, so family only enters the code once.

**Change the family code** so Jude doesn't know it. The default is `northpole`. Have a family member pick a new code and run:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('newcode').digest('hex'))"
```

Then paste the output into `familyCodeHash` in `js/config.js`. Use lowercase, because codes are compared in lowercase. Only the hash is stored in the repo. This is a deterrent, not real security: someone determined could still look at the database.

## Editing the list

Everything lives in `data/items.json`. Each item:

```json
{
  "id": "pb-paddle",                  // unique; don't change once someone has claimed it
  "name": "Vatic Pro Prism Flash 16mm Paddle",
  "category": "Pickleball",           // creates the filter chips automatically
  "emoji": "🏓",
  "url": "https://www.amazon.com/dp/B0BYMGYVTR",
  "priority": 3,                      // 1 nice to have, 2 would love it, 3 top wish
  "note": "Short description",
  "price": 100,                       // optional
  "details": ["16mm core"],           // optional bullet points (sizes, colors…)
  "alternatives": [                   // optional cheaper picks
    { "name": "…", "note": "…", "query": "search terms" }
  ]
}
```

Tip: trim Amazon links down to `https://www.amazon.com/dp/ASIN`. The site uses the ASIN to build the price-history link.

## Memories

Two ways to add photos:

1. **Through the site:** tap **＋ Add a memory**. Photos are resized to about 1280px and saved to the database (or to this browser in demo mode).
2. **Backlog in the repo:** drop images in `/memories` and list them in `data/memories.json`:
   ```json
   { "id": "2024-tree", "year": 2024, "caption": "Tree day", "image": "memories/2024-tree.jpg" }
   ```

## Run it locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The page has to be served (not opened as a file) so it can load the JSON files.

## Phone check

Run this before pushing UI changes. It opens every screen and form at phone sizes, simulates the on-screen keyboard, and fails if a field or the Save button is hidden, a tap target is under 44px, the page scrolls sideways, or there's a script error.

```bash
pip install playwright && playwright install chromium
python3 tests/mobile_check.py
```

New forms go in the `FORMS` list at the top of the script.

## Sharing claims with family (Firebase)

Out of the box the site runs in **demo mode**: claims and memories are saved only in the browser you're using. To let everyone see the same claims live:

1. Create a free project at [console.firebase.google.com](https://console.firebase.google.com), then add a **Web app**.
2. Open **Firestore Database → Create database** (production mode).
3. Paste the web app config into `firebase` in `js/config.js`.
4. Set these Firestore rules (Rules tab):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /claims/{itemId} {
      allow read: if true;
      allow create, update: if request.resource.data.name is string
                            && request.resource.data.name.size() <= 40;
      allow delete: if true;
    }
    match /memories/{id} {
      allow read, create, delete: if true;
    }
  }
}
```

Claims use a transaction, so two people can't claim the same gift at once.

## Deploy (GitHub Pages)

Repo **Settings → Pages → Deploy from a branch → `main` / root**. The site will be at `https://judemarkwell.github.io/JudesChristmas/`.

## Structure

```
index.html          page shell, tabs, modal
css/styles.css      theme (colors and fonts are CSS variables at the top)
js/config.js        owner name, family code hash, Firebase config
js/store.js         storage: local (demo) or Firebase, same interface
js/app.js           views, elf mode, claiming, memories, snow and countdown
data/items.json     the wishlist
data/memories.json  photos that ship with the site
memories/           image files for those photos
```
