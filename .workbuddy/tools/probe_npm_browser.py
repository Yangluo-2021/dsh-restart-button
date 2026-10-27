"""Test each Clash node with a real browser engine against www.npmjs.com.

curl cannot judge a JavaScript challenge — only a browser can. So this drives
headless Chrome for each node and looks at the rendered DOM: a page titled
"Just a moment" means the challenge was not passed, anything else (a login
form, a redirect) means it was. The original node is restored at the end.
"""

import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, r'C:\Users\99687\Desktop\DSH插件发布\.workbuddy\tools')
from clash_pipe import request  # noqa: E402

GROUP = '/proxies/%E9%9B%B7%E4%BA%91X'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
URL = 'https://www.npmjs.com/login'


def render(url):
    """Load the url in headless Chrome and return the resulting DOM."""
    profile = tempfile.mkdtemp(prefix='cfprobe-')
    try:
        proc = subprocess.run(
            [CHROME, '--headless=new', '--disable-gpu', '--no-sandbox',
             '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
             f'--user-data-dir={profile}', '--virtual-time-budget=30000',
             '--dump-dom', url],
            capture_output=True, text=True, timeout=120)
        return proc.stdout
    except subprocess.TimeoutExpired:
        return ''
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def classify(dom):
    if not dom:
        return '无响应'
    title = re.search(r'<title>(.*?)</title>', dom, re.S)
    title = title.group(1).strip() if title else '(无标题)'
    if 'Just a moment' in title or '请稍候' in title or '_cf_chl_' in dom:
        return f'挑战未过 ({title})'
    if len(dom) < 2000:
        return f'内容过少 ({title})'
    return f'通过! ({title})'


def main():
    status, data = request('GET', GROUP)
    original = data.get('now')
    nodes = [n for n in data.get('all', []) if n not in ('自动选择', '故障转移')]
    print(f'原节点: {original}    待测: {len(nodes)}\n')

    winners = []
    for node in nodes:
        request('PUT', GROUP, {'name': node})
        verdict = classify(render(URL))
        print(f'{node:<22} {verdict}')
        if verdict.startswith('通过'):
            winners.append(node)

    request('PUT', GROUP, {'name': original})
    print('\n已还原:', original)
    print('浏览器可过的节点:', winners if winners else '（无）')


if __name__ == '__main__':
    main()
