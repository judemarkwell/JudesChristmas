"""Phone UI check for the wishlist site.

Opens every screen and form at phone sizes and reports problems people hit on a phone:
  - keyboard: with the on-screen keyboard open, the field being typed in or the form's
    main button is hidden
  - tap-size: a button, link or field smaller than 44px tall
  - overflow: the page is wider than the screen (sideways scrolling)
  - errors: JavaScript errors
  - layout: after typing in a form and closing it, the page didn't spring back (window left
    scrolled, or the tab bar stranded mid-screen)
  - tab-bar: the tab bar is pinned with position: fixed, can't be tapped after scrolling, or the
    whole page scrolls instead of just the content (newer iPhones misplace taps on fixed bars)

Screens run against the offline test database (?mock), so no Firebase is needed.

The keyboard is simulated two ways:
  - resizing:  the page shrinks when the keyboard opens (Android Chrome)
  - overlay:   the page keeps its size and the keyboard covers the bottom of the screen
               (iPhones, and pages embedded in an app such as the Claude preview)
A field or button counts as hidden if it ends up under the keyboard in either mode.

Usage:  pip install playwright && playwright install chromium
        python3 tests/mobile_check.py            # exits 1 if anything fails
"""

import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8799
BASE = f'http://localhost:{PORT}/'
PHONES = [('iPhone 14', 390, 844), ('small Android', 360, 740)]
KEYBOARD = 336  # typical phone keyboard height in CSS px

# Screens run against the offline test database (?mock), loaded with a small family:
# Jude (admin, with his starter list), Mom (member), Sam (waiting to be let in),
# a signed-in newcomer with no circle yet, and a signed-out visitor.
VIEWS = [
    ('guest', '#circles'),         # landing page
    ('newbie', '#circles'),        # no circle yet
    ('jude', '#circles'), ('jude', '#circle-c1'), ('jude', '#settings-c1'), ('jude', '#mine'),
    ('jude', '#shop'), ('jude', '#profile'), ('jude', '#person-u-mom'), ('jude', '#list-u-mom'),
    ('mom', '#circle-c1'), ('mom', '#settings-c1'), ('mom', '#person-u-jude'), ('mom', '#list-u-jude'), ('mom', '#shop'),
    ('tia', '#circles'), ('tia', '#list-u-jude'),
]
# Each form: who, where, how to open it, then the selector of its <form>.
FORMS = [
    ('Start a circle', 'jude', '#circles', ['#start-circle'], '#create-form'),
    ('Join with a link', 'newbie', '#circles', ['#join-circle'], '#paste-form'),
    ('Add a wish', 'jude', '#mine', ['#add-wish'], '#item-form'),
    ('Edit a wish', 'jude', '#mine', ['[data-action=edit] >> nth=0'], '#item-form'),
    ('Edit profile', 'jude', '#profile', ['#edit-profile'], '#profile-form'),
    ('Claim a gift', 'mom', '#list-u-jude', ['[data-action=claim] >> nth=0'], '#claim-form'),
    ('Manage a claim', 'mom', '#list-u-jude', ['[data-action=manage] >> nth=0'], '#manage-form'),
    ('Circle memory', 'jude', '#circle-c1', ['#add-memory'], '#memory-form'),
    ('Profile memory', 'jude', '#profile', ['#post-memory'], '#memory-form'),
    ('Rename circle', 'jude', '#settings-c1', [], '#rename-form'),
]


