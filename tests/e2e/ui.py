#!/usr/bin/env python3
"""Browser end-to-end tests. Needs the harness running:  node tests/e2e/harness.mjs

    python3 tests/e2e/ui.py [base_url] [screenshot_dir]

Drives the real website (headless Chromium) against the real database, real Edge Function
handlers and a canned Gemini. Prints one line per check and exits non-zero if any failed.
"""
import json, os, re, struct, sys, zlib, urllib.request
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else '/tmp/qb-shots'
os.makedirs(SHOTS, exist_ok=True)
DL = os.path.join(SHOTS, 'downloads'); os.makedirs(DL, exist_ok=True)

results = []
results_done = False
def check(name, cond, detail=''):
    results.append((bool(cond), name, detail))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'   <- {detail}'), flush=True)

def ctl(**body):
    req = urllib.request.Request(BASE + '/__ctl', data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
    return json.load(urllib.request.urlopen(req))

PUMP = []   # set to the admin page's wait_for_timeout so polling lets Playwright serve the browser's requests

def until(fn, timeout=15, what='condition'):
    """Poll a Python predicate (the page's CSP forbids string-eval, so no wait_for_function)."""
    import time
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return True
        except Exception:
            pass
        if PUMP: PUMP[0](150)
        else: time.sleep(0.15)
    raise AssertionError(f'timed out waiting for {what}')

def png(path, w=240, h=120):
    raw = b''.join(b'\x00' + bytes([(x * 255 // w), (y * 255 // h), 180] * 1) * 1 for y in range(h) for x in range(w) for _ in [0]) if False else b''
    rows = b''.join(b'\x00' + b''.join(bytes([x * 255 // w, y * 255 // h, 180]) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))

IMG = os.path.join(SHOTS, 'sample.png'); png(IMG)
TXT = os.path.join(SHOTS, 'notes.txt'); open(TXT, 'w').write('not an image')

QUESTIONS = [
    # nested shape from the product brief
    {"question": {"text": "Which of these is the SI unit of amount of substance?", "type": "mcq",
                  "options": [{"id": "A", "text": "kilogram"}, {"id": "B", "text": "mole"}, {"id": "C", "text": "kelvin"}, {"id": "D", "text": "candela"}]},
     "answer": {"value": "B"}, "explanation": "The mole counts elementary entities.",
     "classification": {"subject": "Chemistry", "chapter": "Some Basic Concepts of Chemistry", "category": "exam"},
     "exam": {"name": "JEE Main", "year": 2019}, "metadata": {"difficulty": "easy", "marks": 4, "tags": ["units", "mole"]}},
    {"type": "mcq", "question": "Number of significant figures in 0.00250 is", "options": ["2", "3", "4", "5"], "answer": "B",
     "subject": "Chemistry", "chapter": "Some Basic Concepts of Chemistry", "difficulty": "medium", "tags": ["sig figs"]},
    {"type": "numerical", "question": "Molar mass of water in g/mol (nearest integer)?", "answer": {"number": 18, "unit": "g/mol", "tolerance": 0.5},
     "explanation": "2(1) + 16 = 18", "subject": "Chemistry", "chapter": "Some Basic Concepts of Chemistry", "difficulty": "easy"},
    {"type": "true_false", "question": "An electron has a negative charge.", "answer": True, "subject": "Chemistry", "chapter": "Structure of Atom"},
    {"type": "mcq", "question": "XSS probe <img src=x onerror=\"window.__xss=1\"> <script>window.__xss=2</script> pick one", "options": ["<b>bold</b>", "plain"], "answer": "B",
     "subject": "Chemistry", "chapter": "Structure of Atom"},
    {"type": "mcq", "question": "This one names a chapter that does not exist", "options": ["a", "b"], "answer": "A", "subject": "Chemistry", "chapter": "Underwater Basket Weaving"},
    {"type": "match_following", "question": "Match the scientist with the model.", "match": {"left": ["Thomson", "Rutherford"], "right": ["Nuclear model", "Plum pudding"]}, "answer": "A-2, B-1",
     "subject": "Chemistry", "chapter": "Structure of Atom"},
    {"type": "short_answer", "question": "State Avogadro's law.", "answer": "Equal volumes of gases at the same T and P contain equal numbers of molecules.",
     "subject": "Chemistry", "chapter": "Some Basic Concepts of Chemistry", "difficulty": "hard"},
    {"type": "assertion_reason", "question": "Assertion: Atoms are neutral. Reason: They have equal protons and electrons.",
     "options": ["Both true, R explains A", "Both true, R does not explain A", "A true, R false", "A false, R true"], "answer": "A",
     "subject": "Chemistry", "chapter": "Structure of Atom"},
]
VALID = len(QUESTIONS) - 1


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--no-sandbox'])
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True, service_workers='block')
        # Deterministic: the sandbox has no internet, so never wait on Google Fonts.
        ctx.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
        page = ctx.new_page()
        problems = []
        page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
        page.on('console', lambda m: problems.append(f'console.{m.type}: {m.text}') if m.type in ('error',) and 'ERR_FAILED' not in m.text and 'fonts.g' not in m.text and 'Failed to load resource' not in m.text else None)  # 4xx are provoked on purpose; CSP violations and script errors are not
        page.on('dialog', lambda d: d.dismiss())

        PUMP.append(page.wait_for_timeout)
        def go(path): page.goto(BASE + path); page.wait_for_load_state('networkidle')
        def shot(name): page.screenshot(path=f'{SHOTS}/{name}.png', full_page=True)
        def text(): return page.inner_text('body')
        def no_overflow(label):
            w = page.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
            check(f'no horizontal scroll: {label}', w[0] <= w[1] + 1, str(w))

        import atexit
        def dump():
            try:
                print('--- page at exit:', page.url); print(page.inner_text('body')[:1500])
                page.screenshot(path=f'{SHOTS}/failure.png', full_page=True)
            except Exception: pass
        try:
            # ------------------------------------------------------------ public, empty
            ctl(reset=True)
            go('/')
            check('home loads with site name and copyright', 'Question Bank' in text() and 'AyanP_Chem' in text())
            check('empty bank says so honestly (no fake data)', re.search(r'no (published )?questions|0 (published )?questions|nothing', text(), re.I) is not None, text()[:300])
            shot('01-home-empty')

            # ------------------------------------------------------------ sign-in
            go('/admin')
            check('admin page asks for sign-in', page.locator('#login').count() == 1)
            page.fill('#em', 'admin@example.com'); page.fill('#pw', 'wrong'); page.click('#login button')
            until(lambda: 'Wrong email or password' in page.inner_text('#login-err'), what='wrong-password message')
            check('wrong password -> clear message', 'Wrong email or password' in page.inner_text('#login-err'), page.inner_text('#login-err'))
            page.fill('#em', 'reader@example.com'); page.fill('#pw', 'just-a-reader-1'); page.click('#login button')
            until(lambda: 'Wrong email or password' not in page.inner_text('#login-err') and page.inner_text('#login-err').strip(), what='non-admin message')
            check('signed-in non-admin is refused', 'not an admin' in page.inner_text('#login-err'), page.inner_text('#login-err'))
            check('refused user holds no session', page.evaluate("localStorage.getItem('qb.session')") is None)
            page.fill('#em', 'admin@example.com'); page.fill('#pw', 'correct-horse-battery'); page.click('#login button')
            until(lambda: 'questions in total' in text(), what='dashboard stats')
            check('admin signs in and sees dashboard', True)
            shot('02-dashboard')

            # ------------------------------------------------------------ JSON import
            go('/admin/add?tab=json')
            page.fill('#json', '{"questions": [ {"type": "mcq", ')   # broken
            page.click('#jf button[type=submit]')
            page.wait_for_selector('#j-err .notice')
            check('malformed JSON: error with position, nothing imported', 'Nothing was imported' in page.inner_text('#j-err') and re.search(r'line \d+', page.inner_text('#j-err')) is not None, page.inner_text('#j-err'))
            page.fill('#json', json.dumps({"questions": QUESTIONS}))
            page.click('#jf button[type=submit]')
            page.wait_for_selector('.item-list')
            until(lambda: page.locator('.item .badge.review, .item .badge.draft').count() >= 9, what='review rows')
            rows = page.locator('.item-list > li')
            check('review lists every imported item', rows.count() == len(QUESTIONS), str(rows.count()))
            bad = page.locator('.item.bad')
            check('exactly the invalid item is flagged, with the reason', bad.count() == 1 and 'Underwater Basket Weaving' in bad.first.inner_text(), bad.first.inner_text() if bad.count() else 'none flagged')
            check('invalid item cannot be selected', bad.first.locator('input[data-act=sel]').is_disabled())
            check('valid items preselected', page.locator('input[data-act=sel]:checked').count() == VALID, str(page.locator('input[data-act=sel]:checked').count()))
            shot('03-review')
            page.select_option('#st', 'published')
            page.click('[data-act=save]')
            until(lambda: page.locator('.item .badge.published').count() >= VALID, 20, 'saved badges')
            check('selective approval: valid saved, invalid left behind', page.locator('.item .badge.published').count() == VALID and page.locator('.item.bad').count() == 1)
            ids = page.locator('.item .badge.published').all_inner_texts()
            check('public IDs are assigned like QB-CHEM-000001', all(re.search(r'QB-CHEM-\d{6}', i) for i in ids), str(ids))

            # duplicate: same question again must be caught
            go('/admin/add?tab=json')
            page.fill('#json', json.dumps({"questions": [QUESTIONS[1], dict(QUESTIONS[1], question="Number of significant figures in 0.00250 is  ")]}))
            page.click('#jf button[type=submit]')
            page.wait_for_selector('.item-list'); page.wait_for_selector('.dupe')
            check('exact duplicate detected and blocked', 'Already in the bank' in text() and page.locator('input[data-act=sel]:checked').count() == 0, text()[:300])

                # near duplicate: warned, needs an explicit "different question" confirmation
            go('/admin/add?tab=json')
            page.fill('#json', json.dumps({"questions": [{"type": "mcq", "question": "Which is the SI unit for amount of substance?", "options": ["kilogram", "mole", "kelvin", "candela"], "answer": "B", "subject": "Chemistry", "chapter": "Some Basic Concepts of Chemistry"}]}))
            page.click('#jf button[type=submit]')
            page.wait_for_selector('.dupe')
            check('near duplicate is warned with similarity and link', 'Looks similar' in page.inner_text('.dupe') and 'QB-CHEM-' in page.inner_text('.dupe'), page.inner_text('.dupe'))
            page.click('[data-act=save]')
            until(lambda: 'Nothing selected' not in page.inner_text('[data-act=save]') or page.locator('.item .e, .item li.e').count() > 0 or page.locator('.badge.published, .badge.draft', has_text='Saved').count() > 0, 15, 'near dup save attempt')
            check('near duplicate is NOT saved silently', page.locator('.badge', has_text='Saved as').count() == 0, page.inner_text('.item-list')[:300])
            page.check('[data-act=near]')
            page.click('[data-act=save]')
            until(lambda: page.locator('.badge', has_text='Saved as').count() == 1 or 'status=' in page.url, 15, 'near dup confirmed save')
            check('near duplicate saved after the admin confirms', True)

        # ------------------------------------------------------------ AI from image
            go('/admin/add?tab=image')
            check('privacy notice about free-tier AI is shown', 'may use what you send' in text())
            page.set_input_files('#file', TXT)
            page.wait_for_selector('#x-err .notice')
            check('non-image upload rejected in the browser', page.locator('#go').is_disabled() and page.locator('#x-err .notice').count() == 1, page.inner_text('#x-err'))
            page.set_input_files('#file', IMG)
            page.wait_for_selector('#queue .q-item img')
            check('image preview shown, button enabled', page.locator('#go').is_enabled())
            ctl(reset=True, gemini='quota')
            page.click('#go')
            page.wait_for_selector('#x-err .notice')
            msg = page.inner_text('#x-err')
            check('free quota exhausted -> clear message, nothing charged, JSON fallback offered', 'charged' in msg.lower() and 'Paste JSON' in msg, msg)
            used = ctl(sql="select coalesce(sum(used),0) from public.ai_usage")['out'].strip().split()[-1]
            check('a read that Google refused is given back (not counted)', used == '0', used)
            ctl(gemini='garbage')
            page.click('#go'); page.wait_for_selector('#x-err .notice')
            check('garbled AI output handled gracefully', 'Try again' in page.inner_text('#x-err') or 'try again' in page.inner_text('#x-err'), page.inner_text('#x-err'))
            ctl(gemini='ok')
            page.click('#go')
            page.wait_for_url('**/admin/review')
            page.wait_for_selector('.item-list')
            check('AI result lands in review, not in the database', page.locator('.item-list > li').count() == 2)
            check('AI provenance shown (no answer found)', page.locator('.badge.draft', has_text='No answer found').count() == 1)
            check('AI item without answer cannot be saved until fixed', page.locator('.item.bad').count() == 1)
            state = ctl()
            g = state['log']['gemini']
            check('Gemini was called with the key in a header, never in the URL', len(g) >= 1 and all(x['keyHeader'] and not x['keyInUrl'] for x in g), str(g))
            shot('04-ai-review')
            # fix the missing answer by hand
            page.locator('.item.bad [data-act=edit]').click()
            page.wait_for_selector('[data-host]:not([hidden]) input[name=correct]')
            host = page.locator('[data-host]:not([hidden])').first
            host.locator('input[name=correct]').nth(1).check()
            host.locator('[data-act=apply]').click()
            until(lambda: page.locator('.item.bad').count() == 0, what='item fixed')
            check('admin supplies the answer, item becomes saveable', page.locator('input[data-act=sel]:checked').count() == 2)
            page.select_option('#st', 'review')
            page.click('[data-act=save]')
            page.wait_for_url('**/admin/questions?status=review', timeout=20000)
            until(lambda: page.locator('tbody tr').count() > 0, what='review list')
            check('AI drafts saved as "review" with an AI badge', page.locator('.badge.ai').count() >= 1, text()[:300])

            # ------------------------------------------------------------ upload restrictions on the server itself
            tok = json.loads(page.evaluate("localStorage.getItem('qb.session')"))['access_token']
            def post_img(data, ctype='image/png', name='x.png'):
                return page.request.post(BASE + '/functions/v1/extract-question', headers={'authorization': f'Bearer {tok}'},
                                          multipart={'image': {'name': name, 'mimeType': ctype, 'buffer': data}})
            r = post_img(b'MZ\x90\x00' + b'0' * 100)
            check('server rejects a non-image disguised as PNG', r.status in (400, 415), f'{r.status} {r.text()[:120]}')
            r = post_img(b'\x89PNG\r\n\x1a\n' + b'0' * (3 * 1024 * 1024 + 10))
            check('server rejects an oversized upload', r.status in (400, 413), f'{r.status}')
            r = page.request.post(BASE + '/functions/v1/extract-question', multipart={'image': {'name': 'x.png', 'mimeType': 'image/png', 'buffer': open(IMG, 'rb').read()}})
            check('server rejects anonymous callers', r.status == 401, str(r.status))
            r = page.request.post(BASE + '/functions/v1/save-questions', data='{"mode":"save","items":[]}', headers={'content-type': 'application/json'})
            check('save endpoint rejects anonymous callers', r.status == 401, str(r.status))

            # ------------------------------------------------------------ manual question
            ctl(sql="insert into public.chapters (subject_id, name, slug, sort_order) select id, 'Kinematics', 'kinematics', 10 from public.subjects where code = 'PHY'")
            go('/admin/edit/new')
            page.wait_for_selector('#f-text')
            page.select_option('#f-subj', label='Physics')
            page.select_option('#f-chap', index=1)
            page.fill('#f-text', 'Which quantity is a vector?')
            page.fill('#f-opt-0', 'Mass'); page.fill('#f-opt-1', 'Speed'); page.fill('#f-opt-2', 'Velocity'); page.fill('#f-opt-3', 'Energy')
            page.locator('input[name=correct]').nth(2).check()
            page.fill('#f-exp', 'Velocity has direction.')
            page.select_option('#f-diff', 'easy')
            page.select_option('#st', 'published')
            page.click('#save')
            until(lambda: '/admin/edit/QB-PHY-' in page.evaluate('location.pathname'), 15, 'redirect to saved question')
            check('manual question saved with QB-PHY id', re.search(r'/admin/edit/QB-PHY-\d{6}', page.evaluate('location.pathname')) is not None, page.url)

            # ------------------------------------------------------------ destructive actions ask first
            page.wait_for_selector('[data-act=del-opt]')
            n_opts = page.locator('[data-opt]').count()
            page.locator('[data-act=del-opt]').nth(n_opts - 1).click()
            page.wait_for_selector('dialog[open]')
            dlg = page.inner_text('dialog')
            check('removing an option asks first and names it', 'Remove option D?' in dlg and 'Energy' in dlg, dlg)
            page.click('dialog button[value=cancel]')
            until(lambda: page.locator('dialog').count() == 0, 5, 'dialog closed')
            check('cancelling keeps the option', page.locator('[data-opt]').count() == n_opts)
            page.locator('[data-act=del-opt]').nth(n_opts - 1).click()
            page.wait_for_selector('dialog[open]'); page.click('dialog button[value=ok]')
            until(lambda: page.locator('[data-opt]').count() == n_opts - 1, 5, 'option removed after confirming')
            check('confirming removes the option', True)
            page.select_option('#st', 'draft'); page.click('#save')
            page.wait_for_selector('dialog[open]')
            check('unpublishing a published question asks first', 'Unpublish QB-PHY-' in page.inner_text('dialog'), page.inner_text('dialog'))
            page.click('dialog button[value=cancel]')
            until(lambda: page.locator('dialog').count() == 0, 5, 'dialog closed')

            # ------------------------------------------------------------ admin list, bulk publish
            go('/admin/questions?status=review')
            page.locator('#all').check()
            page.select_option('#bs', 'published'); page.click('#bapply'); page.click('dialog button[value=ok]')
            until(lambda: page.locator('tbody tr').count() == 0 or page.locator('.empty-state').count() > 0, 15, 'review list emptied')
            go('/admin/questions?status=published')
            n = page.locator('tbody tr').count()
            check('bulk status change publishes the selection', n >= VALID + 2, str(n))
            shot('05-admin-list')

            # ------------------------------------------------------------ public browsing (signed in as admin; then anonymous)
            anon = browser.new_context(viewport={'width': 1280, 'height': 900})
            anon.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
            pub = anon.new_page()
            pub_problems = []
            pub.on('pageerror', lambda e: pub_problems.append(f'pageerror: {e}'))
            pub.on('console', lambda m: pub_problems.append(f'console: {m.text}') if m.type == 'error' and 'ERR_FAILED' not in m.text and 'fonts.g' not in m.text and 'Failed to load resource' not in m.text else None)
            def pgo(path): pub.goto(BASE + path); pub.wait_for_load_state('networkidle')

            pgo('/')
            t = pub.inner_text('body')
            check('home lists subjects with counts', 'Chemistry' in t and 'Physics' in t)
            shot('06-home')
            # filter-first browsing: nothing listed until a filter is chosen; dropdowns across the top
            pgo('/search')
            check('all-questions page lists nothing until a filter is chosen', pub.locator('article.q').count() == 0 and 'Choose a filter' in pub.inner_text('body'), pub.inner_text('body')[:200])
            check('filter dropdowns sit across the top and the left filter menu is gone', pub.locator('.fbar select').count() >= 9 and pub.locator('nav.filters, .browse, aside').count() == 0, str(pub.locator('.fbar select').count()))
            check('chapter and topic dropdowns wait for their parent', pub.locator('#fb-chapter').is_disabled() and pub.locator('#fb-topic').is_disabled())
            shot('06b-filter-first')
            pub.select_option('#fb-subject', 'chemistry')
            until(lambda: pub.locator('article.q').count() > 0, 10, 'subject questions listed')
            check('choosing a subject lists its questions', '/browse/chemistry' in pub.url and pub.locator('#fb-subject').input_value() == 'chemistry', pub.url)
            check('chapter dropdown is filled from the chosen subject', 'Some Basic Concepts of Chemistry' in ' '.join(o.text_content() for o in pub.locator('#fb-chapter option').all()))
            pub.select_option('#fb-chapter', 'some-basic-concepts-of-chemistry')
            until(lambda: pub.url.endswith('/some-basic-concepts-of-chemistry') and pub.locator('article.q').count() > 0, 10, 'chapter questions listed')
            check('choosing a chapter narrows the list and fills the topic dropdown', pub.locator('#fb-topic').is_enabled() or pub.locator('#fb-topic option').count() >= 1)
            pub.select_option('#fb-type', 'numerical')
            until(lambda: 'type=numerical' in pub.url and pub.locator('article.q').count() == 1, 10, 'type narrowed')
            check('type dropdown narrows the list', pub.locator('article.q').count() == 1 and 'Molar mass' in pub.inner_text('body'))
            pub.select_option('#fb-subject', '')
            until(lambda: '/search' in pub.url and pub.locator('article.q').count() == 0, 10, 'subject cleared')
            check('clearing the subject resets chapter and topic', '/search' in pub.url and 'chapter' not in pub.url)
            pub.click('[data-clear]')
            until(lambda: pub.url.rstrip('/').endswith('/search') and 'Choose a filter' in pub.inner_text('body'), 10, 'cleared')
            check('Clear all filters returns to the empty start', pub.locator('article.q').count() == 0)
            pub.fill('#fb-q', 'mole'); pub.press('#fb-q', 'Enter')
            until(lambda: pub.locator('article.q').count() >= 1, 10, 'search from the bar')
            check('search box in the filter bar works', 'q=mole' in pub.url)
            pgo('/browse/chemistry')
            check('subject page opens with its questions and the subject chosen in the dropdown', pub.locator('article.q').count() > 0 and pub.locator('#fb-subject').input_value() == 'chemistry')
            pgo('/browse/chemistry/some-basic-concepts-of-chemistry')
            cards = pub.locator('article.q')
            check('chapter page shows published questions only', cards.count() >= 4, str(cards.count()))
            check('unpublished invalid item never appears', 'Underwater' not in pub.inner_text('body'))
            first = cards.first
            check('answer hidden until asked', first.locator('.answer').is_hidden())
            first.locator('.reveal-btn').click()
            check('Show answer reveals answer', first.locator('.answer').is_visible() and first.locator('.reveal-btn').get_attribute('aria-expanded') == 'true')
            pub.keyboard.press('Tab')
            pub.locator('.reveal-btn').nth(1).focus(); pub.keyboard.press('Enter')
            check('Show answer works from the keyboard', pub.locator('.reveal-btn').nth(1).get_attribute('aria-expanded') == 'true')
            check('correct option highlighted', pub.locator('.opts li.correct').count() >= 1)
            shot('07-chapter')
            no_overflow('chapter page')

            # filters + search
            pgo('/browse/chemistry?type=numerical')
            check('type filter narrows to numerical', pub.locator('article.q').count() == 1 and 'Molar mass' in pub.inner_text('body'), str(pub.locator('article.q').count()))
            pgo('/search?q=mole')
            check('global search finds by text', pub.locator('article.q').count() >= 1 and 'SI unit' in pub.inner_text('body'), pub.inner_text('body')[:200])
            pgo('/browse/chemistry?exam=1')
            pgo('/search?tag=units')
            check('tag filter works', pub.locator('article.q').count() == 1)
            pgo('/search?q=zzzzqqqq')
            check('empty search shows a helpful empty state', 'No questions' in pub.inner_text('body') or 'No results' in pub.inner_text('body') or 'No published' in pub.inner_text('body'), pub.inner_text('body')[:200])
            pgo('/browse/chemistry')
            more_opts = ' '.join(o.text_content() for o in pub.locator('#fb-exam option, #fb-difficulty option, #fb-year option, #fb-marks option, #fb-tag option').all())
            check('More filters holds exam, year, difficulty, marks and tag dropdowns', 'JEE Main' in more_opts and ('Easy' in more_opts or 'Medium' in more_opts), more_opts[:300])
            pub.click('.fbar-more summary')
            pub.select_option('#fb-exam', label=[o.text_content() for o in pub.locator('#fb-exam option').all() if 'JEE Main' in o.text_content()][0])
            until(lambda: 'exam=' in pub.url, 10, 'exam filter applied')
            until(lambda: pub.locator('article.q').count() >= 1, 10, 'exam rows')
            check('exam dropdown filters the list', pub.locator('article.q').count() >= 1, pub.url)

            # single question page + XSS
            pgo('/search?q=XSS')
            check('XSS probe is shown as text', pub.locator('article.q .q-text').first.inner_text().startswith('XSS probe <img'), pub.locator('article.q .q-text').first.inner_text()[:80])
            check('XSS probe did not execute', pub.evaluate('window.__xss') is None and pub.locator('article.q img').count() == 0)
            check('option HTML is escaped too', '<b>bold</b>' in pub.inner_text('article.q'))
            pid = pub.locator('article.q .q-id').first.inner_text()
            pgo(f'/q/{pid}')
            check('direct question link works', pid in pub.inner_text('body'))
            pgo('/q/QB-CHEM-999999')
            check('unknown question id -> not-found message', 'not found' in pub.inner_text('body').lower())
            pgo('/definitely/not/a/page')
            check('unknown route -> friendly 404', 'does not exist' in pub.inner_text('body').lower())

            # public cannot see admin areas or drafts
            pgo('/admin/questions')
            check('anonymous visitor gets sign-in, not admin data', pub.locator('#login').count() == 1)
            r = pub.request.post(BASE + '/rest/v1/rpc/qb_search_questions', data=json.dumps({'p_status': 'draft', 'p_limit': 500}), headers={'content-type': 'application/json', 'apikey': 'sb_publishable_test0123456789'})
            body = r.json()
            check('anon API cannot read drafts or exceed 50 rows', all(i['status'] == 'published' for i in body['items']) and len(body['items']) <= 50, str(body)[:200])
            r = pub.request.get(BASE + '/rest/v1/questions?select=*', headers={'apikey': 'sb_publishable_test0123456789'})
            check('anon has no direct table access to questions', r.status in (401, 403), str(r.status))
            r = pub.request.post(BASE + '/rest/v1/subjects', data=json.dumps({'code': 'HACK', 'name': 'Hack', 'slug': 'hack'}), headers={'content-type': 'application/json', 'apikey': 'sb_publishable_test0123456789'})
            check('anon cannot write master data', r.status in (401, 403), str(r.status))

            # ------------------------------------------------------------ taxonomy admin
            go('/admin/taxonomy')
            page.fill('#ns-code', 'GEO'); page.fill('#ns-name', 'Geography'); page.click('#add-subject button[type=submit]')
            page.wait_for_selector('summary:has-text("Geography")')
            check('add subject', True)
            page.locator('details[data-key^=s]', has_text='Geography').first.locator('summary [data-act=add-chapter]').click()
            page.fill('dialog input', 'Rivers'); page.click('dialog button[value=ok]')
            page.wait_for_selector('text=Rivers')
            page.locator('details[data-key^=s]', has_text='Geography').first.locator('details[data-key^=c]', has_text='Rivers').locator('summary [data-act=add-topic]').click()
            page.fill('dialog input', 'The Nile'); page.click('dialog button[value=ok]')
            page.wait_for_selector('text=The Nile')
            check('add chapter and topic', True)
            page.locator('details[data-key^=s]', has_text='Geography').first.locator('summary [data-act=rename]').first.click()
            page.fill('dialog input', 'World Geography'); page.click('dialog button[value=ok]')
            page.wait_for_selector('summary:has-text("World Geography")')
            check('rename subject (code stays)', 'GEO' in text())
            page.locator('details[data-key^=s]', has_text='World Geography').first.locator('summary [data-act=up]').first.click()
            page.wait_for_timeout(600)
            order = page.locator('details[data-key^=s] > summary .tx-name').all_inner_texts()
            check('move up changes order', 'World Geography' in order[-2] if len(order) > 1 else False, str(order))
            page.locator('details[data-key^=s]', has_text='World Geography').first.locator('summary [data-act=toggle]').first.click()
            page.wait_for_selector('dialog[open]')
            check('hiding a subject asks first', 'Hide' in page.inner_text('dialog'), page.inner_text('dialog'))
            page.click('dialog button[value=ok]')
            page.wait_for_selector('.is-off')
            check('hide subject', page.locator('.badge:has-text("hidden")').count() >= 1)
            go('/admin/add?tab=json')
            check('hidden subject not offered in pickers', 'World Geography' not in page.inner_text('#d-s'))
            go('/admin/taxonomy')
            page.locator('details[data-key^=s]', has_text='Chemistry').first.locator('summary [data-act=delete]').first.click()
            page.click('dialog button[value=ok]')
            page.wait_for_selector('.toast.bad')
            check('deleting a subject in use is refused with advice', 'Hide it instead' in page.inner_text('.toast.bad'), page.inner_text('.toast.bad'))
            page.locator('details[data-key^=s]', has_text='World Geography').first.locator('summary [data-act=delete]').first.click()
            page.click('dialog button[value=ok]')
            page.wait_for_selector('.toast.bad')
            check('deleting a non-empty subject is refused', True)
            shot('08-taxonomy')

            # ------------------------------------------------------------ export
            go('/admin/export')
            def export(fmt, **kw):
                page.check(f'input[name=fmt][value={fmt}]')
                for k, v in kw.items():
                    if isinstance(v, bool):
                        (page.check if v else page.uncheck)(f'input[name={k}]')
                with page.expect_download() as d:
                    page.click('#x-go')
                dl = d.value
                path = os.path.join(DL, dl.suggested_filename); dl.save_as(path)
                return path
            am = json.load(open(export('am')))
            check('Atomic Minds export format/version', am['format'] == 'atomic-minds-question-bank' and am['version'] == 1)
            check('Atomic Minds export keeps QB IDs and 0-based answer index', all(re.match(r'QB-[A-Z]+-\d{6}', q['id']) for q in am['questions']) and any(q['options'] and isinstance(q['answer'], int) for q in am['questions']))
            check('objective-only by default', all(q['options'] for q in am['questions']) and am['count'] == len(am['questions']), str(am['count']))
            mole = next(q for q in am['questions'] if 'SI unit of amount' in q['question'])
            check('export fields correct (answer index 1, exam source)', mole['answer'] == 1 and mole['sources'] == [{'exam': 'JEE Main', 'year': 2019, 'paper': None}] and mole['category'] == 'exam' and mole['subject'] == 'Chemistry', json.dumps(mole)[:300])
            am2 = json.load(open(export('am', subjective=True)))
            check('subjective types included on request', am2['count'] > am['count'], f"{am['count']} vs {am2['count']}")
            tx = open(export('text', answers=True, expl=True)).read()
            check('plain text layout: Q1. / options on consecutive lines / Ans / Exp', re.search(r'Q1\. .+\n\nA\. .+\nB\. .+\nC\. .+\nD\. .+\n\nAns: [A-D]', tx) is not None, tx[:400])
            check('plain text has explanations', 'Exp: ' in tx)
            tx2 = open(export('text', answers=False, expl=False, ids=True)).read()
            check('plain text can omit answers/explanations and include ids', 'Ans:' not in tx2 and 'Exp:' not in tx2 and 'ID: QB-' in tx2)
            bk = json.load(open(export('backup')))
            check('backup includes all statuses, taxonomy and exams', bk['format'] == 'qb-backup' and bk['count'] >= VALID + 3 and bk['taxonomy'] and bk['exams'], str(bk['count']))
            # manual selection
            page.check('input[name=fmt][value=am]')
            page.check('input[name=scope][value=pick]')
            page.wait_for_selector('#picker .pk')
            page.locator('#picker [data-pid]').first.check()
            with page.expect_download() as d:
                page.click('#x-go')
            sel = json.load(open(d.value.path()))
            check('manual selection exports only chosen question', sel['count'] == 1)
            # filtered export
            page.check('input[name=scope][value=all]')
            page.select_option('#x-sub', label='Physics')
            with page.expect_download() as d:
                page.click('#x-go')
            f = json.load(open(d.value.path()))
            check('filtered export honours subject', f['count'] == 1 and f['questions'][0]['subject'] == 'Physics', str(f['count']))
            page.select_option('#x-sub', ''); page.select_option('#x-type', 'numerical'); page.check('input[name=fmt][value=am]'); page.uncheck('input[name=subjective]')
            page.click('#x-go'); until(lambda: 'fixed options' in page.inner_text('#x-msg'), what='nothing-to-export message')
            check('nothing exportable -> clear message, no file', 'fixed options' in page.inner_text('#x-msg'), page.inner_text('#x-msg'))
            shot('09-export')

            # restore: wipe nothing, but loading the backup must show everything as duplicates (IDs exist)
            go('/admin/export')
            page.set_input_files('#rs', os.path.join(DL, os.listdir(DL)[0]) if False else [os.path.join(DL, f) for f in os.listdir(DL) if f.startswith('question-bank-backup')][0])
            page.wait_for_url('**/admin/review'); page.wait_for_selector('.item-list')
            page.wait_for_selector('.dupe')
            check('restoring onto a bank that already has them flags every question as existing', page.locator('.dupe').count() >= VALID, str(page.locator('.dupe').count()))

            # full round trip: wipe the questions, restore the backup file, compare
            before = json.load(open([os.path.join(DL, f) for f in os.listdir(DL) if f.startswith('question-bank-backup')][0]))
            ctl(sql='delete from public.question_exams; delete from public.questions')
            go('/admin/export')
            page.set_input_files('#rs', [os.path.join(DL, f) for f in os.listdir(DL) if f.startswith('question-bank-backup')][0])
            page.wait_for_url('**/admin/review'); page.wait_for_selector('.item-list')
            until(lambda: page.locator('.item .badge.review').count() == before['count'], 20, 'restore rows ready')
            check('restore shows every question as ready on an empty bank', page.locator('.item.bad').count() == 0 and page.locator('.dupe').count() == 0, str(page.locator('.item.bad').count()))
            page.click('[data-act=save]')
            page.wait_for_url('**/admin/questions*', timeout=30000)
            ctl(reset=False)
            page.set_viewport_size({'width': 1280, 'height': 900})
            go('/admin/export')
            page.check('input[name=fmt][value=backup]'); page.select_option('#x-status', '')
            with page.expect_download() as d:
                page.click('#x-go')
            after = json.load(open(d.value.path()))
            key = lambda q: (q['id'], q['status'], q['type'], q['question'], json.dumps(q['options']), json.dumps(q['answer']), q['explanation'], q['subject'], q['chapter'], json.dumps(q['exams']), json.dumps(q['tags']), q['difficulty'])
            check('restored bank equals the backup (ids, statuses, text, answers, exams, tags)', sorted(map(key, after['questions'])) == sorted(map(key, before['questions'])) and after['count'] == before['count'], f"{before['count']} vs {after['count']}")

            # ------------------------------------------------------------ responsive + theme + a11y spot checks
            for w, h, label in [(375, 800, 'mobile'), (768, 900, 'tablet'), (1280, 900, 'desktop')]:
                pub.set_viewport_size({'width': w, 'height': h})
                for path, nm in [('/', 'home'), ('/browse/chemistry/some-basic-concepts-of-chemistry', 'chapter'), ('/search?q=mole', 'search')]:
                    pgo(path)
                    ow = pub.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
                    check(f'no horizontal scroll {label} {nm}', ow[0] <= ow[1] + 1, str(ow))
                    if nm in ('home', 'chapter'): pub.screenshot(path=f'{SHOTS}/r-{label}-{nm}.png', full_page=True)
            page.set_viewport_size({'width': 375, 'height': 800})
            for path, nm in [('/admin', 'dashboard'), ('/admin/questions?status=published', 'list'), ('/admin/taxonomy', 'taxonomy'), ('/admin/export', 'export'), ('/admin/add?tab=json', 'add')]:
                go(path)
                ow = page.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
                check(f'no page-level horizontal scroll on mobile admin {nm}', ow[0] <= ow[1] + 1, str(ow))
                page.screenshot(path=f'{SHOTS}/r-mobile-admin-{nm}.png', full_page=True)
            dctx = browser.new_context(color_scheme='dark', viewport={'width': 1000, 'height': 800}); dctx.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
            dark = dctx.new_page()
            dark.goto(BASE + '/browse/chemistry/some-basic-concepts-of-chemistry'); dark.wait_for_load_state('networkidle')
            bg = dark.evaluate('getComputedStyle(document.body).backgroundColor')
            check('dark mode applies a dark background', sum(int(x) for x in re.findall(r'\d+', bg)[:3]) < 200, bg)
            dark.locator('.reveal-btn').first.click(); dark.screenshot(path=f'{SHOTS}/r-dark-chapter.png', full_page=True)

            # ------------------------------------------------------------ phone layout (also writes review screenshots)
            state = ctx.storage_state()
            for scheme in ('dark', 'light'):
                mctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme=scheme, storage_state=state)
                mctx.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
                m = mctx.new_page()
                def mgo(path): m.goto(BASE + path); m.wait_for_load_state('networkidle'); m.wait_for_timeout(250)
                def mshot(name): m.screenshot(path=f'{SHOTS}/m-{scheme}-{name}.png', full_page=name in ('revealed',)); m.screenshot(path=f'{SHOTS}/v-{scheme}-{name}.png')
                def mover(label):
                    w = m.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
                    check(f'phone ({scheme}) no horizontal scroll: {label}', w[0] <= w[1] + 1, str(w))
                for path, name in [('/', 'home'), ('/search', 'filters'), ('/browse/chemistry', 'browse'), ('/search?q=mole', 'search'), ('/admin', 'dash'), ('/admin/add', 'add'), ('/admin/questions?status=published', 'list'), ('/admin/taxonomy', 'taxonomy'), ('/admin/export', 'export')]:
                    mgo(path); mover(name); mshot(name)
                mgo('/admin')
                m.click('#menu-btn'); m.wait_for_selector('#menu:not([hidden])')
                mt = m.inner_text('#menu')
                check(f'phone ({scheme}) hamburger menu lists browse and admin pages', all(x in mt for x in ('Subjects', 'All questions', 'Chemistry', 'Taxonomy', 'Export', 'Sign out')), mt)
                mshot('menu')
                m.keyboard.press('Escape'); m.wait_for_selector('#menu', state='hidden')
                check(f'phone ({scheme}) Escape closes the menu', m.get_attribute('#menu-btn', 'aria-expanded') == 'false')
                m.click('#menu-btn'); m.wait_for_selector('#menu:not([hidden])'); m.click('#menu a[href="/admin/taxonomy"]')
                until(lambda: m.evaluate('location.pathname') == '/admin/taxonomy', 8, 'menu navigates')
                check(f'phone ({scheme}) menu link navigates and closes the menu', m.locator('#menu:not([hidden])').count() == 0)
                mgo('/browse/chemistry')
                if m.locator('.reveal-btn').count():
                    m.locator('.reveal-btn').first.click(); m.wait_for_timeout(1100); mshot('revealed')
                row = m.locator('tbody tr a[href^="/admin/edit/"]').first
                if row.count():
                    mgo(row.get_attribute('href')); mover('editor'); mshot('editor')
                mctx.close()

            dctx2 = browser.new_context(viewport={'width': 1280, 'height': 860}, color_scheme='dark', storage_state=state)
            dctx2.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
            dp = dctx2.new_page()
            for path, name in [('/', 'home'), ('/browse/chemistry', 'browse'), ('/admin', 'dash'), ('/admin/questions?status=published', 'list')]:
                dp.goto(BASE + path); dp.wait_for_load_state('networkidle'); dp.wait_for_timeout(250)
                w = dp.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
                check(f'desktop no horizontal scroll: {name}', w[0] <= w[1] + 1, str(w))
                dp.screenshot(path=f'{SHOTS}/d-dark-{name}.png')
            dctx2.close()

            # ------------------------------------------------------------ chemistry text, structures, pictures
            ctl(reset=False); page.set_viewport_size({'width': 1280, 'height': 900})
            go('/admin/edit/new'); page.wait_for_selector('#f-text')
            page.select_option('#f-subj', label='Chemistry'); page.select_option('#f-chap', index=1)
            page.fill('#f-text', 'Balance 2H2 + O2 -> 2H2O. Is H2SO4 an acid; what of Fe^{3+}?\n     |\n    CH3')
            page.wait_for_selector('[data-prev=question_text]:not([hidden])')
            check('editor previews chemistry formatting live', page.locator('[data-prev=question_text] sub').count() >= 3 and '→' in page.inner_text('[data-prev=question_text]'), page.inner_html('[data-prev=question_text]'))
            check('editor preview recognises a drawn structure', page.locator('[data-prev=question_text] .struct').count() == 1)
            page.fill('#f-opt-0', 'H2SO4'); page.fill('#f-opt-1', 'NaCl'); page.fill('#f-opt-2', 'SO42-'); page.fill('#f-opt-3', 'none')
            page.locator('input[name=correct]').nth(0).check(); page.select_option('#st', 'published'); page.click('#save')
            until(lambda: '/admin/edit/QB-CHEM-' in page.evaluate('location.pathname'), 15, 'chem question saved')
            fpid = page.evaluate('location.pathname').split('/')[-1]
            pub.goto(BASE + '/q/' + fpid); pub.wait_for_selector('.q-text')
            check('public page shows subscripts, superscripts and arrows', pub.locator('.q-text sub').count() >= 3 and pub.locator('.q-text sup').count() == 1 and '→' in pub.inner_text('.q-text'), pub.inner_html('.q-text'))
            check('options are formatted too (H₂SO₄, SO₄²⁻)', pub.locator('.opts sub').count() >= 2 and pub.locator('.opts sup').count() == 1)
            check('drawn structure is shown in a fixed-width block', pub.locator('.q-text.struct').count() == 1 and 'mono' in pub.evaluate("getComputedStyle(document.querySelector('.q-text')).fontFamily").lower() or 'Cascadia' in pub.evaluate("getComputedStyle(document.querySelector('.q-text')).fontFamily"), pub.evaluate("getComputedStyle(document.querySelector('.q-text')).fontFamily"))
            check('stored text is unchanged (formatting is display-only)', 'H2SO4' in ctl(sql="select question_text from public.questions where public_id = '%s'" % fpid)['out'])
            pub.screenshot(path=f'{SHOTS}/p-chem.png', full_page=True)

            # a picture: choose, crop, save, see it publicly
            go('/admin/edit/' + fpid); page.wait_for_selector('[data-act=pic-add]')
            with page.expect_file_chooser() as fc: page.click('[data-act=pic-add]')
            fc.value.set_files(IMG)
            page.wait_for_selector('dialog.crop-dialog[open] canvas')
            cb = page.locator('dialog.crop-dialog canvas').bounding_box()
            page.mouse.move(cb['x'] + 20, cb['y'] + 15); page.mouse.down(); page.mouse.move(cb['x'] + cb['width'] * 0.7, cb['y'] + cb['height'] * 0.7, steps=6); page.mouse.up()
            until(lambda: not page.locator('[data-use-part]').is_disabled(), 5, 'crop selection enabled the button')
            check('crop dialog reports the selected size', 'Selected:' in page.inner_text('[data-crop-note]'), page.inner_text('[data-crop-note]'))
            page.click('[data-use-part]')
            page.wait_for_selector('.pic .q-fig img')
            check('chosen picture previews in the editor', page.locator('.pic .q-fig img').get_attribute('src').startswith('data:image/'))
            page.click('#save'); until(lambda: page.locator('.toast', has_text='Saved').count() > 0, 10, 'saved toast')
            check('picture stored in the database (small)', ctl(sql='select count(*) || \'/\' || coalesce(max(bytes),0) from public.question_images')['out'].startswith('1/'), ctl(sql='select count(*) from public.question_images')['out'])
            sz = int(ctl(sql='select max(bytes) from public.question_images')['out'])
            check('stored picture is shrunk (under 110 KB)', 0 < sz <= 110 * 1024, str(sz))
            pub.goto(BASE + '/q/' + fpid); pub.wait_for_selector('.q-fig img')
            until(lambda: pub.evaluate("document.querySelector('.q-fig img').naturalWidth") > 0, 8, 'picture decoded')
            check('public page shows the picture under the question', pub.locator('.q-text + .q-fig img').count() == 1)
            ctl(sql="update public.questions set status = 'draft' where public_id = '%s'" % fpid)
            pub2 = anon.new_page(); pub2.goto(BASE + '/q/' + fpid); pub2.wait_for_timeout(600)
            check('an unpublished question and its picture are hidden from the public', pub2.locator('.q-fig').count() == 0 and pub2.locator('.q-text').count() == 0)
            pub2.close()
            ctl(sql="update public.questions set status = 'published' where public_id = '%s'" % fpid)
            go('/admin'); check('dashboard counts the picture', 'pictures saved' in text() and page.locator('.stat b', has_text='1').count() >= 1, text()[:300])

            # pictures backup, remove, restore
            go('/admin/export'); page.check('input[name=fmt][value=pictures]'); page.select_option('#x-status', '')
            with page.expect_download() as dl: page.click('#x-go')
            pics = json.load(open(dl.value.path()))
            check('pictures backup holds the picture by question ID', pics['format'] == 'qb-pictures' and pics['count'] == 1 and fpid in pics['pictures'] and pics['pictures'][fpid]['data'], str(list(pics)))
            go('/admin/edit/' + fpid); page.wait_for_selector('[data-act=pic-del]'); page.click('[data-act=pic-del]')
            page.wait_for_selector('dialog[open]'); check('removing a picture asks first', 'Remove the picture?' in page.inner_text('dialog'))
            page.click('dialog button[value=ok]'); page.click('#save'); until(lambda: ctl(sql='select count(*) from public.question_images')['out'].strip().endswith('0'), 10, 'picture removed')
            check('picture removed from the database', True)
            go('/admin/export'); page.set_input_files('#rp', dl.value.path())
            page.wait_for_selector('dialog[open]'); page.click('dialog button[value=ok]')
            until(lambda: 'restored' in page.inner_text('#rp-msg'), 15, 'pictures restored')
            check('pictures restore puts the picture back on the same question', ctl(sql='select count(*) from public.question_images')['out'].strip().endswith('1'), page.inner_text('#rp-msg'))

            # ------------------------------------------------------------ several photos at once
            ctl(sql="update public.questions set status = 'archived' where origin = 'ai_image'")
            IMG2 = os.path.join(SHOTS, 'sample2.png'); png(IMG2, 200, 100)
            ctl(reset=True, gemini='ok'); go('/admin/add?tab=image')
            page.set_input_files('#file', [IMG, IMG2])
            until(lambda: page.locator('#queue .q-item').count() == 2, 8, 'two photos queued')
            check('two photos are listed and the button says so', 'Read 2 photos' in page.inner_text('#go'), page.inner_text('#go'))
            page.locator('#queue [data-rm]').nth(1).click()
            check('a queued photo can be removed before reading', page.locator('#queue .q-item').count() == 1)
            page.set_input_files('#file', IMG2)
            until(lambda: page.locator('#queue .q-item').count() == 2, 8, 'photo re-added')
            page.click('#go'); page.wait_for_url('**/admin/review'); page.wait_for_selector('.item-list')
            check('both photos are read one after the other into one review list', page.locator('.item-list > li').count() == 4, str(page.locator('.item-list > li').count()))
            check('review says which photo each question came from', page.locator('.item-list .muted', has_text='Photo 2').count() == 2)
            check('two reads were counted, one per photo', ctl(sql='select coalesce(sum(used),0) from public.ai_usage')['out'].strip().endswith('2'))
            shot('06-multi-review')
            # crop a figure out of the scanned photo during review
            page.locator('.item-list > li').first.locator('[data-act=edit]').click()
            page.wait_for_selector('[data-host]:not([hidden]) [data-act=pic-scan]')
            page.click('[data-host]:not([hidden]) [data-act=pic-scan]')
            page.wait_for_selector('dialog.crop-dialog[open]'); page.click('dialog.crop-dialog button[value=whole]')
            page.wait_for_selector('[data-host]:not([hidden]) .pic .q-fig img')
            page.locator('[data-host]:not([hidden]) [data-act=apply]').click()
            until(lambda: page.locator('.item-list .badge', has_text='Picture added').count() == 1, 10, 'picture added badge')
            page.click('[data-act=none]'); page.locator('.item-list > li').first.locator('input[data-act=sel]').check()
            page.select_option('#st', 'draft'); page.click('[data-act=save]')
            until(lambda: page.locator('.badge', has_text='Saved as').count() >= 1, 15, 'first item saved')
            check('picture chosen during review is saved with the question', ctl(sql='select count(*) from public.question_images')['out'].strip().endswith('2'), ctl(sql='select count(*) from public.question_images')['out'])
            go('/admin/add?tab=image'); ctl(reset=True, gemini='quota')
            page.set_input_files('#file', [IMG, IMG2]); until(lambda: page.locator('#queue .q-item').count() == 2, 8, 'queue')
            page.click('#go'); until(lambda: page.locator('#queue .q-item.skipped').count() == 1, 20, 'second photo skipped')
            qt = page.inner_text('#queue')
            check('when Google refuses, reading stops and the rest are marked not read', 'Not read' in qt and page.locator('#queue .q-item.failed').count() == 1, qt)
            check('refused reads are not counted', ctl(sql='select coalesce(sum(used),0) from public.ai_usage')['out'].strip().endswith('0'))
            ctl(gemini='ok')

            # ------------------------------------------------------------ print worksheet
            go('/admin/worksheet'); page.click('#w-load'); page.wait_for_selector('#pk-all')
            page.fill('#pk-rand', '2'); page.click('#pk-go')
            check('worksheet: random pick selects exactly that many', page.locator('#w-list [data-pid]:checked').count() == 2, str(page.locator('#w-list [data-pid]:checked').count()))
            page.check('#pk-all'); page.fill('#o-title', 'Unit Test 1'); page.fill('#o-sub', 'Class 12 · Chemistry'); page.click('#w-make')
            page.wait_for_selector('.sheet')
            nq = page.locator('.sheet li.sq').count()
            check('worksheet: every chosen question is on the sheet with an answer key', nq >= 5 and page.locator('.sheet-key li').count() == nq and 'Unit Test 1' in page.inner_text('.sheet-head') and 'Name:' in page.inner_text('.sheet-head'), str(nq))
            check('worksheet: chemistry formatting and the picture appear on the sheet', page.locator('.sheet li.sq sub').count() >= 3 and page.locator('.sheet .sq-fig img').count() == 1, str(page.locator('.sheet .sq-fig img').count()))
            page.emulate_media(media='print')
            check('print layout hides the site chrome and keeps the sheet', not page.locator('.site-header').is_visible() and not page.locator('.sheet-bar').is_visible() and page.locator('.sheet').is_visible())
            bgc = page.evaluate("getComputedStyle(document.body).backgroundColor")
            check('print layout is black on white even in dark mode', bgc in ('rgb(255, 255, 255)', 'rgba(255, 255, 255, 1)'), bgc)
            page.emulate_media(media='screen'); page.screenshot(path=f'{SHOTS}/w-sheet.png', full_page=True)
            page.click('#w-back'); check('worksheet: back returns to choosing', page.locator('#builder:not([hidden])').count() == 1)
            page.set_viewport_size({'width': 390, 'height': 844}); go('/admin/worksheet'); no_overflow('worksheet (phone)')
            page.click('#menu-btn'); page.wait_for_selector('#menu:not([hidden])')
            mt = page.inner_text('#menu')
            check('menu offers the worksheet and install help', 'Print worksheet' in mt and ('Install' in mt or 'Add to Home' in mt or 'Add to home' in mt), mt)
            page.keyboard.press('Escape'); page.set_viewport_size({'width': 1280, 'height': 900})

            # ------------------------------------------------------------ install to home screen (PWA)
            go('/')
            mhref = page.get_attribute('link[rel=manifest]', 'href')
            man = json.loads(page.request.get(BASE + mhref).text())
            check('manifest is installable (name, standalone, start_url, 192 and 512 icons)', man['display'] == 'standalone' and man['start_url'] == '/' and {'192x192', '512x512'} <= {i['sizes'] for i in man['icons']} and any(i.get('purpose') == 'maskable' for i in man['icons']), str(man)[:200])
            icons_ok = all(page.request.get(BASE + i['src']).headers.get('content-type', '').startswith('image/png') for i in man['icons'])
            check('every icon in the manifest is a real PNG', icons_ok)
            check('apple touch icon and theme colour are declared', page.locator('link[rel=apple-touch-icon]').count() == 1 and page.locator('meta[name=theme-color]').count() >= 1)
            swr = page.request.get(BASE + '/sw.js')
            hdrs = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../web/_headers')).read()
            check('service worker is served as JavaScript and _headers tells browsers never to cache it', swr.status == 200 and 'javascript' in swr.headers.get('content-type', '') and re.search(r'/sw\.js\n\s+Cache-Control: no-cache', hdrs) is not None, hdrs[-200:])
            swctx = browser.new_context(viewport={'width': 390, 'height': 844}); swctx.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
            sp = swctx.new_page(); sp.goto(BASE + '/'); sp.wait_for_load_state('networkidle')
            until(lambda: sp.evaluate("navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))"), 15, 'service worker active')
            sp.reload(); sp.wait_for_load_state('networkidle')
            swctx.set_offline(True); sp.reload(); sp.wait_for_selector('.brand', timeout=10000)
            check('installed shell still opens with no connection', sp.locator('.brand').count() == 1)
            swctx.set_offline(False); swctx.close()



            # ------------------------------------------------------------ light / dark switch
            bg = lambda pg: pg.evaluate("getComputedStyle(document.body).backgroundColor")
            tctx = browser.new_context(viewport={'width': 1280, 'height': 800}, color_scheme='light'); tctx.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
            tp = tctx.new_page(); tp.goto(BASE + '/'); tp.wait_for_load_state('networkidle')
            light_bg = bg(tp)
            check('header has a light/dark button (desktop)', tp.locator('#theme-btn').is_visible() and 'dark' in (tp.locator('#theme-btn').get_attribute('aria-label') or '').lower())
            tp.click('#theme-btn')
            until(lambda: tp.evaluate("document.documentElement.dataset.theme") == 'dark', 5, 'dark applied')
            check('toggle switches to dark mode', bg(tp) != light_bg and tp.locator('#theme-btn').get_attribute('aria-label') == 'Switch to light mode', f'{light_bg} -> {bg(tp)}')
            check('choice is saved in this browser', tp.evaluate("localStorage.getItem('qb.theme')") == 'dark')
            check('browser colour bar follows the choice', tp.evaluate("[...document.querySelectorAll('meta[name=theme-color]')].every(m => m.content === '#090e14')"))
            tp.reload(); tp.wait_for_load_state('networkidle')
            check('dark mode is remembered after reload', tp.evaluate("document.documentElement.dataset.theme") == 'dark' and bg(tp) != light_bg)
            tp.click('#theme-btn')
            until(lambda: tp.evaluate("document.documentElement.dataset.theme") == 'light', 5, 'light applied')
            check('toggle switches back to light mode', bg(tp) == light_bg and tp.locator('#theme-btn').get_attribute('aria-label') == 'Switch to dark mode')
            tp.goto(BASE + '/admin'); tp.wait_for_load_state('networkidle')
            check('light/dark button is in the admin header too', tp.locator('#theme-btn').is_visible())
            tctx.close()

            # device is dark and nothing saved: starts dark, button offers light and overrides the device
            dd = browser.new_context(viewport={'width': 1280, 'height': 800}, color_scheme='dark'); dd.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
            dp = dd.new_page(); dp.goto(BASE + '/'); dp.wait_for_load_state('networkidle')
            dark_bg = bg(dp)
            check('with a dark device and no saved choice the site starts dark', dp.evaluate("document.documentElement.dataset.theme") is None and dp.locator('#theme-btn').get_attribute('aria-label') == 'Switch to light mode')
            dp.click('#theme-btn')
            until(lambda: dp.evaluate("document.documentElement.dataset.theme") == 'light', 5, 'forced light')
            check('light can be chosen even when the device is dark', bg(dp) != dark_bg)
            dd.close()

            # phone: Appearance section in the menu (Light / Dark / Auto)
            pm = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme='light'); pm.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
            mp = pm.new_page(); mp.goto(BASE + '/'); mp.wait_for_load_state('networkidle')
            check('phone header shows both the light/dark and the menu buttons', mp.locator('#theme-btn').is_visible() and mp.locator('#menu-btn').is_visible())
            mp.click('#menu-btn'); mp.wait_for_selector('#menu:not([hidden])')
            check('menu has an Appearance section with Light, Dark and Auto', mp.locator('[data-theme-set]').count() == 3)
            mp.click('[data-theme-set=dark]')
            until(lambda: mp.evaluate("document.documentElement.dataset.theme") == 'dark', 5, 'menu dark')
            check('menu Dark button switches the site and shows as chosen', mp.locator('[data-theme-set=dark]').get_attribute('aria-pressed') == 'true' and mp.locator('[data-theme-set=light]').get_attribute('aria-pressed') == 'false')
            mp.click('[data-theme-set=""]')
            until(lambda: mp.evaluate("document.documentElement.dataset.theme") is None, 5, 'menu auto')
            check('Auto goes back to the device setting and forgets the choice', mp.evaluate("localStorage.getItem('qb.theme')") is None and mp.locator('[data-theme-set=""]').get_attribute('aria-pressed') == 'true')
            mp.screenshot(path=f'{SHOTS}/m-theme-menu.png')
            pm.close()

            # ------------------------------------------------------------ admin: filter-first list + delete
            page.set_viewport_size({'width': 1280, 'height': 900})
            go('/admin/questions')
            check('admin list shows a prompt, not every question, until a filter is chosen', page.locator('tbody tr').count() == 0 and 'Choose a filter' in text(), text()[:200])
            check('admin list has dropdown filters across the top', page.locator('.fbar select').count() >= 7 and page.locator('.fbar input[name=marks]').count() == 1)
            shot('05b-admin-filter-first')
            page.select_option('#fb-subject', label='Chemistry')
            until(lambda: page.locator('tbody tr').count() > 0, 10, 'subject rows')
            check('admin subject dropdown lists that subject (any status)', page.locator('tbody tr').count() > 0 and '/admin/questions' in page.url)
            check('admin chapter dropdown fills after a subject is chosen', page.locator('#fb-chapter option').count() > 1)
            page.select_option('#fb-type', 'numerical')
            until(lambda: 'type=numerical' in page.url and page.locator('tbody tr').count() >= 1, 10, 'type applied')
            check('admin type dropdown narrows the list', page.locator('tbody tr').count() >= 1)
            page.click('[data-clear]')
            until(lambda: page.locator('tbody tr').count() == 0 and 'Choose a filter' in text(), 10, 'admin cleared')
            check('admin Clear all filters returns to the empty start', page.locator('tbody tr').count() == 0)
            go('/admin/questions?status=published')
            check('picking a status tab counts as a filter', page.locator('tbody tr').count() > 0)
            check('every row has a Delete button', page.locator('tbody tr [data-del]').count() == page.locator('tbody tr').count())

            def qcount(): return int(ctl(sql='select count(*) from public.questions')['out'].strip().split()[-1])
            before = qcount()
            pid = page.locator('tbody tr').first.get_attribute('data-pid')
            go(f'/admin/edit/{pid}')
            check('edit page of a PUBLISHED question has a Delete button', page.locator('#del').count() == 1 and page.locator('#del').is_visible())
            page.click('#del'); page.wait_for_selector('dialog[open]')
            dlg = page.inner_text('dialog')
            check('delete asks first, names the question, warns it is published and cannot be undone', pid in dlg and 'published' in dlg.lower() and 'cannot be undone' in dlg.lower(), dlg[:300])
            check('deleting a published question needs the word DELETE typed', page.locator('dialog button[value=ok]').is_disabled())
            page.fill('#cd-type', 'delet')
            check('a partly typed word keeps Delete disabled', page.locator('dialog button[value=ok]').is_disabled())
            page.click('dialog button[value=cancel]'); until(lambda: page.locator('dialog').count() == 0, 5, 'closed')
            check('Cancel keeps the question', qcount() == before)
            page.click('#del'); page.wait_for_selector('dialog[open]')
            page.fill('#cd-type', 'DELETE')
            check('typing DELETE enables the button', page.locator('dialog button[value=ok]').is_enabled())
            page.click('dialog button[value=ok]'); page.wait_for_selector('dialog', state='detached', timeout=15000)
            until(lambda: qcount() == before - 1 and page.url.rstrip('/').endswith('/admin/questions'), 10, 'deleted')
            check('delete removes the published question for good', qcount() == before - 1 and page.url.rstrip('/').endswith('/admin/questions'), page.url)

            # a draft: single delete from the list row, simple confirmation (no typing)
            drafted = ctl(sql="update public.questions set status='draft' where id = (select id from public.questions where status='published' order by public_id desc limit 1) returning public_id")['out']
            dpid = re.search(r'QB-[A-Z]+-\d+', drafted).group(0)
            go('/admin/questions?status=draft')
            row = page.locator(f'tr[data-pid="{dpid}"]')
            check('drafted question shows in the Draft tab with Delete', row.count() == 1 and row.locator('[data-del]').count() == 1)
            row.locator('[data-del]').click(); page.wait_for_selector('dialog[open]')
            check('a draft needs only a plain confirmation', page.locator('#cd-type').count() == 0 and dpid in page.inner_text('dialog') and page.locator('dialog button[value=ok]').is_enabled())
            page.click('dialog button[value=ok]'); page.wait_for_selector('dialog', state='detached', timeout=15000)
            until(lambda: qcount() == before - 2, 10, 'draft deleted')
            check('row Delete removes the draft', qcount() == before - 2)

            # bulk delete needs the typed word
            go('/admin/questions?status=published')
            two = page.locator('tbody tr [data-sel]')
            two.nth(0).check(); two.nth(1).check()
            ids2 = [page.locator('tbody tr').nth(i).get_attribute('data-pid') for i in (0, 1)]
            page.click('#bdel'); page.wait_for_selector('dialog[open]')
            check('bulk delete lists the selection and needs DELETE typed', all(i in page.inner_text('dialog') for i in ids2) and page.locator('dialog button[value=ok]').is_disabled())
            page.fill('#cd-type', 'DELETE'); page.click('dialog button[value=ok]'); page.wait_for_selector('dialog', state='detached', timeout=15000)
            until(lambda: qcount() == before - 4, 10, 'bulk deleted')
            check('bulk delete removes every selected question', qcount() == before - 4 and all(ctl(sql=f"select count(*) from public.questions where public_id='{i}'")['out'].strip().endswith('0') for i in ids2))
            go('/admin/questions?status=published')
            page.locator('#bdel').click()
            check('selecting nothing shows a hint instead of a dialog', page.locator('dialog[open]').count() == 0)

            # ------------------------------------------------------------ session handling
            go('/admin')
            page.evaluate("(() => { const s = JSON.parse(localStorage.getItem('qb.session')); s.expires_at = 1; localStorage.setItem('qb.session', JSON.stringify(s)); })()")
            go('/admin/questions?status=published')
            check('expired token is refreshed transparently', page.locator('tbody tr').count() > 0)
            page.click('[data-act=sign-out]')
            page.wait_for_selector('#login')
            check('sign out clears the session', page.evaluate("localStorage.getItem('qb.session')") is None)

            # ------------------------------------------------------------ housekeeping
            check('no JavaScript errors or CSP violations in admin session', not problems, '; '.join(problems[:5]))
            check('no JavaScript errors or CSP violations in public session', not pub_problems, '; '.join(pub_problems[:5]))
        except BaseException:
            dump()
            raise
        browser.close()

    global results_done
    results_done = True
    failed = [r for r in results if not r[0]]
    print(f'\n{len(results) - len(failed)} passed, {len(failed)} failed')
    sys.exit(1 if failed else 0)

main()
