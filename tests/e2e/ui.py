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

def until(fn, timeout=15, what='condition'):
    """Poll a Python predicate (the page's CSP forbids string-eval, so no wait_for_function)."""
    import time
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return True
        except Exception:
            pass
        time.sleep(0.15)
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
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
        # Deterministic: the sandbox has no internet, so never wait on Google Fonts.
        ctx.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())
        page = ctx.new_page()
        problems = []
        page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
        page.on('console', lambda m: problems.append(f'console.{m.type}: {m.text}') if m.type in ('error',) and 'ERR_FAILED' not in m.text and 'fonts.g' not in m.text and 'Failed to load resource' not in m.text else None)  # 4xx are provoked on purpose; CSP violations and script errors are not
        page.on('dialog', lambda d: d.dismiss())

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
            page.wait_for_selector('#pv img')
            check('image preview shown, button enabled', page.locator('#go').is_enabled())
            ctl(reset=True, gemini='quota')
            page.click('#go')
            page.wait_for_selector('#x-err .notice')
            msg = page.inner_text('#x-err')
            check('free quota exhausted -> clear message, nothing charged, JSON fallback offered', 'charged' in msg.lower() and 'Paste JSON' in msg, msg)
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
            pgo('/browse/chemistry')
            check('subject page lists chapters', 'Some Basic Concepts of Chemistry' in pub.inner_text('body'))
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
            facets = pub.inner_text('body')
            check('facets show exam and difficulty filters', 'JEE Main' in facets and ('Easy' in facets or 'easy' in facets), facets[:300])

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
            for path, nm in [('/admin', 'dashboard'), ('/admin/questions', 'list'), ('/admin/taxonomy', 'taxonomy'), ('/admin/export', 'export'), ('/admin/add?tab=json', 'add')]:
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

            # ------------------------------------------------------------ session handling
            go('/admin')
            page.evaluate("(() => { const s = JSON.parse(localStorage.getItem('qb.session')); s.expires_at = 1; localStorage.setItem('qb.session', JSON.stringify(s)); })()")
            go('/admin/questions')
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