def fixture():
    items = json.loads((ROOT / 'data/items.json').read_text())['items'][:6]
    member = lambda name, role='member', status='active': {'name': name, 'photoURL': '', 'role': role, 'status': status}
    profile = lambda name: {'name': name, 'photoURL': '', 'birthday': '', 'visibility': 'circle',
                            'sizes': {'shirt': 'L', 'shoe': '10.5'}, 'favorites': {'colors': 'Green'}, 'avoid': '', 'payback': {}}
    return {
        'users': {'u-jude': profile('Jude'), 'u-mom': profile('Mom'), 'u-sam': profile('Sam'), 'u-tia': profile('Tia')},
        'index': {'u-jude': {'circles': ['c1', 'c2']}, 'u-mom': {'circles': ['c1']}, 'u-sam': {'circles': []},
                  'u-tia': {'circles': ['c2']}},
        'circles': {'c1': {'name': 'Markwell Family', 'createdBy': 'u-jude', 'inviteCode': 'testcode12345678',
                           'members': {'u-jude': member('Jude', 'admin'), 'u-mom': member('Mom'),
                                       'u-sam': member('Sam', status='pending')},
                           'memories': {}},
                    # Friends: Jude and Tia. Tia shares no circle with Mom.
                    'c2': {'name': 'Friends', 'createdBy': 'u-jude', 'inviteCode': 'friendscode1234',
                           'members': {'u-jude': member('Jude', 'admin'), 'u-tia': member('Tia')}, 'memories': {}}},
        'invites': {'testcode12345678': {'circleId': 'c1', 'circleName': 'Markwell Family', 'createdBy': 'u-jude'}},
        'items': {'u-jude': {it['id']: {k: v for k, v in it.items() if k != 'id'} for it in items},
                  'u-mom': {'scarf': {'name': 'Wool scarf', 'emoji': '🧣', 'priority': 2}}, 'u-sam': {}},
        # Mom has claimed Jude's first wish.
        'claims': {'u-jude': {items[0]['id']: {'by': 'u-mom', 'owner': 'u-jude', 'byName': 'Mom', 'itemName': items[0]['name'],
                                               'note': 'getting the black one', 'purchased': False, 'claimedAt': 1}},
                   'u-mom': {}, 'u-sam': {}, 'u-tia': {}},
        'pmem': {},
    }


def open_as(page, who, hash_):
    page.goto(f'{BASE}?mock&as={who}{hash_}')
    page.wait_for_timeout(700)


TAP_TARGETS = """
() => [...document.querySelectorAll('button, a.btn, .tab, .chip, input:not([type=hidden]), textarea, select, .seg-opt, .icon-opt')]
  .filter(el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && el.type !== 'radio' && el.type !== 'checkbox';
  })
  .map(el => ({ name: (el.innerText || el.name || el.className || el.tagName).trim().slice(0, 40), h: Math.round(el.getBoundingClientRect().height) }))
  .filter(t => t.h < 44)
"""

VISIBLE = """
(el, keyboard) => {
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const bottom = top + (vv ? vv.height : innerHeight) - keyboard;
  // Hidden if outside the visible area or sitting under a sticky element.
  const inView = r.top >= top - 1 && r.bottom <= bottom + 1;
  const x = r.left + r.width / 2, y = Math.min(r.top + r.height / 2, bottom - 2);
  const hit = document.elementFromPoint(x, y);
  return inView && (hit === el || el.contains(hit) || (hit && hit.closest('label') === el.closest('label')));
}
"""


