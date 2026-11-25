"""Phone UI check for the wishlist site.

Opens every screen and form at phone sizes and reports problems people hit on a phone:
  - keyboard: with the on-screen keyboard open, the field being typed in or the form's
    main button is hidden
  - tap-size: a button, link or field smaller than 44px tall
  - overflow: the page is wider than the screen (sideways scrolling)
  - errors: JavaScript errors

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
    ('guest', '#family'),          # landing page
    ('newbie', '#family'),         # first-time setup
    ('jude', '#family'), ('jude', '#mine'), ('jude', '#person-u-mom'), ('jude', '#shop'),
    ('jude', '#memories'), ('jude', '#circle'),
    ('mom', '#person-u-jude'), ('mom', '#shop'), ('mom', '#circle'),
]
# Each form: who, where, how to open it, then the selector of its <form>.
FORMS = [
    ('Add a wish', 'jude', '#mine', ['#add-wish'], '#item-form'),
    ('Edit a wish', 'jude', '#mine', ['[data-action=edit] >> nth=0'], '#item-form'),
    ('Edit profile', 'jude', '#mine', ['#edit-profile'], '#profile-form'),
    ('Claim a gift', 'mom', '#person-u-jude', ['[data-action=claim] >> nth=0'], '#claim-form'),
    ('Add a memory', 'jude', '#memories', ['#add-memory'], '#memory-form'),
]


def fixture():
    items = json.loads((ROOT / 'data/items.json').read_text())['items'][:6]
    member = lambda name, role='member', status='active': {'name': name, 'photoURL': '', 'role': role, 'status': status}
    profile = lambda name: {'name': name, 'photoURL': '', 'birthday': '', 'visibility': 'circle',
                            'sizes': {'shirt': 'L', 'shoe': '10.5'}, 'favorites': {'colors': 'Green'}, 'avoid': '', 'payback': {}}
    return {
        'users': {'u-jude': profile('Jude'), 'u-mom': profile('Mom'), 'u-sam': profile('Sam')},
        'index': {'u-jude': {'circles': ['c1']}, 'u-mom': {'circles': ['c1']}, 'u-sam': {'circles': []}},
        'circles': {'c1': {'name': 'Markwell Family', 'createdBy': 'u-jude', 'inviteCode': 'testcode12345678',
                           'members': {'u-jude': member('Jude', 'admin'), 'u-mom': member('Mom'),
                                       'u-sam': member('Sam', status='pending')},
                           'memories': {}}},
        'invites': {'testcode12345678': {'circleId': 'c1', 'circleName': 'Markwell Family', 'createdBy': 'u-jude'}},
        'items': {'u-jude': {it['id']: {k: v for k, v in it.items() if k != 'id'} for it in items},
                  'u-mom': {'scarf': {'name': 'Wool scarf', 'emoji': '🧣', 'priority': 2}}, 'u-sam': {}},
        'claims': {'u-jude': {}, 'u-mom': {}, 'u-sam': {}},
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
      for (const who of ['jude', 'mom', 'newbie']) localStorage.setItem('mock.signedIn.' + who, '1');
    }""", fixture())

    for who, hash_ in VIEWS:
        page.set_viewport_size({'width': w, 'height': h})
        open_as(page, who, hash_)
        where = f'{who} {hash_}'
        if page.evaluate('document.documentElement.scrollWidth > innerWidth + 1'):
            fail('overflow', where, 'page scrolls sideways')
        for t in page.evaluate(TAP_TARGETS):
            fail('tap-size', where, f"'{t['name']}' is {t['h']}px tall")

    for name, who, hash_, steps, form in FORMS:
        page.set_viewport_size({'width': w, 'height': h})
        open_as(page, who, hash_)
        for step in steps:
            page.click(step)
        page.wait_for_selector(form)
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
        page.keyboard.press('Escape')


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