def check(page, phone, w, h, problems):
    def fail(kind, where, detail):
        problems.append(f'[{phone}] {kind}: {where}: {detail}')

    page.goto(f'{BASE}?mock&as=guest')
    page.evaluate("""(db) => {
      localStorage.clear();
      localStorage.setItem('mock.db', JSON.stringify(db));
      for (const who of ['jude', 'mom', 'newbie', 'tia']) localStorage.setItem('mock.signedIn.' + who, '1');
    }""", fixture())

    for who, hash_ in VIEWS:
        page.set_viewport_size({'width': w, 'height': h})
        open_as(page, who, hash_)
        where = f'{who} {hash_}'
        if page.evaluate('document.documentElement.scrollWidth > innerWidth + 1'):
            fail('overflow', where, 'page scrolls sideways')
        # Newer iPhones' Safari can misplace taps on position: fixed bars, so the tab bar must
        # be part of the layout, and still be the thing under your finger after scrolling.
        if who != 'guest':
            nav = page.evaluate('''() => {
              const nav = document.querySelector('.tabs');
              const sc = document.getElementById('scroller');
              if (sc) sc.scrollTop = sc.scrollHeight;
              const misses = [...nav.querySelectorAll('.tab')].filter((t) => {
                const r = t.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !(hit && t.contains(hit));
              }).length;
              return { fixed: getComputedStyle(nav).position === 'fixed', misses,
                       docScrolls: document.documentElement.scrollHeight > innerHeight + 1 };
            }''')
            if nav['fixed']:
                fail('tab-bar', where, 'tab bar is position: fixed (taps can fall through on iPhone)')
            if nav['misses']:
                fail('tab-bar', where, f"{nav['misses']} tab(s) not tappable after scrolling")
            if nav['docScrolls']:
                fail('tab-bar', where, 'the whole page scrolls instead of the content area')
        for t in page.evaluate(TAP_TARGETS):
            fail('tap-size', where, f"'{t['name']}' is {t['h']}px tall")

    for name, who, hash_, steps, form in FORMS:
        page.set_viewport_size({'width': w, 'height': h})
        open_as(page, who, hash_)
        for step in steps:
            page.click(step)
        page.wait_for_selector(form)
        in_sheet = page.evaluate(f"!!document.querySelector('#modal {form}')")
        fields = page.locator(f'{form} input:not([type=radio]):not([type=checkbox]):not([type=file]), {form} textarea')
        submit = page.locator(f'{form} [type=submit]')
        for mode in ('resizing', 'overlay'):
            for i in range(fields.count()):
                field = fields.nth(i)
                label = field.get_attribute('name') or f'field {i + 1}'
                page.set_viewport_size({'width': w, 'height': h})
                page.wait_for_timeout(150)
                field.focus()
                if mode == 'resizing':
                    page.set_viewport_size({'width': w, 'height': h - KEYBOARD})
                    covered = 0
                else:
                    covered = KEYBOARD
                page.wait_for_timeout(800)
                if not field.evaluate(VISIBLE, covered):
                    fail('keyboard', f'{name} ({mode})', f"'{label}' is hidden behind the keyboard")
                if submit.count() and not submit.first.evaluate(VISIBLE, covered):
                    fail('keyboard', f'{name} ({mode})', f"main button is hidden while typing in '{label}'")
            page.evaluate('document.activeElement && document.activeElement.blur()')
            page.set_viewport_size({'width': w, 'height': h})
        for t in page.evaluate(TAP_TARGETS):
            fail('tap-size', name, f"'{t['name']}' is {t['h']}px tall")
        if page.evaluate("(() => { const m = document.getElementById('modal'); return m.scrollWidth > m.clientWidth + 1; })()"):
            fail('overflow', name, 'the sheet is wider than the screen')
        if in_sheet:
            page.keyboard.press('Escape')
        # After the keyboard and the pop-up close, the layout must be back in place: window not
        # scrolled, page filling the screen, tab bar at the bottom (not stranded mid-screen).
        page.set_viewport_size({'width': w, 'height': h})
        page.wait_for_timeout(500)
        if who != 'guest':
            lay = page.evaluate('''() => {
              const nav = document.querySelector('.tabs').getBoundingClientRect();
              return { scrollY: window.scrollY, bodyBottom: document.body.getBoundingClientRect().bottom,
                       navBottom: nav.bottom, h: innerHeight };
            }''')
            if lay['scrollY'] > 0 or abs(lay['bodyBottom'] - lay['h']) > 2 or lay['h'] - lay['navBottom'] > 40:
                fail('layout', name, f"layout didn't settle after closing (scrollY {lay['scrollY']}, "
                                     f"page ends at {round(lay['bodyBottom'])} of {lay['h']}, tab bar ends at {round(lay['navBottom'])})")


def main():
    server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)], cwd=ROOT,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    problems = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for phone, w, h in PHONES:
                page = browser.new_page(viewport={'width': w, 'height': h}, has_touch=True, is_mobile=True)
                page.on('pageerror', lambda e, ph=phone: problems.append(f'[{ph}] errors: {e}'))
                check(page, phone, w, h, problems)
                page.close()
            browser.close()
    finally:
        server.terminate()

    problems = list(dict.fromkeys(problems))
    if problems:
        print(f'{len(problems)} problem(s):')
        for line in problems:
            print('  -', line)
        sys.exit(1)
    print('Phone UI check passed: no hidden fields, small targets, overflow or errors.')


if __name__ == '__main__':
    main()
